/**
 * Server (VMs) und IP-Verwaltung (IPAM). Datei: inventory.json im Daten-Volume (gehört dem Panel).
 *
 * Eine VM kann beliebig viele IP-Adressen haben: Jede Zuordnung ist ein Eintrag in `ips` mit `serverId`.
 * Adressen ohne Eintrag gelten als "frei". Erreichbarkeit kommt getrennt vom Worker (runtime/scan.json).
 */
import {
  cidrContains,
  ipv4Addresses,
  isValidFqdn,
  normalizeIp,
  normalizeName,
  parseCidr,
  formatCidr,
  parseIp,
  randomId,
} from "./net.ts";

export type IpStatus = "free" | "assigned" | "reserved" | "blocked";
export const ipStatusLabels: Record<IpStatus, string> = {
  free: "Frei",
  assigned: "Zugewiesen",
  reserved: "Reserviert",
  blocked: "Gesperrt",
};

export type Subnet = {
  id: string;
  name: string;
  cidr: string;
  gateway?: string;
  vlan?: number;
  /** öffentlich (vom Internet aus routbar) oder privat */
  scope: "public" | "private";
  /** Worker prüft die Erreichbarkeit der Adressen */
  scan: boolean;
  comment?: string;
};

export type IpEntry = {
  ip: string;
  status: Exclude<IpStatus, "free">;
  serverId?: string;
  /** Rückwärts-Eintrag (PTR) */
  ptr?: string;
  note?: string;
};

export type Server = {
  id: string;
  /** Kurzname, wird zum Domainnamen: web01 -> web01.server.vylaris.it */
  name: string;
  role?: string;
  /** Proxmox-Knoten und VM-ID (für Traffic und Status) */
  node?: string;
  vmid?: number;
  /** Beim Auflösen aus dem Internet sichtbar? Standard: nein (Ursprungs-IP bleibt geschützt). */
  dnsVisibility: "internal" | "public";
  /** Hauptadresse für Proxy und DNS (sonst die erste zugewiesene) */
  primaryIp?: string;
  note?: string;
};

export type InventorySettings = {
  /** Unterdomain für Server-Namen, z. B. server.vylaris.it */
  serverDomain: string;
};

export type Inventory = {
  version: 1;
  settings: InventorySettings;
  subnets: Subnet[];
  ips: IpEntry[];
  servers: Server[];
  updatedAt?: string;
};

export const defaultInventory = (): Inventory => ({
  version: 1,
  settings: { serverDomain: "server.vylaris.it" },
  subnets: [],
  ips: [],
  servers: [],
});

/* --------------------------------------------------------------- Prüfen */
export type Result<T> = { ok: true; data: T } | { ok: false; errors: string[] };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v).slice(0, max) : "");
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;

export function validateSubnet(raw: Record<string, unknown>, existing: Subnet[] = []): Result<Subnet> {
  const errors: string[] = [];
  const cidr = parseCidr(str(raw.cidr, 64));
  if (!cidr || cidr.family !== 4) errors.push("Netz: gültiges IPv4-Netz wie 203.0.113.0/28 eingeben.");
  else if (cidr.prefix < 20) errors.push("Netz: höchstens 4096 Adressen (kleinste Vorsilbe /20).");
  const name = str(raw.name, 60);
  if (!name) errors.push("Name fehlt.");
  const gw = str(raw.gateway, 64);
  const gateway = gw ? normalizeIp(gw) : null;
  if (gw && (!gateway || !cidr || !cidrContains(formatCidr(cidr), gateway))) errors.push("Gateway muss eine Adresse im Netz sein.");
  const vlanRaw = str(raw.vlan, 5);
  const vlan = vlanRaw ? Number(vlanRaw) : undefined;
  if (vlanRaw && !(Number.isInteger(vlan) && vlan! >= 1 && vlan! <= 4094)) errors.push("VLAN: Zahl von 1 bis 4094.");
  const id = str(raw.id, 20) || randomId();
  if (cidr) {
    const cidrText = formatCidr(cidr);
    if (existing.some((s) => s.id !== id && s.cidr === cidrText)) errors.push("Dieses Netz gibt es schon.");
  }
  if (errors.length || !cidr) return { ok: false, errors };
  return {
    ok: true,
    data: {
      id,
      name,
      cidr: formatCidr(cidr),
      gateway: gateway ?? undefined,
      vlan,
      scope: raw.scope === "private" ? "private" : "public",
      scan: raw.scan === "on" || raw.scan === true || raw.scan === "true",
      comment: str(raw.comment, 200) || undefined,
    },
  };
}

