/**
 * Return labels (DHL Parcel DE Returns): the customer's address as the ERP keeps it,
 * checked and shaped for DHL. Pure functions, no I/O.
 *
 * DHL wants the sender ("shipper") of the return: name1 (max 50 chars), optional
 * name2/name3, addressStreet + addressHouse, postalCode, city and country as ISO
 * 3166-1 alpha-3 ("DEU"). The receiver is the merchant's return address, chosen by
 * the receiver ID set up in the DHL business customer portal ("Retouren-Empfänger"),
 * one per country the customer sends from.
 */

/** The customer's address from the ERP (delivery address, else invoice/record address). */
export interface ReturnAddress {
  /** Person or company, as printed first on the label. */
  name1: string;
  /** Second line, e.g. the person at a company or "c/o". */
  name2?: string;
  street: string;
  houseNumber?: string;
  /** Extra address line (Hinterhaus, Packstation customer number …). */
  addressExtra?: string;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2, e.g. "DE". */
  countryCode: string;
}

/** EU countries (alpha-2 → alpha-3). DHL returns from other countries need customs data, which SupportX does not send. */
export const EU_COUNTRIES: Readonly<Record<string, { alpha3: string; name: string }>> = {
  DE: { alpha3: "DEU", name: "Deutschland" },
  AT: { alpha3: "AUT", name: "Österreich" },
  BE: { alpha3: "BEL", name: "Belgien" },
  BG: { alpha3: "BGR", name: "Bulgarien" },
  CY: { alpha3: "CYP", name: "Zypern" },
  CZ: { alpha3: "CZE", name: "Tschechien" },
  DK: { alpha3: "DNK", name: "Dänemark" },
  EE: { alpha3: "EST", name: "Estland" },
  ES: { alpha3: "ESP", name: "Spanien" },
  FI: { alpha3: "FIN", name: "Finnland" },
  FR: { alpha3: "FRA", name: "Frankreich" },
  GR: { alpha3: "GRC", name: "Griechenland" },
  HR: { alpha3: "HRV", name: "Kroatien" },
  HU: { alpha3: "HUN", name: "Ungarn" },
  IE: { alpha3: "IRL", name: "Irland" },
  IT: { alpha3: "ITA", name: "Italien" },
  LT: { alpha3: "LTU", name: "Litauen" },
  LU: { alpha3: "LUX", name: "Luxemburg" },
  LV: { alpha3: "LVA", name: "Lettland" },
  MT: { alpha3: "MLT", name: "Malta" },
  NL: { alpha3: "NLD", name: "Niederlande" },
  PL: { alpha3: "POL", name: "Polen" },
  PT: { alpha3: "PRT", name: "Portugal" },
  RO: { alpha3: "ROU", name: "Rumänien" },
  SE: { alpha3: "SWE", name: "Schweden" },
  SI: { alpha3: "SVN", name: "Slowenien" },
  SK: { alpha3: "SVK", name: "Slowakei" },
};

/** Country of an address in any common spelling ("DE", "DEU", "Deutschland") → alpha-2, or undefined. */
export function countryAlpha2(raw: string | undefined): string | undefined {
  const v = raw?.trim().toUpperCase();
  if (!v) return undefined;
  if (v.length === 2) return v;
  for (const [a2, c] of Object.entries(EU_COUNTRIES)) if (c.alpha3 === v || c.name.toUpperCase() === v) return a2;
  if (v === "GERMANY") return "DE";
  if (v === "AUSTRIA") return "AT";
  return undefined;
}

/**
 * "Musterstraße 12a" → street + house number. A street without a trailing number stays
 * whole (DHL accepts the house number inside addressStreet). Leading numbers, as in
 * "12 Rue de la Paix", are moved to the house number too.
 */
export function splitStreet(raw: string): { street: string; houseNumber?: string } {
  const s = raw.replace(/\s+/g, " ").trim();
  const tail = /^(.*?[^\d\s,])[\s,]+(\d+[\p{L}]?(?:\s*[-/]\s*\d+[\p{L}]?)?(?:\s*[\p{L}])?)$/u.exec(s);
  if (tail) return { street: tail[1]!.trim(), houseNumber: tail[2]!.replace(/\s+/g, "") };
  const head = /^(\d+[\p{L}]?)[\s,]+(\D.*)$/u.exec(s);
  if (head) return { street: head[2]!.trim(), houseNumber: head[1]! };
  return { street: s };
}

/** "Erika Müller", or the company with the person on line 2. */
export function addressNames(input: { company?: string; company2?: string; firstName?: string; lastName?: string }): { name1?: string; name2?: string } {
  const person = [input.firstName, input.lastName].map((v) => v?.trim()).filter(Boolean).join(" ");
  const company = [input.company, input.company2].map((v) => v?.trim()).filter(Boolean).join(" ");
  if (company) return { name1: company, ...(person ? { name2: person } : {}) };
  return person ? { name1: person } : {};
}

export interface ReceiverChoice {
  /** alpha-3 → receiver ID, as set up in the DHL business customer portal. */
  receiverIds: Readonly<Record<string, string>>;
}

export interface DhlShipper {
  name1: string;
  name2?: string;
  addressStreet: string;
  addressHouse?: string;
  additionalAddressInformation1?: string;
  postalCode: string;
  city: string;
  country: string;
}

