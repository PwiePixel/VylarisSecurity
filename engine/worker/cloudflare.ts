/**
 * Cloudflare-Anbindung des Workers (dokumentierte REST-API v4, Bearer-Token).
 *
 *  1. Token prüfen
 *  2. Zonen der Betriebsart "cloudflare": verwaltete Einträge (comment beginnt mit "vylaris-security") abgleichen
 *  3. Tunnel-Routen: CNAME  <Host> -> <tunnel-id>.cfargotunnel.com  für Proxy-Routen in Cloudflare-Zonen
 *  4. Edge-Absicherung: Custom Hostnames (Cloudflare for SaaS) für Einträge mit "protect"
 *  5. Import: Einträge einer Cloudflare-Zone als Vorschläge liefern (ändert Cloudflare nicht)
 *
 * Sicherheitsregeln: Nicht verwaltete Einträge werden nie geändert. Schlägt das Lesen der Liste fehl, wird nichts
 * gelöscht. Der Token wird nie geloggt und nie in eine Datei geschrieben.
 */
import { formatIPv6, fqdn, isSubdomainOf, normalizeName, parseIPv6 } from "../../lib/core/net.ts";
import { recordTypes, validateRecord, type DnsRecord, type DnsState, type DnsZone } from "../../lib/core/dns-model.ts";
import type { ProxyState } from "../../lib/core/proxy-model.ts";
import type { CloudflareStatus } from "../../lib/core/runtime-model.ts";
import { log, nowIso } from "../common/data.ts";

export const MANAGED = "vylaris-security";
export const TUNNEL_COMMENT = `${MANAGED}:tunnel`;
export const DEFAULT_CF_BASE = "https://api.cloudflare.com/client/v4";

export type CfEnv = { token?: string; accountId?: string; tunnelId?: string; base?: string };

export const cfEnvFromProcess = (env: NodeJS.ProcessEnv = process.env): CfEnv => ({
  token: env.CLOUDFLARE_API_TOKEN?.trim() || undefined,
  accountId: env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined,
  tunnelId: env.CF_TUNNEL_ID?.trim() || undefined,
  base: (env.CF_API_BASE?.trim() || DEFAULT_CF_BASE).replace(/\/+$/, ""),
});

/* ------------------------------------------------------------- HTTP-Client */
export type CfResponse<T = any> = { ok: boolean; status: number; result: T; error: string; totalPages?: number };

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CfClient {
  readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: { token: string; base?: string; timeoutMs?: number; maxRetries?: number; sleep?: (ms: number) => Promise<void> }) {
    this.token = opts.token;
    this.base = (opts.base ?? DEFAULT_CF_BASE).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? sleepMs;
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.base + path, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", "User-Agent": "vylaris-security-worker/1" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        const timeout = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
        return { ok: false, status: 0, result: null as T, error: timeout ? `Zeitüberschreitung bei Cloudflare (${Math.round(this.timeoutMs / 1000)} s).` : "Keine Verbindung zu Cloudflare." };
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep(Math.min(30_000, Math.max(500, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000)));
        continue;
      }
      let json: any = null;
      try {
        json = JSON.parse(await res.text());
      } catch {
        return { ok: false, status: res.status, result: null as T, error: `Unerwartete Antwort von Cloudflare (HTTP ${res.status}).` };
      }
      const ok = res.ok && json?.success === true;
      return {
        ok,
        status: res.status,
        result: json?.result as T,
        error: ok ? "" : cfError(res.status, json),
        totalPages: typeof json?.result_info?.total_pages === "number" ? json.result_info.total_pages : undefined,
      };
    }
  }
}

