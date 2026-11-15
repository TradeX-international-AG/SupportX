import { useRef, useState } from "react";
import { api, fmtDate } from "./api.ts";
import { formatCents } from "../../../packages/core/amazon-refund.ts";
import { parseAmountInput } from "../../../packages/core/refund-list.ts";

export interface CaseCreditNote {
  id: string; invoice_id: string; invoice_number: string | null; currency: string | null; total_cents: number; shipping_cents: number;
  lines: Array<{ itemId: string; title?: string; grossCents: number }>;
  state: "pending" | "created" | "needs_review" | "uncertain" | "failed" | "dismissed";
  credit_note_id: string | null; credit_note_number: string | null; result_cents: number | null; error: string | null; created_at: string; requested_by: string;
}

interface InvoiceView {
  id: string; invoiceNumber?: string; currency?: string; grossCents: number; shippingGrossCents: number; earlierCents: number;
  items: Array<{ id: string; title: string; articleNumber?: string; quantity: number; grossCents: number }>;
  proposal: { lines: Record<string, number>; shippingCents: number; note: string };
}

export const CREDIT_STATE: Record<CaseCreditNote["state"], { label: string; tone: string }> = {
  pending: { label: "wird angelegt", tone: "muted" },
  created: { label: "Entwurf in weclapp", tone: "ok" },
  needs_review: { label: "Entwurf in weclapp, bitte Beträge prüfen", tone: "warn" },
  uncertain: { label: "unklar, in weclapp nachsehen", tone: "warn" },
  failed: { label: "nicht angelegt", tone: "bad" },
  dismissed: { label: "geprüft: keine angelegt", tone: "muted" },
};

const input = (c: number) => (c ? (c / 100).toFixed(2).replace(".", ",") : "");

/**
 * Case card: prepare the credit note in weclapp from the refund. SupportX reads
 * the invoice lines, proposes amounts from what was refunded, the person checks
 * them and confirms; weclapp creates a draft that is booked there.
 */
