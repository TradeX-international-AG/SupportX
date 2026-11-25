import type { OrderRecord } from "../core/contracts.ts";
import { checkReturnAddress, EU_COUNTRIES, parseReceiverIds, receiverCountries, type ReturnAddress } from "../core/return-label.ts";
import { DhlReturnsClient, dhlReturnsAuthHint, type DhlReturnLabel } from "../connectors/dhl/returns.ts";
import { HttpError } from "../connectors/http.ts";
import { many, one, withTx, type Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { loadErpConnection, orderProviderFor, type ChannelKind } from "./connections.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { attachStoredCaseFiles, lockCaseForFiles, REPLY_FILES, storeCaseFile, type CaseFileInfo } from "./documents.ts";

/**
 * DHL return labels from the case. A person clicks "Retourenlabel erstellen", checks
 * the customer's address read fresh from the ERP and confirms; only then SupportX asks
 * DHL (Parcel DE Returns) for one label. The PDF stays with the case and can go out
 * with the next reply. Nothing is sent to the customer here, and the worker and the AI
 * never make labels.
 */

const UUID = /^[0-9a-f-]{36}$/i;

interface ConnectionRow {
  workspace_id: string;
  secret_id: string;
  use_tracking_key: boolean;
  receiver_ids: Record<string, string>;
  sandbox: boolean;
  api_url: string | null;
  status: string;
  last_checked_at: Date | null;
  last_error: string | null;
}

/** Encrypted together in one secret. */
interface StoredAccess {
  user: string;
  password: string;
  apiKey?: string;
}

async function loadConnection(q: Queryable, workspaceId: string): Promise<ConnectionRow | null> {
  return one<ConnectionRow>(q, "SELECT * FROM dhl_return_connections WHERE workspace_id = $1", [workspaceId]);
}

async function readAccess(ctx: AppContext, q: Queryable, row: ConnectionRow): Promise<StoredAccess> {
  return JSON.parse(await ctx.secrets.read(q, row.workspace_id, row.secret_id)) as StoredAccess;
}

async function trackingKey(ctx: AppContext, q: Queryable, workspaceId: string): Promise<string | null> {
  const t = await one<{ secret_id: string }>(q, "SELECT secret_id FROM dhl_tracking_connections WHERE workspace_id = $1", [workspaceId]);
  return t ? ctx.secrets.read(q, workspaceId, t.secret_id) : null;
}

async function clientFor(ctx: AppContext, q: Queryable, row: ConnectionRow): Promise<DhlReturnsClient> {
  const access = await readAccess(ctx, q, row);
  const apiKey = row.use_tracking_key ? await trackingKey(ctx, q, row.workspace_id) : access.apiKey;
  if (!apiKey) throw new ServiceError(409, "NOT_CONNECTED", "Für das DHL-Retourenlabel fehlt der API-Key: Beim DHL-Sendungsstatus ist keiner mehr hinterlegt. Bitte unter Einstellungen → DHL-Retourenlabel einen eigenen eintragen.");
  try {
    return new DhlReturnsClient({ apiKey, user: access.user, password: access.password, sandbox: row.sandbox, apiUrl: row.api_url ?? undefined, allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS });
  } catch (error) {
    throw new ServiceError(409, "NOT_CONNECTED", (error as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Settings

export type DhlReturnSettings =
  | { configured: false; trackingKey: boolean }
  | { configured: true; trackingKey: boolean; useTrackingKey: boolean; countries: string[]; sandbox: boolean; status: string; lastCheckedAt: Date | null; lastError: string | null };

/** Settings view: no user, password, key or receiver ID, only what is set up. */
export async function getDhlReturnSettings(ctx: AppContext, actor: Actor): Promise<DhlReturnSettings> {
  const row = await loadConnection(ctx.db, actor.workspaceId);
  const hasTrackingKey = !!(await one(ctx.db, "SELECT 1 FROM dhl_tracking_connections WHERE workspace_id = $1", [actor.workspaceId]));
  if (!row) return { configured: false, trackingKey: hasTrackingKey };
  return { configured: true, trackingKey: hasTrackingKey, useTrackingKey: row.use_tracking_key, countries: receiverCountries(row.receiver_ids), sandbox: row.sandbox, status: row.status, lastCheckedAt: row.last_checked_at, lastError: row.last_error };
}

export interface DhlReturnInput {
  /** Business customer portal user; empty on a change = keep. */
  user?: string;
  password?: string;
  /** Own API key; ignored with useTrackingKey. Empty on a change = keep. */
  apiKey?: string;
  useTrackingKey: boolean;
  /** Receiver ID for Germany; empty on a change (with receiverOthers empty) = keep. */
  receiverGermany?: string;
  /** Further EU countries: "AUT=aut, BEL=bel". */
  receiverOthers?: string;
  sandbox?: boolean;
  apiUrl?: string;
}

export async function saveDhlReturnConnection(ctx: AppContext, actor: Actor, input: DhlReturnInput): Promise<void> {
  requireRole(actor, ["owner"]);
  const existing = await loadConnection(ctx.db, actor.workspaceId);
  const before = existing ? await readAccess(ctx, ctx.db, existing) : null;
  const user = input.user?.trim() || before?.user;
  const password = input.password || before?.password;
  if (!user) throw new ServiceError(400, "INVALID", "Bitte den Benutzernamen des DHL-Geschäftskundenportals eintragen.");
  if (!password) throw new ServiceError(400, "INVALID", "Bitte das Passwort des DHL-Geschäftskundenportals eintragen.");
  const ownKey = input.useTrackingKey ? undefined : input.apiKey?.trim() || before?.apiKey;
  const key = input.useTrackingKey ? await trackingKey(ctx, ctx.db, actor.workspaceId) : ownKey;
  if (!key) throw new ServiceError(400, "INVALID", input.useTrackingKey ? "Beim DHL-Sendungsstatus ist noch kein API-Key hinterlegt. Bitte dort eintragen oder hier einen eigenen API-Key angeben." : "Bitte den DHL-API-Key eintragen (DHL-Entwicklerportal, App mit „Parcel DE Returns“).");
  let receiverIds: Record<string, string>;
  if (!input.receiverGermany?.trim() && !input.receiverOthers?.trim() && existing) receiverIds = existing.receiver_ids;
  else {
    const parsed = parseReceiverIds(input.receiverGermany ?? "", input.receiverOthers ?? "");
    if (!parsed.ok) throw new ServiceError(400, "INVALID", parsed.error);
    receiverIds = parsed.ids;
  }
  const apiUrl = input.apiUrl?.trim() || null;
  const sandbox = !!input.sandbox;
  try {
    // Offline check: formats and endpoint allow-list, no call to DHL.
    new DhlReturnsClient({ apiKey: key, user, password, sandbox, apiUrl: apiUrl ?? undefined, allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS });
  } catch (error) {
    throw new ServiceError(400, "INVALID", (error as Error).message);
  }
  const access: StoredAccess = { user, password, ...(ownKey ? { apiKey: ownKey } : {}) };
  await withTx(ctx.db, async (tx) => {
    const secretId = await ctx.secrets.store(tx, actor.workspaceId, "dhl_returns", JSON.stringify(access));
    await tx.query(
      `INSERT INTO dhl_return_connections (workspace_id, secret_id, use_tracking_key, receiver_ids, sandbox, api_url) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id) DO UPDATE SET secret_id = EXCLUDED.secret_id, use_tracking_key = EXCLUDED.use_tracking_key, receiver_ids = EXCLUDED.receiver_ids,
         sandbox = EXCLUDED.sandbox, api_url = EXCLUDED.api_url, status = 'configured', last_error = NULL, last_checked_at = NULL, updated_at = now()`,
      [actor.workspaceId, secretId, input.useTrackingKey, JSON.stringify(receiverIds), sandbox, apiUrl],
    );
    if (existing) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, existing.secret_id]);
    await audit(tx, actor, existing ? "dhl_returns.changed" : "dhl_returns.connected", "workspace", actor.workspaceId, { countries: Object.keys(receiverIds), sandbox });
  });
}

export async function deleteDhlReturnConnection(ctx: AppContext, actor: Actor): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    const row = await loadConnection(tx, actor.workspaceId);
    if (!row) throw new ServiceError(404, "NOT_FOUND", "Kein DHL-Retourenzugang hinterlegt.");
    await tx.query("DELETE FROM dhl_return_connections WHERE workspace_id = $1", [actor.workspaceId]);
    await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.secret_id]);
    await audit(tx, actor, "dhl_returns.removed", "workspace", actor.workspaceId);
  });
}