const LIMITS = { name: 50, street: 50, house: 10, extra: 60, city: 40, postal: 10 } as const;

const clean = (v: string | undefined) => v?.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() || undefined;

/**
 * Check an address before asking DHL, in words a person can act on. Returns the
 * DHL shipper and the receiver ID for the customer's country, or the problems.
 */
export function checkReturnAddress(address: ReturnAddress, choice: ReceiverChoice): { ok: true; shipper: DhlShipper; receiverId: string; country: string } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const name1 = clean(address.name1);
  const name2 = clean(address.name2);
  const street = clean(address.street);
  const house = clean(address.houseNumber);
  const extra = clean(address.addressExtra);
  const postalCode = clean(address.postalCode)?.replace(/\s+/g, "");
  const city = clean(address.city);
  const a2 = countryAlpha2(address.countryCode);
  if (!name1) problems.push("Name fehlt.");
  else if (name1.length > LIMITS.name) problems.push(`Name ist zu lang (höchstens ${LIMITS.name} Zeichen bei DHL).`);
  if (name2 && name2.length > LIMITS.name) problems.push(`Zweite Namenszeile ist zu lang (höchstens ${LIMITS.name} Zeichen).`);
  if (!street) problems.push("Straße fehlt.");
  else if (street.length > LIMITS.street) problems.push(`Straße ist zu lang (höchstens ${LIMITS.street} Zeichen).`);
  if (house && house.length > LIMITS.house) problems.push(`Hausnummer ist zu lang (höchstens ${LIMITS.house} Zeichen).`);
  if (extra && extra.length > LIMITS.extra) problems.push(`Adresszusatz ist zu lang (höchstens ${LIMITS.extra} Zeichen).`);
  if (!city) problems.push("Ort fehlt.");
  else if (city.length > LIMITS.city) problems.push(`Ort ist zu lang (höchstens ${LIMITS.city} Zeichen).`);
  const country = a2 ? EU_COUNTRIES[a2] : undefined;
  if (!a2) problems.push("Land fehlt.");
  else if (!country) problems.push(`Rücksendungen aus ${a2} brauchen Zollangaben. Das kann SupportX nicht; bitte das Label im DHL-Geschäftskundenportal erstellen.`);
  if (!postalCode) problems.push("Postleitzahl fehlt.");
  else if (a2 === "DE" && !/^\d{5}$/.test(postalCode)) problems.push("Die Postleitzahl muss in Deutschland fünf Ziffern haben.");
  else if (postalCode.length > LIMITS.postal) problems.push("Postleitzahl ist zu lang.");
  const receiverId = country ? choice.receiverIds[country.alpha3] : undefined;
  if (country && !receiverId) problems.push(`Für ${country.name} ist kein Retouren-Empfänger eingetragen (Einstellungen → Anbindungen → DHL-Retourenlabel).`);
  if (problems.length || !country || !receiverId) return { ok: false, problems };
  return {
    ok: true,
    receiverId,
    country: country.alpha3,
    shipper: {
      name1: name1!,
      ...(name2 ? { name2 } : {}),
      addressStreet: street!,
      ...(house ? { addressHouse: house } : {}),
      ...(extra ? { additionalAddressInformation1: extra } : {}),
      postalCode: postalCode!,
      city: city!,
      country: country.alpha3,
    },
  };
}

/**
 * Receiver IDs as typed in the settings: "deu" alone means Germany; further countries
 * as "AUT=aut, BEL=bel" (alpha-2 or alpha-3 before the equals sign).
 */
export function parseReceiverIds(germany: string, others = ""): { ok: true; ids: Record<string, string> } | { ok: false; error: string } {
  const ids: Record<string, string> = {};
  const idOk = (v: string) => /^[A-Za-z0-9_-]{1,30}$/.test(v);
  const de = germany.trim();
  if (de) {
    if (!idOk(de)) return { ok: false, error: "Die Empfänger-ID für Deutschland hat nicht das erwartete Format (Buchstaben und Ziffern, wie im DHL-Geschäftskundenportal unter Retouren)." };
    ids.DEU = de;
  }
  for (const part of others.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^([A-Za-z]{2,3})\s*[=:]\s*(\S+)$/.exec(part);
    const a2 = m ? countryAlpha2(m[1]) : undefined;
    const country = a2 ? EU_COUNTRIES[a2] : undefined;
    if (!m || !country) return { ok: false, error: `„${part}“ verstehe ich nicht. Bitte so schreiben: AUT=aut, BEL=bel (nur EU-Länder).` };
    if (!idOk(m[2]!)) return { ok: false, error: `Die Empfänger-ID bei „${part}“ hat nicht das erwartete Format.` };
    ids[country.alpha3] = m[2]!;
  }
  if (!ids.DEU && Object.keys(ids).length === 0) return { ok: false, error: "Bitte mindestens die Empfänger-ID für Deutschland eintragen." };
  return { ok: true, ids };
}

/** Country names for the settings view (receiver IDs themselves stay hidden). */
export function receiverCountries(ids: Readonly<Record<string, string>>): string[] {
  // Germany first, then in the order of the country list.
  const order = Object.values(EU_COUNTRIES).map((c) => c.alpha3);
  return Object.keys(ids)
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map((a3) => Object.values(EU_COUNTRIES).find((c) => c.alpha3 === a3)?.name ?? a3);
}
