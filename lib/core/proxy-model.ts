/**
 * Reverse-Proxy: Routen (öffentlicher Hostname -> Server) und globale Schutzregeln.
 * Datei: proxy.json im Daten-Volume (gehört dem Panel). Der Proxy-Container liest sie und lädt sie bei Änderung neu.
 *
 * So bleibt die IP des Servers verborgen: Besucher sprechen nur mit dem Proxy (hinter Cloudflare Tunnel);
 * der Proxy erreicht den Server über das interne Netz anhand des Server-Namens aus dem Inventar.
 */
import { isCidr, isIp, isValidFqdn, normalizeIp, normalizeName, randomId } from "./net.ts";
import { serverPrimaryIp, type Inventory } from "./inventory-model.ts";

export type Upstream =
  | { type: "server"; serverId: string; port: number; scheme: "http" | "https" }
  | { type: "custom"; host: string; port: number; scheme: "http" | "https" };

export type Route = {
  id: string;
  /** öffentlicher Hostname, auch Wildcard "*.example.com" */
  host: string;
  upstream: Upstream;
  enabled: boolean;
  /** Original-Host-Header an den Server weitergeben (sonst den Namen des Servers) */
  preserveHost: boolean;
  /** Bei https-Upstreams das Zertifikat nicht prüfen (z. B. selbstsigniert im internen Netz) */
  insecureUpstream: boolean;
  /** Anfragen pro Minute und Besucher-IP (0 = globale Grenze) */
  rateLimitPerMinute: number;
  /** Nur diese Adressen/Netze dürfen zugreifen (leer = alle) */
  allowIps: string[];
  denyIps: string[];
  /** Erweiterte Absicherung: HSTS usw. */
  hardenHeaders: boolean;
  note?: string;
};

export type ProxyRules = {
  /** gesperrte Besucher-Adressen/Netze */
  blockedIps: string[];
  /** gesperrte User-Agent-Teilstrings (Kleinschreibung) */
  blockedUserAgents: string[];
  /** Anfragen pro Minute und Besucher-IP, wenn die Route nichts Eigenes hat (0 = unbegrenzt) */
  rateLimitPerMinute: number;
  /** Höchste Größe einer Anfrage in MB */
  maxBodyMb: number;
  /** Untere Grenze der Ursprungs-Antwortzeit */
  upstreamTimeoutSec: number;
};

export type ProxyState = { version: 1; rules: ProxyRules; routes: Route[]; updatedAt?: string };

export const defaultProxyState = (): ProxyState => ({
  version: 1,
  rules: { blockedIps: [], blockedUserAgents: ["sqlmap", "nikto", "masscan", "zgrab"], rateLimitPerMinute: 600, maxBodyMb: 100, upstreamTimeoutSec: 60 },
  routes: [],
});

export type Result<T> = { ok: true; data: T } | { ok: false; errors: string[] };
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v).slice(0, max) : "");
const flag = (v: unknown): boolean => v === "on" || v === true || v === "true";
const intIn = (v: unknown, min: number, max: number): number | null => {
  const s = typeof v === "number" ? String(v) : str(v, 12);
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};
const list = (v: unknown, max = 4000): string[] => str(v, max).split(/[\s,;]+/).filter(Boolean);

export function validateRoute(raw: Record<string, unknown>, inv: Inventory, existing: Route[] = []): Result<Route> {
  const errors: string[] = [];
  const host = normalizeName(str(raw.host, 253));
  if (!isValidFqdn(host, { allowWildcard: true }) || !host.includes(".")) errors.push("Hostname ungültig (z. B. shop.example.com oder *.example.com).");
  const id = str(raw.id, 20) || randomId();
  if (existing.some((r) => r.id !== id && r.host === host)) errors.push("Für diesen Hostnamen gibt es schon eine Route.");

  const port = intIn(raw.port, 1, 65535);
  if (port === null) errors.push("Port: 1–65535.");
  const scheme = raw.scheme === "https" ? "https" : "http";
  let upstream: Upstream | null = null;
  const target = str(raw.target, 260);
  if (!target) errors.push("Ziel fehlt: einen Server wählen oder einen Hostnamen/eine Adresse eingeben.");
  else if (target.startsWith("server:")) {
    const sid = target.slice(7);
    if (!inv.servers.some((s) => s.id === sid)) errors.push("Der gewählte Server existiert nicht.");
    else if (port !== null) upstream = { type: "server", serverId: sid, port, scheme };
  } else {
    const h = isIp(target) ? normalizeIp(target)! : normalizeName(target);
    if (!isIp(target) && !isValidFqdn(h)) errors.push("Ziel: gültiger Hostname oder IP-Adresse.");
    else if (port !== null) upstream = { type: "custom", host: h, port, scheme };
  }
  const rl = intIn(raw.rateLimitPerMinute ?? "0", 0, 1_000_000);
  if (rl === null) errors.push("Anfragelimit: Zahl von 0 bis 1000000.");
  const allowIps = list(raw.allowIps);
  const denyIps = list(raw.denyIps);
  for (const n of [...allowIps, ...denyIps]) if (!isCidr(n) && !isIp(n)) errors.push(`„${n}“ ist keine gültige Adresse oder kein Netz.`);
  if (errors.length || !upstream) return { ok: false, errors };
  return {
    ok: true,
    data: {
      id,
      host,
      upstream,
      enabled: raw.enabled === undefined ? true : flag(raw.enabled),
      preserveHost: flag(raw.preserveHost),
      insecureUpstream: flag(raw.insecureUpstream),
      rateLimitPerMinute: rl ?? 0,
      allowIps,
      denyIps,
      hardenHeaders: flag(raw.hardenHeaders),
      note: str(raw.note, 200) || undefined,
    },
  };
}