/** Access check without making a label. */
export async function checkDhlReturnConnection(ctx: AppContext, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  requireRole(actor, ["owner"]);
  const row = await loadConnection(ctx.db, actor.workspaceId);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Kein DHL-Retourenzugang hinterlegt.");
  const result = await (await clientFor(ctx, ctx.db, row)).checkAccess();
  await ctx.db.query("UPDATE dhl_return_connections SET status = $2, last_error = $3, last_checked_at = now() WHERE workspace_id = $1", [actor.workspaceId, result.ok ? "ok" : "error", result.ok ? null : result.detail]);
  return result;
}

// ---------------------------------------------------------------------------
// In the case

export interface ReturnLabelInfo {
  id: string;
  shipmentNo: string;
  internationalShipmentNo: string | null;
  country: string;
  orderNumber: string | null;
  sandbox: boolean;
  createdAt: Date;
  file: CaseFileInfo | null;
}

async function labelsOf(q: Queryable, workspaceId: string, conversationId: string): Promise<ReturnLabelInfo[]> {
  const rows = await many<{ id: string; shipment_no: string; international_shipment_no: string | null; country: string; order_number: string | null; sandbox: boolean; created_at: Date; document_id: string | null }>(
    q,
    "SELECT id, shipment_no, international_shipment_no, country, order_number, sandbox, created_at, document_id FROM return_labels WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at",
    [workspaceId, conversationId],
  );
  const ids = rows.map((r) => r.document_id).filter((v): v is string => !!v);
  const files = ids.length
    ? await many<CaseFileInfo>(q, "SELECT id, name, size, content_type, source, for_next_reply, created_at FROM documents WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL", [workspaceId, ids])
    : [];
  return rows.map((r) => ({ id: r.id, shipmentNo: r.shipment_no, internationalShipmentNo: r.international_shipment_no, country: r.country, orderNumber: r.order_number, sandbox: r.sandbox, createdAt: r.created_at, file: files.find((f) => f.id === r.document_id) ?? null }));
}

