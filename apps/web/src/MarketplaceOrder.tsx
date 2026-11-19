import { useEffect, useState } from "react";
import { api, fmtDate } from "./api.ts";
import type { MarketplaceOrderView } from "../../../packages/core/marketplace-order.ts";

interface Info {
  platform: string;
  platformName: string;
  available: boolean;
  reason?: string;
  candidates: string[];
  order?: MarketplaceOrderView | null;
}

/** Platforms with an order lookup in SupportX; other cases show no card. */
const LOOKUP_PLATFORMS = new Set(["kaufland", "otto", "shop_apotheke", "douglas", "mediamarkt_saturn", "conrad", "decathlon"]);

/**
 * Case card "Beim Marktplatz nachsehen": the order as the marketplace itself
 * shows it (status per article, tracking, refunds). Read live only on a click;
 * nothing of it goes into the draft.
 */
export function MarketplaceOrderCard({ base, caseId, platform, refreshKey }: { base: string; caseId: string; platform: string; refreshKey: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = LOOKUP_PLATFORMS.has(platform);

  useEffect(() => {
    if (!supported) return;
    setInfo(null); setError(null);
    api<Info>("GET", `${base}/cases/${caseId}/marketplace-order`).then((r) => { setInfo(r); setOrderId(r.candidates[0] ?? ""); }, (e: Error) => setError(e.message));
  }, [base, caseId, supported, refreshKey]);

  if (!supported || (!info && !error)) return null;
  const name = info?.platformName ?? platform;
  const lookup = async () => {
    setBusy(true); setError(null);
    try {
      setInfo(await api<Info>("POST", `${base}/cases/${caseId}/marketplace-order`, { orderId: orderId.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const order = info?.order;
  return (
    <section className="card" aria-label={`Bestellung bei ${name}`}>
      <div className="row wrap"><h3>Bei {name} nachsehen</h3></div>
      {error && <p className="notice bad small">{error}</p>}
      {info && !info.available && <p className="small muted">{info.reason}</p>}
      {info?.available && (
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void lookup(); }}>
          <input aria-label="Bestellnummer beim Marktplatz" list={`mp-order-${caseId}`} value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="Bestellnummer" spellCheck={false} />
          <datalist id={`mp-order-${caseId}`}>{info.candidates.map((c) => <option key={c} value={c} />)}</datalist>
          <button type="submit" disabled={busy || !orderId.trim()}>{busy ? `Fragt ${name} …` : order === undefined ? "Bestellung abrufen" : "Neu abrufen"}</button>
        </form>
      )}
      {order === null && <p className="small warn-text">{name} kennt in diesem Konto keine Bestellung mit dieser Nummer.</p>}
      {order && (
        <div className="stack small">
          <div className="facts">
            <div className="kv"><span>Bestellung</span><code>{order.orderId}</code></div>
            <div className="kv"><span>Status</span><strong>{order.statusLabel}</strong></div>
            {order.createdAt && <div className="kv"><span>Bestellt</span><span>{fmtDate(order.createdAt)}</span></div>}
          </div>
          {order.lines.length > 0 && (
            <table>
              <thead><tr><th>Artikel</th><th>Menge</th><th>Status bei {name}</th></tr></thead>
              <tbody>{order.lines.map((l, i) => (
                <tr key={i}><td>{l.title}{l.sku && <div className="muted">{l.sku}</div>}</td><td>{l.quantity ?? ""}</td><td title={l.status}>{l.statusLabel}</td></tr>
              ))}</tbody>
            </table>
          )}
          {order.tracking.length > 0 && (
            <div>Sendung laut {name}: {order.tracking.map((t, i) => (
              <span key={i}>{i > 0 && ", "}{t.url ? <a href={t.url} target="_blank" rel="noopener noreferrer">{t.number}</a> : <code>{t.number}</code>}{t.carrier ? ` (${t.carrier})` : ""}</span>
            ))}</div>
          )}
          {order.refunds.length > 0 && (
            <div>Erstattungen: {order.refunds.map((r, i) => (
              <span key={i}>{i > 0 && "; "}{r.amount !== undefined ? `${r.amount.toFixed(2).replace(".", ",")} ${r.currency ?? ""}` : "Betrag unbekannt"} · {r.stateLabel}{r.date ? ` · ${fmtDate(r.date)}` : ""}</span>
            ))}</div>
          )}
          <div className="muted">Abgefragt {fmtDate(order.fetchedAt)} · nur lesend, geht nicht in den Entwurf</div>
        </div>
      )}
    </section>
  );
}
