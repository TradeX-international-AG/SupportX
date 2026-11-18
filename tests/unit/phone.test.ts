import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { mapCallerCheck } from "../../packages/connectors/weclapp/adapter.ts";
import { callCaseText, callerHint, callerMatches, isMarketplaceRelay, maskEmail, normalizeOrderNumber, transcriptTurns, verifyElevenLabsSignature } from "../../packages/core/phone.ts";
import { orderNumberVariants } from "../../packages/services/phone.ts";

const data = { postalCodes: ["10115", "1010"], lastNames: ["Müller-Beispiel", "Özdemir"] };

describe("phone hotline: caller check", () => {
  it("accepts the exact postal code or a last name, spelled as people say it", () => {
    assert.equal(callerMatches("10115", data), true);
    assert.equal(callerMatches(" 10 115 ", data), true);
    assert.equal(callerMatches("1010", data), true, "Austrian four-digit code");
    assert.equal(callerMatches("Müller-Beispiel", data), true);
    assert.equal(callerMatches("mueller beispiel", data), true);
    assert.equal(callerMatches("Muller", data), true, "one part of a double name, umlaut dropped");
    assert.equal(callerMatches("Oezdemir", data), true);
  });

  it("rejects near misses, other codes and empty or overlong answers", () => {
    assert.equal(callerMatches("10117", data), false);
    assert.equal(callerMatches("1011", data), false);
    assert.equal(callerMatches("Müll", data), false);
    assert.equal(callerMatches("Mueller-Beispielx", data), false);
    assert.equal(callerMatches("", data), false);
    assert.equal(callerMatches("x".repeat(101), data), false);
    assert.equal(callerMatches("Berlin", data), false, "the city is not asked");
  });

  it("reads postal codes, last names and the invoice address from a weclapp salesOrder", () => {
    const check = mapCallerCheck(
      {
        invoiceAddress: { lastName: "Muster", company: "Muster GmbH", zipcode: "80331" },
        deliveryAddress: { lastName: "Muster", zipcode: "80333" },
        salesInvoiceEmailAddresses: { toAddresses: "rechnung@muster.example; zweite@muster.example" },
        recordEmailAddresses: { toAddresses: "auftrag@muster.example" },
      },
      [{ recipientAddress: { lastName: "Nachbar", zipcode: "80333" } }],
    );
    assert.deepEqual(check.postalCodes, ["80331", "80333"]);
    assert.deepEqual(check.lastNames, ["Muster", "Nachbar"], "company names are too easy to guess");
    assert.deepEqual(check.invoiceEmails, ["rechnung@muster.example", "zweite@muster.example"]);
    assert.deepEqual(mapCallerCheck({ recordEmailAddresses: { toAddresses: "auftrag@muster.example, kaputt" } }).invoiceEmails, ["auftrag@muster.example"]);
  });

  it("normalises spoken order numbers and tries the usual written forms", () => {
    assert.equal(normalizeOrderNumber("au minus 10001"), "AU10001");
    assert.deepEqual(orderNumberVariants("AU 10001"), ["AU 10001", "AU10001", "AU-10001"]);
    assert.ok(orderNumberVariants("302 1234567 7654321").includes("302-1234567-7654321"));
  });
});

describe("phone hotline: what is shown and kept", () => {
  it("masks addresses, recognises marketplace relays and keeps only the last digits of the caller", () => {
    assert.equal(maskEmail("erika.mueller@example.de"), "e•••r@example.de");
    assert.equal(maskEmail("ab@x.de"), "a•@x.de");
    assert.equal(isMarketplaceRelay("abc123@marketplace.amazon.de"), true);
    assert.equal(isMarketplaceRelay("erika@example.de"), false);
    assert.equal(callerHint("+49 30 1234567"), "…567");
    assert.equal(callerHint("anonymous"), null);
  });

  it("puts the spoken text into the case only when the workspace keeps transcripts", () => {
    const turns = transcriptTurns([{ role: "agent", message: "Hallo", time_in_call_secs: 0 }, { role: "user", message: "Wo ist mein Paket?" }, { role: "user", message: "" }, null]);
    assert.equal(turns.length, 2);
    const summary = callCaseText({ summary: "Fragt nach Paket.", turns, mode: "summary", durationSec: 95, notes: ["Bestellung X bestätigt."] });
    assert.match(summary, /Zusammenfassung: Fragt nach Paket\./);
    assert.doesNotMatch(summary, /Wo ist mein Paket/);
    assert.match(callCaseText({ summary: "x", turns, mode: "transcript", notes: [] }), /Anrufer: Wo ist mein Paket\?/);
  });
});

describe("phone hotline: ElevenLabs webhook signature", () => {
  const secret = "wsec_testgeheimnis_1234567890";
  const body = JSON.stringify({ type: "post_call_transcription", data: {} });
  const now = new Date("2026-11-18T12:00:00Z");
  const t = Math.floor(now.getTime() / 1000);
  const sign = (ts: number, raw: string) => `t=${ts},v0=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;

  it("accepts a correct, fresh signature", () => {
    assert.deepEqual(verifyElevenLabsSignature(sign(t, body), body, secret, now), { ok: true, timestamp: t });
  });

  it("refuses a changed body, a wrong secret, an old timestamp and garbage", () => {
    assert.equal(verifyElevenLabsSignature(sign(t, body), body + " ", secret, now).ok, false);
    assert.equal(verifyElevenLabsSignature(sign(t, body), body, "anderes-geheimnis-123456", now).ok, false);
    assert.equal(verifyElevenLabsSignature(sign(t - 31 * 60, body), body, secret, now).ok, false);
    assert.equal(verifyElevenLabsSignature("v0=abc", body, secret, now).ok, false);
    assert.equal(verifyElevenLabsSignature(undefined, body, secret, now).ok, false);
  });
});
