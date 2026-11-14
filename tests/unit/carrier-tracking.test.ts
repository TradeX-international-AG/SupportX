import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carrierChip, carrierFacts, hasCarrierDelivered, isDhlCandidate, needsFetch, parcelTargets, type CarrierTrackingResult } from "../../packages/core/carrier-tracking.ts";
import { checkDraft } from "../../packages/core/draft-check.ts";
import { DhlTrackingClient, mapDhlResponse } from "../../packages/connectors/dhl/tracking.ts";

// Synthetic parcel numbers in DHL formats.
const PAKET20 = "00340434000000000001";
const PAKET12 = "340434000002";

describe("isDhlCandidate", () => {
  it("follows the carrier of the tracking address, otherwise the number format", () => {
    assert.equal(isDhlCandidate("DEMO123456", "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=DEMO123456"), true);
    assert.equal(isDhlCandidate(PAKET20, "https://tracking.dpd.de/status/de_DE/parcel/x"), false, "a DPD address is not asked at DHL");
    assert.equal(isDhlCandidate(PAKET20), true);
    assert.equal(isDhlCandidate("0034 0434 0000 0000 0001"), true, "spaces do not matter");
    assert.equal(isDhlCandidate("JJD000390000000000001"), true);
    assert.equal(isDhlCandidate("RR123456789DE"), true);
    assert.equal(isDhlCandidate("DEMO00012345"), false);
    assert.equal(isDhlCandidate("1234"), false);
  });
});

describe("parcelTargets", () => {
  it("lists every DHL parcel of every delivery once, then numbers the customer wrote", () => {
    const order = {
      shipments: [
        { shipmentNumber: "LS-1", recipientPostalCode: "10115", parcels: [{ trackingId: PAKET20 }, { trackingId: PAKET12 }] },
        { shipmentNumber: "LS-2", parcels: [{ trackingId: "01234567890123", trackingUrl: "https://tracking.dpd.de/x" }, { trackingId: PAKET20 }] },
      ],
    };
    const t = parcelTargets(order, ["0034 0434 0000 0000 0001", "JJD000390000000000009", "kein-paket"]);
    assert.deepEqual(t.map((x) => [x.trackingNumber, x.origin, x.label, x.postalCode]), [
      [PAKET20, "shipment", "Lieferung LS-1, Paket 1", "10115"],
      [PAKET12, "shipment", "Lieferung LS-1, Paket 2", "10115"],
      ["JJD000390000000000009", "customer", "vom Kunden genannt", undefined],
    ]);
  });
  it("works without a linked order (a return number in the message)", () => {
    assert.equal(parcelTargets(null, [PAKET12])[0]?.origin, "customer");
  });
});

describe("needsFetch", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  it("keeps delivered and fresh answers, asks again after 2 h, a click after 5 min", () => {
    assert.equal(needsFetch(undefined, now, false), true);
    assert.equal(needsFetch({ state: "found", statusCode: "delivered", fetchedAt: ago(600) }, now, false), false);
    assert.equal(needsFetch({ state: "found", statusCode: "transit", fetchedAt: ago(60) }, now, false), false);
    assert.equal(needsFetch({ state: "found", statusCode: "transit", fetchedAt: ago(121) }, now, false), true);
    assert.equal(needsFetch({ state: "found", statusCode: "delivered", fetchedAt: ago(3) }, now, true), false);
    assert.equal(needsFetch({ state: "found", statusCode: "delivered", fetchedAt: ago(6) }, now, true), true);
    assert.equal(needsFetch({ state: "error", fetchedAt: ago(6) }, now, false), true);
  });
});

const body = {
  shipments: [{
    id: PAKET20, service: "parcel-de",
    status: { timestamp: "2026-11-12T10:15:00+01:00", statusCode: "delivered", status: "Zugestellt", description: "Die Sendung wurde erfolgreich zugestellt.", location: { address: { addressLocality: "Berlin", countryCode: "DE" } } },
    details: { proofOfDelivery: { timestamp: "2026-11-12T10:15:00+01:00" } },
    events: [
      { timestamp: "2026-11-12T10:15:00+01:00", statusCode: "delivered", status: "Zugestellt" },
      { timestamp: "2026-11-11T18:00:00+01:00", statusCode: "transit", status: "Im Paketzentrum bearbeitet" },
    ],
  }],
};

