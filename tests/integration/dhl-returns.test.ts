import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getCase } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { saveDhlConnection, trackCaseParcels } from "../../packages/services/dhl-tracking.ts";
import { attachReturnLabel, caseReturnLabels, checkDhlReturnConnection, createReturnLabel, deleteDhlReturnConnection, getDhlReturnSettings, previewReturnLabel, saveDhlReturnConnection } from "../../packages/services/dhl-returns.ts";
import { composeDraft, discardDraft } from "../../packages/services/replies.ts";
import { many, one } from "../../packages/storage/db.ts";
import { startFakeDhl, startFakeDhlReturns, type FakeDhl, type FakeDhlReturns } from "../../packages/testing/fake-dhl.ts";
import { caseByThread, closeDb, createHarness, currentDraft, loadDemoMails, seedWorkspace, syncAndDrain, type Harness, type SeededWorkspace } from "./harness.ts";

// Synthetic access data only.
const KEY = "TestDhlReturnsKey000000000000001";
const TRACK_KEY = "TestDhlTrackKey00000000000000001";
const USER = "returns-system-user";
const PASSWORD = "Synthetic-Pass-1";

let h: Harness | null = null;
let dhl: FakeDhlReturns | null = null;
let track: FakeDhl | null = null;
afterEach(async () => {
  await h?.close();
  await dhl?.close();
  await track?.close();
  h = null;
  dhl = null;
  track = null;
});
after(closeDb);

const code = (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: ServiceError) => e.code === expected);

async function setup(): Promise<{ h: Harness; dhl: FakeDhlReturns; s: SeededWorkspace; caseId: string }> {
  h = await createHarness();
  dhl = await startFakeDhlReturns({ apiKey: KEY, user: USER, password: PASSWORD, receiverIds: ["deu", "aut"] });
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  const conv = await caseByThread(h, s, "conv-amazon-wismo");
  assert.equal(conv.order_match_status, "unique");
  const open = await currentDraft(h, s, conv.id);
  if (open) await discardDraft(h.ctx, s.agent, open.id);
  return { h, dhl, s, caseId: conv.id };
}

const connect = (x: { h: Harness; dhl: FakeDhlReturns; s: SeededWorkspace }) =>
  saveDhlReturnConnection(x.h.ctx, x.s.owner, { user: USER, password: PASSWORD, apiKey: KEY, useTrackingKey: false, receiverGermany: "deu", receiverOthers: "AT=aut", apiUrl: x.dhl.url });

