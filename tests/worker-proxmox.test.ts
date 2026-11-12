import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { sanitizeInventory } from "../lib/core/inventory-model.ts";
import { defaultIntegrations, type TrafficData } from "../lib/core/runtime-model.ts";

const DATA = await fs.mkdtemp(path.join(os.tmpdir(), "vsec-pve-"));
process.env.DATA_DIR = DATA;
const { TrafficCollector, TrafficRecorder, parseProcNetDev, MAX_POINTS } = await import("../engine/worker/traffic.ts");
const { httpJson, matchServer, parseConfigIps, pveConfig, pveImport, pveMessage, pveResources } = await import("../engine/worker/proxmox.ts");

/* ------------------------------------------------------------- Proxmox-Mock */
const TOKEN = "PVEAPIToken=root@pam!vsec=geheim";
let netin = 1_000_000;
let netout = 500_000;
let mode: "ok" | "401" | "403" = "ok";
let seenAuth = "";

const resources = () => [
  { type: "node", id: "node/pve1", node: "pve1", status: "online", cpu: 0.12, mem: 4e9, uptime: 99999 },
  { type: "qemu", id: "qemu/100", vmid: 100, name: "web01", node: "pve1", status: "running", cpu: 0.05, mem: 1.5e9, uptime: 3600, netin, netout },
  { type: "qemu", id: "qemu/101", vmid: 101, name: "db01", node: "pve1", status: "stopped", netin: 0, netout: 0 },
  { type: "lxc", id: "lxc/200", vmid: 200, name: "dns-ct", node: "pve1", status: "running", netin: 10, netout: 20 },
  { type: "storage", id: "storage/pve1/local", storage: "local" },
];
const CONFIGS: Record<string, object> = {
  "/api2/json/nodes/pve1/qemu/100/config": { name: "web01", ipconfig0: "ip=203.0.113.10/28,gw=203.0.113.1", ipconfig1: "ip=203.0.113.11/28", net0: "virtio=AA:BB:CC:00:00:01,bridge=vmbr0" },
  "/api2/json/nodes/pve1/qemu/101/config": { name: "db01", ipconfig0: "ip=dhcp" },
  "/api2/json/nodes/pve1/lxc/200/config": { net0: "name=eth0,bridge=vmbr0,ip=203.0.113.20/28,gw=203.0.113.1,type=veth", net1: "name=eth1,ip=dhcp" },
};

let server: http.Server;
let url = "";
before(async () => {
  server = http.createServer((req, res) => {
    seenAuth = String(req.headers.authorization ?? "");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (seenAuth !== TOKEN) return send(401, { data: null });
    if (mode === "401") return send(401, null);
    if (mode === "403") return send(403, null);
    if (req.url === "/api2/json/cluster/resources") return send(200, { data: resources() });
    const cfg = CONFIGS[req.url ?? ""];
    if (cfg) return send(200, { data: cfg });
    send(404, { data: null });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fs.writeFile(
    path.join(DATA, "integrations.json"),
    JSON.stringify({ ...defaultIntegrations(), proxmox: { enabled: true, url, tokenId: "root@pam!vsec", verifyTls: false } }),
  );
});
after(() => server.close());

const inventory = async () =>
  sanitizeInventory({
    servers: [
      { id: "s-web", name: "web01", vmid: 100, node: "pve1" },
      { id: "s-db", name: "db01", vmid: 101 }, // ohne Knoten: Zuordnung nur über die VM-ID
    ],
  });

const NETDEV = (eth0rx: number, eth0tx: number) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 111 1 0 0 0 0 0 0 222 2 0 0 0 0 0 0
  eth0: ${eth0rx} 10 0 0 0 0 0 0 ${eth0tx} 10 0 0 0 0 0 0
docker0: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0
veth12ab: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0
br-1234: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0
`;

/* ------------------------------------------------------------------ Tests */
test("/proc/net/dev: lo, docker*, veth*, br-* werden ausgelassen", () => {
  const m = parseProcNetDev(NETDEV(1000, 2000));
  assert.deepEqual([...m.keys()], ["eth0"]);
  assert.deepEqual(m.get("eth0"), { rx: 1000, tx: 2000 });
});

test("Proxmox-Konfiguration: aus, unvollständig, vollständig", () => {
  const i = defaultIntegrations();
  assert.deepEqual(pveConfig(i, "x"), {});
  i.proxmox = { enabled: true, url: "https://pve:8006/", tokenId: "root@pam!t", verifyTls: false };
  assert.match(pveConfig(i, undefined).error ?? "", /PROXMOX_TOKEN_SECRET/);
  assert.equal(pveConfig(i, "s").cfg?.url, "https://pve:8006");
  i.proxmox.url = "";
  assert.match(pveConfig(i, "s").error ?? "", /Adresse oder Token-ID/);
});

test("Ressourcen: Token-Header, nur VMs/Container/Knoten", async () => {
  const res = await pveResources({ url, tokenId: "root@pam!vsec", secret: "geheim", verifyTls: false });
  assert.equal(seenAuth, TOKEN);
  assert.deepEqual(res.map((r) => r.type).sort(), ["lxc", "node", "qemu", "qemu"]);
});

test("Fehler sind lesbar: 401, 403, Verbindung verweigert", async () => {
  const cfg = { url, tokenId: "root@pam!vsec", secret: "geheim", verifyTls: false };
  await assert.rejects(pveResources({ ...cfg, secret: "falsch" }), (e) => /401/.test(pveMessage(e)));
  mode = "403";
  await assert.rejects(pveResources(cfg), (e) => /403.*PVEAuditor/.test(pveMessage(e)));
  mode = "ok";
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  await assert.rejects(httpJson(`http://127.0.0.1:${port}/x`), (e) => /verweigert/.test(pveMessage(e)));
  await assert.rejects(httpJson("kein url"), (e) => /ungültig/.test(pveMessage(e)));
});

