import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { carrierFacts, parcelTargets } from "../core/carrier-tracking.ts";
import type { CallerCheckData, OrderRecord } from "../core/contracts.ts";
import { buildOrderFacts } from "../core/facts.ts";
import {
  callCaseText, callerHint, callerMatches, isMarketplaceRelay, maskEmail, MAX_FAILED_CHECKS_PER_CALL, MAX_FAILED_CHECKS_PER_HOUR,
  normalizeOrderNumber, transcriptTurns, verifyElevenLabsSignature, type CallTurn, type TranscriptMode,
} from "../core/phone.ts";
import { many, one, withTx, type Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { loadErpConnection, orderProviderFor } from "./connections.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { trackParcels } from "./dhl-tracking.ts";
import { autoInvoice, draftInvoiceReply, sendableInvoices } from "./invoices.ts";
import { ALL_ORDERS, enrichConversation } from "./matching.ts";

/**
 * Phone hotline. A voice agent (ElevenLabs Agents, number over a SIP trunk such as
 * sipgate) calls these tools during a call and reports the call afterwards:
 *
 *  - order status: only after order number + postal code or last name match weclapp;
 *    answers are the same facts a written reply may cite (weclapp bookings, DHL scans).
 *  - invoice: goes only to the address weclapp keeps for the order, as a case in the
 *    inbox (fixed template, PDF from weclapp). It is sent automatically only when the
 *    workspace's invoice rule says "send" and every send check passes.
 *  - post-call webhook: the call becomes (or completes) a case; summary always,
 *    the spoken text only when the workspace chose it; audio is never stored.
 *
 * The caller's number proves nothing and is kept only as "…123" for the list.
 */

interface VoiceRow {
  id: string;
  workspace_id: string;
  token_hint: string;
  webhook_secret_id: string | null;
  transcript_mode: TranscriptMode;
  handover_number: string | null;
  last_call_at: Date | null;
}

interface CallRow {
  id: string;
  workspace_id: string;
  call_ref: string;
  caller_hint: string | null;
  failed_checks: number;
  verified_order_id: string | null;
  verified_order_number: string | null;
  invoice_requested_at: Date | null;
  invoice_email: string | null;
  conversation_id: string | null;
  summary: string | null;
  duration_sec: number | null;
  reported_at: Date | null;
}

const UUID = /^[0-9a-f-]{36}$/i;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function loadVoice(q: Queryable, workspaceId: string): Promise<VoiceRow | null> {
  return one<VoiceRow>(q, "SELECT * FROM voice_connections WHERE workspace_id = $1", [workspaceId]);
}

/** The mailbox phone cases live in (and answers are sent from): the workspace's first Microsoft connection. */
async function mailboxConnection(q: Queryable, workspaceId: string): Promise<{ id: string; display_name: string } | null> {
  return one(q, "SELECT id, display_name FROM channel_connections WHERE workspace_id = $1 AND kind = 'microsoft_graph' ORDER BY paused, created_at LIMIT 1", [workspaceId]);
}

// ---------------------------------------------------------------------------
// Settings (owner)

export async function getPhoneSettings(ctx: AppContext, actor: Actor) {
  requireRole(actor, ["owner"]);
  const row = await loadVoice(ctx.db, actor.workspaceId);
  const mailbox = await mailboxConnection(ctx.db, actor.workspaceId);
  const route = mailbox
    ? await one(ctx.db, "SELECT 1 FROM reply_route_verifications WHERE workspace_id = $1 AND connection_id = $2 AND source_platform = 'phone' AND revoked_at IS NULL", [actor.workspaceId, mailbox.id])
    : null;
  const base = ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const calls = row
    ? await many<{ id: string; caller_hint: string | null; verified_order_number: string | null; invoice_requested_at: Date | null; conversation_id: string | null; summary: string | null; created_at: Date }>(
      ctx.db,
      "SELECT id, caller_hint, verified_order_number, invoice_requested_at, conversation_id, summary, created_at FROM phone_calls WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 10",
      [actor.workspaceId],
    )
    : [];
  return {
    configured: !!row,
    tokenHint: row?.token_hint ?? null,
    webhookSecretSet: !!row?.webhook_secret_id,
    transcriptMode: row?.transcript_mode ?? "summary",
    handoverNumber: row?.handover_number ?? null,
    lastCallAt: row?.last_call_at ?? null,
    mailbox: mailbox?.display_name ?? null,
    mailboxConnectionId: mailbox?.id ?? null,
    routeVerified: !!route,
    urls: {
      orderStatus: `${base}/voice/tools/order-status`,
      invoice: `${base}/voice/tools/invoice`,
      webhook: row ? `${base}/webhooks/elevenlabs/${row.id}` : null,
    },
    calls: calls.map((c) => ({ id: c.id, callerHint: c.caller_hint, orderNumber: c.verified_order_number, invoiceRequested: !!c.invoice_requested_at, conversationId: c.conversation_id, summary: c.summary?.slice(0, 300) ?? null, at: c.created_at })),
  };
}

/** New tool token (also replaces an old one). Shown exactly once; only its hash is stored. */
export async function createPhoneToken(ctx: AppContext, actor: Actor): Promise<{ token: string }> {
  requireRole(actor, ["owner"]);
  const token = `sxv_${randomBytes(24).toString("base64url")}`;
  await withTx(ctx.db, async (tx) => {
    const existing = await loadVoice(tx, actor.workspaceId);
    await tx.query(
      `INSERT INTO voice_connections (workspace_id, token_sha256, token_hint) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET token_sha256 = EXCLUDED.token_sha256, token_hint = EXCLUDED.token_hint, updated_at = now()`,
      [actor.workspaceId, sha256(token), `••••${token.slice(-4)}`],
    );
    await audit(tx, actor, existing ? "phone.token_rotated" : "phone.connected", "workspace", actor.workspaceId);
  });
  return { token };
}

export async function savePhoneSettings(ctx: AppContext, actor: Actor, input: { webhookSecret?: string; transcriptMode?: TranscriptMode; handoverNumber?: string | null }): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    const row = await loadVoice(tx, actor.workspaceId);
    if (!row) throw new ServiceError(409, "NOT_CONNECTED", "Bitte zuerst den Schlüssel für die Telefon-Werkzeuge erzeugen.");
    if (input.webhookSecret !== undefined) {
      const secret = input.webhookSecret.trim();
      if (secret.length < 16 || secret.length > 300) throw new ServiceError(400, "INVALID", "Das Webhook-Geheimnis aus ElevenLabs ist zu kurz oder zu lang.");
      const id = await ctx.secrets.store(tx, actor.workspaceId, "phone_webhook", secret);
      await tx.query("UPDATE voice_connections SET webhook_secret_id = $2, updated_at = now() WHERE workspace_id = $1", [actor.workspaceId, id]);
      if (row.webhook_secret_id) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.webhook_secret_id]);
      await audit(tx, actor, "phone.webhook_secret", "workspace", actor.workspaceId);
    }
    if (input.transcriptMode !== undefined) {
      if (input.transcriptMode !== "summary" && input.transcriptMode !== "transcript") throw new ServiceError(400, "INVALID", "Unbekannte Einstellung.");
      await tx.query("UPDATE voice_connections SET transcript_mode = $2, updated_at = now() WHERE workspace_id = $1", [actor.workspaceId, input.transcriptMode]);
      await audit(tx, actor, "phone.transcript_mode", "workspace", actor.workspaceId, { mode: input.transcriptMode });
    }
    if (input.handoverNumber !== undefined) {
      const number = input.handoverNumber?.replace(/[^\d+]/g, "") || null;
      if (number && !/^\+?\d{6,16}$/.test(number)) throw new ServiceError(400, "INVALID", "Bitte die Weiterleitungsnummer im Format +49… eintragen.");
      await tx.query("UPDATE voice_connections SET handover_number = $2, updated_at = now() WHERE workspace_id = $1", [actor.workspaceId, number]);
    }
  });
}

