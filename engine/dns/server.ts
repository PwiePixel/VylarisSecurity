/**
 * Autoritativer DNS-Server (UDP + TCP). Beantwortet nur Zonen aus dns.json (plus Server-Namen und PTR aus inventory.json),
 * kein rekursiver Resolver: Fremde Zonen -> REFUSED.
 *
 * Lädt die Konfiguration bei Änderung neu (atomarer Austausch; bei Fehlern bleibt der alte Stand),
 * schreibt alle 10 s Statistik und Herzschlag nach runtime/dns.json.
 */
import dgram from "node:dgram";
import { promises as fs } from "node:fs";
import net from "node:net";
import { compileZones, sanitizeDnsState, defaultDnsState } from "../../lib/core/dns-model.ts";
import { defaultInventory, sanitizeInventory } from "../../lib/core/inventory-model.ts";
import { isIPv6, parseCidr, parseIp, type Cidr } from "../../lib/core/net.ts";
import { FILES, type DnsRuntime } from "../../lib/core/runtime-model.ts";
import { abs, bumpMinute, log, nowIso, watchFiles, writeJsonAtomic } from "../common/data.ts";
import type { RR } from "../../lib/core/dns-model.ts";
import { createAliasResolver, DEFAULT_UPSTREAM, type AliasResolver } from "./alias.ts";
import { decodeMessage, emptyMessage, encodeMessage, QTYPE, RCODE, typeName, type Message, type WireData, type WireRR } from "./wire.ts";
import { buildIndex, countRecords, findZone, lookup, type AliasJob, type ZoneIndex } from "./zones.ts";

export type DnsServerOptions = {
  /** 0 = freier Port (Tests). Standard 5353. */
  port?: number;
  /** Standard "::" (dual-stack, sonst 0.0.0.0) */
  bind?: string;
  upstream?: string[];
  resolver?: AliasResolver;
  statsIntervalMs?: number;
  pollMs?: number;
  writeStats?: boolean;
};

export type DnsServerHandle = {
  port: number;
  reload(): Promise<void>;
  stop(): Promise<void>;
  stats(): DnsRuntime;
  writeStats(): Promise<void>;
};

const MAX_UDP = 1232;
const MAX_TCP_CONNECTIONS = 200;
const TCP_IDLE_MS = 10_000;
const MAX_QUERIES_PER_TCP = 100;
const MAX_BUCKETS = 50_000;
const MAX_TYPE_KEYS = 50;

/* --------------------------------------------------------------- Hilfen */
type CompiledNet = { family: 4 | 6; base: bigint; hostBits: bigint };
const compileNets = (nets: string[]): CompiledNet[] =>
  nets.flatMap((n) => {
    const c: Cidr | null = n.includes("/") ? parseCidr(n) : (() => {
      const p = parseIp(n);
      return p ? { family: p.family, base: p.value, prefix: p.family === 4 ? 32 : 128 } : null;
    })();
    return c ? [{ family: c.family, base: c.base, hostBits: BigInt((c.family === 4 ? 32 : 128) - c.prefix) }] : [];
  });

function isInternalIp(nets: CompiledNet[], ip: string): boolean {
  const p = parseIp(ip);
  return !!p && nets.some((n) => n.family === p.family && p.value >> n.hostBits === n.base >> n.hostBits);
}

/** "::ffff:1.2.3.4" -> "1.2.3.4"; Zonenkennung entfernen */
function normalizeClient(addr: string): string {
  const a = addr.replace(/%.*$/, "");
  return a.toLowerCase().startsWith("::ffff:") && a.includes(".") ? a.slice(7) : a;
}

/** IPv4 einzeln, IPv6 je /64 */
function rateKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const v = parseIp(ip);
  return v ? `6:${(v.value >> 64n).toString(16)}` : ip;
}

class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  /** Token-Bucket: `rate` pro Sekunde, Burst = 2 x rate. Rückgabe false = verwerfen. */
  allow(key: string, rate: number, now: number): boolean {
    if (rate <= 0) return true;
    const cap = rate * 2;
    const b = this.buckets.get(key) ?? { tokens: cap, last: now };
    b.tokens = Math.min(cap, b.tokens + ((now - b.last) / 1000) * rate);
    b.last = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.delete(key); // ans Ende der Reihenfolge (LRU)
    this.buckets.set(key, b);
    while (this.buckets.size > MAX_BUCKETS) this.buckets.delete(this.buckets.keys().next().value as string);
    return ok;
  }
  /** Entfernt Einträge, die seit über 60 s ruhen. */
  sweep(now: number): void {
    for (const [k, b] of this.buckets) {
      if (now - b.last <= 60_000) break;
      this.buckets.delete(k);
    }
  }
}

