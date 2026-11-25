import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "./api.ts";

type Settings =
  | { configured: false; trackingKey: boolean }
  | { configured: true; trackingKey: boolean; useTrackingKey: boolean; countries: string[]; sandbox: boolean; status: string; lastCheckedAt: string | null; lastError: string | null };

/**
 * Settings card for DHL return labels (Parcel DE Returns). Nothing stored is shown
 * again: user, password, key and receiver IDs appear only as "gespeichert"; a change
 * starts with a click on "Ändern", and empty fields keep what is stored.
 */
export function DhlReturnsCard({ base, owner }: { base: string; owner: boolean }) {
  const [data, setData] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ user: "", password: "", apiKey: "", useTrackingKey: true, receiverGermany: "", receiverOthers: "", sandbox: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<Settings>("GET", `${base}/dhl-returns`).then((d) => {
    setData(d);
    setForm((f) => ({ ...f, useTrackingKey: d.configured ? d.useTrackingKey : d.trackingKey, sandbox: d.configured ? d.sandbox : false }));
  }, (e: Error) => setError(e.message)), [base]);
  useEffect(() => void load(), [load]);

  const reset = () => setForm((f) => ({ ...f, user: "", password: "", apiKey: "", receiverGermany: "", receiverOthers: "" }));
  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => string) => {
    setError(null); setNotice(null);
    try {
      setNotice(ok(await fn()));
      setEditing(false);
      reset();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!data) return null;
  const connected = data.configured && data.status === "ok";
  const pill = !data.configured ? { cls: "pill muted", label: "Nicht eingerichtet" } : data.status === "error" ? { cls: "pill bad", label: "Fehler" } : connected ? { cls: "pill ok", label: data.sandbox ? "Angebunden (Testsystem)" : "Angebunden" } : { cls: "pill warn", label: "Noch nicht getestet" };
  const keep = data.configured ? "leer lassen = bleibt wie gespeichert" : undefined;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  return (
    <section className={`card setup${connected ? " connected" : " unconnected"}`} aria-label="DHL-Retourenlabel">
      <div className="setup-head">
        <div>
          <h3 className="setup-name">DHL-Retourenlabel</h3>
          <div className="muted small">Parcel DE Returns API · Retourenlabel im Fall per Klick erstellen</div>
        </div>
        <span className={pill.cls}>{pill.label}</span>
      </div>
      <p className="muted small">Im Fall gibt es dann den Knopf „Retourenlabel erstellen“. Die Adresse des Kunden kommt aus der Bestellung in der Warenwirtschaft; du prüfst sie, dann erstellt DHL das Label. Das PDF bleibt im Fall und kann mit der Antwort an den Kunden gehen. Nötig sind der Zugang zum DHL-Geschäftskundenportal (am besten ein System-Benutzer mit Recht für Retouren) und die Empfänger-ID deiner Retourenadresse (Portal → Retouren → Einstellungen, für Deutschland oft „deu“).</p>
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className="notice ok small">{notice}</p>}
      {data.configured && !editing && (
        <>
          <div className="facts">
            <div className="kv"><span>Geschäftskundenportal</span><span>Benutzer und Passwort gespeichert (verdeckt)</span></div>
            <div className="kv"><span>API-Key</span><span>{data.useTrackingKey ? "wie beim DHL-Sendungsstatus" : "eigener Key gespeichert (verdeckt)"}</span></div>
            <div className="kv"><span>Retouren aus</span><span>{data.countries.join(", ")}</span></div>
            {data.sandbox && <div className="kv"><span>System</span><span>DHL-Testsystem (Sandbox): Labels sind nicht echt</span></div>}
            {data.lastCheckedAt && <div className="kv"><span>Geprüft</span><span>{fmtDate(data.lastCheckedAt)}</span></div>}
          </div>
          {data.lastError && <p className="notice bad small">{data.lastError}</p>}
          {owner && (
            <div className="row wrap">
              <button className={connected ? "" : "primary"} onClick={() => void run(() => api("POST", `${base}/dhl-returns/check`), (r) => { const x = r as { ok: boolean; detail: string }; return `${x.ok ? "Verbindung in Ordnung" : "Prüfung fehlgeschlagen"}: ${x.detail}`; })}>Verbindung testen</button>
              <button onClick={() => setEditing(true)}>Ändern</button>
              <button className="danger" onClick={() => { if (window.confirm("DHL-Retourenzugang entfernen? Im Fall gibt es dann keinen Knopf für Retourenlabels mehr. Erstellte Labels bleiben im Fall.")) void run(() => api("DELETE", `${base}/dhl-returns`), () => "DHL-Retourenzugang entfernt."); }}>Entfernen</button>
            </div>
          )}
        </>
      )}
      {owner && (!data.configured || editing) && (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          void run(() => api("PUT", `${base}/dhl-returns`, { ...form, user: form.user.trim(), apiKey: form.useTrackingKey ? undefined : form.apiKey.trim() }), () => "Gespeichert. Bitte einmal „Verbindung testen“.");
        }}>
          <label>Benutzer im DHL-Geschäftskundenportal
            <input value={form.user} onChange={set("user")} autoComplete="off" spellCheck={false} required={!data.configured} placeholder={keep} />
          </label>
          <label>Passwort
            <input type="password" value={form.password} onChange={set("password")} autoComplete="new-password" required={!data.configured} placeholder={keep} />
          </label>
          <label className="row"><input type="checkbox" checked={form.useTrackingKey} onChange={set("useTrackingKey")} disabled={!data.trackingKey} /> API-Key vom DHL-Sendungsstatus nehmen (die App im DHL-Entwicklerportal braucht dann auch „Parcel DE Returns“)</label>
          {!form.useTrackingKey && (
            <label>API-Key (DHL-Entwicklerportal → Apps → App mit „Parcel DE Returns“)
              <input type="password" value={form.apiKey} onChange={set("apiKey")} autoComplete="off" spellCheck={false} required={!(data.configured && !data.useTrackingKey)} placeholder={data.configured && !data.useTrackingKey ? keep : "API-Key, nicht das API-Secret"} />
            </label>
          )}
          <label>Empfänger-ID für Retouren aus Deutschland
            <input value={form.receiverGermany} onChange={set("receiverGermany")} autoComplete="off" spellCheck={false} placeholder={keep ?? "z. B. deu"} />
          </label>
          <label>Weitere EU-Länder (freiwillig)
            <input value={form.receiverOthers} onChange={set("receiverOthers")} autoComplete="off" spellCheck={false} placeholder={keep ?? "z. B. AUT=aut, NLD=nld"} />
          </label>
          <label className="row"><input type="checkbox" checked={form.sandbox} onChange={set("sandbox")} /> DHL-Testsystem (Sandbox) nutzen: Labels sind nicht echt, Zugangsdaten aus dem Entwicklerportal</label>
          <p className="muted small">Alles wird verschlüsselt gespeichert und nicht wieder angezeigt. {data.configured ? "Leere Felder behalten den gespeicherten Wert; die Empfänger-IDs werden nur zusammen ersetzt." : ""}</p>
          <div className="row">
            <button type="submit" className="primary">Speichern</button>
            {data.configured && <button type="button" onClick={() => { setEditing(false); reset(); }}>Abbrechen</button>}
          </div>
        </form>
      )}
      {!owner && !data.configured && <p className="small muted">Nur Inhaber können den Zugang eintragen.</p>}
    </section>
  );
}

