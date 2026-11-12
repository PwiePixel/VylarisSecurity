"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { validateServer } from "@/lib/core/inventory-model";
import { normalizeIp } from "@/lib/core/net";
import { begin, done, run, text, type FormState } from "@/lib/server/action";
import { mutateInventory } from "@/lib/server/inventory";
import { getIntegrations, getResult, requestWorker, saveIntegrations } from "@/lib/server/runtime";

const fail = (error: string): FormState => ({ error });

export async function saveProxmoxAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const enabled = text(fd, "enabled", 5) === "on";
    const url = text(fd, "url", 300).trim().replace(/\/+$/, "");
    const tokenId = text(fd, "tokenId", 200).trim();
    if (enabled) {
      if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(url)) return fail("Adresse ungültig (z. B. https://192.168.1.10:8006).");
      if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/.test(tokenId)) return fail("Token-ID ungültig (Form: benutzer@pve!tokenname).");
    }
    const cur = await getIntegrations();
    await saveIntegrations({ ...cur, proxmox: { enabled, url, tokenId, verifyTls: text(fd, "verifyTls", 5) === "on" } });
    revalidatePath("/admin/integrationen/");
    return done("integration_changed", who, `Proxmox ${enabled ? "an" : "aus"}: ${url}`, enabled ? "Gespeichert. Den geheimen Teil des Tokens trägst du auf dem Server ein: ./install.sh proxmox" : "Proxmox ausgeschaltet.");
  });
}

export async function saveCloudflareAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const cur = await getIntegrations();
    await saveIntegrations({ ...cur, cloudflare: { enabled: text(fd, "enabled", 5) === "on" } });
    revalidatePath("/admin/integrationen/");
    return done("integration_changed", who, "Cloudflare-Anbindung geändert", "Gespeichert.");
  });
}

export async function workerRequestAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const type = text(fd, "type", 30);
    if (type === "cloudflare-sync" || type === "scan-now") {
      await requestWorker({ type });
      return done("worker_request", who, type, "Auftrag erteilt – das Ergebnis erscheint in wenigen Sekunden (Seite neu laden).");
    }
    if (type === "proxmox-import") {
      const id = await requestWorker({ type });
      await done("worker_request", who, type, "");
      redirect(`/admin/integrationen/?import=${id}`);
    }
    return fail("Unbekannter Auftrag.");
  });
}

/** Legt aus der Proxmox-Liste Server an (nur noch nicht vorhandene VM-IDs). IPs aus Cloud-Init werden nur übernommen, wenn sie frei sind. */
export async function importVmsAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const result = await getResult(text(fd, "request", 30));
    const found = (result?.data as { vms?: unknown } | undefined)?.vms;
    if (!result?.ok || !Array.isArray(found)) return fail("Das Ergebnis liegt nicht mehr vor. Bitte neu abfragen.");
    const wanted = new Set(fd.getAll("vm").map(String));
    let added = 0;
    const list = found as { node: string; vmid: number; name: string; ips?: string[] }[];
    const r = await mutateInventory((i) => {
      let next = i;
      for (const vm of list) {
        if (!wanted.has(`${vm.node}:${vm.vmid}`)) continue;
        if (next.servers.some((s) => s.vmid === vm.vmid && (!s.node || s.node === vm.node))) continue;
        const base = vm.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `vm${vm.vmid}`;
        let name = base;
        for (let n = 2; next.servers.some((s) => s.name === name); n++) name = `${base}-${n}`;
        const v = validateServer({ name, node: vm.node, vmid: String(vm.vmid), dnsVisibility: "internal" }, next.servers);
        if (!v.ok) continue;
        next = { ...next, servers: [...next.servers, v.data] };
        for (const raw of vm.ips ?? []) {
          const ip = normalizeIp(raw);
          if (ip && !next.ips.some((e) => e.ip === ip)) next = { ...next, ips: [...next.ips, { ip, status: "assigned", serverId: v.data.id }] };
        }
        added++;
      }
      return next;
    });
    if ("error" in r) return fail(r.error);
    revalidatePath("/admin/server/");
    await done("server_changed", who, `${added} Server aus Proxmox übernommen`, "");
    redirect("/admin/server/");
  });
}