describe("mapDhlResponse", () => {
  it("reads status, delivery time, place and history", () => {
    const r = mapDhlResponse(PAKET20, body, "2026-11-14T12:00:00.000Z");
    assert.equal(r.state, "found");
    assert.equal(r.statusCode, "delivered");
    assert.equal(r.deliveredAt, "2026-11-12T10:15:00+01:00");
    assert.equal(r.location, "Berlin, DE");
    assert.equal(r.events.length, 2);
    assert.deepEqual(carrierChip(r), { label: "zugestellt", tone: "good" });
  });
  it("marks a parcel that went back to the sender", () => {
    const back = structuredClone(body) as typeof body & { shipments: Array<{ details: Record<string, unknown> }> };
    back.shipments[0]!.details.returnFlag = true;
    assert.equal(carrierChip(mapDhlResponse(PAKET20, back, "x")).label, "zurück beim Absender");
  });
  it("an empty list is 'not found', an unknown code stays unknown", () => {
    assert.equal(mapDhlResponse(PAKET20, { shipments: [] }, "x").state, "not_found");
    assert.equal(mapDhlResponse(PAKET20, { shipments: [{ status: { statusCode: "lost-in-space" } }] }, "x").statusCode, "unknown");
  });
});

describe("DhlTrackingClient", () => {
  it("only talks to DHL's official host and checks the key format", () => {
    assert.throws(() => new DhlTrackingClient({ apiKey: "short", allowTestEndpoints: false }), /Format/);
    assert.throws(() => new DhlTrackingClient({ apiKey: "a".repeat(32), apiUrl: "https://evil.example/track/shipments", allowTestEndpoints: false }), /Nicht erlaubter Endpunkt/);
    assert.doesNotThrow(() => new DhlTrackingClient({ apiKey: "a".repeat(32), allowTestEndpoints: false }));
  });
  it("sends the key as header, the postal code only when valid, and treats 404 as an answer", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen.push(`${url.toString()} ${(init.headers as Record<string, string>)["DHL-API-Key"]}`);
      return new Response(JSON.stringify({ status: 404, title: "No result found" }), { status: 404 });
    }) as unknown as typeof fetch;
    const client = new DhlTrackingClient({ apiKey: "k".repeat(32), allowTestEndpoints: false, fetchImpl });
    assert.equal((await client.track(PAKET12, { postalCode: "10 115" })).state, "not_found");
    await client.track(PAKET12, { postalCode: "<script>" });
    assert.match(seen[0]!, /^https:\/\/api-eu\.dhl\.com\/track\/shipments\?trackingNumber=340434000002&language=de&recipientPostalCode=10115 k{32}$/);
    assert.ok(!seen[1]!.includes("recipientPostalCode"));
  });
});

describe("carrier facts and the draft check", () => {
  const delivered: CarrierTrackingResult = mapDhlResponse(PAKET20, body, "2026-11-14T12:00:00.000Z");
  const target = { trackingNumber: PAKET20, origin: "shipment" as const, label: "Lieferung LS-1" };
  it("turns only real DHL answers into facts", () => {
    const facts = carrierFacts([{ target, result: delivered }, { target: { ...target, trackingNumber: PAKET12 }, result: { carrier: "dhl", trackingNumber: PAKET12, state: "not_found", events: [], fetchedAt: "x" } }]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.id, "carrier.1.delivered");
    assert.equal(facts[0]!.source, "DHL");
    assert.match(facts[0]!.text, /laut DHL zugestellt \(Stand 12\.11\.2026\)/);
    assert.ok(hasCarrierDelivered(facts));
  });
  it("lets a DHL delivery scan back 'zugestellt', an ERP-only order not", () => {
    const order = { provider: "weclapp" as const, id: "o1", tags: [], lines: [], invoices: [], retrievedAt: "2026-11-14T12:00:00Z", shipments: [{ id: "s1", erpStatus: "SHIPPED", statusHistory: [], items: [], parcels: [{ trackingId: PAKET20, source: "parcels" as const }] }] };
    const base = { text: "Guten Tag, Ihr Paket wurde am 12.11. zugestellt.", citedFactIds: [], order, orderStatus: "unique" as const, allowedLinkPrefixes: [] };
    assert.ok(checkDraft({ ...base, facts: [] }).some((i) => i.code === "DELIVERY_CLAIM_UNSUPPORTED"));
    assert.ok(!checkDraft({ ...base, facts: carrierFacts([{ target, result: delivered }]) }).some((i) => i.code === "DELIVERY_CLAIM_UNSUPPORTED"));
  });
});
