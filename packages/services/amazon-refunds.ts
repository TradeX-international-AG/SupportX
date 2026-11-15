import { amazonMarketplace } from "../core/amazon-marketplaces.ts";
import { AMAZON_ORDER_ID, checkRefund, formatCents, isAmazonRefundReason, refundableOf, refundBlocker, type AmazonOrderView, type RefundLine } from "../core/amazon-refund.ts";
import { parseAmountInput } from "../core/refund-list.ts";
import { AmazonRefundsClient } from "../connectors/amazon/refunds.ts";
import { HttpError } from "../connectors/http.ts";
import { many, one, withTx, type Queryable } from "../storage/db.ts";
import { amazonClientConfig, loadConnection, type AmazonConnectionRow } from "./amazon-listings.ts";
import { audit } from "./audit.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/**
 * Refund an Amazon order from a case (order adjustment feed, see
 * core/amazon-refund.ts). Only a signed-in person, only after the owner switched
 * refunds on, only after reading the order at Amazon and confirming the total in
 * a dialog. Never the worker, an automation or the AI.
 *
 * Safety: one open refund per order (pending/submitted/uncertain), amounts never
 * above what was paid minus earlier SupportX refunds, and an unclear send blocks
 * the order until a person checked Seller Central.
 */

const PENDING_STALE_MS = 5 * 60_000;
/** States in which money may have gone back (or still may). */
const COUNTING = ["pending", "submitted", "accepted", "uncertain"];

interface RefundRow {
  id: string;
  order_id: string;
  marketplace_id: string;
  state: string;
  lines: Array<RefundLine & { title?: string }>;
  total_cents: number;
  currency: string;
  feed_id: string | null;
}

async function assertCase(q: Queryable, workspaceId: string, conversationId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const ok = await one(q, "SELECT 1 FROM conversations WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId]);
  if (!ok) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
}

function humanOnly(actor: Actor): asserts actor is Extract<Actor, { type: "user" }> {
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Eine Erstattung löst nur ein Mensch aus, nie eine Automatik.");
  requireRole(actor, ["owner", "agent"]);
}

async function enabledConnection(q: Queryable, workspaceId: string): Promise<AmazonConnectionRow> {
  const row = await loadConnection(q, workspaceId);
  if (!row) throw new ServiceError(409, "NOT_CONNECTED", "Kein Amazon-Zugang hinterlegt. Bitte in den Einstellungen unter „Amazon-Angebote“ eintragen.");
  if (!row.refunds_enabled) throw new ServiceError(409, "REFUNDS_OFF", "Erstattungen über Amazon sind nicht freigeschaltet. Der Inhaber schaltet sie in den Einstellungen unter „Amazon-Angebote“ ein.");
  return row;
}

async function client(ctx: AppContext, row: AmazonConnectionRow): Promise<AmazonRefundsClient> {
  try {
    return new AmazonRefundsClient(await amazonClientConfig(ctx, ctx.db, row));
  } catch (error) {
    throw new ServiceError(409, "NOT_CONNECTED", (error as Error).message);
  }
}

function orderIdOf(input: string): string {
  const id = input?.trim() ?? "";
  if (!AMAZON_ORDER_ID.test(id)) throw new ServiceError(400, "INVALID", "Bitte die Amazon-Bestellnummer angeben (Form 123-1234567-1234567).");
  return id;
}

async function readOrder(ctx: AppContext, row: AmazonConnectionRow, orderId: string): Promise<AmazonOrderView> {
  let order: AmazonOrderView | null;
  try {
    order = await (await client(ctx, row)).getOrder(orderId);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, "AMAZON_ERROR", (error as Error).message);
  }
  if (!order || order.items.length === 0) throw new ServiceError(404, "ORDER_NOT_FOUND", `Die Bestellung ${orderId} gibt es in diesem Amazon-Konto nicht.`);
  if (!row.marketplace_ids.includes(order.marketplaceId)) {
    throw new ServiceError(409, "MARKETPLACE_NOT_ALLOWED", `Die Bestellung ist auf ${amazonMarketplace(order.marketplaceId)?.label ?? order.marketplaceId}. Dieser Marktplatz ist für den Amazon-Zugang nicht freigegeben.`);
  }
  return order;
}