export function validateRules(raw: Record<string, unknown>): Result<ProxyRules> {
  const errors: string[] = [];
  const blockedIps = list(raw.blockedIps);
  for (const n of blockedIps) if (!isCidr(n) && !isIp(n)) errors.push(`„${n}“ ist keine gültige Adresse oder kein Netz.`);
  const blockedUserAgents = str(raw.blockedUserAgents, 2000).split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 100);
  const rl = intIn(raw.rateLimitPerMinute ?? "600", 0, 1_000_000);
  const mb = intIn(raw.maxBodyMb ?? "100", 1, 10240);
  const to = intIn(raw.upstreamTimeoutSec ?? "60", 5, 600);
  if (rl === null) errors.push("Anfragelimit: Zahl von 0 bis 1000000.");
  if (mb === null) errors.push("Maximale Anfragegröße: 1–10240 MB.");
  if (to === null) errors.push("Zeitlimit: 5–600 Sekunden.");
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { blockedIps, blockedUserAgents, rateLimitPerMinute: rl ?? 600, maxBodyMb: mb ?? 100, upstreamTimeoutSec: to ?? 60 } };
}

export function sanitizeProxyState(raw: unknown, inv: Inventory): ProxyState {
  const out = defaultProxyState();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (r.rules && typeof r.rules === "object") {
    const rr = r.rules as Record<string, unknown>;
    const v = validateRules({
      blockedIps: Array.isArray(rr.blockedIps) ? rr.blockedIps.join(" ") : "",
      blockedUserAgents: Array.isArray(rr.blockedUserAgents) ? rr.blockedUserAgents.join("\n") : "",
      rateLimitPerMinute: rr.rateLimitPerMinute,
      maxBodyMb: rr.maxBodyMb,
      upstreamTimeoutSec: rr.upstreamTimeoutSec,
    });
    if (v.ok) out.rules = v.data;
  }
  for (const rt of Array.isArray(r.routes) ? r.routes : []) {
    const x = (rt ?? {}) as Record<string, unknown>;
    const up = (x.upstream ?? {}) as Record<string, unknown>;
    const v = validateRoute(
      {
        ...x,
        target: up.type === "server" ? `server:${String(up.serverId ?? "")}` : up.host,
        port: up.port,
        scheme: up.scheme,
        allowIps: Array.isArray(x.allowIps) ? x.allowIps.join(" ") : "",
        denyIps: Array.isArray(x.denyIps) ? x.denyIps.join(" ") : "",
        rateLimitPerMinute: x.rateLimitPerMinute ?? 0,
      },
      inv,
      out.routes,
    );
    if (v.ok) out.routes.push(v.data);
  }
  if (typeof r.updatedAt === "string") out.updatedAt = r.updatedAt;
  return out;
}

/** Route zum Hostnamen: exakter Treffer vor Wildcard (der längste Wildcard zuerst). */
export function matchRoute(routes: readonly Route[], hostHeader: string): Route | undefined {
  const host = normalizeName(hostHeader.replace(/:\d+$/, ""));
  const live = routes.filter((r) => r.enabled);
  const exact = live.find((r) => r.host === host);
  if (exact) return exact;
  return live
    .filter((r) => r.host.startsWith("*.") && host.endsWith(r.host.slice(1)) && host.length > r.host.length - 1)
    .sort((a, b) => b.host.length - a.host.length)[0];
}

/** Ziel des Proxys: Adresse, Port, Schema. Server werden über ihre Hauptadresse aus dem Inventar erreicht. */
export function resolveUpstream(route: Route, inv: Inventory): { host: string; port: number; scheme: "http" | "https"; serverName?: string } | null {
  const u = route.upstream;
  if (u.type === "custom") return { host: u.host, port: u.port, scheme: u.scheme };
  const server = inv.servers.find((s) => s.id === u.serverId);
  if (!server) return null;
  const ip = serverPrimaryIp(inv, server);
  if (!ip) return null;
  return { host: ip, port: u.port, scheme: u.scheme, serverName: server.name };
}
