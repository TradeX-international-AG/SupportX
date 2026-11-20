import { test } from "node:test";
import assert from "node:assert/strict";
import { detectOrigin, platformsNamedIn } from "../../packages/core/order-origin.ts";
import { DOCMORRIS_SALES_URL, orderLinks } from "../../apps/web/src/order-links.ts";

test("an e-mail about a DocMorris order is recognised from the weclapp sales channel name", () => {
  const origin = detectOrigin({ sourcePlatform: "email", order: { salesChannel: "NET3", salesChannelName: "DocMorris Marktplatz", orderNumber: "1P5160", orderNumberAtCustomer: "66364" } });
  assert.deepEqual(origin && { platform: origin.platform, label: origin.label, via: origin.via }, { platform: "docmorris", label: "DocMorris", via: "weclapp" });
});

test("the case's own marketplace and the seller account come first", () => {
  assert.equal(detectOrigin({ sourcePlatform: "kaufland", order: { salesChannelName: "DocMorris" } })?.via, "case");
  assert.equal(detectOrigin({ sourcePlatform: "email", accountPlatform: "ebay", order: { salesChannelName: "DocMorris" } })?.platform, "ebay");
});

test("Amazon and eBay order numbers decide before a channel name that names no marketplace", () => {
  assert.equal(detectOrigin({ sourcePlatform: "email", order: { salesChannelName: "Marktplätze", orderNumberAtCustomer: "028-0960602-3405919" } })?.platform, "amazon");
  assert.equal(detectOrigin({ sourcePlatform: "email", order: { orderNumberAtCustomer: "12-34567-89012" } })?.platform, "ebay");
});

test("an own channel name is shown as it is, without a platform", () => {
  const origin = detectOrigin({ sourcePlatform: "email", order: { salesChannelName: "Webshop" }, text: "ich habe bei DocMorris bestellt" });
  assert.deepEqual(origin && { platform: origin.platform, label: origin.label }, { platform: null, label: "Webshop" });
});

test("customer text only labels the case when it names exactly one marketplace", () => {
  const text = "ich habe von Ihnen eine Lieferung erhalten, die ich über DocMorris bestellt hatte.";
  const origin = detectOrigin({ sourcePlatform: "email", order: { orderNumber: "1P5160" }, text });
  assert.equal(origin?.platform, "docmorris");
  assert.equal(origin?.via, "text");
  assert.equal(detectOrigin({ sourcePlatform: "email", text: "Bei Amazon war es billiger als bei eBay." }), null);
  assert.equal(detectOrigin({ sourcePlatform: "email", text: "Mit freundlichen Grüßen, Otto Meier" }), null, "Otto as a first name is no marketplace");
  assert.deepEqual(platformsNamedIn("Bestellung über OTTO Market"), ["otto"]);
  assert.equal(detectOrigin({ sourcePlatform: "phone" }), null);
});

test("a DocMorris order links to the partner portal and copies the order number for its search", () => {
  const links = orderLinks({ order: { id: "4711", orderNumber: "1P5160", orderNumberAtCustomer: "66364" }, platforms: ["email", null, "docmorris"], erpBaseUrl: "https://firma.weclapp.com/webapp/api/v2" });
  assert.deepEqual(links, [
    { label: "Auftrag in weclapp", href: "https://firma.weclapp.com/app/sales-order/4711" },
    { label: "Bestellung bei DocMorris", href: DOCMORRIS_SALES_URL, copy: "1P5160" },
  ]);
});

test("an e-mail case whose order came from a Mirakl marketplace links into that operator's back office", () => {
  const links = orderLinks({ order: { id: "x", orderNumberAtCustomer: "DG-9-A" }, platforms: ["email", "douglas"], miraklBaseUrls: { douglas: "https://douglas.mirakl.net", shop_apotheke: "https://sa.mirakl.net" } });
  assert.deepEqual(links.map((l) => l.href), ["https://douglas.mirakl.net/mmp/shop/order/DG-9-A"]);
});
