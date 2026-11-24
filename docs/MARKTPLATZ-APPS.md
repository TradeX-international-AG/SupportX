# Marktplatz-Apps: was beantragt werden muss

Stand 19.11.2026 (Version 0.19.0). Diese Liste sagt je Marktplatz, ob SupportX
eine eigene, freigegebene Entwickler- oder Partner-App braucht, wer sie
beantragt und wo. Sie gilt für jede SupportX-Installation; konkrete Konten,
Schlüssel und Server stehen nie hier.

Zwei Arten von Zugang:

- **Schlüssel des Händlers:** Der Händler erzeugt im Portal des Marktplatzes
  selbst einen API-Schlüssel und trägt ihn in SupportX ein. Keine Freigabe
  durch den Marktplatz nötig.
- **App des Betreibers:** Der Betreiber der SupportX-Installation braucht ein
  eigenes Entwicklerkonto mit einer App, die der Marktplatz prüft und
  freigibt. Der Händler meldet sich danach nur noch an („Bei … anmelden“).

## Übersicht

| Marktplatz | Was SupportX nutzt | Zugang | App beantragen? | Stand |
| --- | --- | --- | --- | --- |
| Amazon | Käufernachrichten per Mail (Relay); Angebot schließen, Erstattung per SP-API | App des Betreibers (SP-API) | **Ja**: Rolle „Inventory and Order Tracking“ für Erstattungen | gebaut, App mit dieser Rolle fehlt |
| eBay | Nachrichten (Commerce Message API) | App des Betreibers (Keyset) | **Ja**: eigenes Keyset für SupportX empfohlen, Scope `commerce.message`, RuName auf `/oauth/ebay/callback` | gebaut, live nicht freigeschaltet |
| Kaufland | Tickets, Bestellstatus | Schlüssel des Händlers | Nein | gebaut |
| OTTO Market | Kundenanfragen per Mail; Bestellstatus per API | Schlüssel des Händlers (eigene App in Partner Connect) | **Nein** für einen Händler; **ja**, wenn SupportX als Service-Partner-App für viele Händler laufen soll | gebaut, nur Test-Double |
| Shop Apotheke | Posteingang (Mirakl), Bestellstatus | Schlüssel des Händlers | Nein, aber **Freigabe für Hintergrundabruf** beim Betreiber erfragen | gebaut |
| Douglas | wie Shop Apotheke (Mirakl) | Schlüssel des Händlers | Nein, Freigabe für Hintergrundabruf erfragen | gebaut, nur Test-Double |
| MediaMarkt/Saturn | wie Shop Apotheke (Mirakl) | Schlüssel des Händlers | Nein, Freigabe für Hintergrundabruf erfragen | gebaut, nur Test-Double |
| Conrad | wie Shop Apotheke (Mirakl) | Schlüssel des Händlers | Nein, Freigabe für Hintergrundabruf erfragen | gebaut, nur Test-Double |
| Decathlon | wie Shop Apotheke (Mirakl) | Schlüssel des Händlers | Nein, Freigabe für Hintergrundabruf erfragen | gebaut, nur Test-Double |
| Temu | – | App des Betreibers (Partner-Plattform) | **Ja** | nicht gebaut |
| DocMorris | Kundenanfragen per Mail | – | Nein | gebaut (Mail) |
| Shopify | Support-Mails | – | Nein | gebaut (Mail) |

## Zu beantragen

### 1. Amazon: SP-API-App mit Rolle „Inventory and Order Tracking“

- **Wofür:** „Erstattung bei Amazon“ aus dem Fall (Feed
  `POST_PAYMENT_ADJUSTMENT_DATA`) und das Lesen der Bestellung dazu. Das
  Schließen eines Angebots braucht zusätzlich „Product Listing“.
- **Wo:** Seller Central → Partner Network → „Develop Apps“
  (Solution Provider Portal). Für eine Installation, die nur ein eigenes
  Verkäuferkonto bedient, reicht eine **private App** („private developer“).
- **Wie:** Entwicklerprofil ausfüllen, Rollen „Inventory and Order Tracking“
  und „Product Listing“ anfragen, Anwendungsfälle beschreiben (Kundenservice,
  keine personenbezogenen Daten gespeichert außer zur Bearbeitung des Falls).
  Nach der Freigabe: Mit der App der Installation (`AMAZON_SP_*` in der
  `.env`, seit 0.23.0) unter „Amazon-Angebote“ „Bei Amazon anmelden“ bzw.
  „Neu anmelden“; Selbst-Hoster mit eigener App tragen den neuen
  Refresh-Token unter „Ändern“ ein. Stand 24.11.2026: Entwicklerprofil der
  Tradex AG (gilt auch für ASEIO) hat die Rolle noch nicht.
- **Dauer:** einige Tage bis Wochen (Prüfung durch Amazon).

### 2. eBay: eigenes Keyset für SupportX