test("Server-Zuordnung: Knoten+VM-ID, sonst nur VM-ID", async () => {
  const inv = await inventory();
  assert.equal(matchServer(inv, "pve1", 100)?.id, "s-web");
  assert.equal(matchServer(inv, "pve2", 100), undefined); // anderer Knoten, Server ist an pve1 gebunden
  assert.equal(matchServer(inv, "pve1", 101)?.id, "s-db");
  assert.equal(matchServer(inv, "pve9", 101)?.id, "s-db"); // Server ohne Knoten: nur die ID zählt
  assert.equal(matchServer(inv, "pve1", 555), undefined);
});

test("Raten aus Zählerdifferenzen, Zuordnung, Host-Schnittstellen und Neustart eines Zählers", async () => {
  let dev = NETDEV(1_000_000, 2_000_000);
  const c = new TrafficCollector(30, { readNetDev: async () => dev, inventory, secret: () => "geheim" });
  const t0 = Date.UTC(2026, 10, 12, 10, 0, 0);

  let st = await c.collect(t0); // erste Messung: nur Zählerstände, noch keine Rate
  assert.equal(st.configured, true);
  assert.equal(st.ok, true);
  assert.equal(st.vms, 3);
  assert.equal(st.error, undefined);

  netin += 3_000; // in 30 s
  netout += 1_500;
  dev = NETDEV(1_000_000 + 60_000, 2_000_000 + 30_000);
  st = await c.collect(t0 + 30_000);
  assert.equal(st.ok, true);

  let data = JSON.parse(await fs.readFile(path.join(DATA, "runtime/traffic.json"), "utf8")) as TrafficData;
  const web = data.series.find((s) => s.key === "pve:pve1:100")!;
  assert.equal(web.kind, "proxmox-vm");
  assert.equal(web.label, "web01");
  assert.equal(web.serverId, "s-web");
  assert.equal(web.status, "running");
  assert.equal(web.rxBps, 100); // 3000 B / 30 s
  assert.equal(web.txBps, 50);
  assert.equal(web.rxBytes, 3000);
  assert.equal(web.points.length, 1);
  assert.equal(web.uptimeSec, 3600);
  assert.equal(data.series.find((s) => s.key === "pve:pve1:101")!.serverId, "s-db");
  assert.equal(data.series.find((s) => s.key === "pve:pve1:200")!.serverId, undefined);
  const node = data.series.find((s) => s.key === "pve:node:pve1")!;
  assert.equal(node.kind, "proxmox-node");
  assert.equal(node.points.length, 0);
  assert.equal(node.cpu, 0.12);
  const eth = data.series.find((s) => s.key === "host:eth0")!;
  assert.equal(eth.kind, "host-interface");
  assert.equal(eth.rxBps, 2000); // 60000 B / 30 s
  assert.equal(eth.txBps, 1000);
  assert.ok(!data.series.some((s) => s.key.startsWith("host:lo") || s.key.startsWith("host:docker") || s.key.startsWith("host:veth")));

  // Neustart der VM: Zähler springt zurück -> Differenz = neuer Wert, keine negative Rate
  netin = 900;
  netout = 300;
  await c.collect(t0 + 60_000);
  data = JSON.parse(await fs.readFile(path.join(DATA, "runtime/traffic.json"), "utf8")) as TrafficData;
  const web2 = data.series.find((s) => s.key === "pve:pve1:100")!;
  assert.equal(web2.rxBps, 30); // 900 B / 30 s
  assert.equal(web2.rxBytes, 3900);
  assert.ok(web2.points.every((p) => p.rxBps >= 0 && p.txBps >= 0));
});

