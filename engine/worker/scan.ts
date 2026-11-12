/**
 * Erreichbarkeits-Scan der IP-Verwaltung. Prüft alle Adressen der Subnetze mit scan=true und schreibt
 * runtime/scan.json (ScanData). Eine Adresse gilt als "up", wenn eines davon klappt:
 *   1. Ping (falls das ping-Programm vorhanden und erlaubt ist – sonst still übersprungen)
 *   2. TCP-Verbindung auf 22/80/443/53/3389 (verbunden oder "Verbindung abgelehnt" = der Host antwortet)
 *   3. Eintrag in der ARP-Tabelle des Servers (nur Adressen im selben Netz; liefert auch die MAC-Adresse)
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import { ipv4Addresses } from "../../lib/core/net.ts";
import type { Inventory, ScanData, ScanHost } from "../../lib/core/inventory-model.ts";
import { FILES } from "../../lib/core/runtime-model.ts";
import { nowIso, readJson, writeJsonAtomic } from "../common/data.ts";

export type ProbeResult = { up: boolean; method?: string; rttMs?: number; mac?: string };
export type Probe = (ip: string) => Promise<ProbeResult>;
export type ArpReader = () => Promise<Map<string, string>>;

export const SCAN_PORTS = [22, 80, 443, 53, 3389] as const;
export const MAX_ADDRESSES_PER_RUN = 2048;

/** /proc/net/arp: nur vollständige Einträge (Flags 0x2) mit echter MAC. */
export function parseArp(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const [ip, , flags, mac] = f;
    if (!ip || !flags || !mac) continue;
    if ((parseInt(flags, 16) & 2) === 0) continue;
    if (mac === "00:00:00:00:00:00") continue;
    out.set(ip, mac.toLowerCase());
  }
  return out;
}

export const readArp: ArpReader = async () => {
  try {
    return parseArp(await fs.readFile("/proc/net/arp", "utf8"));
  } catch {
    return new Map();
  }
};

/** Verbunden oder ECONNREFUSED/ECONNRESET: Der Host lebt. Timeout und "unreachable": nicht erreichbar. */
export function tcpProbe(ip: string, ports: readonly number[] = SCAN_PORTS, timeoutMs = 800): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let open = ports.length;
    let done = false;
    const sockets: net.Socket[] = [];
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      for (const s of sockets) s.destroy();
      resolve(r);
    };
    for (const port of ports) {
      const s = net.connect({ host: ip, port });
      sockets.push(s);
      s.setTimeout(timeoutMs);
      const gone = () => {
        if (--open === 0) finish({ up: false });
      };
      s.once("connect", () => finish({ up: true, method: "tcp", rttMs: Date.now() - started }));
      s.once("timeout", () => {
        s.destroy();
        gone();
      });
      s.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") finish({ up: true, method: "tcp", rttMs: Date.now() - started });
        else gone();
      });
    }
    if (ports.length === 0) finish({ up: false });
  });
}

let pingState: "unknown" | "ok" | "unavailable" = "unknown";

/** true/false = Antwort/keine Antwort; null = ping nicht nutzbar (fehlt oder keine Berechtigung). */
export function pingProbe(ip: string): Promise<{ up: boolean; rttMs?: number } | null> {
  if (pingState === "unavailable") return Promise.resolve(null);
  return new Promise((resolve) => {
    const started = Date.now();
    execFile("ping", ["-c", "1", "-W", "1", ip], { timeout: 2500 }, (err, _out, stderr) => {
      if (!err) {
        pingState = "ok";
        return resolve({ up: true, rttMs: Date.now() - started });
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || /operation not permitted|permission denied|socket:/i.test(String(stderr))) {
        if (pingState !== "ok") pingState = "unavailable";
        return resolve(null);
      }
      resolve({ up: false });
    });
  });
}

/** Ping und TCP gleichzeitig; die schnellere positive Antwort zählt. */
export const defaultProbe: Probe = async (ip) => {
  const [ping, tcp] = await Promise.all([pingProbe(ip), tcpProbe(ip)]);
  if (ping?.up) return { up: true, method: "ping", rttMs: ping.rttMs };
  if (tcp.up) return { up: true, method: "tcp", rttMs: tcp.rttMs };
  return { up: false };
};

export type ScanOptions = {
  inventory: Inventory;
  previous?: ScanData | null;
  probe?: Probe;
  arp?: ArpReader;
  concurrency?: number;
  limit?: number;
  now?: () => Date;
};

export type ScanOutcome = { data: ScanData; checked: number; durationMs: number; truncated: boolean };

export async function scanOnce(opts: ScanOptions): Promise<ScanOutcome> {
  const started = Date.now();
  const now = opts.now ?? (() => new Date());
  const probe = opts.probe ?? defaultProbe;
  const limit = opts.limit ?? MAX_ADDRESSES_PER_RUN;
  const conc = Math.max(1, opts.concurrency ?? 48);
  const targets: string[] = [];
  for (const s of opts.inventory.subnets) {
    if (!s.scan) continue;
    for (const a of ipv4Addresses(s.cidr)) if (a.kind === "host" && !targets.includes(a.ip)) targets.push(a.ip);
  }
  const truncated = targets.length > limit;
  const list = targets.slice(0, limit);

  const results = new Map<string, ProbeResult>();
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const ip = list[next++]!;
      try {
        results.set(ip, await probe(ip));
      } catch {
        results.set(ip, { up: false });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));

  // ARP erst NACH den Proben lesen: Die Proben haben die Einträge aufgefrischt (veraltete Einträge fallen dabei heraus).
  const arp = opts.arp ? await opts.arp() : await readArp();
  const stamp = now().toISOString();
  const hosts: Record<string, ScanHost> = {};
  for (const ip of list) {
    const r = results.get(ip) ?? { up: false };
    const mac = r.mac ?? arp.get(ip);
    const up = r.up || (!!mac && arp.has(ip));
    const prev = opts.previous?.hosts[ip];
    hosts[ip] = {
      up,
      lastChecked: stamp,
      lastUp: up ? stamp : prev?.lastUp,
      mac: mac ?? (up ? undefined : prev?.mac),
      method: up ? (r.up ? r.method : "arp") : undefined,
      rttMs: up ? r.rttMs : undefined,
    };
  }
  return { data: { updatedAt: stamp, hosts }, checked: list.length, durationMs: Date.now() - started, truncated };
}

export type ScanSummary = { lastRun?: string; hosts: number; durationMs?: number; error?: string };

/** Führt einen Scan aus und schreibt runtime/scan.json. Wirft nie. */
export async function runScan(inventory: Inventory, deps: Partial<Pick<ScanOptions, "probe" | "arp" | "concurrency" | "limit">> = {}): Promise<ScanSummary> {
  try {
    const previous = await readJson<ScanData | null>(FILES.scan, null);
    const out = await scanOnce({ inventory, previous, ...deps });
    await writeJsonAtomic(FILES.scan, out.data);
    return {
      lastRun: nowIso(),
      hosts: out.checked,
      durationMs: out.durationMs,
      error: out.truncated ? `Es wurden nur die ersten ${out.checked} Adressen geprüft (Obergrenze je Lauf).` : undefined,
    };
  } catch (e) {
    return { lastRun: nowIso(), hosts: 0, error: `Scan fehlgeschlagen: ${(e as Error).message}` };
  }
}