- **Wofür:** Nachrichten lesen und beantworten (Commerce Message API).
- **Wo:** developer.ebay.com → „Application Keysets“ → neues Production-Keyset.
- **Wie:**
  1. Keyset anlegen (App ID, Cert ID). Ein Keyset kann nur **einen**
     Endpunkt für die Kontolöschungs-Benachrichtigungen haben; deshalb ein
     eigenes Keyset für SupportX statt des ASEIO-Keysets.
  2. Unter „Alerts & Notifications“ den Endpunkt
     `<öffentliche Adresse>/webhooks/ebay/account-deletion` und das Token aus
     `EBAY_DELETION_VERIFICATION_TOKEN` eintragen (sonst schaltet eBay die
     Production-Schlüssel nicht frei).
  3. Unter „User Tokens“ eine RuName anlegen, „Auth accepted URL“ =
     `<öffentliche Adresse>/oauth/ebay/callback`.
  4. Prüfen, ob der Scope `https://api.ebay.com/oauth/api_scope/commerce.message`
     für das Keyset freigegeben ist; falls nicht, über den eBay Developer
     Support („Request access“) anfragen.
  5. `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME` in die `.env` der
     Installation.
- **Später (nicht gebaut):** Bestellstatus und Erstattungen bei eBay brauchen
  zusätzlich `sell.fulfillment.readonly` bzw. `sell.finances`; dann melden sich
  Händler einmal neu bei eBay an.

### 3. Temu: Partner-App

- **Wofür:** Temu zeigt Käufernachrichten nur im Seller Center. Eine
  öffentliche Nachrichten-Schnittstelle für EU-Verkäufer haben wir nicht
  gefunden; Bestellungen gibt es über die Open API nur mit freigegebener App.
- **Wo:** partner-eu.temu.com (EU-Shops).
- **Wie:** Partner-Konto als „Independent Software Vendor“ anlegen (der Typ
  ist danach nicht änderbar), Firmenprofil mit Handelsregisterauszug,
  App vom Typ „ERP“ bzw. Kundenservice anlegen und die Bereiche Bestellungen
  und, falls angeboten, Kundenservice/Nachrichten beantragen. Bei der
  Gelegenheit **schriftlich fragen, ob Käufernachrichten per API lesbar und
  beantwortbar sind**. ASEIO hat dazu bereits einen Plan
  (Temu-ISV-Onboarding); dieselbe App kann SupportX mitnutzen, wenn die
  Bereiche passen.
- **Erst danach** baut SupportX Temu: ohne bestätigte Schnittstelle würden wir
  Endpunkte raten.

### 4. OTTO Market: nur wenn SupportX für viele Händler laufen soll

- **Ein Händler:** keine Freigabe nötig. In OTTO Partner Connect → „Apps“
  eine eigene App mit dem Bereich **Orders** anlegen und Client-ID und
  Client-Secret in SupportX eintragen (Einstellungen → Marktplätze → OTTO).
  Das Secret zeigt OTTO nur einmal.
- **Viele Händler:** Service-Partner-App bei OTTO beantragen
  (api.otto.market → „Service Partner“); Händler installieren sie dann über
  einen Link und stimmen allen Bereichen zu. Dafür müsste SupportX den
  Authorization-Code-Flow bekommen (nicht gebaut).
- **Kundennachrichten:** OTTO hat dafür keine API. Kundenanfragen kommen per
  Mail; in Partner Connect die Kundenservice-Adresse auf das SupportX-Postfach
  setzen und den Rückweg einmal mit einer Testantwort prüfen.

## Ohne App, aber beim Betreiber zu klären

### Mirakl-Marktplätze (Shop Apotheke, Douglas, MediaMarkt/Saturn, Conrad, Decathlon)

- **Schlüssel:** im Mirakl-Backoffice des jeweiligen Marktplatzes oben rechts
  unter dem Benutzer → „API-Schlüssel“. Die Adresse ist die des Backoffice
  (`https://….mirakl.net`).
- **Hintergrundabruf:** Mirakl beschreibt das Lesen des Posteingangs als
  „nur synchron, beim Anzeigen eines Posteingangs“. SupportX liest deshalb
  nur, solange SupportX offen ist, und per Klick. Für den Abruf rund um die
  Uhr beim Partner-Management des jeweiligen Marktplatzes **schriftlich um
  Freigabe bitten** und die Freigabe in der Verbindung vermerken.
- **Bestellstatus (OR11):** nutzt denselben Schlüssel. Falls der Marktplatz
  den Schlüssel auf Nachrichten beschränkt, beim Betreiber Leserecht auf
  Bestellungen erfragen.

### Kaufland

Keine App. Schlüssel im Kaufland Seller Portal → Einstellungen → API; ein
bestehendes Schlüsselpaar kopieren, nicht neu erzeugen.

## Weitere Marktplätze (noch nicht angefragt)

Nicht gebaut, weil bisher kein Händler sie nutzt. Bei Bedarf zuerst prüfen,
ob es eine Nachrichten-Schnittstelle gibt:

- **Galaxus (Digitec Galaxus):** prüfen, ob Kundenanfragen per Mail kommen;
  dann wie OTTO über das Postfach.
- **Allegro:** hat ein Message Center in der REST-API (OAuth-App im Allegro
  Developer Portal nötig; vor dem Bau prüfen).
- **bol.com:** prüfen, ob die Retailer API Kundenanfragen bietet oder ob sie
  per Mail kommen.
- **Zalando, Etsy, Hood und weitere Mirakl-Betreiber:** Weitere
  Mirakl-Betreiber lassen sich mit wenig Aufwand als eigene Karte ergänzen
  (`packages/core/marketplaces.ts`).
