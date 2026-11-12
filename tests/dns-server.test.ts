import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promises as dnsPromises } from "node:dns";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// Das Daten-Verzeichnis wird beim Import festgelegt, deshalb vorher setzen.
const DATA = mkdtempSync(path.join(tmpdir(), "dns-test-"));
process.env.DATA_DIR = DATA;
const { startDnsServer } = await import("../engine/dns/server.ts");
const { createAliasResolver } = await import("../engine/dns/alias.ts");
const { decodeMessage, emptyMessage, encodeMessage, QTYPE, RCODE } = await import("../engine/dns/wire.ts");
const { defaultDnsState, newZone } = await import("../lib/core/dns-model.ts");
import type { DnsServerHandle } from "../engine/dns/server.ts";
import type { AliasResolver } from "../engine/dns/alias.ts";
import type { DnsRecord, DnsState } from "../lib/core/dns-model.ts";
import type { Message } from "../engine/dns/wire.ts";

/* ------------------------------------------------------------------ Hilfen */
let counter = 0;
const rec = (name: string, type: DnsRecord["type"], value: string, extra: Partial<DnsRecord> = {}): DnsRecord =>
  ({ id: `r${counter++}`, name, type, ttl: 300, value, visibility: "public", ...extra }) as DnsRecord;

const BIG = "b".repeat(1500);
const LONG = "x".repeat(600);

function config(opts: { internalNets?: string[]; rate?: number; extra?: DnsRecord[] } = {}): DnsState {
  const dns = defaultDnsState();
  dns.settings.nameservers = [{ host: "ns1.example.com", ipv4: "192.0.2.53" }, { host: "ns2.example.com" }];
  dns.settings.internalNets = opts.internalNets ?? ["127.0.0.0/8"];
  dns.settings.rateLimitPerSecond = opts.rate ?? 0;
  const z = newZone("example.com", "authoritative");
  z.records = [
    rec("@", "A", "192.0.2.1"),
    rec("@", "AAAA", "2001:db8::1"),
    rec("www", "CNAME", "example.com"),
    rec("chain1", "CNAME", "chain2.example.com"),
    rec("chain2", "CNAME", "www.example.com"),
    rec("@", "MX", "mail.example.com", { priority: 10 }),
    rec("mail", "A", "192.0.2.25"),
    rec("long", "TXT", LONG),
    rec("big", "TXT", BIG),
    rec("_sip._tcp", "SRV", "sip.example.com", { priority: 1, weight: 2, port: 5060 }),
    rec("@", "CAA", "letsencrypt.org", { flags: 0, tag: "issue" }),
    rec("sub", "NS", "ns1.sub.example.com"),
    rec("ns1.sub", "A", "192.0.2.99"),
    rec("*", "A", "192.0.2.77"),
    rec("b", "A", "192.0.2.88"),
    rec("leaf.mid", "A", "192.0.2.66"),
    rec("secret", "A", "10.9.9.9", { visibility: "internal" }),
    ...(opts.extra ?? []),
  ];
  const alias = newZone("alias.test", "authoritative");
  alias.records = [rec("@", "ALIAS", "edge.cdn.test", { ttl: 120 }), rec("www", "CNAME", "alias.test")];
  dns.zones = [z, alias];
  return dns;
}

const inventory = () => ({
  version: 1,
  settings: { serverDomain: "server.example.com" },
  subnets: [],
  servers: [{ id: "srv1", name: "web01", dnsVisibility: "internal" }],
  ips: [
    { ip: "10.0.0.5", status: "assigned", serverId: "srv1" },
    { ip: "10.0.0.6", status: "assigned", serverId: "srv1" },
  ],
});

const write = (file: string, v: unknown) => writeFileSync(path.join(DATA, file), typeof v === "string" ? v : JSON.stringify(v));

let server: DnsServerHandle;
async function setup(dns: DnsState = config()): Promise<void> {
  write("dns.json", dns);
  write("inventory.json", inventory());
  await server.reload();
}

