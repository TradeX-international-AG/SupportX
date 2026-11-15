import { useEffect, useRef, useState } from "react";
import { api, fmtDate } from "./api.ts";
import { amazonMarketplaceLabel } from "../../../packages/core/amazon-marketplaces.ts";
import { AMAZON_ORDER_ID, AMAZON_REFUND_REASONS, formatCents, percentAmounts } from "../../../packages/core/amazon-refund.ts";
import { parseAmountInput } from "../../../packages/core/refund-list.ts";

export interface MarketplaceRefund {
  id: string; platform: string; marketplace_id: string; order_id: string; reason: string; currency: string; total_cents: number;
  lines: Array<{ orderItemId: string; title?: string; principalCents: number; shippingCents: number }>;
  state: "pending" | "submitted" | "accepted" | "rejected" | "uncertain" | "failed" | "dismissed";
  feed_id: string | null; result_messages: string[]; error: string | null; created_at: string; checked_at: string | null; requested_by: string;
}

interface OrderView {
  order: { orderId: string; status: string; marketplaceId: string; currency: string };
  blocker: string | null;
  openRefund: { id: string; state: string } | null;
  fba: boolean;
  items: Array<{ orderItemId: string; sku?: string; title?: string; quantity: number; itemPriceCents: number; shippingPriceCents: number; promotionDiscountCents: number; refundablePrincipalCents: number; refundableShippingCents: number }>;
}

export const REFUND_STATE: Record<MarketplaceRefund["state"], { label: string; tone: string }> = {
  pending: { label: "wird gesendet", tone: "muted" },
  submitted: { label: "an Amazon übergeben, Ergebnis offen", tone: "warn" },
  accepted: { label: "von Amazon erstattet", tone: "ok" },
  rejected: { label: "von Amazon abgelehnt", tone: "bad" },
  uncertain: { label: "unklar, in Seller Central prüfen", tone: "warn" },
  failed: { label: "nicht gesendet", tone: "bad" },
  dismissed: { label: "geprüft: nicht erstattet", tone: "muted" },
};

const STATUS_LABEL: Record<string, string> = { Pending: "ausstehend", Unshipped: "nicht versandt", PartiallyShipped: "teilweise versandt", Shipped: "versandt", Canceled: "storniert", Unfulfillable: "nicht lieferbar", InvoiceUnconfirmed: "versandt, Rechnung offen" };
const reasonLabel = (v: string) => AMAZON_REFUND_REASONS.find((r) => r.value === v)?.label ?? v;
const cents = (s: string) => parseAmountInput(s);
const input = (c: number) => (c / 100).toFixed(2).replace(".", ",");

/** One line for the case history. */
export function refundText(r: MarketplaceRefund): string {
  return `Erstattung bei Amazon: ${formatCents(r.total_cents, r.currency)} für Bestellung ${r.order_id} (${reasonLabel(r.reason)}). Ausgelöst von ${r.requested_by}.`;
}

/**
 * Case card: read the Amazon order, enter what to give back per item, confirm the
 * total in a dialog. Amazon then refunds the buyer. Nothing is sent without the
 * dialog; the result is fetched from Amazon and stays with the case.
 */
