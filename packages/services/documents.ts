import { createHash } from "node:crypto";
import { many, one, withTx, type Tx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import type { ChannelKind } from "./connections.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/** Per PDF and per reply: Graph takes attachments inline only up to about 3 MB per request. */
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
export const MAX_REPLY_DOCUMENTS = 3;
const MAX_DOCUMENTS = 50;
const UUID = /^[0-9a-f-]{36}$/i;

/** Whether a reply over this connection can carry files, and what to do otherwise. */
export const REPLY_FILES: Record<ChannelKind, { supported: boolean; note: string }> = {
  // Amazon, DocMorris, Shopify and other mail answers go out as a mail reply with the file attached.
  microsoft_graph: { supported: true, note: "Die Datei geht als Anhang der Antwortmail raus. Amazon leitet PDF-, JPG- und PNG-Anhänge an den Käufer weiter." },
  kaufland_tickets: { supported: true, note: "Die Datei wird an die Ticket-Nachricht bei Kaufland angehängt." },
  mirakl_inbox: { supported: true, note: "Die Datei wird an die Nachricht bei Shop Apotheke angehängt." },
  ebay_messages: { supported: false, note: "eBay nimmt in Nachrichten keine Dateien an. Ausweg: die Datei hier herunterladen und im eBay-Verkäuferportal bei der Bestellung bzw. Nachricht selbst hochladen, oder die wichtigsten Punkte in die Antwort schreiben." },
};

/** File types a person may attach to one reply. The content is never interpreted. */
const CASE_FILE_TYPES: ReadonlyArray<{ contentType: string; ext: string; magic: (b: Buffer) => boolean }> = [
  { contentType: "application/pdf", ext: "pdf", magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { contentType: "image/jpeg", ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { contentType: "image/png", ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
];

export interface CaseFileInfo {
  id: string;
  name: string;
  size: number;
  content_type: string;
  source: "upload" | "erp_invoice";
  for_next_reply: boolean;
  created_at: Date;
}

export interface DocumentInfo {
  id: string;
  name: string;
  size: number;
  created_at: Date;
}

function cleanName(raw: string, ext = "pdf"): string {
  const base = raw.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f"<>|*?:]/g, "").trim().slice(0, 120);
  const name = base || "Dokument";
  const wanted = ext === "jpg" ? /\.jpe?g$/i : new RegExp(`\\.${ext}$`, "i");
  return wanted.test(name) ? name : `${name.replace(/\.(pdf|jpe?g|png)$/i, "")}.${ext}`;
}

export async function listDocuments(ctx: AppContext, actor: Actor): Promise<DocumentInfo[]> {
  return many<DocumentInfo>(ctx.db, "SELECT id, name, size, created_at FROM documents WHERE workspace_id = $1 AND conversation_id IS NULL AND deleted_at IS NULL ORDER BY name", [actor.workspaceId]);
}

/** Only real PDFs up to the limit; the content is never interpreted. */
export async function uploadDocument(ctx: AppContext, actor: Actor, input: { name: string; data: Buffer }): Promise<DocumentInfo> {
  requireRole(actor, ["owner"]);
  if (input.data.length === 0) throw new ServiceError(400, "INVALID", "Die Datei ist leer.");
  if (input.data.length > MAX_DOCUMENT_BYTES) throw new ServiceError(413, "TOO_LARGE", "Die PDF ist zu groß (höchstens 3 MB). Bitte verkleinern, z. B. beim Export „für Web“ wählen.");
  if (input.data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ServiceError(400, "NOT_PDF", "Das ist keine PDF-Datei. Bitte nur PDFs hochladen.");
  const count = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1 AND conversation_id IS NULL AND deleted_at IS NULL", [actor.workspaceId]);
  if ((count?.n ?? 0) >= MAX_DOCUMENTS) throw new ServiceError(409, "TOO_MANY", `Es sind schon ${MAX_DOCUMENTS} Dokumente hinterlegt. Bitte erst ein altes entfernen.`);
  const row = await one<DocumentInfo>(
    ctx.db,
    "INSERT INTO documents (workspace_id, name, size, sha256, data, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, size, created_at",
    [actor.workspaceId, cleanName(input.name), input.data.length, createHash("sha256").update(input.data).digest("hex"), input.data, actorId(actor)],
  );
  await audit(ctx.db, actor, "document.uploaded", "document", row!.id, { name: row!.name, size: row!.size });
  return row!;
}

export async function deleteDocument(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  requireRole(actor, ["owner"]);
  if (!UUID.test(id)) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  const row = await one(ctx.db, "UPDATE documents SET deleted_at = now() WHERE workspace_id = $1 AND id = $2 AND conversation_id IS NULL AND deleted_at IS NULL RETURNING id", [actor.workspaceId, id]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  await audit(ctx.db, actor, "document.deleted", "document", id);
}

export async function getDocument(ctx: AppContext, actor: Actor, id: string): Promise<{ name: string; data: Buffer; content_type: string }> {
  if (!UUID.test(id)) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  const row = await one<{ name: string; data: Buffer; content_type: string }>(ctx.db, "SELECT name, data, content_type FROM documents WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL", [actor.workspaceId, id]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  return row;
}

/**
 * Choose the PDFs that go out with a draft. This is a change to the draft: the
 * version goes up and earlier approvals no longer count, so a person approves
 * text and files together.
 */
export async function setDraftDocuments(ctx: AppContext, actor: Actor, draftId: string, input: { documentIds: string[]; expectedVersion: number }): Promise<{ version: number }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(draftId)) throw new ServiceError(404, "NOT_FOUND", "Entwurf nicht gefunden.");
  return withTx(ctx.db, (tx) => applyDraftDocuments(tx, actor, draftId, input.documentIds, input.expectedVersion));
}

export interface LockedDraft {
  status: string;
  version: number;
  kind: ChannelKind;
  conversation_id: string;
  document_ids: string[];
}

export async function lockDraft(tx: Tx, actor: Actor, draftId: string, expectedVersion: number): Promise<LockedDraft> {
  const draft = await one<LockedDraft>(
    tx,
    `SELECT d.status, d.version, d.conversation_id, d.document_ids, cc.kind FROM drafts d
       JOIN conversations c ON c.workspace_id = d.workspace_id AND c.id = d.conversation_id
       JOIN channel_connections cc ON cc.workspace_id = c.workspace_id AND cc.id = c.connection_id
      WHERE d.workspace_id = $1 AND d.id = $2 FOR UPDATE OF d`,
    [actor.workspaceId, draftId],
  );
  if (!draft) throw new ServiceError(404, "NOT_FOUND", "Entwurf nicht gefunden.");
  if (!["proposed", "edited"].includes(draft.status)) throw new ServiceError(409, "DRAFT_CLOSED", "Dieser Entwurf ist nicht mehr aktuell.");
  if (draft.version !== expectedVersion) throw new ServiceError(409, "VERSION_CONFLICT", "Der Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.");
  return draft;
}

/**
 * Set the files of a locked draft. Workspace documents and this case's own files
 * are allowed, never another case's files. Voids earlier approvals.
 */
export async function applyDraftDocuments(tx: Tx, actor: Actor, draftId: string, documentIds: string[], expectedVersion: number, locked?: LockedDraft): Promise<{ version: number }> {
  const ids = [...new Set(documentIds)];
  if (ids.some((id) => !UUID.test(id))) throw new ServiceError(400, "INVALID", "Ungültige Dokument-ID.");
  if (ids.length > MAX_REPLY_DOCUMENTS) throw new ServiceError(400, "TOO_MANY", `Höchstens ${MAX_REPLY_DOCUMENTS} Anhänge je Antwort.`);
  const draft = locked ?? (await lockDraft(tx, actor, draftId, expectedVersion));
  if (ids.length > 0 && !REPLY_FILES[draft.kind].supported) throw new ServiceError(409, "NOT_SUPPORTED", REPLY_FILES[draft.kind].note);
  const docs = ids.length
    ? await many<{ id: string; size: number }>(
        tx,
        "SELECT id, size FROM documents WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL AND (conversation_id IS NULL OR conversation_id = $3)",
        [actor.workspaceId, ids, draft.conversation_id],
      )
    : [];
  if (docs.length !== ids.length) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  if (docs.reduce((sum, d) => sum + d.size, 0) > MAX_DOCUMENT_BYTES) throw new ServiceError(413, "TOO_LARGE", "Zusammen sind die Anhänge zu groß (höchstens 3 MB je Antwort). Bitte weniger anhängen.");
  const updated = await one<{ version: number }>(
    tx,
    "UPDATE drafts SET document_ids = $3::uuid[], version = version + 1, status = 'edited', updated_by = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING version",
    [actor.workspaceId, draftId, ids, actorId(actor)],
  );
  await tx.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'Anhänge geändert' WHERE workspace_id = $1 AND draft_id = $2 AND invalidated_at IS NULL", [actor.workspaceId, draftId]);
  await tx.query("UPDATE outbox SET state = 'suppressed', last_error = 'Anhänge geändert', updated_at = now() WHERE workspace_id = $1 AND draft_id = $2 AND state = 'planned'", [actor.workspaceId, draftId]);
  await audit(tx, actor, "draft.documents_set", "draft", draftId, { documents: ids.length, version: updated!.version });
  return { version: updated!.version };
}

/** Check a file for one reply: PDF, JPG or PNG by content (not by name), within the size limit. */
export function checkCaseFile(name: string, data: Buffer): { name: string; contentType: string } {
  if (data.length === 0) throw new ServiceError(400, "INVALID", "Die Datei ist leer.");
  if (data.length > MAX_DOCUMENT_BYTES) throw new ServiceError(413, "TOO_LARGE", "Die Datei ist zu groß (höchstens 3 MB je Antwort). Bitte verkleinern.");
  const type = CASE_FILE_TYPES.find((t) => t.magic(data));
  if (!type) throw new ServiceError(400, "UNSUPPORTED_TYPE", "Diese Datei kann nicht angehängt werden. Erlaubt sind PDF, JPG und PNG.");
  return { name: cleanName(name, type.ext), contentType: type.contentType };
}

/** Store a file for one case (not in the workspace list). */
export async function storeCaseFile(
  tx: Tx,
  actor: Actor,
  conversationId: string,
  file: { name: string; contentType: string; data: Buffer; source: "upload" | "erp_invoice"; externalRef?: string; forNextReply?: boolean },
): Promise<CaseFileInfo> {
  const row = await one<CaseFileInfo>(
    tx,
    `INSERT INTO documents (workspace_id, conversation_id, source, external_ref, name, content_type, size, sha256, data, created_by, for_next_reply)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, name, size, content_type, source, for_next_reply, created_at`,
    [actor.workspaceId, conversationId, file.source, file.externalRef ?? null, file.name, file.contentType, file.data.length, createHash("sha256").update(file.data).digest("hex"), file.data, actorId(actor), file.forNextReply ?? false],
  );
  await audit(tx, actor, file.source === "erp_invoice" ? "case_file.invoice_fetched" : "case_file.uploaded", "conversation", conversationId, { name: row!.name, size: row!.size });
  return row!;
}

/**
 * "Datei anhängen": a file for this one reply. It is stored with the case and added
 * to the draft's attachments; like any change to the files, it voids earlier approvals.
 */
export async function attachUploadedFile(ctx: AppContext, actor: Actor, draftId: string, input: { name: string; data: Buffer; expectedVersion: number }): Promise<{ version: number; file: CaseFileInfo }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(draftId)) throw new ServiceError(404, "NOT_FOUND", "Entwurf nicht gefunden.");
  const checked = checkCaseFile(input.name, input.data);
  return withTx(ctx.db, async (tx) => {
    const draft = await lockDraft(tx, actor, draftId, input.expectedVersion);
    if (!REPLY_FILES[draft.kind].supported) throw new ServiceError(409, "NOT_SUPPORTED", REPLY_FILES[draft.kind].note);
    if (draft.document_ids.length >= MAX_REPLY_DOCUMENTS) throw new ServiceError(400, "TOO_MANY", `Höchstens ${MAX_REPLY_DOCUMENTS} Anhänge je Antwort.`);
    const file = await storeCaseFile(tx, actor, draft.conversation_id, { ...checked, data: input.data, source: "upload" });
    const { version } = await applyDraftDocuments(tx, actor, draftId, [...draft.document_ids, file.id], input.expectedVersion, draft);
    return { version, file };
  });
}

/**
 * "Datei anhängen" in the answer box before a reply is written. If a draft is open,
 * the file goes straight onto it. Otherwise it waits with the case and goes onto the
 * next draft, whichever decision writes it ("Kunde hat recht", "Individuell", …).
 */
export async function uploadReplyFile(ctx: AppContext, actor: Actor, conversationId: string, input: { name: string; data: Buffer }): Promise<{ file: CaseFileInfo; draftId: string | null }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const checked = checkCaseFile(input.name, input.data);
  return withTx(ctx.db, async (tx) => {
    const kind = await lockCaseForFiles(tx, actor, conversationId);
    if (!REPLY_FILES[kind].supported) throw new ServiceError(409, "NOT_SUPPORTED", REPLY_FILES[kind].note);
    const open = await openDraftOf(tx, actor, conversationId);
    if (open) {
      const draft = await lockDraft(tx, actor, open.id, open.version);
      if (draft.document_ids.length >= MAX_REPLY_DOCUMENTS) throw new ServiceError(400, "TOO_MANY", `Höchstens ${MAX_REPLY_DOCUMENTS} Anhänge je Antwort.`);
      const file = await storeCaseFile(tx, actor, conversationId, { ...checked, data: input.data, source: "upload" });
      await applyDraftDocuments(tx, actor, open.id, [...draft.document_ids, file.id], open.version, draft);
      return { file, draftId: open.id };
    }
    await checkWaitingRoom(tx, actor, conversationId, input.data.length);
    const file = await storeCaseFile(tx, actor, conversationId, { ...checked, data: input.data, source: "upload", forNextReply: true });
    return { file, draftId: null };
  });
}

/**
 * "aus Vorlage wählen" in the answer box: a workspace document (e.g. the return form).
 * With an open draft it goes onto the draft; otherwise a copy waits with the case for the
 * next reply, like an uploaded file.
 */
export async function attachTemplate(ctx: AppContext, actor: Actor, conversationId: string, documentId: string): Promise<{ file: CaseFileInfo | null; draftId: string | null }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  if (!UUID.test(documentId)) throw new ServiceError(404, "NOT_FOUND", "Vorlage nicht gefunden.");
  return withTx(ctx.db, async (tx) => {
    const kind = await lockCaseForFiles(tx, actor, conversationId);
    const template = await one<{ id: string; name: string; content_type: string; size: number; data: Buffer }>(
      tx,
      "SELECT id, name, content_type, size, data FROM documents WHERE workspace_id = $1 AND id = $2 AND conversation_id IS NULL AND deleted_at IS NULL",
      [actor.workspaceId, documentId],
    );
    if (!template) throw new ServiceError(404, "NOT_FOUND", "Vorlage nicht gefunden.");
    if (!REPLY_FILES[kind].supported) throw new ServiceError(409, "NOT_SUPPORTED", REPLY_FILES[kind].note);
    const open = await openDraftOf(tx, actor, conversationId);
    if (open) {
      const draft = await lockDraft(tx, actor, open.id, open.version);
      if (draft.document_ids.includes(template.id)) return { file: null, draftId: open.id };
      await applyDraftDocuments(tx, actor, open.id, [...draft.document_ids, template.id], open.version, draft);
      return { file: null, draftId: open.id };
    }
    await checkWaitingRoom(tx, actor, conversationId, template.size);
    const file = await storeCaseFile(tx, actor, conversationId, { name: template.name, contentType: template.content_type, data: template.data, source: "upload", forNextReply: true });
    return { file, draftId: null };
  });
}

export async function lockCaseForFiles(tx: Tx, actor: Actor, conversationId: string): Promise<ChannelKind> {
  const conv = await one<{ kind: ChannelKind }>(
    tx,
    `SELECT cc.kind FROM conversations c JOIN channel_connections cc ON cc.workspace_id = c.workspace_id AND cc.id = c.connection_id
      WHERE c.workspace_id = $1 AND c.id = $2 FOR UPDATE OF c`,
    [actor.workspaceId, conversationId],
  );
  if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  return conv.kind;
}

export const openDraftOf = (tx: Tx, actor: Actor, conversationId: string) =>
  one<{ id: string; version: number }>(tx, "SELECT id, version FROM drafts WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited') ORDER BY created_at DESC LIMIT 1", [actor.workspaceId, conversationId]);

export async function checkWaitingRoom(tx: Tx, actor: Actor, conversationId: string, addBytes: number, addCount = 1): Promise<void> {
  const waiting = await many<{ size: number }>(tx, "SELECT size FROM documents WHERE workspace_id = $1 AND conversation_id = $2 AND for_next_reply AND deleted_at IS NULL", [actor.workspaceId, conversationId]);
  if (waiting.length + addCount > MAX_REPLY_DOCUMENTS) throw new ServiceError(400, "TOO_MANY", `Höchstens ${MAX_REPLY_DOCUMENTS} Anhänge je Antwort.`);
  if (waiting.reduce((sum, d) => sum + d.size, 0) + addBytes > MAX_DOCUMENT_BYTES) throw new ServiceError(413, "TOO_LARGE", "Zusammen sind die Anhänge zu groß (höchstens 3 MB je Antwort). Bitte weniger anhängen.");
}

/** Take back a file that waits for the next reply (it was uploaded only for that). */
export async function removeWaitingFile(ctx: AppContext, actor: Actor, conversationId: string, fileId: string): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(conversationId) || !UUID.test(fileId)) throw new ServiceError(404, "NOT_FOUND", "Datei nicht gefunden.");
  const row = await one(ctx.db, "UPDATE documents SET deleted_at = now(), for_next_reply = false WHERE workspace_id = $1 AND conversation_id = $2 AND id = $3 AND for_next_reply AND deleted_at IS NULL RETURNING id", [actor.workspaceId, conversationId, fileId]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Datei nicht gefunden.");
  await audit(ctx.db, actor, "case_file.removed", "conversation", conversationId, { fileId });
}

