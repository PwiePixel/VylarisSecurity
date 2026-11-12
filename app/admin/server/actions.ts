"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nextFree, serverIps, setIpEntry, validateIpEntry, validateServer } from "@/lib/core/inventory-model";
import { normalizeIp } from "@/lib/core/net";
import { begin, done, formToRecord, run, text, type FormState } from "@/lib/server/action";
import { getInventory, mutateInventory } from "@/lib/server/inventory";
import { getScan } from "@/lib/server/runtime";

const fail = (error: string): FormState => ({ error });
const refresh = (id?: string) => {
  revalidatePath("/admin/server/");
  revalidatePath("/admin/ip/");
  if (id) revalidatePath(`/admin/server/${id}/`);
};

export async function saveServerAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const inv = await getInventory();
    const v = validateServer(formToRecord(fd), inv.servers);
    if (!v.ok) return fail(v.errors.join(" "));
    const creating = !inv.servers.some((s) => s.id === v.data.id);
    const r = await mutateInventory((i) => ({ ...i, servers: creating ? [...i.servers, v.data] : i.servers.map((s) => (s.id === v.data.id ? v.data : s)) }));
    if ("error" in r) return fail(r.error);
    refresh(v.data.id);
    await done("server_changed", who, `${creating ? "Server angelegt" : "Server geändert"}: ${v.data.name}`, "");
    if (creating) redirect(`/admin/server/${v.data.id}/`);
    return { ok: "Gespeichert." };
  });
}

export async function deleteServerAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const id = text(fd, "id", 20);
    const inv = await getInventory();
    const s = inv.servers.find((x) => x.id === id);
    if (!s) return fail("Server nicht gefunden.");
    const r = await mutateInventory((i) => ({ ...i, servers: i.servers.filter((x) => x.id !== id), ips: i.ips.filter((e) => e.serverId !== id) }));
    if ("error" in r) return fail(r.error);
    refresh();
    await done("server_changed", who, `Server gelöscht: ${s.name} (Adressen wieder frei)`, "");
    redirect("/admin/server/");
  });
}

/** Weist einer VM eine (weitere) Adresse zu. Eine VM kann beliebig viele Adressen haben. */
export async function assignIpAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const serverId = text(fd, "serverId", 20);
    const inv = await getInventory();
    const server = inv.servers.find((s) => s.id === serverId);
    if (!server) return fail("Server nicht gefunden.");
    const ipRaw = text(fd, "ip", 64).trim() || text(fd, "ipPick", 64).trim();
    const ip = normalizeIp(ipRaw);
    if (!ip) return fail("Keine gültige IP-Adresse.");
    const existing = inv.ips.find((e) => e.ip === ip);
    if (existing?.status === "assigned" && existing.serverId !== serverId) {
      const other = inv.servers.find((s) => s.id === existing.serverId);
      return fail(`${ip} gehört schon zu ${other?.name ?? "einem anderen Server"}. Erst dort entfernen.`);
    }
    if (existing?.status === "blocked") return fail(`${ip} ist gesperrt. Erst in der IP-Verwaltung freigeben.`);
    const entry = validateIpEntry({ ip, status: "assigned", serverId, ptr: text(fd, "ptr", 253), note: existing?.note });
    if (!entry.ok) return fail(entry.errors.join(" "));
    const r = await mutateInventory((i) => setIpEntry(i, entry.data));
    if ("error" in r) return fail(r.error);
    refresh(serverId);
    return done("ip_changed", who, `${ip} → ${server.name}`, `${ip} zugewiesen.`);
  });
}

/** Nächste freie (und nicht erreichbare) Adresse eines Netzes zuweisen. */
export async function assignNextFreeAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const serverId = text(fd, "serverId", 20);
    const inv = await getInventory();
    const server = inv.servers.find((s) => s.id === serverId);
    const subnet = inv.subnets.find((s) => s.id === text(fd, "subnetId", 20));
    if (!server || !subnet) return fail("Server oder Netz nicht gefunden.");
    const ip = nextFree(inv, subnet, await getScan())[0];
    if (!ip) return fail(`Im Netz ${subnet.name} ist keine freie Adresse mehr.`);
    const r = await mutateInventory((i) => setIpEntry(i, { ip, status: "assigned", serverId }));
    if ("error" in r) return fail(r.error);
    refresh(serverId);
    return done("ip_changed", who, `${ip} → ${server.name} (nächste freie)`, `${ip} zugewiesen.`);
  });
}

export async function unassignIpAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const ip = normalizeIp(text(fd, "ip", 64));
    const serverId = text(fd, "serverId", 20);
    if (!ip) return fail("Keine gültige IP-Adresse.");
    const r = await mutateInventory((i) => setIpEntry(i, { ip, status: "free" }));
    if ("error" in r) return fail(r.error);
    refresh(serverId);
    return done("ip_changed", who, `${ip} freigegeben`, "Freigegeben.");
  });
}

export async function setPrimaryAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const serverId = text(fd, "serverId", 20);
    const ip = normalizeIp(text(fd, "ip", 64));
    const inv = await getInventory();
    const s = inv.servers.find((x) => x.id === serverId);
    if (!s || !ip || !serverIps(inv, serverId).includes(ip)) return fail("Die Adresse gehört nicht zu diesem Server.");
    const r = await mutateInventory((i) => ({ ...i, servers: i.servers.map((x) => (x.id === serverId ? { ...x, primaryIp: ip } : x)) }));
    if ("error" in r) return fail(r.error);
    refresh(serverId);
    return done("server_changed", who, `${s.name}: Hauptadresse ${ip}`, "Hauptadresse gesetzt.");
  });
}

export async function saveServerDomainAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const d = text(fd, "serverDomain", 253).trim().toLowerCase().replace(/\.$/, "");
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) return fail("Domain ungültig (z. B. server.vylaris.it).");
    const r = await mutateInventory((i) => ({ ...i, settings: { ...i.settings, serverDomain: d } }));
    if ("error" in r) return fail(r.error);
    refresh();
    return done("server_changed", who, `Server-Domain: ${d}`, "Gespeichert.");
  });
}