export async function deletePhoneConnection(ctx: AppContext, actor: Actor): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    const row = await loadVoice(tx, actor.workspaceId);
    if (!row) throw new ServiceError(404, "NOT_FOUND", "Keine Telefon-Hotline eingerichtet.");
    await tx.query("DELETE FROM voice_connections WHERE workspace_id = $1", [actor.workspaceId]);
    if (row.webhook_secret_id) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.webhook_secret_id]);
    await audit(tx, actor, "phone.removed", "workspace", actor.workspaceId);
  });
}

// ---------------------------------------------------------------------------
// Tools (called by the voice agent with "Authorization: Bearer <token>")

/** The workspace of a tool token, or null. Constant-time on the hash. */
export async function workspaceForToolToken(ctx: AppContext, header: string | undefined): Promise<string | null> {
  const token = /^Bearer\s+(sxv_[A-Za-z0-9_-]{20,64})$/.exec(header?.trim() ?? "")?.[1];
  if (!token) return null;
  const hash = sha256(token);
  const row = await one<{ workspace_id: string; token_sha256: string }>(ctx.db, "SELECT workspace_id, token_sha256 FROM voice_connections WHERE token_sha256 = $1", [hash]);
  if (!row || !timingSafeEqual(Buffer.from(row.token_sha256), Buffer.from(hash))) return null;
  return row.workspace_id;
}

