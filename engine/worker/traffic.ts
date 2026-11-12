/**
 * Netzwerkverkehr: Messpunkte aus /proc/net/dev (Schnittstellen des Servers, auf dem der Worker läuft –
 * wegen host-Netzwerk der echte Host) und aus Proxmox (netin/netout je VM). Ergebnis: runtime/traffic.json.
 */
import { promises as fs } from "node:fs";
import type { Inventory } from "../../lib/core/inventory-model.ts";
import { FILES } from "../../lib/core/runtime-model.ts";
import type { TrafficData, TrafficPoint, TrafficSeries, WorkerRuntime } from "../../lib/core/runtime-model.ts";
import { loadIntegrations, loadInventory, nowIso, readJson, writeJsonAtomic } from "../common/data.ts";
import { matchServer, pveConfig, pveMessage, pveResources, type PveConfig, type PveResource } from "./proxmox.ts";

export const MAX_POINTS = 360;
const STALE_MS = 10 * 60_000;

type Meta = Pick<TrafficSeries, "label" | "kind"> & Partial<Pick<TrafficSeries, "serverId" | "status" | "cpu" | "memBytes" | "uptimeSec">>;
type State = Meta & { key: string; lastT?: number; lastRx?: number; lastTx?: number; rxBytes: number; txBytes: number; rxBps: number; txBps: number; points: TrafficPoint[]; seenAt: number; noPoints?: boolean };

/** /proc/net/dev -> Schnittstelle -> Zähler. lo, docker*, veth*, br-* werden ausgelassen. */
export function parseProcNetDev(text: string): Map<string, { rx: number; tx: number }> {
  const out = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split("\n").slice(2)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    if (!name || name === "lo" || /^(docker|veth|br-)/.test(name)) continue;
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (f.length < 9 || f.some((n) => !Number.isFinite(n))) continue;
    out.set(name, { rx: f[0]!, tx: f[8]! });
  }
  return out;
}

export class TrafficRecorder {
  private readonly series = new Map<string, State>();

  /** Verlauf und Summen aus einer früheren traffic.json übernehmen (Zählerstände nicht – die gelten nach einem Neustart nicht mehr). */
  restore(data: TrafficData | null, now = Date.now()): void {
    for (const s of data?.series ?? []) {
      if (!s || typeof s.key !== "string" || !Array.isArray(s.points)) continue;
      this.series.set(s.key, { ...s, points: s.points.slice(-MAX_POINTS), seenAt: now });
    }
  }

  /** Neuer Zählerstand. Negative Differenz = Zähler neu gestartet (Neustart der VM/des Servers). */
  sample(key: string, meta: Meta, rx: number, tx: number, nowMs: number, opts: { noPoints?: boolean } = {}): void {
    let s = this.series.get(key);
    if (!s) {
      s = { key, ...meta, rxBytes: 0, txBytes: 0, rxBps: 0, txBps: 0, points: [], seenAt: nowMs };
      this.series.set(key, s);
    }
    Object.assign(s, meta);
    s.noPoints = opts.noPoints;
    s.seenAt = nowMs;
    if (s.lastT !== undefined && s.lastRx !== undefined && s.lastTx !== undefined) {
      const dt = (nowMs - s.lastT) / 1000;
      if (dt < 1) return; // zu kurz nach der letzten Messung: Zählerstand behalten, nichts verlieren
      {
        const drx = rx >= s.lastRx ? rx - s.lastRx : rx;
        const dtx = tx >= s.lastTx ? tx - s.lastTx : tx;
        s.rxBytes += drx;
        s.txBytes += dtx;
        s.rxBps = Math.round(drx / dt);
        s.txBps = Math.round(dtx / dt);
        if (!opts.noPoints) {
          s.points.push({ t: nowMs, rxBps: s.rxBps, txBps: s.txBps });
          if (s.points.length > MAX_POINTS) s.points.splice(0, s.points.length - MAX_POINTS);
        }
        s.lastT = nowMs;
      }
    } else {
      s.lastT = nowMs;
    }
    s.lastRx = rx;
    s.lastTx = tx;
  }

