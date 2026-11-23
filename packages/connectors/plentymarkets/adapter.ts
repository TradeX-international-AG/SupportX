import { createHash } from "node:crypto";
import type {
  InvoiceFact,
  OrderLineFact,
  OrderLookupResult,
  OrderProvider,
  OrderRecord,
  OrderScopeRule,
  ParcelFact,
  ReferenceQuery,
  ShipmentFact,
} from "../../core/contracts.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";

/**
 * Read-only plentymarkets (PlentyONE) REST adapter, the second OrderProvider next
 * to weclapp. Only GET requests besides the login.
 *
 * Login and order fields follow the plenty connection of ASEIO, which reads
 * orders from real plenty systems (POST /rest/login → access_token/expires_in,
 * GET /rest/orders with embedded orderItems, property typeId 7 = external order
 * number, status ranges, /rest/orders/referrers). Relations loaded per order
 * (`with[]=relations|documents|shippingPackages|tags`), /rest/orders/statuses and
 * /rest/orders/{id}/packagenumbers come from the plenty REST reference and are
 * not yet checked against a live system; every one of them is optional here: a
 * refused relation only drops that part of the order, never the lookup.
 *
 * Every hit is compared exactly on the returned record (plenty ignores unknown
 * query parameters silently, so a filter alone proves nothing).
 */
export interface PlentyConfig {
  /** e.g. https://p12345.my.plentysystems.com (with or without /rest). */
  baseUrl: string;
  username: string;
  password: string;
  /** Searched for a customer's order reference, in order: externalOrderId, orderId. */
  searchFields: ReadonlyArray<string>;
  timeoutMs?: number;
  allowTestEndpoints?: boolean;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

export const PLENTY_SEARCH_FIELDS = ["externalOrderId", "orderId"] as const;
/** Order property type 7: external order number (e.g. the Amazon or eBay order number). */
const PROPERTY_EXTERNAL_ORDER_ID = 7;
/** Order item type 6: shipping costs. */
const ITEM_TYPE_SHIPPING = 6;
const ORDER_RELATIONS = ["relations", "documents", "shippingPackages", "tags"];

/** Official plenty hosts. A merchant's own shop domain is not accepted (credentials go there). */
const OFFICIAL_SUFFIXES = [".plentymarkets-cloud01.com", ".plentymarkets-cloud02.com", ".plentymarkets-cloud-de.com", ".plentymarkets-cloud-ie.com", ".plentysystems.com", ".plentyone.com"];

export function validatePlentyBaseUrl(baseUrl: string, allowTestEndpoints: boolean): string {
  const url = assertAllowedEndpoint(baseUrl.trim(), allowTestEndpoints, (u) => OFFICIAL_SUFFIXES.some((s) => u.hostname.endsWith(s)));
  if (url.username || url.password) throw new Error("Die plentymarkets-Adresse darf keine Zugangsdaten enthalten.");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/rest$/, "");
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function arr(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Json[]) : [];
}

/** A list answer is an array or a page ({ entries: [...] }). */
function entries(body: unknown): Json[] {
  if (Array.isArray(body)) return arr(body);
  if (body && typeof body === "object") return arr((body as Json).entries);
  return [];
}

export function externalOrderNumber(order: Json): string | undefined {
  const prop = arr(order.properties).find((p) => num(p.typeId) === PROPERTY_EXTERNAL_ORDER_ID);
  return str(prop?.value)?.trim() || undefined;
}

/** Contact id of the receiver (the customer), from `relations`. */
function receiverContactId(order: Json): string | undefined {
  const rel = arr(order.relations).find((r) => str(r.referenceType) === "contact" && str(r.relation) === "receiver");
  return str(rel?.referenceId);
}

function tagKeys(order: Json): string[] {
  const keys: string[] = [];
  for (const raw of arr(order.tags)) {
    const nested = raw.tag && typeof raw.tag === "object" ? (raw.tag as Json) : null;
    for (const v of [raw.tagId ?? raw.id ?? nested?.id, nested?.tagName ?? raw.tagName ?? nested?.name ?? raw.name]) {
      const s = str(v)?.trim();
      if (s) keys.push(s);
    }
  }
  return keys;
}

/**
 * A merchant account's orders in plenty: salesChannel = referrer id (e.g. "4.01"),
 * customerId = contact id, ecommerceConnectionId = client (plentyId), tag = tag id or name.
 */
export function plentyScopeMatches(order: Json, scope: OrderScopeRule): boolean {
  switch (scope.field) {
    case "none":
      return true;
    case "salesChannel":
      return num(order.referrerId) !== undefined && num(order.referrerId) === num(scope.value);
    case "customerId":
      return receiverContactId(order) === scope.value;
    case "ecommerceConnectionId":
      return str(order.plentyId) === scope.value;
    case "tag":
      return tagKeys(order).includes(scope.value);
  }
}

