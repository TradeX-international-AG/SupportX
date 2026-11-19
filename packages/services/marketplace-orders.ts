import type { OrderRecord, SourcePlatform } from "../core/contracts.ts";
import { cleanOrderId, type MarketplaceOrderView } from "../core/marketplace-order.ts";
import { isMiraklPlatform, PLATFORM_NAMES } from "../core/marketplaces.ts";
import { HttpError } from "../connectors/http.ts";
import { OttoOrdersClient } from "../connectors/otto/orders.ts";
import { one, withTx, type Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { channelFor, type ChannelConnectionRow } from "./connections.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/**
 * "Beim Marktplatz nachsehen": the order as the marketplace itself shows it,
 * read live on a person's click. Read only. weclapp stays the order source of
 * drafts; nothing here goes into a draft or to the AI.
 *
 * Kaufland and the Mirakl marketplaces use the keys of their message channel;
 * OTTO has no message API, so its API key is stored on its own
 * (marketplace_api_connections) and only used for this lookup.
 */

// ---------------------------------------------------------------------------
// OTTO API access (settings)

interface ApiConnectionRow {
  workspace_id: string;
  platform: "otto";
  secret_id: string;
  key_hint: string;
  config: { clientId: string; sandbox?: boolean; baseUrl?: string };
  status: string;
  last_checked_at: Date | null;
  last_error: string | null;
}

interface OttoSecret {
  clientSecret: string;
}

async function loadOtto(q: Queryable, workspaceId: string): Promise<ApiConnectionRow | null> {
  return one<ApiConnectionRow>(q, "SELECT * FROM marketplace_api_connections WHERE workspace_id = $1 AND platform = 'otto'", [workspaceId]);
}

async function ottoClient(ctx: AppContext, q: Queryable, row: ApiConnectionRow): Promise<OttoOrdersClient> {
  const raw = await ctx.secrets.read(q, row.workspace_id, row.secret_id);
  let secret: OttoSecret;
  try {
    secret = JSON.parse(raw) as OttoSecret;
  } catch {
    throw new ServiceError(409, "NOT_CONNECTED", "Gespeicherte OTTO-Zugangsdaten sind beschädigt. Bitte neu eintragen.");
  }
  try {
    return new OttoOrdersClient({ clientId: row.config.clientId, clientSecret: secret.clientSecret, sandbox: row.config.sandbox, baseUrl: row.config.baseUrl, allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS });
  } catch (error) {
    throw new ServiceError(409, "NOT_CONNECTED", (error as Error).message);
  }
}

/** Client id shortened, the secret never: "abcd…wxyz" plus "Secret ••••1234". */
export function ottoKeyHint(clientId: string, clientSecret: string): string {
  const id = clientId.length > 10 ? `${clientId.slice(0, 4)}…${clientId.slice(-4)}` : clientId;
  return `Client-ID ${id} · Secret ••••${clientSecret.slice(-4)}`;
}

/** Settings view: no secret, only the masked hint. */
export async function getOttoSettings(ctx: AppContext, actor: Actor) {
  const row = await loadOtto(ctx.db, actor.workspaceId);
  if (!row) return { configured: false as const };
  return { configured: true as const, keyHint: row.key_hint, sandbox: !!row.config.sandbox, status: row.status, lastCheckedAt: row.last_checked_at, lastError: row.last_error };
}

export async function saveOttoConnection(ctx: AppContext, actor: Actor, input: { clientId?: string; clientSecret?: string; sandbox?: boolean; baseUrl?: string }): Promise<void> {
  requireRole(actor, ["owner"]);
  const clientId = input.clientId?.trim() ?? "";
  const clientSecret = input.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new ServiceError(400, "INVALID", "Bitte Client-ID und Client-Secret aus OTTO Partner Connect eintragen.");
  const config: ApiConnectionRow["config"] = { clientId, ...(input.sandbox ? { sandbox: true } : {}), ...(input.baseUrl && ctx.config.ALLOW_TEST_ENDPOINTS ? { baseUrl: input.baseUrl } : {}) };
  try {
    // Offline check: endpoint allow-list and required fields, no call to OTTO.
    new OttoOrdersClient({ clientId, clientSecret, sandbox: config.sandbox, baseUrl: config.baseUrl, allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS });
  } catch (error) {
    throw new ServiceError(400, "INVALID", (error as Error).message);
  }
  await withTx(ctx.db, async (tx) => {
    const existing = await loadOtto(tx, actor.workspaceId);
    const secretId = await ctx.secrets.store(tx, actor.workspaceId, "otto_api", JSON.stringify({ clientSecret } satisfies OttoSecret));
    await tx.query(
      `INSERT INTO marketplace_api_connections (workspace_id, platform, secret_id, key_hint, config) VALUES ($1, 'otto', $2, $3, $4)
       ON CONFLICT (workspace_id, platform) DO UPDATE SET secret_id = EXCLUDED.secret_id, key_hint = EXCLUDED.key_hint, config = EXCLUDED.config,
         status = 'configured', last_error = NULL, last_checked_at = NULL, updated_at = now()`,
      [actor.workspaceId, secretId, ottoKeyHint(clientId, clientSecret), JSON.stringify(config)],
    );
    if (existing) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, existing.secret_id]);
    await audit(tx, actor, existing ? "otto_api.changed" : "otto_api.connected", "workspace", actor.workspaceId);
  });
}

