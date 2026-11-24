import { createHash, randomBytes } from "node:crypto";
import { amazonMarketplace, maskIdentifier, SELLER_CENTRAL_HOSTS, type AmazonRegion } from "../core/amazon-marketplaces.ts";
import { HttpError } from "../connectors/http.ts";
import { exchangeAmazonAuthCode } from "../connectors/amazon/lwa.ts";
import { LWA_TOKEN_URL } from "../connectors/amazon/listings.ts";
import { one, withTx } from "../storage/db.ts";
import { operatorAmazonApp } from "../storage/config.ts";
import { audit } from "./audit.ts";
import { actorFor } from "./auth.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { loadConnection, type AmazonSecret } from "./amazon-listings.ts";

/**
 * "Bei Amazon anmelden": the seller authorises the installation's own SP-API app
 * (Amazon's website authorisation workflow). Client ID and secret stay in the
 * server's .env; SupportX keeps only the seller's refresh token (encrypted) and
 * the seller ID Amazon reports. Steps:
 *   1. start    – owner picks region and marketplaces, gets the Seller Central consent link.
 *   2. continue – Amazon calls the app's login URI; SupportX hands back a fresh state.
 *   3. complete – Amazon calls the redirect URI with the one-time code; SupportX exchanges it.
 * Steps 2 and 3 run in the browser of the same signed-in owner (session cookie),
 * the state is single use and the whole consent is valid 15 minutes.
 */

export const AMAZON_LOGIN_PATH = "/oauth/amazon/login";
export const AMAZON_CALLBACK_PATH = "/oauth/amazon/callback";
const VALID_MS = 15 * 60_000;

const hash = (state: string) => createHash("sha256").update(state).digest("hex");
const base = (ctx: AppContext) => ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, "");
export const amazonRedirectUri = (ctx: AppContext) => `${base(ctx)}${AMAZON_CALLBACK_PATH}`;

function requireOperatorApp(ctx: AppContext) {
  const app = operatorAmazonApp(ctx.config);
  if (!app) throw new ServiceError(409, "AMAZON_APP_MISSING", "Diese Installation hat keine eigene Amazon-App (AMAZON_SP_APP_ID, AMAZON_SP_CLIENT_ID, AMAZON_SP_CLIENT_SECRET). Bitte die Zugangsdaten der eigenen App eintragen.");
  return app;
}

interface StateRow {
  workspace_id: string;
  user_id: string;
  region: AmazonRegion;
  marketplace_ids: string[];
  state_hashes: string[];
  expires_at: Date;
}