function cfError(status: number, json: any): string {
  const errs: any[] = Array.isArray(json?.errors) ? json.errors : [];
  const text = errs.map((e) => `${e?.message ?? "Fehler"}${e?.code ? ` (Code ${e.code})` : ""}`).join("; ");
  if (status === 401) return `Cloudflare lehnt den Token ab (401)${text ? `: ${text}` : ""}.`;
  if (status === 403) return `Dem Token fehlen Rechte (403)${text ? `: ${text}` : ""}. Prüfe „Zone · DNS · Edit“, „Zone · Zone · Read“ und ggf. „SSL and Certificates · Edit“.`;
  if (status === 429) return "Cloudflare begrenzt die Anfragen (429). Später erneut.";
  return text || `Cloudflare-Fehler (HTTP ${status}).`;
}

/** Liest alle Seiten einer Liste (100 je Seite, höchstens 100 Seiten). Bei Fehler: ok=false und nichts Halbes. */
export async function listAll<T = any>(client: CfClient, path: string): Promise<{ ok: boolean; items: T[]; error: string }> {
  const items: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await client.request<T[]>("GET", `${path}${sep}page=${page}&per_page=100`);
    if (!r.ok || !Array.isArray(r.result)) return { ok: false, items: [], error: r.error || "Unerwartete Antwort von Cloudflare." };
    items.push(...r.result);
    if (r.result.length < 100 || (r.totalPages !== undefined && page >= r.totalPages)) break;
  }
  return { ok: true, items, error: "" };
}

export async function findZoneId(client: CfClient, name: string): Promise<{ id?: string; error?: string }> {
  const r = await client.request<any[]>("GET", `/zones?name=${encodeURIComponent(name)}`);
  if (!r.ok) return { error: r.error };
  const id = Array.isArray(r.result) ? r.result[0]?.id : undefined;
  return typeof id === "string" ? { id } : { error: `Die Domain ${name} liegt nicht in diesem Cloudflare-Konto.` };
}

/* ------------------------------------------------------ Abbilden der Einträge */
export type CfRecordBody = {
  type: string;
  name: string;
  content?: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
  data?: Record<string, string | number>;
  comment: string;
};

const PROXIABLE = ["A", "AAAA", "CNAME", "ALIAS"];

/** Panel-Eintrag -> Cloudflare. Interne Einträge gehören nicht zu Cloudflare (null). */
export function toCfBody(zone: DnsZone, r: DnsRecord): CfRecordBody | null {
  if (r.visibility === "internal") return null;
  const proxied = !!r.proxied && PROXIABLE.includes(r.type);
  const base = { name: fqdn(zone.name, r.name), ttl: proxied ? 1 : Math.max(60, r.ttl), proxied, comment: `${MANAGED}:${r.id}` };
  switch (r.type) {
    case "ALIAS": // Cloudflare flacht CNAME am Zonenanfang selbst ab
      return { ...base, type: "CNAME", content: r.value };
    case "MX":
      return { ...base, type: "MX", content: r.value, priority: r.priority ?? 10 };
    case "SRV":
      return { ...base, type: "SRV", data: { priority: r.priority ?? 0, weight: r.weight ?? 0, port: r.port ?? 0, target: r.value } };
    case "CAA":
      return { ...base, type: "CAA", data: { flags: r.flags ?? 0, tag: r.tag ?? "issue", value: r.value } };
    default:
      return { ...base, type: r.type, content: r.value };
  }
}

const stripQuotes = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
const normHost = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
const normContent = (type: string, c: unknown): string => {
  const s = typeof c === "string" ? c : "";
  if (type === "TXT") return stripQuotes(s);
  if (type === "AAAA") {
    const v = parseIPv6(s);
    return v === null ? s : formatIPv6(v);
  }
  if (type === "CNAME" || type === "NS" || type === "PTR" || type === "MX") return normHost(s);
  return s;
};