export async function deleteOttoConnection(ctx: AppContext, actor: Actor): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    const row = await loadOtto(tx, actor.workspaceId);
    if (!row) throw new ServiceError(404, "NOT_FOUND", "Kein OTTO-Zugang hinterlegt.");
    await tx.query("DELETE FROM marketplace_api_connections WHERE workspace_id = $1 AND platform = 'otto'", [actor.workspaceId]);
    await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.secret_id]);
    await audit(tx, actor, "otto_api.removed", "workspace", actor.workspaceId);
  });
}

export async function checkOttoConnection(ctx: AppContext, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  requireRole(actor, ["owner"]);
  const row = await loadOtto(ctx.db, actor.workspaceId);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Kein OTTO-Zugang hinterlegt.");
  const result = await (await ottoClient(ctx, ctx.db, row)).checkAccess();
  await ctx.db.query("UPDATE marketplace_api_connections SET status = $2, last_error = $3, last_checked_at = now() WHERE workspace_id = $1 AND platform = 'otto'", [actor.workspaceId, result.ok ? "ok" : "error", result.ok ? null : result.detail]);
  return result;
}

// ---------------------------------------------------------------------------
// In the case

export interface CaseMarketplaceOrder {
  platform: string;
  platformName: string;
  /** False: this marketplace has no order API in SupportX, or it is not connected (see `reason`). */
  available: boolean;
  reason?: string;
  /** Order numbers to try, best first: weclapp's marketplace order number, then numbers from the messages. */
  candidates: string[];
  order?: MarketplaceOrderView | null;
}

interface CaseRow {
  source_platform: SourcePlatform;
  connection_id: string;
  order_references: unknown;
}

const LOOKUP_KINDS: Partial<Record<string, ChannelConnectionRow["kind"]>> = { kaufland: "kaufland_tickets" };

async function loadCase(q: Queryable, ws: string, conversationId: string): Promise<CaseRow> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const row = await one<CaseRow>(q, "SELECT source_platform, connection_id, order_references FROM conversations WHERE workspace_id = $1 AND id = $2", [ws, conversationId]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  return row;
}

async function candidates(q: Queryable, ws: string, conversationId: string, c: CaseRow): Promise<string[]> {
  const link = await one<{ snapshot: OrderRecord | null }>(q, "SELECT snapshot FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current AND status = 'unique'", [ws, conversationId]);
  const refs = Array.isArray(c.order_references) ? (c.order_references as Array<{ value?: unknown; kind?: unknown }>) : [];
  const fromMessages = refs.filter((r) => typeof r.value === "string" && r.kind !== "invoice_number" && r.kind !== "tracking_number").map((r) => r.value as string);
  const list = [link?.snapshot?.orderNumberAtCustomer, ...fromMessages].map((v) => (v ? cleanOrderId(v) : null)).filter((v): v is string => !!v);
  return [...new Set(list)].slice(0, 5);
}

/** The message channel whose keys read orders of this marketplace: the case's own connection first. */
async function channelRowFor(q: Queryable, ws: string, c: CaseRow): Promise<ChannelConnectionRow | null> {
  const kind = isMiraklPlatform(c.source_platform) ? "mirakl_inbox" : LOOKUP_KINDS[c.source_platform];
  if (!kind) return null;
  return one<ChannelConnectionRow>(
    q,
    `SELECT * FROM channel_connections
     WHERE workspace_id = $1 AND kind = $2 AND secret_id IS NOT NULL AND ($2 <> 'mirakl_inbox' OR default_source_platform = $3)
     ORDER BY (id = $4) DESC, paused, (health = 'ok') DESC, created_at LIMIT 1`,
    [ws, kind, c.source_platform, c.connection_id],
  );
}

