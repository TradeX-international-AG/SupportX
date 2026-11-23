import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { resetPlentyCaches } from "../../packages/connectors/plentymarkets/adapter.ts";
import { checkErp, deleteErpConnection, upsertPlentyConnection, upsertWeclappConnection } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { enrichConversation, linkOrderManually } from "../../packages/services/matching.ts";
import { one } from "../../packages/storage/db.ts";
import { startFakePlenty, type FakePlenty } from "../../packages/testing/fake-marketplaces.ts";
import { closeDb, createHarness, seedWorkspace, type Harness, type SeededWorkspace } from "./harness.ts";

let h: Harness | null = null;
let fake: FakePlenty | null = null;
afterEach(async () => {
  await h?.close();
  await fake?.close();
  h = null;
  fake = null;
  resetPlentyCaches();
});
after(() => closeDb());

const creds = { username: "supportx-rest", password: "plenty-geheim-4711" };

function addOrders(f: FakePlenty) {
  f.orders.set("1042", {
    id: 1042, typeId: 1, statusId: 7, referrerId: 4.01, plentyId: 12345, createdAt: "2026-11-18T09:12:00+01:00",
    amounts: [{ isSystemCurrency: true, currency: "EUR", grossTotal: 34.8, invoiceTotal: 34.8 }],
    properties: [{ typeId: 7, value: "302-1234567-7654321" }],
    orderItems: [
      { id: 1, typeId: 1, itemVariationId: 2001, quantity: 2, orderItemName: "Bio-Tee 100 g", amounts: [{ isSystemCurrency: true, currency: "EUR", priceGross: 12.9 }] },
      { id: 2, typeId: 6, quantity: 1, orderItemName: "Versand", amounts: [{ isSystemCurrency: true, currency: "EUR", priceGross: 4.9 }] },
    ],
    relations: [{ referenceType: "contact", relation: "receiver", referenceId: 555 }],
    documents: [{ id: 91, type: "invoice", numberWithPrefix: "RE-2026-0815", displayDate: "2026-11-18T10:00:00+01:00" }, { id: 92, type: "delivery_note", number: "LS-1" }],
    shippingPackages: [{ id: 3, packageNumber: "00340434161094042557" }],
    tags: [{ tagId: 9, tag: { tagName: "Prime" } }],
    packageNumbers: ["00340434161094042557"],
  });
  f.orders.set("1043", { id: 1043, typeId: 1, statusId: 5.1, referrerId: 0, amounts: [], properties: [], orderItems: [], packageNumbers: [] });
}

async function caseWith(s: SeededWorkspace, subject: string): Promise<string> {
  const row = await one<{ id: string }>(
    h!.ctx.db,
    `INSERT INTO conversations (workspace_id, connection_id, external_thread_key, source_platform, subject, order_references)
     VALUES ($1, $2, $3, 'amazon', $4, $5) RETURNING id`,
    [s.workspaceId, s.connectionId, `t-${subject}`, subject, JSON.stringify([{ value: subject.split(" ").pop(), kind: "labelled", foundIn: "subject" }])],
  );
  return row!.id;
}

