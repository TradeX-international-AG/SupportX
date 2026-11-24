import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { checkAmazonListingConnection, getAmazonListingSettings, saveAmazonListingConnection } from "../../packages/services/amazon-listings.ts";
import { completeAmazonConsent, startAmazonConsent } from "../../packages/services/amazon-oauth.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { many, one } from "../../packages/storage/db.ts";
import { startFakeAmazon, type FakeAmazon } from "../../packages/testing/fake-amazon.ts";
import { buildServer } from "../../apps/server/app.ts";
import { closeDb, createHarness, seedWorkspace, type Harness } from "./harness.ts";

// Synthetic identifiers only.
const APP = { appId: "amzn1.sp.solution.00000000-test-0000-0000-000000000000", clientId: "amzn1.application-oa2-client.operator000000000000", clientSecret: "amzn1.oa2-cs.v1.operator-secret-value" };
const SELLER = "A1TESTSELLER01";
const REFRESH = "Atzr|consent-refresh-token-value";
const DE = "A1PA6795UKMFR9";
const FR = "A13V1IB3VIYZZH";
const BASE = "https://support.example.com";
const REDIRECT = `${BASE}/oauth/amazon/callback`;
const ENV = { AMAZON_SPAPI_APP_ID: APP.appId, AMAZON_LWA_CLIENT_ID: APP.clientId, AMAZON_LWA_CLIENT_SECRET: APP.clientSecret, PUBLIC_BASE_URL: BASE };

let h: Harness | null = null;
let amz: FakeAmazon | null = null;
afterEach(async () => {
  await h?.close();
  await amz?.close();
  h = null;
  amz = null;
});
after(closeDb);

const code = (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: ServiceError) => e.code === expected);
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

async function setup(env: Record<string, string> = ENV, authCode = "ANcode-1") {
  h = await createHarness({ env });
  amz = await startFakeAmazon({ sellerId: SELLER, clientId: APP.clientId, clientSecret: APP.clientSecret, refreshToken: REFRESH, listings: [], authorization: { code: authCode, redirectUri: REDIRECT } });
  const s = await seedWorkspace(h);
  return { h, amz, s };
}

