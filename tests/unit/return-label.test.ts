import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkReturnAddress, countryAlpha2, parseReceiverIds, receiverCountries, splitStreet } from "../../packages/core/return-label.ts";
import { mapReturnLabel } from "../../packages/connectors/dhl/returns.ts";
import { mapReturnAddress } from "../../packages/connectors/weclapp/adapter.ts";
import { mapPlentyReturnAddress } from "../../packages/connectors/plentymarkets/adapter.ts";

describe("return label address", () => {
  it("splits street and house number", () => {
    assert.deepEqual(splitStreet("Beispielweg 12a"), { street: "Beispielweg", houseNumber: "12a" });
    assert.deepEqual(splitStreet("Am Markt 3 - 5"), { street: "Am Markt", houseNumber: "3-5" });
    assert.deepEqual(splitStreet("Straße des 17. Juni 101"), { street: "Straße des 17. Juni", houseNumber: "101" });
    assert.deepEqual(splitStreet("Hauptstr. 7 b"), { street: "Hauptstr.", houseNumber: "7b" });
    assert.deepEqual(splitStreet("12 Rue de la Paix"), { street: "Rue de la Paix", houseNumber: "12" });
    assert.deepEqual(splitStreet("Packstation"), { street: "Packstation" });
  });

  it("reads country spellings", () => {
    assert.equal(countryAlpha2("de"), "DE");
    assert.equal(countryAlpha2("DEU"), "DE");
    assert.equal(countryAlpha2("Österreich"), "AT");
    assert.equal(countryAlpha2(""), undefined);
  });

  it("checks the address for DHL and picks the receiver by country", () => {
    const ok = checkReturnAddress({ name1: " Erika  Muster ", street: "Weg", houseNumber: "1", postalCode: "10115", city: "Berlin", countryCode: "DE" }, { receiverIds: { DEU: "deu" } });
    assert.ok(ok.ok);
    assert.deepEqual(ok.shipper, { name1: "Erika Muster", addressStreet: "Weg", addressHouse: "1", postalCode: "10115", city: "Berlin", country: "DEU" });
    assert.equal(ok.receiverId, "deu");
    const bad = checkReturnAddress({ name1: "", street: "", postalCode: "1011", city: "", countryCode: "DE" }, { receiverIds: { DEU: "deu" } });
    assert.ok(!bad.ok);
    assert.deepEqual(bad.problems, ["Name fehlt.", "Straße fehlt.", "Ort fehlt.", "Die Postleitzahl muss in Deutschland fünf Ziffern haben."]);
    const at = checkReturnAddress({ name1: "A", street: "B 1", postalCode: "1010", city: "Wien", countryCode: "AT" }, { receiverIds: { DEU: "deu" } });
    assert.ok(!at.ok && /Österreich ist kein Retouren-Empfänger/.test(at.problems.join(" ")));
    const ch = checkReturnAddress({ name1: "A", street: "B 1", postalCode: "8000", city: "Zürich", countryCode: "CH" }, { receiverIds: { DEU: "deu" } });
    assert.ok(!ch.ok && /Zollangaben/.test(ch.problems.join(" ")));
    const long = checkReturnAddress({ name1: "x".repeat(51), street: "B", postalCode: "10115", city: "Berlin", countryCode: "DE" }, { receiverIds: { DEU: "deu" } });
    assert.ok(!long.ok && /zu lang/.test(long.problems[0]!));
  });

  it("parses receiver IDs and shows only country names", () => {
    assert.deepEqual(parseReceiverIds("deu", "AT=aut; nld:nld"), { ok: true, ids: { DEU: "deu", AUT: "aut", NLD: "nld" } });
    assert.equal(parseReceiverIds("", "").ok, false);
    assert.equal(parseReceiverIds("deu", "CH=che").ok, false);
    assert.equal(parseReceiverIds("de u").ok, false);
    assert.deepEqual(receiverCountries({ NLD: "x", DEU: "y" }), ["Deutschland", "Niederlande"]);
  });
});

describe("ERP addresses for a return label", () => {
  it("weclapp: delivery address first, company with the person on line 2", () => {
    const a = mapReturnAddress({
      invoiceAddress: { firstName: "Rechnung", lastName: "Person", street1: "Andere 1", zipcode: "20095", city: "Hamburg", countryCode: "DE" },
      deliveryAddress: { company: "Demo GmbH", firstName: "Erika", lastName: "Muster", street1: "Beispielweg 12a", street2: "Hinterhaus", zipcode: "10115", city: "Berlin", countryCode: "DE" },
    });
    assert.deepEqual(a, { name1: "Demo GmbH", name2: "Erika Muster", street: "Beispielweg", houseNumber: "12a", addressExtra: "Hinterhaus", postalCode: "10115", city: "Berlin", countryCode: "DE" });
    assert.equal(mapReturnAddress({ deliveryAddress: { firstName: "A", zipcode: "1" } }), null);
    assert.equal(mapReturnAddress({ deliveryAddress: { firstName: "A", street1: "Weg 1", city: "Ort" } })!.countryCode, "", "no guessed country");
  });

  it("plentymarkets: delivery relation (typeId 2), house number field, country id", () => {
    const a = mapPlentyReturnAddress({
      addressRelations: [{ typeId: 1, addressId: 11 }, { typeId: 2, addressId: 12 }],
      addresses: [
        { id: 11, name2: "Rechnung", name3: "Person", address1: "Andere", address2: "1", postalCode: "20095", town: "Hamburg", countryId: 1 },
        { id: 12, name1: "", name2: "Erika", name3: "Muster", name4: "Nachbar", address1: "Beispielweg", address2: "12a", postalCode: "1010", town: "Wien", countryId: 2 },
      ],
    });
    assert.deepEqual(a, { name1: "Erika Muster", street: "Beispielweg", houseNumber: "12a", addressExtra: "c/o Nachbar", postalCode: "1010", city: "Wien", countryCode: "AT" });
  });
});

describe("DHL return label answer", () => {
  const pdf = Buffer.from("%PDF-1.4 synthetic").toString("base64");
  it("maps the SDK fixture shape", () => {
    const r = mapReturnLabel({ sstatus: { title: "Created", status: 201 }, shipmentNo: "999990000001", label: { b64: pdf }, routingCode: "40321111111+9900099000001" });
    assert.equal(r.shipmentNo, "999990000001");
    assert.equal(r.routingCode, "40321111111+9900099000001");
    assert.equal(r.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  });
  it("refuses answers without number or PDF", () => {
    assert.throws(() => mapReturnLabel({ label: { b64: pdf } }), /keine Sendungsnummer/);
    assert.throws(() => mapReturnLabel({ shipmentNo: "1" }), /kein PDF/);
    assert.throws(() => mapReturnLabel({ shipmentNo: "1", label: { b64: Buffer.from("PNG").toString("base64") } }), /kein PDF/);
  });
});