async function earlierRefunds(q: Queryable, workspaceId: string, orderId: string): Promise<RefundRow[]> {
  return many<RefundRow>(q, "SELECT id, order_id, marketplace_id, state, lines, total_cents, currency, feed_id FROM marketplace_refunds WHERE workspace_id = $1 AND platform = 'amazon' AND order_id = $2 ORDER BY created_at", [workspaceId, orderId]);
}

const counting = (rows: ReadonlyArray<RefundRow>): RefundLine[] => rows.filter((r) => COUNTING.includes(r.state)).flatMap((r) => r.lines);

export interface RefundOrderView {
  order: AmazonOrderView;
  blocker: string | null;
  /** An earlier refund of this order is still open or unclear: no new one until it is settled. */
  openRefund: { id: string; state: string } | null;
  fba: boolean;
  items: Array<AmazonOrderView["items"][number] & { refundablePrincipalCents: number; refundableShippingCents: number }>;
}

/** Reads the order at Amazon and what can still be refunded. Changes nothing. */
export async function lookupAmazonRefundOrder(ctx: AppContext, actor: Actor, conversationId: string, input: { orderId: string }): Promise<RefundOrderView> {
  humanOnly(actor);
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  const row = await enabledConnection(ctx.db, actor.workspaceId);
  const orderId = orderIdOf(input.orderId);
  const order = await readOrder(ctx, row, orderId);
  const earlier = await earlierRefunds(ctx.db, actor.workspaceId, orderId);
  const open = earlier.find((r) => ["pending", "submitted", "uncertain"].includes(r.state));
  const prior = counting(earlier);
  return {
    order,
    blocker: refundBlocker(order),
    openRefund: open ? { id: open.id, state: open.state } : null,
    fba: order.fulfillmentChannel === "AFN",
    items: order.items.map((i) => {
      const left = refundableOf(i, prior);
      return { ...i, refundablePrincipalCents: left.principalCents, refundableShippingCents: left.shippingCents };
    }),
  };
}

export interface IssueRefundInput {
  orderId: string;
  reason: string;
  lines: Array<{ orderItemId: string; principal?: string; shipping?: string }>;
  confirm: boolean;
  /** The total the person saw in the dialog, in cents. Must match what is sent. */
  expectedTotalCents: number;
}

export interface IssueRefundResult {
  id: string;
  state: "submitted" | "uncertain" | "failed";
  totalCents: number;
  currency: string;
  feedId?: string;
  error?: string;
}

function centsOf(v: string | undefined, label: string): number {
  if (v === undefined) return 0;
  const c = parseAmountInput(v);
  if (c === undefined) throw new ServiceError(400, "INVALID", `${label}: Betrag bitte als Zahl eingeben, z. B. 12,50.`);
  return c ?? 0;
}

