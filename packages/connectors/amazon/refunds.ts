import { gunzipSync } from "node:zlib";
import type { AmazonRegion } from "../../core/amazon-marketplaces.ts";
import { adjustmentFeedXml, amountToCents, parseProcessingReport, type AmazonOrderView, type AmazonRefundReason, type ProcessingReport, type RefundLine } from "../../core/amazon-refund.ts";
import { assertAllowedEndpoint, HttpError, requestBinary, requestJson } from "../http.ts";
import { isOfficialAmazonHost, LWA_TOKEN_URL, REGION_HOSTS } from "./listings.ts";
import { LwaToken } from "./lwa.ts";

/**
 * Amazon SP-API for refunds from a case:
 * - Orders API v0: read the order and its items (what was paid per item).
 * - Feeds API 2021-06-30: submit an order adjustment (POST_PAYMENT_ADJUSTMENT_DATA)
 *   and read its processing report.
 *
 * The SP-API app needs the role "Inventory and Order Tracking" (Amazon lists it
 * for the order adjustment feed). Only the last step, createFeed, can change
 * anything at Amazon; a timeout there is reported as uncertain.
 */

export const FEEDS_VERSION = "2021-06-30";
export const ADJUSTMENT_FEED_TYPE = "POST_PAYMENT_ADJUSTMENT_DATA";
const FEED_CONTENT_TYPE = "text/xml; charset=UTF-8";

export interface AmazonRefundsConfig {
  region: AmazonRegion;
  sellerId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  apiBaseUrl?: string;
  tokenUrl?: string;
  allowTestEndpoints: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type FeedState = "in_progress" | "done" | "failed";

export interface FeedResult {
  state: FeedState;
  /** Amazon processingStatus: IN_QUEUE, IN_PROGRESS, DONE, CANCELLED, FATAL. */
  processingStatus: string;
  report: ProcessingReport | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const money = (v: unknown) => amountToCents(str(rec(v).Amount));

/** Pre-signed upload/download URLs point to Amazon's S3 buckets. */
export function isAmazonDocumentHost(url: URL): boolean {
  return url.hostname === "s3.amazonaws.com" || url.hostname.endsWith(".amazonaws.com");
}

/** Parses getOrder + getOrderItems responses. Exported for contract tests. */
export function parseOrder(orderRaw: unknown, itemsRaw: unknown): AmazonOrderView {
  const order = rec(rec(orderRaw).payload);
  const items = arr(rec(rec(itemsRaw).payload).OrderItems).map(rec);
  const currency = str(rec(order.OrderTotal).CurrencyCode) ?? str(rec(items[0]?.ItemPrice).CurrencyCode) ?? "EUR";
  return {
    orderId: str(order.AmazonOrderId) ?? str(rec(rec(itemsRaw).payload).AmazonOrderId) ?? "",
    status: str(order.OrderStatus) ?? "",
    fulfillmentChannel: str(order.FulfillmentChannel) ?? "",
    marketplaceId: str(order.MarketplaceId) ?? "",
    currency,
    items: items.map((i) => ({
      orderItemId: str(i.OrderItemId) ?? "",
      sku: str(i.SellerSKU),
      asin: str(i.ASIN),
      title: str(i.Title),
      quantity: typeof i.QuantityOrdered === "number" ? i.QuantityOrdered : Number(i.QuantityOrdered ?? 0) || 0,
      itemPriceCents: money(i.ItemPrice),
      shippingPriceCents: money(i.ShippingPrice),
      promotionDiscountCents: money(i.PromotionDiscount),
    })).filter((i) => i.orderItemId),
  };
}

export class AmazonRefundsClient {
  readonly #c: AmazonRefundsConfig;
  readonly #api: URL;
  readonly #lwa: LwaToken;

  constructor(config: AmazonRefundsConfig) {
    if (!config.sellerId.trim() || !config.clientId.trim() || !config.clientSecret || !config.refreshToken) throw new Error("Amazon-Zugangsdaten unvollständig.");
    if (!REGION_HOSTS[config.region]) throw new Error(`Unbekannte Amazon-Region: ${config.region}`);
    this.#c = config;
    this.#api = assertAllowedEndpoint(config.apiBaseUrl ?? REGION_HOSTS[config.region], config.allowTestEndpoints, isOfficialAmazonHost);
    const tokenUrl = assertAllowedEndpoint(config.tokenUrl ?? LWA_TOKEN_URL, config.allowTestEndpoints, isOfficialAmazonHost);
    this.#lwa = new LwaToken({ tokenUrl, clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: config.refreshToken, timeoutMs: this.#timeout, fetchImpl: config.fetchImpl });
  }

  get #timeout(): number {
    return this.#c.timeoutMs ?? 15_000;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown, params: Record<string, string> = {}): Promise<unknown> {
    const token = await this.#lwa.get();
    const url = new URL(path, this.#api);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      return await requestJson(url, { method, headers: { "x-amz-access-token": token, accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: this.#timeout, fetchImpl: this.#c.fetchImpl });
    } catch (error) {
      throw explain(error);
    }
  }

