import type { DhlShipper } from "../../core/return-label.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";

/**
 * DHL Parcel DE Returns API v1 (Post & Parcel Germany), creates return labels.
 *
 *   POST https://api-eu.dhl.com/parcel/de/shipping/returns/v1/orders?labelType=SHIPMENT_LABEL
 *   Header: dhl-api-key: <API key of an app in the DHL developer portal with the Returns API>
 *   Basic auth: user and password of the DHL business customer portal (geschaeftskunden.dhl.de)
 *   Body: { receiverId, customerReference, shipmentReference, shipper: { name1, name2,
 *           addressStreet, addressHouse, additionalAddressInformation1, postalCode, city, country (alpha-3) } }
 *   201:  { sstatus: {status, title, detail}, shipmentNo, internationalShipmentNo?,
 *           label: { b64 }, qrLabel?: { b64 }, routingCode }
 *   Errors: application/json { status, title, detail }; 401 for a wrong key or user.
 *
 * Sandbox: https://api-sandbox.dhl.com/parcel/de/shipping/returns/v1 with sandbox
 * credentials from the developer portal. Shapes taken from the official PHP SDK of
 * DHL's integration partner (netresearch/dhl-sdk-api-parcel-de-returns, its request
 * models and response fixtures); not yet checked against a live account.
 */

export const DHL_RETURNS_URL = "https://api-eu.dhl.com/parcel/de/shipping/returns/v1";
export const DHL_RETURNS_SANDBOX_URL = "https://api-sandbox.dhl.com/parcel/de/shipping/returns/v1";
const OFFICIAL_HOSTS = new Set(["api-eu.dhl.com", "api-sandbox.dhl.com"]);

export interface DhlReturnsConfig {
  apiKey: string;
  user: string;
  password: string;
  sandbox?: boolean;
  /** Test doubles only with ALLOW_TEST_ENDPOINTS. */
  apiUrl?: string;
  allowTestEndpoints: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DhlReturnLabel {
  shipmentNo: string;
  internationalShipmentNo?: string;
  routingCode?: string;
  /** The label as PDF. */
  pdf: Buffer;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Map DHL's answer. Exported for contract tests with synthetic fixtures. */
export function mapReturnLabel(body: unknown): DhlReturnLabel {
  const b = obj(body);
  const shipmentNo = str(b.shipmentNo);
  const b64 = str(obj(b.label).b64);
  if (!shipmentNo) throw new HttpError("DHL hat keine Sendungsnummer zurückgegeben.", 0, false);
  if (!b64) throw new HttpError(`DHL hat zur Sendung ${shipmentNo} kein PDF-Label zurückgegeben.`, 0, false);
  const pdf = Buffer.from(b64, "base64");
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(`Das Label zur Sendung ${shipmentNo} ist kein PDF.`, 0, false);
  return { shipmentNo, internationalShipmentNo: str(b.internationalShipmentNo), routingCode: str(b.routingCode), pdf };
}

export class DhlReturnsClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: DhlReturnsConfig) {
    const key = config.apiKey.trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new Error("Der DHL-API-Key hat nicht das erwartete Format (Buchstaben und Ziffern, aus dem DHL-Entwicklerportal unter „Apps“).");
    const user = config.user.trim();
    if (!user || user.length > 100 || /[:\s]/.test(user)) throw new Error("Bitte den Benutzernamen des DHL-Geschäftskundenportals eintragen (ohne Leerzeichen und Doppelpunkt).");
    if (!config.password || config.password.length > 200) throw new Error("Bitte das Passwort des DHL-Geschäftskundenportals eintragen.");
    const url = assertAllowedEndpoint(config.apiUrl ?? (config.sandbox ? DHL_RETURNS_SANDBOX_URL : DHL_RETURNS_URL), config.allowTestEndpoints, (u) => OFFICIAL_HOSTS.has(u.hostname));
    this.base = url.toString().replace(/\/+$/, "");
    this.headers = {
      "dhl-api-key": key,
      Authorization: `Basic ${Buffer.from(`${user}:${config.password}`, "utf8").toString("base64")}`,
      Accept: "application/json",
    };
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchImpl = config.fetchImpl;
  }

  /**
   * Creates one return label. Every call makes a new label at DHL; the caller makes
   * sure a person asked for it. An unclear outcome (timeout after sending) surfaces as
   * HttpError with `uncertain`.
   */
  async createLabel(input: { receiverId: string; shipper: DhlShipper; customerReference?: string; shipmentReference?: string }): Promise<DhlReturnLabel> {
    const url = new URL(`${this.base}/orders`);
    url.searchParams.set("labelType", "SHIPMENT_LABEL");
    const body = {
      receiverId: input.receiverId,
      ...(input.customerReference ? { customerReference: input.customerReference.slice(0, 30) } : {}),
      ...(input.shipmentReference ? { shipmentReference: input.shipmentReference.slice(0, 30) } : {}),
      shipper: input.shipper,
    };
    const res = await requestJson(url, { method: "POST", headers: this.headers, body: JSON.stringify(body), timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl });
    return mapReturnLabel(res);
  }

  /**
   * Access check without making a label: an order without receiver and sender is
   * refused by DHL with 400 once key and user are accepted, with 401/403 when not.
   */
  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      await requestJson(new URL(`${this.base}/orders?labelType=SHIPMENT_LABEL`), { method: "POST", headers: this.headers, body: "{}", timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl });
      return { ok: false, detail: "DHL hat eine leere Probe-Anfrage angenommen; das ist unerwartet. Bitte im DHL-Geschäftskundenportal nachsehen, ob eine leere Retoure angelegt wurde." };
    } catch (error) {
      const e = error as HttpError;
      if (e.status === 400 || e.status === 422) return { ok: true, detail: "DHL hat API-Key und Benutzer angenommen." };
      if (e.status === 401 || e.status === 403) return { ok: false, detail: dhlReturnsAuthHint(e.message) };
      if (e.status === 429) return { ok: true, detail: "DHL hat die Zugangsdaten angenommen, das Abruflimit ist aber gerade erreicht." };
      return { ok: false, detail: e.message };
    }
  }
}

/** Plain words for a refused login. */
export function dhlReturnsAuthHint(message: string): string {
  if (/user|password|benutzer|passwort/i.test(message)) return "DHL lehnt Benutzer oder Passwort ab. Bitte die Zugangsdaten des DHL-Geschäftskundenportals prüfen (Benutzer mit Recht für Retouren; ein persönlicher Login mit Zwei-Faktor geht nicht, dafür einen System-Benutzer anlegen).";
  return "DHL lehnt den Zugang ab. Bitte prüfen, ob die App im DHL-Entwicklerportal für „Parcel DE Returns“ freigeschaltet ist und Benutzer und Passwort des Geschäftskundenportals stimmen.";
}
