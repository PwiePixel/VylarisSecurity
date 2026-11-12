import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sanitizeInventory } from "../lib/core/inventory-model.ts";

const DATA = await fs.mkdtemp(path.join(os.tmpdir(), "vsec-scan-"));
process.env.DATA_DIR = DATA; // vor dem Import der Engine-Module setzen
const { parseArp, scanOnce, tcpProbe, runScan } = await import("../engine/worker/scan.ts");
const { processRequests, cleanupResults, parseRequest } = await import("../engine/worker/requests.ts");

const inv = (subnets: object[]) => sanitizeInventory({ subnets });
const ARP = `IP address       HW type     Flags       HW address            Mask     Device
203.0.113.2      0x1         0x2         AA:BB:CC:00:00:02     *        eth0
203.0.113.3      0x1         0x0         00:00:00:00:00:00     *        eth0
203.0.113.4      0x1         0x2         aa:bb:cc:00:00:04     *        eth0
`;

test("ARP-Tabelle: nur vollständige Einträge mit echter MAC", () => {
  const m = parseArp(ARP);
  assert.deepEqual([...m.entries()], [
    ["203.0.113.2", "aa:bb:cc:00:00:02"],
    ["203.0.113.4", "aa:bb:cc:00:00:04"],
  ]);
});

test("Scan: nur Subnetze mit scan=true, nur Host-Adressen, up/down, MAC aus ARP, lastUp bleibt erhalten", async () => {
  const i = inv([
    { name: "öffentlich", cidr: "203.0.113.0/29", scan: "on", gateway: "203.0.113.1" },
    { name: "ohne Scan", cidr: "198.51.100.0/30" },
  ]);
  const probed: string[] = [];
  const probe = async (ip: string) => {
    probed.push(ip);
    return ip === "203.0.113.1" || ip === "203.0.113.5" ? { up: true, method: "ping", rttMs: 3 } : { up: false };
  };
  const arp = async () => parseArp(ARP);
  const t1 = new Date("2026-11-12T10:00:00Z");
  const first = await scanOnce({ inventory: i, probe, arp, now: () => t1 });
  assert.equal(first.checked, 6); // /29 = 8 Adressen minus Netz und Broadcast
  assert.ok(!probed.includes("203.0.113.0") && !probed.includes("203.0.113.7"));
  assert.ok(!probed.some((ip) => ip.startsWith("198.51.100.")));
  const h = first.data.hosts;
  assert.equal(h["203.0.113.1"]!.up, true);
  assert.equal(h["203.0.113.1"]!.method, "ping");
  assert.equal(h["203.0.113.2"]!.up, true); // nur über ARP gefunden
  assert.equal(h["203.0.113.2"]!.method, "arp");
  assert.equal(h["203.0.113.2"]!.mac, "aa:bb:cc:00:00:02");
  assert.equal(h["203.0.113.3"]!.up, false); // unvollständiger ARP-Eintrag zählt nicht
  assert.equal(h["203.0.113.6"]!.up, false);
  assert.equal(h["203.0.113.5"]!.lastUp, t1.toISOString());

  // zweiter Lauf: .5 ist jetzt down, lastUp bleibt vom ersten Lauf
  const t2 = new Date("2026-11-12T10:05:00Z");
  const second = await scanOnce({ inventory: i, previous: first.data, probe: async () => ({ up: false }), arp: async () => new Map(), now: () => t2 });
  assert.equal(second.data.hosts["203.0.113.5"]!.up, false);
  assert.equal(second.data.hosts["203.0.113.5"]!.lastUp, t1.toISOString());
  assert.equal(second.data.hosts["203.0.113.5"]!.lastChecked, t2.toISOString());
});

test("Scan: Obergrenze je Lauf und Fehler einzelner Proben", async () => {
  const i = inv([{ name: "groß", cidr: "10.9.0.0/24", scan: "on" }]);
  let calls = 0;
  const out = await scanOnce({
    inventory: i,
    limit: 10,
    concurrency: 4,
    arp: async () => new Map(),
    probe: async () => {
      calls++;
      throw new Error("kaputt");
    },
  });
  assert.equal(out.truncated, true);
  assert.equal(out.checked, 10);
  assert.equal(calls, 10);
  assert.ok(Object.values(out.data.hosts).every((x) => x.up === false));
});

