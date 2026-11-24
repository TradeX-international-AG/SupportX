/**
 * Amazon marketplaces the Selling Partner API serves, by region endpoint.
 * Public identifiers from Amazon's "Marketplace IDs" reference; no credentials.
 * Shared by server and browser (settings form, case view).
 */
export type AmazonRegion = "eu" | "na" | "fe";

export interface AmazonMarketplace {
  id: string;
  country: string;
  label: string;
  region: AmazonRegion;
  /** Seller Central host where the seller authorises an app (Amazon "Seller Central URLs"). */
  sellerCentral: string;
}

export const AMAZON_MARKETPLACES: ReadonlyArray<AmazonMarketplace> = [
  { id: "A1PA6795UKMFR9", country: "DE", label: "Amazon.de", region: "eu", sellerCentral: "sellercentral-europe.amazon.com" },
  { id: "A1RKKUPIHCS9HS", country: "ES", label: "Amazon.es", region: "eu", sellerCentral: "sellercentral-europe.amazon.com" },
  { id: "A13V1IB3VIYZZH", country: "FR", label: "Amazon.fr", region: "eu", sellerCentral: "sellercentral-europe.amazon.com" },
  { id: "APJ6JRA9NG5V4", country: "IT", label: "Amazon.it", region: "eu", sellerCentral: "sellercentral-europe.amazon.com" },
  { id: "A1805IZSGTT6HS", country: "NL", label: "Amazon.nl", region: "eu", sellerCentral: "sellercentral.amazon.nl" },
  { id: "AMEN7PMS3EDWL", country: "BE", label: "Amazon.com.be", region: "eu", sellerCentral: "sellercentral.amazon.com.be" },
  { id: "A1C3SOZRARQ6R3", country: "PL", label: "Amazon.pl", region: "eu", sellerCentral: "sellercentral.amazon.pl" },
  { id: "A2NODRKZP88ZB9", country: "SE", label: "Amazon.se", region: "eu", sellerCentral: "sellercentral.amazon.se" },
  { id: "A1F83G8C2ARO7P", country: "UK", label: "Amazon.co.uk", region: "eu", sellerCentral: "sellercentral-europe.amazon.com" },
  { id: "A28R8C7NBKEWEA", country: "IE", label: "Amazon.ie", region: "eu", sellerCentral: "sellercentral.amazon.ie" },
  { id: "A33AVAJ2PDY3EV", country: "TR", label: "Amazon.com.tr", region: "eu", sellerCentral: "sellercentral.amazon.com.tr" },
  { id: "ATVPDKIKX0DER", country: "US", label: "Amazon.com", region: "na", sellerCentral: "sellercentral.amazon.com" },
  { id: "A2EUQ1WTGCTBG2", country: "CA", label: "Amazon.ca", region: "na", sellerCentral: "sellercentral.amazon.ca" },
  { id: "A1AM78C64UM0Y8", country: "MX", label: "Amazon.com.mx", region: "na", sellerCentral: "sellercentral.amazon.com.mx" },
  { id: "A1VC38T7YXB528", country: "JP", label: "Amazon.co.jp", region: "fe", sellerCentral: "sellercentral.amazon.co.jp" },
  { id: "A39IBJ37TRP1C6", country: "AU", label: "Amazon.com.au", region: "fe", sellerCentral: "sellercentral.amazon.com.au" },
];

/** Every Seller Central host above: the only places a consent may come back from. */
export const SELLER_CENTRAL_HOSTS: ReadonlySet<string> = new Set(AMAZON_MARKETPLACES.map((m) => m.sellerCentral));

export const AMAZON_REGION_LABEL: Record<AmazonRegion, string> = { eu: "Europa", na: "Nordamerika", fe: "Fernost" };

export function amazonMarketplace(id: string): AmazonMarketplace | undefined {
  return AMAZON_MARKETPLACES.find((m) => m.id === id);
}

export function amazonMarketplaceLabel(id: string): string {
  return amazonMarketplace(id)?.label ?? id;
}

/** Shows the start and end of a stored identifier only (e.g. the LWA client ID). */
export function maskIdentifier(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}