test("Verlauf übersteht einen Neustart des Workers (restore)", async () => {
  const c2 = new TrafficCollector(30, { readNetDev: async () => NETDEV(1, 1), inventory, secret: () => "geheim" });
  await c2.collect(Date.UTC(2026, 10, 12, 10, 5, 0));
  const data = JSON.parse(await fs.readFile(path.join(DATA, "runtime/traffic.json"), "utf8")) as TrafficData;
  const web = data.series.find((s) => s.key === "pve:pve1:100")!;
  assert.equal(web.rxBytes, 3900); // Summen bleiben
  assert.equal(web.points.length, 2); // Punkte bleiben; die erste Messung nach dem Neustart erzeugt keinen neuen
});

test("Proxmox-Fehler (401) landen im Status, Host-Daten werden trotzdem erfasst", async () => {
  const c = new TrafficCollector(30, { readNetDev: async () => NETDEV(5, 5), inventory, secret: () => "falsch" });
  const st = await c.collect(Date.UTC(2026, 10, 12, 11, 0, 0));
  assert.equal(st.configured, true);
  assert.equal(st.ok, false);
  assert.match(st.error ?? "", /401/);
  assert.ok(!JSON.stringify(st).includes("falsch"));
  const data = JSON.parse(await fs.readFile(path.join(DATA, "runtime/traffic.json"), "utf8")) as TrafficData;
  assert.ok(data.series.some((s) => s.key === "host:eth0"));
});

test("ohne Geheimnis: nicht konfiguriert mit Hinweis", async () => {
  const c = new TrafficCollector(30, { readNetDev: async () => NETDEV(5, 5), inventory, secret: () => undefined });
  const st = await c.collect(Date.UTC(2026, 10, 12, 11, 1, 0));
  assert.equal(st.configured, false);
  assert.match(st.error ?? "", /PROXMOX_TOKEN_SECRET/);
});

test("Recorder: höchstens 360 Punkte, veraltete Reihen verschwinden", () => {
  const r = new TrafficRecorder();
  const meta = { label: "x", kind: "host-interface" as const };
  for (let i = 0; i < 400; i++) r.sample("host:x", meta, i * 100, i * 100, i * 30_000);
  const d = r.toData(30, 399 * 30_000);
  assert.equal(d.series[0]!.points.length, MAX_POINTS);
  assert.equal(r.toData(30, 399 * 30_000 + 11 * 60_000).series.length, 0); // 11 Minuten ohne Messung
});

test("Import: VMs mit statischen IPs aus Cloud-Init und LXC, DHCP zählt nicht", async () => {
  const vms = await pveImport({ url, tokenId: "root@pam!vsec", secret: "geheim", verifyTls: false });
  assert.deepEqual(vms.map((v) => v.vmid), [100, 101, 200]);
  assert.deepEqual(vms[0]!.ips, ["203.0.113.10", "203.0.113.11"]);
  assert.deepEqual(vms[1]!.ips, []);
  assert.deepEqual(vms[2]!.ips, ["203.0.113.20"]);
  assert.equal(vms[2]!.type, "lxc");
  assert.equal(vms[0]!.name, "web01");
});

test("parseConfigIps: IPv6 und Müll", () => {
  assert.deepEqual(parseConfigIps({ ipconfig0: "ip=192.0.2.5/24,ip6=2001:db8::5/64", ipconfig1: "ip6=auto", foo: "ip=1.1.1.1/32", net0: "virtio=AA" }), ["192.0.2.5", "2001:db8::5"]);
});
