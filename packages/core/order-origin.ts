/**
 * Where an enquiry comes from: the sales channel of the order (DocMorris,
 * Amazon, eBay, own shop …), even when the customer wrote by plain e-mail.
 * Pure, shared by API and UI.
 *
 * Order of evidence, strongest first:
 *  1. the case itself came in through a marketplace (API thread or known sender);
 *  2. the seller account the case belongs to;
 *  3. the sales channel of the matched weclapp order, when its name (as set up
 *     by the merchant in weclapp, e.g. "DocMorris") names a marketplace;
 *  4. the shape of the order number (Amazon, eBay); after that a channel name
 *     that is no known marketplace is shown as it is (e.g. "Webshop"), without a link;
 *  5. the customer's text names exactly one marketplace ("über DocMorris bestellt").
 * Step 5 is customer content: it only labels the case, marked as such, and
 * never selects a seller account, a recipient or a reply route.
 */
import { PLATFORM_NAMES, type SourcePlatform } from "./marketplaces.ts";

export type OriginVia = "case" | "account" | "weclapp" | "number" | "text";

export interface OrderOrigin {
  /** Known platform, or null for a channel SupportX has no page for (e.g. the merchant's own shop). */
  platform: SourcePlatform | null;
  /** Name shown in the case, e.g. "DocMorris" or the weclapp channel name. */
  label: string;
  via: OriginVia;
  /** One short German line on how it was recognised. */
  detail: string;
}

export interface OriginInput {
  sourcePlatform?: string | null;
  accountPlatform?: string | null;
  order?: { salesChannel?: string | null; salesChannelName?: string | null; orderNumber?: string | null; orderNumberAtCustomer?: string | null } | null;
  /** Subject and customer text; only used when nothing above decides. */
  text?: string | null;
}

/** Platforms that say nothing about where the order was placed. */
const NEUTRAL: ReadonlySet<string> = new Set(["email", "phone"]);

/** Spellings of each marketplace in weclapp channel names and customer texts. */
const ALIASES: ReadonlyArray<[SourcePlatform, RegExp]> = [
  ["docmorris", /\bdoc\s*-?\s*morris\b/i],
  ["shop_apotheke", /\b(shop[\s-]*apotheke|redcare)\b/i],
  ["amazon", /\bamazon\b/i],
  ["ebay", /\be-?bay\b/i],
  ["kaufland", /\bkaufland\b/i],
  ["douglas", /\bdouglas\b/i],
  ["mediamarkt_saturn", /\b(media\s*-?\s*markt|saturn)\b/i],
  ["conrad", /\bconrad\b/i],
  ["decathlon", /\bdecathlon\b/i],
  ["shopify", /\bshopify\b/i],
  // "Otto" is also a first name: only the marketplace spelling counts.
  ["otto", /\b(otto\s*(market|marktplatz|\.de)|otto-market)\b|^\s*otto\s*$/i],
];

const AMAZON_ORDER = /\b\d{3}-\d{7}-\d{7}\b/;
const EBAY_ORDER = /^\d{2}-\d{5}-\d{5}$/;

function isPlatform(value: string | null | undefined): value is SourcePlatform {
  return !!value && Object.prototype.hasOwnProperty.call(PLATFORM_NAMES, value);
}

/** Marketplaces named in a text (each once, in list order). */
export function platformsNamedIn(text: string | null | undefined): SourcePlatform[] {
  if (!text) return [];
  return ALIASES.filter(([, re]) => re.test(text)).map(([p]) => p);
}

export function detectOrigin(input: OriginInput): OrderOrigin | null {
  const name = (p: SourcePlatform) => PLATFORM_NAMES[p];
  const source = input.sourcePlatform ?? null;
  if (isPlatform(source) && !NEUTRAL.has(source)) {
    return { platform: source, label: name(source), via: "case", detail: `Anfrage kam über ${name(source)}` };
  }
  const account = input.accountPlatform ?? null;
  if (isPlatform(account) && !NEUTRAL.has(account)) {
    return { platform: account, label: name(account), via: "account", detail: `Verkäuferkonto ${name(account)}` };
  }
  const order = input.order;
  const channelName = order?.salesChannelName?.trim();
  if (channelName) {
    const named = platformsNamedIn(channelName);
    if (named.length === 1) return { platform: named[0]!, label: name(named[0]!), via: "weclapp", detail: `Vertriebsweg in weclapp: ${channelName}` };
  }
  const numbers = [order?.orderNumberAtCustomer, order?.orderNumber].map((n) => n?.trim()).filter((n): n is string => !!n);
  if (numbers.some((n) => AMAZON_ORDER.test(n))) return { platform: "amazon", label: name("amazon"), via: "number", detail: "Amazon-Bestellnummer im Auftrag" };
  if (numbers.some((n) => EBAY_ORDER.test(n))) return { platform: "ebay", label: name("ebay"), via: "number", detail: "eBay-Bestellnummer im Auftrag" };
  // A channel name that is no known marketplace (e.g. "Webshop") is still the order's channel.
  if (channelName) return { platform: null, label: channelName, via: "weclapp", detail: `Vertriebsweg in weclapp: ${channelName}` };
  const mentioned = platformsNamedIn(input.text);
  if (mentioned.length === 1) {
    return { platform: mentioned[0]!, label: name(mentioned[0]!), via: "text", detail: `laut Kundentext (${name(mentioned[0]!)} genannt), nicht in weclapp bestätigt` };
  }
  return null;
}
