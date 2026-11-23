/**
 * Setup checklist per channel for the settings page: only what the merchant must do.
 * Reply routes and routing rules are not steps here: sending stays locked until a
 * route is checked (connection card → Erweitert), and mail markets are recognised
 * by sender (built in for Amazon, otherwise mails arrive as plain e-mail).
 * Pure (no React, no fetch) so it can be unit-tested; the state comes only from
 * the settings payload. A step that happens outside SupportX (e.g. a setting in
 * Seller Central) has `external`: SupportX cannot see it, so it only counts as
 * done once an owner has ticked it off (`confirmations`).
 */

export type StepAction = "connect" | "credentials" | "ebay_login" | "check" | "rule" | "route" | "erp" | "confirm" | "unconfirm";

export interface SetupStep {
  key: string;
  title: string;
  hint?: string;
  done: boolean;
  external?: boolean;
  action?: StepAction;
}

export interface ChannelSetup {
  key: string;
  label: string;
  way: string;
  connected: boolean;
  error: string | null;
  steps: SetupStep[];
  /** First open step. */
  next: SetupStep | null;
  /** Replies for this marketplace: which connection sends them and whether that is allowed. Null until connected. */
  sending?: { connectionId: string; on: boolean } | null;
}

export interface SetupInput {
  connections: ReadonlyArray<{ id: string; kind: string; health: string; paused: boolean; last_error: string | null; default_source_platform: string; send_enabled?: boolean; config: { sellerUsername?: string; mailbox?: string } }>;
  accounts: ReadonlyArray<{ platform: string; paused: boolean }>;
  rules: ReadonlyArray<{ connection_id: string; source_platform: string }>;
  routes: ReadonlyArray<{ connection_id: string; source_platform: string }>;
  erp: null | { provider?: string; has_secret: boolean; status: string; last_error: string | null };
  /** Owner tick-offs for external steps, by platform. */
  confirmations?: Readonly<Record<string, { at: string; by: string | null }>>;
  /** The installation brings its own eBay keyset: the merchant only signs in at eBay. */
  ebayOperatorApp?: boolean;
}

/** Mirakl marketplaces: same adapter, one card each (core/marketplaces.ts). */
export const MIRAKL_MARKETS = ["shop_apotheke", "douglas", "mediamarkt_saturn", "conrad", "decathlon"] as const;
export const API_MARKETS = ["kaufland", "ebay", ...MIRAKL_MARKETS] as const;
export const MAIL_MARKETS = ["amazon", "otto", "docmorris", "shopify"] as const;
export type Market = (typeof API_MARKETS)[number] | (typeof MAIL_MARKETS)[number];
type ApiMarket = (typeof API_MARKETS)[number];

export const MARKET_KIND: Record<ApiMarket, string> = {
  kaufland: "kaufland_tickets", ebay: "ebay_messages",
  shop_apotheke: "mirakl_inbox", douglas: "mirakl_inbox", mediamarkt_saturn: "mirakl_inbox", conrad: "mirakl_inbox", decathlon: "mirakl_inbox",
};

export function isMiraklMarket(market: string): market is (typeof MIRAKL_MARKETS)[number] {
  return (MIRAKL_MARKETS as readonly string[]).includes(market);
}

/** Connections of one marketplace card. Mirakl marketplaces share a kind and differ by platform. */
export function marketConnections<C extends { kind: string; default_source_platform: string }>(market: ApiMarket, connections: ReadonlyArray<C>): C[] {
  return connections.filter((c) => c.kind === MARKET_KIND[market] && (!isMiraklMarket(market) || c.default_source_platform === market));
}

