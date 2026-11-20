import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for the weclapp REST API v2 (GET only), serving synthetic data.
 * Used by contract tests and the demo. It implements only the filters the
 * adapter uses: <field>-eq on all three resources (dotted paths into lists match
 * any element), plus the result envelope and token check.
 */
export interface FakeWeclappData {
  salesOrder: Array<Record<string, unknown>>;
  shipment: Array<Record<string, unknown>>;
  salesInvoice: Array<Record<string, unknown>>;
  article?: Array<Record<string, unknown>>;
  /** Goods receipts; customer returns have incomingGoodsType CUSTOMER_RETURN. */
  incomingGoods?: Array<Record<string, unknown>>;
  shipmentReturnReason?: Array<Record<string, unknown>>;
  currency?: Array<Record<string, unknown>>;
  /** Sales channels as set up in weclapp ({ key: "NET3", name: "DocMorris" }). */
  salesChannels?: Array<{ key: string; name: string }>;
}

export interface FakeWeclapp {
  baseUrl: string;
  /** Write faults for credit notes: "forbidden" (read-only token), "reset" (draft created, answer lost), "put_fails" (draft created, update rejected). */
  writeFault: "none" | "forbidden" | "reset" | "put_fails";
  data: FakeWeclappData;
  requests: string[];
  failNext: (status: number) => void;
  close(): Promise<void>;
}

/** Values at a dotted path; a list on the way yields one value per element (weclapp filters like parcels.trackingId-eq). */
function values(record: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [record];
  if (Array.isArray(record)) return record.flatMap((item) => values(item, path));
  if (!record || typeof record !== "object") return [];
  return values((record as Record<string, unknown>)[path[0]!], path.slice(1));
}

/** `rejectFilters` (e.g. "salesInvoice.salesOrderId-eq") answer HTTP 400 like a tenant that does not know the filter. */
export async function startFakeWeclapp(data: FakeWeclappData, opts: { token: string; port?: number; rejectFilters?: ReadonlyArray<string>; forbidden?: ReadonlyArray<string> }): Promise<FakeWeclapp> {
  const requests: string[] = [];
  let failStatus: number | null = null;
  const state = { writeFault: "none" as FakeWeclapp["writeFault"] };
  let creditNotes = 0;
  const money = (v: unknown) => Number(v ?? 0);
  const fix = (n: number) => n.toFixed(2);
  /** Like weclapp in gross price entry: line gross = unit price × quantity, rounded to the cent. */
  const recompute = (inv: Record<string, unknown>) => {
    const items = (inv.salesInvoiceItems as Array<Record<string, unknown>> | undefined) ?? [];
    for (const i of items) i.grossAmount = fix(Math.round(money(i.unitPrice) * money(i.quantity || 1) * 100) / 100);
    const ship = (inv.shippingCostItems as Array<Record<string, unknown>> | undefined) ?? [];
    for (const i of ship) i.grossAmount = fix(Math.round(money(i.unitPrice) * 100) / 100);
    inv.grossAmount = fix([...items, ...ship].reduce((s, i) => s + money(i.grossAmount), 0));
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["authenticationtoken"] !== opts.token) return send(401, { error: "invalid token" });
    if (failStatus) {
      const status = failStatus;
      failStatus = null;
      return send(status, { error: "simulated failure" });
    }
    const byId = /^\/webapp\/api\/v2\/salesInvoice\/id\/([^/]+)(\/createCreditNote)?$/.exec(url.pathname);
    if (byId) {
      const inv = data.salesInvoice.find((i) => String(i.id) === decodeURIComponent(byId[1]!));
      if (!inv) return send(404, { error: "not found" });
      if (req.method === "GET" && !byId[2]) return send(200, inv);
      if (state.writeFault === "forbidden") return send(403, { error: "Der Benutzer hat keine Berechtigung." });
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (req.method === "POST" && byId[2]) {
        const ids = (body.itemIds as string[] | undefined) ?? [];
        creditNotes += 1;
        const note: Record<string, unknown> = {
          id: `cn-${creditNotes}`, version: "0", invoiceNumber: `GS-${8000 + creditNotes}`, status: "NEW", salesInvoiceType: "CREDIT_NOTE",
          salesOrderId: inv.salesOrderId, recordCurrencyId: inv.recordCurrencyId, createdDate: Date.now(),
          salesInvoiceItems: ((inv.salesInvoiceItems as Array<Record<string, unknown>> | undefined) ?? []).filter((i) => ids.includes(String(i.id)))
            .map((i, n) => ({ ...i, id: `cn-${creditNotes}-item-${n + 1}`, version: "0", creditedInvoiceItemId: i.id })),
          shippingCostItems: ((inv.shippingCostItems as Array<Record<string, unknown>> | undefined) ?? []).map((i, n) => ({ ...i, id: `cn-${creditNotes}-ship-${n + 1}` })),
        };
        recompute(note);
        data.salesInvoice.push(note);
        if (state.writeFault === "reset") return void req.socket.destroy();
        return send(200, { result: note });
      }
      if (req.method === "PUT" && !byId[2]) {
        if (state.writeFault === "put_fails") return send(400, { error: "property createdDate is read-only" });
        if (inv.status !== "NEW") return send(400, { error: "record is booked" });
        Object.assign(inv, body);
        recompute(inv);
        return send(200, inv);
      }
    }
    if (req.method !== "GET") return send(405, { error: "read-only fake" });
    // Invoice document: a synthetic PDF, or 404 when the record says it has none (`noPdf`).
    const pdf = /^\/webapp\/api\/v2\/salesInvoice\/id\/([^/]+)\/downloadLatestSalesInvoicePdf$/.exec(url.pathname);
    if (pdf) {
      const inv = data.salesInvoice.find((i) => String(i.id) === decodeURIComponent(pdf[1]!));
      if (!inv || inv.noPdf) return send(404, { error: "no document" });
      res.writeHead(200, { "Content-Type": "application/pdf" });
      return res.end(Buffer.from(`%PDF-1.4\n% Rechnung ${String(inv.invoiceNumber)}\n%%EOF`));
    }
    // Sales channel names as set up by the merchant (key → name).
    if (url.pathname === "/webapp/api/v2/salesChannel/activeSalesChannels") return send(200, { result: data.salesChannels ?? [] });
    const match = /^\/webapp\/api\/v2\/(salesOrder|shipment|salesInvoice|article|incomingGoods|shipmentReturnReason|currency)$/.exec(url.pathname);
    if (!match) return send(404, { error: "not found" });
    // A user without the right for this resource (e.g. no access to goods receipts).
    if (opts.forbidden?.includes(match[1]!)) return send(403, { error: "forbidden" });
    for (const key of url.searchParams.keys()) {
      if (opts.rejectFilters?.includes(`${match[1]}.${key}`)) return send(400, { error: "unexpected filter property" });
    }
    let rows = data[match[1] as keyof FakeWeclappData] ?? [];
    for (const [key, value] of url.searchParams) {
      if (!key.endsWith("-eq")) continue;
      const field = key.slice(0, -3);
      rows = rows.filter((row) => values(row, field.split(".")).some((v) => String(v ?? "") === value));
    }
    const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
    send(200, { result: rows.slice(0, pageSize) });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    baseUrl: `http://127.0.0.1:${port}/webapp/api/v2`,
    data,
    requests,
    failNext: (status: number) => {
      failStatus = status;
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  });
}
