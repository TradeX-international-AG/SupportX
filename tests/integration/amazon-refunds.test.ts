import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { checkAmazonListingConnection, saveAmazonListingConnection, setAmazonRefundsEnabled } from "../../packages/services/amazon-listings.ts";
import { checkAmazonRefund, issueAmazonRefund, lookupAmazonRefundOrder, settleUncertainAmazonRefund } from "../../packages/services/amazon-refunds.ts";
import { getCase } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { many, one } from "../../packages/storage/db.ts";
import { startFakeAmazon, type FakeAmazon } from "../../packages/testing/fake-amazon.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness, type SeededWorkspace } from "./harness.ts";

// Synthetic identifiers only.
const APP = { sellerId: "A1TESTSELLER01", clientId: "amzn1.application-oa2-client.test0000000000000000", clientSecret: "amzn1.oa2-cs.v1.test-secret-value", refreshToken: "Atzr|test-refresh-token-value" };
const DE = "A1PA6795UKMFR9";
const ORDER = "302-0000000-0000001";
const A = "11111111111111";
const B = "22222222222222";

let h: Harness | null = null;
let amz: FakeAmazon | null = null;
afterEach(async () => {
  await h?.close();
  await amz?.close();
  h = null;
  amz = null;
});
after(closeDb);

const code = (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: ServiceError) => e.code === expected);

async function setup(): Promise<{ h: Harness; amz: FakeAmazon; s: SeededWorkspace; caseId: string }> {
  h = await createHarness();
  amz = await startFakeAmazon({
    ...APP,
    listings: [],
    orders: [
      { orderId: ORDER, status: "Shipped", fulfillmentChannel: "MFN", marketplaceId: DE, currency: "EUR", items: [
        { orderItemId: A, sku: "TEST-A", title: "Testartikel A", quantity: 2, itemPrice: "39.80", shippingPrice: "4.90" },
        { orderItemId: B, sku: "TEST-B", title: "Testartikel B", quantity: 1, itemPrice: "10.00" },
      ] },
      { orderId: "302-0000000-0000002", status: "Unshipped", fulfillmentChannel: "MFN", marketplaceId: DE, currency: "EUR", items: [{ orderItemId: "3", sku: "C", title: "C", quantity: 1, itemPrice: "5.00" }] },
    ],
  });
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  const conv = await caseByThread(h, s, "conv-amazon-wismo");
  await saveAmazonListingConnection(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE], ...APP, apiBaseUrl: amz.url, tokenUrl: amz.tokenUrl });
  return { h, amz, s, caseId: conv.id };
}