/** Gleicht ein vorhandenes Cloudflare-Objekt mit dem gewünschten Inhalt ab (keine Schreibzugriffe, wenn gleich). */
export function sameRecord(existing: any, want: CfRecordBody): boolean {
  if (String(existing.type) !== want.type || normHost(String(existing.name ?? "")) !== normHost(want.name)) return false;
  if (Number(existing.ttl) !== want.ttl) return false;
  if (Boolean(existing.proxied) !== want.proxied) return false;
  if ((existing.comment ?? "") !== want.comment) return false;
  if (want.type === "MX" && Number(existing.priority) !== want.priority) return false;
  if (want.data) {
    const d = existing.data ?? {};
    for (const [k, v] of Object.entries(want.data)) {
      const have = d[k];
      if (typeof v === "number") {
        if (Number(have) !== v) return false;
      } else if (k === "target") {
        if (normHost(String(have ?? "")) !== normHost(v)) return false;
      } else if (stripQuotes(String(have ?? "")) !== v) return false;
    }
    return true;
  }
  return normContent(want.type, existing.content) === normContent(want.type, want.content);
}

const isManaged = (rec: any): boolean => typeof rec?.comment === "string" && rec.comment.startsWith(MANAGED);
const keyOf = (comment: string, name: string): string => (comment === TUNNEL_COMMENT ? `tunnel:${normHost(name)}` : comment);

/* ------------------------------------------------------------ Zonen-Abgleich */
export type ZoneStat = CloudflareStatus["zones"][string];
export type TunnelStat = CloudflareStatus["tunnelRoutes"][string];

/**
 * Gleicht eine Cloudflare-Zone ab. `tunnelHosts`: Hosts, die einen Tunnel-CNAME brauchen; null = Tunnel nicht
 * konfiguriert (vorhandene Tunnel-Einträge bleiben dann unberührt).
 */
export async function syncCloudflareZone(
  client: CfClient,
  zone: DnsZone,
  tunnelHosts: string[] | null,
  tunnelId: string | undefined,
  zoneIds: Map<string, string | null>,
): Promise<{ stat: ZoneStat; tunnel: Record<string, TunnelStat> }> {
  const stat: ZoneStat = { created: 0, updated: 0, deleted: 0, unmanaged: 0 };
  const tunnel: Record<string, TunnelStat> = {};
  const found = await findZoneId(client, zone.name);
  if (!found.id) {
    zoneIds.set(zone.name, null);
    stat.error = found.error;
    for (const h of tunnelHosts ?? []) tunnel[h] = { ok: false, error: found.error };
    return { stat, tunnel };
  }
  zoneIds.set(zone.name, found.id);
  stat.zoneId = found.id;

  const list = await listAll<any>(client, `/zones/${found.id}/dns_records`);
  if (!list.ok) {
    // Kein Lesen, kein Abgleich – vor allem kein Löschen.
    stat.error = `Einträge konnten nicht gelesen werden: ${list.error}`;
    for (const h of tunnelHosts ?? []) tunnel[h] = { ok: false, error: "Zone konnte nicht gelesen werden." };
    return { stat, tunnel };
  }

  const desired = new Map<string, CfRecordBody>();
  const panelNames = new Set<string>();
  for (const r of zone.records) {
    const body = toCfBody(zone, r);
    if (body) {
      desired.set(body.comment, body);
      panelNames.add(normHost(body.name));
    }
  }
  const existingManaged = new Map<string, any>();
  const duplicates: any[] = [];
  const unmanagedNames = new Map<string, any[]>();
  for (const rec of list.items) {
    if (isManaged(rec)) {
      const k = keyOf(String(rec.comment), String(rec.name));
      if (existingManaged.has(k)) duplicates.push(rec);
      else existingManaged.set(k, rec);
    } else {
      stat.unmanaged++;
      const n = normHost(String(rec.name));
      unmanagedNames.set(n, [...(unmanagedNames.get(n) ?? []), rec]);
    }
  }

  // Tunnel-Einträge
  if (tunnelHosts && tunnelId) {
    for (const host of tunnelHosts) {
      const name = normHost(host);
      if (panelNames.has(name)) {
        tunnel[host] = { ok: false, error: "Im Panel gibt es schon einen DNS-Eintrag mit diesem Namen." };
        continue;
      }
      if (unmanagedNames.has(name)) {
        tunnel[host] = { ok: false, error: "In Cloudflare gibt es schon einen nicht verwalteten Eintrag mit diesem Namen – bitte dort entfernen." };
        continue;
      }
      desired.set(keyOf(TUNNEL_COMMENT, name), { type: "CNAME", name, content: `${tunnelId}.cfargotunnel.com`, ttl: 1, proxied: true, comment: TUNNEL_COMMENT });
      tunnel[host] = { ok: true };
    }
  }

  // Reihenfolge: löschen, ändern, anlegen (verhindert Konflikte wie CNAME gegen A am selben Namen)
  const toDelete: any[] = [...duplicates];
  for (const [k, rec] of existingManaged) {
    if (desired.has(k)) continue;
    if (tunnelHosts === null && rec.comment === TUNNEL_COMMENT) continue; // Tunnel nicht konfiguriert: nichts anfassen
    toDelete.push(rec);
  }
  const errors: string[] = [];
  const fail = (what: string, err: string, host?: string) => {
    errors.push(`${what}: ${err}`);
    if (host && tunnel[host]) tunnel[host] = { ok: false, error: err };
  };
  for (const rec of toDelete) {
    const r = await client.request("DELETE", `/zones/${found.id}/dns_records/${rec.id}`);
    if (r.ok) stat.deleted++;
    else fail(`Löschen von ${rec.name}`, r.error);
  }
  const hostOfTunnel = (body: CfRecordBody) => (body.comment === TUNNEL_COMMENT ? tunnelHosts?.find((h) => normHost(h) === normHost(body.name)) : undefined);
  const toCreate: CfRecordBody[] = [];
  for (const [k, body] of desired) {
    const ex = existingManaged.get(k);
    if (!ex) {
      toCreate.push(body);
      continue;
    }
    if (sameRecord(ex, body)) continue;
    const r = await client.request("PUT", `/zones/${found.id}/dns_records/${ex.id}`, body);
    if (r.ok) stat.updated++;
    else fail(`Ändern von ${body.name}`, r.error, hostOfTunnel(body));
  }
  for (const body of toCreate) {
    const r = await client.request("POST", `/zones/${found.id}/dns_records`, body);
    if (r.ok) stat.created++;
    else fail(`Anlegen von ${body.name}`, r.error, hostOfTunnel(body));
  }
  if (errors.length) stat.error = errors.slice(0, 3).join(" · ") + (errors.length > 3 ? ` · … (${errors.length} Fehler)` : "");
  stat.syncedAt = nowIso();
  return { stat, tunnel };
}