describe("Mit Amazon verbinden (SP-API website authorization)", () => {
  it("sends the owner to Seller Central, stores the refresh token once and the access works", async () => {
    const { h, amz, s } = await setup();
    assert.equal((await getAmazonListingSettings(h.ctx, s.owner)).oauthAvailable, true);
    await code(startAmazonConsent(h.ctx, s.agent, { region: "eu", marketplaceIds: [DE] }), "FORBIDDEN");
    await code(startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: ["ATVPDKIKX0DER"] }), "INVALID");

    const { url } = await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE, FR] });
    const u = new URL(url);
    assert.equal(u.origin, "https://sellercentral.amazon.de");
    assert.equal(u.pathname, "/apps/authorize/consent");
    assert.equal(u.searchParams.get("application_id"), APP.appId);
    assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(u.searchParams.get("version"), null, "published app: no beta");
    assert.ok(!url.includes(APP.clientSecret) && !url.includes(APP.clientId));
    const state = stateOf(url);
    const stored = await one<{ state_hash: string }>(h.ctx.db, "SELECT state_hash FROM amazon_oauth_states");
    assert.notEqual(stored!.state_hash, state, "state stored hashed only");

    // Another user of the workspace cannot finish the owner's consent.
    await code(completeAmazonConsent(h.ctx, s.agent.type === "user" ? s.agent.userId : "", { state, code: "ANcode-1", sellingPartnerId: SELLER }, { tokenUrl: amz.tokenUrl, apiBaseUrl: amz.url }), "FORBIDDEN");
    // That attempt used up the state: single use.
    await code(completeAmazonConsent(h.ctx, s.ownerUserId, { state, code: "ANcode-1", sellingPartnerId: SELLER }, { tokenUrl: amz.tokenUrl, apiBaseUrl: amz.url }), "INVALID_STATE");

    const again = stateOf((await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE, FR] })).url);
    const r = await completeAmazonConsent(h.ctx, s.ownerUserId, { state: again, code: "ANcode-1", sellingPartnerId: SELLER }, { tokenUrl: amz.tokenUrl, apiBaseUrl: amz.url });
    assert.equal(r.workspaceId, s.workspaceId);
    assert.ok(!r.sellerIdHint.includes(SELLER));
    const view = await getAmazonListingSettings(h.ctx, s.owner);
    assert.ok(view.configured && view.region === "eu" && view.marketplaceIds.join() === [DE, FR].join());
    for (const secret of [REFRESH, APP.clientSecret, SELLER]) assert.ok(!JSON.stringify(view).includes(secret));
    const secrets = await many<{ ciphertext: Buffer }>(h.ctx.db, "SELECT ciphertext FROM secrets WHERE workspace_id = $1", [s.workspaceId]);
    assert.ok(secrets.every((x) => !x.ciphertext.toString("utf8").includes("Atzr|")), "refresh token encrypted at rest");
    const audit = await one<{ details: { via: string } }>(h.ctx.db, "SELECT details FROM audit_events WHERE workspace_id = $1 AND action = 'amazon_listings.connected'", [s.workspaceId]);
    assert.equal(audit?.details.via, "consent");
    assert.equal((await checkAmazonListingConnection(h.ctx, s.owner)).ok, true, "the stored token works against the API");
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM amazon_oauth_states")).length, 0);
  });

  it("continues an authorization Amazon started in Seller Central, only towards Seller Central", async () => {
    const { h, s } = await setup({ ...ENV, AMAZON_SPAPI_DRAFT: "true" });
    const cb = "https://sellercentral.amazon.de/apps/authorize/confirm/amzn1.sp.solution.x";
    const { url } = await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE], amazonCallbackUri: cb, amazonState: "amz-state-1" });
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, cb);
    assert.equal(u.searchParams.get("amazon_state"), "amz-state-1");
    assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(u.searchParams.get("version"), "beta", "draft app");
    assert.ok(u.searchParams.get("state"));
    for (const bad of ["https://evil.example.com/apps/authorize/confirm", "http://sellercentral.amazon.de/x", "https://sellercentral.amazon.de.evil.example/x", "https://u:p@sellercentral.amazon.de/x"]) {
      await code(startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE], amazonCallbackUri: bad, amazonState: "s" }), "INVALID");
    }
    await code(startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE], amazonCallbackUri: cb }), "INVALID");
  });

  it("rejects a wrong or expired code and keeps an existing access", async () => {
    const { h, amz, s } = await setup();
    await saveAmazonListingConnection(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE], sellerId: SELLER, clientId: APP.clientId, clientSecret: APP.clientSecret, refreshToken: "Atzr|hand-entered", apiBaseUrl: amz.url, tokenUrl: amz.tokenUrl });
    const state = stateOf((await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE] })).url);
    await code(completeAmazonConsent(h.ctx, s.ownerUserId, { state, code: "wrong", sellingPartnerId: SELLER }, { tokenUrl: amz.tokenUrl }), "AMAZON_OAUTH_FAILED");
    assert.equal((await one<{ n: number }>(h.ctx.db, "SELECT count(*)::int AS n FROM amazon_listing_connections WHERE status = 'configured'"))!.n, 1, "hand-entered access untouched");

    const expired = stateOf((await startAmazonConsent(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE] })).url);
    await h.ctx.db.query("UPDATE amazon_oauth_states SET expires_at = now() - interval '1 minute'");
    await code(completeAmazonConsent(h.ctx, s.ownerUserId, { state: expired, code: "ANcode-1", sellingPartnerId: SELLER }, { tokenUrl: amz.tokenUrl }), "INVALID_STATE");
    await code(completeAmazonConsent(h.ctx, s.ownerUserId, { state: "x", code: "ANcode-1", sellingPartnerId: "not a seller" }), "INVALID");
  });

  it("stays off without the operator app in the .env", async () => {
    const plain = await setup({});
    assert.equal((await getAmazonListingSettings(plain.h.ctx, plain.s.owner)).oauthAvailable, false);
    await code(startAmazonConsent(plain.h.ctx, plain.s.owner, { region: "eu", marketplaceIds: [DE] }), "NOT_CONFIGURED");
  });

  it("login and callback URIs hand over to the web app, which finishes with the session", async () => {
    const { h } = await setup();
    const app = await buildServer(h.ctx);
    try {
      const login = await app.inject({ method: "GET", url: "/oauth/amazon/login?amazon_callback_uri=https%3A%2F%2Fsellercentral.amazon.de%2Fapps%2Fauthorize%2Fconfirm&amazon_state=abc&selling_partner_id=A1TESTSELLER01" });
      assert.equal(login.statusCode, 302);
      const l = new URL(login.headers.location as string, BASE);
      assert.equal(l.pathname, "/");
      assert.equal(l.searchParams.get("amazon_callback_uri"), "https://sellercentral.amazon.de/apps/authorize/confirm");
      assert.equal(l.searchParams.get("amazon_state"), "abc");
      const cb = await app.inject({ method: "GET", url: "/oauth/amazon/callback?spapi_oauth_code=ANcode&state=st&selling_partner_id=A1TESTSELLER01" });
      const c = new URL(cb.headers.location as string, BASE);
      assert.equal(c.searchParams.get("amazon_code"), "ANcode");
      assert.equal(c.searchParams.get("amazon_oauth_state"), "st");
      const denied = await app.inject({ method: "GET", url: "/oauth/amazon/callback?error=access_denied" });
      assert.equal(new URL(denied.headers.location as string, BASE).searchParams.get("amazon_error"), "access_denied");
      const complete = await app.inject({ method: "POST", url: "/api/oauth/amazon/complete", headers: { "x-supportx-request": "1" }, payload: { code: "a", state: "b", sellingPartnerId: SELLER } });
      assert.equal(complete.statusCode, 401, "finishing needs the signed-in session");
    } finally {
      await app.close();
    }
  });
});
