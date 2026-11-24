import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { amazonClientConfig, getAmazonListingSettings, loadConnection, saveAmazonListingConnection } from "../../packages/services/amazon-listings.ts";
import { completeAmazonConsent, continueAmazonConsent, startAmazonConsent } from "../../packages/services/amazon-oauth.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { one } from "../../packages/storage/db.ts";
import { closeDb, createHarness, seedWorkspace, type Harness } from "./harness.ts";

// Synthetic identifiers only.
const OPERATOR = { AMAZON_SP_APP_ID: "amzn1.sp.solution.test-app", AMAZON_SP_CLIENT_ID: "amzn1.application-oa2-client.operator", AMAZON_SP_CLIENT_SECRET: "amzn1.oa2-cs.v1.operator-secret", AMAZON_SP_APP_DRAFT: true };
const DE = "A1PA6795UKMFR9";
const SELLER = "A1TESTSELLER01";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const code = (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: ServiceError) => e.code === expected);

/** Stands in for api.amazon.com: records the form and answers with a refresh token. */
function fakeLwa(seen: URLSearchParams[], status = 200): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new URLSearchParams(String(init?.body)));
    const body = status === 200 ? { access_token: "Atza|access", refresh_token: "Atzr|operator-refresh", token_type: "bearer", expires_in: 3600 } : { error: "invalid_grant" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("Bei Amazon anmelden (App der Installation)", () => {
  it("runs consent, login step and redirect, keeps the keyset in .env and stores only the refresh token", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const cfg = h.ctx.config as unknown as Record<string, unknown>;
    const agentId = (s.agent as { userId: string }).userId;

    // Without the operator app the merchant form stays the only way.
    assert.equal((await getAmazonListingSettings(h.ctx, s.owner)).operatorApp, false);
    await code(startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE] }), "AMAZON_APP_MISSING");

    Object.assign(cfg, OPERATOR);
    assert.equal((await getAmazonListingSettings(h.ctx, s.owner)).operatorApp, true);
    await code(startAmazonConsent(h.ctx, s.agent, { region: "eu", marketplaceIds: [DE] }), "FORBIDDEN");
    await code(startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: ["ATVPDKIKX0DER"] }), "INVALID");

    const consent = new URL(await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE] }));
    assert.equal(consent.origin, "https://sellercentral-europe.amazon.com");
    assert.equal(consent.pathname, "/apps/authorize/consent");
    assert.equal(consent.searchParams.get("application_id"), OPERATOR.AMAZON_SP_APP_ID);
    assert.equal(consent.searchParams.get("version"), "beta");
    assert.ok(!consent.toString().includes(OPERATOR.AMAZON_SP_CLIENT_SECRET));

    // Login step: only Seller Central may be the way back.
    await code(continueAmazonConsent(h.ctx, s.ownerUserId, { amazonCallbackUri: "https://evil.example/apps/authorize/confirm", amazonState: "x" }), "INVALID");
    await code(continueAmazonConsent(h.ctx, agentId, { amazonCallbackUri: "https://sellercentral-europe.amazon.com/apps/authorize/confirm/x", amazonState: "amz" }), "INVALID_STATE");
    const back = new URL(await continueAmazonConsent(h.ctx, s.ownerUserId, { amazonCallbackUri: "https://sellercentral-europe.amazon.com/apps/authorize/confirm/amzn1.sp.solution.test-app", amazonState: "amz-state-1" }));
    assert.equal(back.hostname, "sellercentral-europe.amazon.com");
    assert.equal(back.searchParams.get("amazon_state"), "amz-state-1");
    assert.equal(back.searchParams.get("redirect_uri"), "http://localhost:3000/oauth/amazon/callback");
    assert.equal(back.searchParams.get("version"), "beta");
    const state = back.searchParams.get("state")!;
    assert.ok(state && state !== consent.searchParams.get("state"));

    // Another signed-in person cannot finish it.
    await code(completeAmazonConsent(h.ctx, agentId, { code: "c", state, sellingPartnerId: SELLER }, fakeLwa([])), "FORBIDDEN");

    const seen: URLSearchParams[] = [];
    const done = await completeAmazonConsent(h.ctx, s.ownerUserId, { code: "spapi-code-1", state, sellingPartnerId: SELLER }, fakeLwa(seen));
    assert.ok(done.sellerIdHint.includes("…") && !done.sellerIdHint.includes(SELLER));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.get("grant_type"), "authorization_code");
    assert.equal(seen[0]!.get("code"), "spapi-code-1");
    assert.equal(seen[0]!.get("client_id"), OPERATOR.AMAZON_SP_CLIENT_ID);
    assert.equal(seen[0]!.get("redirect_uri"), "http://localhost:3000/oauth/amazon/callback");

    // Single use.
    await code(completeAmazonConsent(h.ctx, s.ownerUserId, { code: "spapi-code-1", state, sellingPartnerId: SELLER }, fakeLwa([])), "INVALID_STATE");

    const row = (await loadConnection(h.ctx.db, s.workspaceId))!;
    assert.equal(row.operator_app, true);
    assert.equal(row.client_id, null);
    assert.equal(row.seller_id, SELLER);
    assert.deepEqual(row.marketplace_ids, [DE]);
    const stored = (await one<{ ciphertext: Buffer }>(h.ctx.db, "SELECT ciphertext FROM secrets WHERE id = $1", [row.secret_id]))!;
    assert.ok(!stored.ciphertext.toString("utf8").includes("Atzr|"), "refresh token encrypted at rest");
    const client = await amazonClientConfig(h.ctx, h.ctx.db, row);
    assert.equal(client.clientId, OPERATOR.AMAZON_SP_CLIENT_ID);
    assert.equal(client.clientSecret, OPERATOR.AMAZON_SP_CLIENT_SECRET);
    assert.equal(client.refreshToken, "Atzr|operator-refresh");

    const view = await getAmazonListingSettings(h.ctx, s.owner);
    assert.ok(view.configured && view.viaOperatorApp && view.clientIdHint === null);
    assert.ok(!JSON.stringify(view).includes(OPERATOR.AMAZON_SP_CLIENT_ID));

    // Keyset removed from the server: reported, not guessed.
    Object.assign(cfg, { AMAZON_SP_APP_ID: undefined, AMAZON_SP_CLIENT_ID: undefined, AMAZON_SP_CLIENT_SECRET: undefined });
    await code(amazonClientConfig(h.ctx, h.ctx.db, row), "AMAZON_APP_MISSING");

    // A self-hoster's own app replaces it; then client ID and secret are required again.
    await code(saveAmazonListingConnection(h.ctx, s.owner, { refreshToken: "Atzr|own" }), "INVALID");
    await saveAmazonListingConnection(h.ctx, s.owner, { clientId: "amzn1.application-oa2-client.own", clientSecret: "amzn1.oa2-cs.v1.own", refreshToken: "Atzr|own" });
    const own = (await loadConnection(h.ctx.db, s.workspaceId))!;
    assert.equal(own.operator_app, false);
    assert.equal((await amazonClientConfig(h.ctx, h.ctx.db, own)).clientSecret, "amzn1.oa2-cs.v1.own");
  });

  it("refuses an expired consent and a rejected code without storing anything", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    Object.assign(h.ctx.config as unknown as Record<string, unknown>, OPERATOR, { AMAZON_SP_APP_DRAFT: false });
    const consent = new URL(await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE] }));
    assert.equal(consent.searchParams.get("version"), null);
    const state = consent.searchParams.get("state")!;

    await code(completeAmazonConsent(h.ctx, s.ownerUserId, { code: "bad", state, sellingPartnerId: SELLER }, fakeLwa([], 400)), "AMAZON_ERROR");
    assert.equal(await loadConnection(h.ctx.db, s.workspaceId), null);

    await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE] });
    await h.ctx.db.query("UPDATE amazon_oauth_states SET expires_at = now() - interval '1 minute'");
    const again = new URL(await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE] }));
    await h.ctx.db.query("UPDATE amazon_oauth_states SET expires_at = now() - interval '1 minute'");
    await code(completeAmazonConsent(h.ctx, s.ownerUserId, { code: "c", state: again.searchParams.get("state")!, sellingPartnerId: SELLER }, fakeLwa([])), "INVALID_STATE");
    assert.equal(await loadConnection(h.ctx.db, s.workspaceId), null);
  });
});
