import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMessage, DnsParseError, emptyMessage, encodeMessage, QTYPE, readName, type Message, type WireData } from "../engine/dns/wire.ts";

const rr = (name: string, data: WireData, ttl = 300) => ({ name, cls: 1, ttl, data });
const roundtrip = (m: Message, compress = true) => decodeMessage(encodeMessage(m, { compress }));

function sample(): Message {
  const m = emptyMessage(0xbeef);
  m.qr = true;
  m.aa = true;
  m.rd = true;
  m.questions.push({ name: "example.com", rawName: "example.com", type: QTYPE.ANY, cls: 1 });
  m.answers.push(
    rr("example.com", { type: "A", address: "192.0.2.1" }),
    rr("example.com", { type: "AAAA", address: "2001:db8:0:0:0:0:0:1" }),
    rr("www.example.com", { type: "CNAME", target: "example.com" }),
    rr("example.com", { type: "MX", preference: 10, exchange: "mail.example.com" }),
    rr("example.com", { type: "TXT", text: "v=spf1 -all" }),
    rr("_sip._tcp.example.com", { type: "SRV", priority: 1, weight: 2, port: 5060, target: "sip.example.com" }),
    rr("example.com", { type: "CAA", flags: 0, tag: "issue", value: "letsencrypt.org" }),
    rr("example.com", { type: "NS", target: "ns1.example.com" }),
    rr("5.2.0.192.in-addr.arpa", { type: "PTR", target: "host.example.com" }),
    rr("example.com", { type: "SOA", mname: "ns1.example.com", rname: "hostmaster.example.com", serial: 2026111201, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300 }),
    rr("example.com", { type: "HINFO", cpu: "RFC8482", os: "" }),
  );
  return m;
}

test("Roundtrip aller Eintragstypen (mit und ohne Namenskompression)", () => {
  for (const compress of [true, false]) {
    const m = sample();
    const back = roundtrip(m, compress);
    assert.equal(back.id, 0xbeef);
    assert.equal(back.qr && back.aa && back.rd, true);
    assert.equal(back.questions[0]!.name, "example.com");
    assert.equal(back.answers.length, m.answers.length);
    for (let i = 0; i < m.answers.length; i++) {
      const want = m.answers[i]!;
      const got = back.answers[i]!;
      assert.equal(got.name, want.name);
      assert.equal(got.ttl, want.ttl);
      if (want.data.type === "AAAA") assert.equal(got.data.type, "AAAA"); // Schreibweise darf kürzer sein
      else assert.deepEqual(got.data, want.data, `Typ ${want.data.type} (compress=${compress})`);
    }
  }
});

test("Kompression macht die Nachricht kleiner und bleibt lesbar", () => {
  const m = sample();
  assert.ok(encodeMessage(m, { compress: true }).length < encodeMessage(m, { compress: false }).length);
});

test("TXT über 255 Bytes wird in Stücke geteilt und wieder zusammengesetzt", () => {
  const text = "x".repeat(600) + "ä";
  const m = emptyMessage(1);
  m.answers.push(rr("t.example.com", { type: "TXT", text }));
  const buf = encodeMessage(m);
  const back = decodeMessage(buf);
  assert.deepEqual(back.answers[0]!.data, { type: "TXT", text });
  // Rohdaten prüfen: erste Länge ist 255
  const idx = buf.indexOf(Buffer.from([255]));
  assert.ok(idx > 0);
});

test("EDNS0: UDP-Größe und Flags werden gelesen und geschrieben", () => {
  const m = emptyMessage(2);
  m.questions.push({ name: "a.example.com", rawName: "A.Example.com", type: QTYPE.A, cls: 1 });
  m.edns = { udpSize: 1232, extRcode: 1, version: 0, flags: 0x8000 };
  const back = roundtrip(m);
  assert.equal(back.edns!.udpSize, 1232);
  assert.equal(back.edns!.extRcode, 1);
  assert.equal(back.edns!.flags, 0x8000);
  assert.equal(back.additional.length, 0, "OPT steckt in edns, nicht in additional");
  // Schreibweise der Frage bleibt erhalten (0x20), Suchname ist klein
  assert.equal(back.questions[0]!.rawName, "A.Example.com");
  assert.equal(back.questions[0]!.name, "a.example.com");
});