export interface ToolInput {
  /** The agent's conversation id (ElevenLabs system__conversation_id). */
  callId: string;
  /** system__caller_id; only its last digits are kept. */
  callerId?: string;
  orderNumber?: string;
  /** Postal code or last name, as the caller said it. */
  check?: string;
}

/** What the agent gets back: a sentence to say and, on success, the facts it may use. Nothing else. */
export interface ToolAnswer {
  ok: boolean;
  /** German text the agent may say (or paraphrase) to the caller. */
  say: string;
  /** True: stop trying, offer the human handover. */
  handover?: boolean;
  facts?: string[];
}

const NO_MATCH = "Ich kann die Bestellung mit diesen Angaben nicht finden. Bitte nennen Sie noch einmal die Bestellnummer und dazu die Postleitzahl oder den Nachnamen aus der Bestellung.";
const TOO_MANY = "Ich kann die Bestellung leider nicht bestätigen. Ich verbinde Sie gern mit einem Mitarbeiter, oder Sie schreiben uns eine E-Mail mit der Bestellnummer.";
const NO_ERP = "Die Bestelldaten sind gerade nicht erreichbar. Bitte versuchen Sie es später noch einmal oder schreiben Sie uns eine E-Mail.";

async function callRow(ctx: AppContext, ws: string, input: ToolInput): Promise<CallRow> {
  const ref = input.callId.trim();
  if (!/^[A-Za-z0-9_.:-]{6,120}$/.test(ref)) throw new ServiceError(400, "INVALID", "callId fehlt.");
  const row = await one<CallRow>(
    ctx.db,
    `INSERT INTO phone_calls (workspace_id, call_ref, caller_hint) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, call_ref) DO UPDATE SET caller_hint = coalesce(phone_calls.caller_hint, EXCLUDED.caller_hint)
     RETURNING *`,
    [ws, ref, callerHint(input.callerId)],
  );
  await ctx.db.query("UPDATE voice_connections SET last_call_at = now() WHERE workspace_id = $1", [ws]);
  return row!;
}

/** Spoken numbers lose their dashes: also try "AB-12345" and Amazon's 3-7-7 form. */
export function orderNumberVariants(spoken: string): string[] {
  const raw = spoken.trim().slice(0, 60);
  const plain = normalizeOrderNumber(raw);
  const out = [raw, plain];
  const prefixed = /^([A-Z]{1,6})(\d{3,})$/.exec(plain);
  if (prefixed) out.push(`${prefixed[1]}-${prefixed[2]}`);
  if (/^\d{17}$/.test(plain)) out.push(`${plain.slice(0, 3)}-${plain.slice(3, 10)}-${plain.slice(10)}`);
  return [...new Set(out.filter((v) => v.length >= 3))];
}