  /** The order and its items as Amazon has them now, or null if this seller has no such order. */
  async getOrder(orderId: string): Promise<AmazonOrderView | null> {
    try {
      const id = encodeURIComponent(orderId);
      const order = await this.#call("GET", `/orders/v0/orders/${id}`);
      const items = await this.#call("GET", `/orders/v0/orders/${id}/orderItems`);
      return parseOrder(order, items);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Uploads the adjustment and creates the feed. Steps before createFeed change
   * nothing at Amazon (not uncertain); createFeed itself can be.
   */
  async submitAdjustment(input: { orderId: string; marketplaceId: string; currency: string; reason: AmazonRefundReason; lines: ReadonlyArray<RefundLine> }): Promise<{ feedId: string }> {
    const document = adjustmentFeedXml({ sellerId: this.#c.sellerId.trim(), ...input });
    const created = rec(await this.#safe(() => this.#call("POST", `/feeds/${FEEDS_VERSION}/documents`, { contentType: FEED_CONTENT_TYPE })));
    const documentId = str(created.feedDocumentId);
    const uploadUrl = str(created.url);
    if (!documentId || !uploadUrl) throw new HttpError("Amazon lieferte keine Upload-Adresse für die Erstattung.", 502, false, false);
    const target = assertAllowedEndpoint(uploadUrl, this.#c.allowTestEndpoints, isAmazonDocumentHost);
    await this.#safe(() => requestJson(target, { method: "PUT", headers: { "Content-Type": FEED_CONTENT_TYPE }, body: document, timeoutMs: this.#timeout, fetchImpl: this.#c.fetchImpl }));
    const feed = rec(await this.#call("POST", `/feeds/${FEEDS_VERSION}/feeds`, { feedType: ADJUSTMENT_FEED_TYPE, marketplaceIds: [input.marketplaceId], inputFeedDocumentId: documentId }));
    const feedId = str(feed.feedId);
    if (!feedId) throw new HttpError("Amazon hat die Erstattung angenommen, aber keine Vorgangsnummer genannt.", 502, false, true);
    return { feedId };
  }

  /** A failure before createFeed never reached Amazon's order: not uncertain. */
  async #safe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.message, error.status, error.retryable, false);
      throw error;
    }
  }

  /** State of a submitted feed and, when done, its processing report. Changes nothing. */
  async getFeedResult(feedId: string): Promise<FeedResult> {
    const feed = rec(await this.#call("GET", `/feeds/${FEEDS_VERSION}/feeds/${encodeURIComponent(feedId)}`));
    const processingStatus = str(feed.processingStatus) ?? "UNKNOWN";
    if (processingStatus === "IN_QUEUE" || processingStatus === "IN_PROGRESS") return { state: "in_progress", processingStatus, report: null };
    const resultId = str(feed.resultFeedDocumentId);
    let report: ProcessingReport | null = null;
    if (resultId) {
      const doc = rec(await this.#call("GET", `/feeds/${FEEDS_VERSION}/documents/${encodeURIComponent(resultId)}`));
      const url = str(doc.url);
      if (url) {
        const file = await requestBinary(assertAllowedEndpoint(url, this.#c.allowTestEndpoints, isAmazonDocumentHost), { timeoutMs: this.#timeout, maxBytes: 5_000_000, fetchImpl: this.#c.fetchImpl });
        const data = str(doc.compressionAlgorithm) === "GZIP" ? gunzipSync(file.data) : file.data;
        report = parseProcessingReport(data.toString("utf8"));
      }
    }
    if (processingStatus !== "DONE") return { state: "failed", processingStatus, report };
    return { state: report && report.successful > 0 && report.withError === 0 ? "done" : "failed", processingStatus, report };
  }

  /** Token exchange plus one order search: proves the role for orders. */
  async checkAccess(marketplaceId: string, now: Date): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#call("GET", "/orders/v0/orders", undefined, { MarketplaceIds: marketplaceId, CreatedAfter: new Date(now.getTime() - 7 * 86_400_000).toISOString(), MaxResultsPerPage: "1" });
      return { ok: true, detail: "Bestellungen lesbar: Erstattungen aus dem Fall sind möglich." };
    } catch (error) {
      return { ok: false, detail: `Erstattungen: ${(error as Error).message}` };
    }
  }
}

function explain(error: unknown): Error {
  if (!(error instanceof HttpError)) return error instanceof Error ? error : new Error(String(error));
  if (error.status === 403) {
    return new HttpError("Amazon verweigert den Zugriff (403). Für Erstattungen braucht die SP-API-App die Rolle „Inventory and Order Tracking“, und der Verkäufer muss die App danach neu autorisiert haben (neuer Refresh-Token).", 403, false, error.uncertain);
  }
  return error;
}
