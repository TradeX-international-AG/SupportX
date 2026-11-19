import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "./api.ts";

type Settings =
  | { configured: false }
  | { configured: true; keyHint: string; sandbox: boolean; status: string; lastCheckedAt: string | null; lastError: string | null };

/**
 * OTTO API access inside the OTTO card. OTTO has no API for customer messages
 * (they come by mail), so the key is only used to read the order status in the
 * case. Stored credentials are shown masked and replaced only after "Ändern".
 */
export function OttoApiSection({ base, owner }: { base: string; owner: boolean }) {
  const [data, setData] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ clientId: "", clientSecret: "", sandbox: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<Settings>("GET", `${base}/otto-api`).then(setData, (e: Error) => setError(e.message)), [base]);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => string) => {
    setError(null); setNotice(null);
    try {
      setNotice(ok(await fn()));
      setEditing(false);
      setForm({ clientId: "", clientSecret: "", sandbox: false });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!data) return null;
  const pill = !data.configured ? { cls: "pill muted", label: "Nicht eingetragen" } : data.status === "error" ? { cls: "pill bad", label: "Fehler" } : data.status === "ok" ? { cls: "pill ok", label: "Geprüft" } : { cls: "pill warn", label: "Noch nicht getestet" };
  return (
    <div className="stack inset" aria-label="OTTO-Schnittstelle">
      <div className="row wrap"><strong>Bestellstatus per OTTO-Schnittstelle</strong><span className={pill.cls}>{pill.label}</span></div>
      <p className="muted small">Optional. Damit zeigt der Fall per Klick, was OTTO selbst zur Bestellung meldet (je Artikel: zu versenden, versendet, zurückgeschickt, storniert). Nur lesend. In OTTO Partner Connect unter „Apps“ eine eigene App mit dem Bereich „Orders“ anlegen und Client-ID und Client-Secret hier eintragen. Das Secret zeigt OTTO nur einmal an.</p>
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className="notice ok small">{notice}</p>}
      {data.configured && !editing && (
        <>
          <div className="facts">
            <div className="kv"><span>Zugang</span><code>{data.keyHint}</code></div>
            {data.sandbox && <div className="kv"><span>Umgebung</span><span>Sandbox</span></div>}
            {data.lastCheckedAt && <div className="kv"><span>Geprüft</span><span>{fmtDate(data.lastCheckedAt)}</span></div>}
          </div>
          {data.lastError && <p className="notice bad small">{data.lastError}</p>}
          {owner && (
            <div className="row wrap">
              <button className={data.status === "ok" ? "" : "primary"} onClick={() => void run(() => api("POST", `${base}/otto-api/check`), (r) => { const x = r as { ok: boolean; detail: string }; return `${x.ok ? "Verbindung in Ordnung" : "Prüfung fehlgeschlagen"}: ${x.detail}`; })}>Verbindung testen</button>
              <button onClick={() => setEditing(true)}>Ändern</button>
              <button className="danger" onClick={() => { if (window.confirm("OTTO-Zugang entfernen? Im Fall lässt sich der Bestellstatus dann nicht mehr bei OTTO nachsehen.")) void run(() => api("DELETE", `${base}/otto-api`), () => "OTTO-Zugang entfernt."); }}>Entfernen</button>
            </div>
          )}
        </>
      )}
      {owner && (!data.configured || editing) && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(() => api("PUT", `${base}/otto-api`, { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim(), sandbox: form.sandbox }), () => "Gespeichert. Bitte einmal „Verbindung testen“."); }}>
          <label>Client-ID<input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} autoComplete="off" spellCheck={false} required /></label>
          <label>Client-Secret<input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="off" spellCheck={false} required placeholder={data.configured ? "das gespeicherte Secret wird ersetzt" : ""} /></label>
          <label className="row small"><input type="checkbox" checked={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} /> Sandbox-App (nur zum Testen)</label>
          <p className="muted small">Die Zugangsdaten werden verschlüsselt gespeichert; angezeigt wird danach nur noch ein gekürzter Hinweis.</p>
          <div className="row">
            <button type="submit" className="primary">Speichern</button>
            {data.configured && <button type="button" onClick={() => { setEditing(false); setForm({ clientId: "", clientSecret: "", sandbox: false }); }}>Abbrechen</button>}
          </div>
        </form>
      )}
    </div>
  );
}
