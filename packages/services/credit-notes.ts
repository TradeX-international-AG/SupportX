import { checkCreditNote, proposeCreditNote, type CreditProposal, type CreditSource } from "../core/credit-note.ts";
import type { CreditSourceInvoice, OrderProvider, OrderRecord } from "../core/contracts.ts";
import { formatAmount, parseAmountInput } from "../core/refund-list.ts";
import { HttpError } from "../connectors/http.ts";
import { many, one, withTx, type Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { loadErpConnection, orderProviderFor } from "./connections.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { sendableInvoices } from "./invoices.ts";
import { ALL_ORDERS } from "./matching.ts";

/**
 * Credit note draft in weclapp from a case ("Gutschrift vorbereiten"). Off until
 * the owner switches it on (the weclapp token then needs write rights for sales
 * invoices). Only a signed-in person, only after confirming the total; the ERP
 * creates a draft (status NEW), booking stays with the person in weclapp.
 * Amounts per line never above the invoice, the total never above what is left
 * after earlier SupportX credit notes for the same invoice.
 */

const PENDING_STALE_MS = 5 * 60_000;
const COUNTING = ["pending", "created", "needs_review", "uncertain"];

function humanOnly(actor: Actor): asserts actor is Extract<Actor, { type: "user" }> {
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Eine Gutschrift bereitet nur ein Mensch vor, nie eine Automatik.");
  requireRole(actor, ["owner", "agent"]);
}

async function assertCase(q: Queryable, ws: string, conversationId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  if (!(await one(q, "SELECT 1 FROM conversations WHERE workspace_id = $1 AND id = $2", [ws, conversationId]))) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
}

type Writer = Required<Pick<OrderProvider, "getInvoiceForCredit" | "createCreditNoteDraft">>;

async function provider(ctx: AppContext, ws: string): Promise<{ provider: OrderProvider & Writer; baseUrl: string }> {
  const erp = await loadErpConnection(ctx.db, ws);
  if (!erp) throw new ServiceError(409, "NO_ERP", "Keine weclapp-Verbindung eingerichtet.");
  if (!erp.credit_notes_enabled) throw new ServiceError(409, "CREDIT_NOTES_OFF", "Gutschriften aus dem Fall sind nicht freigeschaltet. Der Inhaber schaltet sie in den Einstellungen bei weclapp ein.");
  const p = await orderProviderFor(ctx, ctx.db, erp);
  if (!p.getInvoiceForCredit || !p.createCreditNoteDraft) throw new ServiceError(409, "NOT_SUPPORTED", "Diese Warenwirtschaft kann keine Gutschriften vorbereiten.");
  return { provider: p as OrderProvider & Writer, baseUrl: erp.base_url };
}

/** The invoices of the case's order, fresh from weclapp. */
async function caseInvoices(ctx: AppContext, ws: string, conversationId: string, p: OrderProvider): Promise<OrderRecord> {
  const link = await one<{ status: string; snapshot: OrderRecord | null }>(ctx.db, "SELECT status, snapshot FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [ws, conversationId]);
  if (!link || link.status !== "unique" || !link.snapshot) throw new ServiceError(409, "ORDER_NOT_UNIQUE", "Es ist keine Bestellung eindeutig zugeordnet. Bitte erst rechts unter „Bestellung in weclapp“ zuordnen.");
  const fresh = await p.getOrder(link.snapshot.id, ALL_ORDERS);
  if (fresh.status === "error") throw new ServiceError(502, "ERP_ERROR", `weclapp ist gerade nicht erreichbar: ${fresh.error}`);
  if (fresh.status !== "unique") throw new ServiceError(409, "ORDER_NOT_UNIQUE", "Die zugeordnete Bestellung ist in weclapp nicht mehr zu finden.");
  return fresh.order;
}

/** What was refunded for this case: marketplace refunds first, else the amount on the refund list. */
async function creditSource(q: Queryable, ws: string, conversationId: string): Promise<CreditSource> {
  const refunds = await many<{ lines: Array<{ sku?: string; title?: string; principalCents: number; shippingCents: number }>; total_cents: number; currency: string }>(
    q, "SELECT lines, total_cents, currency FROM marketplace_refunds WHERE workspace_id = $1 AND conversation_id = $2 AND state = 'accepted'", [ws, conversationId]);
  if (refunds.length) {
    const lines = refunds.flatMap((r) => r.lines);
    const total = refunds.reduce((s, r) => s + r.total_cents, 0);
    return { kind: "marketplace", label: `Bei Amazon erstattet ${formatAmount(total, refunds[0]!.currency)}`, lines: lines.map((l) => ({ sku: l.sku, title: l.title, principalCents: l.principalCents })), shippingCents: lines.reduce((s, l) => s + l.shippingCents, 0) };
  }
  const entry = await one<{ amount_cents: number | null; currency: string | null }>(q, "SELECT amount_cents, currency FROM refund_entries WHERE workspace_id = $1 AND conversation_id = $2", [ws, conversationId]);
  if (entry?.amount_cents) return { kind: "amount", label: `Betrag auf der Erstattungsliste ${formatAmount(entry.amount_cents, entry.currency ?? "EUR")}`, cents: entry.amount_cents };
  return null;
}

async function earlierCents(q: Queryable, ws: string, invoiceId: string): Promise<number> {
  const row = await one<{ sum: string | null }>(q, `SELECT sum(coalesce(result_cents, total_cents))::text AS sum FROM erp_credit_notes WHERE workspace_id = $1 AND invoice_id = $2 AND state = ANY($3)`, [ws, invoiceId, COUNTING]);
  return Number(row?.sum ?? 0);
}

export interface CreditNoteView {
  invoices: Array<CreditSourceInvoice & { earlierCents: number; proposal: CreditProposal }>;
  erpBaseUrl: string;
}

/** Reads the invoices with their lines and proposes amounts. Changes nothing. */
export async function lookupCreditNote(ctx: AppContext, actor: Actor, conversationId: string): Promise<CreditNoteView> {
  humanOnly(actor);
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  const { provider: p, baseUrl } = await provider(ctx, actor.workspaceId);
  const order = await caseInvoices(ctx, actor.workspaceId, conversationId, p);
  const invoices = sendableInvoices(order).slice(0, 5);
  if (invoices.length === 0) throw new ServiceError(409, "NO_INVOICE", "Zu dieser Bestellung gibt es in weclapp noch keine Rechnung. Eine Gutschrift braucht eine Rechnung.");
  const source = await creditSource(ctx.db, actor.workspaceId, conversationId);
  const out: CreditNoteView["invoices"] = [];
  for (const inv of invoices) {
    let full: CreditSourceInvoice;
    try {
      full = await p.getInvoiceForCredit(inv.id);
    } catch (error) {
      throw new ServiceError(502, "ERP_ERROR", `Rechnung ${inv.invoiceNumber ?? inv.id} lässt sich nicht lesen: ${(error as Error).message}`);
    }
    out.push({ ...full, earlierCents: await earlierCents(ctx.db, actor.workspaceId, inv.id), proposal: proposeCreditNote(full, source) });
  }
  return { invoices: out, erpBaseUrl: baseUrl };
}

export interface CreateCreditNoteInput {
  invoiceId: string;
  lines: Array<{ itemId: string; amount: string }>;
  shipping?: string;
  confirm: boolean;
  expectedTotalCents: number;
}

export interface CreateCreditNoteResult {
  id: string;
  state: "created" | "needs_review" | "uncertain" | "failed";
  creditNoteNumber?: string;
  totalCents: number;
  resultCents?: number;
  error?: string;
}

const amount = (v: string | undefined, label: string): number => {
  if (v === undefined || v.trim() === "") return 0;
  const c = parseAmountInput(v);
  if (c === undefined) throw new ServiceError(400, "INVALID", `${label}: Betrag bitte als Zahl eingeben, z. B. 12,50.`);
  return c ?? 0;
};

/** Creates the credit note draft in weclapp. Needs confirm=true and the confirmed total. */
export async function createCreditNote(ctx: AppContext, actor: Actor, conversationId: string, input: CreateCreditNoteInput): Promise<CreateCreditNoteResult> {
  humanOnly(actor);
  if (input.confirm !== true) throw new ServiceError(400, "CONFIRM_REQUIRED", "Bitte die Gutschrift im Dialog bestätigen.");
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  const { provider: p } = await provider(ctx, actor.workspaceId);
  const order = await caseInvoices(ctx, actor.workspaceId, conversationId, p);
  if (!sendableInvoices(order).some((i) => i.id === input.invoiceId)) throw new ServiceError(404, "NOT_FOUND", "Die Rechnung gehört nicht zur Bestellung dieses Falls.");
  const invoice = await p.getInvoiceForCredit(input.invoiceId);
  const lines = input.lines.map((l) => ({ itemId: l.itemId, grossCents: amount(l.amount, "Position") }));
  const shippingCents = amount(input.shipping, "Versand");

  const reserved = await withTx(ctx.db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`credit:${actor.workspaceId}:${input.invoiceId}`]);
    await tx.query(
      "UPDATE erp_credit_notes SET state = 'uncertain', error = 'Keine Antwort erhalten (Abbruch).', finished_at = now() WHERE workspace_id = $1 AND invoice_id = $2 AND state = 'pending' AND created_at < $3",
      [actor.workspaceId, input.invoiceId, new Date(ctx.now().getTime() - PENDING_STALE_MS)],
    );
    const open = await one<{ state: string }>(tx, "SELECT state FROM erp_credit_notes WHERE workspace_id = $1 AND invoice_id = $2 AND state IN ('pending','uncertain')", [actor.workspaceId, input.invoiceId]);
    if (open?.state === "uncertain") throw new ServiceError(409, "UNCERTAIN", "Eine frühere Gutschrift zu dieser Rechnung ist unklar. Bitte zuerst in weclapp nachsehen und sie im Fall als geprüft markieren.");
    if (open) throw new ServiceError(409, "IN_PROGRESS", "Zu dieser Rechnung wird gerade schon eine Gutschrift angelegt.");
    const check = checkCreditNote(invoice, lines, shippingCents, await earlierCents(tx, actor.workspaceId, input.invoiceId));
    if (!check.ok) throw new ServiceError(400, "INVALID", check.error);
    if (check.totalCents !== input.expectedTotalCents) throw new ServiceError(409, "TOTAL_CHANGED", `Der Betrag hat sich geändert (jetzt ${formatAmount(check.totalCents, invoice.currency ?? "EUR")}). Bitte neu prüfen und bestätigen.`);
    const stored = check.lines.map((l) => ({ ...l, title: invoice.items.find((i) => i.id === l.itemId)?.title.slice(0, 300) }));
    const res = await tx.query<{ id: string }>(
      `INSERT INTO erp_credit_notes (workspace_id, conversation_id, invoice_id, invoice_number, currency, total_cents, shipping_cents, lines, state, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) RETURNING id`,
      [actor.workspaceId, conversationId, input.invoiceId, invoice.invoiceNumber ?? null, invoice.currency ?? null, check.totalCents, check.shippingCents, JSON.stringify(stored), actor.userId],
    );
    return { id: res.rows[0]!.id, check };
  });

  let result: CreateCreditNoteResult;
  try {
    const draft = await p.createCreditNoteDraft(input.invoiceId, { lines: reserved.check.lines, shippingGrossCents: reserved.check.shippingCents });
    const off = draft.adjusted && draft.grossCents !== reserved.check.totalCents;
    result = {
      id: reserved.id,
      state: draft.adjusted && !off ? "created" : "needs_review",
      creditNoteNumber: draft.number,
      totalCents: reserved.check.totalCents,
      resultCents: draft.grossCents,
      error: !draft.adjusted ? `Gutschrift angelegt, Beträge aber nicht gesetzt: ${draft.adjustError ?? "unbekannt"}. Bitte in weclapp anpassen.` : off ? `weclapp rechnet ${formatAmount(draft.grossCents, invoice.currency ?? "EUR")} statt ${formatAmount(reserved.check.totalCents, invoice.currency ?? "EUR")} (Rundung). Bitte in weclapp prüfen.` : undefined,
    };
    await finish(ctx, actor, conversationId, result, draft.id);
  } catch (e) {
    const uncertain = e instanceof HttpError && e.uncertain;
    result = { id: reserved.id, state: uncertain ? "uncertain" : "failed", totalCents: reserved.check.totalCents, error: (e as Error).message };
    await finish(ctx, actor, conversationId, result, null);
  }
  return result;
}

