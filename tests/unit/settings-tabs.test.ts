import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS_TAB, parseSettingsTab, SETTINGS_TABS, settingsHash, tabAlerts } from "../../apps/web/src/settings-tabs.ts";

test("the three settings tabs in order", () => {
  assert.deepEqual(SETTINGS_TABS.map((t) => t.label), ["Anbindungen", "Marktplätze", "System"]);
  assert.equal(DEFAULT_SETTINGS_TAB, "anbindungen");
});

test("a hash names a tab; anything else names none", () => {
  assert.equal(parseSettingsTab("#marktplaetze"), "marktplaetze");
  assert.equal(parseSettingsTab("#System"), "system");
  assert.equal(parseSettingsTab("#weitere"), "system");
  assert.equal(parseSettingsTab("anbindungen"), "anbindungen");
  assert.equal(parseSettingsTab(""), null);
  assert.equal(parseSettingsTab("#"), null);
  assert.equal(parseSettingsTab("#posteingang"), null);
});

test("hash round trip", () => {
  for (const t of SETTINGS_TABS) assert.equal(parseSettingsTab(settingsHash(t.id)), t.id);
});

test("tab alerts count cards with an error", () => {
  const a = tabAlerts({ anbindungen: [{ error: "Zeitüberschreitung" }, { error: null }], marktplaetze: [{ error: null }] });
  assert.deepEqual(a, { anbindungen: 1, marktplaetze: 0, system: 0 });
});