type Verified = { call: CallRow; order: OrderRecord; check: CallerCheckData } | { answer: ToolAnswer };

/**
 * The order of this call, checked. A call that already proved an order needs no second
 * check for the same number. Unknown order and wrong answer get the same reply, so the
 * hotline does not reveal which order numbers exist.
 */
async function verifiedOrder(ctx: AppContext, ws: string, input: ToolInput): Promise<Verified> {
  const call = await callRow(ctx, ws, input);
  const erp = await loadErpConnection(ctx.db, ws);
  if (!erp) return { answer: { ok: false, say: NO_ERP, handover: true } };
  const provider = await orderProviderFor(ctx, ctx.db, erp);
  if (!provider.callerCheck) return { answer: { ok: false, say: NO_ERP, handover: true } };

  const spoken = input.orderNumber?.trim() ?? "";
  if (call.verified_order_id && (!spoken || normalizeOrderNumber(spoken) === normalizeOrderNumber(call.verified_order_number ?? ""))) {
    const again = await provider.getOrder(call.verified_order_id, ALL_ORDERS);
    if (again.status !== "unique") return { answer: { ok: false, say: NO_ERP, handover: true } };
    return { call, order: again.order, check: await provider.callerCheck(call.verified_order_id) };
  }

  if (call.failed_checks >= MAX_FAILED_CHECKS_PER_CALL) return { answer: { ok: false, say: TOO_MANY, handover: true } };
  const hour = await one<{ n: string }>(ctx.db, "SELECT coalesce(sum(failed_checks), 0) AS n FROM phone_calls WHERE workspace_id = $1 AND last_check_at > now() - interval '1 hour'", [ws]);
  if (Number(hour?.n ?? 0) >= MAX_FAILED_CHECKS_PER_HOUR) return { answer: { ok: false, say: TOO_MANY, handover: true } };
  if (!spoken || !input.check?.trim()) {
    return { answer: { ok: false, say: "Bitte nennen Sie mir die Bestellnummer und dazu die Postleitzahl oder den Nachnamen aus der Bestellung." } };
  }

  const fail = async (): Promise<Verified> => {
    const updated = await one<{ failed_checks: number }>(ctx.db, "UPDATE phone_calls SET failed_checks = failed_checks + 1, last_check_at = now() WHERE id = $1 RETURNING failed_checks", [call.id]);
    await audit(ctx.db, { type: "worker", workspaceId: ws }, "phone.check_failed", "phone_call", call.id);
    return { answer: (updated?.failed_checks ?? 0) >= MAX_FAILED_CHECKS_PER_CALL ? { ok: false, say: TOO_MANY, handover: true } : { ok: false, say: NO_MATCH } };
  };

  let found: OrderRecord | null = null;
  for (const value of orderNumberVariants(spoken)) {
    const result = await provider.findOrders([{ value, kind: "order" }], ALL_ORDERS);
    if (result.status === "error") return { answer: { ok: false, say: NO_ERP, handover: true } };
    if (result.status === "ambiguous") return fail();
    if (result.status === "unique") {
      found = result.order;
      break;
    }
  }
  if (!found) return fail();
  let check: CallerCheckData;
  try {
    check = await provider.callerCheck(found.id);
  } catch {
    return { answer: { ok: false, say: NO_ERP, handover: true } };
  }
  if (!callerMatches(input.check, check)) return fail();

  const number = found.orderNumber ?? found.orderNumberAtCustomer ?? found.id;
  await ctx.db.query("UPDATE phone_calls SET verified_order_id = $2, verified_order_number = $3 WHERE id = $1", [call.id, found.id, number]);
  await audit(ctx.db, { type: "worker", workspaceId: ws }, "phone.verified", "phone_call", call.id, { order: number });
  return { call: { ...call, verified_order_id: found.id, verified_order_number: number }, order: found, check };
}

