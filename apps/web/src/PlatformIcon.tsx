import { platformMark } from "../../../packages/core/marketplaces.ts";

/** Envelope / phone pictograms, 1.5px stroke, currentColor. */
function Pictogram({ kind, size }: { kind: "mail" | "phone"; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      {kind === "mail"
        ? <><rect x="2" y="3.5" width="12" height="9" rx="0.5" /><path d="M2.5 4.5 8 8.75l5.5-4.25" /></>
        : <path d="M5.5 2.5h-2a1 1 0 0 0-1 1.1C3 9 7 13 12.4 13.5a1 1 0 0 0 1.1-1v-2l-2.6-1-1.4 1.4A7 7 0 0 1 5.6 7l1.4-1.4-1-2.6Z" />}
    </svg>
  );
}

/**
 * Marketplace mark in front of every case: where the enquiry comes from at a
 * glance. Shows the order's sales channel when known (e.g. DocMorris for an
 * e-mail about a DocMorris order) with a small envelope for the way it came in.
 */
export function PlatformIcon({ source, origin }: { source: string | null | undefined; origin?: string | null }) {
  const mark = platformMark(source, origin);
  const kind = mark.platform === "phone" ? "phone" : "mail";
  return (
    <span className={`platform-mark ${mark.text ? "letters" : "picto"}`} data-platform={mark.platform} title={mark.name} role="img" aria-label={mark.name}>
      {mark.text ?? <Pictogram kind={kind} size={16} />}
      {mark.via && <span className="platform-mark-via" aria-hidden="true"><Pictogram kind={mark.via === "phone" ? "phone" : "mail"} size={10} /></span>}
    </span>
  );
}
