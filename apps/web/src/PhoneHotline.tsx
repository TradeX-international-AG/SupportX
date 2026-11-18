import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "./api.ts";

interface Settings {
  configured: boolean;
  tokenHint: string | null;
  webhookSecretSet: boolean;
  transcriptMode: "summary" | "transcript";
  handoverNumber: string | null;
  lastCallAt: string | null;
  mailbox: string | null;
  mailboxConnectionId: string | null;
  routeVerified: boolean;
  urls: { orderStatus: string; invoice: string; webhook: string | null };
  calls: Array<{ id: string; callerHint: string | null; orderNumber: string | null; invoiceRequested: boolean; conversationId: string | null; summary: string | null; at: string }>;
}

/**
 * Settings card for the phone hotline (voice agent, e.g. ElevenLabs Agents on a sipgate
 * number). The tool token is shown once after "Schlüssel erzeugen"; afterwards only
 * "••••abcd". The webhook secret is entered once and then hidden; "Ändern" replaces it.
 */
export function PhoneHotlineCard({ base, owner }: { base: string; owner: boolean }) {
  const [data, setData] = useState<Settings | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [editSecret, setEditSecret] = useState(false);
  const [secret, setSecret] = useState("");
  const [handover, setHandover] = useState("");
  const [routeNote, setRouteNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<Settings>("GET", `${base}/phone`).then((d) => { setData(d); setHandover(d.handoverNumber ?? ""); }, (e: Error) => setError(e.message)), [base]);
  useEffect(() => { if (owner) void load(); }, [load, owner]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null); setNotice(null);
    try {
      await fn();
      setNotice(ok);
      setEditSecret(false);
      setSecret("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!owner || !data) return null;
  const ready = data.configured && data.webhookSecretSet;
  const pill = !data.configured ? { cls: "pill muted", label: "Nicht eingerichtet" } : !ready ? { cls: "pill warn", label: "Webhook fehlt" } : data.lastCallAt ? { cls: "pill ok", label: "Angebunden" } : { cls: "pill warn", label: "Noch kein Anruf" };
  return (
    <section className={`card setup${ready && data.lastCallAt ? " connected" : ""}`} aria-label="Telefon-Hotline">
      <div className="setup-head">
        <div>
          <h3 className="setup-name">Telefon-Hotline</h3>
          <div className="muted small">Sprachagent (z. B. ElevenLabs) · Lieferstatus und Rechnung am Telefon</div>
        </div>
        <span className={pill.cls}>{pill.label}</span>
      </div>
      <p className="muted small">
        Der Sprachagent fragt SupportX während des Anrufs. Auskunft gibt es erst, wenn Bestellnummer und Postleitzahl oder Nachname zu weclapp passen; die Rufnummer zählt dafür nicht.
        Rechnungen gehen nur an die Mailadresse, die weclapp für die Bestellung kennt, als Fall im Posteingang. Jeder Anruf wird danach ein Fall. Tonaufnahmen speichert SupportX nie.
      </p>
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className="notice ok small">{notice}</p>}

      {freshToken && (
        <div className="notice ok small">
          <strong>Schlüssel für die Werkzeuge (nur jetzt sichtbar):</strong>
          <div><code style={{ wordBreak: "break-all" }}>{freshToken}</code></div>
          In ElevenLabs bei beiden Werkzeugen als Header <code>Authorization: Bearer …</code> eintragen (als Secret speichern).
          <div><button className="small" onClick={() => setFreshToken(null)}>Ausblenden</button></div>
        </div>
      )}

      {!data.configured ? (
        <button className="primary" onClick={() => void run(async () => setFreshToken((await api<{ token: string }>("POST", `${base}/phone/token`)).token), "Schlüssel erzeugt. Bitte jetzt kopieren.")}>Schlüssel erzeugen</button>
      ) : (
        <>
          <div className="facts">
            <div className="kv"><span>Werkzeug Lieferstatus</span><code>{data.urls.orderStatus}</code></div>
            <div className="kv"><span>Werkzeug Rechnung</span><code>{data.urls.invoice}</code></div>
            <div className="kv"><span>Schlüssel</span><code>{data.tokenHint}</code></div>
            {data.urls.webhook && <div className="kv"><span>Webhook nach dem Anruf</span><code>{data.urls.webhook}</code></div>}
            <div className="kv"><span>Webhook-Geheimnis</span><span>{data.webhookSecretSet ? "hinterlegt" : "fehlt"}</span></div>
            <div className="kv"><span>Fälle im Postfach</span><span>{data.mailbox ?? "kein Microsoft-Postfach angebunden"}</span></div>
            <div className="kv"><span>Rechnung per Mail</span><span>{data.routeVerified ? "Antwortweg „Telefon“ geprüft" : "Antwortweg „Telefon“ noch nicht geprüft (Senden gesperrt)"}</span></div>
            {data.lastCallAt && <div className="kv"><span>Letzter Anruf</span><span>{fmtDate(data.lastCallAt)}</span></div>}
          </div>

          {(!data.webhookSecretSet || editSecret) ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(() => api("PUT", `${base}/phone`, { webhookSecret: secret.trim() }), "Webhook-Geheimnis gespeichert."); }}>
              <label>Webhook-Geheimnis (ElevenLabs → Agents → Einstellungen → Post-call webhook → HMAC-Secret)
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} required />
              </label>
              <div className="row">
                <button type="submit" className="primary">Speichern</button>
                {data.webhookSecretSet && <button type="button" onClick={() => { setEditSecret(false); setSecret(""); }}>Abbrechen</button>}
              </div>
            </form>
          ) : null}

          {data.mailboxConnectionId && !data.routeVerified && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(() => api("POST", `${base}/connections/${data.mailboxConnectionId}/routes`, { sourcePlatform: "phone", evidenceNote: routeNote.trim() }).then(() => setRouteNote("")), "Antwortweg „Telefon“ vermerkt. Versand bleibt an die übrigen Freigaben gebunden."); }}>
              <label className="small">Antwortweg „Telefon“ prüfen: einmal mit eigener Bestellung anrufen, Rechnung anfordern, im Fall senden und hier vermerken, dass die Mail ankam.
                <input value={routeNote} onChange={(e) => setRouteNote(e.target.value)} placeholder="z. B. Testanruf am …, Rechnung kam an …" required minLength={10} />
              </label>
              <div className="row"><button type="submit">Vermerken</button></div>
            </form>
          )}

          <label className="row small">
            <input type="checkbox" checked={data.transcriptMode === "transcript"} onChange={(e) => void run(() => api("PUT", `${base}/phone`, { transcriptMode: e.target.checked ? "transcript" : "summary" }), e.target.checked ? "Der Gesprächstext kommt ab jetzt in den Fall." : "Ab jetzt nur noch die Zusammenfassung.")} />
            Gesprächstext im Fall speichern (sonst nur die Zusammenfassung). Der Agent muss das zu Beginn ansagen.
          </label>
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void run(() => api("PUT", `${base}/phone`, { handoverNumber: handover.trim() || null }), "Weiterleitungsnummer gespeichert."); }}>
            <label className="small">Weiterleitung an einen Menschen
              <input value={handover} onChange={(e) => setHandover(e.target.value)} placeholder="+49 …" />
            </label>
            <button type="submit">Speichern</button>
          </form>
          <p className="muted small">Die Weiterleitung selbst stellt man in ElevenLabs ein (Werkzeug „Transfer to number“); hier steht sie, damit das Team sie findet.</p>

          <div className="row wrap">
            {data.webhookSecretSet && !editSecret && <button onClick={() => setEditSecret(true)}>Webhook-Geheimnis ändern</button>}
            <button onClick={() => { if (window.confirm("Neuen Schlüssel erzeugen? Der alte gilt sofort nicht mehr; in ElevenLabs muss der neue eingetragen werden.")) void run(async () => setFreshToken((await api<{ token: string }>("POST", `${base}/phone/token`)).token), "Neuer Schlüssel erzeugt. Bitte jetzt kopieren."); }}>Schlüssel ändern</button>
            <button className="danger" onClick={() => { if (window.confirm("Telefon-Hotline trennen? Der Agent bekommt danach keine Auskunft mehr.")) void run(() => api("DELETE", `${base}/phone`), "Telefon-Hotline getrennt."); }}>Trennen</button>
          </div>

          {data.calls.length > 0 && (
            <>
              <h4>Letzte Anrufe</h4>
              <ul className="small">
                {data.calls.map((c) => (
                  <li key={c.id}>
                    {fmtDate(c.at)} · {c.callerHint ?? "Nummer unterdrückt"} · {c.orderNumber ? `Bestellung ${c.orderNumber}` : "keine Bestellung bestätigt"}{c.invoiceRequested ? " · Rechnung angefragt" : ""}
                    {c.summary && <div className="muted">{c.summary}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
