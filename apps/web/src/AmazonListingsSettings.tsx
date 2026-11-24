import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "./api.ts";
import { AMAZON_MARKETPLACES, AMAZON_REGION_LABEL, type AmazonRegion } from "../../../packages/core/amazon-marketplaces.ts";

/** sessionStorage key (and window event) for an authorization Amazon started in Seller Central. */
export const AMAZON_LOGIN_KEY = "supportx-amazon-login";

function pendingAmazonLogin(): { amazonCallbackUri: string; amazonState: string } | null {
  try {
    const raw = sessionStorage.getItem(AMAZON_LOGIN_KEY);
    return raw ? (JSON.parse(raw) as { amazonCallbackUri: string; amazonState: string }) : null;
  } catch {
    return null;
  }
}

type Settings =
  | { configured: false; oauthAvailable: boolean }
  | { configured: true; oauthAvailable: boolean; region: AmazonRegion; sellerIdHint: string; clientIdHint: string; marketplaceIds: string[]; status: string; lastCheckedAt: string | null; lastError: string | null; refundsEnabled: boolean };

/**
 * Settings card for the Amazon Selling Partner API access that lets a person
 * close a wrong offer from a case. Stored values are shown masked only; they can
 * be changed after clicking "Ändern".
 */
export function AmazonListingsCard({ base, owner }: { base: string; owner: boolean }) {
  const [data, setData] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [fromAmazon, setFromAmazon] = useState(pendingAmazonLogin);
  const load = useCallback(() => api<Settings>("GET", `${base}/amazon-listings`).then(setData, (e: Error) => setError(e.message)), [base]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const changed = () => { setFromAmazon(pendingAmazonLogin()); void load(); };
    window.addEventListener(AMAZON_LOGIN_KEY, changed);
    return () => window.removeEventListener(AMAZON_LOGIN_KEY, changed);
  }, [load]);
  // Opens Seller Central; Amazon comes back to /oauth/amazon/callback.
  const authorize = async (body: { region: AmazonRegion; marketplaceIds: string[] }) => {
    setError(null); setNotice(null);
    try {
      const r = await api<{ url: string }>("POST", `${base}/amazon-listings/authorize`, { ...body, ...(fromAmazon ?? {}) });
      try { sessionStorage.removeItem(AMAZON_LOGIN_KEY); } catch { /* ignore */ }
      window.location.assign(r.url);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => string) => {
    setError(null); setNotice(null);
    try {
      setNotice(ok(await fn()));
      setEditing(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!data) return null;
  const connected = data.configured && data.status === "ok";
  const pill = !data.configured ? { cls: "pill muted", label: "Nicht eingerichtet" } : data.status === "error" ? { cls: "pill bad", label: "Fehler" } : connected ? { cls: "pill ok", label: "Angebunden" } : { cls: "pill warn", label: "Noch nicht getestet" };
  return (
    <section className={`card setup${connected ? " connected" : ""}`} aria-label="Amazon-Angebote">
      <div className="setup-head">
        <div>
          <h3 className="setup-name">Amazon-Angebote</h3>
          <div className="muted small">Selling Partner API · falsches Angebot aus dem Fall deaktivieren</div>
        </div>
        <span className={pill.cls}>{pill.label}</span>
      </div>
      <p className="muted small">Hat ein Kunde recht, weil das Amazon-Angebot falsch ist, kann man es im Fall mit einem Klick und einer Bestätigung deaktivieren. Nie automatisch. Die SP-API-App braucht die Rolle „Product Listing“; der Verkäufer autorisiert sie einmal in Seller Central und erhält dabei den Refresh-Token.</p>
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className="notice ok small">{notice}</p>}
      {data.configured && !editing && (
        <>
          <div className="facts">
            <div className="kv"><span>Region</span><span>{AMAZON_REGION_LABEL[data.region]}</span></div>
            <div className="kv"><span>Marktplätze</span><span>{data.marketplaceIds.map((id) => AMAZON_MARKETPLACES.find((m) => m.id === id)?.label ?? id).join(", ")}</span></div>
            <div className="kv"><span>Verkäufer-ID</span><code>{data.sellerIdHint}</code></div>
            <div className="kv"><span>LWA Client-ID</span><code>{data.clientIdHint}</code></div>
            <div className="kv"><span>Client-Secret, Refresh-Token</span><span>hinterlegt</span></div>
            {data.lastCheckedAt && <div className="kv"><span>Geprüft</span><span>{fmtDate(data.lastCheckedAt)}</span></div>}
          </div>
          {data.lastError && <p className="notice bad small">{data.lastError}</p>}
          <div className="stack">
            <label className="row small">
              <input type="checkbox" checked={data.refundsEnabled} disabled={!owner}
                onChange={(e) => {
                  const on = e.target.checked;
                  if (on && !window.confirm("Erstattungen aus dem Fall freischalten? Dann kann jede Person mit Bearbeiten-Recht im Fall eine Erstattung bei Amazon auslösen, immer mit Bestätigung und nie mehr als bezahlt.")) return;
                  void run(() => api("PUT", `${base}/amazon-listings/refunds`, { enabled: on }), () => (on ? "Erstattungen freigeschaltet. Bitte einmal „Verbindung testen“: SupportX prüft dabei, ob Bestellungen lesbar sind." : "Erstattungen aus dem Fall ausgeschaltet."));
                }} />
              Erstattungen aus dem Fall erlauben
            </label>
            <span className="muted small">Gibt dem Kunden bei Amazon Geld zurück (Erstattung über die Bestellung). Braucht zusätzlich die Rolle „Inventory and Order Tracking“ in der SP-API-App; nach dem Hinzufügen der Rolle muss der Verkäufer die App neu autorisieren und den neuen Refresh-Token hier unter „Ändern“ eintragen.</span>
          </div>
          {owner && (
            <div className="row wrap">
              <button className={connected ? "" : "primary"} onClick={() => void run(() => api("POST", `${base}/amazon-listings/check`), (r) => { const x = r as { ok: boolean; detail: string }; return `${x.ok ? "Verbindung in Ordnung" : "Prüfung fehlgeschlagen"}: ${x.detail}`; })}>Verbindung testen</button>
              <button onClick={() => setEditing(true)}>Ändern</button>
              <button className="danger" onClick={() => { if (window.confirm("Amazon-Zugang entfernen? Angebote lassen sich dann nicht mehr aus dem Fall deaktivieren. Bei Amazon ändert sich nichts.")) void run(() => api("DELETE", `${base}/amazon-listings`), () => "Amazon-Zugang entfernt."); }}>Entfernen</button>
            </div>
          )}
        </>
      )}
      {owner && data.oauthAvailable && (fromAmazon || consent) && (
        <ConsentForm
          current={data.configured ? data : null}
          fromAmazon={!!fromAmazon}
          onCancel={() => { setConsent(false); setFromAmazon(null); try { sessionStorage.removeItem(AMAZON_LOGIN_KEY); } catch { /* ignore */ } }}
          onSubmit={(body) => void authorize(body)}
        />
      )}
      {owner && data.oauthAvailable && !fromAmazon && !consent && (!data.configured || !editing) && (
        <div className="row wrap">
          <button className={data.configured ? "" : "primary"} onClick={() => setConsent(true)}>{data.configured ? "Bei Amazon neu freigeben" : "Mit Amazon verbinden"}</button>
          <span className="muted small">Öffnet Seller Central. Nach der Freigabe trägt SupportX den Zugang selbst ein.</span>
        </div>
      )}
      {owner && (!data.configured || editing) && !consent && !fromAmazon && (
        <AmazonForm
          current={data.configured ? data : null}
          onCancel={data.configured ? () => setEditing(false) : undefined}
          onSubmit={(body) => void run(() => api("PUT", `${base}/amazon-listings`, body), () => "Gespeichert. Bitte einmal „Verbindung testen“.")}
        />
      )}
      {!owner && !data.configured && <p className="small muted">Nur Inhaber können den Zugang eintragen.</p>}
    </section>
  );
}

function AmazonForm({ current, onSubmit, onCancel }: {
  current: Extract<Settings, { configured: true }> | null; onSubmit: (body: Record<string, unknown>) => void; onCancel?: () => void;
}) {
  const [region, setRegion] = useState<AmazonRegion>(current?.region ?? "eu");
  const [markets, setMarkets] = useState<string[]>(current?.marketplaceIds ?? ["A1PA6795UKMFR9"]);
  const [sellerId, setSellerId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const keep = current ? "leer lassen = bleibt wie gespeichert" : undefined;
  const inRegion = AMAZON_MARKETPLACES.filter((m) => m.region === region);
  const toggle = (id: string) => setMarkets((ms) => (ms.includes(id) ? ms.filter((x) => x !== id) : [...ms, id]));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const only = (v: string) => (v.trim() ? v.trim() : undefined);
        onSubmit({ region, marketplaceIds: markets.filter((m) => inRegion.some((x) => x.id === m)), sellerId: only(sellerId), clientId: only(clientId), clientSecret: only(clientSecret), refreshToken: only(refreshToken) });
      }}
    >
      <label>Region
        <select value={region} onChange={(e) => setRegion(e.target.value as AmazonRegion)}>
          {(Object.keys(AMAZON_REGION_LABEL) as AmazonRegion[]).map((r) => <option key={r} value={r}>{AMAZON_REGION_LABEL[r]}</option>)}
        </select>
      </label>
      <fieldset className="stack">
        <legend className="small">Marktplätze, auf denen Angebote deaktiviert werden dürfen</legend>
        <div className="row wrap">
          {inRegion.map((m) => <label key={m.id} className="row small"><input type="checkbox" checked={markets.includes(m.id)} onChange={() => toggle(m.id)} /> {m.label}</label>)}
        </div>
      </fieldset>
      <label>Verkäufer-ID (Merchant Token, Seller Central → Einstellungen → Kontoinformationen → Händlertoken)
        <input value={sellerId} onChange={(e) => setSellerId(e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? `${current.sellerIdHint} (${keep})` : "z. B. A1B2C3D4E5F6G7"} required={!current} />
      </label>
      <label>LWA Client-ID der SP-API-App
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? `${current.clientIdHint} (${keep})` : "amzn1.application-oa2-client.…"} required={!current} />
      </label>
      <label>LWA Client-Secret
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? keep : "amzn1.oa2-cs.v1.…"} required={!current} />
      </label>
      <label>Refresh-Token aus der Autorisierung des Verkäufers
        <input type="password" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? keep : "Atzr|…"} required={!current} />
      </label>
      <p className="muted small">Client-Secret und Refresh-Token werden verschlüsselt gespeichert und nie wieder angezeigt. SupportX legt keine Zugangsdaten bei Amazon an und erneuert keine.</p>
      <div className="row">
        <button type="submit" className="primary">Speichern</button>
        {onCancel && <button type="button" onClick={onCancel}>Abbrechen</button>}
      </div>
    </form>
  );
}

