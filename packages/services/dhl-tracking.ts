import { carrierFacts, needsFetch, parcelTargets, type CarrierTrackingResult, type ParcelTarget } from "../core/carrier-tracking.ts";
import type { AllowedFact, OrderRecord } from "../core/contracts.ts";
import { DhlTrackingClient } from "../connectors/dhl/tracking.ts";
import { HttpError } from "../connectors/http.ts";
import { many, one, withTx, type Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/**
 * DHL parcel status in the case. Read only: SupportX asks DHL for the status of
 * parcel numbers it already has (weclapp deliveries, numbers the customer wrote)
 * and keeps the last answer per number. Nothing is sent to DHL but the number and,
 * for more details, the recipient's postal code from weclapp.
 */

interface ConnectionRow {
  workspace_id: string;
  secret_id: string;
  key_hint: string;
  api_url: string | null;
  status: string;
  last_checked_at: Date | null;
  last_error: string | null;
}

async function loadConnection(q: Queryable, workspaceId: string): Promise<ConnectionRow | null> {
  return one<ConnectionRow>(q, "SELECT * FROM dhl_tracking_connections WHERE workspace_id = $1", [workspaceId]);
}

async function clientFor(ctx: AppContext, q: Queryable, row: ConnectionRow): Promise<DhlTrackingClient> {
  const apiKey = await ctx.secrets.read(q, row.workspace_id, row.secret_id);
  try {
    return new DhlTrackingClient({ apiKey, apiUrl: row.api_url ?? undefined, allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS });
  } catch (error) {
    throw new ServiceError(409, "NOT_CONNECTED", (error as Error).message);
  }
}

function keyHint(key: string): string {
  return `••••${key.slice(-4)}`;
}

/** Settings view: the key only as "••••abcd". */
export async function getDhlSettings(ctx: AppContext, actor: Actor) {
  const row = await loadConnection(ctx.db, actor.workspaceId);
  if (!row) return { configured: false as const };
  return { configured: true as const, keyHint: row.key_hint, status: row.status, lastCheckedAt: row.last_checked_at, lastError: row.last_error };
}

export async function saveDhlConnection(ctx: AppContext, actor: Actor, input: { apiKey?: string; apiUrl?: string }): Promise<void> {
  requireRole(actor, ["owner"]);
  const apiKey = input.apiKey?.trim();
  if (!apiKey) throw new ServiceError(400, "INVALID", "Bitte den DHL-API-Key eintragen.");
  const apiUrl = input.apiUrl?.trim() || null;
  try {
    // Offline check: key format and endpoint allow-list, no call to DHL.
    new DhlTrackingClient({ apiKey, apiUrl: apiUrl ?? undefined, allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS });
  } catch (error) {
    throw new ServiceError(400, "INVALID", (error as Error).message);
  }
  await withTx(ctx.db, async (tx) => {
    const existing = await loadConnection(tx, actor.workspaceId);
    const secretId = await ctx.secrets.store(tx, actor.workspaceId, "dhl_tracking", apiKey);
    await tx.query(
      `INSERT INTO dhl_tracking_connections (workspace_id, secret_id, key_hint, api_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id) DO UPDATE SET secret_id = EXCLUDED.secret_id, key_hint = EXCLUDED.key_hint, api_url = EXCLUDED.api_url,
         status = 'configured', last_error = NULL, last_checked_at = NULL, updated_at = now()`,
      [actor.workspaceId, secretId, keyHint(apiKey), apiUrl],
    );
    if (existing) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, existing.secret_id]);
    await audit(tx, actor, existing ? "dhl_tracking.changed" : "dhl_tracking.connected", "workspace", actor.workspaceId);
  });
}

export async function deleteDhlConnection(ctx: AppContext, actor: Actor): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    const row = await loadConnection(tx, actor.workspaceId);
    if (!row) throw new ServiceError(404, "NOT_FOUND", "Kein DHL-Zugang hinterlegt.");
    await tx.query("DELETE FROM dhl_tracking_connections WHERE workspace_id = $1", [actor.workspaceId]);
    await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.secret_id]);
    await audit(tx, actor, "dhl_tracking.removed", "workspace", actor.workspaceId);
  });
}

export async function checkDhlConnection(ctx: AppContext, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  requireRole(actor, ["owner"]);
  const row = await loadConnection(ctx.db, actor.workspaceId);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Kein DHL-Zugang hinterlegt.");
  const result = await (await clientFor(ctx, ctx.db, row)).checkAccess();
  await ctx.db.query("UPDATE dhl_tracking_connections SET status = $2, last_error = $3, last_checked_at = now() WHERE workspace_id = $1", [actor.workspaceId, result.ok ? "ok" : "error", result.ok ? null : result.detail]);
  return result;
}

// ---------------------------------------------------------------------------
// In the case

async function caseTargets(q: Queryable, workspaceId: string, conversationId: string): Promise<ParcelTarget[]> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const conv = await one<{ order_references: unknown }>(q, "SELECT order_references FROM conversations WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId]);
  if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const link = await one<{ snapshot: OrderRecord | null }>(q, "SELECT snapshot FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current AND status = 'unique'", [workspaceId, conversationId]);
  const refs = Array.isArray(conv.order_references) ? (conv.order_references as Array<{ value?: unknown; kind?: unknown }>) : [];
  const customer = refs.filter((r) => r.kind === "tracking_number" && typeof r.value === "string").map((r) => r.value as string);
  return parcelTargets(link?.snapshot ?? null, customer);
}