/* ------------------------------------------------------------- Edge-Schutz */
function longestZoneFor(name: string, zones: DnsZone[]): DnsZone | undefined {
  return zones.filter((z) => isSubdomainOf(normalizeName(name), z.name)).sort((a, b) => b.name.length - a.name.length)[0];
}

async function syncEdge(client: CfClient, dns: DnsState, status: CloudflareStatus, zoneIds: Map<string, string | null>): Promise<void> {
  const target = normalizeName(dns.settings.edge.target);
  if (!dns.settings.edge.enabled || !target) return;
  // Zone des Edge-Ziels: von lang nach kurz probieren (edge.vylaris.eu -> vylaris.eu)
  const labels = target.split(".");
  let edgeZone: string | undefined;
  let zoneId: string | undefined;
  let lastErr = "";
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join(".");
    const cached = zoneIds.get(name);
    if (cached) {
      edgeZone = name;
      zoneId = cached;
      break;
    }
    if (cached === null) continue;
    const f = await findZoneId(client, name);
    zoneIds.set(name, f.id ?? null);
    if (f.id) {
      edgeZone = name;
      zoneId = f.id;
      break;
    }
    lastErr = f.error ?? "";
  }
  if (!zoneId || !edgeZone) {
    status.edgeNote = `Die Zone für ${target} liegt nicht in diesem Cloudflare-Konto${lastErr ? ` (${lastErr})` : ""}. Edge-Absicherung inaktiv.`;
    return;
  }

  const notes: string[] = [];
  const fb = await client.request<any>("GET", `/zones/${zoneId}/custom_hostnames/fallback_origin`);
  if (!fb.ok) notes.push(`Fallback-Origin nicht lesbar: ${fb.error} (Cloudflare for SaaS in der Zone ${edgeZone} aktivieren).`);
  else if (fb.result?.status !== "active") notes.push(`Fallback-Origin ist nicht aktiv (Status: ${fb.result?.status ?? "nicht gesetzt"}). Setze ihn auf ${target} – sonst werden geschützte Hostnamen nicht ausgeliefert.`);

  const wanted = new Set<string>();
  for (const z of dns.zones) {
    if (z.mode !== "authoritative") continue;
    for (const r of z.records) {
      if (!r.protect) continue;
      const h = fqdn(z.name, r.name);
      if (!h.startsWith("*")) wanted.add(h);
    }
  }
  for (const host of wanted) {
    const checkedAt = nowIso();
    const got = await client.request<any[]>("GET", `/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(host)}`);
    if (!got.ok) {
      status.edge[host] = { status: "error", error: got.error, checkedAt };
      continue;
    }
    let ch = Array.isArray(got.result) ? got.result.find((c) => normHost(String(c.hostname)) === host) : undefined;
    if (!ch) {
      const made = await client.request<any>("POST", `/zones/${zoneId}/custom_hostnames`, {
        hostname: host,
        ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
      });
      if (!made.ok) {
        status.edge[host] = { status: "error", error: made.error, checkedAt };
        continue;
      }
      ch = made.result;
    }
    const verr = Array.isArray(ch?.verification_errors) ? ch.verification_errors.join("; ") : "";
    const sslErr = Array.isArray(ch?.ssl?.validation_errors) ? ch.ssl.validation_errors.map((v: any) => v?.message).filter(Boolean).join("; ") : "";
    status.edge[host] = {
      status: String(ch?.status ?? "pending"),
      sslStatus: ch?.ssl?.status ? String(ch.ssl.status) : undefined,
      error: [verr, sslErr].filter(Boolean).join("; ") || undefined,
      checkedAt,
    };
  }

  // Nicht mehr benötigte Custom Hostnames: nur melden, nie löschen.
  const all = await listAll<any>(client, `/zones/${zoneId}/custom_hostnames`);
  if (all.ok) {
    const extra = all.items.map((c) => normHost(String(c.hostname))).filter((h) => !wanted.has(h));
    if (extra.length) notes.push(`${extra.length} Custom Hostname(s) in Cloudflare werden nicht mehr benötigt (nicht gelöscht): ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", …" : ""}.`);
  }
  if (notes.length) status.edgeNote = notes.join(" ");
}

