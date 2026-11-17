import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getCase } from "../../packages/services/cases.ts";
import { setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { removeWaitingFile, uploadReplyFile } from "../../packages/services/documents.ts";
import { draftInvoiceReply } from "../../packages/services/invoices.ts";
import { approveDraft, composeDraft, discardDraft, dispatchOutbox, queueReply, requestRedraft } from "../../packages/services/replies.ts";
import { drainJobs } from "../../packages/services/worker.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, currentDraft, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: ServiceError) => e.code === code);
const PDF = Buffer.from("%PDF-1.4\n% Foto\n%%EOF");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("bild")]);

async function caseWithoutDraft(thread = "conv-amazon-wismo") {
  h = await createHarness({ sendMode: "enabled" });
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  const conv = await caseByThread(h, s, thread);
  const open = await currentDraft(h, s, conv.id);
  if (open) await discardDraft(h.ctx, s.agent, open.id);
  return { h, s, conv };
}

const docIds = async (h: Harness, draftId: string) => (await one<{ document_ids: string[] }>(h.ctx.db, "SELECT document_ids FROM drafts WHERE id = $1", [draftId]))!.document_ids;

describe("Datei anhängen before the reply is written", () => {
  it("keeps the file with the case and puts it on the next draft, also after a new decision, and sends it", async () => {
    const { h, s, conv } = await caseWithoutDraft();
    const other = await seedWorkspace(h, "Anderer Händler");
    await rejectsWith(uploadReplyFile(h.ctx, s.viewer, conv.id, { name: "a.pdf", data: PDF }), "FORBIDDEN");
    await rejectsWith(uploadReplyFile(h.ctx, other.agent, conv.id, { name: "a.pdf", data: PDF }), "NOT_FOUND");
    await rejectsWith(uploadReplyFile(h.ctx, s.agent, conv.id, { name: "a.exe", data: Buffer.from("MZ..") }), "UNSUPPORTED_TYPE");

    const { file, draftId } = await uploadReplyFile(h.ctx, s.agent, conv.id, { name: "Etikett", data: PNG });
    assert.equal(draftId, null, "no draft yet: the file waits");
    assert.equal(file.for_next_reply, true);
    const gone = await uploadReplyFile(h.ctx, s.agent, conv.id, { name: "falsch.pdf", data: PDF });
    await rejectsWith(removeWaitingFile(h.ctx, other.agent, conv.id, gone.file.id), "NOT_FOUND");
    await removeWaitingFile(h.ctx, s.agent, conv.id, gone.file.id);
    assert.deepEqual((await getCase(h.ctx, s.agent, conv.id)).caseFiles.filter((f) => f.for_next_reply).map((f) => f.name), ["Etikett.png"]);

    // "Individuell" writes the draft: the file is on it.
    const composed = await composeDraft(h.ctx, s.agent, conv.id, "Die richtige Dose geht heute raus.");
    assert.deepEqual(await docIds(h, composed.draftId), [file.id]);
    assert.equal((await getCase(h.ctx, s.agent, conv.id)).caseFiles.filter((f) => f.for_next_reply).length, 0, "no longer waiting");

    // Another decision rewrites the reply: the attachment stays.
    await requestRedraft(h.ctx, s.agent, conv.id, "customer_right");
    await drainJobs(h.ctx, { maxJobs: 50 });
    const redrafted = (await currentDraft(h, s, conv.id))!;
    assert.notEqual(redrafted.id, composed.draftId);
    assert.deepEqual(await docIds(h, redrafted.id), [file.id]);

    // With an open draft the file goes straight onto it.
    const second = await uploadReplyFile(h.ctx, s.agent, conv.id, { name: "Rechnungskopie.pdf", data: PDF });
    assert.equal(second.draftId, redrafted.id);
    const now = (await currentDraft(h, s, conv.id))!;
    assert.deepEqual(await docIds(h, now.id), [file.id, second.file.id]);

    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "amazon", evidenceNote: "Testantwort kam im Käuferpostfach an" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    const approval = await approveDraft(h.ctx, s.agent, now.id, { expectedVersion: now.version, acknowledgeWarnings: true });
    const outboxId = await queueReply(h.ctx, s.agent, approval);
    assert.equal(await dispatchOutbox(h.ctx, s.workspaceId, outboxId), "provider_accepted");
    assert.deepEqual(h.graph.replies.at(-1)!.attachments.map((a) => [a.name, a.contentType]), [["Etikett.png", "image/png"], ["Rechnungskopie.pdf", "application/pdf"]]);
  });

  it("puts the invoice first and keeps waiting files on an invoice reply; stays within three files", async () => {
    const { h, s, conv } = await caseWithoutDraft();
    const ids: string[] = [];
    for (const n of ["a", "b", "c"]) ids.push((await uploadReplyFile(h.ctx, s.agent, conv.id, { name: `${n}.pdf`, data: PDF })).file.id);
    await rejectsWith(uploadReplyFile(h.ctx, s.agent, conv.id, { name: "d.pdf", data: PDF }), "TOO_MANY");
    const result = await draftInvoiceReply(h.ctx, s.agent, conv.id);
    assert.deepEqual(await docIds(h, result.draftId), [result.files[0]!.id, ids[0], ids[1]], "invoice first, then as many as fit");
  });
});
