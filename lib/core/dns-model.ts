/**
 * DNS-Modell: Zonen und Einträge (Datei dns.json, gehört dem Panel) und das Übersetzen in die
 * Form, die der DNS-Server ausliefert (compileZones). Reine Funktionen ohne Abhängigkeiten.
 *
 * Betriebsarten einer Zone:
 *  - "authoritative": unsere Nameserver (ns1/ns2) beantworten die Zone selbst.
 *  - "cloudflare":    die Zone liegt bei Cloudflare; das Panel pflegt sie und der Worker gleicht sie per API ab.
 *
 * Einträge können als "protect" markiert werden: Der DNS-Server liefert dann statt der Ursprungs-IP den
 * Cloudflare-Edge-Namen (CNAME bzw. ALIAS am Zonenanfang) – Cloudflare schützt vor DDoS, die echte IP bleibt verborgen.
 */
import {
  DEFAULT_INTERNAL_NETS,
  fqdn,
  isCidr,
  isIPv4,
  isSubdomainOf,
  isValidFqdn,
  normalizeIp,
  normalizeName,
  parseIp,
  parseIPv6,
  formatIPv6,
  ptrName,
  randomId,
} from "./net.ts";
import { serverFqdn, serverIps, type Inventory } from "./inventory-model.ts";

export const recordTypes = ["A", "AAAA", "CNAME", "ALIAS", "MX", "TXT", "NS", "SRV", "CAA", "PTR"] as const;
export type RecordType = (typeof recordTypes)[number];
export type Visibility = "public" | "internal";
export type ZoneMode = "authoritative" | "cloudflare";

export type DnsRecord = {
  id: string;
  /** relativ zur Zone; "@" = Zonenanfang; "*" = Wildcard */
  name: string;
  type: RecordType;
  ttl: number;
  /** A/AAAA: IP · CNAME/ALIAS/NS/PTR/MX/SRV: Zielname · TXT: Text · CAA: Wert */
  value: string;
  /** MX, SRV */
  priority?: number;
  weight?: number;
  port?: number;
  /** CAA */
  flags?: number;
  tag?: string;
  visibility: Visibility;
  /** Über Cloudflare absichern (nur A, AAAA, CNAME) */
  protect?: boolean;
  /** Cloudflare-Zone: orange Wolke */
  proxied?: boolean;
  comment?: string;
};

export type Soa = { rname: string; refresh: number; retry: number; expire: number; minimum: number };

export type DnsZone = {
  id: string;
  name: string;
  mode: ZoneMode;
  soa: Soa;
  /** Seriennummer, wird bei jeder Änderung erhöht */
  serial: number;
  defaultTtl: number;
  records: DnsRecord[];
  comment?: string;
  updatedAt?: string;
};

export type Nameserver = { host: string; ipv4?: string; ipv6?: string };

export type DnsSettings = {
  nameservers: Nameserver[];
  /** Anfragen aus diesen Netzen sehen auch "interne" Einträge */
  internalNets: string[];
  /** Cloudflare-Absicherung für Einträge mit protect */
  edge: { enabled: boolean; target: string };
  /** Obergrenze für Anfragen pro Adresse und Sekunde (0 = aus) */
  rateLimitPerSecond: number;
};

export type DnsState = { version: 1; settings: DnsSettings; zones: DnsZone[]; updatedAt?: string };

export const defaultDnsState = (): DnsState => ({
  version: 1,
  settings: {
    nameservers: [{ host: "ns1.vylaris.it" }, { host: "ns2.vylaris.it" }],
    internalNets: [...DEFAULT_INTERNAL_NETS],
    edge: { enabled: false, target: "" },
    rateLimitPerSecond: 40,
  },
  zones: [],
});

/* --------------------------------------------------------------- Prüfen */
export type Result<T> = { ok: true; data: T } | { ok: false; errors: string[] };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v).slice(0, max) : "");
const intIn = (v: unknown, min: number, max: number): number | null => {
  const s = typeof v === "number" ? String(v) : str(v, 12);
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};