describe("DHL-Retourenlabel", () => {
  it("stores the access encrypted, shows only countries and changes fields only when typed", async () => {
    const x = await setup();
    const { h, dhl, s } = x;
    await code(saveDhlReturnConnection(h.ctx, s.agent, { user: USER, password: PASSWORD, apiKey: KEY, useTrackingKey: false, receiverGermany: "deu", apiUrl: dhl.url }), "FORBIDDEN");
    await code(saveDhlReturnConnection(h.ctx, s.owner, { user: USER, password: PASSWORD, apiKey: KEY, useTrackingKey: false, receiverGermany: "", apiUrl: dhl.url }), "INVALID");
    await code(saveDhlReturnConnection(h.ctx, s.owner, { user: USER, password: PASSWORD, apiKey: KEY, useTrackingKey: false, receiverGermany: "deu", receiverOthers: "CH=che", apiUrl: dhl.url }), "INVALID");
    await code(saveDhlReturnConnection(h.ctx, s.owner, { user: USER, password: PASSWORD, apiKey: KEY, useTrackingKey: false, receiverGermany: "deu", apiUrl: "https://evil.example/returns" }), "INVALID");
    await code(saveDhlReturnConnection(h.ctx, s.owner, { user: USER, password: PASSWORD, useTrackingKey: true, receiverGermany: "deu", apiUrl: dhl.url }), "INVALID");
    await connect(x);

    const view = await getDhlReturnSettings(h.ctx, s.viewer);
    assert.equal(view.configured, true);
    if (!view.configured) return;
    assert.deepEqual(view.countries, ["Deutschland", "Österreich"]);
    const json = JSON.stringify(view);
    for (const secret of [KEY, USER, PASSWORD, "\"deu\"", "\"aut\""]) assert.ok(!json.includes(secret), `settings must not show ${secret}`);
    const secrets = await many<{ ciphertext: Buffer }>(h.ctx.db, "SELECT ciphertext FROM secrets WHERE workspace_id = $1 AND purpose = 'dhl_returns'", [s.workspaceId]);
    assert.equal(secrets.length, 1);
    assert.ok(!secrets[0]!.ciphertext.toString("latin1").includes(PASSWORD));

    // Only the new password typed: user, key and receivers stay.
    await saveDhlReturnConnection(h.ctx, s.owner, { password: "Wrong-Pass", useTrackingKey: false, apiUrl: dhl.url });
    assert.equal((await checkDhlReturnConnection(h.ctx, s.owner)).ok, false);
    await saveDhlReturnConnection(h.ctx, s.owner, { password: PASSWORD, useTrackingKey: false, apiUrl: dhl.url });
    const ok = await checkDhlReturnConnection(h.ctx, s.owner);
    assert.equal(ok.ok, true, ok.detail);
    assert.equal(dhl.orders.length, 0, "the check makes no label");
    const again = await getDhlReturnSettings(h.ctx, s.owner);
    assert.ok(again.configured && again.countries.length === 2 && again.status === "ok");
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM secrets WHERE workspace_id = $1 AND purpose = 'dhl_returns'", [s.workspaceId])).length, 1, "old secret removed");

    await deleteDhlReturnConnection(h.ctx, s.owner);
    assert.equal((await getDhlReturnSettings(h.ctx, s.owner)).configured, false);
  });

  it("can use the key of the DHL tracking access", async () => {
    const x = await setup();
    const { h, s } = x;
    const returns = await startFakeDhlReturns({ apiKey: TRACK_KEY, user: USER, password: PASSWORD });
    try {
      track = await startFakeDhl({ apiKey: TRACK_KEY });
      await saveDhlConnection(h.ctx, s.owner, { apiKey: TRACK_KEY, apiUrl: track.url });
      await saveDhlReturnConnection(h.ctx, s.owner, { user: USER, password: PASSWORD, useTrackingKey: true, receiverGermany: "deu", apiUrl: returns.url });
      assert.equal((await checkDhlReturnConnection(h.ctx, s.owner)).ok, true);
    } finally {
      await returns.close();
    }
  });

  it("reads the address from the ERP, makes one label on confirmation, keeps the PDF and puts it on the reply", async () => {
    const x = await setup();
    const { h, dhl, s, caseId } = x;
    await code(previewReturnLabel(h.ctx, s.agent, caseId), "NOT_CONNECTED");
    await connect(x);
    const other = await seedWorkspace(h, "Anderer Händler");
    await code(previewReturnLabel(h.ctx, other.agent, caseId), "NOT_FOUND");
    await code(previewReturnLabel(h.ctx, s.viewer, caseId), "FORBIDDEN");

    const preview = await previewReturnLabel(h.ctx, s.agent, caseId);
    assert.equal(preview.orderNumber, "302-1234567-7654321");
    assert.deepEqual(preview.address, { name1: "Erika Müller-Beispiel", street: "Beispielweg", houseNumber: "12a", postalCode: "10115", city: "Berlin", countryCode: "DE" });
    assert.deepEqual(preview.problems, []);
    assert.equal(dhl.orders.length, 0, "the preview asks DHL nothing");

    await code(createReturnLabel(h.ctx, s.viewer, caseId, { address: preview.address!, attach: false }), "FORBIDDEN");
    await code(createReturnLabel(h.ctx, { type: "worker", workspaceId: s.workspaceId } as never, caseId, { address: preview.address!, attach: false }), "FORBIDDEN");
    await code(createReturnLabel(h.ctx, s.agent, caseId, { address: { ...preview.address!, postalCode: "1011" }, attach: false }), "INVALID_ADDRESS");
    await code(createReturnLabel(h.ctx, s.agent, caseId, { address: { ...preview.address!, countryCode: "CH" }, attach: false }), "INVALID_ADDRESS");
    await code(createReturnLabel(h.ctx, s.agent, caseId, { address: { ...preview.address!, countryCode: "FR" }, attach: false }), "INVALID_ADDRESS");
    assert.equal(dhl.orders.length, 0);

    // No draft yet: the label waits for the next reply.
    const made = await createReturnLabel(h.ctx, s.agent, caseId, { address: preview.address!, attach: true });
    assert.equal(dhl.orders.length, 1);
    assert.deepEqual(dhl.orders[0], {
      receiverId: "deu",
      customerReference: "302-1234567-7654321",
      shipper: { name1: "Erika Müller-Beispiel", addressStreet: "Beispielweg", addressHouse: "12a", postalCode: "10115", city: "Berlin", country: "DEU" },
      labelType: "SHIPMENT_LABEL",
    });
    assert.equal(made.attached, true);
    assert.equal(made.draftId, null);
    assert.match(made.label.shipmentNo, /^99999\d{7}$/);
    const c = await getCase(h.ctx, s.agent, caseId);
    const pdf = c.caseFiles.find((f) => f.source === "return_label");
    assert.ok(pdf);
    assert.equal(pdf.name, `DHL-Retourenlabel ${made.label.shipmentNo}.pdf`);
    assert.equal(pdf.for_next_reply, true);
    const doc = await one<{ data: Buffer }>(h.ctx.db, "SELECT data FROM documents WHERE id = $1", [pdf.id]);
    assert.equal(doc!.data.subarray(0, 5).toString("latin1"), "%PDF-");

    // Writing the reply takes the waiting label along.
    const composed = await composeDraft(h.ctx, s.agent, caseId, "Anbei Ihr Retourenlabel.");
    const draft = await one<{ document_ids: string[] }>(h.ctx.db, "SELECT document_ids FROM drafts WHERE id = $1", [composed.draftId]);
    assert.deepEqual(draft!.document_ids, [pdf.id]);

    // A second label only knowingly; not by a double click.
    await code(createReturnLabel(h.ctx, s.agent, caseId, { address: preview.address!, attach: false }), "LABEL_EXISTS");
    await code(createReturnLabel(h.ctx, s.agent, caseId, { address: preview.address!, attach: false, again: true }), "LABEL_EXISTS");
    assert.equal(dhl.orders.length, 1);
    const later = { ...h.ctx, now: () => new Date(Date.now() + 60_000) };
    const second = await createReturnLabel(later, s.agent, caseId, { address: { ...preview.address!, name2: "c/o Nachbar" }, attach: false, again: true });
    assert.equal(dhl.orders.length, 2);
    const list = await caseReturnLabels(h.ctx, s.viewer, caseId);
    assert.deepEqual(list.labels.map((l) => l.shipmentNo), [made.label.shipmentNo, second.label.shipmentNo]);
    // "An Antwort anhängen" later: onto the open draft.
    const attached = await attachReturnLabel(h.ctx, s.agent, caseId, second.label.id);
    assert.equal(attached.draftId, composed.draftId);
    const after2 = await one<{ document_ids: string[] }>(h.ctx.db, "SELECT document_ids FROM drafts WHERE id = $1", [composed.draftId]);
    assert.equal(after2!.document_ids.length, 2);
    await code(attachReturnLabel(h.ctx, other.agent, caseId, second.label.id), "NOT_FOUND");

    const audits = await many<{ action: string }>(h.ctx.db, "SELECT action FROM audit_events WHERE workspace_id = $1 AND action LIKE 'return_label.%' ORDER BY id", [s.workspaceId]);
    assert.deepEqual(audits.map((a) => a.action), ["return_label.created", "return_label.created", "return_label.attached"]);
  });

  it("shows the return label's parcel in the DHL status", async () => {
    const x = await setup();
    const { h, s, caseId } = x;
    await connect(x);
    const preview = await previewReturnLabel(h.ctx, s.agent, caseId);
    const made = await createReturnLabel(h.ctx, s.agent, caseId, { address: preview.address!, attach: false });
    track = await startFakeDhl({ apiKey: TRACK_KEY, parcels: { [made.label.shipmentNo]: { statusCode: "transit", status: "Rücksendung unterwegs", timestamp: "2026-11-25T09:00:00+01:00", returnFlag: true } } });
    await saveDhlConnection(h.ctx, s.owner, { apiKey: TRACK_KEY, apiUrl: track.url });
    const status = await trackCaseParcels(h.ctx, s.agent, caseId);
    const parcel = status.parcels.find((p) => p.target.trackingNumber === made.label.shipmentNo);
    assert.ok(parcel, "label number is a tracked parcel");
    assert.equal(parcel.target.origin, "return_label");
    assert.equal(parcel.result?.state, "found");
  });

  it("says what failed and makes nothing when DHL refuses, and warns on an unclear timeout", async () => {
    const x = await setup();
    const { h, dhl, s, caseId } = x;
    await saveDhlReturnConnection(h.ctx, s.owner, { user: USER, password: "Wrong-Pass", apiKey: KEY, useTrackingKey: false, receiverGermany: "deu", apiUrl: dhl.url });
    const preview = await previewReturnLabel(h.ctx, s.agent, caseId);
    await assert.rejects(createReturnLabel(h.ctx, s.agent, caseId, { address: preview.address!, attach: false }), (e: ServiceError) => e.code === "DHL_AUTH" && /Benutzer oder Passwort/.test(e.message));
    const view = await getDhlReturnSettings(h.ctx, s.owner);
    assert.ok(view.configured && view.status === "error");
    // A receiver DHL does not know.
    await saveDhlReturnConnection(h.ctx, s.owner, { user: USER, password: PASSWORD, apiKey: KEY, useTrackingKey: false, receiverGermany: "gibtsnicht", apiUrl: dhl.url });
    await assert.rejects(createReturnLabel(h.ctx, s.agent, caseId, { address: preview.address!, attach: false }), (e: ServiceError) => e.code === "DHL_ERROR" && /Receiver ID is invalid/.test(e.message));
    assert.equal((await caseReturnLabels(h.ctx, s.agent, caseId)).labels.length, 0);
    assert.equal((await getCase(h.ctx, s.agent, caseId)).caseFiles.length, 0);
  });
});