const LABEL: Record<Market, string> = {
  kaufland: "Kaufland", ebay: "eBay", shop_apotheke: "Shop Apotheke", douglas: "Douglas", mediamarkt_saturn: "MediaMarkt/Saturn", conrad: "Conrad", decathlon: "Decathlon",
  amazon: "Amazon", otto: "OTTO", docmorris: "DocMorris", shopify: "Shopify",
};
const WAY: Record<Market, string> = {
  kaufland: "Schnittstelle (Tickets)", ebay: "Schnittstelle (Nachrichten)",
  shop_apotheke: "Schnittstelle (Mirakl)", douglas: "Schnittstelle (Mirakl)", mediamarkt_saturn: "Schnittstelle (Mirakl)", conrad: "Schnittstelle (Mirakl)", decathlon: "Schnittstelle (Mirakl)",
  amazon: "per Mail über das Postfach", otto: "per Mail über das Postfach, Bestellstatus per Schnittstelle", docmorris: "per Mail über das Postfach", shopify: "per Mail über das Postfach",
};
const mirakl = (name: string): { title: string; hint: string } => ({
  title: "Backoffice-Adresse und API-Schlüssel eintragen",
  hint: `Mirakl-Backoffice von ${name} → oben rechts der Benutzer → API-Schlüssel. Die Adresse ist die des Backoffice (https://….mirakl.net).`,
});
const ZUGANG: Record<ApiMarket, { title: string; hint: string }> = {
  kaufland: { title: "Client Key und Secret Key eintragen", hint: "Kaufland Seller Portal → Einstellungen → API. Ein bestehendes Schlüsselpaar kopieren, nicht neu erzeugen." },
  ebay: { title: "eBay-Anwendung eintragen (App ID, Cert ID, RuName)", hint: "Einmalig durch den Betreiber dieser SupportX-Installation aus seinem eBay-Entwicklerkonto. Der Händler meldet sich danach nur noch bei eBay an." },
  shop_apotheke: mirakl("Shop Apotheke"),
  douglas: mirakl("Douglas"),
  mediamarkt_saturn: mirakl("MediaMarkt/Saturn"),
  conrad: mirakl("Conrad"),
  decathlon: mirakl("Decathlon"),
};
const EXTERN: Record<(typeof MAIL_MARKETS)[number], { title: string; hint: string }> = {
  amazon: { title: "In Seller Central das Postfach eintragen", hint: "Einstellungen → Benachrichtigungen: Käufer-Nachrichten an das Postfach. Nachrichten-Berechtigungen: das Postfach als Absender erlauben, sonst kommen Antworten nicht an." },
  otto: { title: "In OTTO Partner Connect das Postfach eintragen", hint: "Kundenanfragen von OTTO kommen per Mail. Unter Einstellungen → Kontaktdaten die Adresse für den Kundenservice auf das Postfach setzen." },
  docmorris: { title: "Im DocMorris-Partnerportal das Postfach eintragen", hint: "Die Adresse für Kundenanfragen auf das Postfach setzen." },
  shopify: { title: "In Shopify das Postfach eintragen", hint: "Kontaktformular und Shop-Mails an das Postfach leiten." },
};

function finish(key: string, label: string, way: string, steps: SetupStep[], connected: boolean, error: string | null): ChannelSetup {
  return { key, label, way, steps, connected, error, next: steps.find((s) => !s.done) ?? null };
}

/** True when the marketplace refused the stored keys (as opposed to a timeout or an outage). */
export function rejectedKeys(error: string): boolean {
  return /\(401\)|\b401\b|Zugang abgelehnt|invalid_client|unauthori[sz]ed|not known/i.test(error);
}

const healthy = (c: { health: string; paused: boolean }) => c.health === "ok" && !c.paused;

export function microsoftSetup(input: SetupInput): ChannelSetup {
  const graph = input.connections.filter((c) => c.kind === "microsoft_graph");
  const steps: SetupStep[] = [
    { key: "connect", title: "Postfach verbinden", hint: "Verzeichnis-ID, Anwendungs-ID und den Wert des Client Secrets aus Entra eintragen.", done: graph.length > 0, action: "connect" },
    { key: "check", title: "Verbindung testen", done: graph.some(healthy), action: "check" },
  ];
  const err = graph.find((c) => c.health === "error" && !c.paused)?.last_error ?? null;
  return finish("microsoft", "Microsoft-Postfach", "Grundlage für Amazon, DocMorris und Shopify", steps, graph.some(healthy), err);
}

/** The stored order system, if it is this one (rows without provider are weclapp). */
function erpOf(input: SetupInput, provider: "weclapp" | "plentymarkets") {
  return input.erp && (input.erp.provider ?? "weclapp") === provider ? input.erp : null;
}

export function weclappSetup(input: SetupInput): ChannelSetup {
  const erp = erpOf(input, "weclapp");
  const steps: SetupStep[] = [
    { key: "erp", title: "Adresse und API-Token eintragen", hint: "Eigener weclapp-Benutzer nur mit Leserechten, nicht der Token eines anderen Programms.", done: !!erp?.has_secret, action: "erp" },
    { key: "check", title: "Verbindung testen", done: erp?.status === "ok", action: "check" },
  ];
  return finish("weclapp", "weclapp", "Bestelldaten, nur lesend", steps, erp?.status === "ok", erp?.status === "error" ? erp.last_error : null);
}

export function plentySetup(input: SetupInput): ChannelSetup {
  const erp = erpOf(input, "plentymarkets");
  const steps: SetupStep[] = [
    { key: "erp", title: "Adresse, REST-Benutzer und Passwort eintragen", hint: "Eigener REST-Benutzer in plentymarkets, der Aufträge lesen darf. Nicht der Zugang eines anderen Programms.", done: !!erp?.has_secret, action: "erp" },
    { key: "check", title: "Verbindung testen", done: erp?.status === "ok", action: "check" },
  ];
  return finish("plentymarkets", "plentymarkets", "Bestelldaten, nur lesend", steps, erp?.status === "ok", erp?.status === "error" ? erp.last_error : null);
}

