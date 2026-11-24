import { createHash, randomBytes } from "node:crypto";
import type { AmazonRegion } from "../core/amazon-marketplaces.ts";
import { AMAZON_CALLBACK_PATH, buildAmazonConsentUrl, buildAmazonLoginContinueUrl, exchangeAmazonCode } from "../connectors/amazon/oauth.ts";
import { HttpError } from "../connectors/http.ts";
import { operatorAmazonApp } from "../storage/config.ts";
import { one, withTx } from "../storage/db.ts";
import { checkedMarketplaces, loadConnection, writeAmazonConnection, type AmazonSecret } from "./amazon-listings.ts";
import { actorFor } from "./auth.ts";
import { parseSecret } from "./connections.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/**
 * "Mit Amazon verbinden": the owner authorizes the installation's SP-API app in
 * Seller Central and SupportX stores the refresh token Amazon hands back. Only
 * with the operator's app in the server's .env (AMAZON_SPAPI_APP_ID,
 * AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET); the form for a hand-entered
 * access stays for installations without it.
 */

const STATE_TTL_MS = 15 * 60_000;
const hashState = (state: string) => createHash("sha256").update(state).digest("hex");

function requireApp(ctx: AppContext) {
  const app = operatorAmazonApp(ctx.config);
  if (!app) throw new ServiceError(409, "NOT_CONFIGURED", "Für diese Installation ist keine Amazon-App hinterlegt (AMAZON_SPAPI_APP_ID, AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET in der .env des Servers). Den Zugang kann der Inhaber stattdessen von Hand eintragen.");
  return app;
}

export function amazonRedirectUri(ctx: AppContext): string {
  return `${ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, "")}${AMAZON_CALLBACK_PATH}`;
}

export interface StartAmazonConsentInput {
  region: string;
  marketplaceIds: string[];
  /** Only when Amazon opened the login URI (started in Seller Central / Appstore). */
  amazonCallbackUri?: string;
  amazonState?: string;
}

/** Start the consent. The state is single use, bound to this owner and workspace, valid for 15 minutes. */
export async function startAmazonConsent(ctx: AppContext, actor: Actor, input: StartAmazonConsentInput): Promise<{ url: string }> {
  requireRole(actor, ["owner"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Die Amazon-Freigabe startet nur ein Mensch.");
  const app = requireApp(ctx);
  const marketplaceIds = checkedMarketplaces(input.region, input.marketplaceIds);
  const fromAmazon = input.amazonCallbackUri !== undefined || input.amazonState !== undefined;
  if (fromAmazon && (!input.amazonCallbackUri || !input.amazonState)) throw new ServiceError(400, "INVALID", "Die Anfrage von Amazon ist unvollständig. Bitte die Freigabe in Seller Central neu starten.");
  const state = randomBytes(32).toString("base64url");
  const redirectUri = amazonRedirectUri(ctx);
  let url: string;
  try {
    url = fromAmazon
      ? buildAmazonLoginContinueUrl(app, { amazonCallbackUri: input.amazonCallbackUri!, amazonState: input.amazonState!, state, redirectUri })
      : buildAmazonConsentUrl(app, marketplaceIds[0]!, state, redirectUri);
  } catch (error) {
    throw new ServiceError(400, "INVALID", (error as Error).message);
  }
  await withTx(ctx.db, async (tx) => {
    await tx.query("DELETE FROM amazon_oauth_states WHERE expires_at < now()");
    await tx.query(
      "INSERT INTO amazon_oauth_states (workspace_id, user_id, state_hash, region, marketplace_ids, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [actor.workspaceId, actor.userId, hashState(state), input.region, marketplaceIds, new Date(Date.now() + STATE_TTL_MS)],
    );
  });
  return { url };
}

/**
 * Amazon's redirect: exchange the code and store the access for the workspace
 * the consent was started in. The signed-in owner who started it must finish it.
 * `test` points the token exchange at a local double (ALLOW_TEST_ENDPOINTS only).
 */
export async function completeAmazonConsent(
  ctx: AppContext,
  userId: string,
  input: { state: string; code: string; sellingPartnerId: string },
  test: { tokenUrl?: string; apiBaseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ workspaceId: string; sellerIdHint: string }> {
  const app = requireApp(ctx);
  const sellerId = input.sellingPartnerId?.trim() ?? "";
  if (!input.state || !input.code || !/^[A-Z0-9]{8,20}$/.test(sellerId)) throw new ServiceError(400, "INVALID", "Antwort von Amazon unvollständig.");
  // Single use: the state is removed before Amazon is asked.
  const pending = await one<{ workspace_id: string; user_id: string; region: AmazonRegion; marketplace_ids: string[]; expires_at: Date }>(
    ctx.db,
    "DELETE FROM amazon_oauth_states WHERE state_hash = $1 RETURNING workspace_id, user_id, region, marketplace_ids, expires_at",
    [hashState(input.state)],
  );
  if (!pending) throw new ServiceError(400, "INVALID_STATE", "Diese Amazon-Freigabe ist unbekannt oder wurde schon verwendet. Bitte neu starten.");
  if (pending.user_id !== userId) throw new ServiceError(403, "FORBIDDEN", "Bitte die Amazon-Freigabe im selben angemeldeten Konto abschließen, in dem sie gestartet wurde.");
  if (new Date(pending.expires_at).getTime() < Date.now()) throw new ServiceError(400, "INVALID_STATE", "Die Amazon-Freigabe ist abgelaufen. Bitte neu starten.");
  const actor = await actorFor(ctx.db, userId, pending.workspace_id).catch(() => null);
  if (!actor) throw new ServiceError(403, "FORBIDDEN", "Kein Zugriff mehr auf diesen Arbeitsbereich.");
  requireRole(actor, ["owner"]);
  let refreshToken: string;
  try {
    ({ refreshToken } = await exchangeAmazonCode(app, { code: input.code, redirectUri: amazonRedirectUri(ctx), tokenUrl: test.tokenUrl, allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS, fetchImpl: test.fetchImpl }));
  } catch (error) {
    if (error instanceof HttpError) throw new ServiceError(502, "AMAZON_OAUTH_FAILED", error.message);
    throw error;
  }
  await withTx(ctx.db, async (tx) => {
    const existing = await loadConnection(tx, pending.workspace_id);
    const old = existing ? parseSecret<AmazonSecret>(await ctx.secrets.read(tx, pending.workspace_id, existing.secret_id), "Amazon") : null;
    await writeAmazonConnection(ctx, tx, actor, existing, old, {
      region: pending.region,
      sellerId,
      marketplaceIds: pending.marketplace_ids,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken,
      apiBaseUrl: test.apiBaseUrl ?? null,
      tokenUrl: test.tokenUrl ?? null,
    }, "consent");
  });
  return { workspaceId: pending.workspace_id, sellerIdHint: `${sellerId.slice(0, 4)}…${sellerId.slice(-3)}` };
}