async function finish(ctx: AppContext, actor: Extract<Actor, { type: "user" }>, conversationId: string, r: CreateCreditNoteResult, creditNoteId: string | null): Promise<void> {
  await withTx(ctx.db, async (tx) => {
    await tx.query(
      "UPDATE erp_credit_notes SET state = $3, credit_note_id = $4, credit_note_number = $5, result_cents = $6, error = $7, finished_at = now() WHERE workspace_id = $1 AND id = $2",
      [actor.workspaceId, r.id, r.state, creditNoteId, r.creditNoteNumber ?? null, r.resultCents ?? null, r.error ?? null],
    );
    if (r.state === "created" || r.state === "needs_review") {
      // The draft's number on the refund list; ticking "done" stays with the person after booking.
      await tx.query(
        `INSERT INTO refund_entries (workspace_id, conversation_id, added_manually, credit_note_number, created_by) VALUES ($1, $2, true, $3, $4)
         ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET credit_note_number = coalesce(EXCLUDED.credit_note_number, refund_entries.credit_note_number), removed_at = NULL, updated_at = now()`,
        [actor.workspaceId, conversationId, r.creditNoteNumber ?? null, actor.userId],
      );
    }
    await audit(tx, actor, `erp.credit_note_${r.state}`, "conversation", conversationId, { creditNoteRequestId: r.id, totalCents: r.totalCents, creditNoteNumber: r.creditNoteNumber });
  });
}

