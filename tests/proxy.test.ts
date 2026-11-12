import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// DATA_DIR wird beim Import von engine/common/data.ts festgelegt – deshalb zuerst setzen.
const dir = mkdtempSync(path.join(tmpdir(), "vsec-proxy-"));
process.env.DATA_DIR = dir;
const { startProxy } = await import("../engine/proxy/proxy.ts");
type Handle = Awaited<ReturnType<typeof startProxy>>;

/* ------------------------------------------------------------ Test-Upstream */
let uploaded = 0;
const upstream = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/big")) {
    res.writeHead(200, { "content-type": "application/octet-stream", server: "geheim/1.0", "x-powered-by": "PHP" });
    const chunk = Buffer.alloc(64 * 1024, 7);
    let n = 0;
    const write = () => {
      while (n < 128) {
        n++;
        if (!res.write(chunk)) return void res.once("drain", write);
      }
      res.end();
    };
    write();
    return;
  }
  if (url.startsWith("/upload")) {
    let size = 0;
    req.on("data", (c: Buffer) => (size += c.length));
    req.on("end", () => {
      uploaded = size;
      res.end(String(size));
    });
    req.on("close", () => (uploaded = Math.max(uploaded, size)));
    return;
  }
  res.writeHead(200, { "content-type": "application/json", server: "geheim/1.0", "x-powered-by": "PHP" });
  res.end(JSON.stringify({ url, method: req.method, headers: req.headers }));
});
upstream.on("upgrade", (req, socket: Socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
  socket.on("data", (c) => socket.write(c));
  socket.on("error", () => undefined);
});

/* --------------------------------------------------------------- Hilfsmittel */
type Res = { status: number; headers: IncomingHttpHeaders; body: Buffer };

function request(port: number, o: { host?: string; path?: string; method?: string; headers?: Record<string, string>; body?: Buffer | string; chunks?: Buffer[] } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    let got = false;
    const req = http.request(
      { host: "127.0.0.1", port, path: o.path ?? "/", method: o.method ?? "GET", headers: { host: o.host ?? "app.example.com", ...o.headers }, agent: false },
      (res) => {
        got = true;
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
        res.on("error", reject);
      },
    );
    req.on("error", (e) => {
      if (!got) reject(e);
    });
    if (o.chunks) {
      for (const c of o.chunks) req.write(c);
      req.end();
    } else req.end(o.body);
  });
}

const json = (r: Res) => JSON.parse(r.body.toString()) as { url: string; method: string; headers: Record<string, string> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  assert.fail("Bedingung nicht rechtzeitig erfüllt");
}

let upPort = 0;
let deadPort = 0;
let proxy: Handle;
let port = 0;

const route = (id: string, host: string, extra: Record<string, unknown> = {}, upstreamExtra: Record<string, unknown> = {}) => ({
  id,
  host,
  upstream: { type: "custom", host: "127.0.0.1", port: upPort, scheme: "http", ...upstreamExtra },
  enabled: true,
  preserveHost: false,
  insecureUpstream: false,
  rateLimitPerMinute: 0,
  allowIps: [],
  denyIps: [],
  hardenHeaders: false,
  ...extra,
});

function writeConfig(routes: unknown[], rules: Record<string, unknown> = {}): void {
  writeFileSync(
    path.join(dir, "inventory.json"),
    JSON.stringify({
      version: 1,
      settings: { serverDomain: "server.vylaris.it" },
      subnets: [],
      servers: [
        { id: "s1", name: "web01", dnsVisibility: "internal" },
        { id: "s2", name: "leer01", dnsVisibility: "internal" },
      ],
      ips: [{ ip: "127.0.0.1", status: "assigned", serverId: "s1" }],
    }),
  );
  writeFileSync(
    path.join(dir, "proxy.json"),
    JSON.stringify({
      version: 1,
      rules: { blockedIps: ["203.0.113.50"], blockedUserAgents: ["badbot"], rateLimitPerMinute: 0, maxBodyMb: 1, upstreamTimeoutSec: 5, ...rules },
      routes,
    }),
  );
}