  toData(intervalSec: number, nowMs = Date.now()): TrafficData {
    for (const [k, s] of this.series) if (nowMs - s.seenAt > STALE_MS) this.series.delete(k);
    const series: TrafficSeries[] = [...this.series.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label, "de", { numeric: true }))
      .map((s) => ({
        key: s.key,
        label: s.label,
        kind: s.kind,
        serverId: s.serverId,
        rxBytes: s.rxBytes,
        txBytes: s.txBytes,
        rxBps: s.rxBps,
        txBps: s.txBps,
        status: s.status,
        cpu: s.cpu,
        memBytes: s.memBytes,
        uptimeSec: s.uptimeSec,
        points: s.points,
      }));
    return { updatedAt: new Date(nowMs).toISOString(), intervalSec, series };
  }
}

export type TrafficDeps = {
  readNetDev?: () => Promise<string>;
  pveFetch?: (cfg: PveConfig) => Promise<PveResource[]>;
  inventory?: () => Promise<Inventory>;
  secret?: () => string | undefined;
};

export class TrafficCollector {
  readonly recorder = new TrafficRecorder();
  private restored = false;

  private readonly intervalSec: number;
  private readonly deps: TrafficDeps;

  constructor(intervalSec: number, deps: TrafficDeps = {}) {
    this.intervalSec = intervalSec;
    this.deps = deps;
  }

  /** Eine Messrunde: Host-Schnittstellen + Proxmox, schreibt runtime/traffic.json. Wirft nie. */
  async collect(nowMs = Date.now()): Promise<WorkerRuntime["proxmox"]> {
    if (!this.restored) {
      this.restored = true;
      this.recorder.restore(await readJson<TrafficData | null>(FILES.traffic, null), nowMs);
    }
    // 1. Host
    try {
      const text = await (this.deps.readNetDev ?? (() => fs.readFile("/proc/net/dev", "utf8")))();
      for (const [name, c] of parseProcNetDev(text)) this.recorder.sample(`host:${name}`, { label: name, kind: "host-interface" }, c.rx, c.tx, nowMs);
    } catch {
      /* kein /proc/net/dev (z. B. macOS): nur Proxmox-Daten */
    }
    // 2. Proxmox
    const status: WorkerRuntime["proxmox"] = { configured: false, vms: 0 };
    try {
      const integ = await loadIntegrations();
      const { cfg, error } = pveConfig(integ, (this.deps.secret ?? (() => process.env.PROXMOX_TOKEN_SECRET?.trim() || undefined))());
      if (error) {
        status.error = error;
      } else if (cfg) {
        status.configured = true;
        const inv = await (this.deps.inventory ?? loadInventory)();
        const res = await (this.deps.pveFetch ?? pveResources)(cfg);
        for (const r of res) {
          if (r.type === "node" && r.node) {
            this.recorder.sample(
              `pve:node:${r.node}`,
              { label: r.node, kind: "proxmox-node", status: r.status, cpu: r.cpu, memBytes: r.mem, uptimeSec: r.uptime },
              0,
              0,
              nowMs,
              { noPoints: true },
            );
          } else if ((r.type === "qemu" || r.type === "lxc") && r.node && typeof r.vmid === "number") {
            status.vms++;
            const srv = matchServer(inv, r.node, r.vmid);
            this.recorder.sample(
              `pve:${r.node}:${r.vmid}`,
              { label: r.name ?? `vm${r.vmid}`, kind: "proxmox-vm", serverId: srv?.id, status: r.status, cpu: r.cpu, memBytes: r.mem, uptimeSec: r.uptime },
              Number(r.netin ?? 0),
              Number(r.netout ?? 0),
              nowMs,
            );
          }
        }
        status.ok = true;
      }
    } catch (e) {
      status.ok = false;
      status.error = pveMessage(e);
    }
    status.lastRun = nowIso();
    try {
      await writeJsonAtomic(FILES.traffic, this.recorder.toData(this.intervalSec, nowMs));
    } catch (e) {
      status.error = status.error ?? `traffic.json nicht schreibbar: ${(e as Error).message}`;
    }
    return status;
  }
}