describe("Erstattung bei Amazon aus dem Fall", () => {
  it("is off until the owner switches it on, and only a person can do it", async () => {
    const { h, s, caseId } = await setup();
    await code(lookupAmazonRefundOrder(h.ctx, s.agent, caseId, { orderId: ORDER }), "REFUNDS_OFF");
    await code(setAmazonRefundsEnabled(h.ctx, s.agent, true), "FORBIDDEN");
    await setAmazonRefundsEnabled(h.ctx, s.owner, true);
    assert.equal((await getCase(h.ctx, s.agent, caseId)).amazonListings?.refundsEnabled, true);
    assert.equal((await checkAmazonListingConnection(h.ctx, s.owner)).ok, true);
    await code(lookupAmazonRefundOrder(h.ctx, s.viewer, caseId, { orderId: ORDER }), "FORBIDDEN");
    await code(issueAmazonRefund(h.ctx, { type: "worker", workspaceId: s.workspaceId }, caseId, { orderId: ORDER, reason: "CustomerReturn", lines: [{ orderItemId: A, principal: "19,90" }], confirm: true, expectedTotalCents: 1990 }), "FORBIDDEN");
    // Another workspace cannot reach the case.
    const other = await seedWorkspace(h, "Anderer Händler");
    await code(lookupAmazonRefundOrder(h.ctx, other.owner, caseId, { orderId: ORDER }), "NOT_FOUND");
  });

  it("reads the order, refunds on confirmation, fetches the result and caps later refunds", async () => {
    const { h, amz, s, caseId } = await setup();
    await setAmazonRefundsEnabled(h.ctx, s.owner, true);
    await code(lookupAmazonRefundOrder(h.ctx, s.agent, caseId, { orderId: "302-0000000-9999999" }), "ORDER_NOT_FOUND");
    const unshipped = await lookupAmazonRefundOrder(h.ctx, s.agent, caseId, { orderId: "302-0000000-0000002" });
    assert.match(unshipped.blocker!, /noch nicht versandt/);
    await code(issueAmazonRefund(h.ctx, s.agent, caseId, { orderId: "302-0000000-0000002", reason: "Other", lines: [{ orderItemId: "3", principal: "5" }], confirm: true, expectedTotalCents: 500 }), "INVALID");

    const view = await lookupAmazonRefundOrder(h.ctx, s.agent, caseId, { orderId: ORDER });
    assert.equal(view.items[0]!.refundablePrincipalCents, 3980);
    assert.equal(view.items[0]!.refundableShippingCents, 490);
    const feedsBefore = amz.feeds.length;
    const input = { orderId: ORDER, reason: "CustomerReturn", lines: [{ orderItemId: A, principal: "19,90", shipping: "4,90" }], confirm: true as const, expectedTotalCents: 2480 };
    await code(issueAmazonRefund(h.ctx, s.agent, caseId, { ...input, confirm: false as unknown as true }), "CONFIRM_REQUIRED");
    await code(issueAmazonRefund(h.ctx, s.agent, caseId, { ...input, expectedTotalCents: 1990 }), "TOTAL_CHANGED");
    await code(issueAmazonRefund(h.ctx, s.agent, caseId, { ...input, reason: "Gratis" }), "INVALID");
    assert.equal(amz.feeds.length, feedsBefore, "nothing sent before a valid confirmation");

    const r = await issueAmazonRefund(h.ctx, s.agent, caseId, input);
    assert.equal(r.state, "submitted");
    assert.equal(amz.feeds.length, 1);
    assert.equal(amz.feeds[0]!.feedType, "POST_PAYMENT_ADJUSTMENT_DATA");
    assert.deepEqual(amz.feeds[0]!.marketplaceIds, [DE]);
    assert.match(amz.feeds[0]!.document, /<AmazonOrderItemCode>11111111111111<\/AmazonOrderItemCode>.*<Amount currency="EUR">19.90<\/Amount>.*<Amount currency="EUR">4.90<\/Amount>/s);

    // While the first is open, no second refund of the same order.
    await code(issueAmazonRefund(h.ctx, s.owner, caseId, { ...input, lines: [{ orderItemId: B, principal: "1" }], expectedTotalCents: 100 }), "IN_PROGRESS");

    const checked = await checkAmazonRefund(h.ctx, s.agent, caseId, r.id);
    assert.equal(checked.state, "accepted");
    // Now on the refund list with the amount.
    const entry = await one<{ amount_cents: number; note: string }>(h.ctx.db, "SELECT amount_cents, note FROM refund_entries WHERE conversation_id = $1", [caseId]);
    assert.equal(entry!.amount_cents, 2480);
    assert.match(entry!.note, /Bei Amazon erstattet/);

    // What is left: 19,90 € for A, nothing for its shipping.
    const again = await lookupAmazonRefundOrder(h.ctx, s.agent, caseId, { orderId: ORDER });
    assert.equal(again.items[0]!.refundablePrincipalCents, 1990);
    assert.equal(again.items[0]!.refundableShippingCents, 0);
    await code(issueAmazonRefund(h.ctx, s.agent, caseId, { ...input, lines: [{ orderItemId: A, principal: "19,91" }], expectedTotalCents: 1991 }), "INVALID");

    const caseData = await getCase(h.ctx, s.agent, caseId);
    assert.equal((caseData.marketplaceRefunds as Array<{ state: string }>)[0]!.state, "accepted");
    const log = await many<{ action: string }>(h.ctx.db, "SELECT action FROM audit_events WHERE target_id = $1 AND action LIKE 'amazon.refund%' ORDER BY created_at", [caseId]);
    assert.deepEqual(log.map((l) => l.action), ["amazon.refund_submitted", "amazon.refund_accepted"]);
  });

  it("reports a rejection and blocks the order after an unclear send until a person checked Seller Central", async () => {
    const { h, amz, s, caseId } = await setup();
    await setAmazonRefundsEnabled(h.ctx, s.owner, true);
    const input = { orderId: ORDER, reason: "GeneralAdjustment", lines: [{ orderItemId: B, principal: "5,00" }], confirm: true as const, expectedTotalCents: 500 };

    amz.fault.feed = "reject";
    const rejected = await issueAmazonRefund(h.ctx, s.agent, caseId, input);
    const res = await checkAmazonRefund(h.ctx, s.agent, caseId, rejected.id);
    assert.equal(res.state, "rejected");
    assert.match(res.messages[0]!, /exceeds/);

    amz.fault.feed = "reset";
    const unclear = await issueAmazonRefund(h.ctx, s.agent, caseId, input);
    assert.equal(unclear.state, "uncertain");
    amz.fault.feed = "none";
    await code(issueAmazonRefund(h.ctx, s.agent, caseId, input), "UNCERTAIN");
    await code(settleUncertainAmazonRefund(h.ctx, s.agent, caseId, unclear.id, { confirm: false as unknown as true, outcome: "not_refunded" }), "CONFIRM_REQUIRED");
    await settleUncertainAmazonRefund(h.ctx, s.agent, caseId, unclear.id, { confirm: true, outcome: "not_refunded" });
    const third = await issueAmazonRefund(h.ctx, s.agent, caseId, input);
    assert.equal(third.state, "submitted");
  });

  it("names the missing role when Amazon refuses orders", async () => {
    const { h, amz, s, caseId } = await setup();
    await setAmazonRefundsEnabled(h.ctx, s.owner, true);
    amz.fault.feed = "forbidden";
    await assert.rejects(lookupAmazonRefundOrder(h.ctx, s.agent, caseId, { orderId: ORDER }), /Inventory and Order Tracking/);
    const check = await checkAmazonListingConnection(h.ctx, s.owner);
    assert.equal(check.ok, false);
    assert.match(check.detail, /Inventory and Order Tracking/);
  });
});
