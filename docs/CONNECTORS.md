# Connector research and implementation gates

Research checked: **2026-10-21**. Evidence links are listed in [SOURCES.md](SOURCES.md).

## Implementation status (version 0.2.0, 2026-10-22)

| Connector | Status in code | Tested against | Open account tests |
| --- | --- | --- | --- |
| Microsoft 365 (Graph mail) | **Implemented**: delta sync per folder (Inbox, Sent Items), reply, outbox marker header, reconciliation, optional change notifications | Local Graph test double only | App registration, Mail.Read/Mail.Send application permissions, RBAC mailbox scoping (allowed + denied mailbox), shared mailbox, whether `x-supportx-outbox-id` survives in Sent Items |
| weclapp (REST v2, read-only) | **Implemented**: salesOrder lookup by configured fields, shipments with all parcels, invoices (`salesOrders.id` filter, as `salesOrderId` is not filterable in v2) and invoice PDF download, account scope check; weights for the parcel check (0.9.3): `article.articleGrossWeight` / `articleNetWeight` and `shipment.packageWeight` in kg, plus `parcels[].weight` / `packageWeight` (parcel field name in v2 not yet confirmed on a live tenant) | Local weclapp test double only | Tenant URL, read-only user/token, real field mapping (`orderNumberAtCustomer`, `salesChannel` or other scope field), multi-parcel shipment |
| DocMorris | Via Microsoft mail + routing rule (sender domain) | Synthetic mails | Real sender/Reply-To, order number format, controlled test reply into the DocMorris thread |
| Amazon | Via Microsoft mail (Buyer-Seller relay) + routing rule | Synthetic mails | Relay sender domain, approved sender in Seller Central, test reply visible in Seller Central |
| Shopify | Via Microsoft mail (support address) | Synthetic mails | Real routing of shop contact mails |
| eBay | **Implemented (0.2.0)**: OAuth consent per seller account (`prompt=login`), member conversations, reply in conversation, text-based reconciliation, Marketplace Account Deletion endpoint (`/webhooks/ebay/account-deletion`, signature-checked) | Local eBay test double only | Keyset + RuName, `commerce.message` consent, `start_time` semantics, order reference format, conversation round trip, deletion test notification |
| Kaufland | **Implemented (0.2.0)**: HMAC-signed ticket message polling (5 min), ticket detail with order and buyer, reply in ticket (`interim_notice=false`) | Local Kaufland test double only | API keys, `author.role` values, `id_order` field in weclapp, ticket round trip |
| Shop Apotheke (Mirakl) | **Implemented (0.2.0)**: M11 read on demand, background reads only with recorded operator permission, M12 reply to customer or operator taken from the thread | Local Mirakl test double only | Operator instance URL, key scopes, permitted sync mode, order id format |

The UI shows the same status under *Einstellungen → Konnektoren – Stand* (source: `packages/connectors/catalog.ts`). This document still describes researched capabilities; it does not certify access for any seller account, app registration, marketplace, mailbox or deployment.

## Native marketplace channels (0.2.0)

The eBay, Kaufland and Mirakl adapters live in `packages/connectors/{ebay,kaufland,mirakl}`. The Kaufland signing and the eBay OAuth helpers are adapted from the project owner's ASEIO connectors and contributed under MIT. All three:

- use the same outbox, approval and reply-route verification as mail; sending stays off until a controlled reply is recorded and the connection is switched on;
- carry no custom headers, so our own reply is recognised (echo, reconciliation) by exact text in the same thread, or by the provider message id returned from the send call;
- put the marketplace order id into the case subject with a label (`Bestellung …`) so the normal reference extraction looks it up in weclapp; a listing id is never treated as an order id;
- poll in bounded intervals (`pollIntervalSec`, eBay and Kaufland 5 min). Mirakl is read while the SupportX inbox is on screen (at most every 10 min per connection, only in a visible tab) and when someone clicks *Jetzt abrufen*, until the owner records the operator's permission for background reads. Connections not read for more than 4 hours are flagged in the inbox and on their card.