/* ------------------------------------------------------------- Gesamtlauf */
export function emptyCloudflareStatus(configured: boolean): CloudflareStatus {
  return { configured, zones: {}, edge: {}, tunnelRoutes: {} };
}

/** Führt den kompletten Abgleich aus und liefert den neuen Stand. Wirft nie. */
export async function runCloudflareSync(env: CfEnv, dns: DnsState, proxy: ProxyState, client?: CfClient): Promise<CloudflareStatus> {
  const status = emptyCloudflareStatus(!!env.token);
  status.checkedAt = nowIso();
  if (!env.token) return status;
  status.tunnelId = env.tunnelId;
  const cf = client ?? new CfClient({ token: env.token, base: env.base });
  try {
    // 1. Token prüfen
    let v = await cf.request<any>("GET", "/user/tokens/verify");
    if (!v.ok && env.accountId) v = await cf.request<any>("GET", `/accounts/${env.accountId}/tokens/verify`);
    status.tokenValid = v.ok && v.result?.status === "active";
    if (!status.tokenValid) {
      status.error = v.ok ? `Der Token ist nicht aktiv (Status: ${v.result?.status ?? "unbekannt"}).` : v.error;
      return status;
    }

    const zoneIds = new Map<string, string | null>();
    const cfZones = dns.zones.filter((z) => z.mode === "cloudflare");

    // Tunnel-Hosts je Cloudflare-Zone
    const hostsByZone = new Map<string, string[]>();
    for (const route of proxy.routes) {
      if (!route.enabled) continue;
      const z = longestZoneFor(route.host.replace(/^\*\./, ""), cfZones);
      if (!z) continue;
      hostsByZone.set(z.id, [...(hostsByZone.get(z.id) ?? []), route.host]);
    }
    if (!env.tunnelId && hostsByZone.size) {
      status.tunnelNote = "CF_TUNNEL_ID fehlt – Tunnel-Einträge für Proxy-Routen werden nicht gesetzt (./install.sh ausführen).";
    }

    for (const zone of cfZones) {
      try {
        const hosts = env.tunnelId ? (hostsByZone.get(zone.id) ?? []) : null;
        const { stat, tunnel } = await syncCloudflareZone(cf, zone, hosts, env.tunnelId, zoneIds);
        status.zones[zone.id] = stat;
        Object.assign(status.tunnelRoutes, tunnel);
      } catch (e) {
        status.zones[zone.id] = { created: 0, updated: 0, deleted: 0, unmanaged: 0, error: `Unerwarteter Fehler: ${(e as Error).message}` };
      }
    }
    if (!env.tunnelId) {
      for (const hosts of hostsByZone.values()) for (const h of hosts) status.tunnelRoutes[h] = { ok: false, error: "CF_TUNNEL_ID fehlt." };
    }

    try {
      await syncEdge(cf, dns, status, zoneIds);
    } catch (e) {
      status.edgeNote = `Edge-Absicherung fehlgeschlagen: ${(e as Error).message}`;
    }
  } catch (e) {
    status.error = `Unerwarteter Fehler beim Cloudflare-Abgleich: ${(e as Error).message}`;
  }
  return status;
}

