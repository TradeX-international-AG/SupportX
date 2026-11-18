# Telefon-Hotline (ab 0.18.0)

Kundinnen und Kunden rufen eine Telefonnummer an und fragen zum Beispiel „Wo bleibt meine Lieferung?“ oder „Kann ich die Rechnung bekommen?“. Ein Sprachagent nimmt den Anruf an und fragt SupportX während des Gesprächs. SupportX selbst telefoniert nicht: Es stellt dem Agenten zwei Werkzeuge und einen Webhook bereit.

**Stand:** Getestet nur gegen lokale Testdoubles (weclapp, Microsoft) und mit synthetischen ElevenLabs-Webhooks. Ein echter Anruf über ElevenLabs und sipgate ist noch nicht gemacht. Die Schritte unten folgen der Dokumentation von ElevenLabs (Post-call webhooks, SIP trunking, Stand November 2026); was sipgate betrifft, ist vor dem Kauf zu prüfen (siehe „Offen“).

## Was der Agent darf

| Frage | Werkzeug | Was passiert |
| --- | --- | --- |
| Lieferstatus | `POST /voice/tools/order-status` | Erst wenn Bestellnummer **und** Postleitzahl oder Nachname zu weclapp passen, bekommt der Agent die Fakten zur Bestellung: weclapp-Buchungen (Lieferungen, Sendungsnummern) und, wenn ein DHL-Key hinterlegt ist, den Status laut DHL. Dieselben Fakten, die eine schriftliche Antwort zitieren darf. Keine Adressen, keine Beträge. |
| Rechnung | `POST /voice/tools/invoice` | Für eine bestätigte Bestellung: Fall im Posteingang mit der Rechnungs-PDF aus weclapp, Empfänger ist **nur** die Mailadresse, die weclapp für die Bestellung kennt (`salesInvoiceEmailAddresses`, sonst `recordEmailAddresses`). Eine am Telefon genannte Adresse wird nie verwendet. Der Agent nennt die Adresse nur maskiert (`e•••r@example.de`). Verschickt wird nach Klick auf „Senden“ oder automatisch, wenn die Regel „Rechnungsanfragen“ auf „senden“ steht und alle Prüfungen passen. |

Schutz gegen Raten: drei Fehlversuche je Anruf, dann bietet der Agent die Weiterleitung an einen Menschen an; höchstens 30 Fehlversuche je Arbeitsbereich und Stunde. Unbekannte Bestellung und falsche Antwort ergeben dieselbe Ansage, damit niemand Bestellnummern ausprobieren kann. Die Rufnummer des Anrufers beweist nichts; SupportX behält davon nur die letzten drei Ziffern für die Liste.

Nach dem Anruf schickt ElevenLabs den Webhook. Daraus wird ein Fall im Posteingang (Quelle „Telefon“) mit Zusammenfassung, bestätigter Bestellung und Rechnungswunsch. Den Gesprächstext speichert SupportX nur, wenn das in den Einstellungen eingeschaltet ist. Tonaufnahmen (`post_call_audio`) werden angenommen und verworfen. Ein Anruf, bei dem eine Bestellung bestätigt war, ElevenLabs ihn als erfolgreich meldet und nichts offen ist, wird als erledigt abgelegt.

## Einrichtung

### 1. SupportX

Einstellungen → Anbindungen → **Telefon-Hotline**:

1. „Schlüssel erzeugen“: Der Schlüssel `sxv_…` erscheint **einmal**. Kopieren.
2. Nach Schritt 3 das Webhook-Geheimnis aus ElevenLabs eintragen.
3. Gesprächstext speichern: ja oder nein.
4. Weiterleitungsnummer eintragen (nur zur Info für das Team).

Voraussetzungen: weclapp ist angebunden (sonst sagt der Agent, dass die Daten gerade nicht erreichbar sind), ein Microsoft-Postfach ist angebunden (dort liegen die Telefon-Fälle, von dort geht die Rechnung raus), `PUBLIC_BASE_URL` zeigt auf die öffentliche Adresse.

### 2. ElevenLabs-Agent

ElevenLabs → Agents → neuer Agent (Deutsch). Vorschlag für den Systemprompt (anpassen):

