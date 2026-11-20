# Lizenzmodell: Open Core wie Cal.com

Stand 20.11.2026. Vorschlag, entschieden ist nur der Rahmen (AGPL-Kern plus
`packages/ee/`); was nach `packages/ee/` kommt, entscheidet Lars.

## Wie Cal.com es macht

Cal.com steht unter AGPLv3. Die `LICENSE`-Datei beginnt mit einem Kopf, der
die Ordner `…/ee/` ausnimmt; dort gilt die „Cal.com Commercial License“
(Entwicklung und Test frei, Produktivbetrieb nur mit Abo, keine
Weitergabe). Beiträge von außen laufen über eine Rechteeinräumung an
Cal.com, damit Cal.com den Code auch kommerziell lizenzieren darf.

## Was SupportX jetzt hat

| Baustein | Stand |
| --- | --- |
| AGPL-3.0-only für den Kern | schon seit 0.9.2 (`LICENSE`, `package.json`) |
| Namensnennung in der Oberfläche (AGPL § 7(b)), Marken nicht lizenziert (§ 7(e)) | schon in `NOTICE` |
| Rechteeinräumung für Beiträge an TradeX inkl. Umlizenzierung, DCO | schon in `CONTRIBUTING.md` |
| Kopf in `LICENSE`, der `packages/ee/` ausnimmt | neu |
| `packages/ee/LICENSE` „SupportX Commercial License“ | neu, **Entwurf ohne Anwaltsprüfung** |
| Test, dass der Kern nie aus `packages/ee/` importiert | neu (`tests/unit/ee-boundary.test.ts`) |

## Vorschlag: was nach `packages/ee/` gehört

Faustregel wie bei Cal.com: Was ein einzelner Händler für seinen eigenen
Support braucht, bleibt AGPL. Was erst ab mehreren Teams, Mandanten oder
für Agenturen und Hoster wichtig wird, kommt nach `ee`.

Bleibt im AGPL-Kern (heute schon veröffentlicht, kann nicht zurückgeholt
werden): Postfach-Eingang, weclapp-Abgleich, KI-Entwürfe mit Prüfung,
Senden mit Outbox, alle Marktplatz-Kanäle, Rollen owner/agent/viewer.

Kandidaten für `ee` (alles neu, nichts davon existiert heute):

1. **SSO** (Microsoft Entra ID / SAML) und SCIM-Benutzerabgleich.
2. **Mandantenverwaltung für Agenturen:** viele Händler in einer Instanz,
   übergreifende Übersicht, Abrechnung je Mandant.
3. **Automatik ohne Freigabe** (M5): versionierte Tracking-Vorlagen, die
   unbeaufsichtigt antworten, mit Limits und Pause je Konto.
4. **Auswertungen und SLA:** Antwortzeiten, Fristen je Marktplatz,
   Qualität der Entwürfe, Kosten je Fall, Export.
5. **Revisionssicheres Audit-Log** mit Aufbewahrungsregeln und Export.
6. **Eigenes Branding ohne SupportX-Hinweis** (White-Label) als
   kommerzielle Ausnahme von der § 7(b)-Namensnennung.

Nicht nach `ee`: Sicherheit, Mandantentrennung und Fehlerbehebungen. Die
bleiben immer im Kern.

## Folgen, die Lars kennen sollte

- **Das Repo ist schon öffentlich.** `tradex-ag/SupportX` ist auf GitHub
  public (geprüft 20.11.2026). Alles, was dort steht, ist für jeden unter
  AGPL (bis 0.9.1 unter MIT) nutzbar, auch kommerziell. Das lässt sich nicht
  zurücknehmen; `ee` gilt nur für neuen Code.
- **Wer SupportX als Dienst anbietet, muss seine Änderungen offenlegen**
  (AGPL § 13): Ein Hoster, der eine veränderte Fassung für andere betreibt,
  muss den Nutzern den vollständigen Quellcode dieser Fassung unter AGPL
  anbieten. Er muss die Änderungen nicht an uns schicken, nur offenlegen.
  Unveränderter Betrieb ist ohne Pflicht erlaubt.
- **Für TradeX selbst** gilt die Pflicht nicht, weil TradeX Rechteinhaber
  ist. TradeX darf SupportX gehostet anbieten und `ee` dazu verkaufen.
  Voraussetzung: Fremde Beiträge kommen mit der Rechteeinräumung aus
  `CONTRIBUTING.md` (bisher sind alle Commits von TradeX).
- **Der `ee`-Code ist im öffentlichen Repo sichtbar**, wie bei Cal.com. Er
  ist nur nicht frei nutzbar. Wer ihn verstecken will, braucht ein eigenes
  privates Repo statt `packages/ee/`.
- **Abhängigkeiten:** AGPL-Kern und kommerzieller Teil dürfen keine
  GPL-/AGPL-Bibliothek eines Dritten in `ee` ziehen, sonst wäre `ee` selbst
  AGPL.
- **Die kommerzielle Lizenz ist ein Entwurf.** Vor dem ersten Verkauf sollte
  ein Anwalt sie prüfen (Schweizer Recht, Haftung, Abo-Bedingungen).

## Lizenzen der Abhängigkeiten (Prüfung 20.11.2026)

Ausgewertet aus `package-lock.json` (251 Pakete, davon 107 im Produktivbetrieb):

| Lizenz | Pakete (davon Produktion) | Passt zur AGPL? |
| --- | ---: | --- |
| MIT | 195 (81) | ja |
| Apache-2.0 | 23 (1) | ja (AGPLv3 ist mit Apache-2.0 vereinbar) |
| ISC | 16 (10) | ja |
| BlueOak-1.0.0 | 8 (8) | ja, freizügig |
| BSD-3-Clause | 5 (4) | ja |
| OFL-1.1 (Schriften Geist, JetBrains Mono) | 2 (2) | ja; die Schriften bleiben unter OFL |
| Unlicense | 1 (1) | ja |
| CC-BY-4.0 (`caniuse-lite`, nur Build) | 1 (0) | ja, landet nicht im Produkt |

Keine GPL-, AGPL-, SSPL- oder unbekannte Lizenz. Damit passt jede
Abhängigkeit sowohl zum AGPL-Kern als auch zu einem kommerziellen
`ee`-Teil.