const baseRoutes = () => [
  route("r1", "app.example.com", {}, { type: "server", serverId: "s1", host: undefined }),
  route("r2", "*.wild.example.com", { preserveHost: true }),
  route("r3", "deny.example.com", { denyIps: ["203.0.113.9"] }),
  route("r4", "allow.example.com", { allowIps: ["198.51.100.0/24"] }),
  route("r5", "limit.example.com", { rateLimitPerMinute: 3 }),
  route("r6", "dead.example.com", {}, { port: deadPort }),
  route("r7", "leer.example.com", {}, { type: "server", serverId: "s2", host: undefined }),
  route("r8", "ws.example.com"),
  route("r9", "hard.example.com", { hardenHeaders: true }),
  route("r10", "off.example.com", { enabled: false }),
];

before(async () => {
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upPort = (upstream.address() as AddressInfo).port;
  // freien, aber ungenutzten Port ermitteln
  const tmp = http.createServer();
  await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
  deadPort = (tmp.address() as AddressInfo).port;
  await new Promise<void>((r) => tmp.close(() => r()));
  writeConfig(baseRoutes());
  proxy = await startProxy({ port: 0, bind: "127.0.0.1", watchIntervalMs: 100, statsIntervalMs: 60_000 });
  port = proxy.port;
});

after(async () => {
  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------- Tests */
test("Routing nach Host: Server-Ziel, Header-Weitergabe, Besucher-IP aus CF-Connecting-IP", async () => {
  const r = await request(port, {
    path: "/hallo?x=1",
    headers: { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "6.6.6.6", "x-vylaris-admin": "1", "x-real-ip": "6.6.6.6", connection: "keep-alive, x-geheim", "x-geheim": "1" },
  });
  assert.equal(r.status, 200);
  const j = json(r);
  assert.equal(j.url, "/hallo?x=1");
  assert.equal(j.headers["x-forwarded-for"], "198.51.100.7", "gefälschtes X-Forwarded-For wird verworfen");
  assert.equal(j.headers["x-real-ip"], "198.51.100.7");
  assert.equal(j.headers["x-forwarded-proto"], "https");
  assert.equal(j.headers["x-forwarded-host"], "app.example.com");
  assert.equal(j.headers["x-vylaris-admin"], undefined);
  assert.equal(j.headers["x-geheim"], undefined, "in Connection genannte Header sind hop-by-hop");
  assert.equal(j.headers["cf-connecting-ip"], "198.51.100.7", "CF-Header bleiben");
  assert.equal(j.headers.host, `web01.server.vylaris.it:${upPort}`, "Host: Name des Servers");
  assert.equal(r.headers.server, undefined, "Server-Header des Ursprungs entfernt");
  assert.equal(r.headers["x-powered-by"], undefined);
});

test("Ohne CF-Connecting-IP zählt die Socket-Adresse, ungültige Werte werden ignoriert", async () => {
  assert.equal(json(await request(port)).headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(json(await request(port, { headers: { "cf-connecting-ip": "kein-ip" } })).headers["x-forwarded-for"], "127.0.0.1");
});

test("Wildcard-Route und preserveHost; deaktivierte Route gilt nicht", async () => {
  const r = await request(port, { host: "foo.wild.example.com" });
  assert.equal(r.status, 200);
  assert.equal(json(r).headers.host, "foo.wild.example.com", "preserveHost: Original-Host");
  assert.equal((await request(port, { host: "wild.example.com" })).status, 404, "Wildcard gilt nicht für die Domain selbst");
  assert.equal((await request(port, { host: "off.example.com" })).status, 404);
});

test("Unbekannter Host: 404 ohne Details", async () => {
  const r = await request(port, { host: "nope.example.com" });
  assert.equal(r.status, 404);
  const body = r.body.toString();
  assert.match(body, /Nicht gefunden/);
  assert.ok(!body.includes("127.0.0.1") && !body.includes("web01"));
  assert.equal((await request(port, { host: "" })).status, 404);
});

test("Healthcheck nur mit Host localhost / 127.0.0.1", async () => {
  const r = await request(port, { host: "localhost", path: "/healthz" });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "ok");
  assert.equal((await request(port, { host: "127.0.0.1", path: "/healthz" })).status, 200);
  assert.equal((await request(port, { host: "localhost", path: "/anders" })).status, 404);
  assert.equal(json(await request(port, { host: "app.example.com", path: "/healthz" })).url, "/healthz", "mit Routen-Host wird weitergeleitet");
});

test("Streaming großer Antworten (8 MB) und Byte-Zähler", async () => {
  const before = proxy.snapshot().routes.r1?.bytesOut ?? 0;
  const r = await request(port, { path: "/big" });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 128 * 64 * 1024);
  assert.equal(r.headers.server, undefined);
  await until(() => (proxy.snapshot().routes.r1?.bytesOut ?? 0) - before >= 128 * 64 * 1024);
});

test("Gesperrte Besucher-IP (global) und Deny-Liste der Route", async () => {
  assert.equal((await request(port, { headers: { "cf-connecting-ip": "203.0.113.50" } })).status, 403);
  assert.equal((await request(port, { host: "deny.example.com", headers: { "cf-connecting-ip": "203.0.113.9" } })).status, 403);
  assert.equal((await request(port, { host: "deny.example.com", headers: { "cf-connecting-ip": "203.0.113.10" } })).status, 200);
});

test("Allow-Liste: nur erlaubte Netze", async () => {
  assert.equal((await request(port, { host: "allow.example.com", headers: { "cf-connecting-ip": "198.51.100.77" } })).status, 200);
  assert.equal((await request(port, { host: "allow.example.com", headers: { "cf-connecting-ip": "192.0.2.1" } })).status, 403);
});

test("User-Agent-Sperre (Teilstring, Groß-/Kleinschreibung egal)", async () => {
  assert.equal((await request(port, { headers: { "user-agent": "Mozilla BadBot/2.0" } })).status, 403);
  assert.equal((await request(port, { headers: { "user-agent": "Mozilla/5.0" } })).status, 200);
});

test("Anfragelimit je Besucher und Route: 429 mit Retry-After", async () => {
  const h = { "cf-connecting-ip": "198.51.100.200" };
  for (let i = 0; i < 3; i++) assert.equal((await request(port, { host: "limit.example.com", headers: h })).status, 200);
  const r = await request(port, { host: "limit.example.com", headers: h });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers["retry-after"]) >= 1);
  assert.equal((await request(port, { host: "limit.example.com", headers: { "cf-connecting-ip": "198.51.100.201" } })).status, 200, "andere Besucher sind nicht betroffen");
});