/** An unclear request: the person looked in weclapp. "exists" records it, "none" releases the invoice. */
export async function settleUncertainCreditNote(ctx: AppContext, actor: Actor, conversationId: string, id: string, input: { confirm: boolean; outcome: "exists" | "none" }): Promise<void> {
  humanOnly(actor);
  if (input.confirm !== true) throw new ServiceError(400, "CONFIRM_REQUIRED", "Bitte bestätigen, dass du in weclapp nachgesehen hast.");
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  const res = await ctx.db.query(
    "UPDATE erp_credit_notes SET state = $4, error = coalesce(error, '') || $5, finished_at = now() WHERE workspace_id = $1 AND id = $2 AND conversation_id = $3 AND state = 'uncertain'",
    [actor.workspaceId, id, conversationId, input.outcome === "exists" ? "needs_review" : "dismissed", input.outcome === "exists" ? " In weclapp vorhanden." : " In weclapp geprüft: keine Gutschrift."],
  );
  if (!res.rowCount) throw new ServiceError(409, "NOT_UNCERTAIN", "Diese Gutschrift ist nicht (mehr) unklar.");
  await audit(ctx.db, actor, input.outcome === "exists" ? "erp.credit_note_confirmed_manually" : "erp.credit_note_dismissed", "conversation", conversationId, { creditNoteRequestId: id });
}

