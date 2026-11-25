import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { caseCounts, closeAllInTab, listCases } from "../../packages/services/cases.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const status = async (id: string) => (await one<{ status: string }>(h!.ctx.db, "SELECT status FROM conversations WHERE id = $1", [id]))!.status;
const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id as string);

describe("Alle erledigt in Werbung & Infos", () => {
  it("closes only the open cases of that tab, up to the time the list was shown", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    const early = new Date(Date.now() - 3_600_000);
    for (const key of ["nl-1", "nl-2"]) h.graph.addInbound({ from: "news@shop-partner.example.invalid", subject: `Newsletter ${key}`, body: "Aktion", conversationId: key, receivedAt: early });
    h.graph.addInbound({ from: "seller-notification@amazon.de", subject: "Rückerstattung veranlasst – Bestellung 302-1111111-2222222", body: "Erstattet.", conversationId: "notice", receivedAt: early });
    h.graph.addInbound({ from: "kunde@example.invalid", subject: "Wo bleibt mein Paket?", body: "Bitte um Info.", conversationId: "request", receivedAt: early });
    h.graph.addInbound({ from: "news@shop-partner.example.invalid", subject: "Newsletter spät", body: "Aktion", conversationId: "nl-late" });
    await syncAndDrain(h, s);
    await syncAndDrain(h, other);
    const c = async (key: string, ws = s) => (await caseByThread(h!, ws, key)).id;
    const info = [await c("nl-1"), await c("nl-2"), await c("nl-late")];
    await h.ctx.db.query("UPDATE conversations SET category = 'info', category_reason = 'Newsletter' WHERE id = ANY($1)", [info]);
    const foreign = await c("nl-1", other);
    await h.ctx.db.query("UPDATE conversations SET category = 'info', category_reason = 'Newsletter' WHERE id = $1", [foreign]);
    const notice = await c("notice");
    const request = await c("request");
    assert.equal((await caseCounts(h.ctx, s.agent)).info, 3);

    await assert.rejects(closeAllInTab(h.ctx, s.viewer, "info", new Date().toISOString()), /403|Berechtigung|Rolle|darf/i);

    // The list was shown before "Newsletter spät" arrived.
    const closed = await closeAllInTab(h.ctx, s.agent, "info", new Date(early.getTime() + 1000).toISOString());
    assert.equal(closed, 2);
    assert.equal(await status(info[0]!), "closed");
    assert.equal(await status(info[1]!), "closed");
    assert.equal(await status(info[2]!), "open", "arrived after the list was shown");
    assert.equal(await status(notice), "open", "order notices are their own tab");
    assert.equal(await status(request), "open", "customer requests stay");
    assert.equal(await status(foreign), "open", "other workspace untouched");
    assert.deepEqual(ids(await listCases(h.ctx, s.agent, "info")), [info[2]]);
    assert.equal((await caseCounts(h.ctx, s.agent)).info, 1);
    assert.ok(ids(await listCases(h.ctx, s.agent, "all")).includes(info[0]!), "still under Alle");

    // Order notices: same button in their tab.
    assert.equal(await closeAllInTab(h.ctx, s.agent, "orders", new Date().toISOString()), 1);
    assert.equal(await status(notice), "closed");
    assert.equal((await caseCounts(h.ctx, s.agent)).orders, 0);

    // A new mail in the same thread opens the case again.
    h.graph.addInbound({ from: "news@shop-partner.example.invalid", subject: "Newsletter nl-1", body: "Nochmal", conversationId: "nl-1" });
    await syncAndDrain(h, s);
    assert.equal(await status(info[0]!), "open");
    assert.ok(ids(await listCases(h.ctx, s.agent, "info")).includes(info[0]!));
  });
});