/** Step 1: store the consent in progress and return the Seller Central consent link. */
export async function startAmazonConsent(ctx: AppContext, actor: Actor, input: { region: string; marketplaceIds: string[] }): Promise<string> {
  requireRole(actor, ["owner"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Die Amazon-Anmeldung startet nur ein Mensch.");
  const app = requireOperatorApp(ctx);
  const region = input.region as AmazonRegion;
  if (!["eu", "na", "fe"].includes(region)) throw new ServiceError(400, "INVALID", "Bitte die Amazon-Region wählen.");
  const marketplaceIds = [...new Set(input.marketplaceIds.map((m) => m.trim()).filter(Boolean))];
  if (marketplaceIds.length === 0) throw new ServiceError(400, "INVALID", "Bitte mindestens einen Marktplatz wählen.");
  const markets = marketplaceIds.map((id) => {
    const m = amazonMarketplace(id);
    if (!m) throw new ServiceError(400, "INVALID", `Unbekannter Amazon-Marktplatz: ${id}`);
    if (m.region !== region) throw new ServiceError(400, "INVALID", `${m.label} gehört nicht zur gewählten Region.`);
    return m;
  });
  const state = randomBytes(32).toString("base64url");
  await ctx.db.query(
    `INSERT INTO amazon_oauth_states (workspace_id, user_id, region, marketplace_ids, state_hashes, expires_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id) DO UPDATE SET user_id = EXCLUDED.user_id, region = EXCLUDED.region, marketplace_ids = EXCLUDED.marketplace_ids,
       state_hashes = EXCLUDED.state_hashes, expires_at = EXCLUDED.expires_at, created_at = now()`,
    [actor.workspaceId, actor.userId, region, marketplaceIds, [hash(state)], new Date(Date.now() + VALID_MS)],
  );
  const url = new URL(`https://${markets[0]!.sellerCentral}/apps/authorize/consent`);
  url.searchParams.set("application_id", app.appId);
  url.searchParams.set("state", state);
  if (app.draft) url.searchParams.set("version", "beta");
  return url.toString();
}

/**
 * Step 2 (login URI): Amazon sends `amazon_callback_uri` and `amazon_state`. The
 * signed-in owner's open consent gets a fresh state, and the browser goes back to
 * Amazon. Only Seller Central hosts are accepted as callback, so this is no open redirect.
 */
export async function continueAmazonConsent(ctx: AppContext, userId: string, input: { amazonCallbackUri: string; amazonState: string }): Promise<string> {
  const app = requireOperatorApp(ctx);
  let callback: URL;
  try {
    callback = new URL(input.amazonCallbackUri);
  } catch {
    throw new ServiceError(400, "INVALID", "Amazon-Antwort unvollständig.");
  }
  if (callback.protocol !== "https:" || !SELLER_CENTRAL_HOSTS.has(callback.hostname) || callback.username || callback.password || callback.port) {
    throw new ServiceError(400, "INVALID", "Die Rücksprungadresse gehört nicht zu Amazon Seller Central.");
  }
  if (!input.amazonState) throw new ServiceError(400, "INVALID", "Amazon-Antwort unvollständig.");
  const row = await one<StateRow>(ctx.db, "SELECT * FROM amazon_oauth_states WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 1", [userId]);
  if (!row) throw new ServiceError(400, "INVALID_STATE", "Keine offene Amazon-Anmeldung. Bitte in SupportX unter Einstellungen → Marktplätze „Bei Amazon anmelden“ klicken.");
  const state = randomBytes(32).toString("base64url");
  await ctx.db.query("UPDATE amazon_oauth_states SET state_hashes = array_append(state_hashes, $2) WHERE workspace_id = $1", [row.workspace_id, hash(state)]);
  callback.searchParams.set("amazon_state", input.amazonState);
  callback.searchParams.set("state", state);
  callback.searchParams.set("redirect_uri", amazonRedirectUri(ctx));
  if (app.draft) callback.searchParams.set("version", "beta");
  return callback.toString();
}

/** Step 3 (redirect URI): exchange the code and store the access for the workspace. */
export async function completeAmazonConsent(
  ctx: AppContext,
  userId: string,
  input: { code: string; state: string; sellingPartnerId: string },
  fetchImpl?: typeof fetch,
): Promise<{ sellerIdHint: string }> {
  const app = requireOperatorApp(ctx);
  if (!input.code || !input.state) throw new ServiceError(400, "INVALID", "Amazon-Antwort unvollständig.");
  const sellerId = input.sellingPartnerId.trim();
  if (!/^[A-Z0-9]{8,20}$/.test(sellerId)) throw new ServiceError(400, "INVALID", "Amazon hat keine gültige Verkäufer-ID gemeldet.");
  const row = await one<StateRow>(ctx.db, "SELECT * FROM amazon_oauth_states WHERE $1 = ANY(state_hashes)", [hash(input.state)]);
  if (!row) throw new ServiceError(400, "INVALID_STATE", "Die Amazon-Anmeldung ist unbekannt oder wurde schon verwendet. Bitte neu starten.");
  const actor = userId === row.user_id ? await actorFor(ctx.db, userId, row.workspace_id).catch(() => null) : null;
  if (!actor) throw new ServiceError(403, "FORBIDDEN", "Bitte die Amazon-Anmeldung im selben angemeldeten Konto abschließen, in dem sie gestartet wurde.");
  requireRole(actor, ["owner"]);
  // Single use: remove the open consent before talking to Amazon.
  await ctx.db.query("DELETE FROM amazon_oauth_states WHERE workspace_id = $1", [row.workspace_id]);
  if (new Date(row.expires_at).getTime() < Date.now()) throw new ServiceError(400, "INVALID_STATE", "Die Amazon-Anmeldung ist abgelaufen. Bitte neu starten.");
  let refreshToken: string;
  try {
    ({ refreshToken } = await exchangeAmazonAuthCode({ tokenUrl: new URL(LWA_TOKEN_URL), clientId: app.clientId, clientSecret: app.clientSecret, code: input.code, redirectUri: amazonRedirectUri(ctx), fetchImpl }));
  } catch (error) {
    throw new ServiceError(502, "AMAZON_ERROR", error instanceof HttpError || error instanceof Error ? error.message : String(error));
  }
  await withTx(ctx.db, async (tx) => {
    const existing = await loadConnection(tx, row.workspace_id);
    const secretId = await ctx.secrets.store(tx, row.workspace_id, "amazon_sp_api", JSON.stringify({ refreshToken } satisfies AmazonSecret));
    await tx.query(
      `INSERT INTO amazon_listing_connections (workspace_id, region, seller_id, marketplace_ids, client_id, secret_id, operator_app)
       VALUES ($1, $2, $3, $4, NULL, $5, true)
       ON CONFLICT (workspace_id) DO UPDATE SET region = EXCLUDED.region, seller_id = EXCLUDED.seller_id, marketplace_ids = EXCLUDED.marketplace_ids,
         client_id = NULL, operator_app = true, secret_id = EXCLUDED.secret_id, api_base_url = NULL, token_url = NULL,
         status = 'configured', last_error = NULL, updated_at = now()`,
      [row.workspace_id, row.region, sellerId, row.marketplace_ids, secretId],
    );
    if (existing) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [row.workspace_id, existing.secret_id]);
    await audit(tx, actor, existing ? "amazon_listings.reauthorized" : "amazon_listings.connected", "workspace", row.workspace_id, { region: row.region, marketplaceIds: row.marketplace_ids, operatorApp: true });
  });
  return { sellerIdHint: maskIdentifier(sellerId) };
}