test("Kompressionszeiger werden aufgelöst", () => {
  // Header + Frage www.example.com A IN + Antwort mit Zeiger auf die Frage (0xC00C)
  const q = Buffer.concat([Buffer.from([3]), Buffer.from("www"), Buffer.from([7]), Buffer.from("example"), Buffer.from([3]), Buffer.from("com"), Buffer.from([0])]);
  const head = Buffer.from([0, 7, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  const tail = Buffer.from([0, 1, 0, 1]);
  const ans = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 1, 0x2c, 0, 4, 192, 0, 2, 9]);
  const m = decodeMessage(Buffer.concat([head, q, tail, ans]));
  assert.equal(m.answers[0]!.name, "www.example.com");
  assert.deepEqual(m.answers[0]!.data, { type: "A", address: "192.0.2.9" });
  assert.equal(m.answers[0]!.ttl, 300);
});

test("Fehlerfälle: Schleifen, Vorwärtszeiger, Abbrüche, falsche Längen", () => {
  const head = (qd: number, an = 0) => Buffer.from([0, 1, 0, 0, 0, qd, 0, an, 0, 0, 0, 0]);
  // Zeiger auf sich selbst
  assert.throws(() => decodeMessage(Buffer.concat([head(1), Buffer.from([0xc0, 12, 0, 1, 0, 1])])), DnsParseError);
  // Vorwärtszeiger
  assert.throws(() => decodeMessage(Buffer.concat([head(1), Buffer.from([0xc0, 40, 0, 1, 0, 1])])), DnsParseError);
  // Label ragt über das Ende
  assert.throws(() => readName(Buffer.from([5, 97, 98]), 0), DnsParseError);
  // reservierter Label-Typ
  assert.throws(() => readName(Buffer.from([0x40, 0]), 0), DnsParseError);
  // zu kurzer Kopf, abgeschnittene Frage
  assert.throws(() => decodeMessage(Buffer.alloc(5)), DnsParseError);
  assert.throws(() => decodeMessage(Buffer.concat([head(1), Buffer.from([3, 97, 98, 99])])), DnsParseError);
  // A mit 3 Bytes
  const bad = Buffer.concat([head(0, 1), Buffer.from([0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 3, 1, 2, 3])]);
  assert.throws(() => decodeMessage(bad), DnsParseError);
  // unplausible Anzahl
  assert.throws(() => decodeMessage(Buffer.from([0, 1, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0])), DnsParseError);
  // zu langer Name (Zeigerkette hilft nicht)
  const long = Buffer.concat([...Array(5)].map(() => Buffer.concat([Buffer.from([63]), Buffer.alloc(63, 97)])));
  assert.throws(() => readName(Buffer.concat([long, Buffer.from([0])]), 0), DnsParseError);
  // Zufallsdaten dürfen höchstens DnsParseError werfen
  for (let i = 0; i < 300; i++) {
    const b = Buffer.alloc(12 + (i % 40));
    for (let j = 0; j < b.length; j++) b[j] = (i * 31 + j * 17 + (j * i) % 7) & 0xff;
    try {
      decodeMessage(b);
    } catch (e) {
      assert.ok(e instanceof DnsParseError);
    }
  }
});

test("Schreiben: ALIAS und ungültige Adressen werden abgelehnt", () => {
  const m = emptyMessage(3);
  m.answers.push(rr("a.example.com", { type: "ALIAS", target: "x.example.com" }));
  assert.throws(() => encodeMessage(m));
  const m2 = emptyMessage(3);
  m2.answers.push(rr("a.example.com", { type: "A", address: "999.1.1.1" }));
  assert.throws(() => encodeMessage(m2));
});
