// No imports: the browser bundle uses this file too.

/** category_reason of automatic marketplace notices to the seller (see category.ts). */
export const SYSTEM_NOTICE_REASON = "Systemmeldung des Marktplatzes";

/**
 * "Werbung & Infos" holds two different kinds of mail: advertising (newsletters,
 * webinars) and order notifications a marketplace or shop sends to the seller
 * ("Neuer Auftrag auf dem DocMorris Marktplatz: …", "Neue Bestellung", Amazon's
 * system notices about refunds and returns). Both stay category "info" (no draft,
 * no deadline); the inbox only shows them in separate tabs.
 *
 * The pattern is written so that JavaScript (flag i) and PostgreSQL (~*) read it alike:
 * no \b, no look-arounds, no quotes.
 */
export const ORDER_NOTICE_SUBJECT =
  "(neue[rs]?\\s+(auftrag|bestellung)|(auftrag|bestellung)\\s+(erhalten|eingegangen)|new\\s+order|order\\s+received|you\\s+(have\\s+)?sold|you.ve\\s+sold|(artikel|bestellung)\\s+(wurde\\s+)?verkauft|bestellung\\s+#?\\S*\\s*aufgegeben|order\\s+#?\\S*\\s*placed)";
const ORDER_NOTICE_RE = new RegExp(ORDER_NOTICE_SUBJECT, "i");

/** Only for mails already sorted as information: is it an order notification rather than advertising? */
export function isOrderNotice(c: { category: string; subject: string | null; category_reason?: string | null }): boolean {
  if (c.category !== "info") return false;
  return c.category_reason === SYSTEM_NOTICE_REASON || ORDER_NOTICE_RE.test(c.subject ?? "");
}

/** The same test as SQL on a conversations row aliased c. */
export const ORDER_NOTICE_SQL = `(c.category = 'info' AND (c.category_reason IS NOT DISTINCT FROM '${SYSTEM_NOTICE_REASON.replace(/'/g, "''")}' OR coalesce(c.subject, '') ~* '${ORDER_NOTICE_SUBJECT.replace(/'/g, "''")}'))`;
