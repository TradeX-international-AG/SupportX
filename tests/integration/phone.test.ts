import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, afterEach, describe, it } from "node:test";
import { setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { createPhoneToken, getPhoneSettings, handlePhoneWebhook, phoneInvoiceRequest, phoneOrderStatus, savePhoneSettings, workspaceForToolToken } from "../../packages/services/phone.ts";
import { approveDraft, dispatchOutbox, queueReply } from "../../packages/services/replies.ts";
import { one } from "../../packages/storage/db.ts";
import { closeDb, createHarness, currentDraft, seedWorkspace, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const SECRET = "wsec_elevenlabs_test_1234567890";
const sign = (raw: string, at = new Date()) => {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v0=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`;
};

async function setup(sendMode: "drafts_only" | "enabled" = "drafts_only") {
  h = await createHarness({ sendMode });
  const s = await seedWorkspace(h);
  const { token } = await createPhoneToken(h.ctx, s.owner);
  await savePhoneSettings(h.ctx, s.owner, { webhookSecret: SECRET });
  const settings = await getPhoneSettings(h.ctx, s.owner);
  const connectionId = settings.urls.webhook!.split("/").at(-1)!;
  return { h, s, token, connectionId };
}

describe("phone hotline: tools", () => {
  it("accepts only its own token; the token is shown once and stored as a hash", async () => {
    const { h, s, token } = await setup();
    assert.equal(await workspaceForToolToken(h.ctx, `Bearer ${token}`), s.workspaceId);
    assert.equal(await workspaceForToolToken(h.ctx, `Bearer ${token}x`), null);
    assert.equal(await workspaceForToolToken(h.ctx, token), null, "Bearer prefix required");
    const row = await one<{ token_sha256: string; token_hint: string }>(h.ctx.db, "SELECT token_sha256, token_hint FROM voice_connections WHERE workspace_id = $1", [s.workspaceId]);
    assert.notEqual(row!.token_sha256, token);
    assert.equal(row!.token_hint, `••••${token.slice(-4)}`);
    const settings = await getPhoneSettings(h.ctx, s.owner);
    assert.equal(JSON.stringify(settings).includes(token), false);
    await assert.rejects(getPhoneSettings(h.ctx, s.agent), (e: ServiceError) => e.code === "FORBIDDEN");
    const rotated = await createPhoneToken(h.ctx, s.owner);
    assert.equal(await workspaceForToolToken(h.ctx, `Bearer ${token}`), null, "old token stops working");
    assert.equal(await workspaceForToolToken(h.ctx, `Bearer ${rotated.token}`), s.workspaceId);
  });

  it("answers order status only after order number and postal code or name match; unknown order and wrong answer read the same", async () => {
    const { h, s } = await setup();
    const ws = s.workspaceId;
    const unknown = await phoneOrderStatus(h.ctx, ws, { callId: "conv_call_0001", orderNumber: "AU-99999", check: "10115" });
    const wrong = await phoneOrderStatus(h.ctx, ws, { callId: "conv_call_0001", orderNumber: "AU-10001", check: "99999" });
    assert.equal(unknown.ok, false);
    assert.equal(wrong.say, unknown.say, "no hint which order numbers exist");
    assert.equal(wrong.facts, undefined);
    const third = await phoneOrderStatus(h.ctx, ws, { callId: "conv_call_0001", orderNumber: "AU-10001", check: "Fremd" });
    assert.equal(third.handover, true, "three misses: hand over to a person");
    const blocked = await phoneOrderStatus(h.ctx, ws, { callId: "conv_call_0001", orderNumber: "AU-10001", check: "10115" });
    assert.equal(blocked.ok, false, "even the right answer is refused after three misses in this call");

    const ok = await phoneOrderStatus(h.ctx, ws, { callId: "conv_call_0002", callerId: "+49301234567", orderNumber: "au 10001", check: "Müller" });
    assert.equal(ok.ok, true, ok.say);
    assert.ok(ok.facts!.some((f) => /Lieferung LS-5001: im ERP als versendet gebucht/.test(f)), ok.facts!.join("\n"));
    assert.ok(ok.facts!.every((f) => !/10115|Müller|kundin-demo/.test(f)), "no addresses in what the agent hears");
    const again = await phoneOrderStatus(h.ctx, ws, { callId: "conv_call_0002" });
    assert.equal(again.ok, true, "same call, same order: no second check");
    const call = await one<{ caller_hint: string; verified_order_number: string }>(h.ctx.db, "SELECT caller_hint, verified_order_number FROM phone_calls WHERE call_ref = 'conv_call_0002'");
    assert.deepEqual(call, { caller_hint: "…567", verified_order_number: "AU-10001" });
    assert.ok(h.weclapp.requests.every((r) => r.startsWith("GET ")), "weclapp is only read");
  });

  it("sends the invoice only to the address weclapp keeps, through a case that a person (or the invoice rule) releases", async () => {
    const { h, s } = await setup("enabled");
    const ws = s.workspaceId;
    const answer = await phoneInvoiceRequest(h.ctx, ws, { callId: "conv_call_0003", orderNumber: "AU-10001", check: "10115" });
    assert.equal(answer.ok, true, answer.say);
    assert.match(answer.say, /k•••o@example\.invalid/);
    assert.doesNotMatch(answer.say, /kundin-demo/);
    const conv = (await one<{ id: string; source_platform: string; customer_address: string; order_match_status: string; status: string }>(
      h.ctx.db, "SELECT c.* FROM conversations c JOIN phone_calls p ON p.conversation_id = c.id WHERE p.call_ref = 'conv_call_0003'",
    ))!;
    assert.equal(conv.source_platform, "phone");
    assert.equal(conv.customer_address, "kundin-demo@example.invalid");
    assert.equal(conv.order_match_status, "unique");
    const draft = (await currentDraft(h, s, conv.id))!;
    assert.equal((await one<{ decision: string }>(h.ctx.db, "SELECT decision FROM drafts WHERE id = $1", [draft.id]))!.decision, "invoice");
    assert.equal(h.graph.forwards.length, 0, "nothing sent without a verified route and a click");
    const repeat = await phoneInvoiceRequest(h.ctx, ws, { callId: "conv_call_0003" });
    assert.match(repeat.say, /bereits angefordert/);

    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "phone", evidenceNote: "Testmail an eigene Adresse angekommen" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    const approval = await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    const outboxId = await queueReply(h.ctx, s.agent, approval);
    assert.equal(await dispatchOutbox(h.ctx, ws, outboxId), "provider_accepted");
    const sent = h.graph.forwards.at(-1)!;
    assert.equal(sent.kind, "sendMail");
    assert.deepEqual(sent.to, ["kundin-demo@example.invalid"]);
    assert.equal(sent.subject, "Ihre Bestellung AU-10001");
    assert.deepEqual(sent.attachments.map((a) => a.name), ["Rechnung RE-9001.pdf"]);
    assert.ok(sent.headers.some((x) => x.value === outboxId), "marker header for reconciliation");
  });

  it("refuses the invoice without a confirmed order", async () => {
    const { h, s } = await setup();
    const answer = await phoneInvoiceRequest(h.ctx, s.workspaceId, { callId: "conv_call_0004", orderNumber: "AU-10001" });
    assert.equal(answer.ok, false);
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM conversations WHERE source_platform = 'phone'"), null);
  });
});

describe("phone hotline: post-call webhook", () => {
  const event = (ref: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: "post_call_transcription",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: "agent_x", conversation_id: ref, status: "done",
      transcript: [{ role: "agent", message: "Guten Tag, wie kann ich helfen?" }, { role: "user", message: "Wo bleibt mein Paket?" }],
      metadata: { call_duration_secs: 75 },
      analysis: { transcript_summary: "Kundin fragt nach dem Paketstatus.", call_successful: "success" },
      conversation_initiation_client_data: { dynamic_variables: { system__caller_id: "+491701234999" } },
      ...extra,
    },
  });

  it("files the call as a case: summary always, spoken text only when chosen; refuses wrong signatures", async () => {
    const { h, s, connectionId } = await setup();
    const raw = event("conv_call_0005");
    assert.equal((await handlePhoneWebhook(h.ctx, connectionId, raw, sign(raw).replace(/.$/, "0"))).status, 401);
    assert.equal((await handlePhoneWebhook(h.ctx, connectionId, raw, sign(raw, new Date(Date.now() - 3_600_000)))).status, 401);
    assert.equal((await handlePhoneWebhook(h.ctx, connectionId, raw, sign(raw))).status, 200);
    const msg = (await one<{ body_text: string; status: string; subject: string }>(
      h.ctx.db, "SELECT m.body_text, c.status, c.subject FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.external_message_id = 'phone:conv_call_0005'",
    ))!;
    assert.match(msg.body_text, /Kundin fragt nach dem Paketstatus/);
    assert.doesNotMatch(msg.body_text, /Wo bleibt mein Paket/, "no transcript by default");
    assert.equal(msg.status, "open", "no confirmed order: a person looks at it");
    assert.equal(msg.subject, "Anruf …999");

    await savePhoneSettings(h.ctx, s.owner, { transcriptMode: "transcript" });
    const raw2 = event("conv_call_0006");
    await handlePhoneWebhook(h.ctx, connectionId, raw2, sign(raw2));
    const body2 = (await one<{ body_text: string }>(h.ctx.db, "SELECT body_text FROM messages WHERE external_message_id = 'phone:conv_call_0006'"))!.body_text;
    assert.match(body2, /Anrufer: Wo bleibt mein Paket\?/);

    const audio = JSON.stringify({ type: "post_call_audio", data: { conversation_id: "conv_call_0007", full_audio: "AAAA" } });
    assert.equal((await handlePhoneWebhook(h.ctx, connectionId, audio, sign(audio))).status, 200);
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM phone_calls WHERE call_ref = 'conv_call_0007'"), null, "audio is never stored");
  });

  it("completes the case of a call that already asked for the invoice, and files a fully answered status call as done", async () => {
    const { h, s, connectionId } = await setup();
    await phoneInvoiceRequest(h.ctx, s.workspaceId, { callId: "conv_call_0008", orderNumber: "AU-10001", check: "10115" });
    const raw = event("conv_call_0008");
    await handlePhoneWebhook(h.ctx, connectionId, raw, sign(raw));
    const rows = await h.ctx.db.query("SELECT 1 FROM conversations WHERE source_platform = 'phone'");
    assert.equal(rows.rowCount, 1, "one case per call");
    const invoiceCase = (await one<{ status: string; body_text: string }>(h.ctx.db, "SELECT c.status, m.body_text FROM conversations c JOIN messages m ON m.id = c.latest_inbound_message_id WHERE c.source_platform = 'phone'"))!;
    assert.equal(invoiceCase.status, "open", "the invoice draft waits for a person");
    assert.match(invoiceCase.body_text, /Kundin fragt nach dem Paketstatus/);
    assert.match(invoiceCase.body_text, /Rechnung per E-Mail erhalten/);

    await phoneOrderStatus(h.ctx, s.workspaceId, { callId: "conv_call_0009", orderNumber: "AU-10001", check: "10115" });
    const raw2 = event("conv_call_0009");
    await handlePhoneWebhook(h.ctx, connectionId, raw2, sign(raw2));
    const status = (await one<{ status: string }>(h.ctx.db, "SELECT c.status FROM conversations c JOIN phone_calls p ON p.conversation_id = c.id WHERE p.call_ref = 'conv_call_0009'"))!;
    assert.equal(status.status, "closed");
  });

  it("keeps workspaces apart: another workspace's webhook id or token does not reach these calls", async () => {
    const { h, s, connectionId } = await setup();
    const other = await seedWorkspace(h, "Andere Firma");
    const { token } = await createPhoneToken(h.ctx, other.owner);
    assert.equal(await workspaceForToolToken(h.ctx, `Bearer ${token}`), other.workspaceId);
    const raw = event("conv_call_0010");
    await handlePhoneWebhook(h.ctx, connectionId, raw, sign(raw));
    const call = (await one<{ workspace_id: string }>(h.ctx.db, "SELECT workspace_id FROM phone_calls WHERE call_ref = 'conv_call_0010'"))!;
    assert.equal(call.workspace_id, s.workspaceId);
    const otherView = await getPhoneSettings(h.ctx, other.owner);
    assert.equal(otherView.calls.length, 0);
  });
});