export function CreditNoteCard({ base, caseId, notes, canEdit, onDone }: { base: string; caseId: string; notes: CaseCreditNote[]; canEdit: boolean; onDone: () => void }) {
  const [invoices, setInvoices] = useState<InvoiceView[] | null>(null);
  const [invoiceId, setInvoiceId] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [shipping, setShipping] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const settleDialog = useRef<HTMLDialogElement>(null);
  const [settle, setSettle] = useState<CaseCreditNote | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const pick = (inv: InvoiceView) => {
    setInvoiceId(inv.id);
    setAmounts(Object.fromEntries(inv.items.map((i) => [i.id, input(inv.proposal.lines[i.id] ?? 0)])));
    setShipping(input(inv.proposal.shippingCents));
  };
  const lookup = () => run(async () => {
    const r = await api<{ invoices: InvoiceView[] }>("POST", `${base}/cases/${caseId}/credit-note/lookup`);
    setInvoices(r.invoices);
    if (r.invoices[0]) pick(r.invoices[0]);
  });

  const inv = invoices?.find((i) => i.id === invoiceId) ?? null;
  const cur = inv?.currency ?? "EUR";
  const parsed = inv?.items.map((i) => { const c = parseAmountInput(amounts[i.id] ?? ""); return { item: i, c: c ?? 0, bad: c === undefined || (c ?? 0) > i.grossCents }; }) ?? [];
  const ship = parseAmountInput(shipping);
  const shipBad = ship === undefined || (ship ?? 0) > (inv?.shippingGrossCents ?? 0);
  const total = parsed.reduce((s, x) => s + (x.bad ? 0 : x.c), 0) + (shipBad ? 0 : ship ?? 0);
  const left = inv ? inv.grossCents - inv.earlierCents : 0;
  const invalid = parsed.some((x) => x.bad) || shipBad || total > left;
  const canSend = !!inv && !invalid && parsed.some((x) => x.c > 0);

  const send = () => { dialog.current?.close(); if (inv) void run(async () => {
    const r = await api<{ state: string; creditNoteNumber?: string; error?: string }>("POST", `${base}/cases/${caseId}/credit-note`, {
      invoiceId: inv.id, confirm: true, expectedTotalCents: total, shipping: shipping || undefined,
      lines: parsed.filter((x) => x.c > 0).map((x) => ({ itemId: x.item.id, amount: amounts[x.item.id]! })),
    });
    const no = r.creditNoteNumber ? ` ${r.creditNoteNumber}` : "";
    if (r.state === "created") setNotice({ tone: "ok", text: `Gutschrift${no} liegt als Entwurf in weclapp. Bitte dort prüfen und buchen, dann auf der Erstattungsliste abhaken.` });
    else if (r.state === "needs_review") setNotice({ tone: "warn", text: `Gutschrift${no} ist in weclapp angelegt. ${r.error ?? ""}` });
    else if (r.state === "uncertain") setNotice({ tone: "warn", text: "Keine Antwort von weclapp. Bitte in weclapp nachsehen, ob die Gutschrift angelegt wurde, bevor du es noch einmal versuchst." });
    else setNotice({ tone: "bad", text: `Nicht angelegt: ${r.error ?? "unbekannter Fehler"}` });
    setInvoices(null);
    onDone();
  }); };
  const settleAs = (outcome: "exists" | "none") => { settleDialog.current?.close(); if (settle) void run(async () => {
    await api("POST", `${base}/cases/${caseId}/credit-note/${settle.id}/settle`, { confirm: true, outcome });
    setNotice({ tone: "ok", text: outcome === "exists" ? "Vermerkt: die Gutschrift ist in weclapp." : "Vermerkt. Die Gutschrift kann neu angelegt werden." });
    onDone();
  }); };

  return (
    <section className="card">
      <h3>Gutschrift in weclapp</h3>
      <p className="muted small">Bereitet die Gutschrift zur Rechnung vor, mit den Beträgen aus der Erstattung. weclapp legt sie als Entwurf an; gebucht wird in weclapp.</p>
      {canEdit && <div className="row"><button onClick={() => void lookup()} disabled={busy}>Gutschrift vorbereiten</button></div>}
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className={`notice ${notice.tone} small`}>{notice.text}</p>}
      {invoices && inv && (
        <div className="stack">
          {invoices.length > 1 && (
            <label>Rechnung
              <select value={invoiceId} onChange={(e) => { const x = invoices.find((i) => i.id === e.target.value); if (x) pick(x); }}>
                {invoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber ?? i.id} · {formatCents(i.grossCents, i.currency ?? "EUR")}</option>)}
              </select>
            </label>
          )}
          <div className="facts">
            <div className="kv"><span>Rechnung</span><span>{inv.invoiceNumber ?? inv.id} · {formatCents(inv.grossCents, cur)}</span></div>
            {inv.earlierCents > 0 && <div className="kv"><span>Schon gutgeschrieben</span><span>{formatCents(inv.earlierCents, cur)} (aus SupportX)</span></div>}
          </div>
          <p className="small muted">{inv.proposal.note}</p>
          <div className="refund-items">
            {parsed.map(({ item: i, bad }) => (
              <div key={i.id} className="refund-item">
                <div><strong>{i.quantity} × {i.title}</strong></div>
                <div className="muted small">{i.articleNumber ? `Art.-Nr. ${i.articleNumber} · ` : ""}Rechnung {formatCents(i.grossCents, cur)}</div>
                <label className="small">Gutschrift brutto
                  <input className={bad ? "invalid" : ""} inputMode="decimal" value={amounts[i.id] ?? ""} disabled={!canEdit} placeholder={`max. ${input(i.grossCents)}`}
                    onChange={(e) => setAmounts((m) => ({ ...m, [i.id]: e.target.value }))} />
                </label>
              </div>
            ))}
            {inv.shippingGrossCents > 0 && (
              <div className="refund-item">
                <div><strong>Versand</strong></div>
                <label className="small">Gutschrift brutto
                  <input className={shipBad ? "invalid" : ""} inputMode="decimal" value={shipping} disabled={!canEdit} placeholder={`max. ${input(inv.shippingGrossCents)}`} onChange={(e) => setShipping(e.target.value)} />
                </label>
              </div>
            )}
          </div>
          {invalid && <p className="small warn-text">{total > left ? "Mehr als von der Rechnung noch offen ist." : "Ein Betrag ist keine Zahl oder höher als in der Rechnung."}</p>}
          {canEdit && <div className="row"><button className="primary" disabled={busy || !canSend} onClick={() => dialog.current?.showModal()}>{total > 0 ? `Gutschrift über ${formatCents(total, cur)} anlegen …` : "Gutschrift anlegen …"}</button></div>}
        </div>
      )}
      <dialog ref={dialog} className="confirm-dialog" aria-labelledby={`cn-confirm-${caseId}`}>
        <h3 id={`cn-confirm-${caseId}`}>{inv ? `Gutschrift über ${formatCents(total, cur)} anlegen?` : "Gutschrift anlegen?"}</h3>
        {inv && (
          <>
            <p className="small">Zur Rechnung {inv.invoiceNumber ?? inv.id}</p>
            <ul className="small">
              {parsed.filter((x) => x.c > 0).map((x) => <li key={x.item.id}>{x.item.title}: {formatCents(x.c, cur)}</li>)}
              {(ship ?? 0) > 0 && <li>Versand: {formatCents(ship ?? 0, cur)}</li>}
            </ul>
          </>
        )}
        <p className="small">weclapp legt die Gutschrift als Entwurf an. Sie wird erst gebucht, wenn du das in weclapp tust.</p>
        <div className="row">
          <button className="primary" onClick={send}>Ja, Entwurf anlegen</button>
          <button onClick={() => dialog.current?.close()}>Abbrechen</button>
        </div>
      </dialog>
      <dialog ref={settleDialog} className="confirm-dialog" aria-labelledby={`cn-settle-${caseId}`}>
        <h3 id={`cn-settle-${caseId}`}>Unklare Gutschrift klären</h3>
        <p className="small">Bitte in weclapp bei Rechnung {settle?.invoice_number ?? settle?.invoice_id} nachsehen, ob eine Gutschrift über {settle ? formatCents(settle.total_cents, settle.currency ?? "EUR") : ""} angelegt wurde.</p>
        <div className="row wrap">
          <button onClick={() => settleAs("exists")}>Ist angelegt</button>
          <button onClick={() => settleAs("none")}>Ist nicht angelegt</button>
          <button onClick={() => settleDialog.current?.close()}>Abbrechen</button>
        </div>
      </dialog>
      {notes.length > 0 && (
        <>
          <h4>Bisher in diesem Fall</h4>
          <ul className="history">
            {notes.map((n) => (
              <li key={n.id}>
                <span className="muted small">{fmtDate(n.created_at)}</span> {formatCents(n.result_cents ?? n.total_cents, n.currency ?? "EUR")}{n.credit_note_number ? ` · ${n.credit_note_number}` : ""} <span className={`pill ${CREDIT_STATE[n.state].tone}`}>{CREDIT_STATE[n.state].label}</span>
                <div className="muted small">zu Rechnung {n.invoice_number ?? n.invoice_id} · von {n.requested_by}{n.error ? ` · ${n.error}` : ""}</div>
                {canEdit && n.state === "uncertain" && <button className="small" disabled={busy} onClick={() => { setSettle(n); settleDialog.current?.showModal(); }}>In weclapp geprüft …</button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