type Lookup = { lookupOrder(orderId: string): Promise<MarketplaceOrderView | null> };

async function lookupFor(ctx: AppContext, ws: string, c: CaseRow): Promise<{ lookup: Lookup | null; reason?: string }> {
  const name = PLATFORM_NAMES[c.source_platform] ?? c.source_platform;
  if (c.source_platform === "otto") {
    const row = await loadOtto(ctx.db, ws);
    if (!row) return { lookup: null, reason: "Für OTTO ist noch kein API-Zugang hinterlegt (Einstellungen → Marktplätze → OTTO)." };
    return { lookup: await ottoClient(ctx, ctx.db, row) };
  }
  const row = await channelRowFor(ctx.db, ws, c);
  if (!row) {
    const known = isMiraklPlatform(c.source_platform) || !!LOOKUP_KINDS[c.source_platform];
    return { lookup: null, reason: known ? `${name} ist noch nicht per Schnittstelle verbunden.` : `Für ${name} gibt es in SupportX noch keine Bestell-Schnittstelle.` };
  }
  const channel = await channelFor(ctx, ctx.db, row);
  if (!channel.lookupOrder) return { lookup: null, reason: `Für ${name} gibt es in SupportX noch keine Bestell-Schnittstelle.` };
  return { lookup: { lookupOrder: (id) => channel.lookupOrder!(id) } };
}

/** Whether the case's marketplace can be asked, and which numbers to try. No call to the marketplace. */
export async function caseMarketplaceOrderInfo(ctx: AppContext, actor: Actor, conversationId: string): Promise<CaseMarketplaceOrder> {
  requireRole(actor, ["owner", "agent", "viewer"]);
  const ws = actor.workspaceId;
  const c = await loadCase(ctx.db, ws, conversationId);
  const list = await candidates(ctx.db, ws, conversationId, c);
  const base = { platform: c.source_platform, platformName: PLATFORM_NAMES[c.source_platform] ?? c.source_platform, candidates: list };
  const supported = c.source_platform === "otto" || c.source_platform === "kaufland" || isMiraklPlatform(c.source_platform);
  if (!supported) return { ...base, available: false, reason: `Für ${base.platformName} gibt es in SupportX noch keine Bestell-Schnittstelle.` };
  const connected = c.source_platform === "otto" ? !!(await loadOtto(ctx.db, ws)) : !!(await channelRowFor(ctx.db, ws, c));
  return connected ? { ...base, available: true } : { ...base, available: false, reason: `${base.platformName} ist noch nicht per Schnittstelle verbunden.` };
}

/** Reads one order at the marketplace, on a person's click. */
export async function lookupCaseMarketplaceOrder(ctx: AppContext, actor: Actor, conversationId: string, input: { orderId?: string }): Promise<CaseMarketplaceOrder> {
  requireRole(actor, ["owner", "agent", "viewer"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Nur auf Klick einer Person.");
  const ws = actor.workspaceId;
  const c = await loadCase(ctx.db, ws, conversationId);
  const list = await candidates(ctx.db, ws, conversationId, c);
  const base = { platform: c.source_platform, platformName: PLATFORM_NAMES[c.source_platform] ?? c.source_platform, candidates: list };
  const orderId = input.orderId ? cleanOrderId(input.orderId) : list[0] ?? null;
  if (!orderId) throw new ServiceError(400, "INVALID", "Bitte eine gültige Bestellnummer des Marktplatzes eingeben.");
  const { lookup, reason } = await lookupFor(ctx, ws, c);
  if (!lookup) return { ...base, available: false, reason };
  try {
    const order = await lookup.lookupOrder(orderId);
    return { ...base, available: true, order: order ? { ...order, platform: c.source_platform } : null };
  } catch (error) {
    if (error instanceof HttpError) {
      const refused = error.status === 401 || error.status === 403;
      throw new ServiceError(502, "MARKETPLACE_ERROR", refused ? `${base.platformName} lehnt den Zugang ab. Bitte die Zugangsdaten in den Einstellungen prüfen (für Bestellungen braucht der Schlüssel Leserecht auf Aufträge).` : `${base.platformName}: ${error.message}`);
    }
    throw error;
  }
}
