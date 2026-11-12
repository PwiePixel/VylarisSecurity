/**
 * Vylaris-Security-Worker: Cloudflare-Abgleich, IP-Scan, Netzwerkverkehr (Host + Proxmox) und Aufträge des Panels.
 * Läuft als eigener Container mit Host-Netzwerk (damit Scan und Zähler das echte Netz sehen) und hat als Einziger
 * den Cloudflare-Token. Schreibt nur in runtime/ (und runtime/results/).
 *
 * Umgebung: DATA_DIR, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_TUNNEL_ID, CF_API_BASE, PROXMOX_TOKEN_SECRET,
 *           SCAN_INTERVAL_SEC (120), TRAFFIC_INTERVAL_SEC (30), CF_SYNC_INTERVAL_SEC (120)
 */
import type { WorkerRuntime } from "../../lib/core/runtime-model.ts";
import { FILES } from "../../lib/core/runtime-model.ts";
import { DATA_DIR, loadDns, loadIntegrations, loadInventory, loadProxy, log, nowIso, watchFiles, writeJsonAtomic } from "../common/data.ts";
import { CfClient, CloudflareService, cfEnvFromProcess, emptyCloudflareStatus, importCloudflareZone, summarizeCloudflare } from "./cloudflare.ts";
import { pveConfig, pveImport, pveMessage } from "./proxmox.ts";
import { cleanupResults, processRequests, type Handlers } from "./requests.ts";
import { runScan } from "./scan.ts";
import { TrafficCollector } from "./traffic.ts";

const num = (v: string | undefined, d: number, min: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
};
const SCAN_SEC = num(process.env.SCAN_INTERVAL_SEC, 120, 10);
const TRAFFIC_SEC = num(process.env.TRAFFIC_INTERVAL_SEC, 30, 5);
const CF_SEC = num(process.env.CF_SYNC_INTERVAL_SEC, 120, 30);

const startedAt = nowIso();
const env = cfEnvFromProcess();
const cf = new CloudflareService(
  env,
  async () => {
    const inv = await loadInventory();
    return { dns: await loadDns(), proxy: await loadProxy(inv) };
  },
  { intervalMs: CF_SEC * 1000, minGapMs: 10_000 },
);
const traffic = new TrafficCollector(TRAFFIC_SEC);
const state: WorkerRuntime = {
  updatedAt: startedAt,
  startedAt,
  cloudflare: emptyCloudflareStatus(!!env.token),
  scan: { hosts: 0 },
  proxmox: { configured: false, vms: 0 },
};

const timers: NodeJS.Timeout[] = [];
const stops: (() => void)[] = [];

/** Läuft `fn` nie überlappend; Fehler landen im Log, nie als Absturz. */
function every(name: string, ms: number, firstMs: number, fn: () => Promise<void>): void {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      log(name, `Fehler: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => {
    void run();
    const t = setInterval(() => void run(), ms);
    timers.push(t);
  }, firstMs);
  timers.push(first);
}

async function writeState(): Promise<void> {
  state.updatedAt = nowIso();
  state.cloudflare = cf.status;
  await writeJsonAtomic(FILES.workerRuntime, state);
}

let scanning: Promise<void> | null = null;
function scanNow(): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      state.scan = await runScan(await loadInventory());
      log("scan", `${state.scan.hosts} Adressen in ${state.scan.durationMs ?? 0} ms${state.scan.error ? ` – ${state.scan.error}` : ""}`);
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

async function collectTraffic(): Promise<void> {
  state.proxmox = await traffic.collect();
}

const handlers: Handlers = {
  "scan-now": async () => {
    await scanNow();
    return { ok: !state.scan.error, message: `${state.scan.hosts} Adressen geprüft${state.scan.error ? ` – ${state.scan.error}` : "."}` };
  },
  "cloudflare-sync": async () => {
    const s = await cf.sync();
    return summarizeCloudflare(s);
  },
  "cloudflare-import": async (req) => {
    if (!env.token) return { ok: false, message: "Kein Cloudflare-Token konfiguriert (./install.sh cloudflare)." };
    return importCloudflareZone(new CfClient({ token: env.token, base: env.base }), await loadDns(), req.zoneId);
  },
  "proxmox-import": async () => {
    const { cfg, error } = pveConfig(await loadIntegrations(), process.env.PROXMOX_TOKEN_SECRET?.trim() || undefined);
    if (!cfg) return { ok: false, message: error ?? "Proxmox ist nicht aktiviert (Integrationen)." };
    try {
      const vms = await pveImport(cfg);
      return { ok: true, message: `${vms.length} VM(s) gefunden.`, data: { vms } };
    } catch (e) {
      return { ok: false, message: pveMessage(e) };
    }
  },
};

log("worker", `startet (Daten: ${DATA_DIR}; Cloudflare: ${env.token ? "Token vorhanden" : "kein Token"}; Scan alle ${SCAN_SEC} s; Messung alle ${TRAFFIC_SEC} s)`);

stops.push(watchFiles([FILES.dns, FILES.proxy, FILES.inventory], () => cf.markDirty(), 2000));
every("cloudflare", 3000, 1500, () => cf.syncIfDue());
every("scan", SCAN_SEC * 1000, 5000, scanNow);
every("traffic", TRAFFIC_SEC * 1000, 2000, collectTraffic);
every("requests", 3000, 1000, async () => {
  const n = await processRequests(handlers);
  if (n > 0) await writeState();
});
every("cleanup", 3600_000, 60_000, async () => {
  await cleanupResults();
});
every("heartbeat", 10_000, 500, writeState);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("worker", `${signal}: beende …`);
  for (const t of timers) clearTimeout(t);
  for (const s of stops) s();
  try {
    await writeState();
  } catch {
    /* egal beim Beenden */
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log("worker", `Unbehandelter Fehler: ${(e as Error)?.message ?? String(e)}`));
