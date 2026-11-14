import type { CarrierEvent, CarrierStatusCode, CarrierTrackingResult } from "../../core/carrier-tracking.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";

/**
 * DHL Shipment Tracking – Unified API (developer.dhl.com), read only.
 *
 *   GET https://api-eu.dhl.com/track/shipments?trackingNumber=…&language=de[&recipientPostalCode=…]
 *   Header: DHL-API-Key: <API key of an app in the DHL developer portal>
 *
 * The answer has `shipments[]` with the latest `status` and the `events[]` history
 * (newest first). `status.statusCode` is one of pre-transit, transit, delivered,
 * failure, unknown. DHL only shows details such as the places a parcel passed when
 * the recipient's postal code is given ("postal code challenge"); the status itself
 * comes without it. Unknown numbers answer 404. A new app's key is limited (DHL:
 * 250 calls a day); a higher limit is requested in the developer portal.
 * Works for DHL Paket Deutschland, DHL Express and other DHL divisions; the
 * response shape is the same for all.
 */

export const DHL_TRACKING_URL = "https://api-eu.dhl.com/track/shipments";
const OFFICIAL_HOSTS = new Set(["api-eu.dhl.com", "api.dhl.com", "api-test.dhl.com"]);

export function isOfficialDhlHost(url: URL): boolean {
  return OFFICIAL_HOSTS.has(url.hostname);
}

export interface DhlTrackingConfig {
  apiKey: string;
  /** Default: the official EU endpoint. Test doubles only with ALLOW_TEST_ENDPOINTS. */
  apiUrl?: string;
  allowTestEndpoints: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const CODES = new Set<CarrierStatusCode>(["pre-transit", "transit", "delivered", "failure", "unknown"]);

function code(v: unknown): CarrierStatusCode | undefined {
  const s = str(v)?.toLowerCase();
  return s && CODES.has(s as CarrierStatusCode) ? (s as CarrierStatusCode) : undefined;
}

function place(v: unknown): string | undefined {
  const a = obj(obj(v).address);
  const parts = [str(a.addressLocality), str(a.countryCode)].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

function event(v: unknown): CarrierEvent {
  const e = obj(v);
  return { at: str(e.timestamp), statusCode: code(e.statusCode), status: str(e.status), description: str(e.description), location: place(e.location) };
}

/** Map one Unified API answer. Exported for contract tests with synthetic fixtures. */
export function mapDhlResponse(trackingNumber: string, body: unknown, fetchedAt: string): CarrierTrackingResult {
  const shipments = Array.isArray(obj(body).shipments) ? (obj(body).shipments as unknown[]) : [];
  // DHL may list more than one hit (several divisions); prefer the one with this id.
  const s = obj(shipments.find((x) => str(obj(x).id)?.replace(/\s+/g, "").toUpperCase() === trackingNumber) ?? shipments[0]);
  if (!shipments.length) return { carrier: "dhl", trackingNumber, state: "not_found", events: [], fetchedAt };
  const status = event(s.status);
  const events = (Array.isArray(s.events) ? s.events : []).map(event).slice(0, 30);
  const details = obj(s.details);
  const statusCode = status.statusCode ?? events[0]?.statusCode ?? "unknown";
  const delivered = statusCode === "delivered" ? str(obj(details.proofOfDelivery).timestamp) ?? status.at ?? events.find((e) => e.statusCode === "delivered")?.at : undefined;
  const returnFlag = details.returnFlag === true || s.returnFlag === true;
  return {
    carrier: "dhl",
    trackingNumber,
    state: "found",
    statusCode,
    status: status.status,
    description: status.description,
    statusAt: status.at,
    location: status.location,
    ...(delivered ? { deliveredAt: delivered } : {}),
    ...(returnFlag ? { returnFlag } : {}),
    service: str(s.service),
    estimatedDelivery: str(s.estimatedTimeOfDelivery),
    events,
    fetchedAt,
  };
}

export class DhlTrackingClient {
  private readonly url: URL;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: DhlTrackingConfig) {
    const key = config.apiKey.trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new Error("Der DHL-API-Key hat nicht das erwartete Format (Buchstaben und Ziffern, aus dem DHL-Entwicklerportal unter „Apps“).");
    this.url = assertAllowedEndpoint(config.apiUrl ?? DHL_TRACKING_URL, config.allowTestEndpoints, isOfficialDhlHost);
    this.apiKey = key;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.fetchImpl = config.fetchImpl;
  }

  /** Status of one parcel. A 404 is an answer ("DHL kennt die Nummer nicht"), not an error. */
  async track(trackingNumber: string, opts: { postalCode?: string; now?: Date } = {}): Promise<CarrierTrackingResult> {
    const fetchedAt = (opts.now ?? new Date()).toISOString();
    const url = new URL(this.url);
    url.searchParams.set("trackingNumber", trackingNumber);
    url.searchParams.set("language", "de");
    const zip = opts.postalCode?.replace(/\s+/g, "");
    if (zip && /^[A-Za-z0-9]{3,10}$/.test(zip)) url.searchParams.set("recipientPostalCode", zip);
    try {
      const body = await requestJson(url, { method: "GET", headers: { "DHL-API-Key": this.apiKey, Accept: "application/json" }, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl });
      return mapDhlResponse(trackingNumber, body, fetchedAt);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return { carrier: "dhl", trackingNumber, state: "not_found", events: [], fetchedAt };
      throw error;
    }
  }

  /**
   * Key check without a real parcel: a made-up number answers 404 when the key is
   * accepted, 401/403 when it is not.
   */
  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.track("00340000000000000000");
      return { ok: true, detail: r.state === "not_found" ? "DHL hat den API-Key angenommen." : "DHL hat den API-Key angenommen und geantwortet." };
    } catch (error) {
      const e = error as HttpError;
      if (e.status === 401 || e.status === 403) return { ok: false, detail: "DHL lehnt den API-Key ab. Bitte im DHL-Entwicklerportal prüfen, ob die App für „Shipment Tracking – Unified“ freigeschaltet ist." };
      if (e.status === 429) return { ok: true, detail: "DHL hat den API-Key angenommen, das Tageslimit ist aber gerade erreicht." };
      return { ok: false, detail: e.message };
    }
  }
}
