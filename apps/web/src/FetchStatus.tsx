import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { needsAttention, sinceLabel } from "../../../packages/core/fetch-freshness.ts";

export interface FetchState {
  id: string; kind: string; displayName: string; lastSyncAt: string | null;
  background: boolean; stale: boolean; fetching: boolean; health: string;
}

/**
 * Reads run quietly: the worker reads every channel on a timer, and Mirakl
 * marketplaces without background permission (Shop Apotheke …) are read here
 * while the inbox is open, as Mirakl documents it. Reports "inbox on screen" to
 * the server once a minute while the tab is visible; the server decides whether
 * a read is due. A line appears only when something is wrong: the last read
 * failed, or a timer-read channel has not been read for hours. A Mirakl channel
 * that waited while nobody looked is read right away and never shown as stale.
 */
export function FetchStatus({ workspaceId, canFetch, onFetched }: { workspaceId: string; canFetch: boolean; onFetched: () => void }) {
  const [states, setStates] = useState<FetchState[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const report = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    try {
      const r = await api<{ connections: FetchState[] }>("POST", `/api/w/${workspaceId}/inbox/displayed`);
      setStates((prev) => {
        // A read just finished: reload the case list once.
        if (prev.some((p) => p.fetching && r.connections.some((c) => c.id === p.id && !c.fetching))) onFetched();
        return r.connections;
      });
    } catch { /* the case list shows connection errors already */ }
  }, [workspaceId, onFetched]);
  useEffect(() => {
    void report();
    const t = setInterval(() => void report(), 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void report(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [report]);
  // While a read runs, look again sooner so the line updates.
  useEffect(() => {
    if (!states.some((s) => s.fetching)) return;
    const t = setTimeout(() => void report(), 5_000);
    return () => clearTimeout(t);
  }, [states, report]);

  const shown = states.filter(needsAttention);
  if (shown.length === 0) return null;
  const fetchNow = async (id: string) => {
    setBusy(id);
    try { await api("POST", `/api/w/${workspaceId}/connections/${id}/sync`); await report(); } catch { /* shown on the next report */ } finally { setBusy(null); }
  };
  return (
    <div className="fetch-status small pad">
      {shown.map((s) => (
        <div key={s.id} className="row">
          {s.health === "error"
            ? <span className="deadline bad" title="Der letzte Abruf ist fehlgeschlagen. SupportX versucht es automatisch erneut. Details unter Einstellungen."><i aria-hidden="true" />{s.displayName}: Abruf fehlgeschlagen</span>
            : <span className="deadline bad" title="Neue Nachrichten von hier fehlen womöglich im Posteingang."><i aria-hidden="true" />{s.displayName} {s.lastSyncAt ? `seit ${sinceLabel(s.lastSyncAt).replace(/^vor /, "")} nicht abgerufen` : "noch nie abgerufen"}</span>}
          {canFetch && <button className="link" disabled={busy === s.id} onClick={() => void fetchNow(s.id)}>Erneut versuchen</button>}
        </div>
      ))}
    </div>
  );
}