/** Sends the refund to Amazon. Needs confirm=true and the total from the dialog. */
export async function issueAmazonRefund(ctx: AppContext, actor: Actor, conversationId: string, input: IssueRefundInput): Promise<IssueRefundResult> {
  humanOnly(actor);
  if (input.confirm !== true) throw new ServiceError(400, "CONFIRM_REQUIRED", "Bitte die Erstattung im Dialog bestätigen.");
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  const row = await enabledConnection(ctx.db, actor.workspaceId);
  const orderId = orderIdOf(input.orderId);
  if (!isAmazonRefundReason(input.reason)) throw new ServiceError(400, "INVALID", "Bitte einen Grund für die Erstattung wählen.");
  const reason = input.reason;
  const requested: RefundLine[] = input.lines.map((l) => ({ orderItemId: l.orderItemId, principalCents: centsOf(l.principal, "Artikel"), shippingCents: centsOf(l.shipping, "Versand") }));

  // Fresh from Amazon: the person's view may be old.
  const order = await readOrder(ctx, row, orderId);

  const reserved = await withTx(ctx.db, async (tx) => {
    // A pending row older than 5 minutes means the process died mid-request: unclear, not retried.
    await tx.query(
      "UPDATE marketplace_refunds SET state = 'uncertain', error = 'Keine Antwort erhalten (Abbruch).', finished_at = now() WHERE workspace_id = $1 AND platform = 'amazon' AND order_id = $2 AND state = 'pending' AND created_at < $3",
      [actor.workspaceId, orderId, new Date(ctx.now().getTime() - PENDING_STALE_MS)],
    );
    // Serialises refunds of the same order across requests.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`refund:${actor.workspaceId}:amazon:${orderId}`]);
    const earlier = await earlierRefunds(tx, actor.workspaceId, orderId);
    const open = earlier.find((r) => ["pending", "submitted", "uncertain"].includes(r.state));
    if (open?.state === "uncertain") throw new ServiceError(409, "UNCERTAIN", "Eine frühere Erstattung dieser Bestellung ist unklar. Bitte zuerst in Seller Central nachsehen und sie im Fall als geprüft markieren.");
    if (open) throw new ServiceError(409, "IN_PROGRESS", "Für diese Bestellung läuft schon eine Erstattung. Bitte zuerst das Ergebnis bei Amazon abrufen.");
    const check = checkRefund(order, requested, counting(earlier));
    if (!check.ok) throw new ServiceError(400, "INVALID", check.error);
    if (check.totalCents !== input.expectedTotalCents) throw new ServiceError(409, "TOTAL_CHANGED", `Der Betrag hat sich geändert (jetzt ${formatCents(check.totalCents, order.currency)}). Bitte neu prüfen und bestätigen.`);
    const lines = check.lines.map((l) => {
      const item = order.items.find((i) => i.orderItemId === l.orderItemId);
      return { ...l, title: item?.title?.slice(0, 300), sku: item?.sku?.slice(0, 200) };
    });
    const res = await tx.query<{ id: string }>(
      `INSERT INTO marketplace_refunds (workspace_id, conversation_id, platform, marketplace_id, order_id, reason, currency, total_cents, lines, state, requested_by)
       VALUES ($1, $2, 'amazon', $3, $4, $5, $6, $7, $8, 'pending', $9) RETURNING id`,
      [actor.workspaceId, conversationId, order.marketplaceId, orderId, reason, order.currency, check.totalCents, JSON.stringify(lines), actor.userId],
    );
    return { id: res.rows[0]!.id, lines: check.lines, totalCents: check.totalCents };
  });

  let result: IssueRefundResult;
  try {
    const { feedId } = await (await client(ctx, row)).submitAdjustment({ orderId, marketplaceId: order.marketplaceId, currency: order.currency, reason, lines: reserved.lines });
    result = { id: reserved.id, state: "submitted", totalCents: reserved.totalCents, currency: order.currency, feedId };
  } catch (e) {
    const uncertain = e instanceof HttpError && e.uncertain;
    result = { id: reserved.id, state: uncertain ? "uncertain" : "failed", totalCents: reserved.totalCents, currency: order.currency, error: (e as Error).message };
  }
  await withTx(ctx.db, async (tx) => {
    await tx.query(
      "UPDATE marketplace_refunds SET state = $3, feed_id = $4, error = $5, finished_at = CASE WHEN $3 = 'submitted' THEN NULL ELSE now() END WHERE workspace_id = $1 AND id = $2",
      [actor.workspaceId, reserved.id, result.state, result.feedId ?? null, result.error ?? null],
    );
    await audit(tx, actor, `amazon.refund_${result.state}`, "conversation", conversationId, { orderId, totalCents: reserved.totalCents, currency: order.currency, reason, feedId: result.feedId, refundId: reserved.id });
  });
  return result;
}

