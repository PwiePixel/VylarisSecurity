import { randomBytes } from "node:crypto";
import { defaultIntegrations, FILES, isFresh, type DnsRuntime, type Integrations, type ProxyRuntime, type TrafficData, type WorkerRequest, type WorkerResult, type WorkerRuntime } from "@/lib/core/runtime-model";
import type { ScanData } from "@/lib/core/inventory-model";
import { readJson, withLock, writeJson } from "./store";

/** Laufzeitdaten der Engines (nur lesen). Fehlt eine Datei oder ist sie defekt, ist der Wert null. */
async function safe<T>(file: string): Promise<T | null> {
  try {
    return await readJson<T | null>(file, null);
  } catch {
    return null;
  }
}

export const getDnsRuntime = () => safe<DnsRuntime>(FILES.dnsRuntime);
export const getProxyRuntime = () => safe<ProxyRuntime>(FILES.proxyRuntime);
export const getWorkerRuntime = () => safe<WorkerRuntime>(FILES.workerRuntime);
export const getScan = () => safe<ScanData>(FILES.scan);
export const getTraffic = () => safe<TrafficData>(FILES.traffic);

export async function getIntegrations(): Promise<Integrations> {
  const raw = (await safe<Partial<Integrations>>(FILES.integrations)) ?? {};
  const d = defaultIntegrations();
  return { proxmox: { ...d.proxmox, ...(raw.proxmox ?? {}) }, cloudflare: { ...d.cloudflare, ...(raw.cloudflare ?? {}) } };
}

export function saveIntegrations(i: Integrations): Promise<void> {
  return withLock(() => writeJson(FILES.integrations, i));
}

/** Legt einen Auftrag für den Worker ab (er holt ihn innerhalb weniger Sekunden). */
export async function requestWorker(req: Omit<WorkerRequest, "id" | "at"> & Record<string, unknown>): Promise<string> {
  const id = randomBytes(8).toString("hex");
  const full = { ...req, id, at: new Date().toISOString() } as WorkerRequest;
  await writeJson(`${FILES.requestsDir}/${id}.json`, full);
  return id;
}

export async function getResult(id: string): Promise<WorkerResult | null> {
  if (!/^[a-z0-9]{6,20}$/.test(id)) return null;
  return safe<WorkerResult>(`${FILES.resultsDir}/${id}.json`);
}

/* ------------------------------------------------------- Systemzustand */
export type Tone = "ok" | "info" | "warn";
export type SystemItem = { id: string; name: string; tone: Tone; label: string; detail: string };

/** Ein Blick auf alle Bausteine – abgeleitet aus den Herzschlägen der Engines. */
export async function getSystem(): Promise<SystemItem[]> {
  const [dns, proxy, worker, integ] = await Promise.all([getDnsRuntime(), getProxyRuntime(), getWorkerRuntime(), getIntegrations()]);
  const items: SystemItem[] = [{ id: "panel", name: "Panel", tone: "ok", label: "Im Betrieb", detail: "Diese Seite" }];
  const live = (name: string, id: string, rt: { updatedAt: string } | null, detail: string): SystemItem =>
    !rt
      ? { id, name, tone: "warn", label: "Keine Daten", detail: "Container nicht gestartet oder noch ohne Herzschlag" }
      : isFresh(rt.updatedAt)
        ? { id, name, tone: "ok", label: "Im Betrieb", detail }
        : { id, name, tone: "warn", label: "Antwortet nicht", detail: `Letzter Herzschlag: ${new Date(rt.updatedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}` };
  items.push(live("DNS-Server", "dns", dns, dns ? `${dns.zones} Zonen · ${dns.records} Einträge · ${dns.totals.queries.toLocaleString("de-DE")} Anfragen` : ""));
  items.push(live("Proxy", "proxy", proxy, proxy ? `${proxy.totals.requests.toLocaleString("de-DE")} Anfragen · ${proxy.totals.blocked.toLocaleString("de-DE")} abgewehrt` : ""));
  items.push(live("Worker", "worker", worker, "Cloudflare-Abgleich, Erreichbarkeits-Scan, Traffic"));
  const cf = worker?.cloudflare;
  if (!integ.cloudflare.enabled) items.push({ id: "cloudflare", name: "Cloudflare", tone: "info", label: "Aus", detail: "In den Anbindungen abgeschaltet" });
  else if (!cf?.configured) items.push({ id: "cloudflare", name: "Cloudflare", tone: "info", label: "Nicht eingerichtet", detail: "Token fehlt – ./install.sh cloudflare" });
  else if (cf.tokenValid === false || cf.error) items.push({ id: "cloudflare", name: "Cloudflare", tone: "warn", label: "Fehler", detail: cf.error ?? "Token ungültig" });
  else items.push({ id: "cloudflare", name: "Cloudflare", tone: "ok", label: "Verbunden", detail: "Token gültig" });
  const pm = worker?.proxmox;
  if (!integ.proxmox.enabled) items.push({ id: "proxmox", name: "Proxmox", tone: "info", label: "Aus", detail: "Optional – für Traffic und Status der VMs" });
  else if (pm?.ok === false) items.push({ id: "proxmox", name: "Proxmox", tone: "warn", label: "Fehler", detail: pm.error ?? "Keine Verbindung" });
  else items.push({ id: "proxmox", name: "Proxmox", tone: pm?.ok ? "ok" : "info", label: pm?.ok ? "Verbunden" : "Wartet", detail: pm?.ok ? `${pm.vms} VMs` : "Noch keine Abfrage" });
  return items;
}