## More marketplaces (0.19.0, 2026-11-19)

Requested by the project owner: every marketplace ASEIO connects to, through
its API where one exists. Which developer apps still have to be applied for is
listed in [MARKTPLATZ-APPS.md](MARKTPLATZ-APPS.md).

- **Mirakl marketplaces:** Douglas, MediaMarkt/Saturn, Conrad and Decathlon run
  on Mirakl like Shop Apotheke. Each is its own platform (card, seller account,
  reply deadline, messaging check) on the same `mirakl_inbox` adapter; the
  connection's `default_source_platform` names the operator. No operator
  address is built in. Same "synchronous only" rule as Shop Apotheke.
- **OTTO Market:** OTTO has no customer-message API (checked against the
  interface list on api.otto.market, OTTO-1). Customer contacts arrive by
  e-mail and are a mail market like DocMorris. The OTTO Orders API v4 is
  connected separately (`marketplace_api_connections`, own app with scope
  `orders`, client credentials) and only used for the order status in the case.
- **Order status in the case ("Bei … nachsehen"):** read-only, on a person's
  click, never for the worker or the AI, never in a draft. Kaufland
  `GET /orders/{id_order}` (order units grouped per article and status),
  Mirakl OR11 `GET /api/orders?order_ids=` (state per line, tracking,
  refunds), OTTO `GET /v4/orders/{orderNumber}` (fulfillmentStatus per
  position item). Order numbers are restricted to `[A-Za-z0-9_-]` before they
  go into a URL. eBay needs the extra scope `sell.fulfillment.readonly`
  (seller re-login), not built.
- **Temu:** not built. Buyer messages live in the Seller Center chat; no
  public message API for EU sellers was found, and the Open API needs an
  approved partner app. See MARKTPLATZ-APPS.md.

All of it is tested only against local test doubles
(`packages/testing/fake-marketplaces.ts`); no live Douglas, MediaMarkt/Saturn,
Conrad, Decathlon or OTTO account has been connected.

## Preparing native channels (M3, original notes)

All channels implement `MessageChannel` in `packages/core/contracts.ts` (`sync`, `sendReply`, `reconcileReply`, `checkAccess`, declared `capabilities`). Rules for the next adapters:

- **Amazon:** keep the email relay as the only route. SP-API Messaging is outgoing-only, order-action based and has no inbox; do not use it for dialogue replies.
- **eBay:** Commerce Message API (`getConversations`, `getConversation`, `sendMessage`, `NEW_MESSAGE` notification). OAuth helpers can follow the pattern used in the operator's existing integration, without copying proprietary code.
- **Kaufland:** tickets + `POST /tickets/{id}/messages`; bounded polling; `interim_notice=true` is customer-visible.
- **Shop Apotheke:** Mirakl M11/M10/M12; background polling only after the operator confirms it is allowed.
- **No duplicate cases from email copies:** marketplaces often also email a copy of a native message. Native adapters must fill `IngressMessage.aliasKeys` (e.g. `ebay:conversation:<id>:<messageId>`), and the mail routing for such copies must be set to “notification only” before a native channel is switched on. The `messages.alias_keys` column and index exist; the cross-channel merge itself is part of M3 and **not implemented yet**.
- Each capability starts as `not_implemented`/`documented` and becomes `verified` only after a recorded account test.

## First-build scope

**Message channels -> order lookup in weclapp -> reply through the original message channel.** All required order data already resides in weclapp. It is the **only `OrderProvider` in the first build**; marketplace message adapters supply conversation and external order references for that lookup.

There is no second order import from Shopify, Amazon, DocMorris, eBay, Kaufland or Mirakl in this scope. Previously researched order APIs are reference-only possibilities for other installations, not dependencies or required roadmap items. An unresolved order reference goes to manual review or an approved clarification workflow; it must not silently enable another order source.