/**
 * "Wo bleibt meine Lieferung?": the facts a written reply could cite, plus DHL's own
 * status for the order's parcels (cached like in the case view).
 */
export async function phoneOrderStatus(ctx: AppContext, ws: string, input: ToolInput): Promise<ToolAnswer> {
  const verified = await verifiedOrder(ctx, ws, input);
  if ("answer" in verified) return verified.answer;
  const { order } = verified;
  const facts = buildOrderFacts(order).filter((f) => !f.id.startsWith("invoice."));
  const tracking = await trackParcels(ctx, ws, parcelTargets(order, [])).catch(() => null);
  const carrier = tracking ? carrierFacts(tracking.parcels.flatMap((p) => (p.result ? [{ target: p.target, result: p.result }] : []))) : [];
  return {
    ok: true,
    say: `Bestellung ${verified.call.verified_order_number} ist bestätigt. Nenne nur, was in den Fakten steht. Eine ERP-Buchung ist kein Paketscan; „zugestellt“ nur, wenn DHL das meldet. Keine Liefertermine versprechen.`,
    facts: [...facts.map((f) => f.text), ...carrier.map((f) => f.text)],
  };
}

/**
 * "Kann ich eine Rechnung haben?": the invoice of the verified order goes to the
 * address weclapp keeps for it. A case is created right away so the team sees it.
 */
export async function phoneInvoiceRequest(ctx: AppContext, ws: string, input: ToolInput): Promise<ToolAnswer> {
  const verified = await verifiedOrder(ctx, ws, input);
  if ("answer" in verified) return verified.answer;
  const { call, order, check } = verified;
  if (sendableInvoices(order).length === 0) {
    return { ok: false, say: "Zu dieser Bestellung gibt es noch keine Rechnung. Sie wird erstellt, sobald die Bestellung abgerechnet ist." };
  }
  const email = check.invoiceEmails[0];
  if (!email) {
    await ctx.db.query("UPDATE phone_calls SET invoice_requested_at = coalesce(invoice_requested_at, now()) WHERE id = $1", [call.id]);
    await ensureCallCase(ctx, ws, call.id);
    return { ok: false, say: "Für diese Bestellung ist keine E-Mail-Adresse hinterlegt. Ein Mitarbeiter meldet sich bei Ihnen." };
  }
  if (call.invoice_requested_at && call.invoice_email) {
    return { ok: true, say: `Die Rechnung ist bereits angefordert und geht an ${isMarketplaceRelay(email) ? "Ihr Nachrichtenpostfach beim Marktplatz" : maskEmail(email)}.` };
  }
  await ctx.db.query("UPDATE phone_calls SET invoice_requested_at = now(), invoice_email = $2 WHERE id = $1", [call.id, email]);
  const caseId = await ensureCallCase(ctx, ws, call.id);
  if (!caseId) return { ok: false, say: "Ich habe Ihre Anfrage notiert. Ein Mitarbeiter schickt Ihnen die Rechnung per E-Mail.", handover: false };

  const outcome = await autoInvoice(ctx, ws, caseId);
  let state: "sent" | "drafted" | "failed" = outcome === "sent" ? "sent" : outcome === "failed" ? "failed" : "drafted";
  if (outcome === "off" || outcome === "skipped") {
    try {
      await draftInvoiceReply(ctx, { type: "worker", workspaceId: ws }, caseId);
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      state = "failed";
      await ctx.db.query("UPDATE conversations SET last_error = $3 WHERE workspace_id = $1 AND id = $2", [ws, caseId, `Rechnung vom Telefon angefragt, nicht vorbereitet: ${error.message}`]);
    }
  }
  const where = isMarketplaceRelay(email) ? "an Ihr Nachrichtenpostfach beim Marktplatz" : `an ${maskEmail(email)}`;
  return {
    ok: true,
    say: state === "sent"
      ? `Die Rechnung ist ${where} unterwegs.`
      : `Die Rechnung geht ${where}, sobald ein Mitarbeiter sie geprüft hat, normalerweise am selben Werktag.`,
  };
}