/** Kurze Zusammenfassung für Aufträge und Logs. */
export function summarizeCloudflare(s: CloudflareStatus): { ok: boolean; message: string } {
  if (!s.configured) return { ok: false, message: "Kein Cloudflare-Token konfiguriert (./install.sh cloudflare)." };
  if (!s.tokenValid) return { ok: false, message: s.error ?? "Token ungültig." };
  const z = Object.values(s.zones);
  const c = z.reduce((a, x) => a + x.created, 0);
  const u = z.reduce((a, x) => a + x.updated, 0);
  const d = z.reduce((a, x) => a + x.deleted, 0);
  const errs = [
    ...z.map((x) => x.error).filter(Boolean),
    ...Object.entries(s.tunnelRoutes).filter(([, t]) => !t.ok).map(([h, t]) => `${h}: ${t.error}`),
    ...Object.entries(s.edge).filter(([, e]) => e.status === "error").map(([h, e]) => `${h}: ${e.error}`),
  ] as string[];
  const base = `Abgleich fertig: ${c} angelegt, ${u} geändert, ${d} gelöscht.`;
  return errs.length ? { ok: false, message: `${base} Probleme: ${errs.slice(0, 3).join(" · ")}` } : { ok: true, message: base };
}

/* ------------------------------------------------------------------ Import */
const SUPPORTED = new Set<string>(recordTypes.filter((t) => t !== "ALIAS"));

