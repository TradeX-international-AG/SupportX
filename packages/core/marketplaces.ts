/**
 * One list of the platforms SupportX knows, so names, deadlines and messaging
 * rules stay in step. Pure, shared by API, worker and UI.
 *
 * Mirakl: several marketplaces run on Mirakl and share one seller API (inbox
 * M10–M13, orders OR11). Each operator is its own platform in SupportX (own
 * card, own deadline, own seller account), but uses the same adapter; the
 * merchant enters the operator's instance address and the shop API key. No
 * operator address is built in.
 */

export type SourcePlatform =
  | "email"
  | "amazon"
  | "ebay"
  | "kaufland"
  /** OTTO Market: customer messages arrive by e-mail; order status via the OTTO API (read only). */
  | "otto"
  /** Mirakl marketplaces (same adapter, see core/marketplaces.ts). */
  | "shop_apotheke"
  | "douglas"
  | "mediamarkt_saturn"
  | "conrad"
  | "decathlon"
  | "docmorris"
  | "shopify"
  /** A call to the phone hotline (voice agent); answered by a new mail to the address weclapp keeps for the order. */
  | "phone";

export const MIRAKL_PLATFORMS = ["shop_apotheke", "douglas", "mediamarkt_saturn", "conrad", "decathlon"] as const;
export type MiraklPlatform = (typeof MIRAKL_PLATFORMS)[number];

export function isMiraklPlatform(value: unknown): value is MiraklPlatform {
  return typeof value === "string" && (MIRAKL_PLATFORMS as readonly string[]).includes(value);
}

export const PLATFORM_NAMES: Readonly<Record<SourcePlatform, string>> = {
  email: "E-Mail",
  amazon: "Amazon",
  ebay: "eBay",
  kaufland: "Kaufland",
  otto: "OTTO",
  shop_apotheke: "Shop Apotheke",
  douglas: "Douglas",
  mediamarkt_saturn: "MediaMarkt/Saturn",
  conrad: "Conrad",
  decathlon: "Decathlon",
  docmorris: "DocMorris",
  shopify: "Shopify",
  phone: "Telefon",
};

export const ALL_PLATFORMS = Object.keys(PLATFORM_NAMES) as SourcePlatform[];

export function platformName(platform: string | null | undefined): string {
  return (platform && PLATFORM_NAMES[platform as SourcePlatform]) || (platform ?? "");
}

/** Marketplaces whose buyer messaging forbids contact details and advertising. */
export const MESSAGING_RULE_PLATFORMS: ReadonlyArray<SourcePlatform> = ["amazon", "ebay", "kaufland", "otto", ...MIRAKL_PLATFORMS, "docmorris"];

/** Platforms whose messages come through a buyer relay or a marketplace API thread (never forward the original). */
export const RELAY_PLATFORMS: ReadonlyArray<SourcePlatform> = ["amazon", "ebay", "kaufland", ...MIRAKL_PLATFORMS];
