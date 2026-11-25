import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_PLATFORMS, PLATFORM_MARKS, platformMark } from "../../packages/core/marketplaces.ts";

test("every platform has a mark; only e-mail and phone use a pictogram", () => {
  for (const p of ALL_PLATFORMS) {
    const text = PLATFORM_MARKS[p];
    if (p === "email" || p === "phone") assert.equal(text, null, p);
    else assert.ok(text && text.length >= 2 && text.length <= 4, `${p}: ${text}`);
  }
  const texts = ALL_PLATFORMS.map((p) => PLATFORM_MARKS[p]).filter(Boolean);
  assert.equal(new Set(texts).size, texts.length, "marks are unique");
});

test("marketplace message shows its own mark", () => {
  assert.deepEqual(platformMark("ebay"), { platform: "ebay", text: "eBay", via: null, name: "eBay" });
});

test("order channel wins over the way it came in, which stays visible", () => {
  const m = platformMark("email", "docmorris");
  assert.equal(m.platform, "docmorris");
  assert.equal(m.text, "DM");
  assert.equal(m.via, "email");
  assert.equal(m.name, "DocMorris, eingegangen per E-Mail");
});

test("same origin as source is not doubled", () => {
  assert.equal(platformMark("amazon", "amazon").via, null);
});

test("plain e-mail and unknown platforms get the neutral pictogram", () => {
  assert.deepEqual(platformMark("email", null), { platform: "email", text: null, via: null, name: "E-Mail" });
  const u = platformMark("temu");
  assert.equal(u.platform, "unknown");
  assert.equal(u.text, null);
  assert.match(u.name, /Unbekannte Herkunft/);
  assert.equal(platformMark(null).platform, "unknown");
  assert.equal(platformMark("toString").platform, "unknown");
});
