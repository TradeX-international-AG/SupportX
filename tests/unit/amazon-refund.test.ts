import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adjustmentFeedXml, checkRefund, feedAmount, parseProcessingReport, percentAmounts, refundBlocker, type AmazonOrderView } from "../../packages/core/amazon-refund.ts";
import { parseOrder } from "../../packages/connectors/amazon/refunds.ts";

// Synthetic order only.
const order: AmazonOrderView = {
  orderId: "302-0000000-0000001", status: "Shipped", fulfillmentChannel: "MFN", marketplaceId: "A1PA6795UKMFR9", currency: "EUR",
  items: [
    { orderItemId: "11111111111111", title: "Testartikel A", quantity: 2, itemPriceCents: 3980, shippingPriceCents: 490, promotionDiscountCents: 0 },
    { orderItemId: "22222222222222", title: "Testartikel B", quantity: 1, itemPriceCents: 1000, shippingPriceCents: 0, promotionDiscountCents: 200 },
  ],
};

describe("Amazon-Erstattung (Order Adjustment)", () => {
  it("allows refunds only after shipping", () => {
    assert.equal(refundBlocker(order), null);
    assert.match(refundBlocker({ status: "Unshipped" })!, /stornieren/);
    assert.match(refundBlocker({ status: "Canceled" })!, /storniert/);
  });

  it("caps each line at what was paid minus earlier refunds", () => {
    const ok = checkRefund(order, [{ orderItemId: "11111111111111", principalCents: 1990, shippingCents: 490 }, { orderItemId: "22222222222222", principalCents: 0, shippingCents: 0 }], []);
    assert.deepEqual(ok, { ok: true, lines: [{ orderItemId: "11111111111111", principalCents: 1990, shippingCents: 490 }], totalCents: 2480 });
    // Promotion: B paid 8,00 €, not 10,00 €.
    const promo = checkRefund(order, [{ orderItemId: "22222222222222", principalCents: 1000, shippingCents: 0 }], []);
    assert.equal(promo.ok, false);
    // Earlier refund of 19,90 € leaves 19,90 € for A.
    const earlier = [{ orderItemId: "11111111111111", principalCents: 1990, shippingCents: 490 }];
    assert.equal(checkRefund(order, [{ orderItemId: "11111111111111", principalCents: 1991, shippingCents: 0 }], earlier).ok, false);
    assert.equal(checkRefund(order, [{ orderItemId: "11111111111111", principalCents: 0, shippingCents: 1 }], earlier).ok, false);
    assert.equal(checkRefund(order, [{ orderItemId: "11111111111111", principalCents: 1990, shippingCents: 0 }], earlier).ok, true);
    assert.equal(checkRefund(order, [{ orderItemId: "99", principalCents: 100, shippingCents: 0 }], []).ok, false);
    assert.equal(checkRefund(order, [{ orderItemId: "11111111111111", principalCents: -1, shippingCents: 0 }], []).ok, false);
    assert.equal(checkRefund(order, [{ orderItemId: "11111111111111", principalCents: 0, shippingCents: 0 }], []).ok, false);
  });

  it("builds the OrderAdjustment feed with escaped values", () => {
    const doc = adjustmentFeedXml({ sellerId: "A1TEST<&>", orderId: order.orderId, currency: "EUR", reason: "CustomerReturn", lines: [{ orderItemId: "11111111111111", principalCents: 1990, shippingCents: 490 }] });
    assert.match(doc, /<MessageType>OrderAdjustment<\/MessageType>/);
    assert.match(doc, /<MerchantIdentifier>A1TEST&lt;&amp;&gt;<\/MerchantIdentifier>/);
    assert.match(doc, /<AmazonOrderID>302-0000000-0000001<\/AmazonOrderID>/);
    assert.match(doc, /<AdjustedItem><AmazonOrderItemCode>11111111111111<\/AmazonOrderItemCode><AdjustmentReason>CustomerReturn<\/AdjustmentReason>/);
    assert.match(doc, /<Component><Type>Principal<\/Type><Amount currency="EUR">19.90<\/Amount><\/Component><Component><Type>Shipping<\/Type><Amount currency="EUR">4.90<\/Amount><\/Component>/);
    assert.throws(() => adjustmentFeedXml({ sellerId: "A", orderId: "x</AmazonOrderID>", currency: "EUR", reason: "Other", lines: [] }));
    assert.equal(feedAmount(150 * 100, "JPY"), "150");
  });

  it("reads the processing report", () => {
    assert.deepEqual(parseProcessingReport("<ProcessingReport><ProcessingSummary><MessagesProcessed>1</MessagesProcessed><MessagesSuccessful>0</MessagesSuccessful><MessagesWithError>1</MessagesWithError></ProcessingSummary><Result><ResultCode>Error</ResultCode><ResultDescription>Amount &amp; more</ResultDescription></Result></ProcessingReport>"),
      { processed: 1, successful: 0, withError: 1, messages: ["Error: Amount & more"] });
    assert.equal(parseProcessingReport("<html/>"), null);
  });

  it("parses getOrder and getOrderItems", () => {
    const v = parseOrder(
      { payload: { AmazonOrderId: "302-0000000-0000001", OrderStatus: "Shipped", FulfillmentChannel: "AFN", MarketplaceId: "A1PA6795UKMFR9", OrderTotal: { CurrencyCode: "EUR", Amount: "24.80" } } },
      { payload: { OrderItems: [{ OrderItemId: "1", SellerSKU: "S", Title: "T", QuantityOrdered: 2, ItemPrice: { CurrencyCode: "EUR", Amount: "19.90" }, ShippingPrice: { CurrencyCode: "EUR", Amount: "4.90" } }] } },
    );
    assert.deepEqual(v.items[0], { orderItemId: "1", sku: "S", asin: undefined, title: "T", quantity: 2, itemPriceCents: 1990, shippingPriceCents: 490, promotionDiscountCents: 0 });
    assert.equal(v.fulfillmentChannel, "AFN");
  });

  it("computes a percentage of the paid item price, capped at what is left", () => {
    const items = order.items.map((i) => ({ ...i, refundablePrincipalCents: i.itemPriceCents - i.promotionDiscountCents }));
    assert.deepEqual(percentAmounts(items, 20), { "11111111111111": 796, "22222222222222": 160 });
    assert.deepEqual(percentAmounts(items, 12.5), { "11111111111111": 498, "22222222222222": 100 });
    // Earlier refund leaves only 1,00 € for A.
    assert.equal(percentAmounts([{ ...items[0]!, refundablePrincipalCents: 100 }], 50)!["11111111111111"], 100);
    for (const bad of [0, -5, 101, Number.NaN]) assert.equal(percentAmounts(items, bad), null);
    // The result passes the server check.
    const p = percentAmounts(items, 20)!;
    assert.equal(checkRefund(order, Object.entries(p).map(([orderItemId, principalCents]) => ({ orderItemId, principalCents, shippingCents: 0 })), []).ok, true);
  });
});
