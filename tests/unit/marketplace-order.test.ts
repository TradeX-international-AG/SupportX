import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOrderId, KAUFLAND_STATUS_DE, MIRAKL_STATE_DE, OTTO_STATUS_DE, statusLabel, summariseLines } from "../../packages/core/marketplace-order.ts";
import { ALL_PLATFORMS, isMiraklPlatform, MESSAGING_RULE_PLATFORMS, PLATFORM_NAMES } from "../../packages/core/marketplaces.ts";
import { DEADLINE_PLATFORMS, DEFAULT_REPLY_DEADLINES } from "../../packages/core/deadline.ts";
import { checkDraft } from "../../packages/core/draft-check.ts";

test("status labels: known codes in German, unknown codes shown as they are", () => {
  assert.equal(statusLabel(MIRAKL_STATE_DE, "SHIPPED"), "versendet");
  assert.equal(statusLabel(KAUFLAND_STATUS_DE, "need_to_be_sent"), "zu versenden");
  assert.equal(statusLabel(OTTO_STATUS_DE, "CANCELLED_BY_MARKETPLACE"), "von OTTO storniert");
  assert.equal(statusLabel(OTTO_STATUS_DE, "SOMETHING_NEW"), "SOMETHING_NEW");
  assert.equal(statusLabel(OTTO_STATUS_DE, undefined), "unbekannt");
});

test("one order status from per-item states", () => {
  assert.equal(summariseLines([]), "keine Positionen");
  assert.equal(summariseLines([{ title: "a", statusLabel: "versendet", quantity: 2 }]), "versendet");
  assert.equal(summariseLines([{ title: "a", statusLabel: "versendet", quantity: 2 }, { title: "b", statusLabel: "storniert" }]), "gemischt: 2 × versendet, 1 × storniert");
});

test("only plausible order numbers go into a marketplace URL", () => {
  assert.equal(cleanOrderId(" DG-77-A "), "DG-77-A");
  assert.equal(cleanOrderId("M3KX7Q2"), "M3KX7Q2");
  for (const bad of ["../x", "a b", "x", "abc?d=1", "a/b"]) assert.equal(cleanOrderId(bad), null, bad);
});

test("every platform has a name; new marketplaces have deadlines and messaging rules", () => {
  for (const p of ALL_PLATFORMS) assert.ok(PLATFORM_NAMES[p]);
  for (const p of ["otto", "douglas", "mediamarkt_saturn", "conrad", "decathlon"] as const) {
    assert.ok((DEADLINE_PLATFORMS as readonly string[]).includes(p), p);
    assert.ok(DEFAULT_REPLY_DEADLINES[p] > 0, p);
    assert.ok(MESSAGING_RULE_PLATFORMS.includes(p), p);
  }
  assert.equal(isMiraklPlatform("douglas"), true);
  assert.equal(isMiraklPlatform("otto"), false);
});

test("Douglas replies get the marketplace messaging check (no mail addresses)", () => {
  const issues = checkDraft({ text: "Schreiben Sie uns an info@shop.example", citedFactIds: [], facts: [], order: null, orderStatus: "not_checked", allowedLinkPrefixes: [], sourcePlatform: "douglas" });
  assert.ok(issues.some((i) => i.code === "MARKETPLACE_CONTACT" && i.message.includes("Douglas")), JSON.stringify(issues));
});
