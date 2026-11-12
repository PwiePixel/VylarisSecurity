import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { newZone, sanitizeDnsState, validateRecord, defaultDnsState, type DnsState, type DnsZone } from "../lib/core/dns-model.ts";
import { defaultInventory } from "../lib/core/inventory-model.ts";
import { defaultProxyState, validateRoute, type ProxyState } from "../lib/core/proxy-model.ts";
import {
  CfClient,
  CloudflareService,
  importCloudflareZone,
  runCloudflareSync,
  sameRecord,
  summarizeCloudflare,
  toCfBody,
  type CfEnv,
} from "../engine/worker/cloudflare.ts";

/* ------------------------------------------------------------------ Mock */
type Rec = Record<string, any>;
const mock = {
  zones: {} as Record<string, string>,
  records: {} as Record<string, Rec[]>,
  hostnames: {} as Record<string, Rec[]>,
  fallback: { origin: "edge.vylaris.eu", status: "active" } as Rec | null,
  writes: [] as string[],
  failList: false,
  throttleOnce: false,
  tokenStatus: "active",
  nextId: 1,
  reset() {
    this.zones = { "example.com": "z1", "vylaris.eu": "z2" };
    this.records = { z1: [], z2: [] };
    this.hostnames = { z1: [], z2: [] };
    this.fallback = { origin: "edge.vylaris.eu", status: "active" };
    this.writes = [];
    this.failList = false;
    this.throttleOnce = false;
    this.tokenStatus = "active";
    this.nextId = 1;
  },
};

const quoteTxt = (r: Rec): Rec => (r.type === "TXT" && !String(r.content).startsWith('"') ? { ...r, content: `"${r.content}"` } : r);

let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const send = (status: number, result: unknown, info?: Rec, errors: Rec[] = []) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: status >= 200 && status < 300, errors, messages: [], result, result_info: info }));
      };
      if (req.headers.authorization !== "Bearer test-token") return send(401, null, undefined, [{ code: 10000, message: "Authentication error" }]);
      if (mock.throttleOnce) {
        mock.throttleOnce = false;
        res.writeHead(429, { "retry-after": "1" });
        return res.end("{}");
      }
      const p = url.pathname;
      const m = req.method ?? "GET";
      if (m !== "GET") mock.writes.push(`${m} ${p}`);
      if (p === "/user/tokens/verify") return send(200, { id: "t", status: mock.tokenStatus });
      if (p === "/zones") {
        const name = url.searchParams.get("name") ?? "";
        const id = mock.zones[name];
        return send(200, id ? [{ id, name }] : []);
      }
      let g = /^\/zones\/(\w+)\/dns_records(?:\/(\w+))?$/.exec(p);
      if (g) {
        const [, zid, rid] = g as unknown as [string, string, string | undefined];
        const list = mock.records[zid]!;
        if (m === "GET") {
          if (mock.failList) return send(500, null, undefined, [{ code: 1000, message: "Interner Fehler" }]);
          const per = Number(url.searchParams.get("per_page") ?? 20);
          const page = Number(url.searchParams.get("page") ?? 1);
          return send(200, list.slice((page - 1) * per, page * per).map(quoteTxt), { page, per_page: per, total_pages: Math.max(1, Math.ceil(list.length / per)) });
        }
        if (m === "POST") {
          const rec = { id: `r${mock.nextId++}`, proxied: false, ...body };
          list.push(rec);
          return send(200, rec);
        }
        const i = list.findIndex((r) => r.id === rid);
        if (i < 0) return send(404, null, undefined, [{ code: 81044, message: "Record does not exist" }]);
        if (m === "PUT") {
          list[i] = { id: rid, proxied: false, ...body };
          return send(200, list[i]);
        }
        if (m === "DELETE") {
          list.splice(i, 1);
          return send(200, { id: rid });
        }
      }
      g = /^\/zones\/(\w+)\/custom_hostnames\/fallback_origin$/.exec(p);
      if (g) return mock.fallback ? send(200, mock.fallback) : send(404, null, undefined, [{ code: 1551, message: "kein Fallback-Origin" }]);
      g = /^\/zones\/(\w+)\/custom_hostnames$/.exec(p);
      if (g) {
        const zid = g[1]!;
        const list = (mock.hostnames[zid] ??= []);
        if (m === "GET") {
          const h = url.searchParams.get("hostname");
          return send(200, h ? list.filter((x) => x.hostname === h) : list, { total_pages: 1 });
        }
        if (m === "POST") {
          const ch = { id: `h${mock.nextId++}`, hostname: body.hostname, status: "pending", ssl: { status: "pending_validation", ...body.ssl }, verification_errors: [] };
          list.push(ch);
          return send(200, ch);
        }
      }
      send(404, null, undefined, [{ code: 7003, message: "Route nicht gefunden" }]);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => mock.reset());

