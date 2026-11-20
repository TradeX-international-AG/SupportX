import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "./api.ts";
import { carrierChip, type CarrierTrackingResult, type ParcelTarget } from "../../../packages/core/carrier-tracking.ts";

type Settings =
  | { configured: false }
  | { configured: true; keyHint: string; status: string; lastCheckedAt: string | null; lastError: string | null };

const TONE: Record<string, string> = { good: "ok", warn: "warn", bad: "bad", neutral: "muted" };

/**
 * Settings card for the DHL Shipment Tracking API key. The stored key is shown
 * only as "••••abcd" and can be replaced after clicking "Ändern".
 */
export function DhlTrackingCard({ base, owner }: { base: string; owner: boolean }) {
  const [data, setData] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<Settings>("GET", `${base}/dhl-tracking`).then(setData, (e: Error) => setError(e.message)), [base]);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => string) => {
    setError(null); setNotice(null);
    try {
      setNotice(ok(await fn()));
      setEditing(false);
      setApiKey("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!data) return null;
  const connected = data.configured && data.status === "ok";
  const pill = !data.configured ? { cls: "pill muted", label: "Nicht eingerichtet" } : data.status === "error" ? { cls: "pill bad", label: "Fehler" } : connected ? { cls: "pill ok", label: "Angebunden" } : { cls: "pill warn", label: "Noch nicht getestet" };
  return (
    <section className={`card setup${connected ? " connected" : " unconnected"}`} aria-label="DHL-Sendungsstatus">
      <div className="setup-head">
        <div>
          <h3 className="setup-name">DHL-Sendungsstatus</h3>
          <div className="muted small">Shipment Tracking API · im Fall sehen, ob das Paket angekommen ist</div>
        </div>
        <span className={pill.cls}>{pill.label}</span>
      </div>
      <p className="muted small">SupportX fragt DHL nach dem Status der Sendungsnummern aus weclapp und der Nummern, die der Kunde schreibt (z. B. bei einer Rücksendung). Abgefragt wird beim Öffnen des Falls und per Klick, nur lesend. Den API-Key gibt es kostenlos im DHL-Entwicklerportal (developer.dhl.com) unter „Apps“ für die API „Shipment Tracking – Unified“.</p>
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className="notice ok small">{notice}</p>}
      {data.configured && !editing && (
        <>
          <div className="facts">
            <div className="kv"><span>API-Key</span><code>{data.keyHint}</code></div>
            {data.lastCheckedAt && <div className="kv"><span>Geprüft</span><span>{fmtDate(data.lastCheckedAt)}</span></div>}
          </div>
          {data.lastError && <p className="notice bad small">{data.lastError}</p>}
          {owner && (
            <div className="row wrap">
              <button className={connected ? "" : "primary"} onClick={() => void run(() => api("POST", `${base}/dhl-tracking/check`), (r) => { const x = r as { ok: boolean; detail: string }; return `${x.ok ? "Verbindung in Ordnung" : "Prüfung fehlgeschlagen"}: ${x.detail}`; })}>Verbindung testen</button>
              <button onClick={() => setEditing(true)}>Ändern</button>
              <button className="danger" onClick={() => { if (window.confirm("DHL-Zugang entfernen? Im Fall steht dann kein DHL-Status mehr.")) void run(() => api("DELETE", `${base}/dhl-tracking`), () => "DHL-Zugang entfernt."); }}>Entfernen</button>
            </div>
          )}
        </>
      )}
      {owner && (!data.configured || editing) && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(() => api("PUT", `${base}/dhl-tracking`, { apiKey: apiKey.trim() }), () => "Gespeichert. Bitte einmal „Verbindung testen“."); }}>
          <label>API-Key (DHL-Entwicklerportal → Apps → deine App → „Show key“)
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} required placeholder={data.configured ? `${data.keyHint} wird ersetzt` : "API-Key, nicht das API-Secret"} />
          </label>
          <p className="muted small">Der Key wird verschlüsselt gespeichert und nie wieder angezeigt. Ein neuer Key hat bei DHL anfangs 250 Abrufe am Tag; mehr gibt es im Portal über „Request upgrade“.</p>
          <div className="row">
            <button type="submit" className="primary">Speichern</button>
            {data.configured && <button type="button" onClick={() => { setEditing(false); setApiKey(""); }}>Abbrechen</button>}
          </div>
        </form>
      )}
      {!owner && !data.configured && <p className="small muted">Nur Inhaber können den Zugang eintragen.</p>}
    </section>
  );
}