test("TCP-Probe: offener Port und abgelehnte Verbindung bedeuten 'up'; ohne Ports 'down'", async () => {
  const srv = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const open = (srv.address() as net.AddressInfo).port;
  const up = await tcpProbe("127.0.0.1", [open]);
  assert.equal(up.up, true);
  assert.equal(up.method, "tcp");
  await new Promise<void>((r) => srv.close(() => r()));
  const refused = await tcpProbe("127.0.0.1", [open]); // Port jetzt zu: ECONNREFUSED = Host antwortet
  assert.equal(refused.up, true);
  assert.equal((await tcpProbe("127.0.0.1", [])).up, false);
});

test("runScan schreibt runtime/scan.json und meldet die Zusammenfassung", async () => {
  const i = inv([{ name: "lokal", cidr: "127.0.0.0/30", scan: "on" }]);
  const sum = await runScan(i, { probe: async (ip) => ({ up: ip === "127.0.0.1", method: "tcp" }), arp: async () => new Map() });
  assert.equal(sum.hosts, 2);
  assert.equal(sum.error, undefined);
  const file = JSON.parse(await fs.readFile(path.join(DATA, "runtime/scan.json"), "utf8"));
  assert.equal(file.hosts["127.0.0.1"].up, true);
  assert.equal(file.hosts["127.0.0.2"].up, false);
});

/* --------------------------------------------------------------- Aufträge */
const reqDir = path.join(DATA, "requests");

test("Aufträge: gültige werden ausgeführt (Ergebnis + Datei weg), ungültige verworfen", async () => {
  await fs.mkdir(reqDir, { recursive: true });
  const w = (name: string, body: string) => fs.writeFile(path.join(reqDir, name), body);
  const now = new Date().toISOString();
  await w("scan0001.json", JSON.stringify({ id: "scan0001", type: "scan-now", at: now }));
  await w("imp00001.json", JSON.stringify({ id: "imp00001", type: "cloudflare-import", zoneId: "zone-1", at: now }));
  await w("bad00001.json", JSON.stringify({ id: "bad00001", type: "cloudflare-import", at: now })); // zoneId fehlt
  await w("other001.json", JSON.stringify({ id: "andere", type: "scan-now" })); // id passt nicht zum Dateinamen
  await w("unknown1.json", JSON.stringify({ id: "unknown1", type: "format-c" }));
  await w("json0001.json", "{kaputt");
  await w("big00001.json", JSON.stringify({ id: "big00001", type: "scan-now", pad: "x".repeat(5000) }));
  await w("Groß.json", "{}");
  await w("boom0001.json", JSON.stringify({ id: "boom0001", type: "proxmox-import", at: now }));

  const calls: string[] = [];
  const n = await processRequests({
    "scan-now": async (r) => (calls.push(r.type), { ok: true, message: "geprüft" }),
    "cloudflare-sync": async () => ({ ok: true, message: "x" }),
    "cloudflare-import": async (r) => (calls.push(`${r.type}:${r.zoneId}`), { ok: true, message: "ok", data: { records: [] } }),
    "proxmox-import": async () => {
      throw new Error("Proxmox weg");
    },
  });
  assert.equal(n, 3);
  assert.deepEqual(calls.sort(), ["cloudflare-import:zone-1", "scan-now"]);
  assert.deepEqual(await fs.readdir(reqDir), []); // alles aufgeräumt
  const res = JSON.parse(await fs.readFile(path.join(DATA, "runtime/results/scan0001.json"), "utf8"));
  assert.equal(res.ok, true);
  assert.equal(res.id, "scan0001");
  const boom = JSON.parse(await fs.readFile(path.join(DATA, "runtime/results/boom0001.json"), "utf8"));
  assert.equal(boom.ok, false);
  assert.match(boom.message, /Proxmox weg/);
  await assert.rejects(fs.readFile(path.join(DATA, "runtime/results/bad00001.json")));
});

test("Ergebnisse älter als ein Tag werden gelöscht", async () => {
  const dir = path.join(DATA, "runtime/results");
  const old = path.join(dir, "alt00001.json");
  await fs.writeFile(old, "{}");
  const past = new Date(Date.now() - 25 * 3600_000);
  await fs.utimes(old, past, past);
  const removed = await cleanupResults();
  assert.equal(removed, 1);
  await assert.rejects(fs.stat(old));
  assert.ok((await fs.readdir(dir)).includes("scan0001.json"));
});

test("parseRequest: Form und Ids", () => {
  assert.equal(parseRequest("abcdef", { id: "abcdef", type: "scan-now" })?.type, "scan-now");
  assert.equal(parseRequest("abcdef", { id: "abcdeg", type: "scan-now" }), null);
  assert.equal(parseRequest("abcdef", null), null);
  assert.equal(parseRequest("abcdef", { id: "abcdef", type: "cloudflare-import", zoneId: "../etc" }), null);
});
