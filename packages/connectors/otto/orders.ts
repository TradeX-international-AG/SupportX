import { OTTO_STATUS_DE, statusLabel, summariseLines, type MarketplaceOrderLookup, type MarketplaceOrderView } from "../../core/marketplace-order.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";
import { httpsUrl } from "../mirakl/inbox-channel.ts";

/**
 * OTTO Market order status, read only.
 *
 * OTTO has no API for customer messages: customer contacts reach the partner by
 * e-mail and come into SupportX through the Microsoft mailbox. The OTTO API
 * only adds what OTTO itself knows about an order (status per position,
 * cancellations, returns), on a person's click in the case.
 *
 * Documentation reviewed 2026-11-19 (docs/SOURCES.md, OTTO-1..OTTO-3):
 * - Self-app: the seller creates an app in OTTO Partner Connect with the scope
 *   "orders" and enters client id + secret; OAuth2 client credentials,
 *   POST /v1/token (form encoded). Every interface must be named as a scope in
 *   the token request.
 * - GET /v4/orders/{orderNumber} (or {salesOrderId}); positionItems[] with
 *   fulfillmentStatus ANNOUNCED, PROCESSABLE, SENT, RETURNED,
 *   CANCELLED_BY_PARTNER, CANCELLED_BY_MARKETPLACE.
 *
 * Not yet verified with a real account: token scope handling, the exact field
 * names of product title and tracking inside positionItems.
 */
export interface OttoOrdersConfig {
  clientId: string;
  clientSecret: string;
  sandbox?: boolean;
  /** Test doubles only (ALLOW_TEST_ENDPOINTS). */
  baseUrl?: string;
  allowTestEndpoints?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

export const OTTO_PROD_URL = "https://api.otto.market";
export const OTTO_SANDBOX_URL = "https://sandbox.api.otto.market";

export function isOfficialOttoHost(url: URL): boolean {
  return url.hostname === "api.otto.market" || url.hostname === "sandbox.api.otto.market";
}

export class OttoOrdersClient implements MarketplaceOrderLookup {
  readonly #config: OttoOrdersConfig;
  readonly #base: string;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(config: OttoOrdersConfig) {
    if (!config.clientId?.trim() || !config.clientSecret?.trim()) throw new Error("OTTO Client-ID und Client-Secret werden benötigt.");
    this.#config = config;
    this.#base = assertAllowedEndpoint(config.baseUrl ?? (config.sandbox ? OTTO_SANDBOX_URL : OTTO_PROD_URL), config.allowTestEndpoints ?? false, isOfficialOttoHost).origin;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.#config.clientId.trim(), client_secret: this.#config.clientSecret.trim(), scope: "orders" });
    const res = (await requestJson(`${this.#base}/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      timeoutMs: this.#config.timeoutMs ?? 20_000,
      fetchImpl: this.#config.fetchImpl,
    })) as Json | null;
    const token = typeof res?.access_token === "string" ? res.access_token : "";
    if (!token) throw new HttpError("OTTO hat kein Zugriffstoken geliefert.", 502, true);
    const seconds = typeof res?.expires_in === "number" ? res.expires_in : 1800;
    this.#token = { value: token, expiresAt: Date.now() + seconds * 1000 };
    return token;
  }

  async #get(path: string): Promise<Json | null> {
    return (await requestJson(`${this.#base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${await this.#accessToken()}`, Accept: "application/json" },
      timeoutMs: this.#config.timeoutMs ?? 20_000,
      fetchImpl: this.#config.fetchImpl,
    })) as Json | null;
  }

  async lookupOrder(orderId: string): Promise<MarketplaceOrderView | null> {
    let order: Json | null;
    try {
      order = await this.#get(`/v4/orders/${encodeURIComponent(orderId)}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
    if (!order) return null;
    const items = Array.isArray(order.positionItems) ? (order.positionItems as Json[]) : [];
    // OTTO lists one position item per piece: group equal article + status.
    const grouped = new Map<string, { title: string; sku?: string; status?: string; quantity: number }>();
    const tracking = new Map<string, { carrier?: string; number?: string; url?: string }>();
    for (const item of items) {
      const product = (item.product ?? {}) as Json;
      const title = typeof product.productTitle === "string" ? product.productTitle : typeof product.title === "string" ? product.title : typeof product.sku === "string" ? product.sku : "Artikel";
      const sku = typeof product.sku === "string" ? product.sku : undefined;
      const status = typeof item.fulfillmentStatus === "string" ? item.fulfillmentStatus : undefined;
      const key = `${title}\u0000${status ?? ""}`;
      const g = grouped.get(key) ?? { title, sku, status, quantity: 0 };
      g.quantity += 1;
      grouped.set(key, g);
      const info = (item.trackingInfo ?? {}) as Json;
      if (typeof info.trackingNumber === "string" && info.trackingNumber) {
        tracking.set(info.trackingNumber, { number: info.trackingNumber, carrier: typeof info.carrier === "string" ? info.carrier : undefined, url: httpsUrl(info.trackingUrl) });
      }
    }
    const lines = [...grouped.values()].map((g) => ({ title: g.title, sku: g.sku, quantity: g.quantity, status: g.status, statusLabel: statusLabel(OTTO_STATUS_DE, g.status) }));
    return {
      platform: "otto",
      orderId: typeof order.orderNumber === "string" ? order.orderNumber : orderId,
      statusLabel: summariseLines(lines),
      createdAt: typeof order.orderDate === "string" ? order.orderDate : undefined,
      lines,
      tracking: [...tracking.values()],
      refunds: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#accessToken();
      // Cheapest read with the orders scope: at most one order of the last day.
      await this.#get(`/v4/orders?limit=1&fromOrderDate=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`);
      return { ok: true, detail: "OTTO-Bestellungen lesbar." };
    } catch (error) {
      return { ok: false, detail: error instanceof HttpError ? error.message : (error as Error).message };
    }
  }
}