interface Tracking {
  connected: boolean;
  parcels: Array<{ target: ParcelTarget; result?: CarrierTrackingResult }>;
  limited?: boolean;
}

/**
 * Case card: DHL's own status per parcel (weclapp deliveries and numbers the
 * customer wrote). Opening the case asks DHL only for numbers without a fresh
 * answer; "Neu bei DHL abrufen" asks again.
 */
export function ParcelTrackingCard({ base, caseId, refreshKey, canEdit }: { base: string; caseId: string; refreshKey: string; canEdit: boolean }) {
  const [data, setData] = useState<Tracking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const fetchStatus = useCallback(async (force: boolean) => {
    setBusy(true); setError(null);
    try {
      setData(await api<Tracking>("POST", `${base}/cases/${caseId}/parcel-tracking`, { force }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [base, caseId]);
  useEffect(() => { void fetchStatus(false); }, [fetchStatus, refreshKey]);

  if (!data && !error) return null;
  if (data && data.parcels.length === 0) return null;
  return (
    <section className="card" aria-label="Zustellung laut DHL">
      <div className="row wrap"><h3>Zustellung laut DHL</h3></div>
      {error && <p className="notice bad small">{error}</p>}
      {data && !data.connected && (
        <p className="small muted">{data.parcels.length === 1 ? "Eine Sendungsnummer ist" : `${data.parcels.length} Sendungsnummern sind`} da. Mit einem DHL-API-Key (Einstellungen → Anbindungen → DHL-Sendungsstatus) steht hier, ob das Paket angekommen ist.</p>
      )}
      {data?.connected && (
        <ul className="parcel-status">
          {data.parcels.map(({ target, result }) => {
            const chip = result ? carrierChip(result) : { label: busy ? "wird abgefragt" : "noch nicht abgefragt", tone: "neutral" };
            const when = result?.state === "found" ? (result.statusCode === "delivered" ? result.deliveredAt ?? result.statusAt : result.statusAt) : undefined;
            return (
              <li key={target.trackingNumber} className="small">
                <div className="row wrap">
                  <code>{target.trackingNumber}</code>
                  <span className={`pill ${TONE[chip.tone]}`}>{chip.label}</span>
                  {when && <span className="muted">{fmtDate(when)}</span>}
                </div>
                <div className="muted">{target.label}{result?.location ? ` · ${result.location}` : ""}</div>
                {result?.state === "found" && (result.description || result.status) && <div>{result.description || result.status}</div>}
                {result?.state === "found" && result.statusCode !== "delivered" && result.estimatedDelivery && <div className="muted">Voraussichtlich laut DHL: {fmtDate(result.estimatedDelivery)}</div>}
                {result?.error && <div className="warn-text">{result.error}</div>}
                {result && result.events.length > 1 && (
                  <button className="link small" onClick={() => setOpen(open === target.trackingNumber ? null : target.trackingNumber)}>{open === target.trackingNumber ? "Verlauf ausblenden" : `Verlauf (${result.events.length})`}</button>
                )}
                {open === target.trackingNumber && result && (
                  <ol className="muted">
                    {result.events.map((e, i) => <li key={i}>{fmtDate(e.at)} · {e.description || e.status || e.statusCode}{e.location ? ` · ${e.location}` : ""}</li>)}
                  </ol>
                )}
                {result && <div className="muted">Abgefragt {fmtDate(result.fetchedAt)}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {data?.limited && <p className="small warn-text">DHL-Tageslimit erreicht. Die übrigen Nummern fragt SupportX beim nächsten Öffnen ab.</p>}
      {data?.connected && canEdit && (
        <button disabled={busy} onClick={() => void fetchStatus(true)} title="Fragt den Status bei DHL neu ab (nur lesend, höchstens alle 5 Minuten je Nummer).">{busy ? "Fragt DHL …" : "Neu bei DHL abrufen"}</button>
      )}
      <p className="muted small">Status, wie DHL ihn meldet. „Zugestellt“ heißt: DHL hat die Zustellung gescannt.</p>
    </section>
  );
}