/** Fetches the result of a submitted refund from Amazon. Changes nothing at Amazon. */
export async function checkAmazonRefund(ctx: AppContext, actor: Actor, conversationId: string, refundId: string): Promise<{ state: string; messages: string[] }> {
  requireRole(actor, ["owner", "agent"]);
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  if (!/^[0-9a-f-]{36}$/i.test(refundId)) throw new ServiceError(404, "NOT_FOUND", "Erstattung nicht gefunden.");
  const refund = await one<RefundRow & { conversation_id: string }>(ctx.db, "SELECT * FROM marketplace_refunds WHERE workspace_id = $1 AND id = $2 AND conversation_id = $3", [actor.workspaceId, refundId, conversationId]);
  if (!refund) throw new ServiceError(404, "NOT_FOUND", "Erstattung nicht gefunden.");
  if (refund.state !== "submitted" || !refund.feed_id) return { state: refund.state, messages: [] };
  const row = await loadConnection(ctx.db, actor.workspaceId);
  if (!row) throw new ServiceError(409, "NOT_CONNECTED", "Kein Amazon-Zugang hinterlegt.");
  let feed;
  try {
    feed = await (await client(ctx, row)).getFeedResult(refund.feed_id);
  } catch (error) {
    throw new ServiceError(502, "AMAZON_ERROR", (error as Error).message);
  }
  if (feed.state === "in_progress") {
    await ctx.db.query("UPDATE marketplace_refunds SET checked_at = now() WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, refundId]);
    return { state: "submitted", messages: [] };
  }
  const state = feed.state === "done" ? "accepted" : "rejected";
  const messages = feed.report?.messages ?? (feed.state === "failed" ? [`Amazon-Status ${feed.processingStatus}`] : []);
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query(
      "UPDATE marketplace_refunds SET state = $3, result_messages = $4, error = $5, checked_at = now(), finished_at = now() WHERE workspace_id = $1 AND id = $2 AND state = 'submitted'",
      [actor.workspaceId, refundId, state, JSON.stringify(messages), state === "rejected" ? messages.join("; ") || "Von Amazon abgelehnt." : null],
    );
    if (!res.rowCount) return;
    await audit(tx, actor, `amazon.refund_${state}`, "conversation", conversationId, { orderId: refund.order_id, feedId: refund.feed_id, refundId });
    if (state === "accepted") {
      // On the refund list with the amount, so the credit note in the ERP is not forgotten.
      await tx.query(
        `INSERT INTO refund_entries (workspace_id, conversation_id, added_manually, amount_cents, currency, note, created_by) VALUES ($1, $2, true, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET added_manually = true, removed_at = NULL,
           amount_cents = coalesce(refund_entries.amount_cents, EXCLUDED.amount_cents), currency = coalesce(refund_entries.currency, EXCLUDED.currency),
           note = coalesce(refund_entries.note, EXCLUDED.note), updated_at = now()`,
        [actor.workspaceId, conversationId, refund.total_cents, refund.currency, `Bei Amazon erstattet (Vorgang ${refund.feed_id}).`, actor.type === "user" ? actor.userId : null],
      );
    }
  });
  return { state, messages };
}

/**
 * An unclear refund: a person looked in Seller Central. "refunded" records it
 * as done there; "not_refunded" releases the order for a new attempt.
 */
export async function settleUncertainAmazonRefund(ctx: AppContext, actor: Actor, conversationId: string, refundId: string, input: { confirm: boolean; outcome: "refunded" | "not_refunded" }): Promise<void> {
  humanOnly(actor);
  if (input.confirm !== true) throw new ServiceError(400, "CONFIRM_REQUIRED", "Bitte bestätigen, dass du in Seller Central nachgesehen hast.");
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query(
      "UPDATE marketplace_refunds SET state = $4, error = coalesce(error, '') || $5, finished_at = now() WHERE workspace_id = $1 AND id = $2 AND conversation_id = $3 AND state = 'uncertain'",
      [actor.workspaceId, refundId, conversationId, input.outcome === "refunded" ? "accepted" : "dismissed", input.outcome === "refunded" ? " In Seller Central als erstattet bestätigt." : " In Seller Central geprüft: nicht erstattet."],
    );
    if (!res.rowCount) throw new ServiceError(409, "NOT_UNCERTAIN", "Diese Erstattung ist nicht (mehr) unklar.");
    await audit(tx, actor, input.outcome === "refunded" ? "amazon.refund_confirmed_manually" : "amazon.refund_dismissed", "conversation", conversationId, { refundId });
  });
}

export async function listCaseMarketplaceRefunds(q: Queryable, workspaceId: string, conversationId: string) {
  return many(
    q,
    `SELECT r.id, r.platform, r.marketplace_id, r.order_id, r.reason, r.currency, r.total_cents, r.lines, r.state, r.feed_id, r.result_messages, r.error,
            r.created_at, r.checked_at, r.finished_at, u.display_name AS requested_by
       FROM marketplace_refunds r JOIN users u ON u.id = r.requested_by
      WHERE r.workspace_id = $1 AND r.conversation_id = $2 ORDER BY r.created_at`,
    [workspaceId, conversationId],
  );
}