For Shopify, the first build handles support emails through Microsoft 365. A Shopify Admin API order/fulfillment connector is out of scope. Shopify Inbox needs a separate capability decision only if the operator actually uses it.

## First-build capability matrix

| Connector | First-build transport | Order context | Inbound messages | Outbound messages | Synchronization plan | Required validation gate |
| --- | --- | --- | --- | --- | --- | --- |
| Microsoft 365 | Microsoft Graph | weclapp lookup using verified order references | Mail API | Graph reply from the authorized mailbox | Change notifications plus folder delta reconciliation and subscription renewal | Confirm an Exchange Online mailbox, app permissions, effective mailbox scope, reply behavior and subscription support |
| Amazon | Amazon Buyer-Seller email relay through Microsoft 365 | weclapp; no SP-API order import | Notification email; no public SP-API inbox operation verified | Authorized email sender to the original Amazon relay conversation | Mail synchronization | Verify Seller Central notification address, sender authorization, relay/thread routing, marketplace and fulfillment mode |
| eBay | Commerce Message API | weclapp lookup from conversation/order references | `getConversations`, `getConversation` | `sendMessage` | `NEW_MESSAGE` notifications with message reconciliation, subject to available permissions and limits | OAuth user authorization, `commerce.message` scope, app access, topic availability and conversation round trip |
| Kaufland | Seller API tickets | weclapp lookup from ticket/order references | Ticket list and ticket/message resources | `POST /tickets/{id_ticket}/messages` | Bounded polling with pagination, overlap and deduplication; no ticket/message push verified | API credentials, storefront/account routing, customer/operator recipients and message visibility |
| Shop Apotheke | Operator-specific Mirakl messaging API | weclapp lookup from thread/order references | M11 thread list; M10 thread detail | M12 reply to thread | User-triggered inbox retrieval initially; background collection requires operator confirmation | Correct Mirakl instance/shop, message scopes, API key and explicit permitted automation mode |
| DocMorris | Email through the shared Microsoft 365 connector | weclapp; no native DocMorris or Partner API order connector | Incoming email confirmed by the user; include ingestion in M1 | Email only after validating the original reply route | Microsoft mailbox synchronization in M1 | Before outbound activation: verify Reply-To/destination and end-to-end thread acceptance; inbound email does not prove reply capability |
| Shopify | Support email through Microsoft 365 | weclapp; no Shopify Admin order/fulfillment connector | Store email/contact-form enquiries delivered to the connected mailbox | Replies through the original email conversation | Mailbox reconciliation only | Verify actual support mail routing; ask about Shopify Inbox only if used |
| weclapp | REST API v2; sole first-build `OrderProvider` | `salesOrder`, `shipment`, `salesInvoice`, `incomingGoods` (customer returns, type `CUSTOMER_RETURN`), `shipmentReturnReason` | Not a marketplace message transport | Not a marketplace message transport | Read-only order/context lookup; any local cache must preserve source and freshness | Tenant URL, least-privilege token, external order mapping and parcel data; confirm token-rotation behavior |

## Microsoft 365

Graph supports replying to an existing message, change notifications and delta queries for message changes. Use an explicitly configured mailbox identity. A Microsoft login alone does not establish that the user's email is hosted in Exchange Online.

For unattended access to shared/delegated mailboxes, validate the documented application-permission route; do not assume delegated `Mail.Read.Shared` supports change-notification subscriptions. Restrict application access to the intended mailboxes with Exchange Application RBAC. Separately granted, unscoped Microsoft Entra permissions can expand effective access, so test both an allowed and a disallowed mailbox. Reading messages and sending replies are separate permissions; avoid requesting write access merely to store drafts in this application's own database.

