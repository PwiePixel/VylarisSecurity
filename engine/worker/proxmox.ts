/**
 * Proxmox-Anbindung (nur lesend): VMs und Knoten samt Netzwerkzählern über die Proxmox-API.
 * Token: `Authorization: PVEAPIToken=<tokenId>=<secret>`; die Token-ID steht in integrations.json,
 * das Geheimnis nur in der Umgebung des Workers (PROXMOX_TOKEN_SECRET). Empfohlene Rolle: PVEAuditor.
 *
 * TLS: Proxmox nutzt oft ein selbst signiertes Zertifikat. Bei verifyTls=false wird die Prüfung NUR für
 * diese Verbindung abgeschaltet (eigener Agent), nie global.
 */
import http from "node:http";
import https from "node:https";
import { parseIp } from "../../lib/core/net.ts";
import type { Inventory, Server } from "../../lib/core/inventory-model.ts";
import type { Integrations } from "../../lib/core/runtime-model.ts";

export type PveConfig = { url: string; tokenId: string; secret: string; verifyTls: boolean };

/** Nur wenn aktiviert und vollständig. Fehlendes Geheimnis -> Fehlertext statt Konfiguration. */
export function pveConfig(integ: Integrations, secret: string | undefined): { cfg?: PveConfig; error?: string } {
  const p = integ.proxmox;
  if (!p.enabled) return {};
  if (!p.url || !p.tokenId) return { error: "Proxmox ist aktiviert, aber Adresse oder Token-ID fehlen." };
  if (!secret) return { error: "PROXMOX_TOKEN_SECRET fehlt (./install.sh proxmox ausführen)." };
  return { cfg: { url: p.url.replace(/\/+$/, ""), tokenId: p.tokenId, secret, verifyTls: p.verifyTls } };
}

export class PveError extends Error {}

/** GET mit Timeout; wirft PveError mit lesbarem deutschem Text. */
export function httpJson(urlStr: string, opts: { headers?: Record<string, string>; insecure?: boolean; timeoutMs?: number } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      return reject(new PveError("Die Proxmox-Adresse ist ungültig (z. B. https://192.0.2.10:8006)."));
    }
    const lib = url.protocol === "https:" ? https : http;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json", ...(opts.headers ?? {}) },
        agent: url.protocol === "https:" && opts.insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) req.destroy(new PveError("Antwort von Proxmox zu groß."));
          else chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* kein JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new PveError(`Zeitüberschreitung bei Proxmox (${Math.round(timeoutMs / 1000)} s).`)));
    req.on("error", (e: NodeJS.ErrnoException) => reject(explain(e)));
    req.end();
  });
}

function explain(e: NodeJS.ErrnoException): PveError {
  if (e instanceof PveError) return e;
  const code = String(e.code ?? "");
  if (code === "ECONNREFUSED") return new PveError("Proxmox verweigert die Verbindung (Adresse/Port prüfen, Standard 8006).");
  if (code === "ENOTFOUND") return new PveError("Der Proxmox-Name lässt sich nicht auflösen.");
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new PveError("Proxmox ist von hier aus nicht erreichbar.");
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) return new PveError("Das TLS-Zertifikat von Proxmox ist nicht vertrauenswürdig – „TLS prüfen“ in den Integrationen abschalten.");
  return new PveError(`Proxmox nicht erreichbar${code ? ` (${code})` : ""}.`);
}

async function pveGet(cfg: PveConfig, path: string, timeoutMs?: number): Promise<any> {
  const r = await httpJson(`${cfg.url}/api2/json${path}`, {
    headers: { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.secret}` },
    insecure: !cfg.verifyTls,
    timeoutMs,
  });
  if (r.status === 401) throw new PveError("Proxmox lehnt den Token ab (401): Token-ID und Geheimnis prüfen.");
  if (r.status === 403) throw new PveError("Dem Proxmox-Token fehlen Rechte (403): Rolle PVEAuditor auf „/“ vergeben, „Privilege Separation“ beachten.");
  if (r.status < 200 || r.status >= 300) throw new PveError(`Proxmox antwortet mit HTTP ${r.status}.`);
  if (!r.json || !("data" in r.json)) throw new PveError("Unerwartete Antwort von Proxmox.");
  return r.json.data;
}

export const pveMessage = (e: unknown): string => (e instanceof PveError ? e.message : `Proxmox-Abfrage fehlgeschlagen: ${(e as Error).message}`);

export type PveResource = {
  type: string;
  id?: string;
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
  netin?: number;
  netout?: number;
};

/** Alle Ressourcen des Clusters (VMs, Container, Knoten; Speicher usw. werden herausgefiltert). */
export async function pveResources(cfg: PveConfig): Promise<PveResource[]> {
  const data = await pveGet(cfg, "/cluster/resources");
  if (!Array.isArray(data)) throw new PveError("Unerwartete Antwort von Proxmox.");
  return data.filter((r): r is PveResource => !!r && typeof r === "object" && ["qemu", "lxc", "node"].includes(String((r as PveResource).type)));
}

/** Server aus dem Inventar zur VM: gleiche node+vmid, sonst nur die vmid (wenn eindeutig). */
export function matchServer(inv: Inventory, node: string | undefined, vmid: number | undefined): Server | undefined {
  if (vmid === undefined) return undefined;
  const exact = inv.servers.find((s) => s.vmid === vmid && s.node && s.node === node);
  if (exact) return exact;
  const byVmid = inv.servers.filter((s) => s.vmid === vmid && (!s.node || s.node === node));
  return byVmid.length === 1 ? byVmid[0] : undefined;
}

export type PveImportItem = { node: string; vmid: number; name: string; status: string; type: "qemu" | "lxc"; ips: string[] };

/** IP-Adressen aus Cloud-Init (ipconfigN: "ip=1.2.3.4/24,gw=…") bzw. LXC (netN: "…,ip=1.2.3.4/24,…"). DHCP/auto zählt nicht. */
export function parseConfigIps(config: Record<string, unknown>): string[] {
  const ips: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (!/^(ipconfig|net)\d+$/.test(k) || typeof v !== "string") continue;
    for (const part of v.split(",")) {
      const m = /^ip6?=(.+)$/.exec(part.trim());
      if (!m) continue;
      const addr = m[1]!.split("/")[0]!;
      if (parseIp(addr)) ips.push(addr);
    }
  }
  return [...new Set(ips)];
}

/** Liste der VMs mit den (soweit lesbaren) statisch konfigurierten IPs – als Vorschlag für das Panel. */
export async function pveImport(cfg: PveConfig, max = 200): Promise<PveImportItem[]> {
  const vms = (await pveResources(cfg)).filter((r) => (r.type === "qemu" || r.type === "lxc") && r.node && typeof r.vmid === "number").slice(0, max);
  const out: PveImportItem[] = [];
  let next = 0;
  const worker = async () => {
    while (next < vms.length) {
      const vm = vms[next++]!;
      let ips: string[] = [];
      try {
        ips = parseConfigIps((await pveGet(cfg, `/nodes/${encodeURIComponent(vm.node!)}/${vm.type}/${vm.vmid}/config`, 8000)) ?? {});
      } catch {
        /* Konfiguration nicht lesbar (Rechte): VM trotzdem ohne IPs anbieten */
      }
      out.push({ node: vm.node!, vmid: vm.vmid!, name: vm.name ?? `vm${vm.vmid}`, status: vm.status ?? "unknown", type: vm.type as "qemu" | "lxc", ips });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, vms.length) }, worker));
  return out.sort((a, b) => a.vmid - b.vmid);
}