type QOpts = { tcp?: boolean; edns?: number; rd?: boolean; cls?: number; opcode?: number; timeoutMs?: number };
function build(name: string, type: number, o: QOpts = {}): Buffer {
  const m = emptyMessage(Math.floor(Math.random() * 65535));
  m.rd = o.rd ?? true;
  m.opcode = o.opcode ?? 0;
  m.questions.push({ name: name.toLowerCase(), rawName: name, type, cls: o.cls ?? 1 });
  if (o.edns) m.edns = { udpSize: o.edns, extRcode: 0, version: 0, flags: 0 };
  return encodeMessage(m);
}

function udpRaw(port: number, buf: Buffer, timeoutMs = 2000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const t = setTimeout(() => {
      s.close();
      resolve(null);
    }, timeoutMs);
    s.on("message", (b) => {
      clearTimeout(t);
      s.close();
      resolve(b);
    });
    s.send(buf, port, "127.0.0.1");
  });
}

function tcpRaw(port: number, buf: Buffer, timeoutMs = 2000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let acc = Buffer.alloc(0);
    const done = (v: Buffer | null) => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(null), timeoutMs);
    s.on("connect", () => {
      const head = Buffer.alloc(2);
      head.writeUInt16BE(buf.length);
      s.write(Buffer.concat([head, buf]));
    });
    s.on("data", (d) => {
      acc = Buffer.concat([acc, d]);
      if (acc.length >= 2 && acc.length >= 2 + acc.readUInt16BE(0)) done(acc.subarray(2, 2 + acc.readUInt16BE(0)));
    });
    s.on("error", () => done(null));
    s.on("close", () => done(null));
  });
}

async function ask(name: string, type: number, o: QOpts = {}): Promise<Message> {
  const buf = build(name, type, o);
  const raw = o.tcp ? await tcpRaw(server.port, buf, o.timeoutMs) : await udpRaw(server.port, buf, o.timeoutMs);
  assert.ok(raw, `keine Antwort auf ${name}`);
  return decodeMessage(raw);
}

const data = (m: Message, section: "answers" | "authority" | "additional" = "answers") => m[section].map((r) => r.data);
const types = (m: Message, section: "answers" | "authority" | "additional" = "answers") => m[section].map((r) => r.data.type);
const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

let aliasMode: "ok" | "empty" | "fail" = "ok";
const aliasCalls: string[] = [];
const fakeResolver: AliasResolver = {
  size: () => 0,
  async resolve(host, family) {
    aliasCalls.push(`${host}/${family}`);
    if (aliasMode === "fail") throw new Error("Test: Resolver nicht erreichbar");
    if (aliasMode === "empty") return { addresses: [], ttl: 60 };
    return { addresses: family === 4 ? ["198.51.100.7", "198.51.100.8"] : ["2001:db8:ffff::7"], ttl: 90 };
  },
};

