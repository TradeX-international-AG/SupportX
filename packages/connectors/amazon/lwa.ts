import { HttpError, requestJson } from "../http.ts";

/**
 * Login with Amazon: exchanges the seller's refresh token for an access token
 * (valid about one hour) and keeps it until shortly before it expires. Shared by
 * the SP-API clients (listings, refunds).
 */
export class LwaToken {
  readonly #url: URL;
  readonly #form: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #fetchImpl?: typeof fetch;
  #access: { token: string; expiresAt: number } | null = null;

  constructor(opts: { tokenUrl: URL; clientId: string; clientSecret: string; refreshToken: string; timeoutMs: number; fetchImpl?: typeof fetch }) {
    this.#url = opts.tokenUrl;
    this.#form = { grant_type: "refresh_token", refresh_token: opts.refreshToken, client_id: opts.clientId, client_secret: opts.clientSecret };
    this.#timeoutMs = opts.timeoutMs;
    this.#fetchImpl = opts.fetchImpl;
  }

  async get(): Promise<string> {
    if (this.#access && this.#access.expiresAt > Date.now() + 60_000) return this.#access.token;
    let res: unknown;
    try {
      res = await requestJson(this.#url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams(this.#form).toString(), timeoutMs: this.#timeoutMs, fetchImpl: this.#fetchImpl });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 400 || error.status === 401)) {
        // Not a send: a failed token request never changed anything at Amazon.
        throw new HttpError(`Anmeldung bei Amazon fehlgeschlagen: Client-ID, Client-Secret oder Refresh-Token passen nicht (${error.message}).`, error.status, false, false);
      }
      throw new HttpError(error instanceof Error ? error.message : String(error), error instanceof HttpError ? error.status : 0, true, false);
    }
    const body = (res && typeof res === "object" ? res : {}) as Record<string, unknown>;
    const token = typeof body.access_token === "string" && body.access_token ? body.access_token : undefined;
    if (!token) throw new HttpError("Amazon lieferte kein Zugriffstoken.", 502, false);
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.#access = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }
}