test("Zu große Anfragen: 413 (Content-Length) und Abbruch beim Streamen", async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 1);
  const r = await request(port, { method: "POST", path: "/upload", headers: { "content-length": String(big.length) }, body: big }).catch((e: Error) => e);
  if (r instanceof Error) assert.match((r as NodeJS.ErrnoException).code ?? "", /ECONNRESET|EPIPE/);
  else assert.equal(r.status, 413);

  uploaded = 0;
  const chunks = Array.from({ length: 48 }, () => Buffer.alloc(64 * 1024, 2)); // 3 MB ohne Content-Length
  const s = await request(port, { method: "POST", path: "/upload", chunks }).catch((e: Error) => e);
  if (s instanceof Error) assert.match((s as NodeJS.ErrnoException).code ?? "", /ECONNRESET|EPIPE/);
  else assert.equal(s.status, 413);
  await sleep(100);
  assert.ok(uploaded < 3 * 1024 * 1024, `Ursprung bekam nicht alles (${uploaded})`);
  assert.ok(proxy.snapshot().events.some((e) => e.reason === "too-large"));

  const ok = await request(port, { method: "POST", path: "/upload", body: Buffer.alloc(512 * 1024, 3) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString(), String(512 * 1024));
});

test("Toter Ursprung: 502 ohne interne Adressen; Server ohne Adresse: 503", async () => {
  const r = await request(port, { host: "dead.example.com" });
  assert.equal(r.status, 502);
  assert.ok(!r.body.toString().includes("127.0.0.1") && !r.body.toString().includes(String(deadPort)));
  assert.equal((await request(port, { host: "leer.example.com" })).status, 503);
});

test("Gehärtete Header nur, wenn der Ursprung sie nicht liefert", async () => {
  const r = await request(port, { host: "hard.example.com" });
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.match(String(r.headers["strict-transport-security"]), /max-age=31536000/);
  assert.equal((await request(port)).headers["strict-transport-security"], undefined);
});