describe("plentymarkets as order system", () => {
  it("replaces weclapp only after removing it, keeps the password hidden and finds orders by marketplace number", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    fake = await startFakePlenty(creds);
    addOrders(fake);

    // One order system per workspace: weclapp is set up by the seed.
    await assert.rejects(upsertPlentyConnection(h.ctx, s.owner, { baseUrl: fake.baseUrl, ...creds }), (e: ServiceError) => e.code === "OTHER_ERP");
    await assert.rejects(deleteErpConnection(h.ctx, s.agent), (e: ServiceError) => e.code === "FORBIDDEN");
    await deleteErpConnection(h.ctx, s.owner);

    await assert.rejects(upsertPlentyConnection(h.ctx, s.owner, { baseUrl: "https://shop.example.com", ...creds }), (e: ServiceError) => e.code === "INVALID_URL");
    await assert.rejects(upsertPlentyConnection(h.ctx, s.agent, { baseUrl: fake.baseUrl, ...creds }), (e: ServiceError) => e.code === "FORBIDDEN");
    await upsertPlentyConnection(h.ctx, s.owner, { baseUrl: `${fake.baseUrl}/rest/`, ...creds });
    const row = await one<{ base_url: string; username: string; provider: string; search_fields: string[] }>(h.ctx.db, "SELECT base_url, username, provider, search_fields FROM erp_connections WHERE workspace_id = $1", [s.workspaceId]);
    assert.equal(row?.base_url, fake.baseUrl, "/rest is cut off");
    assert.equal(row?.provider, "plentymarkets");
    assert.deepEqual(row?.search_fields, ["externalOrderId", "orderId"]);
    const stored = await one<{ n: number }>(h.ctx.db, "SELECT count(*)::int AS n FROM erp_connections WHERE workspace_id = $1 AND username = $2", [s.workspaceId, creds.username]);
    assert.equal(stored?.n, 1);
    await assert.rejects(upsertWeclappConnection(h.ctx, s.owner, { baseUrl: h.weclapp.baseUrl, apiToken: "x" }), (e: ServiceError) => e.code === "OTHER_ERP");
    // Another user without a new password would reuse the old password.
    await assert.rejects(upsertPlentyConnection(h.ctx, s.owner, { baseUrl: fake.baseUrl, username: "andere" }), (e: ServiceError) => e.code === "INVALID");

    const check = await checkErp(h.ctx, s.owner);
    assert.equal(check.ok, true, check.detail);

    const conv = await caseWith(s, "Bestellung 302-1234567-7654321");
    assert.equal(await enrichConversation(h.ctx, s.workspaceId, conv), "unique");
    const link = await one<{ provider: string; external_order_id: string; matched_by: string; snapshot: Record<string, any> }>(h.ctx.db, "SELECT provider, external_order_id, matched_by, snapshot FROM order_links WHERE conversation_id = $1 AND is_current", [conv]);
    assert.equal(link?.provider, "plentymarkets");
    assert.equal(link?.external_order_id, "1042");
    assert.match(link?.matched_by ?? "", /Externe Auftragsnummer/);
    const o = link!.snapshot;
    assert.equal(o.orderNumberAtCustomer, "302-1234567-7654321");
    assert.equal(o.status, "[7] Warenausgang gebucht");
    assert.equal(o.salesChannelName, "Amazon Deutschland");
    assert.equal(o.customerId, "555");
    assert.deepEqual(o.lines.map((l: any) => [l.title, l.quantity, l.grossAmount]), [["Bio-Tee 100 g", 2, 25.8]]);
    assert.equal(o.shippingGrossAmount, 4.9);
    assert.equal(o.grossAmount, 34.8);
    assert.deepEqual(o.shipments[0].parcels.map((p: any) => p.trackingId), ["00340434161094042557"]);
    assert.deepEqual(o.invoices.map((i: any) => [i.invoiceNumber, i.type]), [["RE-2026-0815", "STANDARD_INVOICE"]], "delivery notes are no invoices");
    assert.deepEqual(o.tags, ["9", "Prime"]);
    assert.equal(fake.requests.some((r) => !r.startsWith("GET") && !r.startsWith("POST /rest/login")), false, "only reads");
    assert.equal(fake.logins, 1, "the token is reused");

    // By plenty order id, also when the system refuses the relations.
    fake.refuseRelations = true;
    const conv2 = await caseWith(s, "Auftrag 1043");
    assert.equal(await linkOrderManually(h.ctx, s.agent, conv2, { reference: "1043" }), "unique");
    const two = await one<{ snapshot: Record<string, any> }>(h.ctx.db, "SELECT snapshot FROM order_links WHERE conversation_id = $1 AND is_current", [conv2]);
    assert.equal(two?.snapshot.status, "[5.1] Wartet auf Lager");
    assert.deepEqual(two?.snapshot.shipments, []);
    assert.equal(await linkOrderManually(h.ctx, s.agent, conv2, { reference: "999-0000000-0000000" }), "missing");
  });

  it("checks the external number on the record when plenty ignores the filter, and reports a refused login", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    await deleteErpConnection(h.ctx, s.owner);
    fake = await startFakePlenty({ ...creds, ignoreExternalFilter: true });
    addOrders(fake);
    await upsertPlentyConnection(h.ctx, s.owner, { baseUrl: fake.baseUrl, ...creds });
    const conv = await caseWith(s, "Bestellung 302-1234567-7654321");
    assert.equal(await enrichConversation(h.ctx, s.workspaceId, conv), "unique", "the unfiltered list must not give two hits");

    await upsertPlentyConnection(h.ctx, s.owner, { baseUrl: fake.baseUrl, username: creds.username, password: "falsch" });
    resetPlentyCaches();
    const check = await checkErp(h.ctx, s.owner);
    assert.equal(check.ok, false);
    assert.match(check.detail, /Anmeldung ab \(401\)/);
  });
});