```
Du bist die Telefon-Hotline von <Firma>. Du sprichst Deutsch, freundlich und kurz.
Sage zu Beginn: „Sie sprechen mit einem KI-Assistenten.“ (bei Gesprächstext zusätzlich: „Das Gespräch wird als Text gespeichert.“)
Du hilfst bei zwei Fragen: Lieferstatus und Rechnung. Für alles andere, bei Gesundheitsfragen
und wenn ein Werkzeug handover=true meldet, bietest du die Weiterleitung an einen Mitarbeiter an.
Frage immer nach der Bestellnummer und nach der Postleitzahl oder dem Nachnamen aus der Bestellung.
Sage nur, was das Werkzeug in "say" und "facts" zurückgibt. Erfinde keine Liefertermine.
„Zugestellt“ nur, wenn DHL das meldet. Nenne keine Mailadresse außer der maskierten aus "say".
```

Zwei **Webhook-Werkzeuge** (Server tools), jeweils `POST`, Header `Authorization: Bearer <Schlüssel aus Schritt 1>` (als ElevenLabs-Secret speichern), Body-Parameter:

| Parameter | Typ | Quelle |
| --- | --- | --- |
| `call_id` | string | Dynamische Variable `system__conversation_id` |
| `caller_id` | string | Dynamische Variable `system__caller_id` (optional) |
| `order_number` | string | vom Agenten aus dem Gespräch: „Bestellnummer, wie der Anrufer sie nennt“ |
| `check` | string | vom Agenten: „Postleitzahl oder Nachname aus der Bestellung“ |

- `lieferstatus` → URL „Werkzeug Lieferstatus“ aus der Karte
- `rechnung_senden` → URL „Werkzeug Rechnung“ aus der Karte

Dazu das System-Werkzeug „Transfer to number“ mit der Weiterleitungsnummer.

**Post-call webhook** (Agents → Einstellungen → Webhooks): URL „Webhook nach dem Anruf“ aus der Karte, Ereignis „Transcription“; **„Send audio data“ aus**. Das angezeigte HMAC-Geheimnis in SupportX eintragen.

Datenschutz in ElevenLabs: Aufbewahrung von Transkripten und Audio so kurz wie möglich stellen (Agent → Advanced → Retention) und den Auftragsverarbeitungsvertrag (DPA) mit ElevenLabs abschließen.

### 3. Telefonnummer über sipgate

ElevenLabs nimmt Anrufe über einen SIP-Trunk an: Phone Numbers → Import number → From SIP Trunk, Nummer im E.164-Format (`+49…`), Digest-Authentifizierung mit Benutzer und Passwort. Der Anbieter schickt den Anruf an `sip:+49…@sip.rtc.elevenlabs.io:5061;transport=tls` (oder TCP 5060), Codec G.711 oder G.722.

Bei sipgate (Produkt „sipgate trunking“) muss die Nummer so eingestellt werden, dass eingehende Anrufe an diese SIP-Adresse gehen. **Vor dem Kauf bei sipgate klären:** ob trunking eingehende Anrufe an eine fremde SIP-Adresse (statt an eine registrierte Telefonanlage) zustellen kann und ob der Header `X-CALLER-ID` mitkommt. Geht das nicht, bleibt als Umweg eine Rufumleitung der sipgate-Nummer auf eine bei ElevenLabs direkt gekaufte oder über Twilio angebundene Nummer.

### 4. Antwortweg prüfen und Versand freigeben

Wie bei jedem Kanal ist der Versand gesperrt, bis der Antwortweg geprüft ist: einmal mit einer eigenen Bestellung anrufen, Rechnung anfordern, im Fall senden, Ankunft der Mail prüfen und in der Karte „Telefon-Hotline“ vermerken. Danach gilt die normale Freigabe des Postfachs („Versand freischalten“).

## Offen

- Echter Testanruf über ElevenLabs und sipgate (siehe oben, sipgate-Weiterleitung an eine SIP-Adresse ungeprüft).
- Ob ElevenLabs im Webhook die Anrufernummer unter `system__caller_id` liefert, ist für SIP-Nummern mit einem echten Webhook zu prüfen; ohne sie zeigt die Liste „Nummer unterdrückt“.
- Bei Amazon-Bestellungen steht in weclapp oft die Amazon-Weiterleitungsadresse. Die Rechnung geht dann über diese Adresse (Käufernachricht), wie bei einer schriftlichen Anfrage.
