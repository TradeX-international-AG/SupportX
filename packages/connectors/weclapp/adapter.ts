import type {
  CallerCheckData,
  CreditNoteDraftInput,
  CreditNoteDraftResult,
  CreditSourceInvoice,
  InvoiceFact,
  OrderLineFact,
  OrderLookupResult,
  OrderProvider,
  OrderRecord,
  OrderScopeRule,
  ParcelFact,
  ReferenceQuery,
  ReturnFact,
  ShipmentFact,
} from "../../core/contracts.ts";
import { trackingHref } from "../../core/tracking.ts";
import { assertAllowedEndpoint, HttpError, requestBinary, requestJson } from "../http.ts";

/**
 * Read-only weclapp REST API v2 adapter (sole OrderProvider in v1).
 *
 * Field names follow the official v2 OpenAPI specification
 * (https://www.weclapp.com/api/openapi_v2.yaml, reviewed 2026-10-21 via the
 * generated v2 model documentation): salesOrder.orderNumber /
 * orderNumberAtCustomer / orderItems / salesChannel / ecommerceOrder,
 * shipment.parcels[].trackingId / trackingUrl (packageTracking* is deprecated),
 * shipment.shipmentItems[].salesOrderItemId, shipment.mainSalesOrderId and
 * salesInvoice.salesOrderId. The exact mapping of marketplace order numbers to
 * these fields must be confirmed against the operator's tenant (M0 data check).
 *
 * The adapter issues GET requests, with one exception: createCreditNoteDraft,
 * called only after a person confirmed a credit note in the case and the owner
 * switched credit notes on. It never books (no open item). It never creates, rotates or replaces
 * the API token: per weclapp documentation, generating a new token can
 * invalidate the user's previous tokens and break existing integrations.
 */