/**
 * Supersede the open draft of a case and return its files, so a new decision does not
 * silently drop what a person attached.
 */
export async function supersedeOpenDrafts(tx: Tx, workspaceId: string, conversationId: string): Promise<string[]> {
  const rows = await many<{ document_ids: string[] | null }>(tx, "UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited') RETURNING document_ids", [workspaceId, conversationId]);
  return rows.flatMap((r) => r.document_ids ?? []);
}

/**
 * Files for a freshly written draft: first the given ones (e.g. the invoice), then the
 * files waiting for the next reply, then those of the draft it replaces. Kept within the
 * per-reply limits; whatever does not fit stays with the case to pick again.
 */
export async function attachToNewDraft(tx: Tx, workspaceId: string, conversationId: string, draftId: string, input: { first?: string[]; previous?: string[] } = {}): Promise<string[]> {
  const conv = await one<{ kind: ChannelKind }>(
    tx,
    "SELECT cc.kind FROM conversations c JOIN channel_connections cc ON cc.workspace_id = c.workspace_id AND cc.id = c.connection_id WHERE c.workspace_id = $1 AND c.id = $2",
    [workspaceId, conversationId],
  );
  if (!conv || !REPLY_FILES[conv.kind].supported) return [];
  const waiting = await many<{ id: string }>(tx, "SELECT id FROM documents WHERE workspace_id = $1 AND conversation_id = $2 AND for_next_reply AND deleted_at IS NULL ORDER BY created_at", [workspaceId, conversationId]);
  const wanted = [...new Set([...(input.first ?? []), ...waiting.map((w) => w.id), ...(input.previous ?? [])])];
  if (wanted.length === 0) return [];
  const rows = await many<{ id: string; size: number }>(
    tx,
    "SELECT id, size FROM documents WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL AND (conversation_id IS NULL OR conversation_id = $3)",
    [workspaceId, wanted, conversationId],
  );
  const chosen: string[] = [];
  let bytes = 0;
  for (const id of wanted) {
    const row = rows.find((r) => r.id === id);
    if (!row || chosen.length >= MAX_REPLY_DOCUMENTS || bytes + row.size > MAX_DOCUMENT_BYTES) continue;
    chosen.push(id);
    bytes += row.size;
  }
  await tx.query("UPDATE drafts SET document_ids = $3::uuid[] WHERE workspace_id = $1 AND id = $2", [workspaceId, draftId, chosen]);
  if (waiting.length) await tx.query("UPDATE documents SET for_next_reply = false WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, waiting.map((w) => w.id)]);
  return chosen;
}

export async function listCaseFiles(ctx: AppContext, actor: Actor, conversationId: string): Promise<CaseFileInfo[]> {
  if (!UUID.test(conversationId)) return [];
  return many<CaseFileInfo>(
    ctx.db,
    "SELECT id, name, size, content_type, source, for_next_reply, created_at FROM documents WHERE workspace_id = $1 AND conversation_id = $2 AND deleted_at IS NULL ORDER BY created_at",
    [actor.workspaceId, conversationId],
  );
}

/** Files for a queued reply, exactly as approved (also when removed from the list since). */
export async function outboxAttachments(ctx: AppContext, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await many<{ id: string; name: string; content_type: string; data: Buffer }>(ctx.db, "SELECT id, name, content_type, data FROM documents WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, ids]);
  if (rows.length !== ids.length) throw new Error("Ein freigegebenes Dokument fehlt.");
  return ids.map((id) => rows.find((r) => r.id === id)!).map((r) => ({ name: r.name, contentType: r.content_type, data: r.data }));
}