async function caseKind(q: Queryable, workspaceId: string, conversationId: string): Promise<ChannelKind> {
  if (!UUID.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const conv = await one<{ kind: ChannelKind }>(q, "SELECT cc.kind FROM conversations c JOIN channel_connections cc ON cc.workspace_id = c.workspace_id AND cc.id = c.connection_id WHERE c.workspace_id = $1 AND c.id = $2", [workspaceId, conversationId]);
  if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  return conv.kind;
}

export interface CaseReturnLabels {
  /** False: no DHL return access in this workspace. */
  connected: boolean;
  sandbox: boolean;
  labels: ReturnLabelInfo[];
  replyFiles: { supported: boolean; note: string };
}

/** The case card: labels made so far (no call to DHL or the ERP). */
export async function caseReturnLabels(ctx: AppContext, actor: Actor, conversationId: string): Promise<CaseReturnLabels> {
  requireRole(actor, ["owner", "agent", "viewer"]);
  const kind = await caseKind(ctx.db, actor.workspaceId, conversationId);
  const row = await loadConnection(ctx.db, actor.workspaceId);
  return { connected: !!row, sandbox: !!row?.sandbox, labels: await labelsOf(ctx.db, actor.workspaceId, conversationId), replyFiles: REPLY_FILES[kind] };
}

interface CaseOrder {
  orderId: string;
  orderNumber: string;
}

async function caseOrder(ctx: AppContext, actor: Actor, conversationId: string): Promise<CaseOrder> {
  const link = await one<{ status: string; snapshot: OrderRecord | null }>(ctx.db, "SELECT status, snapshot FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [actor.workspaceId, conversationId]);
  if (!link || link.status !== "unique" || !link.snapshot) {
    const why = link?.status === "ambiguous" ? "Es passen mehrere Bestellungen." : link?.status === "pending" ? "Die Bestellung wird noch gesucht." : "Es ist keine Bestellung zugeordnet.";
    throw new ServiceError(409, "ORDER_NOT_UNIQUE", `${why} Bitte erst die richtige Bestellung zuordnen; die Adresse für das Label kommt aus der Bestellung.`);
  }
  return { orderId: link.snapshot.id, orderNumber: link.snapshot.orderNumberAtCustomer ?? link.snapshot.orderNumber ?? link.snapshot.id };
}

export interface ReturnLabelPreview {
  orderNumber: string;
  /** Read fresh from the ERP; null when the order has no usable address. */
  address: ReturnAddress | null;
  problems: string[];
  countries: Array<{ code: string; name: string; receiver: boolean }>;
  sandbox: boolean;
  labels: ReturnLabelInfo[];
  replyFiles: { supported: boolean; note: string };
}

/**
 * "Retourenlabel erstellen", step 1: the customer's address from the ERP (read only)
 * for the person to check. Nothing goes to DHL.
 */
export async function previewReturnLabel(ctx: AppContext, actor: Actor, conversationId: string): Promise<ReturnLabelPreview> {
  requireRole(actor, ["owner", "agent"]);
  const kind = await caseKind(ctx.db, actor.workspaceId, conversationId);
  const row = await loadConnection(ctx.db, actor.workspaceId);
  if (!row) throw new ServiceError(409, "NOT_CONNECTED", "DHL-Retourenlabel ist noch nicht eingerichtet (Einstellungen → Anbindungen → DHL-Retourenlabel).");
  const order = await caseOrder(ctx, actor, conversationId);
  const erp = await loadErpConnection(ctx.db, actor.workspaceId);
  if (!erp) throw new ServiceError(409, "NO_ERP", "Keine Warenwirtschaft verbunden.");
  const provider = await orderProviderFor(ctx, ctx.db, erp);
  if (!provider.returnAddress) throw new ServiceError(409, "NOT_SUPPORTED", "Diese Warenwirtschaft liefert keine Lieferadresse.");
  let address: ReturnAddress | null;
  try {
    address = await provider.returnAddress(order.orderId);
  } catch (error) {
    throw new ServiceError(502, "ERP_ERROR", `Die Adresse konnte nicht aus der Warenwirtschaft gelesen werden: ${(error as Error).message}`);
  }
  const check = address ? checkReturnAddress(address, { receiverIds: row.receiver_ids }) : { ok: false as const, problems: ["In der Bestellung steht keine Lieferadresse mit Straße und Ort."] };
  return {
    orderNumber: order.orderNumber,
    address,
    problems: check.ok ? [] : check.problems,
    countries: Object.entries(EU_COUNTRIES).map(([code, c]) => ({ code, name: c.name, receiver: !!row.receiver_ids[c.alpha3] })),
    sandbox: row.sandbox,
    labels: await labelsOf(ctx.db, actor.workspaceId, conversationId),
    replyFiles: REPLY_FILES[kind],
  };
}

export interface CreateReturnLabelInput {
  /** The address as the person checked (and maybe corrected) it in the dialog. */
  address: ReturnAddress;
  /** Put the PDF onto the open draft or the next reply. */
  attach: boolean;
  /** Required when the case already has a label: another one is made knowingly. */
  again?: boolean;
}

/**
 * "Retourenlabel erstellen", step 2, after the person confirmed: one label at DHL, the
 * PDF stored with the case and (on request) onto the reply. Every call makes a new
 * label at DHL, so the caller must be a person and a second label needs `again`.
 */
export async function createReturnLabel(ctx: AppContext, actor: Actor, conversationId: string, input: CreateReturnLabelInput): Promise<{ label: ReturnLabelInfo; draftId: string | null; attached: boolean }> {
  requireRole(actor, ["owner", "agent"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Retourenlabels erstellt nur eine Person per Klick.");
  const kind = await caseKind(ctx.db, actor.workspaceId, conversationId);
  const row = await loadConnection(ctx.db, actor.workspaceId);
  if (!row) throw new ServiceError(409, "NOT_CONNECTED", "DHL-Retourenlabel ist noch nicht eingerichtet (Einstellungen → Anbindungen → DHL-Retourenlabel).");
  const order = await caseOrder(ctx, actor, conversationId);
  if (input.attach && !REPLY_FILES[kind].supported) throw new ServiceError(409, "NOT_SUPPORTED", REPLY_FILES[kind].note);
  const check = checkReturnAddress(input.address, { receiverIds: row.receiver_ids });
  if (!check.ok) throw new ServiceError(400, "INVALID_ADDRESS", `Bitte die Adresse prüfen: ${check.problems.join(" ")}`);

  // No second label by a double click: an existing one is only followed by another knowingly.
  const recent = await one<{ shipment_no: string; created_at: Date }>(ctx.db, "SELECT shipment_no, created_at FROM return_labels WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1", [actor.workspaceId, conversationId]);
  if (recent && !input.again) throw new ServiceError(409, "LABEL_EXISTS", `Zu diesem Fall gibt es schon das Retourenlabel ${recent.shipment_no}. Ein weiteres Label nur erstellen, wenn der Kunde wirklich ein zweites braucht.`);
  if (recent && ctx.now().getTime() - new Date(recent.created_at).getTime() < 30_000) throw new ServiceError(409, "LABEL_EXISTS", `Das Retourenlabel ${recent.shipment_no} wurde gerade erst erstellt. Bitte kurz warten und die Liste prüfen.`);

  const client = await clientFor(ctx, ctx.db, row);
  let label: DhlReturnLabel;
  try {
    label = await client.createLabel({ receiverId: check.receiverId, shipper: check.shipper, customerReference: order.orderNumber });
  } catch (error) {
    const e = error as HttpError;
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      const detail = dhlReturnsAuthHint(e.message);
      await ctx.db.query("UPDATE dhl_return_connections SET status = 'error', last_error = $2, last_checked_at = now() WHERE workspace_id = $1", [actor.workspaceId, detail]);
      throw new ServiceError(502, "DHL_AUTH", detail);
    }
    await audit(ctx.db, actor, "return_label.failed", "conversation", conversationId, { status: e.status ?? null, uncertain: !!e.uncertain });
    if (e instanceof HttpError && e.uncertain) throw new ServiceError(502, "DHL_UNCERTAIN", `DHL hat nicht rechtzeitig geantwortet (${e.message}). Vielleicht wurde das Label trotzdem erstellt: bitte im DHL-Geschäftskundenportal unter Retouren nachsehen, bevor du es noch einmal versuchst.`);
    throw new ServiceError(502, "DHL_ERROR", `DHL hat kein Label erstellt: ${e.message}`);
  }

  return withTx(ctx.db, async (tx) => {
    await lockCaseForFiles(tx, actor, conversationId);
    const file = await storeCaseFile(tx, actor, conversationId, {
      name: `DHL-Retourenlabel ${label.shipmentNo}.pdf`,
      contentType: "application/pdf",
      data: label.pdf,
      source: "return_label",
      externalRef: label.shipmentNo,
    });
    const inserted = await one<{ id: string; created_at: Date }>(
      tx,
      `INSERT INTO return_labels (workspace_id, conversation_id, order_id, order_number, shipment_no, international_shipment_no, routing_code, country, shipper, document_id, sandbox, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, created_at`,
      [actor.workspaceId, conversationId, order.orderId, order.orderNumber, label.shipmentNo, label.internationalShipmentNo ?? null, label.routingCode ?? null, check.country, JSON.stringify(check.shipper), file.id, row.sandbox, actor.type === "user" ? actor.userId : null],
    );
    await audit(tx, actor, "return_label.created", "conversation", conversationId, { shipmentNo: label.shipmentNo, country: check.country, sandbox: row.sandbox, orderNumber: order.orderNumber });
    let draftId: string | null = null;
    let attached = false;
    if (input.attach) {
      try {
        draftId = (await attachStoredCaseFiles(tx, actor, conversationId, [file])).draftId;
        attached = true;
      } catch (error) {
        // The label exists at DHL either way; it stays with the case to attach by hand.
        if (!(error instanceof ServiceError)) throw error;
      }
    }
    const info: ReturnLabelInfo = { id: inserted!.id, shipmentNo: label.shipmentNo, internationalShipmentNo: label.internationalShipmentNo ?? null, country: check.country, orderNumber: order.orderNumber, sandbox: row.sandbox, createdAt: inserted!.created_at, file: { ...file, for_next_reply: attached && !draftId } };
    return { label: info, draftId, attached };
  });
}

/** "An Antwort anhängen" for a label made earlier. */
export async function attachReturnLabel(ctx: AppContext, actor: Actor, conversationId: string, labelId: string): Promise<{ draftId: string | null }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(labelId)) throw new ServiceError(404, "NOT_FOUND", "Label nicht gefunden.");
  const kind = await caseKind(ctx.db, actor.workspaceId, conversationId);
  if (!REPLY_FILES[kind].supported) throw new ServiceError(409, "NOT_SUPPORTED", REPLY_FILES[kind].note);
  return withTx(ctx.db, async (tx) => {
    await lockCaseForFiles(tx, actor, conversationId);
    const file = await one<CaseFileInfo>(
      tx,
      `SELECT d.id, d.name, d.size, d.content_type, d.source, d.for_next_reply, d.created_at FROM return_labels l
         JOIN documents d ON d.workspace_id = l.workspace_id AND d.id = l.document_id AND d.deleted_at IS NULL
        WHERE l.workspace_id = $1 AND l.conversation_id = $2 AND l.id = $3`,
      [actor.workspaceId, conversationId, labelId],
    );
    if (!file) throw new ServiceError(404, "NOT_FOUND", "Label nicht gefunden.");
    const result = await attachStoredCaseFiles(tx, actor, conversationId, [file]);
    await audit(tx, actor, "return_label.attached", "conversation", conversationId, { labelId });
    return result;
  });
}
