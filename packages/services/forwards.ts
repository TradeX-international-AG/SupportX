import type { AttachmentInfo, ReplyAttachment, ReplyOutcome } from "../core/contracts.ts";
import type { OrderRecord } from "../core/contracts.ts";
import { caseForwardSubject, caseForwardText, forwardMode, forwardSubject, forwardText, MAX_FORWARD_COMMENT, MAX_FORWARD_RECIPIENTS, parseRecipients, type CaseForwardEntry, type ForwardMode } from "../core/forward.ts";
import { buildTimeline } from "../core/timeline.ts";
import { many, one, withTx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { channelFor, loadChannelConnection } from "./connections.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/**
 * Forward one mail of a case to other addresses (supplier, colleague, accounting).
 * A person types the recipients and confirms; nothing here is triggered by the AI
 * or the worker. The send goes through the connected mailbox once, recorded in
 * message_forwards (its id is the marker header of the sent copy). A timeout
 * leaves the forward "uncertain": never resent automatically, only after a person
 * checked Sent Items.
 */

const UUID = /^[0-9a-f-]{36}$/i;
/** Graph accepts about 3 MB of inline attachments per request (see graph-mail.ts). */
const MAX_TEXT_ATTACHMENT_BYTES = 3 * 1024 * 1024;

interface ForwardSource {
  id: string;
  conversation_id: string;
  connection_id: string;
  connection_kind: string;
  external_message_id: string;
  external_thread_key: string;
  direction: "inbound" | "outbound";
  subject: string;
  body_text: string;
  from_address: string;
  reply_to: Array<{ address: string }>;
  to_addresses: Array<{ address: string }>;
  has_attachments: boolean;
  received_at: Date;
  source_platform: string;
}

async function loadSource(ctx: AppContext, workspaceId: string, messageId: string): Promise<ForwardSource> {
  if (!UUID.test(messageId)) throw new ServiceError(404, "NOT_FOUND", "Nachricht nicht gefunden.");
  const row = await one<ForwardSource>(
    ctx.db,
    `SELECT m.id, m.conversation_id, m.connection_id, cc.kind AS connection_kind, m.external_message_id, c.external_thread_key, m.direction, m.subject, m.body_text,
            m.from_address, m.reply_to, m.to_addresses, m.has_attachments, m.received_at, c.source_platform
       FROM messages m
       JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
       JOIN channel_connections cc ON cc.workspace_id = m.workspace_id AND cc.id = m.connection_id
      WHERE m.workspace_id = $1 AND m.id = $2`,
    [workspaceId, messageId],
  );
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Nachricht nicht gefunden.");
  if (row.connection_kind !== "microsoft_graph") throw new ServiceError(409, "NOT_SUPPORTED", "Weiterleiten geht nur bei E-Mails aus dem angebundenen Postfach. Marktplatz-Nachrichten bitte im Marktplatz weitergeben.");
  return row;
}

function modeOf(src: ForwardSource): ForwardMode {
  return forwardMode(src.source_platform, [src.from_address, ...src.reply_to.map((r) => r.address), ...src.to_addresses.map((t) => t.address)]);
}

export interface ForwardInfo {
  mode: ForwardMode;
  subject: string;
  /** What the confirmation dialog must say before sending. */
  notice: string;
  /** Addresses used in earlier forwards of this workspace, most recent first. */
  suggestions: string[];
  /** Blockers that prevent sending right now (send mode, paused connection). */
  blockers: string[];
}

async function blockersFor(ctx: AppContext, workspaceId: string, connectionId: string): Promise<string[]> {
  const connection = await loadChannelConnection(ctx.db, workspaceId, connectionId);
  const blockers: string[] = [];
  if (ctx.config.SEND_MODE !== "enabled") blockers.push("Versand ist für diese Installation deaktiviert (SEND_MODE=drafts_only).");
  if (!connection.send_enabled) blockers.push(`Versand ist für die Verbindung „${connection.display_name}“ nicht aktiviert.`);
  if (connection.paused) blockers.push("Die Verbindung ist pausiert.");
  return blockers;
}

export async function getForwardInfo(ctx: AppContext, actor: Actor, messageId: string): Promise<ForwardInfo> {
  requireRole(actor, ["owner", "agent"]);
  const src = await loadSource(ctx, actor.workspaceId, messageId);
  const mode = modeOf(src);
  const rows = await many<{ address: string }>(
    ctx.db,
    `SELECT address FROM (SELECT unnest(recipients) AS address, created_at FROM message_forwards WHERE workspace_id = $1 AND state <> 'failed' ORDER BY created_at DESC LIMIT 200) r
      GROUP BY address ORDER BY max(created_at) DESC LIMIT 20`,
    [actor.workspaceId],
  );
  const notice = mode === "original"
    ? "Die Original-Mail geht mit Absender, Text und Anhängen unverändert an die Empfänger, also auch die Adresse und Daten des Kunden. Nur an Stellen weiterleiten, die sie für diesen Fall brauchen."
    : "Marktplatz-Mail: Es wird nur der Text weitergeleitet, alle E-Mail-Adressen (auch die Kunden-Relay-Adresse) werden entfernt. Anhänge bis 3 MB gehen mit. Der Empfänger kann dem Kunden so nicht direkt schreiben.";
  return { mode, subject: forwardSubject(src.subject), notice, suggestions: rows.map((r) => r.address), blockers: await blockersFor(ctx, actor.workspaceId, src.connection_id) };
}

export interface ForwardInput {
  /** Generated by the dialog when it opens: a double click sends once. */
  forwardId: string;
  to: string | string[];
  comment?: string;
}

export interface ForwardResult {
  id: string;
  state: string;
  error?: string;
}

/** Send one forward, after the person confirmed recipients and text. */
export async function forwardMessage(ctx: AppContext, actor: Actor, messageId: string, input: ForwardInput): Promise<ForwardResult> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(input.forwardId)) throw new ServiceError(400, "INVALID", "Ungültige Anfrage.");
  const src = await loadSource(ctx, actor.workspaceId, messageId);
  const { valid, invalid } = parseRecipients(input.to);
  if (invalid.length) throw new ServiceError(400, "INVALID_RECIPIENT", `Keine gültige E-Mail-Adresse: ${invalid.join(", ")}`);
  if (valid.length === 0) throw new ServiceError(400, "NO_RECIPIENT", "Bitte mindestens eine Empfängeradresse eingeben.");
  if (valid.length > MAX_FORWARD_RECIPIENTS) throw new ServiceError(400, "TOO_MANY", `Höchstens ${MAX_FORWARD_RECIPIENTS} Empfänger.`);
  const comment = (input.comment ?? "").trim();
  if (comment.length > MAX_FORWARD_COMMENT) throw new ServiceError(400, "TOO_LONG", "Der Begleittext ist zu lang.");
  const mode = modeOf(src);

  // Reserve once: the same dialog id never sends twice; an unclear send blocks a repeat.
  const reserved = await withTx(ctx.db, async (tx) => {
    const existing = await one<{ id: string; state: string; message_id: string; last_error: string | null }>(tx, "SELECT id, state, message_id, last_error FROM message_forwards WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, input.forwardId]);
    if (existing) {
      if (existing.message_id !== src.id) throw new ServiceError(409, "CONFLICT", "Diese Weiterleitung gehört zu einer anderen Nachricht.");
      return { already: { id: existing.id, state: existing.state, ...(existing.last_error ? { error: existing.last_error } : {}) } };
    }
    const blockers = await blockersFor(ctx, actor.workspaceId, src.connection_id);
    if (blockers.length) throw new ServiceError(409, "SEND_BLOCKED", blockers.join(" "));
    const open = await one(tx, "SELECT 1 FROM message_forwards WHERE workspace_id = $1 AND message_id = $2 AND state IN ('sending','uncertain') AND recipients && $3::text[]", [actor.workspaceId, src.id, valid]);
    if (open) throw new ServiceError(409, "FORWARD_UNCLEAR", "Eine Weiterleitung dieser Mail an diese Adresse ist noch ungeklärt. Bitte erst in „Gesendete Elemente“ prüfen und im Verlauf klären.");
    await tx.query(
      `INSERT INTO message_forwards (id, workspace_id, conversation_id, message_id, connection_id, recipients, comment, mode, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [input.forwardId, actor.workspaceId, src.conversation_id, src.id, src.connection_id, valid, comment, mode, actorId(actor)],
    );
    return { already: null };
  });
  if (reserved.already) return reserved.already;

  let outcome: ReplyOutcome;
  let included: number | null = 0;
  const leftOut: string[] = [];
  try {
    const channel = await channelFor(ctx, ctx.db, await loadChannelConnection(ctx.db, actor.workspaceId, src.connection_id));
    if (!channel.forwardMessage) throw new ServiceError(409, "NOT_SUPPORTED", "Diese Verbindung kann nicht weiterleiten.");
    if (mode === "original") {
      outcome = await channel.forwardMessage({ mode, externalMessageId: src.external_message_id, to: valid, comment, marker: input.forwardId });
      included = null; // the mailbox forwards the files with the original
    } else {
      const attachments: ReplyAttachment[] = [];
      if (src.has_attachments && channel.listAttachments && channel.getAttachment) {
        let budget = MAX_TEXT_ATTACHMENT_BYTES;
        const listed: AttachmentInfo[] = await channel.listAttachments(src.external_message_id, src.external_thread_key);
        for (const a of listed) {
          if (a.size > budget) {
            leftOut.push(a.name);
            continue;
          }
          const file = await channel.getAttachment(src.external_message_id, src.external_thread_key, a.id);
          if (file.data.length > budget) {
            leftOut.push(a.name);
            continue;
          }
          budget -= file.data.length;
          attachments.push({ name: file.name, contentType: file.contentType, data: file.data });
        }
      }
      included = attachments.length;
      const bodyText = forwardText({ comment, platform: src.source_platform, receivedAt: src.received_at, subject: src.subject, direction: src.direction, body: src.body_text, leftOut });
      outcome = await channel.forwardMessage({ mode, to: valid, subject: forwardSubject(src.subject), bodyText, marker: input.forwardId, attachments });
    }
  } catch (error) {
    // Failed before anything left our side (setup, reading the attachments): nothing was sent.
    outcome = { state: "rejected", error: (error as Error).message, retryable: false };
  }

  const state = outcome.state === "provider_accepted" ? "sent" : outcome.state === "uncertain" ? "uncertain" : "failed";
  const error = outcome.state === "provider_accepted" ? null : outcome.error;
  await withTx(ctx.db, async (tx) => {
    await tx.query(
      "UPDATE message_forwards SET state = $3, last_error = $4, attachments_included = $5, attachments_left_out = $6, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND state = 'sending'",
      [actor.workspaceId, input.forwardId, state, error, included, leftOut],
    );
    // Recipients go into the audit; the comment does not (it may carry customer details).
    await audit(tx, actor, `message.forward_${state}`, "conversation", src.conversation_id, { forwardId: input.forwardId, messageId: src.id, recipients: valid, mode, ...(error ? { error } : {}) });
  });
  return { id: input.forwardId, state, ...(error ? { error } : {}) };
}

/**
 * Clear an unclear forward: look in Sent Items for the marker ("check"), or a
 * person states what they found there.
 */
export async function resolveForward(ctx: AppContext, actor: Actor, forwardId: string, action: "check" | "was_sent" | "was_not_sent"): Promise<{ state: string }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(forwardId)) throw new ServiceError(404, "NOT_FOUND", "Weiterleitung nicht gefunden.");
  const row = await one<{ id: string; state: string; connection_id: string; conversation_id: string; created_at: Date }>(ctx.db, "SELECT id, state, connection_id, conversation_id, created_at FROM message_forwards WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, forwardId]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Weiterleitung nicht gefunden.");
  if (!["uncertain", "sending", "sent"].includes(row.state)) return { state: row.state };
  let next: string | null = null;
  if (action === "check") {
    const channel = await channelFor(ctx, ctx.db, await loadChannelConnection(ctx.db, actor.workspaceId, row.connection_id));
    const found = await channel.reconcileReply(forwardId, row.created_at, "", "");
    if (found.state === "found") next = "confirmed";
    else if (found.state === "unknown") throw new ServiceError(502, "PROVIDER_ERROR", `Abgleich nicht möglich: ${found.error}`);
    else return { state: row.state };
  } else {
    if (row.state === "sent") return { state: row.state };
    next = action === "was_sent" ? "confirmed" : "failed";
  }
  await withTx(ctx.db, async (tx) => {
    await tx.query("UPDATE message_forwards SET state = $3, last_error = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, forwardId, next, action === "was_not_sent" ? "Manuell als nicht gesendet geklärt" : null]);
    await audit(tx, actor, "message.forward_resolved", "conversation", row.conversation_id, { forwardId, action, state: next });
  });
  return { state: next! };
}

/** Forwards of a case for the history, oldest first. */
export async function caseForwards(ctx: AppContext, workspaceId: string, conversationId: string) {
  return many(
    ctx.db,
    `SELECT f.id, f.message_id, f.recipients, f.comment, f.mode, f.state, f.attachments_included, f.attachments_left_out, f.last_error, f.created_at, u.display_name AS created_by_name
       FROM message_forwards f LEFT JOIN users u ON u.id = f.created_by
      WHERE f.workspace_id = $1 AND f.conversation_id = $2 ORDER BY f.created_at`,
    [workspaceId, conversationId],
  );
}

// ---------------------------------------------------------------------------
// The whole case in one mail: customer messages, our replies, the order from the
// ERP and the files, for a colleague, supplier or accounting. Always a new mail
// (sendMail) through a connected mailbox; in marketplace relay cases every mail
// address is removed, as with a single relay forward.

/** Files of all messages plus the case files, together at most this much (Graph inline limit). */
const MAX_CASE_FORWARD_FILES = 20;

interface CaseSource {
  id: string;
  subject: string;
  status: string;
  source_platform: string;
  connection_id: string;
  connection_kind: string;
  customer_address: string | null;
  customer_name: string | null;
  assignee_name: string | null;
  order_match_status: string | null;
}

interface CaseMessage {
  id: string;
  connection_id: string;
  external_message_id: string;
  external_thread_key: string;
  direction: "inbound" | "outbound";
  kind: string;
  from_address: string;
  from_name: string | null;
  to_addresses: Array<{ address: string }>;
  reply_to: Array<{ address: string }>;
  subject: string;
  body_text: string;
  has_attachments: boolean;
  received_at: string;
  outbox_id: string | null;
}

interface CaseReply {
  id: string;
  state: string;
  body: string | null;
  expected_recipient: string | null;
  attempts: number;
  last_error: string | null;
  dispatched_at: string | null;
  created_at: string;
  updated_at: string;
}

async function loadCase(ctx: AppContext, workspaceId: string, conversationId: string): Promise<CaseSource> {
  if (!UUID.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const row = await one<CaseSource>(
    ctx.db,
    `SELECT c.id, c.subject, c.status, c.source_platform, c.connection_id, cc.kind AS connection_kind, c.customer_address, c.customer_name, u.display_name AS assignee_name, c.order_match_status
       FROM conversations c JOIN channel_connections cc ON cc.workspace_id = c.workspace_id AND cc.id = c.connection_id
       LEFT JOIN users u ON u.id = c.assignee_user_id
      WHERE c.workspace_id = $1 AND c.id = $2`,
    [workspaceId, conversationId],
  );
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  return row;
}

/** The mailbox that sends: the case's own one, else a connected mailbox of the workspace (preferably one allowed to send). */
async function sendingMailbox(ctx: AppContext, workspaceId: string, c: CaseSource): Promise<string | null> {
  if (c.connection_kind === "microsoft_graph") return c.connection_id;
  const row = await one<{ id: string }>(
    ctx.db,
    "SELECT id FROM channel_connections WHERE workspace_id = $1 AND kind = 'microsoft_graph' ORDER BY send_enabled DESC, paused ASC, created_at LIMIT 1",
    [workspaceId],
  );
  return row?.id ?? null;
}

async function caseParts(ctx: AppContext, workspaceId: string, conversationId: string) {
  const [messages, outbox, link, notes, files] = await Promise.all([
    many<CaseMessage>(ctx.db, "SELECT m.id, m.connection_id, m.external_message_id, c.external_thread_key, m.direction, m.kind, m.from_address, m.from_name, m.to_addresses, m.reply_to, m.subject, m.body_text, m.has_attachments, m.received_at, m.outbox_id FROM messages m JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id WHERE m.workspace_id = $1 AND m.conversation_id = $2 ORDER BY m.received_at", [workspaceId, conversationId]),
    many<CaseReply>(ctx.db, "SELECT id, state, body, expected_recipient, attempts, last_error, dispatched_at, created_at, updated_at FROM outbox WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at", [workspaceId, conversationId]),
    one<{ status: string; snapshot: OrderRecord | null }>(ctx.db, "SELECT status, snapshot FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [workspaceId, conversationId]),
    many<{ body: string; created_at: string; author: string | null }>(ctx.db, "SELECT n.body, n.created_at, u.display_name AS author FROM internal_notes n LEFT JOIN users u ON u.id = n.author_user_id WHERE n.workspace_id = $1 AND n.conversation_id = $2 ORDER BY n.created_at", [workspaceId, conversationId]),
    many<{ id: string; name: string; size: number }>(ctx.db, "SELECT id, name, size FROM documents WHERE workspace_id = $1 AND conversation_id = $2 AND deleted_at IS NULL ORDER BY created_at", [workspaceId, conversationId]),
  ]);
  // Platform notices (Amazon's "Bestellung versendet" etc.) are no part of the dialogue.
  const shown = messages.filter((m) => m.kind !== "platform_notice");
  return { messages: shown, outbox, link, notes, files };
}

function caseMasked(c: CaseSource, messages: CaseMessage[]): boolean {
  return forwardMode(c.source_platform, messages.flatMap((m) => [m.from_address, ...m.reply_to.map((r) => r.address), ...m.to_addresses.map((t) => t.address)])) === "text";
}

export interface CaseForwardInfo {
  subject: string;
  notice: string;
  suggestions: string[];
  blockers: string[];
  /** What goes into the mail, for the dialog. */
  contents: { messages: number; replies: number; order: string | null; files: number; notes: number; masked: boolean };
}

export async function getCaseForwardInfo(ctx: AppContext, actor: Actor, conversationId: string): Promise<CaseForwardInfo> {
  requireRole(actor, ["owner", "agent"]);
  const c = await loadCase(ctx, actor.workspaceId, conversationId);
  const parts = await caseParts(ctx, actor.workspaceId, conversationId);
  const masked = caseMasked(c, parts.messages);
  const timeline = buildTimeline(parts.messages, parts.outbox);
  const mailbox = await sendingMailbox(ctx, actor.workspaceId, c);
  const blockers = mailbox ? await blockersFor(ctx, actor.workspaceId, mailbox) : ["Es ist kein E-Mail-Postfach angebunden, über das weitergeleitet werden kann."];
  const rows = await many<{ address: string }>(
    ctx.db,
    `SELECT address FROM (SELECT unnest(recipients) AS address, created_at FROM message_forwards WHERE workspace_id = $1 AND state <> 'failed' ORDER BY created_at DESC LIMIT 200) r
      GROUP BY address ORDER BY max(created_at) DESC LIMIT 20`,
    [actor.workspaceId],
  );
  const order = parts.link?.status === "unique" && parts.link.snapshot ? parts.link.snapshot.orderNumber ?? parts.link.snapshot.id : null;
  const fileCount = parts.messages.filter((m) => m.has_attachments).length + parts.files.length;
  const notice = masked
    ? "Marktplatz-Fall: Alle E-Mail-Adressen (auch die Kunden-Relay-Adresse) werden entfernt. Der Empfänger kann dem Kunden so nicht direkt schreiben. Anhänge gehen bis zusammen 3 MB mit."
    : "Der ganze Fall geht als eine neue Mail: Kundennachrichten mit Absender, unsere Antworten, die Bestellung mit Positionen, Versand, Rechnungen und Retouren, dazu die Anhänge bis zusammen 3 MB. Das sind Kundendaten: nur an Stellen weiterleiten, die sie für diesen Fall brauchen.";
  return {
    subject: caseForwardSubject(c.subject),
    notice,
    suggestions: rows.map((r) => r.address),
    blockers,
    contents: {
      messages: timeline.filter((e) => e.type === "message" && e.message.direction === "inbound").length,
      replies: timeline.filter((e) => e.type === "reply" || e.message.direction === "outbound").length,
      order,
      files: fileCount,
      notes: parts.notes.length,
      masked,
    },
  };
}

export interface CaseForwardInput extends ForwardInput {
  /** Internal notes are only sent when the person ticks it. */
  includeNotes?: boolean;
}

const REPLY_STATE_NOTE: Record<string, string> = {
  planned: "eingeplant, noch nicht gesendet",
  dispatching: "wird gerade gesendet",
  delivery_uncertain: "Versand ungeklärt",
  failed: "nicht gesendet",
};

export async function forwardCase(ctx: AppContext, actor: Actor, conversationId: string, input: CaseForwardInput): Promise<ForwardResult> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(input.forwardId)) throw new ServiceError(400, "INVALID", "Ungültige Anfrage.");
  const c = await loadCase(ctx, actor.workspaceId, conversationId);
  const { valid, invalid } = parseRecipients(input.to);
  if (invalid.length) throw new ServiceError(400, "INVALID_RECIPIENT", `Keine gültige E-Mail-Adresse: ${invalid.join(", ")}`);
  if (valid.length === 0) throw new ServiceError(400, "NO_RECIPIENT", "Bitte mindestens eine Empfängeradresse eingeben.");
  if (valid.length > MAX_FORWARD_RECIPIENTS) throw new ServiceError(400, "TOO_MANY", `Höchstens ${MAX_FORWARD_RECIPIENTS} Empfänger.`);
  const comment = (input.comment ?? "").trim();
  if (comment.length > MAX_FORWARD_COMMENT) throw new ServiceError(400, "TOO_LONG", "Der Begleittext ist zu lang.");
  const mailbox = await sendingMailbox(ctx, actor.workspaceId, c);
  if (!mailbox) throw new ServiceError(409, "SEND_BLOCKED", "Es ist kein E-Mail-Postfach angebunden, über das weitergeleitet werden kann.");

  const reserved = await withTx(ctx.db, async (tx) => {
    const existing = await one<{ id: string; state: string; conversation_id: string; message_id: string | null; last_error: string | null }>(tx, "SELECT id, state, conversation_id, message_id, last_error FROM message_forwards WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, input.forwardId]);
    if (existing) {
      if (existing.conversation_id !== c.id || existing.message_id !== null) throw new ServiceError(409, "CONFLICT", "Diese Weiterleitung gehört zu einer anderen Nachricht.");
      return { already: { id: existing.id, state: existing.state, ...(existing.last_error ? { error: existing.last_error } : {}) } };
    }
    const blockers = await blockersFor(ctx, actor.workspaceId, mailbox);
    if (blockers.length) throw new ServiceError(409, "SEND_BLOCKED", blockers.join(" "));
    const open = await one(tx, "SELECT 1 FROM message_forwards WHERE workspace_id = $1 AND conversation_id = $2 AND mode = 'case' AND state IN ('sending','uncertain') AND recipients && $3::text[]", [actor.workspaceId, c.id, valid]);
    if (open) throw new ServiceError(409, "FORWARD_UNCLEAR", "Eine Weiterleitung dieses Falls an diese Adresse ist noch ungeklärt. Bitte erst in „Gesendete Elemente“ prüfen und im Verlauf klären.");
    await tx.query(
      `INSERT INTO message_forwards (id, workspace_id, conversation_id, message_id, connection_id, recipients, comment, mode, created_by)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, 'case', $7)`,
      [input.forwardId, actor.workspaceId, c.id, mailbox, valid, comment, actorId(actor)],
    );
    return { already: null };
  });
  if (reserved.already) return reserved.already;

  let outcome: ReplyOutcome;
  const attachments: ReplyAttachment[] = [];
  const leftOut: string[] = [];
  try {
    const parts = await caseParts(ctx, actor.workspaceId, c.id);
    const masked = caseMasked(c, parts.messages);
    let budget = MAX_TEXT_ATTACHMENT_BYTES;
    const take = (name: string, contentType: string, data: Buffer) => {
      if (data.length > budget || attachments.length >= MAX_CASE_FORWARD_FILES) {
        leftOut.push(name);
        return;
      }
      budget -= data.length;
      attachments.push({ name, contentType, data });
    };
    // Files of the messages, read from their own channel (the mailbox or a marketplace).
    const names = new Map<string, string[]>();
    const channels = new Map<string, Awaited<ReturnType<typeof channelFor>>>();
    for (const m of parts.messages.filter((x) => x.has_attachments)) {
      let channel = channels.get(m.connection_id);
      if (!channel) {
        channel = await channelFor(ctx, ctx.db, await loadChannelConnection(ctx.db, actor.workspaceId, m.connection_id));
        channels.set(m.connection_id, channel);
      }
      if (!channel.listAttachments || !channel.getAttachment) continue;
      const listed: AttachmentInfo[] = await channel.listAttachments(m.external_message_id, m.external_thread_key);
      names.set(m.id, listed.map((a) => a.name));
      for (const a of listed) {
        if (a.size > budget) {
          leftOut.push(a.name);
          continue;
        }
        const file = await channel.getAttachment(m.external_message_id, m.external_thread_key, a.id);
        take(file.name, file.contentType, file.data);
      }
    }
    // Files kept with the case (invoice PDFs fetched from the ERP, uploaded files).
    for (const f of parts.files) {
      if (f.size > budget) {
        leftOut.push(f.name);
        continue;
      }
      const doc = await one<{ name: string; content_type: string; data: Buffer }>(ctx.db, "SELECT name, content_type, data FROM documents WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, f.id]);
      if (doc) take(doc.name, doc.content_type, doc.data);
    }

    const entries: CaseForwardEntry[] = buildTimeline(parts.messages, parts.outbox).map((e) => e.type === "message"
      ? { at: e.message.received_at, direction: e.message.direction, fromAddress: e.message.from_address, fromName: e.message.from_name, subject: e.message.subject, body: e.message.body_text, attachmentNames: names.get(e.message.id) ?? [] }
      : { at: e.at, direction: "outbound", body: e.reply.body ?? "", ...(REPLY_STATE_NOTE[e.reply.state] ? { stateNote: REPLY_STATE_NOTE[e.reply.state] } : {}) });
    const snapshot = parts.link?.status === "unique" ? parts.link.snapshot : null;
    const bodyText = caseForwardText({
      comment,
      platform: c.source_platform,
      subject: c.subject,
      status: c.status,
      assignee: c.assignee_name,
      customer: { name: c.customer_name, address: c.customer_address },
      orderMatch: parts.link?.status ?? c.order_match_status,
      order: snapshot,
      entries,
      notes: input.includeNotes ? parts.notes.map((n) => ({ at: n.created_at, author: n.author, body: n.body })) : [],
      mask: masked,
      attached: attachments.map((a) => a.name),
      leftOut,
    });
    const channel = await channelFor(ctx, ctx.db, await loadChannelConnection(ctx.db, actor.workspaceId, mailbox));
    if (!channel.forwardMessage) throw new ServiceError(409, "NOT_SUPPORTED", "Dieses Postfach kann nicht weiterleiten.");
    outcome = await channel.forwardMessage({ mode: "text", to: valid, subject: caseForwardSubject(c.subject), bodyText, marker: input.forwardId, attachments });
  } catch (error) {
    // Failed before anything left our side (setup, reading the files): nothing was sent.
    outcome = { state: "rejected", error: (error as Error).message, retryable: false };
  }

  const state = outcome.state === "provider_accepted" ? "sent" : outcome.state === "uncertain" ? "uncertain" : "failed";
  const error = outcome.state === "provider_accepted" ? null : outcome.error;
  await withTx(ctx.db, async (tx) => {
    await tx.query(
      "UPDATE message_forwards SET state = $3, last_error = $4, attachments_included = $5, attachments_left_out = $6, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND state = 'sending'",
      [actor.workspaceId, input.forwardId, state, error, attachments.length, leftOut],
    );
    await audit(tx, actor, `case.forward_${state}`, "conversation", c.id, { forwardId: input.forwardId, recipients: valid, includeNotes: !!input.includeNotes, ...(error ? { error } : {}) });
  });
  return { id: input.forwardId, state, ...(error ? { error } : {}) };
}
