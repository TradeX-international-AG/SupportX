import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createKauflandConnection, createMerchantAccount, createMiraklConnection } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { enqueue } from "../../packages/services/jobs.ts";
import { caseMarketplaceOrderInfo, checkOttoConnection, getOttoSettings, lookupCaseMarketplaceOrder, saveOttoConnection } from "../../packages/services/marketplace-orders.ts";
import { one } from "../../packages/storage/db.ts";
import { startFakeKaufland, startFakeMirakl, startFakeOtto } from "../../packages/testing/fake-marketplaces.ts";
import { closeDb, createHarness, drainWithDrafts, seedWorkspace, type Harness, type SeededWorkspace } from "./harness.ts";

let h: Harness | null = null;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const c of closers.splice(0)) await c();
});
after(() => closeDb());

async function sync(s: SeededWorkspace, connectionId: string): Promise<void> {
  await enqueue(h!.ctx.db, { workspaceId: s.workspaceId, type: "mail.sync", payload: { connectionId }, dedupeKey: `mail.sync:${connectionId}` });
  await drainWithDrafts(h!, 200);
}

describe("Mirakl marketplaces next to Shop Apotheke", () => {
  it("keeps each operator its own platform and reads the order there (OR11) on click", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const sa = await startFakeMirakl({ apiKey: "key-sa" });
    const douglas = await startFakeMirakl({ apiKey: "key-douglas" });
    closers.push(() => sa.close(), () => douglas.close());
    sa.addThread({ id: "th-sa", topic: "Lieferung", orderId: "SA-1-A", customerId: "c-1", customerName: "Kundin A", text: "Wo ist mein Paket?" });
    douglas.addThread({ id: "th-dg", topic: "Retoure", orderId: "DG-77-A", customerId: "c-2", customerName: "Kunde B", text: "Ich möchte zurückschicken." });
    douglas.orders.push({
      order_id: "DG-77-A", order_state: "SHIPPED", created_date: "2026-11-10T09:00:00Z", currency_iso_code: "EUR",
      shipping_tracking: "00340434161094042557", shipping_carrier_code: "DHL", shipping_tracking_url: "https://www.dhl.de/x?n=1",
      order_lines: [
        { product_title: "Parfum 50 ml", offer_sku: "P-50", quantity: 1, order_line_state: "SHIPPED", refunds: [{ amount: 12.5, refund_state: "REFUNDED", created_date: "2026-11-12T10:00:00Z" }] },
        { product_title: "Duschgel", offer_sku: "D-1", quantity: 2, order_line_state: "CANCELED" },
      ],
    });

    const saId = await createMiraklConnection(h.ctx, s.owner, { displayName: "", baseUrl: sa.baseUrl, apiKey: "key-sa" });
    const dgId = await createMiraklConnection(h.ctx, s.owner, { displayName: "", baseUrl: douglas.baseUrl, apiKey: "key-douglas", platform: "douglas" });
    await assert.rejects(createMiraklConnection(h.ctx, s.owner, { displayName: "", baseUrl: douglas.baseUrl, apiKey: "k", platform: "amazon" }), (e: ServiceError) => e.code === "INVALID");
    const names = await one<{ sa: string; dg: string }>(h.ctx.db, "SELECT (SELECT display_name FROM channel_connections WHERE id = $1) AS sa, (SELECT display_name FROM channel_connections WHERE id = $2) AS dg", [saId, dgId]);
    assert.deepEqual(names, { sa: "Shop Apotheke", dg: "Douglas" });

    await sync(s, saId);
    await sync(s, dgId);
    const dgCase = (await one<{ id: string; source_platform: string }>(h.ctx.db, "SELECT id, source_platform FROM conversations WHERE connection_id = $1", [dgId]))!;
    assert.equal(dgCase.source_platform, "douglas");
    const saCase = (await one<{ source_platform: string }>(h.ctx.db, "SELECT source_platform FROM conversations WHERE connection_id = $1", [saId]))!;
    assert.equal(saCase.source_platform, "shop_apotheke");

    // A seller account and a reply deadline exist for the new platform.
    await createMerchantAccount(h.ctx, s.owner, { name: "Douglas DE", platform: "douglas", orderScopeField: "none", orderScopeValue: "" });
    const deadline = await one<{ hours: number }>(h.ctx.db, "SELECT (reply_deadlines->>'douglas')::int AS hours FROM workspaces WHERE id = $1", [s.workspaceId]);
    assert.equal(deadline?.hours, 48);

    const info = await caseMarketplaceOrderInfo(h.ctx, s.agent, dgCase.id);
    assert.equal(info.available, true);
    assert.equal(info.platformName, "Douglas");
    assert.ok(info.candidates.includes("DG-77-A"), "order id from the thread is offered");
    assert.equal(douglas.requests.filter((r) => r.startsWith("GET /api/orders")).length, 0, "opening the case reads nothing");

    const res = await lookupCaseMarketplaceOrder(h.ctx, s.agent, dgCase.id, {});
    assert.equal(res.order?.orderId, "DG-77-A");
    assert.equal(res.order?.statusLabel, "versendet");
    assert.deepEqual(res.order?.lines.map((l) => [l.title, l.quantity, l.statusLabel]), [["Parfum 50 ml", 1, "versendet"], ["Duschgel", 2, "storniert"]]);
    assert.deepEqual(res.order?.tracking, [{ number: "00340434161094042557", carrier: "DHL", url: "https://www.dhl.de/x?n=1" }]);
    assert.deepEqual(res.order?.refunds.map((r) => [r.amount, r.currency, r.stateLabel]), [[12.5, "EUR", "erstattet"]]);
    assert.equal(sa.requests.filter((r) => r.startsWith("GET /api/orders")).length, 0, "only the case's own operator is asked");

    const missing = await lookupCaseMarketplaceOrder(h.ctx, s.agent, dgCase.id, { orderId: "DG-404-A" });
    assert.equal(missing.order, null);
    await assert.rejects(lookupCaseMarketplaceOrder(h.ctx, s.agent, dgCase.id, { orderId: "../../x" }), (e: ServiceError) => e.code === "INVALID");
    await assert.rejects(lookupCaseMarketplaceOrder(h.ctx, { type: "worker", workspaceId: s.workspaceId }, dgCase.id, {}), (e: ServiceError) => e.code === "FORBIDDEN");
  });
});

