/**
 * ALIAS-Auflösung ("CNAME am Zonenanfang"): Der Ziel-Name wird zur Laufzeit bei einem öffentlichen Resolver
 * zu A/AAAA aufgelöst und zwischengespeichert. Anfragen werden nie lange blockiert:
 *  - frischer Cache-Eintrag: sofort,
 *  - sonst eine Abfrage mit Zeitlimit (Standard 1,5 s); die Abfrage läuft auch nach dem Zeitlimit weiter
 *    und füllt den Cache für die nächste Anfrage,
 *  - schlägt sie fehl und gibt es einen alten Eintrag (bis 24 h), wird dieser kurz weiterverwendet (stale-while-error).
 */
import { promises as dnsPromises } from "node:dns";

export type AliasResult = { addresses: string[]; ttl: number };
export type AliasFetch = (host: string, family: 4 | 6) => Promise<AliasResult>;
export type AliasResolver = { resolve(host: string, family: 4 | 6): Promise<AliasResult>; size(): number };

type Entry = { result: AliasResult; expires: number; fetchedAt: number };

export const DEFAULT_UPSTREAM = ["1.1.1.1", "9.9.9.9"];
const MAX_TTL = 300;
const MIN_TTL = 10;
const STALE_MAX_MS = 24 * 3600_000;
const MAX_ENTRIES = 5000;

/** Standard-Abfrage über node:dns gegen die angegebenen Resolver. */
export function nodeDnsFetch(upstream: string[], timeoutMs = 1200): AliasFetch {
  const resolver = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers(upstream);
  return async (host, family) => {
    try {
      const recs = await (family === 4 ? resolver.resolve4(host, { ttl: true }) : resolver.resolve6(host, { ttl: true }));
      const ttl = recs.length ? Math.min(...recs.map((r) => r.ttl)) : 60;
      return { addresses: recs.map((r) => r.address), ttl };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENODATA" || code === "ENOTFOUND") return { addresses: [], ttl: 60 }; // gibt es nicht: kurz merken
      throw e;
    }
  };
}

export function createAliasResolver(opts: { upstream?: string[]; fetch?: AliasFetch; timeoutMs?: number; now?: () => number } = {}): AliasResolver {
  const fetchFn = opts.fetch ?? nodeDnsFetch(opts.upstream ?? DEFAULT_UPSTREAM);
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<AliasResult>>();

  const startFetch = (key: string, host: string, family: 4 | 6): Promise<AliasResult> => {
    const running = inflight.get(key);
    if (running) return running;
    const p = fetchFn(host, family).then(
      (res) => {
        const ttl = Math.max(MIN_TTL, Math.min(res.ttl, MAX_TTL));
        cache.delete(key);
        cache.set(key, { result: { addresses: res.addresses, ttl }, expires: now() + ttl * 1000, fetchedAt: now() });
        while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
        return { addresses: res.addresses, ttl };
      },
    );
    inflight.set(key, p);
    const clear = () => inflight.delete(key);
    p.then(clear, clear);
    p.catch(() => undefined); // läuft evtl. nach dem Zeitlimit weiter, Fehler sind dann egal
    return p;
  };

  return {
    size: () => cache.size,
    async resolve(host, family) {
      const key = `${family}:${host}`;
      const hit = cache.get(key);
      const t = now();
      if (hit && hit.expires > t) return { addresses: hit.result.addresses, ttl: Math.max(1, Math.ceil((hit.expires - t) / 1000)) };
      try {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Zeitlimit bei der ALIAS-Auflösung")), timeoutMs);
        });
        try {
          return await Promise.race([startFetch(key, host, family), timeout]);
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        if (hit && t - hit.fetchedAt < STALE_MAX_MS) return { addresses: hit.result.addresses, ttl: 30 }; // alter Stand, kurz gültig
        throw e;
      }
    },
  };
}
