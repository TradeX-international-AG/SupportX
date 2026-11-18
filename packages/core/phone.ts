import { createHmac, timingSafeEqual } from "node:crypto";
import type { CallerCheckData } from "./contracts.ts";

/**
 * Phone hotline (voice agent, e.g. ElevenLabs Agents over a SIP number). Pure rules
 * shared by the service and the tests: when a caller counts as verified, what the
 * agent may say about an order, and how the webhooks are authenticated.
 *
 * The caller's phone number never proves anything. A caller is verified only when the
 * order number and the postal code or last name both match weclapp. Invoices go only
 * to the address weclapp keeps for the order, never to one the caller names.
 */

/** Failed checks per call before the agent must hand over to a person. */
export const MAX_FAILED_CHECKS_PER_CALL = 3;
/** Failed checks per workspace and hour (guessing across many calls). */
export const MAX_FAILED_CHECKS_PER_HOUR = 30;
/** ElevenLabs signs post-call webhooks with a timestamp; older ones are refused. */
export const WEBHOOK_TOLERANCE_SEC = 30 * 60;

/** Spoken order numbers come with spaces, dashes or "minus"; compare letters and digits only. */
export function normalizeOrderNumber(value: string): string {
  return value.normalize("NFKC").replace(/\b(minus|bindestrich|strich)\b/gi, "").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase().slice(0, 40);
}

/** "Müller" = "mueller" = "MULLER"; spaces and dashes ignored. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}

export function normalizePostalCode(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * Does the caller's answer fit the order? A postal code must match exactly; a name
 * must match one last name (or the company) exactly after normalising, or equal its
 * umlaut-free spelling. No partial or fuzzy match: a near miss is a miss.
 */
export function callerMatches(answer: string, data: Pick<CallerCheckData, "postalCodes" | "lastNames">): boolean {
  const raw = answer.trim();
  if (!raw || raw.length > 100) return false;
  const zip = normalizePostalCode(raw);
  if (/\d/.test(zip) && zip.length >= 4 && zip.length <= 10) return data.postalCodes.some((p) => normalizePostalCode(p) === zip);
  const name = normalizeName(raw);
  if (name.length < 2) return false;
  // "Müller" spoken as "Muller" is the same person; nothing looser than that.
  const plain = (s: string) => normalizeName(s).replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u");
  return data.lastNames.some((n) => {
    const whole = [n, ...n.split("-")].filter((part) => normalizeName(part).length >= 3 || part === n);
    return whole.some((part) => normalizeName(part) === name || plain(part) === plain(raw));
  });
}

/** "m•••r@gmx.de": enough for the caller to recognise the address, too little to learn it. */
export function maskEmail(address: string): string {
  const [local, domain] = address.split("@");
  if (!local || !domain) return "die hinterlegte Adresse";
  const shown = local.length <= 2 ? `${local[0]}•` : `${local[0]}•••${local.at(-1)}`;
  return `${shown}@${domain}`;
}

/** Amazon, eBay & Co. relay addresses: the invoice goes over the marketplace's own messaging. */
export function isMarketplaceRelay(address: string): boolean {
  return /@(marketplace\.amazon\.[a-z.]+|members\.ebay\.[a-z.]+|kaufland-marktplatz\.de)$/i.test(address);
}

/** The last digits of the caller's number, for the case list only (never for checking). */
export function callerHint(callerId: string | undefined | null): string | null {
  const digits = (callerId ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-3)}` : null;
}

/**
 * Verify an ElevenLabs webhook signature: header "t=<unix>,v0=<hex>", where hex is
 * HMAC-SHA256(secret, "<t>.<raw body>") (as the ElevenLabs SDKs check it).
 */
export function verifyElevenLabsSignature(header: string | undefined, rawBody: string, secret: string, now: Date): { ok: true; timestamp: number } | { ok: false; reason: string } {
  if (!header || !secret) return { ok: false, reason: "Signatur fehlt." };
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v0 = parts.v0;
  if (!Number.isInteger(t) || !v0 || !/^[0-9a-f]{64}$/i.test(v0)) return { ok: false, reason: "Signatur unlesbar." };
  if (Math.abs(now.getTime() / 1000 - t) > WEBHOOK_TOLERANCE_SEC) return { ok: false, reason: "Signatur zu alt." };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const got = Buffer.from(v0, "hex");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: "Signatur falsch." };
  return { ok: true, timestamp: t };
}

export type TranscriptMode = "summary" | "transcript";

export interface CallTurn {
  role: "agent" | "user";
  message: string;
  atSec?: number;
}

/** Turns of an ElevenLabs transcript, text only (tool payloads and metrics are dropped). */
export function transcriptTurns(raw: unknown): CallTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t): CallTurn[] => {
    if (!t || typeof t !== "object") return [];
    const row = t as Record<string, unknown>;
    const message = typeof row.message === "string" ? row.message.trim() : "";
    if (!message) return [];
    const role: CallTurn["role"] = row.role === "agent" ? "agent" : "user";
    const at = typeof row.time_in_call_secs === "number" ? row.time_in_call_secs : undefined;
    return [{ role, message: message.slice(0, 4000), ...(at !== undefined ? { atSec: at } : {}) }];
  }).slice(0, 400);
}

/** The case text of a call: summary first, the conversation only when the workspace keeps transcripts. */
export function callCaseText(input: { summary?: string; turns: ReadonlyArray<CallTurn>; mode: TranscriptMode; durationSec?: number; notes: ReadonlyArray<string> }): string {
  const lines: string[] = [];
  lines.push(`Anruf über die Telefon-Hotline${input.durationSec ? ` (${Math.round(input.durationSec / 60) || 1} Min.)` : ""}.`);
  if (input.summary) lines.push("", `Zusammenfassung: ${input.summary.trim().slice(0, 3000)}`);
  if (input.notes.length) lines.push("", ...input.notes.map((n) => `• ${n}`));
  if (input.mode === "transcript" && input.turns.length) {
    lines.push("", "Gespräch:");
    for (const t of input.turns) lines.push(`${t.role === "agent" ? "Agent" : "Anrufer"}: ${t.message}`);
  }
  return lines.join("\n").slice(0, 60_000);
}