/** The order system cards to show: both while none is connected, else only the connected one. */
export function erpSetups(input: SetupInput): ChannelSetup[] {
  const provider = input.erp ? input.erp.provider ?? "weclapp" : null;
  if (provider === "plentymarkets") return [plentySetup(input)];
  if (provider === "weclapp") return [weclappSetup(input)];
  return [weclappSetup(input), plentySetup(input)];
}

export function marketSetup(market: Market, input: SetupInput): ChannelSetup {
  if ((API_MARKETS as readonly string[]).includes(market)) {
    const own = marketConnections(market as ApiMarket, input.connections);
    if (market === "ebay" && input.ebayOperatorApp) {
      // Like ASEIO: one click to eBay, no keys to type. The login creates the connection if needed.
      const steps: SetupStep[] = [
        { key: "ebay_login", title: "Bei eBay mit dem Verkäuferkonto anmelden", hint: "Du wirst zu eBay geleitet, meldest dich mit dem Verkäuferkonto an und stimmst zu. Schlüssel musst du keine eintragen.", done: own.some((c) => !!c.config.sellerUsername), action: "ebay_login" },
        { key: "check", title: "Verbindung testen", done: own.some(healthy), action: own.length ? "check" : undefined },
      ];
      if (!steps[1]!.action) delete steps[1]!.action;
      const err = own.find((c) => c.health === "error" && !c.paused)?.last_error ?? null;
      return { ...finish(market, LABEL[market], WAY[market], steps, own.some(healthy), err), sending: sendingOf(market, own.find(healthy), input) };
    }
    const steps: SetupStep[] = [{ key: "connect", ...ZUGANG[market as ApiMarket], done: own.length > 0, action: "connect" }];
    if (market === "ebay") steps.push({ key: "ebay_login", title: "Bei eBay mit dem Verkäuferkonto anmelden", done: own.some((c) => !!c.config.sellerUsername), action: "ebay_login" });
    steps.push({ key: "check", title: "Verbindung testen", done: own.some(healthy), action: "check" });
    // Without a connection, "test" and "log in" have nothing to act on.
    if (own.length === 0) for (const step of steps) if (step.action !== "connect") delete step.action;
    const err = own.find((c) => c.health === "error" && !c.paused)?.last_error ?? null;
    // Keys refused by the marketplace: the next thing to do is to enter new ones, not to test again.
    if (err && rejectedKeys(err) && !own.some(healthy)) steps[0] = { key: "connect", title: "Zugangsdaten erneuern", hint: `${LABEL[market]} lehnt die gespeicherten Schlüssel ab. Neue eintragen, Fälle und Einstellungen bleiben erhalten.`, done: false, action: "credentials" };
    return { ...finish(market, LABEL[market], WAY[market], steps, own.some(healthy), err), sending: sendingOf(market, own.find(healthy), input) };
  }
  const graph = input.connections.filter((c) => c.kind === "microsoft_graph");
  const mailboxOk = graph.some(healthy);
  const mail = market as (typeof MAIL_MARKETS)[number];
  const confirmed = input.confirmations?.[market];
  const external: SetupStep = confirmed
    ? { key: "external", title: EXTERN[mail].title, hint: `Abgehakt${confirmed.by ? ` von ${confirmed.by}` : ""} am ${fmtDay(confirmed.at)}.`, done: true, external: true, action: "unconfirm" }
    : { key: "external", ...EXTERN[mail], hint: `${EXTERN[mail].hint} Danach hier abhaken, SupportX kann das nicht selbst sehen.`, done: false, external: true, action: "confirm" };
  const steps: SetupStep[] = [
    external,
    { key: "mailbox", title: "Microsoft-Postfach verbunden und geprüft", hint: "Siehe Karte „Microsoft-Postfach“.", done: mailboxOk },
  ];
  const connected = !!confirmed && mailboxOk;
  return { ...finish(market, LABEL[market], WAY[market], steps, connected, null), sending: connected ? sendingOf(market, graph.find(healthy), input) : null };
}

function sendingOf(market: Market, connection: SetupInput["connections"][number] | undefined, input: SetupInput): ChannelSetup["sending"] {
  if (!connection) return null;
  const routed = input.routes.some((r) => r.connection_id === connection.id && r.source_platform === market);
  return { connectionId: connection.id, on: routed && !!connection.send_enabled };
}

function fmtDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