export const MIN_TTL = 30;
export const MAX_TTL = 86400;

/** Relativer Name aus Eingabe ("www", "www.example.com", "@", "example.com"). */
export function relativeName(zone: string, input: string): string | null {
  const n = normalizeName(input);
  if (n === "" || n === "@" || n === zone) return "@";
  const rel = n.endsWith(`.${zone}`) ? n.slice(0, -zone.length - 1) : n;
  return isValidFqdn(rel, { allowWildcard: true }) && isValidFqdn(`${rel}.${zone}`, { allowWildcard: true }) ? rel : null;
}

export function validateRecord(zone: DnsZone, raw: Record<string, unknown>): Result<DnsRecord> {
  const errors: string[] = [];
  const type = str(raw.type, 10).toUpperCase() as RecordType;
  if (!recordTypes.includes(type)) return { ok: false, errors: ["Unbekannter Eintragstyp."] };
  const name = relativeName(zone.name, str(raw.name, 253));
  if (name === null) errors.push("Name ungültig (erlaubt: Buchstaben, Zahlen, Bindestrich, Unterstrich, * am Anfang).");
  const ttlRaw = str(raw.ttl, 8);
  const ttl = ttlRaw ? intIn(ttlRaw, MIN_TTL, MAX_TTL) : zone.defaultTtl;
  if (ttl === null) errors.push(`TTL: ${MIN_TTL}–${MAX_TTL} Sekunden.`);
  let value = str(raw.value, 2000);
  const rec: DnsRecord = {
    id: str(raw.id, 20) || randomId(),
    name: name ?? "@",
    type,
    ttl: ttl ?? zone.defaultTtl,
    value,
    visibility: raw.visibility === "internal" ? "internal" : "public",
    comment: str(raw.comment, 200) || undefined,
  };

  switch (type) {
    case "A":
      if (!isIPv4(value)) errors.push("A: gültige IPv4-Adresse nötig.");
      break;
    case "AAAA": {
      const v6 = parseIPv6(value);
      if (v6 === null) errors.push("AAAA: gültige IPv6-Adresse nötig.");
      else rec.value = formatIPv6(v6);
      break;
    }
    case "CNAME":
    case "ALIAS":
    case "NS":
    case "PTR":
    case "MX":
    case "SRV": {
      value = normalizeName(value);
      if (!isValidFqdn(value)) errors.push(`${type}: Zielname ungültig (vollständiger Name, z. B. host.example.com).`);
      rec.value = value;
      break;
    }
    case "TXT":
      if (!value) errors.push("TXT: Text fehlt.");
      if (/[^\x20-\x7e -￿]/.test(value)) errors.push("TXT: Steuerzeichen sind nicht erlaubt.");
      break;
    case "CAA":
      if (!value) errors.push("CAA: Wert fehlt (z. B. letsencrypt.org).");
      break;
  }
  if (type === "MX" || type === "SRV") {
    const p = intIn(raw.priority, 0, 65535);
    if (p === null) errors.push(`${type}: Priorität 0–65535.`);
    else rec.priority = p;
  }
  if (type === "SRV") {
    const w = intIn(raw.weight, 0, 65535);
    const port = intIn(raw.port, 0, 65535);
    if (w === null) errors.push("SRV: Gewicht 0–65535.");
    else rec.weight = w;
    if (port === null) errors.push("SRV: Port 0–65535.");
    else rec.port = port;
  }
  if (type === "CAA") {
    const f = intIn(raw.flags ?? "0", 0, 255);
    const tag = str(raw.tag, 20).toLowerCase();
    if (f === null) errors.push("CAA: Flags 0–255.");
    else rec.flags = f;
    if (!["issue", "issuewild", "iodef"].includes(tag)) errors.push("CAA: Tag issue, issuewild oder iodef.");
    else rec.tag = tag;
  }
  if (type === "PTR" || type === "NS") {
    // PTR und NS sind für öffentliche Auflösung gedacht; interne Sichtbarkeit bleibt erlaubt.
  }
  const flag = (v: unknown) => v === "on" || v === true || v === "true";
  if (flag(raw.protect)) {
    if (!["A", "AAAA", "CNAME"].includes(type)) errors.push("Cloudflare-Schutz geht nur bei A, AAAA und CNAME.");
    else if (zone.mode !== "authoritative") errors.push("Cloudflare-Schutz gilt nur in Zonen, die wir selbst beantworten. In Cloudflare-Zonen nutze die orange Wolke (proxied).");
    else if (rec.visibility === "internal") errors.push("Interne Einträge brauchen keinen Cloudflare-Schutz.");
    else rec.protect = true;
  }
  if (flag(raw.proxied)) {
    if (zone.mode !== "cloudflare") errors.push("„Proxied“ gibt es nur in Cloudflare-Zonen.");
    else if (!["A", "AAAA", "CNAME"].includes(type)) errors.push("Proxied geht nur bei A, AAAA und CNAME.");
    else rec.proxied = true;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: rec };
}