async function storedResults(q: Queryable, workspaceId: string, numbers: ReadonlyArray<string>): Promise<Map<string, CarrierTrackingResult>> {
  if (numbers.length === 0) return new Map();
  const rows = await many<{ tracking_number: string; result: CarrierTrackingResult }>(
    q,
    "SELECT tracking_number, result FROM parcel_tracking WHERE workspace_id = $1 AND carrier = 'dhl' AND tracking_number = ANY($2::text[])",
    [workspaceId, numbers],
  );
  return new Map(rows.map((r) => [r.tracking_number, r.result]));
}

export interface CaseParcelTracking {
  /** False: no DHL key in this workspace (the case shows a hint to set it up). */
  connected: boolean;
  parcels: Array<{ target: ParcelTarget; result?: CarrierTrackingResult }>;
  /** Set when DHL's daily limit stopped the round; the rest is asked next time. */
  limited?: boolean;
}

/**
 * Status of the case's DHL parcels. Asks DHL only for numbers without a fresh
 * answer (delivered stays; others after 2 h; force = the "Neu abrufen" click, at
 * most every 5 min per number). Called when a person opens the case and on click;
 * the worker and the AI never trigger calls (a verified caller of the phone hotline may).
 */
export async function trackCaseParcels(ctx: AppContext, actor: Actor, conversationId: string, opts: { force?: boolean } = {}): Promise<CaseParcelTracking> {
  requireRole(actor, ["owner", "agent", "viewer"]);
  const targets = await caseTargets(ctx.db, actor.workspaceId, conversationId);
  return trackParcels(ctx, actor.workspaceId, targets, { force: !!opts.force && actor.type === "user" });
}

/**
 * Status of given parcel numbers, with the same cache and limits as the case view.
 * Also used by the phone hotline for a verified caller (never with force).
 */
export async function trackParcels(ctx: AppContext, ws: string, targets: ReadonlyArray<ParcelTarget>, opts: { force?: boolean } = {}): Promise<CaseParcelTracking> {
  const row = await loadConnection(ctx.db, ws);
  const stored = await storedResults(ctx.db, ws, targets.map((t) => t.trackingNumber));
  if (!row || targets.length === 0) return { connected: !!row, parcels: targets.map((target) => ({ target, result: stored.get(target.trackingNumber) })) };

  const now = ctx.now();
  const due = targets.filter((t) => needsFetch(stored.get(t.trackingNumber), now, !!opts.force));
  let limited = false;
  if (due.length > 0) {
    const client = await clientFor(ctx, ctx.db, row);
    for (const t of due) {
      let result: CarrierTrackingResult;
      try {
        result = await client.track(t.trackingNumber, { postalCode: t.postalCode, now });
      } catch (error) {
        if (error instanceof HttpError && error.status === 429) {
          limited = true;
          break;
        }
        const previous = stored.get(t.trackingNumber);
        const message = error instanceof HttpError && (error.status === 401 || error.status === 403) ? "DHL lehnt den API-Key ab. Bitte in den Einstellungen unter „DHL-Sendungsstatus“ prüfen." : (error as Error).message;
        // Keep the last real answer visible; only remember that this round failed.
        result = previous && previous.state !== "error" ? { ...previous, error: message } : { carrier: "dhl", trackingNumber: t.trackingNumber, state: "error", events: [], error: message, fetchedAt: now.toISOString() };
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          await ctx.db.query("UPDATE dhl_tracking_connections SET status = 'error', last_error = $2, last_checked_at = now() WHERE workspace_id = $1", [ws, message]);
        }
        // An error never makes a stored answer look fresh.
        if (previous && previous.state !== "error") {
          stored.set(t.trackingNumber, result);
          continue;
        }
      }
      await ctx.db.query(
        `INSERT INTO parcel_tracking (workspace_id, carrier, tracking_number, state, status_code, result, fetched_at) VALUES ($1, 'dhl', $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, carrier, tracking_number) DO UPDATE SET state = EXCLUDED.state, status_code = EXCLUDED.status_code, result = EXCLUDED.result, fetched_at = EXCLUDED.fetched_at`,
        [ws, t.trackingNumber, result.state, result.statusCode ?? null, JSON.stringify(result), result.fetchedAt],
      );
      stored.set(t.trackingNumber, result);
    }
  }
  return { connected: true, parcels: targets.map((target) => ({ target, result: stored.get(target.trackingNumber) })), ...(limited ? { limited } : {}) };
}

/** Facts from the stored DHL answers of a case, for drafts (no call to DHL). */
export async function caseCarrierFacts(q: Queryable, workspaceId: string, conversationId: string): Promise<AllowedFact[]> {
  const targets = await caseTargets(q, workspaceId, conversationId).catch(() => [] as ParcelTarget[]);
  if (targets.length === 0) return [];
  const stored = await storedResults(q, workspaceId, targets.map((t) => t.trackingNumber));
  return carrierFacts(targets.flatMap((target) => {
    const result = stored.get(target.trackingNumber);
    return result ? [{ target, result }] : [];
  }));
}