before(async () => {
  write("dns.json", config());
  write("inventory.json", inventory());
  server = await startDnsServer({ port: 0, bind: "127.0.0.1", resolver: fakeResolver, pollMs: 100, statsIntervalMs: 60_000 });
});
after(async () => {
  await server.stop();
  rmSync(DATA, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ Tests */
test("A und AAAA: autoritativ (AA), nie rekursiv (RA), RD wird kopiert, EDNS wird beantwortet", async () => {
  await setup();
  const a = await ask("example.com", QTYPE.A, { edns: 4096 });
  assert.equal(a.rcode, RCODE.NOERROR);
  assert.equal(a.aa, true);
  assert.equal(a.ra, false);
  assert.equal(a.rd, true);
  assert.equal(a.edns?.udpSize, 1232);
  assert.deepEqual(data(a), [{ type: "A", address: "192.0.2.1" }]);
  const nord = await ask("example.com", QTYPE.A, { rd: false });
  assert.equal(nord.rd, false);
  assert.equal(nord.edns, undefined, "ohne EDNS in der Anfrage auch keins in der Antwort");
  const aaaa = await ask("example.com", QTYPE.AAAA);
  assert.deepEqual(data(aaaa), [{ type: "AAAA", address: "2001:db8:0:0:0:0:0:1" }]);
});

test("Groß-/Kleinschreibung der Frage bleibt erhalten (0x20), die Suche ignoriert sie", async () => {
  await setup();
  const r = await ask("ExAmPlE.CoM", QTYPE.A);
  assert.equal(r.questions[0]!.rawName, "ExAmPlE.CoM");
  assert.equal(r.answers.length, 1);
});

test("CNAME-Kette innerhalb der Zone wird verfolgt", async () => {
  await setup();
  const r = await ask("chain1.example.com", QTYPE.A);
  assert.deepEqual(types(r), ["CNAME", "CNAME", "CNAME", "A"]);
  assert.deepEqual(r.answers.map((x) => x.name), ["chain1.example.com", "chain2.example.com", "www.example.com", "example.com"]);
  const direct = await ask("chain1.example.com", QTYPE.CNAME);
  assert.deepEqual(types(direct), ["CNAME"], "CNAME-Anfrage liefert nur den CNAME");
});

test("MX (mit Adresse im Zusatzteil), TXT über 255 Bytes, SRV, CAA, NS, SOA", async () => {
  await setup();
  const mx = await ask("example.com", QTYPE.MX);
  assert.deepEqual(data(mx), [{ type: "MX", preference: 10, exchange: "mail.example.com" }]);
  assert.deepEqual(data(mx, "additional"), [{ type: "A", address: "192.0.2.25" }]);

  const txt = await ask("long.example.com", QTYPE.TXT, { edns: 4096 });
  assert.deepEqual(data(txt), [{ type: "TXT", text: LONG }]);

  const srv = await ask("_sip._tcp.example.com", QTYPE.SRV);
  assert.deepEqual(data(srv), [{ type: "SRV", priority: 1, weight: 2, port: 5060, target: "sip.example.com" }]);

  const caa = await ask("example.com", QTYPE.CAA);
  assert.deepEqual(data(caa), [{ type: "CAA", flags: 0, tag: "issue", value: "letsencrypt.org" }]);

  const ns = await ask("example.com", QTYPE.NS);
  assert.deepEqual(data(ns).map((d) => (d as { target: string }).target).sort(), ["ns1.example.com", "ns2.example.com"]);
  assert.deepEqual(data(ns, "additional"), [{ type: "A", address: "192.0.2.53" }], "Glue für ns1 aus den Einstellungen");

  const soa = await ask("example.com", QTYPE.SOA);
  const d = soa.answers[0]!.data;
  assert.equal(d.type, "SOA");
  if (d.type === "SOA") {
    assert.equal(d.mname, "ns1.example.com");
    assert.equal(d.rname, "hostmaster.example.com");
    assert.ok(d.serial > 2020010100);
  }
});

test("NXDOMAIN und NODATA mit SOA, REFUSED für fremde Zonen", async () => {
  await setup();
  const nxd = await ask("x.b.example.com", QTYPE.A); // b existiert -> kein Wildcard für darunterliegende Namen
  assert.equal(nxd.rcode, RCODE.NXDOMAIN);
  assert.equal(nxd.aa, true);
  assert.deepEqual(types(nxd, "authority"), ["SOA"]);
  assert.equal(nxd.authority[0]!.ttl, 300, "Negativ-TTL = min(SOA-TTL, minimum)");

  const nodata = await ask("mail.example.com", QTYPE.AAAA);
  assert.equal(nodata.rcode, RCODE.NOERROR);
  assert.equal(nodata.answers.length, 0);
  assert.deepEqual(types(nodata, "authority"), ["SOA"]);

  const mid = await ask("mid.example.com", QTYPE.A); // leerer Zwischenknoten: kein Wildcard
  assert.equal(mid.rcode, RCODE.NOERROR);
  assert.equal(mid.answers.length, 0);

  const foreign = await ask("other.org", QTYPE.A);
  assert.equal(foreign.rcode, RCODE.REFUSED);
  assert.equal(foreign.aa, false);
  assert.equal(foreign.answers.length, 0);
});

test("Wildcard greift nur bei nicht vorhandenen Namen und trägt den angefragten Namen", async () => {
  await setup();
  const w = await ask("irgendwas.example.com", QTYPE.A);
  assert.deepEqual(w.answers.map((x) => [x.name, x.data]), [["irgendwas.example.com", { type: "A", address: "192.0.2.77" }]]);
  const deep = await ask("a.b.c.example.com", QTYPE.A);
  assert.equal(deep.answers[0]!.data.type, "A");
  const wnodata = await ask("irgendwas.example.com", QTYPE.TXT);
  assert.equal(wnodata.rcode, RCODE.NOERROR);
  assert.equal(wnodata.answers.length, 0);
  const exact = await ask("b.example.com", QTYPE.A);
  assert.deepEqual(data(exact), [{ type: "A", address: "192.0.2.88" }]);
});

test("Delegation: Verweis mit NS und Glue, ohne AA", async () => {
  await setup();
  const r = await ask("host.sub.example.com", QTYPE.A);
  assert.equal(r.rcode, RCODE.NOERROR);
  assert.equal(r.aa, false);
  assert.equal(r.answers.length, 0);
  assert.deepEqual(data(r, "authority"), [{ type: "NS", target: "ns1.sub.example.com" }]);
  assert.deepEqual(data(r, "additional"), [{ type: "A", address: "192.0.2.99" }]);
  const glueQuery = await ask("ns1.sub.example.com", QTYPE.A);
  assert.equal(glueQuery.aa, false, "auch der Glue-Name selbst liegt unter der Delegation");
});

test("ANY liefert nur HINFO (RFC 8482); Zonentransfer und fremde Klassen werden verweigert; Opcode NOTIMP", async () => {
  await setup();
  const any = await ask("example.com", QTYPE.ANY);
  assert.deepEqual(data(any), [{ type: "HINFO", cpu: "RFC8482", os: "" }]);
  for (const t of [QTYPE.AXFR, QTYPE.IXFR]) {
    assert.equal((await ask("example.com", t)).rcode, RCODE.REFUSED);
    assert.equal((await ask("example.com", t, { tcp: true })).rcode, RCODE.REFUSED);
  }
  assert.equal((await ask("version.bind", QTYPE.TXT, { cls: 3 })).rcode, RCODE.REFUSED);
  assert.equal((await ask("example.com", QTYPE.A, { opcode: 4 })).rcode, RCODE.NOTIMP);
});

test("Kaputte Pakete: FORMERR oder keine Antwort – Antworten (QR=1) werden ignoriert", async () => {
  await setup();
  // Anfrage mit abgeschnittener Frage
  const trunc = Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 3, 97, 98]);
  const r = await udpRaw(server.port, trunc);
  assert.ok(r);
  const m = decodeMessage(r!);
  assert.equal(m.id, 0x1234);
  assert.equal(m.rcode, RCODE.FORMERR);
  assert.equal(m.qr, true);
  // Antwortpaket (QR=1) nie beantworten
  const asReply = Buffer.from([0x12, 0x34, 0x81, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(await udpRaw(server.port, asReply, 300), null);
  // zu kurz
  assert.equal(await udpRaw(server.port, Buffer.from([1, 2, 3]), 300), null);
  // zwei Fragen
  const two = emptyMessage(9);
  two.questions.push({ name: "a.example.com", rawName: "a.example.com", type: 1, cls: 1 }, { name: "b.example.com", rawName: "b.example.com", type: 1, cls: 1 });
  assert.equal(decodeMessage((await udpRaw(server.port, encodeMessage(two)))!).rcode, RCODE.FORMERR);
  // Server lebt noch
  assert.equal((await ask("example.com", QTYPE.A)).answers.length, 1);
});

test("Interne und externe Sicht; Server-Namen aus dem Inventar", async () => {
  await setup(config({ internalNets: ["127.0.0.0/8"] }));
  const secret = await ask("secret.example.com", QTYPE.A);
  assert.deepEqual(data(secret), [{ type: "A", address: "10.9.9.9" }]);
  const web = await ask("web01.server.example.com", QTYPE.A);
  assert.deepEqual(data(web).map((d) => (d as { address: string }).address).sort(), ["10.0.0.5", "10.0.0.6"], "eine VM mit mehreren IPs");

  const before = server.stats().totals.internalViews;
  assert.ok(before >= 2);

  await setup(config({ internalNets: ["203.0.113.0/24"] }));
  // „secret“ gibt es für externe Clients nicht – das Wildcard antwortet an seiner Stelle, nicht die interne Adresse
  const ext = await ask("secret.example.com", QTYPE.A);
  assert.deepEqual(data(ext), [{ type: "A", address: "192.0.2.77" }]);
  const extWeb = await ask("web01.server.example.com", QTYPE.A);
  assert.deepEqual(data(extWeb), [{ type: "A", address: "192.0.2.77" }], "Wildcard statt der internen Adresse");
  assert.ok(!data(extWeb).some((d) => (d as { address?: string }).address?.startsWith("10.0.0.")));
  assert.equal(server.stats().totals.internalViews, before, "externe Anfragen zählen nicht als interne Sicht");
});

test("Ohne Wildcard ist ein interner Eintrag für externe Clients NXDOMAIN", async () => {
  const dns = config({ internalNets: ["203.0.113.0/24"] });
  dns.zones[0]!.records = dns.zones[0]!.records.filter((r) => r.name !== "*");
  await setup(dns);
  assert.equal((await ask("secret.example.com", QTYPE.A)).rcode, RCODE.NXDOMAIN);
  assert.equal((await ask("web01.server.example.com", QTYPE.A)).rcode, RCODE.NXDOMAIN);
});

test("Zu große UDP-Antwort: TC=1; per TCP kommt die vollständige Antwort", async () => {
  await setup();
  const udp = await ask("big.example.com", QTYPE.TXT);
  assert.equal(udp.tc, true);
  assert.equal(udp.answers.length, 0);
  const udpEdns = await ask("big.example.com", QTYPE.TXT, { edns: 4096 });
  assert.equal(udpEdns.tc, true, "mehr als 1232 Bytes gibt es nie per UDP");
  const tcp = await ask("big.example.com", QTYPE.TXT, { tcp: true });
  assert.equal(tcp.tc, false);
  assert.deepEqual(data(tcp), [{ type: "TXT", text: BIG }]);
  assert.ok(server.stats().totals.truncated >= 2);
});

test("TCP: mehrere Anfragen über eine Verbindung", async () => {
  await setup();
  const answers = await new Promise<Message[]>((resolve, reject) => {
    const s = net.connect(server.port, "127.0.0.1");
    const out: Message[] = [];
    let acc = Buffer.alloc(0);
    const t = setTimeout(() => reject(new Error("Zeitlimit")), 2000);
    s.on("connect", () => {
      for (const n of ["example.com", "www.example.com", "mail.example.com"]) {
        const b = build(n, QTYPE.A);
        const h = Buffer.alloc(2);
        h.writeUInt16BE(b.length);
        s.write(Buffer.concat([h, b]));
      }
    });
    s.on("data", (d) => {
      acc = Buffer.concat([acc, d]);
      while (acc.length >= 2 && acc.length >= 2 + acc.readUInt16BE(0)) {
        const len = acc.readUInt16BE(0);
        out.push(decodeMessage(acc.subarray(2, 2 + len)));
        acc = acc.subarray(2 + len);
      }
      if (out.length === 3) {
        clearTimeout(t);
        s.destroy();
        resolve(out);
      }
    });
  });
  assert.deepEqual(answers.map((m) => m.rcode), [0, 0, 0]);
  assert.ok(answers.every((m) => m.answers.length >= 1));
});

test("Neuladen: Änderung an dns.json wird erkannt; eine kaputte Datei lässt den alten Stand aktiv", async () => {
  await setup();
  assert.equal((await ask("neu.example.com", QTYPE.TXT)).answers.length, 0);
  write("dns.json", config({ extra: [rec("neu", "TXT", "hallo")] }));
  assert.ok(await until(async () => (await ask("neu.example.com", QTYPE.TXT)).answers.length === 1), "Neuladen per Beobachter");
  write("dns.json", "{kaputt");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await ask("neu.example.com", QTYPE.TXT)).answers.length, 1, "alter Stand bleibt");
  assert.equal((await ask("example.com", QTYPE.A)).answers.length, 1);
});

test("Ratenbegrenzung: externe Quelle wird gedrosselt und gezählt, interne nicht", async () => {
  await setup(config({ internalNets: ["203.0.113.0/24"], rate: 2 }));
  const before = server.stats().totals.rateLimited;
  const results = await Promise.all(Array.from({ length: 30 }, () => udpRaw(server.port, build("example.com", QTYPE.A), 700)));
  const got = results.filter(Boolean).length;
  assert.ok(got < 30 && got >= 1, `beantwortet: ${got}`);
  assert.ok(server.stats().totals.rateLimited > before);
  await setup(config({ internalNets: ["127.0.0.0/8"], rate: 2 }));
  const internal = await Promise.all(Array.from({ length: 30 }, () => udpRaw(server.port, build("example.com", QTYPE.A), 1500)));
  assert.equal(internal.filter(Boolean).length, 30);
});

test("ALIAS: Antwort aus dem Resolver, NODATA bei leerem Ergebnis, SERVFAIL bei Fehler, Name im eigenen Bestand", async () => {
  await setup();
  aliasCalls.length = 0;
  aliasMode = "ok";
  const a = await ask("alias.test", QTYPE.A);
  assert.deepEqual(a.answers.map((x) => [x.name, x.data, x.ttl]), [
    ["alias.test", { type: "A", address: "198.51.100.7" }, 90],
    ["alias.test", { type: "A", address: "198.51.100.8" }, 90],
  ]);
  const aaaa = await ask("alias.test", QTYPE.AAAA);
  assert.equal(aaaa.answers.length, 1);
  assert.deepEqual(aliasCalls, ["edge.cdn.test/4", "edge.cdn.test/6"]);
  const viaCname = await ask("www.alias.test", QTYPE.A);
  assert.deepEqual(types(viaCname), ["CNAME", "A", "A"]);
  const mx = await ask("alias.test", QTYPE.MX);
  assert.equal(mx.answers.length, 0);
  assert.equal(mx.rcode, RCODE.NOERROR);

  aliasMode = "empty";
  const empty = await ask("alias.test", QTYPE.A);
  assert.equal(empty.rcode, RCODE.NOERROR);
  assert.equal(empty.answers.length, 0);
  assert.deepEqual(types(empty, "authority"), ["SOA"]);

  aliasMode = "fail";
  assert.equal((await ask("alias.test", QTYPE.A)).rcode, RCODE.SERVFAIL);
  aliasMode = "ok";

  // Ziel in eigener Zone: ohne Resolver beantwortet
  aliasCalls.length = 0;
  await setup(config({ extra: [] }));
  const dns = config();
  dns.zones[1]!.records[0] = rec("@", "ALIAS", "www.example.com", { ttl: 120 });
  await setup(dns);
  const local = await ask("alias.test", QTYPE.A);
  assert.deepEqual(data(local), [{ type: "A", address: "192.0.2.1" }]);
  assert.deepEqual(aliasCalls, []);
});

test("node:dns Resolver gegen den Server", async () => {
  await setup();
  const r = new dnsPromises.Resolver({ timeout: 1500, tries: 1 });
  r.setServers([`127.0.0.1:${server.port}`]);
  assert.deepEqual(await r.resolve4("example.com"), ["192.0.2.1"]);
  assert.deepEqual(await r.resolve6("example.com"), ["2001:db8::1"]);
  assert.deepEqual(await r.resolveMx("example.com"), [{ exchange: "mail.example.com", priority: 10 }]);
  assert.deepEqual(await r.resolveTxt("long.example.com"), [[LONG.slice(0, 255), LONG.slice(255, 510), LONG.slice(510)]]);
  assert.deepEqual(await r.resolveCname("www.example.com"), ["example.com"]);
  assert.deepEqual(await r.resolveSrv("_sip._tcp.example.com"), [{ name: "sip.example.com", port: 5060, priority: 1, weight: 2 }]);
  assert.deepEqual((await r.resolveNs("example.com")).sort(), ["ns1.example.com", "ns2.example.com"]);
  // große Antwort: der Resolver wechselt bei TC selbständig auf TCP
  const big = await r.resolveTxt("big.example.com");
  assert.equal(big.flat().join(""), BIG);
});

test("Statistik und Herzschlag werden nach runtime/dns.json geschrieben", async () => {
  await setup();
  await ask("example.com", QTYPE.A);
  await server.writeStats();
  const s = JSON.parse(readFileSync(path.join(DATA, "runtime", "dns.json"), "utf8"));
  assert.equal(s.version, 1);
  assert.ok(Date.now() - Date.parse(s.updatedAt) < 5000);
  assert.ok(s.totals.queries > 0 && s.totals.udp > 0 && s.totals.tcp > 0);
  assert.ok(s.zones >= 2 && s.records > 10);
  assert.ok(s.byZone["example.com"] > 0 && s.byType.A > 0);
  assert.ok(s.perMinute.length >= 1 && s.perMinute.length <= 60);
});

test("Standardbindung (dual-stack mit Rückfall) und Healthcheck", async () => {
  const dual = await startDnsServer({ port: 0, resolver: fakeResolver, writeStats: false, pollMs: 60_000 });
  try {
    const raw = await udpRaw(dual.port, build("example.com", QTYPE.A));
    assert.ok(raw);
    assert.equal(decodeMessage(raw!).answers.length >= 0, true);
    const file = fileURLToPath(new URL("../engine/dns/healthcheck.ts", import.meta.url));
    const code = await new Promise<number>((resolve) => {
      execFile(process.execPath, [file], { env: { ...process.env, DNS_PORT: String(dual.port) } }, (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0));
    });
    assert.equal(code, 0);
    const bad = await new Promise<number>((resolve) => {
      execFile(process.execPath, [file], { env: { ...process.env, DNS_PORT: "9" } }, (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0));
    });
    assert.equal(bad, 1);
  } finally {
    await dual.stop();
  }
});

/* ------------------------------------------------------- ALIAS-Zwischenspeicher */
test("ALIAS-Resolver: Cache, Zeitlimit, Stale-while-error", async () => {
  let t = 1_000_000;
  let calls = 0;
  let mode: "ok" | "fail" | "slow" = "ok";
  const r = createAliasResolver({
    now: () => t,
    timeoutMs: 100,
    fetch: async () => {
      calls++;
      if (mode === "fail") throw new Error("down");
      if (mode === "slow") await new Promise((res) => setTimeout(res, 300));
      return { addresses: ["203.0.113.5"], ttl: 9999 };
    },
  });
  const first = await r.resolve("edge.example", 4);
  assert.deepEqual(first, { addresses: ["203.0.113.5"], ttl: 300 }, "TTL-Obergrenze 300 s");
  await r.resolve("edge.example", 4);
  assert.equal(calls, 1, "frischer Eintrag kommt aus dem Cache");
  t += 301_000;
  mode = "fail";
  const stale = await r.resolve("edge.example", 4);
  assert.deepEqual(stale, { addresses: ["203.0.113.5"], ttl: 30 }, "alter Stand bei Fehler");
  await assert.rejects(r.resolve("unbekannt.example", 4), /down/);
  mode = "slow";
  t += 400_000;
  const started = Date.now();
  const slow = await r.resolve("edge.example", 4);
  assert.ok(Date.now() - started < 250, "wartet höchstens das Zeitlimit");
  assert.equal(slow.ttl, 30);
  await new Promise((res) => setTimeout(res, 350)); // die Abfrage läuft weiter und füllt den Cache
  mode = "fail";
  const fresh = await r.resolve("edge.example", 4);
  assert.equal(fresh.ttl <= 300 && fresh.ttl > 30, true);
});