describe("Kaufland order status in the case", () => {
  it("groups order units per article and status", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const keys = { clientKey: "ck-test", secretKey: "sk-test" };
    const fake = await startFakeKaufland(keys);
    closers.push(() => fake.close());
    fake.addTicket({ id_ticket: "T5", id_order: "MK1ABC2", buyer: { firstname: "E", lastname: "M" } });
    fake.addMessage("T5", "buyer", "Ein Teil fehlt.", new Date(Date.now() - 600_000));
    fake.orders.set("MK1ABC2", {
      ts_created_iso: "2026-11-01T08:00:00Z",
      order_units: [
        { id_order_unit: 1, status: "sent", item: { title: "Tee 100 g" }, tracking_numbers: "TRK1, TRK2", carrier_code: "DHL" },
        { id_order_unit: 2, status: "sent", item: { title: "Tee 100 g" }, tracking_numbers: "TRK1", carrier_code: "DHL" },
        { id_order_unit: 3, status: "returned", item: { title: "Honig" } },
      ],
    });
    const id = await createKauflandConnection(h.ctx, s.owner, { displayName: "Kaufland", ...keys, baseUrl: fake.baseUrl });
    await sync(s, id);
    const conv = (await one<{ id: string }>(h.ctx.db, "SELECT id FROM conversations WHERE connection_id = $1", [id]))!;
    const res = await lookupCaseMarketplaceOrder(h.ctx, s.viewer, conv.id, {});
    assert.equal(res.order?.orderId, "MK1ABC2");
    assert.deepEqual(res.order?.lines.map((l) => [l.title, l.quantity, l.statusLabel]), [["Tee 100 g", 2, "versendet"], ["Honig", 1, "zurückgeschickt"]]);
    assert.equal(res.order?.statusLabel, "gemischt: 2 × versendet, 1 × zurückgeschickt");
    assert.deepEqual(res.order?.tracking.map((t) => t.number), ["TRK1", "TRK2"]);
  });
});

describe("OTTO", () => {
  it("stores the API key masked and reads the order status of an OTTO mail case", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const creds = { clientId: "otto-client-123456", clientSecret: "otto-secret-abcdef9876" };
    const fake = await startFakeOtto(creds);
    closers.push(() => fake.close());
    fake.orders.set("OT12345", {
      orderNumber: "OT12345", orderDate: "2026-11-15T12:00:00Z",
      positionItems: [
        { fulfillmentStatus: "SENT", product: { productTitle: "Bio-Kaffee", sku: "K-1" }, trackingInfo: { trackingNumber: "Z9", carrier: "HERMES" } },
        { fulfillmentStatus: "SENT", product: { productTitle: "Bio-Kaffee", sku: "K-1" }, trackingInfo: { trackingNumber: "Z9", carrier: "HERMES" } },
      ],
    });

    // An OTTO case arrived by mail (OTTO has no message API).
    const conv = await one<{ id: string }>(
      h.ctx.db,
      `INSERT INTO conversations (workspace_id, connection_id, external_thread_key, source_platform, subject, order_references)
       VALUES ($1, $2, 'otto-thread-1', 'otto', 'Frage zu Bestellung OT12345', '[{"value":"OT12345","kind":"labelled","foundIn":"subject"}]') RETURNING id`,
      [s.workspaceId, s.connectionId],
    );
    const before = await caseMarketplaceOrderInfo(h.ctx, s.agent, conv!.id);
    assert.equal(before.available, false);
    assert.match(before.reason ?? "", /OTTO/);

    await assert.rejects(saveOttoConnection(h.ctx, s.agent, { ...creds, baseUrl: fake.baseUrl }), (e: ServiceError) => e.code === "FORBIDDEN");
    await saveOttoConnection(h.ctx, s.owner, { ...creds, baseUrl: fake.baseUrl });
    const view = await getOttoSettings(h.ctx, s.owner);
    assert.ok(view.configured);
    assert.equal(JSON.stringify(view).includes(creds.clientSecret), false, "the secret is never returned");
    assert.match(view.configured ? view.keyHint : "", /••••9876/);

    const check = await checkOttoConnection(h.ctx, s.owner);
    assert.equal(check.ok, true, check.detail);
    assert.equal(fake.tokenRequests[0]?.scope, "orders");

    const res = await lookupCaseMarketplaceOrder(h.ctx, s.agent, conv!.id, { orderId: "OT12345" });
    assert.equal(res.order?.statusLabel, "versendet");
    assert.deepEqual(res.order?.lines.map((l) => [l.title, l.quantity]), [["Bio-Kaffee", 2]]);
    assert.deepEqual(res.order?.tracking, [{ number: "Z9", carrier: "HERMES", url: undefined }]);
    assert.equal((await lookupCaseMarketplaceOrder(h.ctx, s.agent, conv!.id, { orderId: "OT99999" })).order, null);
  });
});
