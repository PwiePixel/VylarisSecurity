import assert from "node:assert/strict";
import { test } from "node:test";
import { cidrContains, formatIPv6, ipv4Addresses, isValidFqdn, normalizeIp, parseCidr, parseIPv6, ptrName } from "../lib/core/net.ts";
import { checkZoneRecords, compileZones, defaultDnsState, newZone, relativeName, validateRecord, validateSettings } from "../lib/core/dns-model.ts";
import { buildIpRows, defaultInventory, nextFree, sanitizeInventory, serverPrimaryIp, setIpEntry, summarizeRows, validateServer, validateSubnet } from "../lib/core/inventory-model.ts";
import { matchRoute, resolveUpstream, sanitizeProxyState, validateRoute } from "../lib/core/proxy-model.ts";

test("IP-Adressen und Netze", () => {
  assert.equal(normalizeIp("2001:0DB8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(normalizeIp("999.1.1.1"), null);
  assert.equal(formatIPv6(parseIPv6("::ffff:1.2.3.4")!), "::ffff:102:304");
  assert.equal(parseCidr("203.0.113.9/28")!.prefix, 28);
  assert.equal(cidrContains("203.0.113.0/28", "203.0.113.15"), true);
  assert.equal(cidrContains("203.0.113.0/28", "203.0.113.16"), false);
  assert.equal(cidrContains("10.0.0.0/8", "2001:db8::1"), false);
  assert.equal(ptrName("203.0.113.5"), "5.113.0.203.in-addr.arpa");
  const a = ipv4Addresses("203.0.113.0/29");
  assert.equal(a.length, 8);
  assert.equal(a[0]!.kind, "network");
  assert.equal(a[7]!.kind, "broadcast");
  assert.equal(ipv4Addresses("10.0.0.0/8").length, 0, "zu große Netze werden nicht aufgelistet");
  assert.equal(isValidFqdn("_dmarc.example.com"), true);
  assert.equal(isValidFqdn("-bad.example.com"), false);
});

test("DNS: Einträge prüfen", () => {
  const z = newZone("example.com", "authoritative");
  assert.equal(relativeName("example.com", "www.example.com"), "www");
  assert.equal(relativeName("example.com", "example.com"), "@");
  const ok = validateRecord(z, { name: "www", type: "A", value: "203.0.113.5", ttl: 120 });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.data.ttl, 120);
  assert.equal(validateRecord(z, { name: "www", type: "A", value: "nope" }).ok, false);
  assert.equal(validateRecord(z, { name: "x", type: "MX", value: "mail.example.com" }).ok, false, "MX braucht Priorität");
  assert.equal(validateRecord(z, { name: "x", type: "A", value: "1.2.3.4", visibility: "internal", protect: "on" }).ok, false);
  const cf = validateRecord(z, { name: "@", type: "CNAME", value: "edge.example.net" });
  const a = validateRecord(z, { name: "@", type: "A", value: "1.2.3.4" });
  assert.ok(cf.ok && a.ok);
  assert.ok(checkZoneRecords([(cf as any).data, (a as any).data]).length > 0, "CNAME neben A ist ein Fehler");
});

test("DNS: Einstellungen", () => {
  const ok = validateSettings({ ns1: "ns1.vylaris.it", ns1v4: "203.0.113.2", ns2: "ns2.vylaris.it", internalNets: "10.0.0.0/8 192.168.0.0/16", rateLimitPerSecond: "40" });
  assert.equal(ok.ok, true);
  assert.equal(validateSettings({ ns1: "ns1.vylaris.it", edgeEnabled: "on", edgeTarget: "" }).ok, false);
  assert.equal(validateSettings({ ns1: "", internalNets: "" }).ok, false);
  assert.equal(validateSettings({ ns1: "ns1.x.de", internalNets: "kaputt" }).ok, false);
});

test("Server mit mehreren IPs, Domainname und DNS-Übersetzung", () => {
  let inv = defaultInventory();
  const s = validateServer({ name: "web01", vmid: 101, node: "pve1" });
  assert.ok(s.ok);
  inv = { ...inv, servers: [(s as any).data] };
  const id = inv.servers[0]!.id;
  inv = setIpEntry(inv, { ip: "203.0.113.12", status: "assigned", serverId: id });
  inv = setIpEntry(inv, { ip: "203.0.113.11", status: "assigned", serverId: id });
  assert.equal(serverPrimaryIp(inv, inv.servers[0]!), "203.0.113.11", "erste IPv4 nach Sortierung");
  assert.equal(inv.servers[0]!.vmid, 101, "Zahlen bleiben erhalten");

  const dns = defaultDnsState();
  const zone = newZone("vylaris.it", "authoritative");
  const pub = validateRecord(zone, { name: "shop", type: "A", value: "203.0.113.50", protect: "on" });
  zone.records.push((pub as any).data);
  dns.zones.push(zone);
  dns.settings.edge = { enabled: true, target: "edge.vylaris.eu" };
  dns.settings.nameservers = [{ host: "ns1.vylaris.it", ipv4: "203.0.113.2" }, { host: "ns2.vylaris.it" }];
  const { zones, warnings } = compileZones(dns, inv);
  assert.deepEqual(warnings, []);
  const rrs = zones[0]!.rrs;
  const web = rrs.filter((r) => r.name === "web01.server.vylaris.it");
  assert.equal(web.length, 2);
  assert.ok(web.every((r) => r.internal), "Server-Namen sind standardmäßig nur intern sichtbar");
  const shop = rrs.filter((r) => r.name === "shop.vylaris.it");
  assert.equal(shop.length, 1);
  assert.deepEqual(shop[0]!.data, { type: "CNAME", target: "edge.vylaris.eu" }, "geschützter Eintrag zeigt auf Cloudflare, nicht auf die IP");
  assert.ok(rrs.some((r) => r.name === "ns1.vylaris.it" && r.data.type === "A"), "Glue für Nameserver in der Zone");
  assert.equal(rrs.filter((r) => r.data.type === "NS" && r.name === "vylaris.it").length, 2);

  // ohne passende Zone: Warnung statt Fehler
  assert.equal(compileZones(defaultDnsState(), inv).warnings.length, 1);
});

test("IP-Verwaltung: frei, zugewiesen, Konflikte", () => {
  let inv = defaultInventory();
  const sn = validateSubnet({ name: "Block", cidr: "203.0.113.0/29", gateway: "203.0.113.1", scan: "on" });
  assert.ok(sn.ok);
  inv = { ...inv, subnets: [(sn as any).data] };
  const sv = validateServer({ name: "db01" });
  inv = { ...inv, servers: [(sv as any).data] };
  inv = setIpEntry(inv, { ip: "203.0.113.2", status: "assigned", serverId: inv.servers[0]!.id });
  inv = setIpEntry(inv, { ip: "203.0.113.3", status: "reserved" });
  const now = new Date().toISOString();
  const scan = { hosts: { "203.0.113.2": { up: false, lastChecked: now }, "203.0.113.4": { up: true, lastChecked: now }, "203.0.113.5": { up: false, lastChecked: now } } };
  const rows = buildIpRows(inv, inv.subnets[0]!, scan);
  const by = Object.fromEntries(rows.map((r) => [r.ip, r]));
  assert.equal(by["203.0.113.0"]!.kind, "network");
  assert.equal(by["203.0.113.2"]!.alert, "assigned-but-down");
  assert.equal(by["203.0.113.4"]!.alert, "free-but-up");
  assert.equal(by["203.0.113.5"]!.alert, undefined);
  const sum = summarizeRows(rows);
  assert.equal(sum.usable, 6);
  assert.deepEqual([sum.assigned, sum.reserved, sum.free], [1, 1, 3], "Gateway zählt nicht als frei");
  assert.deepEqual(nextFree(inv, inv.subnets[0]!, scan, 2), ["203.0.113.5", "203.0.113.6"], "erreichbare „freie“ Adressen werden nicht vorgeschlagen");
  assert.equal(validateSubnet({ name: "x", cidr: "10.0.0.0/8" }).ok, false);
  assert.equal(validateSubnet({ name: "x", cidr: "203.0.113.0/29", gateway: "10.0.0.1" }).ok, false);
});

test("Proxy: Routen, Wildcards, Ziel über Servernamen", () => {
  let inv = defaultInventory();
  inv = { ...inv, servers: [(validateServer({ name: "web01" }) as any).data] };
  const id = inv.servers[0]!.id;
  inv = setIpEntry(inv, { ip: "10.0.0.21", status: "assigned", serverId: id });
  const r1 = validateRoute({ host: "Shop.Example.com", target: `server:${id}`, port: "8080" }, inv);
  const r2 = validateRoute({ host: "*.example.com", target: "10.0.0.99", port: "80" }, inv);
  assert.ok(r1.ok && r2.ok);
  const routes = [(r1 as any).data, (r2 as any).data];
  assert.equal(matchRoute(routes, "shop.example.com:443")!.host, "shop.example.com");
  assert.equal(matchRoute(routes, "blog.example.com")!.host, "*.example.com");
  assert.equal(matchRoute(routes, "example.com"), undefined);
  assert.deepEqual(resolveUpstream(routes[0], inv), { host: "10.0.0.21", port: 8080, scheme: "http", serverName: "web01" });
  assert.equal(validateRoute({ host: "x.example.com", target: "server:gibtsnicht", port: "80" }, inv).ok, false);
  assert.equal(validateRoute({ host: "x.example.com", target: "h.example.com", port: "0" }, inv).ok, false);
  assert.equal(validateRoute({ host: "x.example.com", target: "h.example.com", port: "80", allowIps: "kaputt" }, inv).ok, false);
  // gespeicherter Stand: Routen auf gelöschte Server verschwinden
  const state = sanitizeProxyState({ routes: [{ id: "a", host: "a.example.com", upstream: { type: "server", serverId: "weg", port: 80, scheme: "http" } }] }, inv);
  assert.equal(state.routes.length, 0);
  assert.equal(sanitizeInventory({ servers: [{ name: "web01", vmid: 150 }] }).servers[0]!.vmid, 150);
});