/** Prüft das Gesamtbild einer Zone: CNAME exklusiv, keine Doppelten, ALIAS nicht neben A/AAAA/CNAME. */
export function checkZoneRecords(records: DnsRecord[]): string[] {
  const errors: string[] = [];
  const byName = new Map<string, DnsRecord[]>();
  for (const r of records) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  for (const [name, rs] of byName) {
    const label = name === "@" ? "Zonenanfang (@)" : name;
    if (rs.some((r) => r.type === "CNAME") && rs.length > 1) errors.push(`${label}: Ein CNAME darf nicht neben anderen Einträgen stehen.`);
    if (rs.filter((r) => r.type === "CNAME").length > 1) errors.push(`${label}: Nur ein CNAME je Name.`);
    if (rs.some((r) => r.type === "ALIAS") && rs.some((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME")) {
      errors.push(`${label}: ALIAS und A/AAAA/CNAME schließen sich aus.`);
    }
    const seen = new Set<string>();
    for (const r of rs) {
      const key = `${r.type}|${r.value}|${r.priority ?? ""}|${r.port ?? ""}|${r.visibility}`;
      if (seen.has(key)) errors.push(`${label}: Doppelter ${r.type}-Eintrag (${r.value}).`);
      seen.add(key);
    }
  }
  return errors;
}

export function validateZoneName(name: string, existing: DnsZone[]): Result<string> {
  const n = normalizeName(name);
  if (!isValidFqdn(n) || !n.includes(".")) return { ok: false, errors: ["Zonenname ungültig (z. B. example.com)."] };
  if (existing.some((z) => z.name === n)) return { ok: false, errors: ["Diese Zone gibt es schon."] };
  return { ok: true, data: n };
}

export function newZone(name: string, mode: ZoneMode): DnsZone {
  return {
    id: randomId(),
    name,
    mode,
    soa: { rname: `hostmaster.${name}`, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300 },
    serial: serialNow(0),
    defaultTtl: 300,
    records: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Seriennummer im Format JJJJMMTTnn; immer größer als die vorherige. */
export function serialNow(previous: number, now = new Date()): number {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  const base = Number(d) * 100;
  return previous >= base ? previous + 1 : base;
}

export function validateSettings(raw: Record<string, unknown>): Result<DnsSettings> {
  const errors: string[] = [];
  const nameservers: Nameserver[] = [];
  for (let i = 1; i <= 4; i++) {
    const host = normalizeName(str(raw[`ns${i}`], 253));
    if (!host) continue;
    if (!isValidFqdn(host)) {
      errors.push(`Nameserver ${i}: Name ungültig.`);
      continue;
    }
    const v4 = str(raw[`ns${i}v4`], 64);
    const v6 = str(raw[`ns${i}v6`], 64);
    if (v4 && !isIPv4(v4)) errors.push(`Nameserver ${i}: IPv4-Adresse ungültig.`);
    if (v6 && parseIPv6(v6) === null) errors.push(`Nameserver ${i}: IPv6-Adresse ungültig.`);
    nameservers.push({ host, ipv4: v4 || undefined, ipv6: v6 ? normalizeIp(v6) ?? undefined : undefined });
  }
  if (nameservers.length < 1) errors.push("Mindestens ein Nameserver nötig.");
  const nets = str(raw.internalNets, 2000).split(/[\s,;]+/).filter(Boolean);
  for (const n of nets) if (!isCidr(n) && !parseIp(n)) errors.push(`Internes Netz „${n}“ ist ungültig (z. B. 10.0.0.0/8).`);
  const edgeTarget = normalizeName(str(raw.edgeTarget, 253));
  const edgeEnabled = raw.edgeEnabled === "on" || raw.edgeEnabled === true || raw.edgeEnabled === "true";
  if (edgeEnabled && !isValidFqdn(edgeTarget)) errors.push("Cloudflare-Absicherung braucht einen gültigen Edge-Namen (z. B. edge.vylaris.eu).");
  const rl = intIn(raw.rateLimitPerSecond ?? "40", 0, 100000);
  if (rl === null) errors.push("Anfragelimit: Zahl von 0 bis 100000.");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    data: { nameservers, internalNets: nets.length ? nets : [...DEFAULT_INTERNAL_NETS], edge: { enabled: edgeEnabled, target: edgeTarget }, rateLimitPerSecond: rl ?? 40 },
  };
}

/** Übernimmt nur Brauchbares aus einer gespeicherten Datei. */
export function sanitizeDnsState(raw: unknown): DnsState {
  const out = defaultDnsState();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const s = r.settings as Record<string, unknown> | undefined;
  if (s && typeof s === "object") {
    const flat: Record<string, unknown> = {
      internalNets: Array.isArray(s.internalNets) ? s.internalNets.join(" ") : "",
      edgeTarget: (s.edge as Record<string, unknown> | undefined)?.target,
      edgeEnabled: (s.edge as Record<string, unknown> | undefined)?.enabled,
      rateLimitPerSecond: s.rateLimitPerSecond,
    };
    (Array.isArray(s.nameservers) ? s.nameservers : []).slice(0, 4).forEach((n, i) => {
      const x = (n ?? {}) as Record<string, unknown>;
      flat[`ns${i + 1}`] = x.host;
      flat[`ns${i + 1}v4`] = x.ipv4;
      flat[`ns${i + 1}v6`] = x.ipv6;
    });
    const v = validateSettings(flat);
    if (v.ok) out.settings = v.data;
  }
  const names: DnsZone[] = [];
  for (const zr of Array.isArray(r.zones) ? r.zones : []) {
    const z = (zr ?? {}) as Record<string, unknown>;
    const name = normalizeName(str(z.name, 253));
    if (!isValidFqdn(name) || !name.includes(".") || names.some((x) => x.name === name)) continue;
    const zone = newZone(name, z.mode === "cloudflare" ? "cloudflare" : "authoritative");
    zone.id = str(z.id, 20) || zone.id;
    const soa = (z.soa ?? {}) as Record<string, unknown>;
    zone.soa = {
      rname: isValidFqdn(str(soa.rname, 253)) ? normalizeName(str(soa.rname, 253)) : zone.soa.rname,
      refresh: intIn(soa.refresh, 60, 2419200) ?? zone.soa.refresh,
      retry: intIn(soa.retry, 60, 2419200) ?? zone.soa.retry,
      expire: intIn(soa.expire, 60, 4838400) ?? zone.soa.expire,
      minimum: intIn(soa.minimum, 30, 86400) ?? zone.soa.minimum,
    };
    zone.serial = intIn(z.serial, 1, 4294967295) ?? zone.serial;
    zone.defaultTtl = intIn(z.defaultTtl, MIN_TTL, MAX_TTL) ?? 300;
    zone.comment = str(z.comment, 200) || undefined;
    zone.updatedAt = typeof z.updatedAt === "string" ? z.updatedAt : undefined;
    zone.records = [];
    for (const rr of Array.isArray(z.records) ? z.records : []) {
      const v = validateRecord(zone, { ...(rr as Record<string, unknown>) });
      if (v.ok) zone.records.push(v.data);
    }
    names.push(zone);
  }
  out.zones = names;
  if (typeof r.updatedAt === "string") out.updatedAt = r.updatedAt;
  return out;
}

/* ----------------------------------------------------------- Übersetzen */
export type RData =
  | { type: "A" | "AAAA"; address: string }
  | { type: "CNAME" | "NS" | "PTR" | "ALIAS"; target: string }
  | { type: "MX"; preference: number; exchange: string }
  | { type: "TXT"; text: string }
  | { type: "SRV"; priority: number; weight: number; port: number; target: string }
  | { type: "CAA"; flags: number; tag: string; value: string }
  | { type: "SOA"; mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number };

export type RR = { name: string; ttl: number; internal: boolean; data: RData; source?: "zone" | "server" | "glue" | "edge" | "ptr" | "ns" | "soa" };
export type CompiledZone = { name: string; soa: RR; rrs: RR[] };

function toRData(r: DnsRecord): RData | null {
  switch (r.type) {
    case "A":
    case "AAAA":
      return { type: r.type, address: r.value };
    case "CNAME":
    case "NS":
    case "PTR":
    case "ALIAS":
      return { type: r.type, target: r.value };
    case "MX":
      return { type: "MX", preference: r.priority ?? 10, exchange: r.value };
    case "TXT":
      return { type: "TXT", text: r.value };
    case "SRV":
      return { type: "SRV", priority: r.priority ?? 0, weight: r.weight ?? 0, port: r.port ?? 0, target: r.value };
    case "CAA":
      return { type: "CAA", flags: r.flags ?? 0, tag: r.tag ?? "issue", value: r.value };
  }
}

/**
 * Baut aus Panel-Daten die auslieferbaren Zonen:
 * SOA und Zonen-NS (aus den Nameservern), Glue-Adressen, Einträge, Server-Namen aus der Inventar-Liste,
 * PTR-Einträge aus der IP-Verwaltung und die Cloudflare-Edge-Ersetzung für "protect".
 * Cloudflare-Zonen werden nicht ausgeliefert (dort antwortet Cloudflare).
 */
export function compileZones(dns: DnsState, inv: Inventory): { zones: CompiledZone[]; warnings: string[] } {
  const warnings: string[] = [];
  const zones = dns.zones.filter((z) => z.mode === "authoritative");
  const byName = new Map<string, CompiledZone>();
  const edge = dns.settings.edge.enabled && dns.settings.edge.target ? dns.settings.edge.target : "";
  const primaryNs = dns.settings.nameservers[0]?.host ?? `ns1.${zones[0]?.name ?? "example.com"}`;

  for (const z of zones) {
    const rrs: RR[] = [];
    const add = (rr: RR) => {
      if (!rrs.some((x) => x.name === rr.name && x.internal === rr.internal && JSON.stringify(x.data) === JSON.stringify(rr.data))) rrs.push(rr);
    };
    const soa: RR = {
      name: z.name,
      ttl: z.defaultTtl,
      internal: false,
      source: "soa",
      data: { type: "SOA", mname: primaryNs, rname: z.soa.rname, serial: z.serial, refresh: z.soa.refresh, retry: z.soa.retry, expire: z.soa.expire, minimum: z.soa.minimum },
    };
    for (const ns of dns.settings.nameservers) add({ name: z.name, ttl: 3600, internal: false, source: "ns", data: { type: "NS", target: ns.host } });

    const explicit = new Set(z.records.map((r) => `${fqdn(z.name, r.name)}|${r.type}`));
    for (const ns of dns.settings.nameservers) {
      if (!isSubdomainOf(ns.host, z.name)) continue; // Glue nur für Namen in dieser Zone
      if (ns.ipv4 && !explicit.has(`${ns.host}|A`)) add({ name: ns.host, ttl: 3600, internal: false, source: "glue", data: { type: "A", address: ns.ipv4 } });
      if (ns.ipv6 && !explicit.has(`${ns.host}|AAAA`)) add({ name: ns.host, ttl: 3600, internal: false, source: "glue", data: { type: "AAAA", address: ns.ipv6 } });
    }

    for (const r of z.records) {
      const name = fqdn(z.name, r.name);
      if (r.protect && edge && ["A", "AAAA", "CNAME"].includes(r.type)) {
        const apex = name === z.name;
        add({ name, ttl: Math.min(r.ttl, 300), internal: false, source: "edge", data: { type: apex ? "ALIAS" : "CNAME", target: edge } });
        continue;
      }
      const data = toRData(r);
      if (data) add({ name, ttl: r.ttl, internal: r.visibility === "internal", source: "zone", data });
    }
    const cz: CompiledZone = { name: z.name, soa, rrs };
    byName.set(z.name, cz);
  }

  const zoneFor = (name: string): CompiledZone | undefined => {
    let best: CompiledZone | undefined;
    for (const z of byName.values()) if (isSubdomainOf(name, z.name) && (!best || z.name.length > best.name.length)) best = z;
    return best;
  };
  const has = (cz: CompiledZone, name: string, type: string) => cz.rrs.some((r) => r.name === name && r.data.type === type);

  // Server-Namen: web01.server.vylaris.it -> alle zugewiesenen Adressen
  let missingZone = false;
  for (const s of inv.servers) {
    const ips = serverIps(inv, s.id);
    if (ips.length === 0) continue;
    const name = serverFqdn(s, inv);
    const cz = zoneFor(name);
    if (!cz) {
      missingZone = true;
      continue;
    }
    for (const ip of ips) {
      const p = parseIp(ip);
      if (!p) continue;
      const type = p.family === 4 ? "A" : "AAAA";
      if (has(cz, name, type) && cz.rrs.some((r) => r.name === name && r.data.type === type && r.source === "zone")) continue; // manueller Eintrag gewinnt
      cz.rrs.push({ name, ttl: 300, internal: s.dnsVisibility === "internal", source: "server", data: { type, address: p.family === 4 ? ip : normalizeIp(ip)! } });
    }
  }
  if (missingZone) warnings.push(`Für ${inv.settings.serverDomain} gibt es keine Zone, die wir beantworten – Server-Namen werden nicht ausgeliefert. Lege die Zone (oder die Oberzone) an.`);

  // PTR aus der IP-Verwaltung
  for (const e of inv.ips) {
    if (!e.ptr) continue;
    const pn = ptrName(e.ip);
    const cz = pn ? zoneFor(pn) : undefined;
    if (pn && cz) cz.rrs.push({ name: pn, ttl: 3600, internal: false, source: "ptr", data: { type: "PTR", target: e.ptr } });
  }

  return { zones: [...byName.values()], warnings };
}

/** Lesbarer Wert eines Eintrags für Tabellen. */
export function recordValueText(r: DnsRecord): string {
  switch (r.type) {
    case "MX":
      return `${r.priority ?? 10} ${r.value}`;
    case "SRV":
      return `${r.priority ?? 0} ${r.weight ?? 0} ${r.port ?? 0} ${r.value}`;
    case "CAA":
      return `${r.flags ?? 0} ${r.tag ?? "issue"} "${r.value}"`;
    default:
      return r.value;
  }
}