/** Owner switches credit note drafts on or off. */
export async function setCreditNotesEnabled(ctx: AppContext, actor: Actor, enabled: boolean): Promise<void> {
  requireRole(actor, ["owner"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Nur ein Mensch schaltet Gutschriften frei.");
  const res = await ctx.db.query("UPDATE erp_connections SET credit_notes_enabled = $2 WHERE workspace_id = $1", [actor.workspaceId, enabled]);
  if (!res.rowCount) throw new ServiceError(404, "NOT_FOUND", "Keine weclapp-Verbindung eingerichtet.");
  await audit(ctx.db, actor, enabled ? "erp.credit_notes_enabled" : "erp.credit_notes_disabled", "workspace", actor.workspaceId);
}

export async function listCaseCreditNotes(q: Queryable, ws: string, conversationId: string) {
  return many(
    q,
    `SELECT n.id, n.invoice_id, n.invoice_number, n.currency, n.total_cents, n.shipping_cents, n.lines, n.state, n.credit_note_id, n.credit_note_number, n.result_cents, n.error, n.created_at, u.display_name AS requested_by
       FROM erp_credit_notes n JOIN users u ON u.id = n.requested_by WHERE n.workspace_id = $1 AND n.conversation_id = $2 ORDER BY n.created_at`,
    [ws, conversationId],
  );
}

export async function caseCreditNoteAccess(q: Queryable, ws: string): Promise<boolean> {
  return !!(await one<{ on: boolean }>(q, "SELECT credit_notes_enabled AS on FROM erp_connections WHERE workspace_id = $1 AND credit_notes_enabled", [ws]));
}