function upgrade(host: string, headers: Record<string, string> = {}): Promise<{ status: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/ws", headers: { host, connection: "Upgrade", upgrade: "echo", ...headers }, agent: false });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket: socket as Socket }));
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

test("WebSocket/Upgrade wird durchgereicht (Echo) und unterliegt denselben Prüfungen", async () => {
  const { status, socket } = await upgrade("ws.example.com", { "cf-connecting-ip": "198.51.100.9" });
  assert.equal(status, 101);
  const echoed = await new Promise<string>((resolve) => {
    socket!.once("data", (d) => resolve(d.toString()));
    socket!.write("hallo-ws");
  });
  assert.equal(echoed, "hallo-ws");
  socket!.destroy();
  assert.equal((await upgrade("ws.example.com", { "cf-connecting-ip": "203.0.113.50" })).status, 403);
  assert.equal((await upgrade("nope.example.com")).status, 404);
  await until(() => (proxy.snapshot().routes.r8?.bytesIn ?? 0) >= "hallo-ws".length);
});

test("Statistik: Zähler je Route, Gesamtsumme, Ereignisse, Datei runtime/proxy.json", async () => {
  await sleep(50);
  const s = proxy.snapshot();
  assert.ok((s.routes.r1?.requests ?? 0) >= 4);
  assert.ok((s.routes.r1?.s2xx ?? 0) >= 4);
  assert.ok((s.routes.r1?.blocked ?? 0) >= 2, "gesperrte IP + User-Agent + zu groß");
  assert.ok((s.routes.r3?.blocked ?? 0) >= 1);
  assert.ok((s.routes.r5?.rateLimited ?? 0) >= 1);
  assert.ok((s.routes.r6?.upstreamErrors ?? 0) >= 1);
  assert.ok((s.routes.r6?.s5xx ?? 0) >= 1);
  assert.ok((s.routes.r7?.upstreamErrors ?? 0) >= 1);
  assert.ok(s.unknownHost >= 2);
  assert.ok(s.totals.requests >= (s.routes.r1?.requests ?? 0));
  assert.ok(s.totals.bytesOut >= 128 * 64 * 1024);
  assert.ok((s.routes.r1?.latencyMs ?? 0) >= 0);
  assert.equal(s.perMinute.length >= 1, true);
  assert.ok((s.perMinute.at(-1)?.req ?? 0) > 0);
  const reasons = new Set(s.events.map((e) => e.reason));
  for (const want of ["unknown-host", "blocked-ip", "deny-ip", "not-allowed", "user-agent", "rate-limit", "upstream-error"]) assert.ok(reasons.has(want as never), `Ereignis ${want}`);
  assert.ok(s.events.length <= 100);
  assert.ok(!s.routes.r10 || s.routes.r10.requests === 0);

  await proxy.flush();
  const file = JSON.parse(readFileSync(path.join(dir, "runtime", "proxy.json"), "utf8"));
  assert.equal(typeof file.updatedAt, "string");
  assert.equal(file.routes.r1.requests, proxy.snapshot().routes.r1?.requests);
});

test("Ereignisse werden gedrosselt (nicht jede Anfrage ein Eintrag)", async () => {
  const before = proxy.snapshot().events.filter((e) => e.reason === "user-agent").length;
  for (let i = 0; i < 20; i++) await request(port, { headers: { "user-agent": "badbot", "cf-connecting-ip": "198.51.100.99" } });
  const after = proxy.snapshot().events.filter((e) => e.reason === "user-agent").length;
  assert.ok(after - before <= 1);
});

test("Neuladen: neue Route per Datei (Beobachter) und per reload(); Fehler behalten den alten Stand", async () => {
  assert.equal((await request(port, { host: "neu.example.com" })).status, 404);
  writeConfig([...baseRoutes(), route("r11", "neu.example.com")]);
  await until(async () => (await request(port, { host: "neu.example.com" })).status === 200);

  // Server bekommt eine andere Adresse: Routen mit Server-Ziel folgen nach reload()
  writeFileSync(
    path.join(dir, "inventory.json"),
    JSON.stringify({ version: 1, settings: { serverDomain: "server.vylaris.it" }, subnets: [], servers: [{ id: "s1", name: "web01", dnsVisibility: "internal" }], ips: [] }),
  );
  await proxy.reload();
  assert.equal((await request(port, { host: "app.example.com" })).status, 503, "Server ohne Adresse");
  writeFileSync(path.join(dir, "inventory.json"), "{ kaputt");
  await proxy.reload();
  assert.equal((await request(port, { host: "neu.example.com" })).status, 200, "defekte Datei bricht den Betrieb nicht");
});

test("Zähler entfernter Routen bleiben (24 h), neue Konfiguration setzt Regeln neu", async () => {
  writeConfig([route("r1", "app.example.com"), route("r12", "x.example.com")], { blockedUserAgents: [] });
  await proxy.reload();
  assert.ok(proxy.snapshot().routes.r5 !== undefined, "Zähler bleiben zunächst erhalten");
  assert.equal((await request(port, { host: "x.example.com", headers: { "user-agent": "badbot" } })).status, 200);
});
