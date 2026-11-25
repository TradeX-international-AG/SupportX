import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for DHL Shipment Tracking – Unified API (GET /track/shipments),
 * built from the documented request and response shapes: header DHL-API-Key,
 * query trackingNumber / language / recipientPostalCode, answer `shipments[]` with
 * `status` and `events[]` (newest first), 404 for unknown numbers, 401 for a wrong
 * key, 429 when the daily limit is used up. Synthetic data only.
 */
export interface FakeDhlParcel {
  statusCode: "pre-transit" | "transit" | "delivered" | "failure" | "unknown";
  status: string;
  description?: string;
  timestamp: string;
  city?: string;
  returnFlag?: boolean;
  /** Older events, newest first. */
  history?: Array<{ statusCode: string; status: string; timestamp: string; city?: string }>;
  /** Details (cities) only with this postal code, like DHL's "postal code challenge". */
  postalCode?: string;
}

export interface FakeDhl {
  url: string;
  parcels: Map<string, FakeDhlParcel>;
  requests: Array<{ trackingNumber: string | null; postalCode: string | null; key: string | null }>;
  /** Calls left before 429 (Infinity = no limit). */
  limit: { remaining: number };
  close(): Promise<void>;
}

export async function startFakeDhl(opts: { apiKey: string; parcels?: Record<string, FakeDhlParcel>; port?: number }): Promise<FakeDhl> {
  const state = { parcels: new Map(Object.entries(opts.parcels ?? {})), requests: [] as FakeDhl["requests"], limit: { remaining: Infinity } };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": status === 200 ? "application/json" : "application/problem+json" });
      res.end(JSON.stringify(body));
    };
    const key = (req.headers["dhl-api-key"] as string | undefined) ?? null;
    const trackingNumber = url.searchParams.get("trackingNumber");
    const postalCode = url.searchParams.get("recipientPostalCode");
    state.requests.push({ trackingNumber, postalCode, key });
    if (req.method !== "GET" || url.pathname !== "/track/shipments") return send(404, { status: 404, title: "Not Found" });
    if (key !== opts.apiKey) return send(401, { status: 401, title: "Unauthorized", detail: "Invalid API key" });
    if (state.limit.remaining <= 0) return send(429, { status: 429, title: "Too many requests", detail: "Daily limit reached" });
    state.limit.remaining -= 1;
    if (!trackingNumber) return send(400, { status: 400, title: "Bad Request", detail: "trackingNumber is required" });
    const p = state.parcels.get(trackingNumber);
    if (!p) return send(404, { status: 404, title: "No result found", detail: `No shipment with given tracking number found.` });
    const details = !p.postalCode || p.postalCode === postalCode;
    const loc = (city?: string) => (details && city ? { address: { addressLocality: city, countryCode: "DE" } } : undefined);
    const latest = { timestamp: p.timestamp, statusCode: p.statusCode, status: p.status, description: p.description ?? p.status, location: loc(p.city) };
    send(200, {
      shipments: [
        {
          id: trackingNumber,
          service: "parcel-de",
          status: latest,
          details: { ...(p.statusCode === "delivered" ? { proofOfDelivery: { timestamp: p.timestamp } } : {}), ...(p.returnFlag ? { returnFlag: true } : {}) },
          events: [latest, ...(p.history ?? []).map((e) => ({ timestamp: e.timestamp, statusCode: e.statusCode, status: e.status, description: e.status, location: loc(e.city) }))],
        },
      ],
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/track/shipments`,
    ...state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Local stand-in for DHL Parcel DE Returns (POST /parcel/de/shipping/returns/v1/orders),
 * built from the shapes of the official SDK's fixtures: header dhl-api-key plus Basic
 * auth (business customer portal user), body { receiverId, customerReference, shipper },
 * 201 { sstatus, shipmentNo, label: { b64 }, routingCode }, problem JSON
 * { status, title, detail } on errors. Synthetic data only.
 */
export interface FakeDhlReturns {
  url: string;
  orders: Array<{ receiverId: unknown; customerReference: unknown; shipper: Record<string, unknown>; labelType: string | null }>;
  requests: number;
  /** Next answer is held back this long (to test timeouts). */
  delayMs: { value: number };
  close(): Promise<void>;
}

export async function startFakeDhlReturns(opts: { apiKey: string; user: string; password: string; receiverIds?: string[]; port?: number }): Promise<FakeDhlReturns> {
  const receivers = new Set(opts.receiverIds ?? ["deu"]);
  const state = { orders: [] as FakeDhlReturns["orders"], requests: 0, delayMs: { value: 0 } };
  let next = 1;
  const server = createServer((req, res) => {
    state.requests += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      const delay = state.delayMs.value;
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }, delay);
    };
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || url.pathname !== "/parcel/de/shipping/returns/v1/orders") return send(404, { status: 404, title: "Not Found", detail: "Not Found" });
      if (req.headers["dhl-api-key"] !== opts.apiKey) return send(401, { status: 401, title: "Unauthorized", detail: "Unauthorized for given resource." });
      const basic = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
      if (req.headers.authorization !== basic) return send(401, { status: 401, title: "Unauthorized", detail: "Authentication failed: User not found or password invalid" });
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      } catch {
        return send(400, { status: 400, title: "Bad Request", detail: "Invalid JSON" });
      }
      const shipper = (body.shipper ?? null) as Record<string, unknown> | null;
      if (!body.receiverId || !receivers.has(String(body.receiverId))) return send(400, { status: 400, title: "Bad Request", detail: "Receiver ID is invalid." });
      if (!shipper || !shipper.name1 || !shipper.city || !shipper.postalCode) return send(400, { status: 400, title: "Bad Request", detail: "Shipper address is required." });
      if (shipper.country === "DEU" && !/^\d{5}$/.test(String(shipper.postalCode))) return send(400, { status: 400, title: "Bad Request", detail: "Postal code is invalid. Please use 99999 format." });
      state.orders.push({ receiverId: body.receiverId, customerReference: body.customerReference, shipper, labelType: url.searchParams.get("labelType") });
      const shipmentNo = `99999${String(next++).padStart(7, "0")}`;
      const pdf = Buffer.from(`%PDF-1.4\n% synthetic DHL return label ${shipmentNo}\n%%EOF\n`, "latin1").toString("base64");
      send(201, { sstatus: { title: "Created", status: 201, detail: "Created" }, shipmentNo, label: { b64: pdf }, routingCode: `40321111111+99000${shipmentNo.slice(-7)}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/parcel/de/shipping/returns/v1`,
    orders: state.orders,
    get requests() { return state.requests; },
    delayMs: state.delayMs,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