type State = { index: ZoneIndex; nets: CompiledNet[]; rate: number; warnings: string[]; records: number };

const emptyTotals = (): DnsRuntime["totals"] => ({ queries: 0, udp: 0, tcp: 0, noerror: 0, nxdomain: 0, refused: 0, servfail: 0, formerr: 0, truncated: 0, rateLimited: 0, internalViews: 0 });

async function readConfig(rel: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(abs(rel), "utf8")) as unknown;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // noch keine Datei: Standardwerte
    throw e; // defekt: Aufrufer behält den alten Stand
  }
}

const toWire = (rrs: RR[]): WireRR[] =>
  rrs.filter((r) => r.data.type !== "ALIAS").map((r) => ({ name: r.name, cls: 1, ttl: r.ttl, data: r.data as WireData }));

/* ----------------------------------------------------------------- Start */
export async function startDnsServer(opts: DnsServerOptions = {}): Promise<DnsServerHandle> {
  const resolver = opts.resolver ?? createAliasResolver({ upstream: opts.upstream ?? DEFAULT_UPSTREAM });
  const limiter = new RateLimiter();
  const startedAt = nowIso();
  const totals = emptyTotals();
  const byType: Record<string, number> = {};
  const byZone: Record<string, number> = {};
  const perMinute: DnsRuntime["perMinute"] = [];
  let state: State = { index: new Map(), nets: compileNets(defaultDnsState().settings.internalNets), rate: 0, warnings: [], records: 0 };

  async function reload(): Promise<void> {
    try {
      const [rawDns, rawInv] = await Promise.all([readConfig(FILES.dns), readConfig(FILES.inventory)]);
      const dns = rawDns === undefined ? defaultDnsState() : sanitizeDnsState(rawDns);
      const inv = rawInv === undefined ? defaultInventory() : sanitizeInventory(rawInv);
      const { zones, warnings } = compileZones(dns, inv);
      const index = buildIndex(zones);
      state = { index, nets: compileNets(dns.settings.internalNets), rate: dns.settings.rateLimitPerSecond, warnings, records: countRecords(index) };
      log("dns", `Konfiguration geladen: ${index.size} Zone(n), ${state.records} Einträge${warnings.length ? `, ${warnings.length} Hinweis(e)` : ""}`);
    } catch (e) {
      log("dns", `Neuladen fehlgeschlagen, der alte Stand bleibt aktiv: ${(e as Error).message}`);
    }
  }
  await reload();

  /* ------------------------------------------------------ Anfrage beantworten */
  async function aliasAddresses(job: AliasJob): Promise<{ addresses: string[]; ttl: number }> {
    const lz = findZone(state.index, job.target);
    if (lz) {
      // Ziel liegt in einer eigenen Zone: direkt beantworten statt über das Internet
      const r = lookup(lz, job.target, job.qtype, false);
      if (!r.alias) {
        const rrs = r.answers.filter((a) => a.data.type === job.qtype);
        return { addresses: rrs.map((a) => (a.data as { address: string }).address), ttl: rrs.length ? Math.min(...rrs.map((a) => a.ttl)) : 60 };
      }
    }
    return resolver.resolve(job.target, job.qtype === "A" ? 4 : 6);
  }

  async function handle(buf: Buffer, ip: string, transport: "udp" | "tcp"): Promise<Buffer | null> {
    let msg: Message;
    try {
      msg = decodeMessage(buf);
    } catch {
      // Unlesbar: Antwort nur, wenn es nach einer Anfrage aussieht (QR nicht gesetzt)
      if (buf.length < 12 || (buf[2]! & 0x80) !== 0) return null;
      totals.queries++;
      totals.formerr++;
      const out = Buffer.alloc(12);
      out.writeUInt16BE(buf.readUInt16BE(0), 0);
      out.writeUInt16BE(0x8000 | ((buf[2]! & 0x78) << 8) | RCODE.FORMERR, 2);
      return out;
    }
    if (msg.qr) return null; // nie auf Antworten antworten

    totals.queries++;
    totals[transport]++;
    bumpMinute(perMinute, (t) => ({ t, q: 0 }), (m) => void m.q++);

    const resp = emptyMessage(msg.id);
    resp.qr = true;
    resp.opcode = msg.opcode;
    resp.rd = msg.rd;
    resp.cd = msg.cd;
    resp.questions = msg.questions.slice(0, 1);
    if (msg.edns) resp.edns = { udpSize: MAX_UDP, extRcode: 0, version: 0, flags: 0 };
    let zoneName: string | undefined;
    let qname = "";

    const q = msg.questions[0];
    if (msg.opcode !== 0) resp.rcode = RCODE.NOTIMP;
    else if (msg.edns && msg.edns.version > 0) {
      resp.rcode = 0;
      resp.edns!.extRcode = 1; // BADVERS (16)
      resp.questions = msg.questions.slice(0, 1);
    } else if (msg.questions.length !== 1 || !q) resp.rcode = RCODE.FORMERR;
    else if (q.cls !== 1 || q.type === QTYPE.AXFR || q.type === QTYPE.IXFR || q.type === QTYPE.OPT) resp.rcode = q.type === QTYPE.OPT ? RCODE.FORMERR : RCODE.REFUSED;
    else {
      qname = q.name;
      const zone = findZone(state.index, q.name);
      if (!zone) resp.rcode = RCODE.REFUSED;
      else {
        zoneName = zone.name;
        const internal = isInternalIp(state.nets, ip);
        if (internal) totals.internalViews++;
        const tname = typeName(q.type);
        const r = lookup(zone, q.name, tname, internal);
        let { rcode, answers, authority } = r;
        if (r.alias) {
          try {
            const res = await aliasAddresses(r.alias);
            if (res.addresses.length > 0) {
              const ttl = Math.max(1, Math.min(r.alias.ttl, res.ttl));
              const synth: RR[] = res.addresses.map((address) => ({ name: r.alias!.owner, ttl, internal: false, data: { type: r.alias!.qtype, address } }));
              answers = [...answers, ...synth];
              authority = [];
            }
          } catch (e) {
            log("dns", `ALIAS ${r.alias.target} nicht auflösbar: ${(e as Error).message}`);
            rcode = RCODE.SERVFAIL;
            answers = [];
            authority = [];
          }
        }
        resp.rcode = rcode;
        resp.aa = r.aa;
        resp.answers = toWire(answers);
        resp.authority = toWire(authority);
        resp.additional = toWire(r.additional);
      }
    }

    // Größe begrenzen (nur UDP): zu groß -> TC mit leerem Antwortteil, der Client wiederholt per TCP
    let out: Buffer;
    try {
      out = encodeMessage(resp);
      if (transport === "udp") {
        const limit = msg.edns ? Math.max(512, Math.min(msg.edns.udpSize, MAX_UDP)) : 512;
        if (out.length > limit) {
          resp.tc = true;
          resp.answers = [];
          resp.authority = [];
          resp.additional = [];
          out = encodeMessage(resp);
          totals.truncated++;
        }
      }
    } catch (e) {
      log("dns", `Antwort nicht kodierbar: ${(e as Error).message}`);
      resp.rcode = RCODE.SERVFAIL;
      resp.answers = resp.authority = resp.additional = [];
      resp.aa = false;
      out = encodeMessage(resp);
    }

    switch (resp.rcode) {
      case RCODE.NOERROR: totals.noerror++; break;
      case RCODE.NXDOMAIN: totals.nxdomain++; break;
      case RCODE.REFUSED: totals.refused++; break;
      case RCODE.SERVFAIL: totals.servfail++; break;
      case RCODE.FORMERR: totals.formerr++; break;
    }
    if (zoneName && q) {
      byZone[zoneName] = (byZone[zoneName] ?? 0) + 1;
      const tn = typeName(q.type);
      if (tn in byType || Object.keys(byType).length < MAX_TYPE_KEYS) byType[tn] = (byType[tn] ?? 0) + 1;
      else byType["andere"] = (byType["andere"] ?? 0) + 1;
    }
    void qname;
    return out;
  }

  const allowed = (ip: string): boolean => {
    if (state.rate <= 0 || isInternalIp(state.nets, ip)) return true;
    if (limiter.allow(rateKey(ip), state.rate, Date.now())) return true;
    totals.rateLimited++;
    return false;
  };

  /* ------------------------------------------------------------ Sockets */
  const host = opts.bind ?? "::";
  const wantedPort = opts.port ?? 5353;

  async function bindUdp(h: string, port: number): Promise<{ sock: dgram.Socket; host: string }> {
    const attempt = (type: "udp4" | "udp6", addr: string) =>
      new Promise<dgram.Socket>((resolve, reject) => {
        const s = dgram.createSocket(type === "udp6" ? { type, ipv6Only: false } : { type });
        s.once("error", (e) => {
          s.close();
          reject(e);
        });
        s.bind(port, addr, () => {
          s.removeAllListeners("error");
          resolve(s);
        });
      });
    if (h === "::" || isIPv6(h)) {
      try {
        return { sock: await attempt("udp6", h), host: h };
      } catch (e) {
        if (h !== "::") throw e;
        log("dns", `IPv6 nicht verfügbar (${(e as Error).message}), nutze IPv4`);
        return { sock: await attempt("udp4", "0.0.0.0"), host: "0.0.0.0" };
      }
    }
    return { sock: await attempt("udp4", h), host: h };
  }

  const tcpConns = new Set<net.Socket>();
  function bindTcp(h: string, port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.maxConnections = MAX_TCP_CONNECTIONS;
      srv.on("connection", onTcpConnection);
      srv.once("error", reject);
      srv.listen({ port, host: h, ipv6Only: false }, () => {
        srv.removeAllListeners("error");
        srv.on("error", (e) => log("dns", `TCP-Fehler: ${e.message}`));
        resolve(srv);
      });
    });
  }

  function onTcpConnection(sock: net.Socket): void {
    tcpConns.add(sock);
    sock.setTimeout(TCP_IDLE_MS, () => sock.destroy());
    sock.on("error", () => sock.destroy());
    sock.on("close", () => tcpConns.delete(sock));
    const ip = normalizeClient(sock.remoteAddress ?? "");
    let acc: Buffer = Buffer.alloc(0);
    let chain: Promise<void> = Promise.resolve();
    let served = 0;
    sock.on("data", (d: Buffer) => {
      acc = acc.length ? Buffer.concat([acc, d]) : d;
      while (acc.length >= 2) {
        const len = acc.readUInt16BE(0);
        if (len < 12) return void sock.destroy();
        if (acc.length < 2 + len) break;
        const frame = Buffer.from(acc.subarray(2, 2 + len));
        acc = acc.subarray(2 + len);
        if (++served > MAX_QUERIES_PER_TCP || !allowed(ip)) return void sock.destroy();
        chain = chain
          .then(async () => {
            const out = await handle(frame, ip, "tcp");
            if (out && !sock.destroyed) {
              const head = Buffer.alloc(2);
              head.writeUInt16BE(out.length);
              sock.write(Buffer.concat([head, out]));
            }
          })
          .catch((e) => log("dns", `TCP-Anfrage fehlgeschlagen: ${(e as Error).message}`));
      }
    });
  }

  let udp: dgram.Socket | undefined;
  let tcp: net.Server | undefined;
  let port = wantedPort;
  for (let attempt = 0; ; attempt++) {
    const u = await bindUdp(host, wantedPort);
    port = (u.sock.address() as { port: number }).port;
    try {
      tcp = await bindTcp(u.host, port);
      udp = u.sock;
      break;
    } catch (e) {
      u.sock.close();
      if (wantedPort !== 0 || attempt >= 5) throw e; // bei Port 0: anderen freien Port versuchen
    }
  }
  udp!.on("error", (e) => log("dns", `UDP-Fehler: ${e.message}`));
  udp!.on("message", (buf, rinfo) => {
    const ip = normalizeClient(rinfo.address);
    if (!allowed(ip)) return; // still verwerfen
    handle(buf, ip, "udp")
      .then((out) => {
        if (out) udp!.send(out, rinfo.port, rinfo.address);
      })
      .catch((e) => log("dns", `UDP-Anfrage fehlgeschlagen: ${(e as Error).message}`));
  });
  log("dns", `Lauscht auf ${host.includes(":") ? `[${host}]` : host}:${port} (UDP und TCP)`);

  /* ------------------------------------------------- Statistik und Neuladen */
  const snapshot = (): DnsRuntime => ({
    updatedAt: nowIso(),
    startedAt,
    version: 1,
    zones: state.index.size,
    records: state.records,
    warnings: state.warnings,
    totals: { ...totals },
    byType: { ...byType },
    byZone: { ...byZone },
    perMinute: perMinute.map((m) => ({ ...m })),
  });
  const writeStats = async (): Promise<void> => {
    try {
      await writeJsonAtomic(FILES.dnsRuntime, snapshot());
    } catch (e) {
      log("dns", `Statistik nicht schreibbar: ${(e as Error).message}`);
    }
  };
  const statsTimer = setInterval(() => {
    limiter.sweep(Date.now());
    void writeStats();
  }, opts.statsIntervalMs ?? 10_000);
  statsTimer.unref();
  const stopWatching = watchFiles([FILES.dns, FILES.inventory], reload, opts.pollMs ?? 2000);
  if (opts.writeStats !== false) await writeStats();

  let stopped = false;
  return {
    port,
    reload,
    stats: snapshot,
    writeStats,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(statsTimer);
      stopWatching();
      if (opts.writeStats !== false) await writeStats();
      for (const s of tcpConns) s.destroy();
      await Promise.all([
        new Promise<void>((r) => udp!.close(() => r())),
        new Promise<void>((r) => tcp!.close(() => r())),
      ]);
    },
  };
}