Treat notifications as signals to reconcile state, not as an exactly-once message stream. Persist each folder's delta cursor, renew subscriptions and recover from invalid cursors. A successful send request is not proof of recipient delivery. See [MS-1–MS-4](SOURCES.md#microsoft).

## Amazon

**First build:** ingest and answer Amazon customer-service messages through the authorized email relay. Resolve all order and shipment context in weclapp. No Amazon Orders connector or SP-API registration is a prerequisite for this email-based design.

**Research only:** Messaging API v1 supports outgoing, order-specific actions. `getMessagingActionsForOrder` returns available actions, not received messages. Some actions allow custom text; others restrict text or attachments. There is no verified generic inbox/read/reply operation or incoming buyer-message notification. A generic “mark no response required” API is also unverified.

For customer-service conversations, use the Amazon relay address and a sender approved in Seller Central Messaging Permissions. The account's notification mailbox supplies the incoming message. Validate the resulting conversation in Seller Central; preserve the seller account and marketplace identity throughout routing. Do not replace the relay address with an unrelated personal email address.

Do not repurpose an API action merely because it accepts text. For example, the current role/region matrix lists `createUnexpectedProblem` for NA/FE, not EU. Available actions also depend on the order and seller circumstances. Seller and Vendor Central capabilities differ; Messaging v1 is listed for sellers.

