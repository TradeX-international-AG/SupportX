import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { caseCarrierFacts, checkDhlConnection, deleteDhlConnection, getDhlSettings, saveDhlConnection, trackCaseParcels } from "../../packages/services/dhl-tracking.ts";
import { refreshOrderLink } from "../../packages/services/matching.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { many, one } from "../../packages/storage/db.ts";
import { startFakeDhl, type FakeDhl } from "../../packages/testing/fake-dhl.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness, type SeededWorkspace } from "./harness.ts";

// Synthetic key and parcel numbers in DHL formats.
const KEY = "TestDhlKey0000000000000000000001";
const P1 = "00340434000000000011";
const P2 = "340434000012";
const RETURN = "JJD000390000000000013";

let h: Harness | null = null;
let dhl: FakeDhl | null = null;
afterEach(async () => {
  await h?.close();
  await dhl?.close();
  h = null;
  dhl = null;
});
after(closeDb);

const code = (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: ServiceError) => e.code === expected);

async function setup(): Promise<{ h: Harness; dhl: FakeDhl; s: SeededWorkspace; caseId: string }> {
  h = await createHarness();
  dhl = await startFakeDhl({
    apiKey: KEY,
    parcels: {
      [P1]: { statusCode: "delivered", status: "Zugestellt", description: "Die Sendung wurde erfolgreich zugestellt.", timestamp: "2026-10-16T11:02:00+02:00", city: "Leipzig", postalCode: "04109", history: [{ statusCode: "transit", status: "Im Zustellfahrzeug", timestamp: "2026-10-16T08:00:00+02:00", city: "Leipzig" }] },
      [P2]: { statusCode: "transit", status: "Im Paketzentrum bearbeitet", timestamp: "2026-10-15T22:00:00+02:00", city: "Radefeld" },
      [RETURN]: { statusCode: "transit", status: "Rücksendung unterwegs", timestamp: "2026-10-21T09:00:00+02:00", returnFlag: true },
    },
  });
  // Two DHL parcels in the first delivery of the demo order, with the recipient's postal code.
  const sh1 = h.weclapp.data.shipment.find((x) => x.id === "sh-1")!;
  sh1.parcels = [
    { id: "pc-1", trackingId: P1, trackingUrl: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=", shippingCarrierId: "carrier-dhl" },
    { id: "pc-2", trackingId: P2, shippingCarrierId: "carrier-dhl" },
  ];
  sh1.recipientAddress = { zipcode: "04109", countryCode: "DE" };
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  const conv = await caseByThread(h, s, "conv-amazon-wismo");
  assert.equal(conv.order_match_status, "unique");
  return { h, dhl, s, caseId: conv.id };
}

describe("DHL-Sendungsstatus im Fall", () => {
  it("stores the key encrypted, shows it masked and replaces it only with a new key", async () => {
    const { h, dhl, s } = await setup();
    await code(saveDhlConnection(h.ctx, s.agent, { apiKey: KEY, apiUrl: dhl.url }), "FORBIDDEN");
    await code(saveDhlConnection(h.ctx, s.owner, { apiKey: "zu kurz", apiUrl: dhl.url }), "INVALID");
    await code(saveDhlConnection(h.ctx, s.owner, { apiKey: KEY, apiUrl: "https://evil.example/track" }), "INVALID");
    await saveDhlConnection(h.ctx, s.owner, { apiKey: "WrongKey00000000000000000000000x", apiUrl: dhl.url });
    const view = await getDhlSettings(h.ctx, s.viewer);
    assert.ok(view.configured && view.keyHint === "••••000x");
    assert.ok(!JSON.stringify(view).includes("WrongKey"), "the key is never returned");
    const stored = await one<{ ciphertext: Buffer }>(h.ctx.db, "SELECT s.ciphertext FROM secrets s JOIN dhl_tracking_connections d ON d.secret_id = s.id");
    assert.ok(!stored!.ciphertext.toString("utf8").includes("WrongKey"), "encrypted at rest");

    const bad = await checkDhlConnection(h.ctx, s.owner);
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /lehnt den API-Key ab/);
    await saveDhlConnection(h.ctx, s.owner, { apiKey: KEY, apiUrl: dhl.url });
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM secrets WHERE purpose = 'dhl_tracking'")).length, 1, "the old key is deleted");
    assert.equal((await checkDhlConnection(h.ctx, s.owner)).ok, true);
    assert.equal((await getDhlSettings(h.ctx, s.owner) as { status: string }).status, "ok");

    await deleteDhlConnection(h.ctx, s.owner);
    assert.equal((await getDhlSettings(h.ctx, s.owner)).configured, false);
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM secrets WHERE purpose = 'dhl_tracking'")).length, 0);
  });

  it("shows the parcels without a key and asks DHL nothing", async () => {
    const { h, dhl, s, caseId } = await setup();
    const r = await trackCaseParcels(h.ctx, s.agent, caseId);
    assert.equal(r.connected, false);
    assert.deepEqual(r.parcels.map((p) => p.target.trackingNumber), [P1, P2]);
    assert.equal(dhl.requests.length, 0);
  });

  it("reads each parcel once, keeps the answer, and backs 'zugestellt' in drafts with DHL's scan", async () => {
    const { h, dhl, s, caseId } = await setup();
    await saveDhlConnection(h.ctx, s.owner, { apiKey: KEY, apiUrl: dhl.url });
    // The customer also wrote a return parcel number.
    await h.ctx.db.query("UPDATE conversations SET order_references = order_references || $3::jsonb WHERE workspace_id = $1 AND id = $2", [s.workspaceId, caseId, JSON.stringify([{ value: RETURN, kind: "tracking_number", foundIn: "body" }])]);

    const r = await trackCaseParcels(h.ctx, s.viewer, caseId);
    assert.equal(r.connected, true);
    const by = new Map(r.parcels.map((p) => [p.target.trackingNumber, p]));
    assert.equal(by.get(P1)!.result!.statusCode, "delivered");
    assert.equal(by.get(P1)!.result!.location, "Leipzig, DE", "postal code from weclapp unlocks details");
    assert.equal(by.get(P2)!.result!.statusCode, "transit");
    assert.equal(by.get(RETURN)!.target.origin, "customer");
    assert.equal(by.get(RETURN)!.result!.returnFlag, true);
    assert.equal(dhl.requests.find((q) => q.trackingNumber === P1)!.postalCode, "04109");
    assert.equal(dhl.requests.length, 3);

    // Opening the case again within 2 h asks nothing; a click asks again only after 5 minutes.
    await trackCaseParcels(h.ctx, s.agent, caseId);
    await trackCaseParcels(h.ctx, s.agent, caseId, { force: true });
    assert.equal(dhl.requests.length, 3);

    // Another workspace never sees these answers.
    const other = await seedWorkspace(h, "Anderer Händler");
    await code(trackCaseParcels(h.ctx, other.agent, caseId), "NOT_FOUND");
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM parcel_tracking WHERE workspace_id = $1", [other.workspaceId])).length, 0);

    const facts = await caseCarrierFacts(h.ctx.db, s.workspaceId, caseId);
    assert.deepEqual(facts.map((f) => f.id), ["carrier.1.delivered", "carrier.2.transit", "carrier.3.transit"]);
    assert.ok(facts.every((f) => f.source === "DHL"));
    assert.ok(!facts.some((f) => f.text.includes("04109")), "no postal code in AI facts");
  });

  it("stops at DHL's daily limit, and keeps earlier answers when a call fails", async () => {
    const { h, dhl, s, caseId } = await setup();
    await saveDhlConnection(h.ctx, s.owner, { apiKey: KEY, apiUrl: dhl.url });
    dhl.limit.remaining = 1;
    const r = await trackCaseParcels(h.ctx, s.agent, caseId);
    assert.equal(r.limited, true);
    assert.equal(r.parcels[0]!.result!.statusCode, "delivered");
    assert.equal(r.parcels[1]!.result, undefined, "the rest waits for the next round");

    // Later: the second parcel is due; DHL rejects the key → error shown, connection marked.
    dhl.limit.remaining = Infinity;
    await h.ctx.db.query("UPDATE parcel_tracking SET fetched_at = now() - interval '3 hours', result = jsonb_set(result, '{fetchedAt}', to_jsonb((now() - interval '3 hours')::text)) WHERE workspace_id = $1", [s.workspaceId]);
    await h.ctx.db.query("UPDATE parcel_tracking SET status_code = 'transit', result = jsonb_set(result, '{statusCode}', '\"transit\"') WHERE workspace_id = $1 AND tracking_number = $2", [s.workspaceId, P1]);
    await saveDhlConnection(h.ctx, s.owner, { apiKey: "WrongKey00000000000000000000000x", apiUrl: dhl.url });
    const failed = await trackCaseParcels(h.ctx, s.agent, caseId);
    const p1 = failed.parcels.find((p) => p.target.trackingNumber === P1)!.result!;
    assert.equal(p1.state, "found", "the last real answer stays visible");
    assert.match(p1.error ?? "", /lehnt den API-Key ab/);
    assert.equal(failed.parcels.find((p) => p.target.trackingNumber === P2)!.result!.state, "error");
    assert.equal((await getDhlSettings(h.ctx, s.owner) as { status: string }).status, "error");
  });

  it("re-reads the order from weclapp and then tracks a parcel added later", async () => {
    const { h, dhl, s, caseId } = await setup();
    await saveDhlConnection(h.ctx, s.owner, { apiKey: KEY, apiUrl: dhl.url });
    h.weclapp.data.shipment.find((x) => x.id === "sh-2")!.parcels = [{ id: "pc-9", trackingId: RETURN }];
    await refreshOrderLink(h.ctx, s.agent, caseId);
    const r = await trackCaseParcels(h.ctx, s.agent, caseId);
    assert.deepEqual(r.parcels.map((p) => p.target.label), ["Lieferung LS-5001, Paket 1", "Lieferung LS-5001, Paket 2", "Lieferung LS-5002"]);
  });
});