/** Fixed plenty status ranges (system meaning; own statuses are decimals inside them). Names are a fallback for /rest/orders/statuses. */
export function plentyStatusFallback(statusId: number | undefined): string | undefined {
  if (statusId === undefined) return undefined;
  const band = Math.floor(statusId);
  const names: Record<number, string> = {
    1: "unvollständige Daten", 2: "Auftragseingang", 3: "wartet auf Zahlung", 4: "in Vorbereitung für Versand", 5: "freigegeben für Versand",
    6: "gerade im Versand", 7: "Warenausgang gebucht", 8: "storniert", 9: "Retoure", 10: "Gewährleistung", 11: "Gutschrift",
  };
  return names[band] ?? "offen";
}

function amountIn(amounts: unknown, currency: string | undefined): Json | undefined {
  const list = arr(amounts);
  return (currency ? list.find((a) => str(a.currency) === currency) : undefined) ?? list.find((a) => a.isSystemCurrency === false) ?? list[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Extras {
  statusName?: string;
  referrerName?: string;
  packageNumbers?: ReadonlyArray<string>;
}

export function mapPlentyOrder(order: Json, retrievedAt: string, extras: Extras = {}): OrderRecord {
  const id = String(order.id);
  const orderAmount = amountIn(order.amounts, undefined);
  const currency = str(orderAmount?.currency);
  const items = arr(order.orderItems);
  let shipping = 0;
  let anyAmount = false;
  const lines: OrderLineFact[] = [];
  items.forEach((item, index) => {
    const quantity = num(item.quantity) ?? 0;
    const unit = num(amountIn(item.amounts, currency)?.priceGross);
    if (unit !== undefined) anyAmount = true;
    if (num(item.typeId) === ITEM_TYPE_SHIPPING) {
      shipping += (unit ?? 0) * (quantity || 1);
      return;
    }
    lines.push({
      id: str(item.id) ?? `${id}-${index + 1}`,
      position: index + 1,
      title: str(item.orderItemName) ?? "Position",
      ...(str(item.itemVariationId) ? { articleId: str(item.itemVariationId) } : {}),
      quantity,
      ...(unit !== undefined ? { grossAmount: round2(unit * quantity) } : {}),
    });
  });

  const statusId = num(order.statusId);
  const status = extras.statusName ?? str(order.statusName) ?? plentyStatusFallback(statusId);
  const statusText = statusId !== undefined ? `[${statusId}] ${status ?? ""}`.trim() : status;
  const packages = extras.packageNumbers ?? [];
  const parcels: ParcelFact[] = packages.map((n) => ({ trackingId: n, source: "parcels" as const }));
  const shipments: ShipmentFact[] =
    parcels.length || (statusId !== undefined && statusId >= 7 && statusId < 8)
      ? [{
          id: `${id}-versand`,
          shipmentNumber: id,
          erpStatus: statusText,
          statusHistory: statusText ? [{ status: statusText }] : [],
          items: lines.map((l) => ({ orderLineId: l.id, title: l.title, quantity: l.quantity })),
          parcels,
        }]
      : [];

  const invoices: InvoiceFact[] = arr(order.documents)
    .filter((d) => ["invoice", "invoice_external", "correction", "credit_note", "reversal_document"].includes(str(d.type) ?? ""))
    .map((d) => ({
      id: String(d.id),
      invoiceNumber: str(d.numberWithPrefix) ?? str(d.number),
      invoiceDate: str(d.displayDate) ?? str(d.createdAt),
      type: str(d.type) === "invoice" || str(d.type) === "invoice_external" ? "STANDARD_INVOICE" : "CREDIT_NOTE",
    }));

  const gross = num(orderAmount?.invoiceTotal) ?? num(orderAmount?.grossTotal);
  const external = externalOrderNumber(order);
  return {
    provider: "plentymarkets",
    id,
    orderNumber: id,
    ...(external ? { orderNumberAtCustomer: external } : {}),
    orderDate: str(order.createdAt),
    status: statusText,
    ...(str(order.referrerId) ? { salesChannel: str(order.referrerId) } : {}),
    ...(extras.referrerName ? { salesChannelName: extras.referrerName } : {}),
    ...(str(order.plentyId) ? { ecommerceConnectionId: str(order.plentyId) } : {}),
    ...(receiverContactId(order) ? { customerId: receiverContactId(order) } : {}),
    tags: tagKeys(order),
    lines,
    shipments,
    invoices,
    ...(gross !== undefined ? { grossAmount: gross } : {}),
    ...(anyAmount ? { shippingGrossAmount: round2(shipping) } : {}),
    ...(currency ? { currency } : {}),
    amountsRead: gross !== undefined,
    retrievedAt,
  };
}

/** Access tokens per system and user; plenty tokens last about a day. */
const TOKENS = new Map<string, { token: string; until: number }>();
/** Status and referrer names per system (10 minutes). */
const NAMES = new Map<string, { until: number; statuses: Map<string, string>; referrers: Map<string, string> }>();

export class PlentyOrderProvider implements OrderProvider {
  readonly kind = "plentymarkets" as const;
  readonly #config: PlentyConfig;
  readonly #baseUrl: string;
  readonly #cacheKey: string;

  constructor(config: PlentyConfig) {
    this.#config = config;
    this.#baseUrl = validatePlentyBaseUrl(config.baseUrl, config.allowTestEndpoints ?? false);
    const unsupported = config.searchFields.filter((f) => !(PLENTY_SEARCH_FIELDS as ReadonlyArray<string>).includes(f));
    if (unsupported.length > 0) throw new Error(`Nicht unterstützte plentymarkets-Suchfelder: ${unsupported.join(", ")}`);
    this.#cacheKey = `${this.#baseUrl}|${config.username}|${createHash("sha256").update(config.password).digest("hex")}`;
  }

  async #token(): Promise<string> {
    const cached = TOKENS.get(this.#cacheKey);
    if (cached && cached.until > Date.now()) return cached.token;
    const body = (await requestJson(`${this.#baseUrl}/rest/login`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: JSON.stringify({ username: this.#config.username, password: this.#config.password }),
      timeoutMs: this.#config.timeoutMs ?? 15_000,
      fetchImpl: this.#config.fetchImpl,
    })) as Json | null;
    const token = str(body?.access_token ?? body?.accessToken);
    if (!token) throw new HttpError("plentymarkets hat beim Anmelden kein Zugriffstoken geliefert.", 0, false);
    const seconds = num(body?.expires_in ?? body?.expiresIn) ?? 3600;
    // Five minutes early, so a token never runs out in the middle of a lookup.
    TOKENS.set(this.#cacheKey, { token, until: Date.now() + Math.max(60, seconds - 300) * 1000 });
    return token;
  }

  async #get(path: string, params: Array<[string, string]> = []): Promise<unknown> {
    const url = new URL(`${this.#baseUrl}/rest/${path}`);
    for (const [key, value] of params) url.searchParams.append(key, value);
    const call = async () =>
      requestJson(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${await this.#token()}`, Accept: "application/json" },
        timeoutMs: this.#config.timeoutMs ?? 15_000,
        fetchImpl: this.#config.fetchImpl,
      });
    try {
      return await call();
    } catch (error) {
      // An expired or revoked token: log in again once.
      if (error instanceof HttpError && error.status === 401 && TOKENS.has(this.#cacheKey)) {
        TOKENS.delete(this.#cacheKey);
        return call();
      }
      throw error;
    }
  }

  /** null when plenty does not know the order (404). */
  async #order(orderId: string): Promise<Json | null> {
    try {
      const body = await this.#get(`orders/${encodeURIComponent(orderId)}`, ORDER_RELATIONS.map((r) => ["with[]", r] as [string, string]));
      return body && typeof body === "object" ? (body as Json) : null;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      // A system that refuses one of the relations still gives the plain order.
      if (error instanceof HttpError && (error.status === 400 || error.status === 422)) {
        try {
          const body = await this.#get(`orders/${encodeURIComponent(orderId)}`);
          return body && typeof body === "object" ? (body as Json) : null;
        } catch (inner) {
          if (inner instanceof HttpError && inner.status === 404) return null;
          throw inner;
        }
      }
      throw error;
    }
  }

  async #names(): Promise<{ statuses: Map<string, string>; referrers: Map<string, string> }> {
    const cached = NAMES.get(this.#cacheKey);
    if (cached && cached.until > Date.now()) return cached;
    const read = async (path: string, pick: (row: Json) => [string | undefined, string | undefined]) => {
      try {
        const map = new Map<string, string>();
        for (const row of entries(await this.#get(path))) {
          const [k, v] = pick(row);
          if (k !== undefined && v) map.set(String(num(k) ?? k), v);
        }
        return { map, ok: true };
      } catch {
        return { map: new Map<string, string>(), ok: false };
      }
    };
    const [statuses, referrers] = await Promise.all([
      read("orders/statuses", (r) => {
        const names = r.names && typeof r.names === "object" ? (r.names as Json) : {};
        return [str(r.statusId ?? r.id), str(names.de) ?? str(names.en) ?? str(r.name)];
      }),
      read("orders/referrers", (r) => [str(r.id), str(r.name) ?? str(r.backendName)]),
    ]);
    const entry = { until: Date.now() + (statuses.ok && referrers.ok ? 10 * 60_000 : 60_000), statuses: statuses.map, referrers: referrers.map };
    NAMES.set(this.#cacheKey, entry);
    return entry;
  }

  async #packageNumbers(order: Json): Promise<string[]> {
    const fromRelation = arr(order.shippingPackages).map((p) => str(p.packageNumber)).filter((v): v is string => !!v);
    if (fromRelation.length) return [...new Set(fromRelation)];
    try {
      const body = await this.#get(`orders/${encodeURIComponent(String(order.id))}/packagenumbers`);
      const list = Array.isArray(body) ? body : entries(body).map((p) => p.packageNumber);
      return [...new Set(list.map((v) => str(typeof v === "object" && v ? (v as Json).packageNumber : v)).filter((v): v is string => !!v))];
    } catch {
      return [];
    }
  }

  async #record(order: Json): Promise<OrderRecord> {
    const [names, packageNumbers] = await Promise.all([this.#names(), this.#packageNumbers(order)]);
    const statusKey = num(order.statusId);
    return mapPlentyOrder(order, new Date().toISOString(), {
      statusName: statusKey !== undefined ? names.statuses.get(String(statusKey)) : undefined,
      referrerName: num(order.referrerId) !== undefined ? names.referrers.get(String(num(order.referrerId))) : undefined,
      packageNumbers,
    });
  }

  async findOrders(references: ReadonlyArray<ReferenceQuery>, scope: OrderScopeRule): Promise<OrderLookupResult> {
    const orderRefs = references.filter((r) => r.kind === "order");
    if (orderRefs.length === 0) return { status: "missing", triedReferences: [...new Set(references.map((r) => r.value))] };
    try {
      const found = new Map<string, { order: Json; matchedBy: string }>();
      let outOfScope = 0;
      const consider = (row: Json, matchedBy: string) => {
        if (!plentyScopeMatches(row, scope)) {
          outOfScope++;
          return;
        }
        const id = String(row.id);
        if (!found.has(id)) found.set(id, { order: row, matchedBy });
      };
      for (const { value } of orderRefs) {
        for (const field of this.#config.searchFields) {
          if (field === "orderId") {
            if (!/^\d{1,12}$/.test(value)) continue;
            const row = await this.#order(value);
            if (row && String(row.id) === value) consider(row, `Auftrags-ID=${value}`);
          } else {
            const rows = entries(await this.#get("orders", [["externalOrderId", value], ["itemsPerPage", "20"]]));
            // Exact comparison on the record: plenty ignores unknown filters silently.
            for (const row of rows) {
              if (externalOrderNumber(row) !== value) continue;
              const full = (await this.#order(String(row.id))) ?? row;
              consider(full, `Externe Auftragsnummer=${value}`);
            }
          }
        }
      }
      if (found.size === 0) {
        return { status: "missing", triedReferences: [...new Set(references.map((r) => r.value))], ...(outOfScope > 0 ? { outOfScopeMatches: outOfScope } : {}) };
      }
      if (found.size > 1) {
        return { status: "ambiguous", candidates: [...found.values()].map(({ order, matchedBy }) => ({ id: String(order.id), orderNumber: String(order.id), matchedBy })) };
      }
      const [{ order, matchedBy }] = [...found.values()] as [{ order: Json; matchedBy: string }];
      return { status: "unique", order: await this.#record(order), matchedBy };
    } catch (error) {
      return toLookupError(error);
    }
  }

  async getOrder(orderId: string, scope: OrderScopeRule): Promise<OrderLookupResult> {
    try {
      if (!/^\d{1,12}$/.test(orderId)) return { status: "missing", triedReferences: [orderId] };
      const row = await this.#order(orderId);
      if (!row || String(row.id) !== orderId || !plentyScopeMatches(row, scope)) return { status: "missing", triedReferences: [orderId] };
      return { status: "unique", order: await this.#record(row), matchedBy: `Auftrags-ID=${orderId}` };
    } catch (error) {
      return toLookupError(error);
    }
  }

  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#get("orders", [["itemsPerPage", "1"]]);
      return { ok: true, detail: "Anmeldung und lesender Zugriff auf Aufträge erfolgreich." };
    } catch (error) {
      const detail = error instanceof HttpError && error.status === 401
        ? "plentymarkets lehnt die Anmeldung ab (401): Benutzername oder Passwort prüfen."
        : error instanceof HttpError && error.status === 403
          ? "Der plentymarkets-Benutzer darf Aufträge nicht lesen (403). Rechte des REST-Benutzers prüfen."
          : (error as Error).message;
      return { ok: false, detail };
    }
  }
}

function toLookupError(error: unknown): OrderLookupResult {
  if (error instanceof HttpError) return { status: "error", error: `plentymarkets: ${error.message}`, retryable: error.retryable };
  return { status: "error", error: (error as Error).message, retryable: true };
}

/** For tests: forget cached tokens and names. */
export function resetPlentyCaches(): void {
  TOKENS.clear();
  NAMES.clear();
}