/* --------------------------------------------------------------- Hilfen */
const env = (extra: Partial<CfEnv> = {}): CfEnv => ({ token: "test-token", accountId: "acc", base, ...extra });

function cfZone(): DnsZone {
  const z = newZone("example.com", "cloudflare");
  z.id = "zone-cf";
  const add = (raw: Record<string, unknown>) => {
    const v = validateRecord(z, raw);
    assert.ok(v.ok, JSON.stringify(v));
    z.records.push({ ...v.data, id: String(raw.id) });
  };
  add({ id: "a1", name: "www", type: "A", value: "203.0.113.10", ttl: "300", proxied: "on" });
  add({ id: "a2", name: "mail", type: "A", value: "203.0.113.11", ttl: "600" });
  add({ id: "a3", name: "@", type: "MX", value: "mail.example.com", priority: "10" });
  add({ id: "a4", name: "@", type: "TXT", value: "v=spf1 mx -all" });
  add({ id: "a5", name: "_sip._tcp", type: "SRV", value: "sip.example.com", priority: "1", weight: "5", port: "5060" });
  add({ id: "a6", name: "@", type: "CAA", value: "letsencrypt.org", tag: "issue", flags: "0" });
  add({ id: "a7", name: "intern", type: "A", value: "10.0.0.5", visibility: "internal" }); // gehört nicht zu Cloudflare
  return z;
}

const dnsWith = (...zones: DnsZone[]): DnsState => ({ ...defaultDnsState(), zones });
const noProxy = (): ProxyState => defaultProxyState();
const writesOf = () => mock.writes.length;

function proxyWith(...hosts: { host: string; enabled?: boolean }[]): ProxyState {
  const p = defaultProxyState();
  for (const h of hosts) {
    const v = validateRoute({ host: h.host, target: "backend.internal", port: "80", enabled: h.enabled === false ? "false" : "true" }, defaultInventory());
    assert.ok(v.ok, JSON.stringify(v));
    p.routes.push(v.data);
  }
  return p;
}

/* ----------------------------------------------------------------- Tests */
describe("Cloudflare: Token", () => {
  test("ungültiger Token: kein Zonenzugriff", async () => {
    const s = await runCloudflareSync(env({ token: "falsch" }), dnsWith(cfZone()), noProxy());
    assert.equal(s.configured, true);
    assert.equal(s.tokenValid, false);
    assert.match(s.error ?? "", /401|Token/);
    assert.deepEqual(s.zones, {});
    assert.equal(writesOf(), 0);
  });

  test("kein Token: nicht konfiguriert, keine Anfragen", async () => {
    const s = await runCloudflareSync({ base }, dnsWith(cfZone()), noProxy());
    assert.equal(s.configured, false);
    assert.equal(summarizeCloudflare(s).ok, false);
  });

  test("Token mit Status ungleich active gilt als ungültig", async () => {
    mock.tokenStatus = "expired";
    const s = await runCloudflareSync(env(), dnsWith(cfZone()), noProxy());
    assert.equal(s.tokenValid, false);
  });

  test("429: Retry-After wird beachtet, danach klappt die Anfrage", async () => {
    mock.throttleOnce = true;
    const waits: number[] = [];
    const c = new CfClient({ token: "test-token", base, sleep: async (ms) => void waits.push(ms) });
    const r = await c.request("GET", "/user/tokens/verify");
    assert.equal(r.ok, true);
    assert.deepEqual(waits, [1000]);
  });
});