// ---------------------------------------------------------------------------
// The call as a case

/** What the team must know about the call, derived from the call row (never from the caller's words). */
function callNotes(call: CallRow): string[] {
  return [
    call.verified_order_number
      ? `Bestellung ${call.verified_order_number} am Telefon bestätigt (Bestellnummer und Postleitzahl oder Name passten zu weclapp).`
      : "Keine Bestellung bestätigt.",
    ...(call.failed_checks ? [`${call.failed_checks} Fehlversuch(e) bei der Bestätigung.`] : []),
    ...(call.invoice_requested_at
      ? [call.invoice_email
        ? `Der Anrufer möchte die Rechnung per E-Mail erhalten; sie geht nur an die in weclapp hinterlegte Adresse (${maskEmail(call.invoice_email)}).`
        : "Der Anrufer möchte die Rechnung erhalten, aber in weclapp ist für diese Bestellung keine Mailadresse hinterlegt. Bitte selbst klären."]
      : []),
  ];
}

/**
 * The case of a call in the workspace's mailbox connection (answers go out as a new
 * mail from there). Created once; later calls of this function rewrite only its text.
 * Without a mailbox the call is kept in the list only.
 */
async function ensureCallCase(ctx: AppContext, ws: string, callId: string, turns: ReadonlyArray<CallTurn> = []): Promise<string | null> {
  const created = await withTx(ctx.db, async (tx) => {
    const call = (await one<CallRow>(tx, "SELECT * FROM phone_calls WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [ws, callId]))!;
    const voice = await loadVoice(tx, ws);
    const mode = voice?.transcript_mode ?? "summary";
    const text = callCaseText({ summary: call.summary ?? undefined, turns: mode === "transcript" ? turns : [], mode, durationSec: call.duration_sec ?? undefined, notes: callNotes(call) });
    if (call.conversation_id) {
      await tx.query("UPDATE messages SET body_text = $3 WHERE workspace_id = $1 AND conversation_id = $2 AND external_message_id = $4", [ws, call.conversation_id, text, `phone:${call.call_ref}`]);
      return { id: call.conversation_id, fresh: false };
    }
    const mailbox = await mailboxConnection(tx, ws);
    if (!mailbox) return null;
    const subject = `Anruf${call.caller_hint ? ` ${call.caller_hint}` : ""}${call.verified_order_number ? ` · Bestellung ${call.verified_order_number}` : ""}`;
    const now = ctx.now();
    const conv = (await one<{ id: string }>(
      tx,
      `INSERT INTO conversations (workspace_id, connection_id, external_thread_key, source_platform, subject, customer_address, last_message_at, order_references, category, category_source, category_reason)
       VALUES ($1, $2, $3, 'phone', $4, $5, $6, $7, 'support', 'rule', 'Anruf über die Telefon-Hotline') RETURNING id`,
      [ws, mailbox.id, `phone:${call.call_ref}`, subject, call.invoice_email, now, JSON.stringify(call.verified_order_number ? [{ kind: "labelled", value: call.verified_order_number, foundIn: "body" }] : [])],
    ))!;
    const msg = (await one<{ id: string }>(
      tx,
      `INSERT INTO messages (workspace_id, conversation_id, connection_id, external_message_id, direction, kind, from_address, from_name, subject, body_text, received_at)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', $5, $6, $7, $8, $9) RETURNING id`,
      [ws, conv.id, mailbox.id, `phone:${call.call_ref}`, call.invoice_email ?? "", call.caller_hint ? `Anrufer ${call.caller_hint}` : "Anrufer", subject, text, now],
    ))!;
    await tx.query("UPDATE conversations SET latest_inbound_message_id = $3 WHERE workspace_id = $1 AND id = $2", [ws, conv.id, msg.id]);
    await tx.query("UPDATE phone_calls SET conversation_id = $2 WHERE id = $1", [call.id, conv.id]);
    await audit(tx, { type: "worker", workspaceId: ws }, "phone.case_created", "conversation", conv.id);
    return { id: conv.id, fresh: true };
  });
  if (!created) return null;
  // The order link the case shows (same lookup as for mail cases).
  if (created.fresh) await enrichConversation(ctx, ws, created.id).catch(() => undefined);
  return created.id;
}

/**
 * ElevenLabs post-call webhook (type post_call_transcription). Audio events are
 * acknowledged and dropped. The call's summary (and, if chosen, its text) goes into
 * the case; a call without a case gets one when the workspace has a mailbox.
 */
export async function handlePhoneWebhook(ctx: AppContext, connectionId: string, rawBody: string, signature: string | undefined): Promise<{ status: number; reason?: string }> {
  if (!UUID.test(connectionId)) return { status: 404, reason: "unknown connection" };
  const voice = await one<VoiceRow>(ctx.db, "SELECT * FROM voice_connections WHERE id = $1", [connectionId]);
  if (!voice?.webhook_secret_id) return { status: 404, reason: "unknown connection" };
  const secret = await ctx.secrets.read(ctx.db, voice.workspace_id, voice.webhook_secret_id);
  const verified = verifyElevenLabsSignature(signature, rawBody, secret, ctx.now());
  if (!verified.ok) return { status: 401, reason: verified.reason };
  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, reason: "invalid json" };
  }
  if (event.type !== "post_call_transcription" || !event.data) return { status: 200, reason: "ignored" };
  const data = event.data;
  const ref = typeof data.conversation_id === "string" ? data.conversation_id : "";
  if (!/^[A-Za-z0-9_.:-]{6,120}$/.test(ref)) return { status: 400, reason: "no conversation id" };
  const ws = voice.workspace_id;
  const analysis = (data.analysis ?? {}) as { transcript_summary?: unknown; call_successful?: unknown };
  const metadata = (data.metadata ?? {}) as { call_duration_secs?: unknown };
  const vars = ((data.conversation_initiation_client_data as { dynamic_variables?: Record<string, unknown> } | undefined)?.dynamic_variables ?? {});
  const summary = typeof analysis.transcript_summary === "string" ? analysis.transcript_summary.slice(0, 3000) : null;
  const duration = typeof metadata.call_duration_secs === "number" ? Math.round(metadata.call_duration_secs) : null;
  const caller = typeof vars.system__caller_id === "string" ? vars.system__caller_id : undefined;

  const call = (await one<CallRow>(
    ctx.db,
    `INSERT INTO phone_calls (workspace_id, call_ref, caller_hint, summary, duration_sec, reported_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (workspace_id, call_ref) DO UPDATE SET summary = EXCLUDED.summary, duration_sec = EXCLUDED.duration_sec, reported_at = now(),
       caller_hint = coalesce(phone_calls.caller_hint, EXCLUDED.caller_hint)
     RETURNING *`,
    [ws, ref, callerHint(caller), summary, duration],
  ))!;
  await ctx.db.query("UPDATE voice_connections SET last_call_at = now() WHERE workspace_id = $1", [ws]);
  // The spoken text is used only when the workspace keeps transcripts; it is not stored elsewhere.
  const caseId = await ensureCallCase(ctx, ws, call.id, voice.transcript_mode === "transcript" ? transcriptTurns(data.transcript) : []);
  // A call the agent fully answered (no invoice, no open question) needs no person: it is filed as done.
  if (caseId && !call.invoice_requested_at && analysis.call_successful === "success" && call.verified_order_id) {
    await ctx.db.query("UPDATE conversations SET status = 'closed', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'open' AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.workspace_id = $1 AND d.conversation_id = $2)", [ws, caseId]);
  }
  await audit(ctx.db, { type: "worker", workspaceId: ws }, "phone.call_reported", "phone_call", call.id, { case: caseId });
  return { status: 200 };
}
