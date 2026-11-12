import { compileZones, defaultDnsState, sanitizeDnsState, serialNow, type DnsState } from "@/lib/core/dns-model";
import { FILES } from "@/lib/core/runtime-model";
import { getInventory } from "./inventory";
import { readJson, withLock, writeJson } from "./store";

export async function getDns(): Promise<DnsState> {
  try {
    return sanitizeDnsState(await readJson<unknown>(FILES.dns, defaultDnsState()));
  } catch {
    return defaultDnsState();
  }
}

/**
 * Ändert den DNS-Stand atomar. `touched` nennt die Zonen-IDs, deren Seriennummer erhöht wird
 * (Nameserver erkennen daran Änderungen). Bei { error } wird nichts gespeichert.
 */
export function mutateDns(fn: (dns: DnsState) => Promise<DnsState | { error: string }> | DnsState | { error: string }, touched: string[] = []): Promise<{ error: string } | { ok: true; dns: DnsState }> {
  return withLock(async () => {
    const current = await getDns();
    const next = await fn(structuredClone(current));
    if ("error" in next) return { error: next.error };
    const now = new Date().toISOString();
    for (const z of next.zones) {
      if (touched.includes(z.id)) {
        z.serial = serialNow(z.serial);
        z.updatedAt = now;
      }
    }
    const clean = sanitizeDnsState(next);
    clean.updatedAt = now;
    await writeJson(FILES.dns, clean);
    return { ok: true as const, dns: clean };
  });
}

/** Was der DNS-Server tatsächlich ausliefert (für die Vorschau im Panel). */
export async function getCompiled() {
  const [dns, inv] = await Promise.all([getDns(), getInventory()]);
  return compileZones(dns, inv);
}