function ConsentForm({ current, fromAmazon, onSubmit, onCancel }: {
  current: Extract<Settings, { configured: true }> | null; fromAmazon: boolean; onSubmit: (body: { region: AmazonRegion; marketplaceIds: string[] }) => void; onCancel: () => void;
}) {
  const [region, setRegion] = useState<AmazonRegion>(current?.region ?? "eu");
  const [markets, setMarkets] = useState<string[]>(current?.marketplaceIds ?? ["A1PA6795UKMFR9"]);
  const inRegion = AMAZON_MARKETPLACES.filter((m) => m.region === region);
  const toggle = (id: string) => setMarkets((ms) => (ms.includes(id) ? ms.filter((x) => x !== id) : [...ms, id]));
  const chosen = markets.filter((m) => inRegion.some((x) => x.id === m));
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); onSubmit({ region, marketplaceIds: chosen }); }}>
      <p className="small">{fromAmazon ? "Amazon hat die Freigabe in Seller Central gestartet. Wähle, für welche Marktplätze SupportX den Zugang nutzen darf, dann geht es zurück zu Amazon." : "Du wirst zu Seller Central weitergeleitet und gibst SupportX dort frei. Danach kommst du hierher zurück."}</p>
      <label>Region
        <select value={region} onChange={(e) => setRegion(e.target.value as AmazonRegion)}>
          {(Object.keys(AMAZON_REGION_LABEL) as AmazonRegion[]).map((r) => <option key={r} value={r}>{AMAZON_REGION_LABEL[r]}</option>)}
        </select>
      </label>
      <fieldset className="stack">
        <legend className="small">Marktplätze, auf denen SupportX den Zugang nutzen darf</legend>
        <div className="row wrap">
          {inRegion.map((m) => <label key={m.id} className="row small"><input type="checkbox" checked={markets.includes(m.id)} onChange={() => toggle(m.id)} /> {m.label}</label>)}
        </div>
      </fieldset>
      <div className="row">
        <button type="submit" className="primary" disabled={chosen.length === 0}>{fromAmazon ? "Freigabe fortsetzen" : "Weiter zu Amazon"}</button>
        <button type="button" onClick={onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}