For another installation that elects to add SP-API operations, each operator needs properly authorized credentials; public hosted apps and private apps have different registration models. Public source code does not confer API authorization. This is reference guidance, not a first-build dependency. Apply the retention and processing requirements relevant to each actual data source, including copies used for AI processing. See [AMZ-1–AMZ-8](SOURCES.md#amazon).

## Amazon listings: close a wrong offer (0.10.0)

Optional, separate from the message route above. When a customer is right because the Amazon offer itself is wrong (e.g. the listing shows two bottles, the article is one), a person can close that offer from the case.

- **API:** Selling Partner API, Listings Items API v2021-08-01. `getListingsItem` (`includedData=summaries,offers,fulfillmentAvailability,issues`) shows the listing first; `patchListingsItem` with `op: "merge"` on `/attributes/purchasable_offer` and an `end_at` date in the past closes the offer ("Manage purchasable offer"). Price, stock and content stay unchanged; the offer is opened again in Seller Central by removing the end date. `searchListingsItems` (page size 1) is the connection test. See [AMZ-9–AMZ-12](SOURCES.md#amazon).
- **Role:** the SP-API app needs the role **Product Listing** (Amazon also accepts "Inventory and Order Tracking" for these operations; SupportX documents and tests Product Listing). Without it Amazon answers 403, which SupportX shows as a missing role.
- **Credentials:** the operator enters region, marketplaces, seller ID (merchant token), LWA client ID, LWA client secret and the refresh token from the seller's authorisation of the app (Settings → "Amazon-Angebote"). Client secret and refresh token are encrypted (purpose `amazon_sp_api`), seller ID and client ID only shown masked; changes only after clicking "Ändern", empty fields keep the stored value. SupportX never creates, rotates or requests credentials from Amazon. Calls use the LWA access token only (no AWS signature since 2023). Only the official hosts `sellingpartnerapi-{eu,na,fe}.amazon.com` and `api.amazon.com` are allowed outside test mode.
- **In the case:** card "Amazon-Angebot" on Amazon cases (and on any case that already has such an action). The SKU field suggests the article numbers of the linked weclapp order; whether they equal the Amazon seller SKU is the operator's setup and must be checked. "Angebot bei Amazon prüfen" reads title, ASIN, status, price and stock (changes nothing). "Angebot deaktivieren …" opens a confirmation dialog; only "Ja, deaktivieren" sends the change, together with the ASIN that was shown, so a listing that changed in between is refused.
- **Safety:** owner or agent, signed-in person only; the worker, automations and the AI cannot call it. One request per offer at a time (`listing_actions` pending row). Results: *von Amazon angenommen* (ACCEPTED, processing can take minutes), *abgelehnt* (with Amazon's issues), *unklar* (connection dropped after sending: check with "prüfen" before retrying). Every attempt is stored in `listing_actions`, shown in the case card and in the case's Verlauf, and audited (`amazon.offer_close_*`).
- **Tested:** against the local test double `packages/testing/fake-amazon.ts` only (documented request/response shapes, synthetic data). **No live Amazon account has been connected yet.** Open account tests: role on the real app, authorisation of the seller account, actual effect of `end_at` on a live FBM and an FBA offer, time until the offer is no longer buyable, reopening in Seller Central.

## Refunds at the marketplace from a case (0.16.1)

Optional and off by default. A person gives the customer money back at the marketplace directly from the case, after checking the order there and confirming the total. SupportX still does not write to weclapp: the credit note stays a manual step, and an accepted refund puts the case on the refund list ("Erstattungen") with the amount.

### Amazon (built)

- **API:** Amazon has no refund endpoint. A seller refunds through an order adjustment: Feeds API 2021-06-30 with feed type `POST_PAYMENT_ADJUSTMENT_DATA` (XML schema `OrderAdjustment`, one `AdjustedItem` per order item, components `Principal` and `Shipping`). Order and items come from Orders API v0 (`getOrder`, `getOrderItems`; `OrderItemId` is the `AmazonOrderItemCode`). Steps: `createFeedDocument` → upload to the pre-signed S3 URL → `createFeed`; the result comes from `getFeed` → `getFeedDocument` (processing report, optionally GZIP). Only `createFeed` can change anything at Amazon; a timeout or 5xx there is stored as *unklar*. See [AMZ-13–AMZ-15](SOURCES.md#amazon).
- **Role:** the SP-API app needs **Inventory and Order Tracking** (Amazon lists it for the order adjustment feed, together with the restricted "Direct-to-Consumer Shipping" role). After adding the role the seller must authorise the app again; the new refresh token is entered under "Ändern". "Verbindung testen" then also reads orders (`getOrders`, page size 1) and names the missing role on 403.
- **Switch:** Settings → "Amazon-Angebote" → "Erstattungen aus dem Fall erlauben" (owner only, `amazon_listing_connections.refunds_enabled`, audited).
- **In the case:** card "Erstattung bei Amazon" on Amazon cases and cases with an Amazon order number (from weclapp `orderNumberAtCustomer` or the mail). "Bestellung bei Amazon laden" reads status and items (changes nothing). Per item the person enters the amount for the item and for shipping ("Alles erstatten" fills what is left; "Prozent vom Artikelpreis" fills e.g. 20 % of each item price paid, capped at what is left, shipping excluded, reason set to "Kulanz / Teilerstattung"), picks a reason (subset of Amazon's `AdjustmentReason` values) and confirms the total in a dialog.
- **Checks on the server:** signed-in owner or agent only (never worker, automation or AI); order must be shipped (`Shipped`, `PartiallyShipped`, `InvoiceUnconfirmed`) and on a marketplace allowed for the access; per item never more than paid (item price minus promotion, shipping) minus earlier SupportX refunds that are open, accepted or unclear; the total must equal the one the person confirmed; one open refund per order (`marketplace_refunds` unique partial index plus an advisory lock). An unclear send blocks the order until a person checked Seller Central ("Ist erstattet" / "Ist nicht erstattet").
- **States:** *an Amazon übergeben* (feed created) → "Ergebnis abrufen" → *von Amazon erstattet* (report without errors) or *abgelehnt* (with Amazon's messages); *unklar*; *nicht gesendet*. All attempts are audited (`amazon.refund_*`) and shown in the case.
- **Assumptions to confirm on a live account:** that EU amounts are gross (item price incl. VAT, as the Orders API reports it) and Amazon does not expect a separate `Tax` component; behaviour on FBA orders (the card warns, Amazon often refunds FBA returns itself); time until the feed is processed.
- **Tested:** only against `packages/testing/fake-amazon.ts`. **No live Amazon account has been connected for refunds.**

### Credit note draft in weclapp (0.17.0)

After a refund, a person prepares the credit note in weclapp from the case (card "Gutschrift in weclapp"). This is the only write SupportX makes to weclapp.

- **API:** `GET /salesInvoice/id/{id}` (lines `salesInvoiceItems`, `shippingCostItems`), `POST /salesInvoice/id/{id}/createCreditNote` with `itemIds` (weclapp creates the credit note in status `NEW`, not booked), then `PUT /salesInvoice/id/{creditNoteId}` with the fresh full entity (weclapp replaces the whole record) where each line's `unitPrice` is scaled so its gross equals the confirmed amount (`manualUnitPrice: true`) and shipping cost items likewise (0 removes them). `createCreditNoteOpenItem` (booking) is never called. Endpoints from the weclapp v2 OpenAPI.
- **Switch:** Settings → weclapp → "Gutschriften aus dem Fall als Entwurf anlegen" (owner only, `erp_connections.credit_notes_enabled`, audited). The weclapp user of the API token needs the right to create and change sales invoices; a read-only token gets 403, shown as "nicht angelegt".
- **Proposal:** from Amazon refunds of the case (lines matched to invoice lines by article number = SKU, else title, else spread in proportion), otherwise from the amount on the refund list (spread over the lines, then shipping), otherwise the whole invoice. The person edits every amount before confirming.
- **Checks:** signed-in owner or agent only; invoice must belong to the case's weclapp order, not be a credit note or cancelled; each line at most its gross, shipping at most the invoice's shipping, total at most the invoice minus earlier SupportX credit notes for it; total must equal the confirmed one; one open request per invoice (`erp_credit_notes`, advisory lock).
- **States:** *Entwurf in weclapp*; *Beträge prüfen* (draft exists but the update failed or weclapp's total differs by rounding); *unklar* (no answer on the create call: check weclapp, then "Ist angelegt" / "Ist nicht angelegt"); *nicht angelegt*. The draft's number goes onto the refund list entry; ticking "done" stays with the person after booking in weclapp.
- **Assumptions to confirm on the live tenant:** that `createCreditNote` creates status `NEW` and copies shipping cost items, that `creditedInvoiceItemId` links the new lines to the invoice lines, that a PUT echoing the read-only fields is accepted, and how unit prices behave with net price entry.
- **Tested:** only against `packages/testing/fake-weclapp.ts`. A plentymarkets implementation would provide the same two provider methods (`getInvoiceForCredit`, `createCreditNoteDraft`).

### eBay, Kaufland, Shop Apotheke (not built yet)

- **eBay:** Fulfillment API `POST /sell/fulfillment/v1/order/{order_id}/issue_refund` (full or partial, per order or line item, reason enum). Needs the additional OAuth scope `sell.finances`, so the seller must sign in again, and eBay requires digital signatures for this call for EU/UK sellers (signing key from the Key Management API, entered by the operator). See [EBAY-4](SOURCES.md#ebay).
- **Kaufland:** Seller API `PATCH /v2/order-units/{id_order_unit}/refund` with `amount` in cents and a `reason`. Needs the order-unit ID (Kaufland order, not in weclapp so far) and the list of allowed reasons. See [KFL-5](SOURCES.md#kaufland).
- **Shop Apotheke (Mirakl):** OR28 `PUT /api/orders/refund` per order line (`order_line_id`, `amount`, `quantity`, `reason_code`, `shipping_amount`). Needs the order lines (OR11) and the operator's refund reason codes, and Shop Apotheke must have granted the refund roles to the shop key. See [MIR-4](SOURCES.md#shop-apotheke-and-mirakl).

## eBay

Use the current Commerce Message API for a new integration. Its release notes document the initial release on **2025-11-03**; `NEW_MESSAGE` support followed on **2025-11-17**. The API supports retrieving conversations and sending messages with seller/user OAuth authorization and the `commerce.message` scope.

Keep notification verification, duplicate handling and reconciliation in the adapter. Verify message attachments, conversation types, app access and marketplace coverage before enabling each capability. Use external order references to look up weclapp records; the first build does not request eBay order-import permissions. See [EBAY-1–EBAY-3](SOURCES.md#ebay).

## Kaufland

Use ticket resources for conversations and the ticket-message endpoint for replies. Resolve order references in weclapp; do not add a parallel Kaufland order import. Poll only within the provider's documented limits; the reviewed push-notification list does not establish a ticket/message event.

**`interim_notice=true` is customer-visible communication, not an internal note.** Store staff notes only in the local application unless a separately verified, explicitly internal provider capability exists. Confirm recipient and visibility semantics before sending to a buyer or operator. See [KFL-1–KFL-3](SOURCES.md#kaufland).

## Shop Apotheke / Mirakl

Shop Apotheke's partner information confirms Mirakl as its marketplace technology. The generic Mirakl seller API documents:

- M11: `GET /api/inbox/threads`.
- M10: retrieve a specific thread.
- M12: `POST /api/inbox/threads/{thread_id}/message`.

Use the actual operator instance, shop identifier and allowed message scopes. Resolve the thread's order reference in weclapp; no Mirakl order-import connector is required. M11 uses seek pagination; its optional included messages are limited to the last 100 messages per thread. This is not a complete historical export guarantee.

**M10/M11 publicly document synchronous use tied to an inbox display.** Do not interpret `updated_since` as permission for continuous background polling. Confirm an approved automation/synchronization route with the operator before scheduling unattended retrieval. SupportX treats its own inbox page as the inbox display: `POST /api/w/:ws/inbox/displayed` (sent once a minute while the inbox tab is visible) queues a read when the last one is older than 10 minutes. Nothing is read on a timer when nobody looks. Email notifications may trigger local review, but they do not establish API permission. See [SA-1 and MIR-1–MIR-3](SOURCES.md#shop-apotheke-and-mirakl).

## DocMorris

**First build:** the user confirmed that DocMorris messages arrive by email. Include incoming DocMorris messages in M1 through the shared Microsoft 365 connector. Order and shipment data comes solely from weclapp; no native DocMorris connector, Partner API order import or JWT setup is required.

**Research only:** the publicly documented Partner API uses GraphQL and describes order/suborder data and JWT-based access. This does not establish a messaging capability. No public messaging operation was verified; do not infer Mirakl compatibility or invent a GraphQL message mutation.

Inbound email is confirmed; outbound replies remain a separate activation gate. Inspect the original message's Reply-To and destination, then verify that a controlled reply is accepted into the correct customer-service thread before enabling sending. Do not infer reply capability from email receipt: a notification can be non-replyable. See [DM-1–DM-4](SOURCES.md#docmorris) for reference-only API research. Status: inbound via Microsoft mail implemented; outbound blocked until the route is verified per connection (UI: Einstellungen → Geprüfte Antwortwege).

## Shopify

**First build:** handle support email/contact-form enquiries delivered to the configured Microsoft mailbox, look up the order in weclapp and reply through the same email conversation. There is no Shopify Admin API order/fulfillment connector, extra order synchronization or related app authorization in scope.

Treat support email and Shopify Inbox as separate channels. If the operator actually uses Shopify Inbox, verify that message source separately before promising integration. No public Inbox read/send API was verified in this research. The GraphQL `Order` and `Fulfillment` sources are retained solely as reference-only capabilities for other installations, not required roadmap items. See [SHOP-1–SHOP-3](SOURCES.md#shopify).

## weclapp

weclapp is the **only `OrderProvider` in the first build**. Use REST API v2 with the `AuthenticationToken` header and an explicitly configured tenant base URL for read-only sales-order, shipment and invoice lookups. Prefer parcel fields such as `parcels[].trackingId` and `parcels[].trackingUrl` over deprecated `packageTracking*` fields.

A tracking number or created shipping label is not proof of a carrier scan or delivery. Represent the evidence source and timestamp; add carrier-event data separately when available. Resolve marketplace order references explicitly rather than matching only on customer names.

Token rotation can invalidate an existing credential: inspect the account's behavior and dependent integrations before replacing a token. Do not silently rotate credentials during setup. See [WC-1](SOURCES.md#weclapp).

## DHL parcel status (0.16.0)

SupportX reads the carrier's own status of the parcels in a case from the **DHL Shipment Tracking – Unified API** (developer.dhl.com), read only: `GET https://api-eu.dhl.com/track/shipments?trackingNumber=…&language=de` with the header `DHL-API-Key`. The optional `recipientPostalCode` comes from weclapp `shipment.recipientAddress.zipcode`; DHL only shows details such as places with the right postal code ("postal code challenge"), the status itself comes without it. The postal code is never part of AI facts.

- **Which numbers:** every parcel of every weclapp delivery (`parcels[].trackingId`, legacy `packageTrackingNumber`) whose tracking address is DHL/Deutsche Post or, without an address, whose number has a DHL format; plus parcel numbers the customer wrote (often a return label). At most 10 per case. Numbers with another carrier's address (DPD, GLS, UPS, Hermes …) are not sent to DHL.
- **When:** when a person opens the case, only for numbers without a fresh answer (delivered stays; others after 2 h), and on the click "Neu bei DHL abrufen" (at most every 5 min per number). The worker, automations and the AI never call DHL. Answers are stored per workspace in `parcel_tracking`.
- **Limits:** a new app key has 250 calls a day at DHL; a 429 stops the round and the rest is asked on the next opening. A higher limit is requested in the developer portal ("Request upgrade").
- **Drafts:** a DHL answer becomes a fact `carrier.<n>.<statusCode>` with source DHL. A DHL delivery scan backs "zugestellt" in the draft check (as a weclapp DELIVERED booking does); a transit scan backs "versendet/unterwegs". "Not found" and errors add nothing.
- **Credentials:** owner enters the API key (Settings → Anbindungen → "DHL-Sendungsstatus"), stored encrypted (purpose `dhl_tracking`), shown only as `••••abcd`, replaced only after clicking "Ändern". Only `api-eu.dhl.com`, `api.dhl.com` and `api-test.dhl.com` are allowed outside test mode.
- **Status:** tested only against the local test double `packages/testing/fake-dhl.ts`; no live DHL key has been connected yet. Open live checks: real response of a DHL Paket Germany parcel and a DHL return label, field `details.returnFlag`, whether weclapp fills `recipientAddress.zipcode`.

## Shared implementation rules

1. Capabilities start disabled and become available only after implementation and account validation.
2. Identify records by workspace, provider account and external ID. Deduplicate repeated delivery without merging unrelated sellers or channels.
3. Keep customer-visible replies separate from internal notes. Preserve the original destination and conversation identity.
4. Enrich exclusively from weclapp in the first build. Do not manufacture tracking states, refunds, replacements or delivery promises, or silently fall back to a second order import.
5. Pass AI proposals through application-owned policy checks. Credentials and unrestricted send/refund tools never belong in a model prompt.
6. Record the outgoing intent durably before sending. After an ambiguous timeout, reconcile rather than blindly resend.
7. Test permissions, pagination, duplicate notifications, reconnects, expired credentials, attachments and one controlled conversation round trip per connector before production.

Rules 1, 2, 3, 4, 5 and 6 are enforced for the Microsoft + weclapp slice and covered by tests (see README); rule 7 requires live accounts.