export function validateServer(raw: Record<string, unknown>, existing: Server[] = []): Result<Server> {
  const errors: string[] = [];
  const name = str(raw.name, 42).toLowerCase();
  if (!NAME_RE.test(name)) errors.push("Name: 1–42 Zeichen, nur a–z, 0–9 und Bindestrich (z. B. web01).");
  const id = str(raw.id, 20) || randomId();
  if (existing.some((s) => s.id !== id && s.name === name)) errors.push("Diesen Server-Namen gibt es schon.");
  const vmRaw = str(raw.vmid, 9);
  const vmid = vmRaw ? Number(vmRaw) : undefined;
  if (vmRaw && !(Number.isInteger(vmid) && vmid! >= 100 && vmid! <= 999999999)) errors.push("VM-ID: ganze Zahl ab 100.");
  const node = str(raw.node, 60) || undefined;
  if (node && !/^[A-Za-z0-9._-]+$/.test(node)) errors.push("Proxmox-Knoten: nur Buchstaben, Zahlen, Punkt, Bindestrich.");
  const primRaw = str(raw.primaryIp, 64);
  const primaryIp = primRaw ? normalizeIp(primRaw) : null;
  if (primRaw && !primaryIp) errors.push("Hauptadresse ist keine gültige IP-Adresse.");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      id,
      name,
      role: str(raw.role, 60) || undefined,
      node,
      vmid,
      dnsVisibility: raw.dnsVisibility === "public" ? "public" : "internal",
      primaryIp: primaryIp ?? undefined,
      note: str(raw.note, 300) || undefined,
    },
  };
}

export function validateIpEntry(raw: Record<string, unknown>): Result<IpEntry> {
  const ip = normalizeIp(str(raw.ip, 64));
  if (!ip) return { ok: false, errors: ["Keine gültige IP-Adresse."] };
  const status = raw.status === "reserved" || raw.status === "blocked" || raw.status === "assigned" ? raw.status : null;
  if (!status) return { ok: false, errors: ["Status: zugewiesen, reserviert oder gesperrt."] };
  const serverId = str(raw.serverId, 20) || undefined;
  if (status === "assigned" && !serverId) return { ok: false, errors: ["Für „zugewiesen“ einen Server wählen."] };
  const ptr = str(raw.ptr, 253);
  if (ptr && !isValidFqdn(ptr)) return { ok: false, errors: ["PTR ist kein gültiger Hostname."] };
  return {
    ok: true,
    data: {
      ip,
      status,
      serverId: status === "assigned" ? serverId : undefined,
      ptr: ptr ? normalizeName(ptr) : undefined,
      note: str(raw.note, 200) || undefined,
    },
  };
}

/** Übernimmt nur Brauchbares; defekte Dateien führen nie zu Fehlern beim Lesen. */
export function sanitizeInventory(raw: unknown): Inventory {
  const base = defaultInventory();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const settings = r.settings as Record<string, unknown> | undefined;
  const sd = typeof settings?.serverDomain === "string" ? normalizeName(settings.serverDomain) : "";
  if (isValidFqdn(sd)) base.settings.serverDomain = sd;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
  for (const s of arr(r.subnets)) {
    const v = validateSubnet(s, base.subnets);
    if (v.ok) base.subnets.push(v.data);
  }
  for (const s of arr(r.servers)) {
    const v = validateServer(s, base.servers);
    if (v.ok) base.servers.push(v.data);
  }
  const seen = new Set<string>();
  for (const e of arr(r.ips)) {
    const v = validateIpEntry(e);
    if (v.ok && !seen.has(v.data.ip) && (v.data.status !== "assigned" || base.servers.some((s) => s.id === v.data.serverId))) {
      seen.add(v.data.ip);
      base.ips.push(v.data);
    }
  }
  if (typeof r.updatedAt === "string") base.updatedAt = r.updatedAt;
  return base;
}

