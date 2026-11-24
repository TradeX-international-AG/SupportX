import { amazonMarketplace } from "../../core/amazon-marketplaces.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";
import { isOfficialAmazonHost, LWA_TOKEN_URL } from "./listings.ts";

/**
 * Amazon SP-API website authorization workflow for the operator's app.
 *
 * Two ways in, one way out:
 * - Started in SupportX: the owner is sent to the Seller Central consent page
 *   (`/apps/authorize/consent?application_id=…`).
 * - Started in the Amazon Appstore / Seller Central: Amazon opens the app's
 *   login URI (`/oauth/amazon/login`) with `amazon_callback_uri` and
 *   `amazon_state`; SupportX sends the signed-in owner back to that callback.
 * Either way Amazon then redirects to `/oauth/amazon/callback` with
 * `spapi_oauth_code`, `state` and `selling_partner_id`, and the code is
 * exchanged once (valid five minutes) for the seller's refresh token.
 */

export const AMAZON_LOGIN_PATH = "/oauth/amazon/login";
export const AMAZON_CALLBACK_PATH = "/oauth/amazon/callback";

/** Seller Central host per marketplace country (Amazon "Authorization URLs"). */
const SELLER_CENTRAL_BY_COUNTRY: Readonly<Record<string, string>> = {
  DE: "sellercentral.amazon.de",
  ES: "sellercentral.amazon.es",
  FR: "sellercentral.amazon.fr",
  IT: "sellercentral.amazon.it",
  NL: "sellercentral.amazon.nl",
  BE: "sellercentral.amazon.com.be",
  PL: "sellercentral.amazon.pl",
  SE: "sellercentral.amazon.se",
  UK: "sellercentral.amazon.co.uk",
  IE: "sellercentral.amazon.ie",
  TR: "sellercentral.amazon.com.tr",
  US: "sellercentral.amazon.com",
  CA: "sellercentral.amazon.ca",
  MX: "sellercentral.amazon.com.mx",
  JP: "sellercentral.amazon.co.jp",
  AU: "sellercentral.amazon.com.au",
};
const SELLER_CENTRAL_HOSTS = new Set([...Object.values(SELLER_CENTRAL_BY_COUNTRY), "sellercentral-europe.amazon.com", "sellercentral-japan.amazon.com"]);

export function isSellerCentralHost(hostname: string): boolean {
  return SELLER_CENTRAL_HOSTS.has(hostname.toLowerCase());
}

export interface AmazonOAuthApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  /** Draft app in Developer Central: Amazon only accepts the consent with version=beta. */
  draft: boolean;
}

/** Consent page in Seller Central of the first chosen marketplace. */
export function buildAmazonConsentUrl(app: AmazonOAuthApp, marketplaceId: string, state: string, redirectUri: string): string {
  const country = amazonMarketplace(marketplaceId)?.country;
  const host = country ? SELLER_CENTRAL_BY_COUNTRY[country] : undefined;
  if (!host) throw new Error(`Für diesen Marktplatz ist keine Seller-Central-Adresse bekannt: ${marketplaceId}`);
  const url = new URL(`https://${host}/apps/authorize/consent`);
  url.searchParams.set("application_id", app.appId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  if (app.draft) url.searchParams.set("version", "beta");
  return url.toString();
}

/**
 * Started from Amazon: continue at the `amazon_callback_uri` Amazon gave the
 * login URI. Only Seller Central over HTTPS is accepted, so the login URI can
 * never be used to send a person to another site.
 */
export function buildAmazonLoginContinueUrl(app: AmazonOAuthApp, input: { amazonCallbackUri: string; amazonState: string; state: string; redirectUri: string }): string {
  let url: URL;
  try {
    url = new URL(input.amazonCallbackUri);
  } catch {
    throw new Error("Die Rücksprungadresse von Amazon ist ungültig.");
  }
  if (url.protocol !== "https:" || !isSellerCentralHost(url.hostname) || url.username || url.password || url.port) {
    throw new Error("Die Rücksprungadresse gehört nicht zu Amazon Seller Central.");
  }
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("amazon_state", input.amazonState);
  url.searchParams.set("state", input.state);
  if (app.draft) url.searchParams.set("version", "beta");
  return url.toString();
}

/** Exchange the authorization code (single use, five minutes) for the seller's refresh token. */
export async function exchangeAmazonCode(
  app: AmazonOAuthApp,
  input: { code: string; redirectUri: string; tokenUrl?: string; allowTestEndpoints: boolean; fetchImpl?: typeof fetch },
): Promise<{ refreshToken: string }> {
  const url = assertAllowedEndpoint(input.tokenUrl ?? LWA_TOKEN_URL, input.allowTestEndpoints, isOfficialAmazonHost);
  let raw: unknown;
  try {
    raw = await requestJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, client_id: app.clientId, client_secret: app.clientSecret }).toString(),
      timeoutMs: 15_000,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 400 || error.status === 401)) {
      throw new HttpError("Amazon hat die Freigabe nicht angenommen: Der Code ist abgelaufen oder schon verwendet, oder Client-ID/Secret der App passen nicht. Bitte die Verbindung neu starten.", error.status, false, false);
    }
    throw error;
  }
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!/^Atzr\|/.test(refreshToken)) throw new HttpError("Amazon lieferte keinen Refresh-Token.", 502, false, false);
  return { refreshToken };
}