interface Address { name1: string; name2?: string; street: string; houseNumber?: string; addressExtra?: string; postalCode: string; city: string; countryCode: string }
interface LabelInfo { id: string; shipmentNo: string; internationalShipmentNo: string | null; country: string; orderNumber: string | null; sandbox: boolean; createdAt: string; file: { id: string; name: string; for_next_reply: boolean } | null }
interface CaseLabels { connected: boolean; sandbox: boolean; labels: LabelInfo[]; replyFiles: { supported: boolean; note: string } }
interface Preview { orderNumber: string; address: Address | null; problems: string[]; countries: Array<{ code: string; name: string; receiver: boolean }>; sandbox: boolean; labels: LabelInfo[]; replyFiles: { supported: boolean; note: string } }

const EMPTY: Address = { name1: "", street: "", postalCode: "", city: "", countryCode: "DE" };

/**
 * Case card "Retourenlabel": the click reads the customer's address from the order,
 * the person checks it and confirms, and only then DHL makes the label. The PDF stays
 * with the case; "an die Antwort hängen" puts it on the reply. Nothing is sent here.
 */
export function ReturnLabelCard({ base, caseId, canEdit, orderUnique, onChanged }: { base: string; caseId: string; canEdit: boolean; orderUnique: boolean; onChanged: () => void }) {
  const [data, setData] = useState<CaseLabels | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [address, setAddress] = useState<Address>(EMPTY);
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<CaseLabels>("GET", `${base}/cases/${caseId}/return-labels`).then(setData, (e: Error) => setError(e.message)), [base, caseId]);
  useEffect(() => { setPreview(null); setNotice(null); setError(null); void load(); }, [load]);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const open = () => step(async () => {
    const p = await api<Preview>("POST", `${base}/cases/${caseId}/return-labels/preview`);
    setPreview(p);
    setAddress(p.address ?? EMPTY);
    setAttach(p.replyFiles.supported);
  });
  const create = () => step(async () => {
    const again = (data?.labels.length ?? 0) > 0;
    if (again && !window.confirm("Zu diesem Fall gibt es schon ein Retourenlabel. Wirklich ein weiteres bei DHL erstellen?")) return;
    const r = await api<{ label: LabelInfo; draftId: string | null; attached: boolean }>("POST", `${base}/cases/${caseId}/return-labels`, { confirm: true, attach, again, address });
    setPreview(null);
    setNotice(`Retourenlabel ${r.label.shipmentNo} erstellt.${r.attached ? (r.draftId ? " Es hängt an der Antwort; bitte lesen und senden." : " Es geht mit der Antwort raus, sobald du entschieden hast.") : attach ? " Es liegt im Fall; an die Antwort ließ es sich nicht hängen (zu viele oder zu große Anhänge)." : " Es liegt im Fall zum Herunterladen."}`);
    await load();
    onChanged();
  });
  const attachLater = (label: LabelInfo) => step(async () => {
    const r = await api<{ draftId: string | null }>("POST", `${base}/cases/${caseId}/return-labels/${label.id}/attach`);
    setNotice(r.draftId ? "Label hängt an der Antwort. Bitte lesen und senden." : "Label geht mit der Antwort raus, sobald du entschieden hast.");
    await load();
    onChanged();
  });

  if (!data) return error ? <section className="card"><p className="notice bad small">{error}</p></section> : null;
  if (!data.connected && data.labels.length === 0) return null;
  const field = (k: keyof Address, label: string, opts: { required?: boolean } = {}) => (
    <label style={{ minWidth: 0 }}>{label}
      <input value={address[k] ?? ""} onChange={(e) => setAddress({ ...address, [k]: e.target.value })} required={opts.required} autoComplete="off" style={{ width: "100%", boxSizing: "border-box" }} />
    </label>
  );
  const pair = (columns: string, a: React.ReactNode, b: React.ReactNode) => <div style={{ display: "grid", gridTemplateColumns: columns, gap: "0.5rem" }}>{a}{b}</div>;
  return (
    <section className="card" aria-label="Retourenlabel">
      <div className="row wrap"><h3>Retourenlabel (DHL)</h3>{data.sandbox && <span className="pill warn">Testsystem</span>}</div>
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className="notice ok small">{notice}</p>}
      {data.labels.length > 0 && (
        <ul className="parcel-status">
          {data.labels.map((l) => (
            <li key={l.id} className="small">
              <div className="row wrap">
                <code>{l.shipmentNo}</code>
                {l.sandbox && <span className="pill warn">Test</span>}
                <span className="muted">{fmtDate(l.createdAt)}</span>
              </div>
              <div className="row wrap">
                {l.file ? <a href={`${base}/documents/${l.file.id}`} download={l.file.name}>Label als PDF</a> : <span className="muted">PDF nicht mehr vorhanden</span>}
                {l.file?.for_next_reply && <span className="muted">geht mit der nächsten Antwort raus</span>}
                {canEdit && l.file && !l.file.for_next_reply && data.replyFiles.supported && <button className="link small" disabled={busy} onClick={() => void attachLater(l)}>an die Antwort hängen</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canEdit && data.connected && !preview && (
        <button disabled={busy || !orderUnique} onClick={() => void open()} title={orderUnique ? "Liest die Adresse aus der Bestellung. DHL wird erst nach deiner Bestätigung gefragt." : "Erst die Bestellung zuordnen: die Adresse kommt aus der Bestellung."}>
          {busy ? "Liest Adresse …" : data.labels.length ? "Weiteres Retourenlabel erstellen" : "Retourenlabel erstellen"}
        </button>
      )}
      {!orderUnique && data.connected && canEdit && !preview && <p className="muted small">Erst die Bestellung zuordnen; die Adresse für das Label kommt aus der Bestellung.</p>}
      {preview && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <p className="small">Absender des Pakets ist der Kunde. Adresse aus Bestellung {preview.orderNumber}; bitte prüfen und bei Bedarf korrigieren (die Bestellung selbst bleibt unverändert).</p>
          {preview.problems.length > 0 && <p className="notice warn small">{preview.problems.join(" ")}</p>}
          {field("name1", "Name", { required: true })}
          {field("name2", "Zweite Zeile (Firma, c/o, freiwillig)")}
          {pair("3fr 1fr", field("street", "Straße", { required: true }), field("houseNumber", "Nr."))}
          {field("addressExtra", "Adresszusatz (freiwillig)")}
          {pair("1fr 2fr", field("postalCode", "PLZ", { required: true }), field("city", "Ort", { required: true }))}
          <label>Land
            <select value={address.countryCode} onChange={(e) => setAddress({ ...address, countryCode: e.target.value })} required>
              {!preview.countries.some((c) => c.code === address.countryCode) && <option value={address.countryCode}>{address.countryCode || "bitte wählen"}</option>}
              {preview.countries.map((c) => <option key={c.code} value={c.code} disabled={!c.receiver}>{c.name}{c.receiver ? "" : " (kein Retouren-Empfänger eingetragen)"}</option>)}
            </select>
          </label>
          {preview.replyFiles.supported
            ? <label className="row small"><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Label an die Antwort an den Kunden hängen</label>
            : <p className="muted small">{preview.replyFiles.note}</p>}
          <p className="muted small">{preview.sandbox ? "Testsystem: DHL erstellt ein Probe-Label, das nicht verwendet werden kann." : "DHL erstellt ein echtes Retourenlabel; berechnet wird es von DHL nach deinem Vertrag."} An den Kunden geht dabei noch nichts.</p>
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>{busy ? "DHL erstellt …" : "Label bei DHL erstellen"}</button>
            <button type="button" disabled={busy} onClick={() => setPreview(null)}>Abbrechen</button>
          </div>
        </form>
      )}
    </section>
  );
}
