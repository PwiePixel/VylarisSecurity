import { defaultProxyState, sanitizeProxyState, type ProxyState } from "@/lib/core/proxy-model";
import { FILES } from "@/lib/core/runtime-model";
import { getInventory } from "./inventory";
import { readJson, withLock, writeJson } from "./store";

export async function getProxy(): Promise<ProxyState> {
  try {
    return sanitizeProxyState(await readJson<unknown>(FILES.proxy, null), await getInventory());
  } catch {
    return defaultProxyState();
  }
}

export function mutateProxy(fn: (p: ProxyState) => Promise<ProxyState | { error: string }> | ProxyState | { error: string }): Promise<{ error: string } | { ok: true; proxy: ProxyState }> {
  return withLock(async () => {
    const inv = await getInventory();
    const current = await getProxy();
    const next = await fn(structuredClone(current));
    if ("error" in next) return { error: next.error };
    const clean = sanitizeProxyState(next, inv);
    clean.updatedAt = new Date().toISOString();
    await writeJson(FILES.proxy, clean);
    return { ok: true as const, proxy: clean };
  });
}