/** Liest die Einträge einer Cloudflare-Zone und liefert gültige Panel-Einträge als Vorschläge. Ändert Cloudflare nicht. */
export async function importCloudflareZone(
  client: CfClient,
  dns: DnsState,
  panelZoneId: string,
): Promise<{ ok: boolean; message: string; data?: { zoneId: string; zoneName: string; records: DnsRecord[]; skipped: number } }> {
  const zone = dns.zones.find((z) => z.id === panelZoneId);
  if (!zone) return { ok: false, message: "Zone nicht gefunden." };
  const found = await findZoneId(client, zone.name);
  if (!found.id) return { ok: false, message: found.error ?? "Zone nicht gefunden." };
  const list = await listAll<any>(client, `/zones/${found.id}/dns_records`);
  if (!list.ok) return { ok: false, message: `Einträge konnten nicht gelesen werden: ${list.error}` };
  const records: DnsRecord[] = [];
  let skipped = 0;
  for (const c of list.items) {
    if (isManaged(c)) continue; // schon im Panel
    const type = String(c.type);
    if (!SUPPORTED.has(type)) {
      skipped++;
      continue;
    }
    const raw: Record<string, unknown> = { name: c.name, type, ttl: c.ttl === 1 ? zone.defaultTtl : c.ttl, visibility: "public", proxied: c.proxied ? "on" : undefined };
    if (type === "SRV") {
      const d = c.data ?? parseSrv(String(c.content ?? ""));
      Object.assign(raw, { value: d.target, priority: d.priority, weight: d.weight, port: d.port });
    } else if (type === "CAA") {
      const d = c.data ?? parseCaa(String(c.content ?? ""));
      Object.assign(raw, { value: stripQuotes(String(d.value ?? "")), flags: d.flags ?? 0, tag: d.tag });
    } else if (type === "MX") {
      Object.assign(raw, { value: c.content, priority: c.priority });
    } else {
      raw.value = type === "TXT" ? stripQuotes(String(c.content ?? "")) : c.content;
    }
    const v = validateRecord(zone, raw);
    if (v.ok) records.push(v.data);
    else skipped++;
  }
  return {
    ok: true,
    message: `${records.length} Eintrag/Einträge gefunden${skipped ? `, ${skipped} nicht übernehmbar` : ""}.`,
    data: { zoneId: zone.id, zoneName: zone.name, records, skipped },
  };
}

function parseSrv(content: string): { priority: number; weight: number; port: number; target: string } {
  const [p, w, port, target] = content.split(/\s+/);
  return { priority: Number(p), weight: Number(w), port: Number(port), target: target ?? "" };
}
function parseCaa(content: string): { flags: number; tag: string; value: string } {
  const m = /^(\d+)\s+(\w+)\s+(.*)$/.exec(content.trim());
  return { flags: Number(m?.[1] ?? 0), tag: m?.[2] ?? "issue", value: m?.[3] ?? "" };
}

/* ---------------------------------------------------------------- Dienst */
export type CfInputs = { dns: DnsState; proxy: ProxyState };

/** Hält den letzten Stand und entscheidet, wann abgeglichen wird (Änderung der Dateien oder Zeitintervall). */
export class CloudflareService {
  status: CloudflareStatus;
  private dirty = true;
  private lastRun = 0;
  private running: Promise<CloudflareStatus> | null = null;

  private readonly env: CfEnv;
  private readonly load: () => Promise<CfInputs>;
  private readonly opts: { intervalMs: number; minGapMs: number; client?: CfClient };

  constructor(env: CfEnv, load: () => Promise<CfInputs>, opts: { intervalMs: number; minGapMs: number; client?: CfClient } = { intervalMs: 120_000, minGapMs: 10_000 }) {
    this.env = env;
    this.load = load;
    this.opts = opts;
    this.status = emptyCloudflareStatus(!!env.token);
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Prüft alle paar Sekunden: abgleichen, wenn geändert (mit Mindestabstand) oder Intervall abgelaufen. */
  async syncIfDue(now = Date.now()): Promise<void> {
    if (this.running) return;
    const gap = now - this.lastRun;
    if ((this.dirty && gap >= this.opts.minGapMs) || gap >= this.opts.intervalMs) await this.sync();
  }

  sync(): Promise<CloudflareStatus> {
    if (this.running) return this.running;
    this.dirty = false;
    this.lastRun = Date.now();
    this.running = (async () => {
      try {
        const { dns, proxy } = await this.load();
        const next = await runCloudflareSync(this.env, dns, proxy, this.opts.client);
        this.status = next;
        const sum = summarizeCloudflare(next);
        if (next.configured) log("cloudflare", sum.message);
        return next;
      } finally {
        this.lastRun = Date.now();
        this.running = null;
      }
    })();
    return this.running;
  }
}