describe("Cloudflare: Zonen-Abgleich", () => {
  test("legt fehlende verwaltete Einträge an (interne nicht) und mappt die Typen", async () => {
    const z = cfZone();
    const s = await runCloudflareSync(env(), dnsWith(z), noProxy());
    assert.equal(s.tokenValid, true);
    const st = s.zones["zone-cf"]!;
    assert.equal(st.error, undefined);
    assert.equal(st.created, 6);
    assert.equal(st.zoneId, "z1");
    const recs = mock.records.z1!;
    assert.equal(recs.length, 6);
    const www = recs.find((r) => r.name === "www.example.com")!;
    assert.equal(www.proxied, true);
    assert.equal(www.ttl, 1); // proxied -> automatisch
    assert.equal(www.comment, "vylaris-security:a1");
    assert.equal(recs.find((r) => r.name === "mail.example.com")!.ttl, 600);
    assert.equal(recs.find((r) => r.type === "MX")!.priority, 10);
    assert.equal(recs.find((r) => r.type === "TXT")!.content.replace(/"/g, ""), "v=spf1 mx -all");
    assert.deepEqual(recs.find((r) => r.type === "SRV")!.data, { priority: 1, weight: 5, port: 5060, target: "sip.example.com" });
    assert.deepEqual(recs.find((r) => r.type === "CAA")!.data, { flags: 0, tag: "issue", value: "letsencrypt.org" });
    assert.ok(!recs.some((r) => r.name === "intern.example.com"));
  });

  test("unveränderter Stand verursacht keine Schreibaufrufe (auch wenn Cloudflare TXT in Anführungszeichen liefert)", async () => {
    const z = cfZone();
    await runCloudflareSync(env(), dnsWith(z), noProxy());
    mock.writes.length = 0;
    const s = await runCloudflareSync(env(), dnsWith(z), noProxy());
    assert.equal(writesOf(), 0, mock.writes.join(", "));
    assert.deepEqual([s.zones["zone-cf"]!.created, s.zones["zone-cf"]!.updated, s.zones["zone-cf"]!.deleted], [0, 0, 0]);
  });

  test("geänderte Einträge werden aktualisiert (genau ein PUT)", async () => {
    const z = cfZone();
    await runCloudflareSync(env(), dnsWith(z), noProxy());
    mock.writes.length = 0;
    z.records.find((r) => r.id === "a2")!.value = "203.0.113.99";
    const s = await runCloudflareSync(env(), dnsWith(z), noProxy());
    assert.equal(s.zones["zone-cf"]!.updated, 1);
    assert.deepEqual(mock.writes, ["PUT /zones/z1/dns_records/" + mock.records.z1!.find((r) => r.comment === "vylaris-security:a2")!.id]);
    assert.equal(mock.records.z1!.find((r) => r.comment === "vylaris-security:a2")!.content, "203.0.113.99");
  });

  test("gelöscht wird nur Verwaltetes; fremde Einträge bleiben und werden gezählt", async () => {
    const z = cfZone();
    mock.records.z1!.push(
      { id: "x1", type: "A", name: "fremd.example.com", content: "198.51.100.1", ttl: 300, proxied: false, comment: "von Hand" },
      { id: "x2", type: "TXT", name: "ohne-kommentar.example.com", content: "hallo", ttl: 300 },
      { id: "x3", type: "A", name: "alt.example.com", content: "198.51.100.2", ttl: 300, proxied: false, comment: "vylaris-security:verwaist" },
    );
    const s = await runCloudflareSync(env(), dnsWith(z), noProxy());
    const st = s.zones["zone-cf"]!;
    assert.equal(st.deleted, 1);
    assert.equal(st.unmanaged, 2);
    const names = mock.records.z1!.map((r) => r.name);
    assert.ok(names.includes("fremd.example.com") && names.includes("ohne-kommentar.example.com"));
    assert.ok(!names.includes("alt.example.com"));
  });

  test("Fehler beim Lesen: nichts wird angelegt, geändert oder gelöscht", async () => {
    const z = cfZone();
    mock.records.z1!.push({ id: "x3", type: "A", name: "alt.example.com", content: "198.51.100.2", ttl: 300, comment: "vylaris-security:verwaist" });
    mock.failList = true;
    const s = await runCloudflareSync(env(), dnsWith(z), noProxy());
    assert.match(s.zones["zone-cf"]!.error ?? "", /nicht gelesen/);
    assert.equal(writesOf(), 0);
    assert.equal(mock.records.z1!.length, 1);
    assert.equal(summarizeCloudflare(s).ok, false);
  });

  test("Paginierung: 250 fremde Einträge, verwaltete auf späterer Seite werden erkannt (keine Duplikate)", async () => {
    const z = cfZone();
    await runCloudflareSync(env(), dnsWith(z), noProxy());
    const managed = [...mock.records.z1!];
    mock.records.z1!.length = 0;
    for (let i = 0; i < 250; i++) mock.records.z1!.push({ id: `f${i}`, type: "TXT", name: `t${i}.example.com`, content: "x", ttl: 300 });
    mock.records.z1!.push(...managed);
    mock.writes.length = 0;
    const s = await runCloudflareSync(env(), dnsWith(z), noProxy());
    assert.equal(s.zones["zone-cf"]!.unmanaged, 250);
    assert.equal(writesOf(), 0, mock.writes.join(", "));
  });

  test("Zone nicht im Konto: lesbarer Fehler", async () => {
    const z = newZone("nicht-da.org", "cloudflare");
    const s = await runCloudflareSync(env(), dnsWith(z), noProxy());
    assert.match(s.zones[z.id]!.error ?? "", /nicht-da\.org/);
  });

  test("ALIAS wird bei Cloudflare als CNAME angelegt; Panel-Eintrag mit intern wird übersprungen", () => {
    const z = newZone("example.com", "cloudflare");
    const alias = { id: "q1", name: "@", type: "ALIAS" as const, ttl: 300, value: "ziel.example.net", visibility: "public" as const };
    assert.equal(toCfBody(z, alias)!.type, "CNAME");
    assert.equal(toCfBody(z, { ...alias, visibility: "internal" }), null);
  });

  test("sameRecord vergleicht ohne Rücksicht auf Anführungszeichen, Groß-/Kleinschreibung und Punkt am Ende", () => {
    const want = toCfBody(newZone("example.com", "cloudflare"), { id: "n1", name: "x", type: "CNAME", ttl: 300, value: "Ziel.Example.Net", visibility: "public" })!;
    assert.equal(sameRecord({ type: "CNAME", name: "X.example.com", content: "ziel.example.net.", ttl: 300, proxied: false, comment: "vylaris-security:n1" }, want), true);
    assert.equal(sameRecord({ type: "CNAME", name: "x.example.com", content: "anders.example.net", ttl: 300, proxied: false, comment: "vylaris-security:n1" }, want), false);
  });
});

describe("Cloudflare: Tunnel-Routen", () => {
  test("legt den proxied CNAME auf den Tunnel an, ist idempotent und entfernt ihn mit der Route", async () => {
    const z = newZone("example.com", "cloudflare");
    const e = env({ tunnelId: "abc123" });
    const s1 = await runCloudflareSync(e, dnsWith(z), proxyWith({ host: "shop.example.com" }));
    assert.deepEqual(s1.tunnelRoutes["shop.example.com"], { ok: true });
    const rec = mock.records.z1![0]!;
    assert.equal(rec.type, "CNAME");
    assert.equal(rec.content, "abc123.cfargotunnel.com");
    assert.equal(rec.proxied, true);
    assert.equal(rec.comment, "vylaris-security:tunnel");

    mock.writes.length = 0;
    await runCloudflareSync(e, dnsWith(z), proxyWith({ host: "shop.example.com" }));
    assert.equal(writesOf(), 0, mock.writes.join(", "));

    const s3 = await runCloudflareSync(e, dnsWith(z), proxyWith({ host: "shop.example.com", enabled: false }));
    assert.equal(mock.records.z1!.length, 0);
    assert.equal(s3.zones[z.id]!.deleted, 1);
  });

  test("ohne CF_TUNNEL_ID: Hinweis, nichts wird angelegt und vorhandene Tunnel-Einträge bleiben", async () => {
    const z = newZone("example.com", "cloudflare");
    mock.records.z1!.push({ id: "t1", type: "CNAME", name: "shop.example.com", content: "alt.cfargotunnel.com", ttl: 1, proxied: true, comment: "vylaris-security:tunnel" });
    const s = await runCloudflareSync(env(), dnsWith(z), proxyWith({ host: "shop.example.com" }));
    assert.match(s.tunnelNote ?? "", /CF_TUNNEL_ID/);
    assert.equal(s.tunnelRoutes["shop.example.com"]!.ok, false);
    assert.equal(writesOf(), 0);
    assert.equal(mock.records.z1!.length, 1);
  });

  test("bestehender fremder Eintrag mit gleichem Namen wird nie überschrieben", async () => {
    const z = newZone("example.com", "cloudflare");
    mock.records.z1!.push({ id: "f1", type: "A", name: "shop.example.com", content: "198.51.100.7", ttl: 300, comment: "von Hand" });
    const s = await runCloudflareSync(env({ tunnelId: "abc123" }), dnsWith(z), proxyWith({ host: "shop.example.com" }));
    assert.equal(s.tunnelRoutes["shop.example.com"]!.ok, false);
    assert.equal(writesOf(), 0);
  });

  test("Routen außerhalb von Cloudflare-Zonen werden ignoriert", async () => {
    const z = newZone("example.com", "cloudflare");
    const s = await runCloudflareSync(env({ tunnelId: "abc123" }), dnsWith(z), proxyWith({ host: "shop.andere.org" }));
    assert.deepEqual(s.tunnelRoutes, {});
    assert.equal(writesOf(), 0);
  });
});

describe("Cloudflare: Edge-Absicherung (Custom Hostnames)", () => {
  function edgeDns(): DnsState {
    const z = newZone("kunde.net", "authoritative");
    const v = validateRecord(z, { name: "www", type: "A", value: "203.0.113.20", protect: "on" });
    assert.ok(v.ok, JSON.stringify(v));
    z.records.push(v.data);
    const wild = validateRecord(z, { name: "*", type: "A", value: "203.0.113.20", protect: "on" });
    assert.ok(wild.ok);
    z.records.push(wild.data);
    const d = dnsWith(z);
    d.settings.edge = { enabled: true, target: "edge.vylaris.eu" };
    return d;
  }

  test("legt den Custom Hostname an (Wildcards nicht), danach idempotent", async () => {
    const s = await runCloudflareSync(env(), edgeDns(), noProxy());
    assert.deepEqual(Object.keys(s.edge), ["www.kunde.net"]);
    assert.equal(s.edge["www.kunde.net"]!.status, "pending");
    assert.equal(s.edge["www.kunde.net"]!.sslStatus, "pending_validation");
    assert.equal(s.edgeNote, undefined);
    const ch = mock.hostnames.z2![0]!;
    assert.equal(ch.hostname, "www.kunde.net");
    assert.equal(ch.ssl.method, "http");
    assert.equal(ch.ssl.type, "dv");
    assert.equal(ch.ssl.settings.min_tls_version, "1.2");

    mock.writes.length = 0;
    await runCloudflareSync(env(), edgeDns(), noProxy());
    assert.equal(writesOf(), 0, mock.writes.join(", "));
  });

  test("Fallback-Origin nicht aktiv: Hinweis in edgeNote", async () => {
    mock.fallback = { origin: "edge.vylaris.eu", status: "pending_deployment" };
    const s = await runCloudflareSync(env(), edgeDns(), noProxy());
    assert.match(s.edgeNote ?? "", /Fallback-Origin ist nicht aktiv/);
  });

  test("nicht mehr benötigte Custom Hostnames werden nur gemeldet, nie gelöscht", async () => {
    mock.hostnames.z2!.push({ id: "old", hostname: "alt.kunde.net", status: "active", ssl: { status: "active" } });
    const s = await runCloudflareSync(env(), edgeDns(), noProxy());
    assert.match(s.edgeNote ?? "", /alt\.kunde\.net/);
    assert.ok(mock.hostnames.z2!.some((h) => h.id === "old"));
    assert.ok(!mock.writes.some((w) => w.startsWith("DELETE")));
  });

  test("Edge-Zone nicht im Konto: Hinweis statt Fehler", async () => {
    const d = edgeDns();
    d.settings.edge.target = "edge.unbekannt.org";
    const s = await runCloudflareSync(env(), d, noProxy());
    assert.match(s.edgeNote ?? "", /unbekannt\.org/);
    assert.deepEqual(s.edge, {});
  });

  test("ausgeschaltet: keine Anfragen an custom_hostnames", async () => {
    const d = edgeDns();
    d.settings.edge.enabled = false;
    const s = await runCloudflareSync(env(), d, noProxy());
    assert.deepEqual(s.edge, {});
    assert.equal(mock.hostnames.z2!.length, 0);
  });
});

describe("Cloudflare: Import", () => {
  test("liefert Vorschläge, überspringt Verwaltetes und nicht unterstützte Typen, ändert nichts", async () => {
    const z = newZone("example.com", "cloudflare");
    z.id = "zone-imp";
    mock.records.z1!.push(
      { id: "i1", type: "A", name: "www.example.com", content: "203.0.113.5", ttl: 1, proxied: true },
      { id: "i2", type: "TXT", name: "example.com", content: '"v=spf1 -all"', ttl: 3600 },
      { id: "i3", type: "MX", name: "example.com", content: "mx.example.com", priority: 20, ttl: 300 },
      { id: "i4", type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"', ttl: 300, data: { flags: 0, tag: "issue", value: "letsencrypt.org" } },
      { id: "i5", type: "HTTPS", name: "example.com", content: "1 .", ttl: 300 },
      { id: "i6", type: "A", name: "schon.example.com", content: "203.0.113.6", ttl: 300, comment: "vylaris-security:abc" },
    );
    const c = new CfClient({ token: "test-token", base });
    const r = await importCloudflareZone(c, dnsWith(z), "zone-imp");
    assert.equal(r.ok, true);
    const recs = r.data!.records;
    assert.equal(recs.length, 4);
    assert.equal(r.data!.skipped, 1);
    const www = recs.find((x) => x.name === "www")!;
    assert.equal(www.proxied, true);
    assert.equal(www.ttl, z.defaultTtl);
    assert.equal(recs.find((x) => x.type === "TXT")!.value, "v=spf1 -all");
    assert.equal(recs.find((x) => x.type === "MX")!.priority, 20);
    assert.equal(recs.find((x) => x.type === "CAA")!.value, "letsencrypt.org");
    assert.equal(writesOf(), 0);
  });

  test("unbekannte Panel-Zone", async () => {
    const r = await importCloudflareZone(new CfClient({ token: "test-token", base }), dnsWith(), "nix");
    assert.equal(r.ok, false);
  });
});

describe("Cloudflare: Dienst", () => {
  test("gleicht bei Änderung (mit Mindestabstand) und nach Intervall ab, nie parallel", async () => {
    let loads = 0;
    const z = cfZone();
    const svc = new CloudflareService(env(), async () => (loads++, { dns: dnsWith(z), proxy: noProxy() }), { intervalMs: 60_000, minGapMs: 10_000 });
    const t0 = Date.now();
    await svc.syncIfDue(t0); // erster Lauf (dirty, Abstand groß genug)
    assert.equal(loads, 1);
    assert.equal(svc.status.zones["zone-cf"]!.created, 6);
    await svc.syncIfDue(t0 + 1000); // nichts geändert, Intervall nicht erreicht
    assert.equal(loads, 1);
    svc.markDirty();
    await svc.syncIfDue(Date.now() + 1000); // geändert, aber Mindestabstand (10 s) nicht erreicht
    assert.equal(loads, 1);
    await svc.syncIfDue(Date.now() + 11_000);
    assert.equal(loads, 2);
    await svc.syncIfDue(Date.now() + 61_000); // Intervall
    assert.equal(loads, 3);
    const [a, b] = await Promise.all([svc.sync(), svc.sync()]); // gleichzeitig: ein Lauf
    assert.equal(a, b);
    assert.equal(loads, 4);
  });

  test("Token taucht in keinem Status auf", async () => {
    const s = await runCloudflareSync(env(), dnsWith(cfZone()), noProxy());
    assert.ok(!JSON.stringify(s).includes("test-token"));
    const bad = await runCloudflareSync(env({ token: "geheim-123" }), dnsWith(cfZone()), noProxy());
    assert.ok(!JSON.stringify(bad).includes("geheim-123"));
  });
});

test("sanitizeDnsState übersteht den Round-Trip der Test-Zone", () => {
  const z = cfZone();
  const back = sanitizeDnsState(JSON.parse(JSON.stringify(dnsWith(z))));
  assert.equal(back.zones[0]!.records.length, z.records.length);
});
