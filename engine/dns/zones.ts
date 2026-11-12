/**
 * Zonen-Index und Antwortlogik des autoritativen DNS-Servers.
 * Index: Zone -> Name -> Typ -> Einträge, getrennt für die öffentliche und die interne Sicht.
 * Die Logik folgt RFC 1034 §4.3.2 (Verweise, CNAME-Ketten) und RFC 4592 (Wildcards).
 */
import { isSubdomainOf } from "../../lib/core/net.ts";
import type { CompiledZone, RR } from "../../lib/core/dns-model.ts";

export type View = {
  names: Map<string, Map<string, RR[]>>;
  /** Namen ohne eigene Einträge, die aber Unter-Namen haben (leere Zwischenknoten) */
  ents: Set<string>;
  /** Delegationspunkte (Namen unterhalb des Zonenanfangs mit NS-Einträgen) */
  delegations: Set<string>;
};
export type ZoneData = { name: string; soa: RR; pub: View; int: View };
export type ZoneIndex = Map<string, ZoneData>;

const newView = (): View => ({ names: new Map(), ents: new Set(), delegations: new Set() });

function addTo(view: View, rr: RR): void {
  let set = view.names.get(rr.name);
  if (!set) view.names.set(rr.name, (set = new Map()));
  const list = set.get(rr.data.type);
  if (list) list.push(rr);
  else set.set(rr.data.type, [rr]);
}

function finish(view: View, apex: string): void {
  for (const name of view.names.keys()) {
    if (name === apex) continue;
    if (view.names.get(name)!.has("NS")) view.delegations.add(name);
    // Vorfahren bis zum Zonenanfang (ausschließlich) sind Zwischenknoten
    let p = name.indexOf(".") >= 0 ? name.slice(name.indexOf(".") + 1) : "";
    while (p && p !== apex && p.length > apex.length) {
      if (!view.names.has(p)) view.ents.add(p);
      p = p.indexOf(".") >= 0 ? p.slice(p.indexOf(".") + 1) : "";
    }
  }
}

/** Baut den Index aus den übersetzten Zonen. */
export function buildIndex(zones: CompiledZone[]): ZoneIndex {
  const index: ZoneIndex = new Map();
  for (const z of zones) {
    const pub = newView();
    const int = newView();
    addTo(pub, z.soa);
    addTo(int, z.soa);
    for (const rr of z.rrs) {
      if (!isSubdomainOf(rr.name, z.name)) continue; // Sicherheitsnetz: nichts außerhalb der Zone
      addTo(int, rr);
      if (!rr.internal) addTo(pub, rr);
    }
    finish(pub, z.name);
    finish(int, z.name);
    index.set(z.name, { name: z.name, soa: z.soa, pub, int });
  }
  return index;
}

/** Zone mit dem längsten passenden Suffix. */
export function findZone(index: ZoneIndex, qname: string): ZoneData | undefined {
  let n = qname;
  for (;;) {
    const z = index.get(n);
    if (z) return z;
    const dot = n.indexOf(".");
    if (dot < 0) return undefined;
    n = n.slice(dot + 1);
  }
}

export type AliasJob = { owner: string; target: string; ttl: number; qtype: "A" | "AAAA"; zone: string };
export type LookupResult = {
  rcode: number;
  aa: boolean;
  answers: RR[];
  authority: RR[];
  additional: RR[];
  alias?: AliasJob;
};

const MAX_CHAIN = 8;

const soaNegative = (z: ZoneData): RR => {
  const d = z.soa.data;
  const minimum = d.type === "SOA" ? d.minimum : z.soa.ttl;
  return { ...z.soa, ttl: Math.min(z.soa.ttl, minimum) };
};

const rename = (rrs: RR[], owner: string): RR[] => rrs.map((r) => (r.name === owner ? r : { ...r, name: owner }));

/** Adressen zu Namen, auf die NS-/MX-/SRV-Einträge zeigen (nur wenn wir sie selbst kennen). */
function addressesFor(view: View, targets: string[], skip: Set<RR> = new Set()): RR[] {
  const out: RR[] = [];
  for (const t of new Set(targets)) {
    const set = view.names.get(t);
    if (!set) continue;
    for (const type of ["A", "AAAA"]) for (const rr of set.get(type) ?? []) if (!skip.has(rr)) out.push(rr);
  }
  return out;
}