export function AmazonRefundCard({ base, caseId, orderIds, suggestedCents, refunds, canEdit, onDone }: {
  base: string; caseId: string; orderIds: string[]; suggestedCents: number | null; refunds: MarketplaceRefund[]; canEdit: boolean; onDone: () => void;
}) {
  const [orderId, setOrderId] = useState(orderIds[0] ?? "");
  const [view, setView] = useState<OrderView | null>(null);
  const [amounts, setAmounts] = useState<Record<string, { principal: string; shipping: string }>>({});
  const [reason, setReason] = useState<string>("CustomerReturn");
  const [percent, setPercent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const settleDialog = useRef<HTMLDialogElement>(null);
  const [settle, setSettle] = useState<MarketplaceRefund | null>(null);
  useEffect(() => { setView(null); }, [orderId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const lookup = () => run(async () => {
    const v = await api<OrderView>("POST", `${base}/cases/${caseId}/amazon-refund/lookup`, { orderId: orderId.trim() });
    setView(v);
    setAmounts(Object.fromEntries(v.items.map((i) => [i.orderItemId, { principal: "", shipping: "" }])));
  });
  const pct = Number(percent.trim().replace(",", ".").replace(/\s*%$/, ""));
  const byPercent = view && percent.trim() ? percentAmounts(view.items, pct) : null;
  const fillPercent = () => {
    if (!view || !byPercent) return;
    setAmounts(Object.fromEntries(view.items.map((i) => [i.orderItemId, { principal: byPercent[i.orderItemId] ? input(byPercent[i.orderItemId]!) : "", shipping: "" }])));
    setReason("GeneralAdjustment");
  };
  const fillAll = () => view && setAmounts(Object.fromEntries(view.items.map((i) => [i.orderItemId, { principal: i.refundablePrincipalCents ? input(i.refundablePrincipalCents) : "", shipping: i.refundableShippingCents ? input(i.refundableShippingCents) : "" }])));

  const parsed = view?.items.map((i) => {
    const a = amounts[i.orderItemId] ?? { principal: "", shipping: "" };
    const p = cents(a.principal); const s = cents(a.shipping);
    const bad = p === undefined || s === undefined || (p ?? 0) > i.refundablePrincipalCents || (s ?? 0) > i.refundableShippingCents;
    return { item: i, a, p: p ?? 0, s: s ?? 0, bad };
  }) ?? [];
  const total = parsed.reduce((sum, x) => sum + (x.bad ? 0 : x.p + x.s), 0);
  const invalid = parsed.some((x) => x.bad);
  const canSend = !!view && !view.blocker && !view.openRefund && !invalid && total > 0;

  const send = () => { dialog.current?.close(); void run(async () => {
    const r = await api<{ state: string; error?: string }>("POST", `${base}/cases/${caseId}/amazon-refund`, {
      orderId: view!.order.orderId, reason, confirm: true, expectedTotalCents: total,
      lines: parsed.filter((x) => x.p + x.s > 0).map((x) => ({ orderItemId: x.item.orderItemId, principal: x.a.principal || undefined, shipping: x.a.shipping || undefined })),
    });
    if (r.state === "submitted") setNotice({ tone: "ok", text: "An Amazon übergeben. Amazon verarbeitet Erstattungen meist innerhalb weniger Minuten; dann unten „Ergebnis abrufen“." });
    else if (r.state === "uncertain") setNotice({ tone: "warn", text: "Keine Antwort von Amazon. Bitte in Seller Central nachsehen, ob die Erstattung angekommen ist, bevor du es noch einmal versuchst." });
    else setNotice({ tone: "bad", text: `Nicht gesendet: ${r.error ?? "unbekannter Fehler"}` });
    setView(null);
    onDone();
  }); };
  const check = (r: MarketplaceRefund) => run(async () => {
    const res = await api<{ state: string; messages: string[] }>("POST", `${base}/cases/${caseId}/amazon-refund/${r.id}/check`);
    if (res.state === "accepted") setNotice({ tone: "ok", text: "Amazon hat die Erstattung verarbeitet. Der Fall steht mit dem Betrag auf der Erstattungsliste. Die Gutschrift in weclapp nicht vergessen." });
    else if (res.state === "rejected") setNotice({ tone: "bad", text: `Amazon hat abgelehnt: ${res.messages.join("; ") || "ohne Grund"}` });
    else setNotice({ tone: "warn", text: "Amazon verarbeitet noch. Bitte später noch einmal abrufen." });
    onDone();
  });
  const settleAs = (outcome: "refunded" | "not_refunded") => { settleDialog.current?.close(); if (settle) void run(async () => {
    await api("POST", `${base}/cases/${caseId}/amazon-refund/${settle.id}/settle`, { confirm: true, outcome });
    setNotice({ tone: "ok", text: outcome === "refunded" ? "Als erstattet vermerkt." : "Vermerkt. Die Bestellung kann wieder erstattet werden." });
    onDone();
  }); };

  return (
    <section className="card">
      <h3>Erstattung bei Amazon</h3>
      <p className="muted small">Gibt Amazon dem Kunden Geld zurück, direkt aus dem Fall. SupportX liest dafür die Bestellung bei Amazon, du trägst je Artikel den Betrag ein und bestätigst die Summe. Mehr als bezahlt geht nicht. Die Gutschrift in weclapp bereitest du danach unten unter „Gutschrift in weclapp“ vor (wenn freigeschaltet) oder machst sie wie bisher.</p>
      {canEdit && (
        <div className="stack">
          <label>Amazon-Bestellnummer
            <input list={`amz-orders-${caseId}`} value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="123-1234567-1234567" spellCheck={false} />
            <datalist id={`amz-orders-${caseId}`}>{orderIds.map((o) => <option key={o} value={o} />)}</datalist>
          </label>
          <div className="row"><button onClick={() => void lookup()} disabled={busy || !AMAZON_ORDER_ID.test(orderId.trim())}>Bestellung bei Amazon laden</button></div>
        </div>
      )}
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className={`notice ${notice.tone} small`}>{notice.text}</p>}
      {view && (
        <div className="stack">
          <div className="facts">
            <div className="kv"><span>Bestellung</span><span>{view.order.orderId} · {amazonMarketplaceLabel(view.order.marketplaceId)}</span></div>
            <div className="kv"><span>Status bei Amazon</span><span>{STATUS_LABEL[view.order.status] ?? view.order.status}{view.fba ? " · Versand durch Amazon (FBA)" : ""}</span></div>
          </div>
          {view.blocker && <p className="notice warn small">{view.blocker}</p>}
          {view.openRefund && <p className="notice warn small">Für diese Bestellung ist schon eine Erstattung offen oder unklar. Bitte zuerst unten ihr Ergebnis klären.</p>}
          {view.fba && !view.blocker && <p className="small warn-text">Versand durch Amazon: Amazon erstattet FBA-Rücksendungen oft selbst. Bitte vorher in Seller Central nachsehen, damit nicht doppelt erstattet wird.</p>}
          <div className="refund-items">
            {parsed.map(({ item: i, a, bad }) => (
              <div key={i.orderItemId} className="refund-item">
                <div><strong>{i.quantity} × {i.title ?? i.sku ?? i.orderItemId}</strong></div>
                <div className="muted small">
                  {i.sku ? `SKU ${i.sku} · ` : ""}bezahlt {formatCents(i.itemPriceCents - i.promotionDiscountCents, view.order.currency)}{i.shippingPriceCents ? ` + ${formatCents(i.shippingPriceCents, view.order.currency)} Versand` : ""}
                </div>
                <div className="row wrap">
                  <label className="small">Artikel
                    <input className={bad ? "invalid" : ""} inputMode="decimal" value={a.principal} disabled={!canEdit || !i.refundablePrincipalCents} placeholder={`max. ${input(i.refundablePrincipalCents)}`}
                      onChange={(e) => setAmounts((m) => ({ ...m, [i.orderItemId]: { ...a, principal: e.target.value } }))} />
                  </label>
                  {i.shippingPriceCents > 0 && (
                    <label className="small">Versand
                      <input className={bad ? "invalid" : ""} inputMode="decimal" value={a.shipping} disabled={!canEdit || !i.refundableShippingCents} placeholder={`max. ${input(i.refundableShippingCents)}`}
                        onChange={(e) => setAmounts((m) => ({ ...m, [i.orderItemId]: { ...a, shipping: e.target.value } }))} />
                    </label>
                  )}
                </div>
              </div>
            ))}
          </div>
          {invalid && <p className="small warn-text">Ein Betrag ist keine Zahl oder höher als noch möglich.</p>}
          {canEdit && (
            <>
              <div className="row wrap">
                <button onClick={fillAll} disabled={busy}>Alles erstatten</button>
                <label className="row small">Prozent vom Artikelpreis
                  <input className={`pct-input${percent.trim() && !byPercent ? " invalid" : ""}`} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="z. B. 20" aria-label="Prozent vom Artikelpreis" />
                </label>
                <button onClick={fillPercent} disabled={busy || !byPercent}>{byPercent ? `${percent.trim().replace(/\s*%$/, "")} % eintragen` : "% eintragen"}</button>
                {suggestedCents ? <span className="muted small">Laut Fall: {formatCents(suggestedCents, view.order.currency)}</span> : null}
              </div>
              <label>Grund
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {AMAZON_REFUND_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
              <div className="row"><button className="danger" disabled={busy || !canSend} onClick={() => dialog.current?.showModal()}>{total > 0 ? `${formatCents(total, view.order.currency)} erstatten …` : "Erstatten …"}</button></div>
            </>
          )}
        </div>
      )}
      <dialog ref={dialog} className="confirm-dialog" aria-labelledby={`refund-confirm-${caseId}`}>
        <h3 id={`refund-confirm-${caseId}`}>{view ? `${formatCents(total, view.order.currency)} bei Amazon erstatten?` : "Erstatten?"}</h3>
        {view && (
          <>
            <p className="small">Bestellung {view.order.orderId} · Grund: {reasonLabel(reason)}</p>
            <ul className="small">
              {parsed.filter((x) => x.p + x.s > 0).map((x) => <li key={x.item.orderItemId}>{x.item.title ?? x.item.sku}: {formatCents(x.p, view.order.currency)}{x.s ? ` + ${formatCents(x.s, view.order.currency)} Versand` : ""}</li>)}
            </ul>
          </>
        )}
        <p className="small">Amazon zahlt das Geld an den Kunden zurück. Das lässt sich nicht rückgängig machen.</p>
        <div className="row">
          <button className="danger" onClick={send}>Ja, jetzt erstatten</button>
          <button onClick={() => dialog.current?.close()}>Abbrechen</button>
        </div>
      </dialog>
      <dialog ref={settleDialog} className="confirm-dialog" aria-labelledby={`refund-settle-${caseId}`}>
        <h3 id={`refund-settle-${caseId}`}>Unklare Erstattung klären</h3>
        <p className="small">Bitte in Seller Central bei Bestellung {settle?.order_id} nachsehen, ob {settle ? formatCents(settle.total_cents, settle.currency) : ""} erstattet wurden.</p>
        <div className="row wrap">
          <button onClick={() => settleAs("refunded")}>Ist erstattet</button>
          <button onClick={() => settleAs("not_refunded")}>Ist nicht erstattet</button>
          <button onClick={() => settleDialog.current?.close()}>Abbrechen</button>
        </div>
      </dialog>
      {refunds.length > 0 && (
        <>
          <h4>Bisher in diesem Fall</h4>
          <ul className="history">
            {refunds.map((r) => (
              <li key={r.id}>
                <span className="muted small">{fmtDate(r.created_at)}</span> {formatCents(r.total_cents, r.currency)} · {r.order_id} <span className={`pill ${REFUND_STATE[r.state].tone}`}>{REFUND_STATE[r.state].label}</span>
                <div className="muted small">{reasonLabel(r.reason)} · von {r.requested_by}{r.feed_id ? ` · Amazon-Vorgang ${r.feed_id}` : ""}{r.error ? ` · ${r.error}` : ""}</div>
                {canEdit && r.state === "submitted" && <button className="small" disabled={busy} onClick={() => void check(r)}>Ergebnis abrufen</button>}
                {canEdit && r.state === "uncertain" && <button className="small" disabled={busy} onClick={() => { setSettle(r); settleDialog.current?.showModal(); }}>In Seller Central geprüft …</button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
