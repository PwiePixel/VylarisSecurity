/**
 * Gemeinsame Hilfen der Engines (DNS-Server, Proxy, Worker): Daten lesen, atomar schreiben, Änderungen beobachten.
 * Nur Node-Bordmittel, keine Abhängigkeiten. Die Konfiguration gehört dem Panel – Engines lesen sie nur;
 * geschrieben wird ausschließlich in runtime/ (und runtime/results/ für den Worker).
 */
import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { defaultInventory, sanitizeInventory, type Inventory } from "../../lib/core/inventory-model.ts";
import { defaultDnsState, sanitizeDnsState, type DnsState } from "../../lib/core/dns-model.ts";
import { sanitizeProxyState, type ProxyState } from "../../lib/core/proxy-model.ts";
import { defaultIntegrations, FILES, type Integrations } from "../../lib/core/runtime-model.ts";

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "/data");
export const abs = (rel: string): string => path.join(DATA_DIR, rel);
export const nowIso = (): string => new Date().toISOString();

export async function readJson<T>(rel: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(abs(rel), "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    log("data", `${rel} nicht lesbar: ${(e as Error).message}`);
    return fallback;
  }
}

/** Atomar schreiben (temporäre Datei + Umbenennen); legt Ordner an. */
export async function writeJsonAtomic(rel: string, value: unknown): Promise<void> {
  const target = abs(rel);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o644 });
  await fs.rename(tmp, target);
}

export function log(component: string, message: string): void {
  console.log(`${new Date().toISOString()} [${component}] ${message}`);
}

/** Sekundenscharfe Prüfung auf Änderungen: Größe + Änderungszeit der Datei (nicht der Inhalt). */
export function fileSignature(rel: string): string {
  try {
    const st = statSync(abs(rel));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * Beobachtet Dateien und ruft `onChange` bei Änderung (und einmal sofort). Fehler im Callback stoppen nichts.
 * Rückgabe: Funktion zum Beenden.
 */
export function watchFiles(rels: string[], onChange: () => void | Promise<void>, intervalMs = 2000): () => void {
  let last = "";
  let running = false;
  const tick = async () => {
    const sig = rels.map(fileSignature).join("|");
    if (sig === last || running) return;
    running = true;
    last = sig;
    try {
      await onChange();
    } catch (e) {
      log("data", `Neuladen fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export const loadInventory = async (): Promise<Inventory> => sanitizeInventory(await readJson<unknown>(FILES.inventory, defaultInventory()));
export const loadDns = async (): Promise<DnsState> => sanitizeDnsState(await readJson<unknown>(FILES.dns, defaultDnsState()));
export const loadProxy = async (inv?: Inventory): Promise<ProxyState> => sanitizeProxyState(await readJson<unknown>(FILES.proxy, null), inv ?? (await loadInventory()));
export const loadIntegrations = async (): Promise<Integrations> => {
  const raw = await readJson<Partial<Integrations>>(FILES.integrations, {});
  const d = defaultIntegrations();
  return {
    proxmox: { ...d.proxmox, ...(raw.proxmox ?? {}) },
    cloudflare: { ...d.cloudflare, ...(raw.cloudflare ?? {}) },
  };
};

/** Zählt pro Minute (UTC-Minute als Schlüssel) und hält die letzten 60 Minuten. */
export function bumpMinute<T extends { t: number }>(list: T[], make: (t: number) => T, apply: (x: T) => void, now = Date.now()): void {
  const t = Math.floor(now / 60000) * 60000;
  let last = list[list.length - 1];
  if (!last || last.t !== t) {
    last = make(t);
    list.push(last);
    while (list.length > 60) list.shift();
  }
  apply(last);
}
