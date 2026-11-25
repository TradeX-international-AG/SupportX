import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isStale, needsAttention, sinceLabel } from "../../packages/core/fetch-freshness.ts";

const now = new Date("2026-11-12T12:00:00Z");
describe("fetch freshness", () => {
  it("flags reads older than 4 hours and missing reads", () => {
    assert.equal(isStale(null, now), true);
    assert.equal(isStale("garbage", now), true);
    assert.equal(isStale("2026-11-12T08:30:00Z", now), false);
    assert.equal(isStale("2026-11-12T07:59:00Z", now), true);
    assert.equal(isStale(new Date("2026-10-27T10:00:00Z"), now), true);
  });
  it("says how long ago in one short German phrase", () => {
    assert.equal(sinceLabel(null, now), "noch nie");
    assert.equal(sinceLabel("2026-11-12T11:59:40Z", now), "gerade eben");
    assert.equal(sinceLabel("2026-11-12T11:48:00Z", now), "vor 12 Min.");
    assert.equal(sinceLabel("2026-11-12T09:00:00Z", now), "vor 3 Std.");
    assert.equal(sinceLabel("2026-10-27T10:00:00Z", now), "vor 16 Tagen");
  });
  it("shows a line in the inbox only for problems", () => {
    const ok = { fetching: false, health: "ok", stale: false, background: false };
    assert.equal(needsAttention(ok), false, "Shop Apotheke read fine: no line");
    assert.equal(needsAttention({ ...ok, stale: true }), false, "read on display, nobody looked: no line");
    assert.equal(needsAttention({ ...ok, stale: true, background: true }), true, "worker channel not read for hours");
    assert.equal(needsAttention({ ...ok, health: "error" }), true, "last read failed");
    assert.equal(needsAttention({ ...ok, health: "error", fetching: true }), false, "retry running");
  });
});