function additionalFor(view: View, answers: RR[]): RR[] {
  const targets: string[] = [];
  for (const rr of answers) {
    const d = rr.data;
    if (d.type === "NS") targets.push(d.target);
    else if (d.type === "MX") targets.push(d.exchange);
    else if (d.type === "SRV") targets.push(d.target);
  }
  return addressesFor(view, targets, new Set(answers));
}

function fromSet(z: ZoneData, view: View, owner: string, set: Map<string, RR[]> | undefined, qtype: string, depth: number, prior: RR[]): LookupResult {
  if (qtype === "ANY") {
    // RFC 8482: nur ein kleiner HINFO-Eintrag, damit ANY nicht zur Verstärkung missbraucht wird
    const hinfo: RR = { name: owner, ttl: 3600, internal: false, data: { type: "HINFO", cpu: "RFC8482", os: "" } as never };
    return { rcode: 0, aa: true, answers: [...prior, hinfo], authority: [], additional: [] };
  }
  const cname = set?.get("CNAME");
  if (cname && cname.length > 0 && qtype !== "CNAME") {
    const rr = cname[0]!;
    const answers = [...prior, ...rename([rr], owner)];
    const target = rr.data.type === "CNAME" ? rr.data.target : "";
    if (target && isSubdomainOf(target, z.name) && depth < MAX_CHAIN && !prior.some((p) => p.name === target)) {
      return resolveName(z, view, target, qtype, depth + 1, answers);
    }
    return { rcode: 0, aa: true, answers, authority: [], additional: [] };
  }
  const direct = set?.get(qtype);
  if (direct && direct.length > 0) {
    const answers = [...prior, ...rename(direct, owner)];
    return { rcode: 0, aa: true, answers, authority: [], additional: additionalFor(view, answers) };
  }
  const alias = set?.get("ALIAS")?.[0];
  if ((qtype === "A" || qtype === "AAAA") && alias && alias.data.type === "ALIAS") {
    return {
      rcode: 0,
      aa: true,
      answers: prior,
      authority: [soaNegative(z)], // gilt, falls das Ziel keine Adressen dieser Art hat
      additional: [],
      alias: { owner, target: alias.data.target, ttl: alias.ttl, qtype, zone: z.name },
    };
  }
  return { rcode: 0, aa: true, answers: prior, authority: [soaNegative(z)], additional: [] };
}

function resolveName(z: ZoneData, view: View, qname: string, qtype: string, depth: number, prior: RR[]): LookupResult {
  // 1) Delegation: vom Zonenanfang abwärts den obersten Delegationspunkt suchen
  if (qname !== z.name && view.delegations.size > 0) {
    const labels = qname.slice(0, qname.length - z.name.length - 1).split(".");
    for (let i = labels.length - 1; i >= 0; i--) {
      const n = `${labels.slice(i).join(".")}.${z.name}`;
      if (view.delegations.has(n)) {
        const ns = view.names.get(n)!.get("NS") ?? [];
        const glue = addressesFor(view, ns.map((r) => (r.data.type === "NS" ? r.data.target : "")));
        return { rcode: 0, aa: prior.length > 0, answers: prior, authority: ns, additional: glue };
      }
    }
  }
  // 2) Name vorhanden (mit Einträgen oder als Zwischenknoten)
  const set = view.names.get(qname);
  if (set || view.ents.has(qname)) return fromSet(z, view, qname, set, qtype, depth, prior);

  // 3) Wildcard: nächster vorhandener Vorfahre ("closest encloser"), dann dessen "*"
  let encloser = qname;
  for (;;) {
    const dot = encloser.indexOf(".");
    if (dot < 0) break;
    encloser = encloser.slice(dot + 1);
    if (encloser === z.name || view.names.has(encloser) || view.ents.has(encloser)) break;
  }
  const wild = view.names.get(`*.${encloser}`);
  if (wild && isSubdomainOf(encloser, z.name)) return fromSet(z, view, qname, wild, qtype, depth, prior);

  // 4) Nicht vorhanden
  return { rcode: 3, aa: true, answers: prior, authority: [soaNegative(z)], additional: [] };
}

/** Antwort der Zone auf (Name, Typ). `internal` wählt die interne Sicht. */
export function lookup(z: ZoneData, qname: string, qtype: string, internal: boolean): LookupResult {
  return resolveName(z, internal ? z.int : z.pub, qname, qtype, 0, []);
}

export function countRecords(index: ZoneIndex): number {
  let n = 0;
  for (const z of index.values()) for (const set of z.int.names.values()) for (const list of set.values()) n += list.length;
  return n;
}