export interface WeclappConfig {
  /** e.g. https://<tenant>.weclapp.com/webapp/api/v2 */
  baseUrl: string;
  apiToken: string;
  searchFields: ReadonlyArray<string>;
  timeoutMs?: number;
  allowTestEndpoints?: boolean;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

const SEARCHABLE = new Set(["orderNumberAtCustomer", "orderNumber", "ecommerceOrder.ecommerceId"]);

function str(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** weclapp timestamps are epoch milliseconds. */
function isoDate(value: unknown): string | undefined {
  const n = num(value);
  return n === undefined ? undefined : new Date(n).toISOString();
}

function arr(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Json[]) : [];
}

/** Sum of grossAmount over shipping cost items; undefined when the record has no such list. */
function shippingGross(record: Json): number | undefined {
  if (!Array.isArray(record.shippingCostItems)) return undefined;
  return arr(record.shippingCostItems).reduce((sum, item) => sum + (num(item.grossAmount) ?? 0), 0);
}

export function validateWeclappBaseUrl(baseUrl: string, allowTestEndpoints: boolean): string {
  const url = assertAllowedEndpoint(baseUrl, allowTestEndpoints, (u) => u.hostname.endsWith(".weclapp.com"));
  const normalized = url.toString().replace(/\/+$/, "");
  if (!allowTestEndpoints && !normalized.endsWith("/webapp/api/v2")) {
    throw new Error("Die weclapp-URL muss auf /webapp/api/v2 enden (REST API v2).");
  }
  return normalized;
}

export function scopeMatches(order: Json, scope: OrderScopeRule): boolean {
  switch (scope.field) {
    case "none":
      return true;
    case "salesChannel":
      return str(order.salesChannel) === scope.value;
    case "customerId":
      return str(order.customerId) === scope.value;
    case "ecommerceConnectionId":
      return str((order.ecommerceOrder as Json | undefined)?.externalConnectionId) === scope.value;
    case "tag":
      return Array.isArray(order.tags) && order.tags.map(String).includes(scope.value);
  }
}

/**
 * A weight in kg, or undefined when unset or not positive. weclapp sends weights
 * as decimal strings in kg (article: articleGrossWeight / articleNetWeight;
 * shipment: packageWeight). The parcel field name in API v2 is not confirmed on a
 * live tenant yet, so `weight` and `packageWeight` are both read.
 */
export function kg(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n > 0 && n < 10_000 ? n : undefined;
}

function mapParcels(shipment: Json): ParcelFact[] {
  const parcels: ParcelFact[] = arr(shipment.parcels).map((p) => {
    const weightKg = kg(p.weight) ?? kg(p.packageWeight);
    return {
      id: str(p.id),
      trackingId: str(p.trackingId),
      trackingUrl: trackingHref(str(p.trackingUrl), str(p.trackingId)),
      carrierId: str(p.shippingCarrierId),
      reference: str(p.reference),
      source: "parcels" as const,
      ...(weightKg !== undefined ? { weightKg } : {}),
    };
  });
  // Deprecated single-package fields are only used when no parcel list exists,
  // and are labelled as such. Several parcels are never collapsed into one.
  if (parcels.length === 0 && (str(shipment.packageTrackingNumber) || str(shipment.packageTrackingUrl))) {
    parcels.push({
      trackingId: str(shipment.packageTrackingNumber),
      trackingUrl: trackingHref(str(shipment.packageTrackingUrl), str(shipment.packageTrackingNumber)),
      carrierId: str(shipment.shippingCarrierId),
      source: "legacy_package_tracking",
    });
  }
  return parcels.filter((p) => p.trackingId || p.trackingUrl || p.id || p.weightKg !== undefined);
}

export function mapShipment(shipment: Json, linesById: Map<string, OrderLineFact>): ShipmentFact {
  const history = arr(shipment.statusHistory)
    .map((h) => ({ status: str(h.status) ?? "UNKNOWN", at: isoDate(h.statusDate) }))
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const status = str(shipment.status);
  const statusAt = [...history].reverse().find((h) => h.status === status)?.at;
  const recipient = shipment.recipientAddress && typeof shipment.recipientAddress === "object" ? (shipment.recipientAddress as Json) : {};
  const zip = str(recipient.zipcode);
  return {
    id: String(shipment.id),
    shipmentNumber: str(shipment.shipmentNumber),
    erpStatus: status,
    erpStatusAt: statusAt,
    statusHistory: history,
    shippingDate: isoDate(shipment.shippingDate),
    deliveryDate: isoDate(shipment.deliveryDate),
    items: arr(shipment.shipmentItems).map((item) => {
      const lineId = str(item.salesOrderItemId);
      return {
        orderLineId: lineId,
        title: str(item.title) ?? (lineId ? linesById.get(lineId)?.title : undefined),
        quantity: num(item.quantity) ?? 0,
      };
    }),
    parcels: mapParcels(shipment),
    ...(kg(shipment.packageWeight) !== undefined ? { weightKg: kg(shipment.packageWeight) } : {}),
    ...(num(shipment.shippingReturnLabelsCount) ? { returnLabels: num(shipment.shippingReturnLabelsCount) } : {}),
    ...(zip ? { recipientPostalCode: zip } : {}),
  };
}

/**
 * A customer return (weclapp incomingGoods of type CUSTOMER_RETURN, created e.g.
 * via salesOrder/createCustomerReturn). Reason names are resolved from
 * shipmentReturnReason when available; the free return description is a fallback.
 */
export function mapReturn(record: Json, linesById: Map<string, OrderLineFact>, reasonNames: Map<string, string> = new Map()): ReturnFact {
  const history = arr(record.statusHistory)
    .map((h) => ({ status: str(h.status) ?? "UNKNOWN", at: isoDate(h.statusDate) }))
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const status = str(record.status);
  return {
    id: String(record.id),
    returnNumber: str(record.incomingGoodsNumber),
    erpStatus: status,
    erpStatusAt: [...history].reverse().find((h) => h.status === status)?.at,
    createdAt: isoDate(record.createdDate),
    statusHistory: history,
    items: arr(record.incomingGoodsItems).map((item) => {
      const lineId = str(item.salesOrderItemId);
      const articleId = str(item.articleId);
      const reasonIds = [str(item.returnReasonId), ...arr(item.returnReasons).map((r) => str(r.id))].filter((v): v is string => !!v);
      const reasons = [...new Set(reasonIds.map((r) => reasonNames.get(r)).filter((v): v is string => !!v))];
      const reason = reasons.length ? reasons.join(", ") : str(item.returnDescription);
      return {
        orderLineId: lineId,
        ...(articleId ? { articleId } : {}),
        title: str(item.title) ?? (lineId ? linesById.get(lineId)?.title : undefined),
        quantity: num(item.quantity) ?? 0,
        ...(reason ? { reason } : {}),
      };
    }),
  };
}

export interface ReturnsRead {
  records: Json[];
  reasonNames?: Map<string, string>;
  error?: string;
}

export function mapOrder(order: Json, shipments: Json[], invoices: Json[], retrievedAt: string, articles: Json[] = [], returns?: ReturnsRead, weightsRead = true, currency?: string): OrderRecord {
  const articlesById = new Map(articles.map((a) => [String(a.id), a]));
  const lines: OrderLineFact[] = arr(order.orderItems).map((item, i) => {
    const article = articlesById.get(str(item.articleId) ?? "");
    const grossWeightKg = kg(article?.articleGrossWeight);
    const netWeightKg = kg(article?.articleNetWeight);
    return {
      id: String(item.id ?? `line-${i + 1}`),
      position: num(item.positionNumber),
      title: str(item.title) ?? str(item.description) ?? "Artikel",
      articleId: str(item.articleId),
      articleNumber: str(item.articleNumber) ?? str(article?.articleNumber),
      articleName: str(article?.name),
      quantity: num(item.quantity) ?? 0,
      shippedQuantity: num(item.shippedQuantity),
      returnedQuantity: num(item.returnedQuantity),
      ...(num(item.grossAmount) !== undefined ? { grossAmount: num(item.grossAmount) } : {}),
      ...(grossWeightKg !== undefined ? { grossWeightKg } : {}),
      ...(netWeightKg !== undefined ? { netWeightKg } : {}),
    };
  });
  const linesById = new Map(lines.map((l) => [l.id, l]));
  const invoiceFacts: InvoiceFact[] = invoices.map((inv) => ({
    id: String(inv.id),
    invoiceNumber: str(inv.invoiceNumber),
    invoiceDate: isoDate(inv.invoiceDate),
    status: str(inv.status),
    paymentStatus: str(inv.paymentStatus),
    type: str(inv.salesInvoiceType),
    ...(num(inv.grossAmount) !== undefined ? { grossAmount: num(inv.grossAmount) } : {}),
    ...(shippingGross(inv) !== undefined ? { shippingGrossAmount: shippingGross(inv) } : {}),
  }));
  const grossAmount = num(order.grossAmount);
  const shippingGrossAmount = shippingGross(order);
  return {
    provider: "weclapp",
    id: String(order.id),
    orderNumber: str(order.orderNumber),
    orderNumberAtCustomer: str(order.orderNumberAtCustomer),
    orderDate: isoDate(order.orderDate),
    status: str(order.status),
    salesChannel: str(order.salesChannel),
    ecommerceConnectionId: str((order.ecommerceOrder as Json | undefined)?.externalConnectionId),
    customerId: str(order.customerId),
    tags: Array.isArray(order.tags) ? order.tags.map(String) : [],
    lines,
    shipments: shipments
      .map((s) => mapShipment(s, linesById))
      .sort((a, b) => (a.shippingDate ?? a.shipmentNumber ?? "").localeCompare(b.shippingDate ?? b.shipmentNumber ?? "")),
    invoices: invoiceFacts,
    ...(returns
      ? {
          returns: returns.records
            .map((r) => mapReturn(r, linesById, returns.reasonNames))
            .sort((a, b) => (a.createdAt ?? a.returnNumber ?? "").localeCompare(b.createdAt ?? b.returnNumber ?? "")),
          ...(returns.error ? { returnsError: returns.error } : {}),
        }
      : {}),
    ...(grossAmount !== undefined ? { grossAmount } : {}),
    ...(shippingGrossAmount !== undefined ? { shippingGrossAmount } : {}),
    ...(currency ? { currency } : {}),
    // Amounts count as read when the order carries its total; shipping may be absent (free shipping).
    ...(grossAmount !== undefined ? { amountsRead: true } : {}),
    ...(weightsRead ? { weightsRead: true } : {}),
    retrievedAt,
  };
}

function belongsToOrder(shipment: Json, orderId: string): boolean {
  return str(shipment.mainSalesOrderId) === orderId || arr(shipment.salesOrders).some((o) => str(o.id) === orderId);
}

/** Sales orders an invoice or shipment belongs to. */
function orderIdsOf(record: Json): string[] {
  return [str(record.salesOrderId), str(record.mainSalesOrderId), ...arr(record.salesOrders).map((o) => str(o.id))].filter((id): id is string => !!id);
}

/** One address list as weclapp writes it ("a@x.de; b@y.de" or comma separated). */
function splitAddresses(value: unknown): string[] {
  return (str(value) ?? "").split(/[;,]/).map((a) => a.trim()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
}

/**
 * Caller check data from a salesOrder (OpenAPI: invoiceAddress, deliveryAddress,
 * recordAddress with zipcode and lastName; salesInvoiceEmailAddresses and
 * recordEmailAddresses with toAddresses). Invoices go to the invoice addresses when
 * weclapp has some, else to the record addresses.
 */
export function mapCallerCheck(order: Json, shipments: Json[] = []): CallerCheckData {
  const addresses = ["invoiceAddress", "deliveryAddress", "recordAddress"]
    .map((k) => order[k])
    .filter((a): a is Json => !!a && typeof a === "object");
  const recipients = shipments.map((s) => s.recipientAddress).filter((a): a is Json => !!a && typeof a === "object");
  const all = [...addresses, ...recipients];
  const uniq = (values: Array<string | undefined>) => [...new Set(values.filter((v): v is string => !!v))];
  const mails = (k: string) => {
    const box = order[k];
    return box && typeof box === "object" ? splitAddresses((box as Json).toAddresses) : [];
  };
  const invoice = mails("salesInvoiceEmailAddresses");
  return {
    postalCodes: uniq(all.map((a) => str(a.zipcode))),
    lastNames: uniq(all.map((a) => str(a.lastName))),
    invoiceEmails: [...new Set(invoice.length ? invoice : mails("recordEmailAddresses"))],
  };
}

/** Sales channel names per weclapp tenant (key → name), see #salesChannelName. */
const CHANNEL_NAMES = new Map<string, { until: number; names: Map<string, string> }>();

export class WeclappOrderProvider implements OrderProvider {
  readonly kind = "weclapp" as const;
  readonly #config: WeclappConfig;
  readonly #baseUrl: string;

  constructor(config: WeclappConfig) {
    this.#config = config;
    this.#baseUrl = validateWeclappBaseUrl(config.baseUrl, config.allowTestEndpoints ?? false);
    const unsupported = config.searchFields.filter((f) => !SEARCHABLE.has(f));
    if (unsupported.length > 0) throw new Error(`Nicht unterstützte weclapp-Suchfelder: ${unsupported.join(", ")}`);
  }

  async #get(resource: string, params: Record<string, string>): Promise<Json[]> {
    const url = new URL(`${this.#baseUrl}/${resource}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const body = await requestJson(url, {
      method: "GET",
      headers: { AuthenticationToken: this.#config.apiToken, Accept: "application/json" },
      timeoutMs: this.#config.timeoutMs ?? 15_000,
      fetchImpl: this.#config.fetchImpl,
    });
    const result = (body as Json | null)?.result;
    if (!Array.isArray(result)) throw new HttpError("Unerwartete weclapp-Antwort (kein result-Array).", 0, false);
    return result as Json[];
  }

  /**
   * Like #get, but a filter the tenant rejects (HTTP 400, e.g. "unexpected filter
   * property") yields no rows and is remembered in `rejected`, so one unknown
   * field does not break the whole lookup.
   */
  async #tryGet(resource: string, params: Record<string, string>, rejected: string[]): Promise<Json[]> {
    try {
      return await this.#get(resource, params);
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) {
        rejected.push(`${resource}?${Object.keys(params).filter((k) => k !== "pageSize").join("&")}`);
        return [];
      }
      throw error;
    }
  }

  async #enrich(order: Json): Promise<OrderRecord> {
    const id = String(order.id);
    const rejected: string[] = [];
    // salesInvoice.salesOrderId is not filterable in API v2 (OpenAPI: filterable false);
    // salesOrders.id is. The old filter is kept for tenants that still accept it, and
    // the marketplace order number as a last resort. Every hit is checked again here.
    const atCustomer = str(order.orderNumberAtCustomer);
    const [shipments, ...invoiceLists] = await Promise.all([
      this.#tryGet("shipment", { "mainSalesOrderId-eq": id, pageSize: "100" }, rejected),
      this.#tryGet("salesInvoice", { "salesOrders.id-eq": id, pageSize: "100" }, rejected),
      this.#tryGet("salesInvoice", { "salesOrderId-eq": id, pageSize: "100" }, rejected),
      ...(atCustomer ? [this.#tryGet("salesInvoice", { "orderNumberAtCustomer-eq": atCustomer, pageSize: "20" }, rejected)] : []),
    ]);
    const invoices = new Map<string, Json>();
    for (const inv of invoiceLists.flat()) {
      const orderIds = orderIdsOf(inv);
      const mine = orderIds.length ? orderIds.includes(id) : !!atCustomer && str(inv.orderNumberAtCustomer) === atCustomer;
      if (mine) invoices.set(String(inv.id), inv);
    }
    if (rejected.length) console.warn(`[weclapp] Filter abgelehnt, Daten fehlen evtl. am Auftrag: ${rejected.join(", ")}`);
    const ownShipments = shipments.filter((s) => belongsToOrder(s, id));
    const [articles, returns, currency, channelName] = await Promise.all([
      this.#articles(order), this.#returns(order, ownShipments), this.#currency(str(order.recordCurrencyId)), this.#salesChannelName(str(order.salesChannel)),
    ]);
    // Weights count as read only when every linked article could be read.
    const record = mapOrder(order, ownShipments, [...invoices.values()], new Date().toISOString(), articles.rows, returns, !articles.failed, currency);
    return channelName ? { ...record, salesChannelName: channelName } : record;
  }

  /**
   * Customer returns of the order: incomingGoods of type CUSTOMER_RETURN, found via
   * salesOrders.id and, as a fallback, via the outgoing shipment they refer to.
   * Every hit is checked again on the record (order, shipment or order line).
   * Never fails the order lookup: missing rights or a refused filter only set `error`.
   */
  async #returns(order: Json, shipments: Json[]): Promise<ReturnsRead> {
    const id = String(order.id);
    const lineIds = new Set(arr(order.orderItems).map((item) => str(item.id)).filter((v): v is string => !!v));
    const shipmentIds = new Set(shipments.map((s) => String(s.id)));
    const rejected: string[] = [];
    try {
      const lists = await Promise.all([
        this.#tryGet("incomingGoods", { "salesOrders.id-eq": id, pageSize: "50" }, rejected),
        ...[...shipmentIds].slice(0, 10).map((shipmentId) => this.#tryGet("incomingGoods", { "relatedShipmentId-eq": shipmentId, pageSize: "50" }, rejected)),
      ]);
      const found = new Map<string, Json>();
      for (const row of lists.flat()) {
        if (str(row.incomingGoodsType) !== "CUSTOMER_RETURN") continue;
        const mine =
          arr(row.salesOrders).some((o) => str(o.id) === id) ||
          shipmentIds.has(str(row.relatedShipmentId) ?? "") ||
          arr(row.incomingGoodsItems).some((item) => lineIds.has(str(item.salesOrderItemId) ?? ""));
        if (mine) found.set(String(row.id), row);
      }
      const allRefused = rejected.length > 0 && rejected.length >= lists.length;
      const error = allRefused ? `weclapp lehnt die Abfrage der Retouren ab (${rejected.join(", ")}).` : undefined;
      return { records: [...found.values()], reasonNames: found.size ? await this.#returnReasons() : new Map(), ...(error ? { error } : {}) };
    } catch (error) {
      const detail = error instanceof HttpError && (error.status === 401 || error.status === 403)
        ? "Der weclapp-Benutzer darf Wareneingänge (Retouren) nicht lesen."
        : `Retouren konnten nicht gelesen werden: ${(error as Error).message}`;
      return { records: [], error: detail };
    }
  }

  /**
   * Name the merchant gave the order's sales channel in weclapp (e.g. NET3 → "DocMorris"),
   * from GET /salesChannel/activeSalesChannels ({ key, name }). Read once per tenant and
   * kept for 10 minutes. Best effort: a failure only drops the name.
   */
  async #salesChannelName(key: string | undefined): Promise<string | undefined> {
    if (!key) return undefined;
    const cacheKey = `${this.#baseUrl}|${this.#config.apiToken}`;
    let entry = CHANNEL_NAMES.get(cacheKey);
    if (!entry || entry.until < Date.now()) {
      try {
        const rows = await this.#get("salesChannel/activeSalesChannels", {});
        entry = { until: Date.now() + 10 * 60_000, names: new Map(rows.map((r) => [str(r.key) ?? "", str(r.name) ?? ""] as [string, string]).filter(([k, n]) => k && n)) };
      } catch {
        entry = { until: Date.now() + 60_000, names: new Map() };
      }
      CHANNEL_NAMES.set(cacheKey, entry);
    }
    const name = entry.names.get(key);
    return name && name !== key ? name : undefined;
  }

  /** Name of the order currency (e.g. "EUR"). Best effort: a failure only drops the currency label. */
  async #currency(currencyId: string | undefined): Promise<string | undefined> {
    if (!currencyId) return undefined;
    try {
      const row = (await this.#get("currency", { "id-eq": currencyId, pageSize: "1" })).find((c) => String(c.id) === currencyId);
      return str(row?.name);
    } catch {
      return undefined;
    }
  }

  /** Names of the return reasons configured in weclapp. Best effort: a failure only drops the names. */
  async #returnReasons(): Promise<Map<string, string>> {
    try {
      const rows = await this.#get("shipmentReturnReason", { pageSize: "200" });
      return new Map(rows.map((r) => [String(r.id), str(r.name) ?? ""]).filter(([, name]) => !!name) as Array<[string, string]>);
    } catch {
      return new Map();
    }
  }

  /** Linked articles, for comparing the order title and the weight with the ERP article. Best effort: a failure only drops the comparison. */
  async #articles(order: Json): Promise<{ rows: Json[]; failed: boolean }> {
    const all = [...new Set(arr(order.orderItems).map((item) => str(item.articleId)).filter((v): v is string => !!v))];
    const ids = all.slice(0, 20);
    const rows = await Promise.all(
      ids.map(async (articleId) => {
        try {
          return (await this.#get("article", { "id-eq": articleId, pageSize: "1" })).find((a) => String(a.id) === articleId) ?? null;
        } catch {
          return undefined;
        }
      }),
    );
    return { rows: rows.filter((a): a is Json => !!a), failed: all.length > ids.length || rows.some((a) => a === undefined) };
  }

  /**
   * Exact lookups only: order numbers in the configured salesOrder fields,
   * invoice numbers in salesInvoice.invoiceNumber, parcel numbers in the
   * shipment's parcels. Every hit is compared again on the returned record.
   */
  async findOrders(references: ReadonlyArray<ReferenceQuery>, scope: OrderScopeRule): Promise<OrderLookupResult> {
    if (references.length === 0) return { status: "missing", triedReferences: [] };
    try {
      const found = new Map<string, { order: Json; matchedBy: string }>();
      const rejected: string[] = [];
      let tried = 0;
      let outOfScope = 0;
      const consider = (row: Json, matchedBy: string) => {
        if (!scopeMatches(row, scope)) {
          outOfScope++;
          return;
        }
        const id = String(row.id);
        if (!found.has(id)) found.set(id, { order: row, matchedBy });
      };
      const viaOrderIds = async (orderIds: Iterable<string>, matchedBy: string) => {
        for (const orderId of new Set(orderIds)) {
          const row = (await this.#tryGet("salesOrder", { "id-eq": orderId, pageSize: "1" }, rejected)).find((r) => String(r.id) === orderId);
          if (row) consider(row, matchedBy);
        }
      };
      for (const { value, kind } of references) {
        if (kind === "order") {
          for (const field of this.#config.searchFields) {
            tried++;
            const rows = await this.#tryGet("salesOrder", { [`${field}-eq`]: value, pageSize: "20" }, rejected);
            for (const row of rows) {
              // Exact comparison on the returned record; never trust a fuzzy server match.
              const actual = field === "ecommerceOrder.ecommerceId" ? str((row.ecommerceOrder as Json | undefined)?.ecommerceId) : str(row[field]);
              if (actual === value) consider(row, `${field}=${value}`);
            }
          }
        } else if (kind === "invoice") {
          tried++;
          const invoices = (await this.#tryGet("salesInvoice", { "invoiceNumber-eq": value, pageSize: "20" }, rejected)).filter((inv) => str(inv.invoiceNumber) === value);
          await viaOrderIds(invoices.flatMap(orderIdsOf), `Rechnungsnummer=${value}`);
        } else {
          const shipments = await this.#shipmentsByTracking(value);
          await viaOrderIds(shipments.flatMap(orderIdsOf), `Sendungsnummer=${value}`);
        }
      }
      if (rejected.length) console.warn(`[weclapp] Filter abgelehnt: ${rejected.join(", ")}`);
      if (found.size === 0 && tried > 0 && rejected.length >= tried) {
        return { status: "error", error: `weclapp lehnt die Suchfilter ab (${rejected.join(", ")}). Bitte die Suchfelder unter Einstellungen → weclapp prüfen.`, retryable: false };
      }
      if (found.size === 0) {
        return { status: "missing", triedReferences: [...new Set(references.map((r) => r.value))], ...(outOfScope > 0 ? { outOfScopeMatches: outOfScope } : {}), ...(rejected.length ? { rejectedFilters: rejected } : {}) };
      }
      if (found.size > 1) {
        return {
          status: "ambiguous",
          candidates: [...found.values()].map(({ order, matchedBy }) => ({ id: String(order.id), orderNumber: str(order.orderNumber), matchedBy })),
        };
      }
      const [{ order, matchedBy }] = [...found.values()] as [{ order: Json; matchedBy: string }];
      return { status: "unique", order: await this.#enrich(order), matchedBy };
    } catch (error) {
      return toLookupError(error);
    }
  }

  /**
   * Parcel numbers live in shipment.parcels[].trackingId (older tenants:
   * packageTrackingNumber). A filter the tenant does not accept (HTTP 400) is
   * skipped, the other one still runs.
   */
  async #shipmentsByTracking(trackingId: string): Promise<Json[]> {
    const rows: Json[] = [];
    for (const filter of ["parcels.trackingId-eq", "packageTrackingNumber-eq"]) {
      try {
        rows.push(...(await this.#get("shipment", { [filter]: trackingId, pageSize: "20" })));
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) continue;
        throw error;
      }
    }
    const norm = (v: string | undefined) => v?.replace(/\s+/g, "").toUpperCase();
    const wanted = norm(trackingId);
    const seen = new Set<string>();
    return rows.filter((s) => {
      const hit = arr(s.parcels).some((p) => norm(str(p.trackingId)) === wanted) || norm(str(s.packageTrackingNumber)) === wanted;
      if (!hit || seen.has(String(s.id))) return false;
      seen.add(String(s.id));
      return true;
    });
  }

  async getOrder(orderId: string, scope: OrderScopeRule): Promise<OrderLookupResult> {
    try {
      const rows = await this.#get("salesOrder", { "id-eq": orderId, pageSize: "1" });
      const row = rows.find((r) => String(r.id) === orderId);
      if (!row || !scopeMatches(row, scope)) return { status: "missing", triedReferences: [orderId] };
      return { status: "unique", order: await this.#enrich(row), matchedBy: `id=${orderId}` };
    } catch (error) {
      return toLookupError(error);
    }
  }

  /** GET only: the order's addresses for the phone hotline's caller check. */
  async callerCheck(orderId: string): Promise<CallerCheckData> {
    const row = (await this.#get("salesOrder", { "id-eq": orderId, pageSize: "1" })).find((r) => String(r.id) === orderId);
    if (!row) throw new Error("Auftrag nicht gefunden.");
    const shipments = await this.#get("shipment", { "mainSalesOrderId-eq": orderId, pageSize: "20" }).catch(() => [] as Json[]);
    return mapCallerCheck(row, shipments);
  }

  /** GET only: weclapp renders the latest invoice document; nothing is created or changed. */
  async downloadInvoicePdf(invoiceId: string): Promise<{ data: Buffer; contentType: string }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(invoiceId)) throw new Error("Ungültige Rechnungs-ID.");
    const url = new URL(`${this.#baseUrl}/salesInvoice/id/${encodeURIComponent(invoiceId)}/downloadLatestSalesInvoicePdf`);
    const file = await requestBinary(url, {
      headers: { AuthenticationToken: this.#config.apiToken, Accept: "application/pdf" },
      timeoutMs: this.#config.timeoutMs ?? 30_000,
      fetchImpl: this.#config.fetchImpl,
      maxBytes: 10 * 1024 * 1024,
    });
    return { data: file.data, contentType: file.contentType };
  }

  async #call(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Json> {
    const res = await requestJson(new URL(`${this.#baseUrl}/${path}`), {
      method,
      headers: { AuthenticationToken: this.#config.apiToken, Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.#config.timeoutMs ?? 30_000,
      fetchImpl: this.#config.fetchImpl,
    });
    if (!res || typeof res !== "object") throw new HttpError("Unerwartete weclapp-Antwort.", 0, false);
    return res as Json;
  }

  /** The invoice with its lines and article numbers (GET only). */
  async getInvoiceForCredit(invoiceId: string): Promise<CreditSourceInvoice> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(invoiceId)) throw new Error("Ungültige Rechnungs-ID.");
    const inv = await this.#call("GET", `salesInvoice/id/${encodeURIComponent(invoiceId)}`);
    const items = arr(inv.salesInvoiceItems);
    const { rows: articles } = await this.#articles({ orderItems: items });
    const byId = new Map(articles.map((a) => [String(a.id), a]));
    const shippingGrossCents = arr(inv.shippingCostItems).reduce((sum, i) => sum + cents(i.grossAmount), 0);
    return {
      id: String(inv.id ?? invoiceId),
      invoiceNumber: str(inv.invoiceNumber),
      status: str(inv.status),
      type: str(inv.salesInvoiceType),
      currency: await this.#currency(str(inv.recordCurrencyId)),
      // Without a total on the record: the lines plus shipping.
      grossCents: num(inv.grossAmount) !== undefined ? cents(inv.grossAmount) : items.reduce((sum, i) => sum + cents(i.grossAmount), 0) + shippingGrossCents,
      shippingGrossCents,
      items: items.map((i, n) => ({
        id: String(i.id ?? `item-${n + 1}`),
        title: str(i.title) ?? str(i.description) ?? "Artikel",
        articleNumber: str(i.articleNumber) ?? str(byId.get(str(i.articleId) ?? "")?.articleNumber),
        quantity: num(i.quantity) ?? 0,
        grossCents: cents(i.grossAmount),
      })),
    };
  }

  /**
   * POST salesInvoice/id/{id}/createCreditNote with the chosen invoice items
   * (weclapp creates the credit note in status NEW, nothing is booked), then sets
   * the amounts: each line's unit price is scaled so its gross equals the
   * requested gross, shipping cost items likewise (0 removes them). The update
   * is a full replace with the fresh entity, as weclapp requires.
   * A timeout on the POST is uncertain (a draft may exist).
   */
  async createCreditNoteDraft(invoiceId: string, input: CreditNoteDraftInput): Promise<CreditNoteDraftResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(invoiceId)) throw new Error("Ungültige Rechnungs-ID.");
    const created = await this.#call("POST", `salesInvoice/id/${encodeURIComponent(invoiceId)}/createCreditNote`, { itemIds: input.lines.map((l) => l.itemId) });
    const note = (created.result && typeof created.result === "object" ? created.result : created) as Json;
    const id = str(note.id);
    if (!id) throw new HttpError("weclapp hat die Gutschrift angelegt, aber keine ID genannt. Bitte in weclapp nachsehen.", 0, false, true);
    const base = { id, number: str(note.invoiceNumber), status: str(note.status) };
    try {
      // Fresh, full entity: weclapp replaces the whole record on PUT.
      const fresh = await this.#call("GET", `salesInvoice/id/${encodeURIComponent(id)}`);
      const wanted = new Map(input.lines.map((l) => [l.itemId, l.grossCents]));
      const items = arr(fresh.salesInvoiceItems).map((item) => {
        const source = str(item.creditedInvoiceItemId);
        const target = source ? wanted.get(source) : undefined;
        return target === undefined ? item : scaleLine(item, target);
      });
      const shipping = input.shippingGrossCents > 0 ? scaleShipping(arr(fresh.shippingCostItems), input.shippingGrossCents) : [];
      const updated = await this.#call("PUT", `salesInvoice/id/${encodeURIComponent(id)}`, { ...fresh, salesInvoiceItems: items, shippingCostItems: shipping });
      return { ...base, number: str(updated.invoiceNumber) ?? base.number, status: str(updated.status) ?? base.status, grossCents: cents(updated.grossAmount), adjusted: true };
    } catch (error) {
      return { ...base, grossCents: cents(note.grossAmount), adjusted: false, adjustError: (error as Error).message };
    }
  }

  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#get("salesOrder", { pageSize: "1" });
      return { ok: true, detail: "Lesender Zugriff auf salesOrder erfolgreich." };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

function cents(value: unknown): number {
  const n = num(value);
  return n === undefined ? 0 : Math.round(n * 100);
}

/** Unit price scaled so the line's gross becomes `targetCents` (works for net and gross price entry). */
function scaleLine(item: Json, targetCents: number): Json {
  const gross = cents(item.grossAmount);
  const unit = num(item.unitPrice);
  if (!gross || unit === undefined) throw new Error(`Position „${str(item.title) ?? ""}“: weclapp nennt keinen Betrag, Gutschrift bitte in weclapp anpassen.`);
  if (targetCents === gross) return item;
  return { ...item, unitPrice: (Math.round(unit * (targetCents / gross) * 10_000) / 10_000).toFixed(4), manualUnitPrice: true };
}

/** Shipping cost items scaled to a total gross of `targetCents`. */
function scaleShipping(items: Json[], targetCents: number): Json[] {
  const total = items.reduce((sum, i) => sum + cents(i.grossAmount), 0);
  if (!total) throw new Error("Die Gutschrift hat keine Versandkosten-Position, Versand bitte in weclapp ergänzen.");
  if (targetCents === total) return items;
  return items.map((i) => {
    const unit = num(i.unitPrice) ?? num(i.netAmount);
    if (unit === undefined) throw new Error("Versandkosten ohne Betrag, bitte in weclapp anpassen.");
    return { ...i, unitPrice: (Math.round(unit * (targetCents / total) * 10_000) / 10_000).toFixed(4) };
  });
}

function toLookupError(error: unknown): OrderLookupResult {
  if (error instanceof HttpError) return { status: "error", error: error.message, retryable: error.retryable };
  return { status: "error", error: (error as Error).message, retryable: true };
}
