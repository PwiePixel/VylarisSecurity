/**
 * Laufzeitdaten der Engines. Jede Engine schreibt NUR ihre eigenen Dateien (Ordner runtime/ im Daten-Volume);
 * das Panel liest sie. Konfigurationsdateien (dns.json, inventory.json, proxy.json) gehören dem Panel
 * und werden von den Engines nur gelesen.
 *
 *   dns.json  inventory.json  proxy.json  admin.json  sessions.json  audit.log   <- Panel
 *   runtime/dns.json        <- DNS-Server   (Zähler, Herzschlag)
 *   runtime/proxy.json      <- Proxy        (Zähler je Route, gesperrte Anfragen, Herzschlag)
 *   runtime/worker.json     <- Worker       (Herzschlag, Cloudflare-Stand)
 *   runtime/scan.json       <- Worker       (Erreichbarkeit der IPs, siehe ScanData)
 *   runtime/traffic.json    <- Worker       (Netzwerkverkehr: Host-Schnittstellen und Proxmox-VMs)
 *   requests/<id>.json      <- Panel        (Aufträge an den Worker)
 *   runtime/results/<id>.json <- Worker     (Ergebnis eines Auftrags)
 */

export const FILES = {
  dns: "dns.json",
  inventory: "inventory.json",
  proxy: "proxy.json",
  integrations: "integrations.json",
  dnsRuntime: "runtime/dns.json",
  proxyRuntime: "runtime/proxy.json",
  workerRuntime: "runtime/worker.json",
  scan: "runtime/scan.json",
  traffic: "runtime/traffic.json",
  requestsDir: "requests",
  resultsDir: "runtime/results",
} as const;

/** Ein Herzschlag gilt als frisch, wenn er höchstens so alt ist (Engines schreiben alle 10 s). */
export const HEARTBEAT_MAX_AGE_MS = 45_000;

export const isFresh = (iso: string | undefined, now = Date.now(), maxAge = HEARTBEAT_MAX_AGE_MS): boolean => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && now - t <= maxAge;
};

/* ------------------------------------------------------------ DNS-Server */
export type DnsRuntime = {
  updatedAt: string;
  startedAt: string;
  version: number;
  /** Anzahl der ausgelieferten Zonen und Einträge */
  zones: number;
  records: number;
  warnings: string[];
  totals: {
    queries: number;
    udp: number;
    tcp: number;
    noerror: number;
    nxdomain: number;
    refused: number;
    servfail: number;
    formerr: number;
    truncated: number;
    rateLimited: number;
    internalViews: number;
  };
  byType: Record<string, number>;
  byZone: Record<string, number>;
  /** Anfragen je Minute der letzten 60 Minuten (neueste zuletzt) */
  perMinute: { t: number; q: number }[];
};

/* ----------------------------------------------------------------- Proxy */
export type RouteStats = {
  requests: number;
  bytesIn: number;
  bytesOut: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  blocked: number;
  rateLimited: number;
  upstreamErrors: number;
  /** Summe der Antwortzeiten in ms (Durchschnitt = latencyMs / requests) */
  latencyMs: number;
  lastRequestAt?: string;
};

export type ProxyEvent = { t: string; host: string; ip: string; reason: "blocked-ip" | "deny-ip" | "not-allowed" | "user-agent" | "rate-limit" | "too-large" | "upstream-error" | "unknown-host"; detail?: string };

export type ProxyRuntime = {
  updatedAt: string;
  startedAt: string;
  routes: Record<string, RouteStats>;
  totals: RouteStats;
  unknownHost: number;
  /** je Minute der letzten 60 Minuten */
  perMinute: { t: number; req: number; bytesIn: number; bytesOut: number; blocked: number }[];
  events: ProxyEvent[];
};

/* ---------------------------------------------------------------- Worker */
export type CloudflareStatus = {
  configured: boolean;
  checkedAt?: string;
  tokenValid?: boolean;
  error?: string;
  tunnelId?: string;
  /** Cloudflare-Zonen (Betriebsart "cloudflare"): letzter Abgleich */
  zones: Record<string, { zoneId?: string; syncedAt?: string; created: number; updated: number; deleted: number; unmanaged: number; error?: string }>;
  /** Absicherung (Custom Hostnames) je Hostname */
  edge: Record<string, { status: string; sslStatus?: string; error?: string; checkedAt: string }>;
  /** CNAME auf den Tunnel für Proxy-Routen in Cloudflare-Zonen */
  tunnelRoutes: Record<string, { ok: boolean; error?: string }>;
  /** Hinweis zur Edge-Absicherung (z. B. Fallback-Origin fehlt, nicht mehr benötigte Custom Hostnames) */
  edgeNote?: string;
  /** Hinweis zu den Tunnel-Routen (z. B. CF_TUNNEL_ID fehlt) */
  tunnelNote?: string;
};

export type WorkerRuntime = {
  updatedAt: string;
  startedAt: string;
  cloudflare: CloudflareStatus;
  scan: { lastRun?: string; hosts: number; durationMs?: number; error?: string };
  proxmox: { configured: boolean; lastRun?: string; ok?: boolean; error?: string; vms: number };
};

/** Aufträge des Panels an den Worker (Datei requests/<id>.json). */
export type WorkerRequest =
  | { id: string; type: "scan-now"; at: string }
  | { id: string; type: "cloudflare-sync"; at: string }
  | { id: string; type: "cloudflare-import"; at: string; zoneId: string }
  | { id: string; type: "proxmox-import"; at: string };

export type WorkerResult = { id: string; done: string; ok: boolean; message: string; data?: unknown };

/* --------------------------------------------------------------- Traffic */
export type TrafficPoint = { t: number; rxBps: number; txBps: number };

export type TrafficSeries = {
  key: string;
  label: string;
  kind: "host-interface" | "proxmox-vm" | "proxmox-node";
  /** serverId, wenn die VM einem Server im Inventar zugeordnet ist */
  serverId?: string;
  /** Summen seit Start der Zählung (Bytes) und letzter Zählerstand */
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
  status?: string;
  /** Proxmox: CPU 0..1, Speicher und Laufzeit */
  cpu?: number;
  memBytes?: number;
  uptimeSec?: number;
  points: TrafficPoint[];
};

export type TrafficData = { updatedAt: string; intervalSec: number; series: TrafficSeries[] };

/* ----------------------------------------------------- Proxmox-Integration */
/** Nicht geheime Einstellungen (integrations.json, Panel). Das Token-Geheimnis steht nur in .env.worker. */
export type Integrations = {
  proxmox: { enabled: boolean; url: string; tokenId: string; verifyTls: boolean };
  cloudflare: { enabled: boolean };
};

export const defaultIntegrations = (): Integrations => ({
  proxmox: { enabled: false, url: "", tokenId: "", verifyTls: false },
  cloudflare: { enabled: true },
});
