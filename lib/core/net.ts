/**
 * Netzwerk-Grundfunktionen: IPv4/IPv6, CIDR, Hostnamen. Reine Funktionen ohne Abhängigkeiten –
 * genutzt vom Panel (Next.js) und von den Engines (DNS-Server, Proxy, Worker).
 * Alle Dateien in lib/core importieren einander mit ".ts"-Endung, damit Node sie direkt ausführen kann.
 */

export type IpFamily = 4 | 6;
export type ParsedIp = { family: IpFamily; value: bigint };
export type Cidr = { family: IpFamily; base: bigint; prefix: number };

const V4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(s: string): boolean {
  return V4_RE.test(s);
}

export function parseIPv4(s: string): bigint | null {
  if (!V4_RE.test(s)) return null;
  return s.split(".").reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
}

export function formatIPv4(n: bigint): string {
  return [24n, 16n, 8n, 0n].map((sh) => String((n >> sh) & 255n)).join(".");
}

/** Liest eine IPv6-Adresse (auch "::" und eingebettetes IPv4). Rückgabe: 128-Bit-Zahl oder null. */
export function parseIPv6(input: string): bigint | null {
  let s = input.trim().toLowerCase();
  if (!s || s.includes("%") || /[^0-9a-f:.]/.test(s)) return null;
  // eingebettetes IPv4 am Ende (::ffff:1.2.3.4)
  const lastColon = s.lastIndexOf(":");
  let tail = "";
  if (s.includes(".")) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = `${Number((v4 >> 16n) & 0xffffn).toString(16)}:${Number(v4 & 0xffffn).toString(16)}`;
    s = s.slice(0, lastColon + 1) + tail;
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(":") : [];
  const rest = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : [];
  let groups: string[];
  if (dbl.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

export function isIPv6(s: string): boolean {
  return parseIPv6(s) !== null;
}

/** Kürzeste Schreibweise einer IPv6-Adresse (RFC 5952). */
export function formatIPv6(n: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(":");
  const left = groups.slice(0, bestStart).map((g) => g.toString(16)).join(":");
  const right = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(":");
  return `${left}::${right}`;
}

export function parseIp(s: string): ParsedIp | null {
  const t = s.trim();
  const v4 = parseIPv4(t);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseIPv6(t);
  if (v6 !== null) return { family: 6, value: v6 };
  return null;
}

export const isIp = (s: string): boolean => parseIp(s) !== null;

export function formatIp(p: ParsedIp): string {
  return p.family === 4 ? formatIPv4(p.value) : formatIPv6(p.value);
}

/** Einheitliche Schreibweise (IPv6 verkürzt und klein). Ungültig -> null. */
export function normalizeIp(s: string): string | null {
  const p = parseIp(s);
  return p ? formatIp(p) : null;
}

export function parseCidr(s: string): Cidr | null {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const ip = parseIp(m[1]!);
  const prefix = Number(m[2]);
  if (!ip) return null;
  const bits = ip.family === 4 ? 32 : 128;
  if (prefix > bits) return null;
  const hostBits = BigInt(bits - prefix);
  const base = (ip.value >> hostBits) << hostBits;
  return { family: ip.family, base, prefix };
}

export const isCidr = (s: string): boolean => parseCidr(s) !== null;

export function formatCidr(c: Cidr): string {
  return `${c.family === 4 ? formatIPv4(c.base) : formatIPv6(c.base)}/${c.prefix}`;
}

/** Liegt die Adresse im Netz? Ein Eintrag ohne "/" gilt als einzelne Adresse. */
export function cidrContains(cidr: string, ip: string): boolean {
  const addr = parseIp(ip);
  if (!addr) return false;
  const c = cidr.includes("/") ? parseCidr(cidr) : (() => {
    const single = parseIp(cidr);
    return single ? { family: single.family, base: single.value, prefix: single.family === 4 ? 32 : 128 } : null;
  })();
  if (!c || c.family !== addr.family) return false;
  const bits = c.family === 4 ? 32 : 128;
  const hostBits = BigInt(bits - c.prefix);
  return addr.value >> hostBits === c.base >> hostBits;
}

export const inAnyNet = (nets: readonly string[], ip: string): boolean => nets.some((n) => cidrContains(n, ip));

/** Anzahl der Adressen im Netz (als Zahl; bei riesigen IPv6-Netzen gedeckelt). */
export function cidrSize(c: Cidr): number {
  const bits = c.family === 4 ? 32 : 128;
  const host = bits - c.prefix;
  return host > 30 ? 2 ** 30 : 2 ** host;
}

export type AddressKind = "network" | "broadcast" | "host";
export const MAX_SUBNET_ADDRESSES = 4096;

/** Alle IPv4-Adressen eines Netzes (höchstens 4096, also bis /20). Netz- und Broadcast-Adresse sind markiert. */
export function ipv4Addresses(cidr: string): { ip: string; kind: AddressKind }[] {
  const c = parseCidr(cidr);
  if (!c || c.family !== 4) return [];
  const n = cidrSize(c);
  if (n > MAX_SUBNET_ADDRESSES) return [];
  const out: { ip: string; kind: AddressKind }[] = [];
  for (let i = 0; i < n; i++) {
    const kind: AddressKind = c.prefix <= 30 && i === 0 ? "network" : c.prefix <= 30 && i === n - 1 ? "broadcast" : "host";
    out.push({ ip: formatIPv4(c.base + BigInt(i)), kind });
  }
  return out;
}

export function isPrivateIPv4(ip: string): boolean {
  return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10"].some((n) => cidrContains(n, ip));
}

/** Private, lokale und Docker-Netze: Standard für "interne" Anfragen an den DNS-Server. */
export const DEFAULT_INTERNAL_NETS = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7", "fe80::/10"] as const;

/** Name für Rückwärtsauflösung: 203.0.113.5 -> 5.113.0.203.in-addr.arpa */
export function ptrName(ip: string): string | null {
  const p = parseIp(ip);
  if (!p) return null;
  if (p.family === 4) return `${formatIPv4(p.value).split(".").reverse().join(".")}.in-addr.arpa`;
  const hex = p.value.toString(16).padStart(32, "0");
  return `${hex.split("").reverse().join(".")}.ip6.arpa`;
}

/* ------------------------------------------------------------- Hostnamen */
const LABEL_RE = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/** Kleinschreibung, ohne Punkt am Ende. */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, "");
}

export function isValidLabel(l: string): boolean {
  return LABEL_RE.test(l) || l === "*";
}

/** Gültiger Hostname/Domainname (Unterstriche erlaubt wegen _dmarc, _srv usw.). Wildcard nur als erstes Label. */
export function isValidFqdn(raw: string, opts: { allowWildcard?: boolean } = {}): boolean {
  const s = normalizeName(raw);
  if (!s || s.length > 253) return false;
  const labels = s.split(".");
  return labels.every((l, i) => (l === "*" ? !!opts.allowWildcard && i === 0 : LABEL_RE.test(l)));
}

/** Hängt den relativen Namen an die Zone ("@" = Zone selbst). */
export function fqdn(zone: string, name: string): string {
  const n = normalizeName(name);
  if (n === "" || n === "@") return zone;
  return n === zone || n.endsWith(`.${zone}`) ? n : `${n}.${zone}`;
}

export const isSubdomainOf = (name: string, zone: string): boolean => name === zone || name.endsWith(`.${zone}`);

export function randomId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}
