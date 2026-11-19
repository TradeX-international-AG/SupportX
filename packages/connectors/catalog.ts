import type { CapabilityState, SourcePlatform } from "../core/contracts.ts";

/**
 * Researched connector status, shown in the UI and docs. "documented" means the
 * vendor documents the operation; it does NOT mean this project implements it or
 * that an account was tested. Research date: 2026-10-21 (docs/CONNECTORS.md).
 */
export interface ConnectorDescriptor {
  platform: SourcePlatform | "microsoft" | "weclapp" | "dhl" | "temu";
  label: string;
  transport: string;
  implementation: "implemented" | "via_microsoft_mail" | "planned";
  receive: CapabilityState;
  reply: CapabilityState;
  accountTestNeeded: ReadonlyArray<string>;
  notes: string;
}

export const CONNECTOR_CATALOG: ReadonlyArray<ConnectorDescriptor> = [
  {
    platform: "microsoft",
    label: "Microsoft 365 (Graph)",
    transport: "Graph Mail API: Delta je Ordner, Reply, optionale Change Notifications",
    implementation: "implemented",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: [
      "Exchange-Online-Postfach und App-Registrierung (Mail.Read, später Mail.Send als Anwendungsberechtigung)",
      "Postfachbeschränkung per Exchange RBAC for Applications (erlaubtes und nicht erlaubtes Postfach testen)",
      "Bleibt der x-supportx-outbox-id-Header in Gesendete Elemente erhalten (Abgleich nach Timeout)?",
      "Weiterleiten: Gehen die Datei-Anhänge der Original-Mail mit, und bleibt der Marker-Header in der weitergeleiteten Kopie erhalten?",
    ],
    notes: "Eine 202-Antwort von Graph ist eine Annahme, kein Zustellnachweis.",
  },
  {
    platform: "weclapp",
    label: "weclapp (REST API v2)",
    transport: "Lesend: salesOrder, shipment (parcels[]), salesInvoice",
    implementation: "implemented",
    receive: "not_implemented",
    reply: "not_implemented",
    accountTestNeeded: [
      "In welchem Feld steht die Marktplatz-Bestellnummer (orderNumberAtCustomer, orderNumber, ecommerceOrder.ecommerceId)?",
      "Woran sind Verkäuferkonten im Auftrag erkennbar (salesChannel, Kunde, E-Commerce-Verbindung, Tag)?",
      "Filter shipment?mainSalesOrderId-eq liefert alle Teillieferungen?",
      "Bestehende Integrationen des Token-Nutzers vor jeder Token-Erneuerung prüfen",
    ],
    notes: "Einzige Bestelldatenquelle im ersten Build.",
  },
  {
    platform: "dhl",
    label: "DHL Sendungsstatus (Shipment Tracking – Unified API)",
    transport: "Lesend: GET /track/shipments je Sendungsnummer, beim Öffnen des Falls und per Klick",
    implementation: "implemented",
    receive: "not_implemented",
    reply: "not_implemented",
    accountTestNeeded: [
      "API-Key einer App im DHL-Entwicklerportal mit freigeschalteter „Shipment Tracking – Unified“-API",
      "Tageslimit des Keys (Start: 250 Abrufe am Tag) reicht für die Fälle; sonst im Portal „Request upgrade“",
      "Steht die Empfänger-PLZ in weclapp unter shipment.recipientAddress.zipcode (für Details wie Orte)?",
      "Stehen Retouren-Sendungsnummern in weclapp, oder nur in der Kundennachricht?",
    ],
    notes: "Nur der Status, den DHL meldet; ein Zustell-Scan belegt „zugestellt“ im Entwurf. Geprüft nur mit einem lokalen Test-Double, kein echter Key angebunden.",
  },
  {
    platform: "docmorris",
    label: "DocMorris",
    transport: "E-Mail über den Microsoft-Anschluss (vom Projektinhaber bestätigt)",
    implementation: "via_microsoft_mail",
    receive: "configured",
    reply: "documented",
    accountTestNeeded: ["Absender, Reply-To und Zuordnung einer kontrollierten Antwort zum DocMorris-Vorgang anhand einer echten Nachricht"],
    notes: "Kein eigener API-Connector nötig. Versand bleibt gesperrt, bis der Rückweg geprüft ist.",
  },
  {
    platform: "amazon",
    label: "Amazon (Buyer-Seller-Messaging-Relay)",
    transport: "Relay-E-Mail über den Microsoft-Anschluss",
    implementation: "via_microsoft_mail",
    receive: "configured",
    reply: "documented",
    accountTestNeeded: [
      "Absenderadresse in Seller Central (Messaging Permissions) freigeschaltet",
      "Kontrollierte Antwort erscheint im richtigen Seller-Central-Vorgang",
    ],
    notes: "Die SP-API Messaging API ist kein allgemeiner Posteingang; sie bietet nur bestimmte Aktionen je Bestellung.",
  },
  {
    platform: "shopify",
    label: "Shopify (Support-E-Mail)",
    transport: "E-Mail über den Microsoft-Anschluss",
    implementation: "via_microsoft_mail",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: ["Kontaktformular/Support-Mails landen im angebundenen Postfach"],
    notes: "Kein Shopify-Bestellanschluss; Bestellungen kommen aus weclapp. Shopify-Inbox-Chats nur bei tatsächlicher Nutzung prüfen.",
  },
  {
    platform: "ebay",
    label: "eBay (Commerce Message API)",
    transport: "OAuth je Verkäuferkonto; getConversations / getConversation / send_message, Abruf alle 5 min",
    implementation: "implemented",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: [
      "Eigenes eBay-Keyset mit Scope commerce.message und RuName auf /oauth/ebay/callback",
      "Filtert start_time nach Erstellung oder letzter Aktivität der Konversation?",
      "Wie erscheint die eBay-Bestellnummer in der Nachricht (nur Artikelnummer = keine Bestellung)?",
      "Kontrollierte Testantwort erscheint in der eBay-Konversation",
    ],
    notes: "Nur Mitglieder-Konversationen, keine eBay-Systemnachrichten. NEW_MESSAGE-Push noch nicht angebunden.",
  },
  {
    platform: "kaufland",
    label: "Kaufland (Seller API Tickets)",
    transport: "HMAC-signiert; GET /tickets/messages, GET /tickets/{id}, POST /tickets/{id}/messages, Abruf alle 5 min; Bestellstatus lesend über GET /orders/{id_order} per Klick im Fall",
    implementation: "implemented",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: [
      "API-Schlüssel aus dem Seller Portal",
      "Werte von author.role (Käufer, Verkäufer, Kaufland-Service)",
      "In welchem weclapp-Feld steht die Kaufland-Bestellnummer (id_order)?",
      "Kontrollierte Testantwort im Ticket sichtbar",
    ],
    notes: "Antworten werden mit interim_notice=false gesendet (normale, kundensichtbare Antwort). Kein Ticket-Push dokumentiert.",
  },
  {
    platform: "otto",
    label: "OTTO Market (Mail + Orders API v4)",
    transport: "Kundenanfragen per E-Mail über den Microsoft-Anschluss; Bestellstatus lesend über GET /v4/orders/{orderNumber} (eigene App, Client Credentials, Scope orders), nur per Klick im Fall",
    implementation: "via_microsoft_mail",
    receive: "configured",
    reply: "documented",
    accountTestNeeded: [
      "Kommen OTTO-Kundenanfragen als Mail im Postfach an, und mit welchem Absender/Reply-To?",
      "Erreicht eine Antwort auf diese Mail den Kunden (Rückweg einmal kontrolliert prüfen)?",
      "Eigene App in OTTO Partner Connect mit Scope „orders“; liefert das Token den Scope?",
      "Feldnamen von Artikeltitel und Sendungsnummer in positionItems",
    ],
    notes: "OTTO bietet keine API für Kundennachrichten. Die OTTO-Schnittstelle zeigt nur den Bestellstatus, sie geht nicht in den Entwurf. Geprüft nur mit einem lokalen Test-Double.",
  },
  {
    platform: "shop_apotheke",
    label: "Mirakl-Marktplätze: Shop Apotheke, Douglas, MediaMarkt/Saturn, Conrad, Decathlon (M10–M13, OR11)",
    transport: "Mirakl-Posteingang der Betreiber-Instanz; Abruf bei offenem Posteingang (höchstens alle 10 min) und per Klick, Hintergrundabruf nur mit Freigabe",
    implementation: "implemented",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: [
      "Adresse der Mirakl-Instanz je Marktplatz und Nachrichtenrechte des API-Schlüssels",
      "Liefert OR11 (GET /api/orders) mit demselben Schlüssel die Bestellung (Bestellstatus im Fall)?",
      "Freigabe des Betreibers für Hintergrundabruf (Mirakl: synchron beim Öffnen des Posteingangs)",
      "Format der Bestellnummer (MMP_ORDER) in weclapp",
      "Kontrollierte Testantwort an Kunde bzw. Betreiber",
    ],
    notes: "Ein Adapter für alle Mirakl-Betreiber, je Betreiber eine eigene Karte. Empfänger kommt aus dem Vorgang selbst (Kunde oder Betreiber), nie aus dem Entwurf. Nur Shop Apotheke war bisher im Gespräch; Douglas, MediaMarkt/Saturn, Conrad und Decathlon sind nur mit dem Test-Double geprüft.",
  },
  {
    platform: "temu",
    label: "Temu",
    transport: "Kundennachrichten nur im Temu Seller Center (Chat); keine öffentliche Nachrichten-API für EU-Verkäufer gefunden",
    implementation: "planned",
    receive: "not_implemented",
    reply: "not_implemented",
    accountTestNeeded: [
      "Partner-App bei Temu (partner-eu.temu.com) beantragen, siehe docs/MARKTPLATZ-APPS.md",
      "Klären, ob Temu Käufernachrichten über die Open API freigibt",
    ],
    notes: "Nicht gebaut: ohne freigegebene App und bestätigte Nachrichten-Schnittstelle würde SupportX Endpunkte raten.",
  },
];