/* ------------------------------------------------------------- Abfragen */
export const serverFqdn = (s: Server, inv: Inventory): string => `${s.name}.${inv.settings.serverDomain}`;

export function serverIps(inv: Inventory, serverId: string): string[] {
  return inv.ips.filter((e) => e.status === "assigned" && e.serverId === serverId).map((e) => e.ip);
}

/** Hauptadresse: ausdrücklich gesetzt (und noch zugewiesen), sonst die erste IPv4, sonst die erste Adresse. */
export function serverPrimaryIp(inv: Inventory, s: Server): string | undefined {
  const ips = serverIps(inv, s.id);
  if (s.primaryIp && ips.includes(s.primaryIp)) return s.primaryIp;
  return ips.find((i) => parseIp(i)?.family === 4) ?? ips[0];
}

export const subnetOf = (inv: Inventory, ip: string): Subnet | undefined => inv.subnets.find((s) => cidrContains(s.cidr, ip));

/* ----------------------------------------------------------- IP-Tabelle */
export type Reach = "up" | "down" | "unknown";
export type ScanHost = { up: boolean; lastChecked: string; lastUp?: string; mac?: string; method?: string; rttMs?: number };
export type ScanData = { updatedAt?: string; hosts: Record<string, ScanHost> };

export type IpRow = {
  ip: string;
  kind: "network" | "broadcast" | "host";
  isGateway: boolean;
  status: IpStatus;
  entry?: IpEntry;
  serverId?: string;
  reach: Reach;
  /** Hinweis, der Aufmerksamkeit braucht */
  alert?: "free-but-up" | "assigned-but-down" | "reserved-but-up";
  scan?: ScanHost;
};

export function buildIpRows(inv: Inventory, subnet: Subnet, scan: ScanData | null): IpRow[] {
  const byIp = new Map(inv.ips.map((e) => [e.ip, e]));
  return ipv4Addresses(subnet.cidr).map(({ ip, kind }) => {
    const entry = byIp.get(ip);
    const isGateway = subnet.gateway === ip;
    const status: IpStatus = entry ? entry.status : "free";
    const sc = scan?.hosts[ip];
    const reach: Reach = !subnet.scan || !sc ? "unknown" : sc.up ? "up" : "down";
    let alert: IpRow["alert"];
    if (kind === "host" && !isGateway && reach !== "unknown") {
      if (status === "free" && reach === "up") alert = "free-but-up";
      else if (status === "assigned" && reach === "down") alert = "assigned-but-down";
      else if (status === "reserved" && reach === "up") alert = "reserved-but-up";
    }
    return { ip, kind, isGateway, status, entry, serverId: entry?.serverId, reach, alert, scan: sc };
  });
}

export type SubnetSummary = { total: number; usable: number; free: number; assigned: number; reserved: number; blocked: number; alerts: number };

export function summarizeRows(rows: IpRow[]): SubnetSummary {
  const hosts = rows.filter((r) => r.kind === "host");
  const count = (st: IpStatus) => hosts.filter((r) => r.status === st && !r.isGateway).length;
  return {
    total: rows.length,
    usable: hosts.length,
    free: count("free"),
    assigned: count("assigned"),
    reserved: count("reserved"),
    blocked: count("blocked"),
    alerts: rows.filter((r) => r.alert).length,
  };
}

/** Nächste freie Adressen eines Netzes (ohne Gateway, Netz- und Broadcast-Adresse). */
export function nextFree(inv: Inventory, subnet: Subnet, scan: ScanData | null, limit = 1): string[] {
  return buildIpRows(inv, subnet, scan)
    .filter((r) => r.kind === "host" && !r.isGateway && r.status === "free" && r.reach !== "up")
    .slice(0, limit)
    .map((r) => r.ip);
}

/** Setzt eine Zuordnung (oder entfernt sie mit status "free"). Gibt neue Liste zurück, ändert nichts am Original. */
export function setIpEntry(inv: Inventory, entry: IpEntry | { ip: string; status: "free" }): Inventory {
  const ips = inv.ips.filter((e) => e.ip !== entry.ip);
  if (entry.status !== "free") ips.push(entry);
  ips.sort((a, b) => (parseIp(a.ip)!.value < parseIp(b.ip)!.value ? -1 : 1));
  return { ...inv, ips };
}
