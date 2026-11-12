"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cidrContains } from "@/lib/core/net";
import { setIpEntry, validateIpEntry, validateSubnet } from "@/lib/core/inventory-model";
import { begin, done, formToRecord, run, text, type FormState } from "@/lib/server/action";
import { getInventory, mutateInventory } from "@/lib/server/inventory";
import { requestWorker } from "@/lib/server/runtime";

const fail = (error: string): FormState => ({ error });

export async function saveSubnetAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const inv = await getInventory();
    const v = validateSubnet(formToRecord(fd), inv.subnets);
    if (!v.ok) return fail(v.errors.join(" "));
    const creating = !inv.subnets.some((s) => s.id === v.data.id);
    if (creating) {
      const overlap = inv.subnets.find((s) => cidrContains(s.cidr, v.data.cidr.split("/")[0]!) || cidrContains(v.data.cidr, s.cidr.split("/")[0]!));
      if (overlap) return fail(`Überschneidet sich mit „${overlap.name}“ (${overlap.cidr}).`);
    }
    const r = await mutateInventory((i) => ({ ...i, subnets: creating ? [...i.subnets, v.data] : i.subnets.map((s) => (s.id === v.data.id ? v.data : s)) }));
    if ("error" in r) return fail(r.error);
    revalidatePath("/admin/ip/");
    await done("ip_changed", who, `${creating ? "Netz angelegt" : "Netz geändert"}: ${v.data.cidr}`, "");
    if (creating) redirect(`/admin/ip/${v.data.id}/`);
    return { ok: "Gespeichert." };
  });
}

export async function deleteSubnetAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const id = text(fd, "id", 20);
    const inv = await getInventory();
    const s = inv.subnets.find((x) => x.id === id);
    if (!s) return fail("Netz nicht gefunden.");
    const r = await mutateInventory((i) => ({ ...i, subnets: i.subnets.filter((x) => x.id !== id), ips: i.ips.filter((e) => !cidrContains(s.cidr, e.ip)) }));
    if ("error" in r) return fail(r.error);
    revalidatePath("/admin/ip/");
    await done("ip_changed", who, `Netz gelöscht: ${s.cidr}`, "");
    redirect("/admin/ip/");
  });
}

/** Status einer einzelnen Adresse setzen: frei, reserviert, gesperrt oder einem Server zugewiesen. */
export async function setIpAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const ip = text(fd, "ip", 64);
    const status = text(fd, "status", 20);
    const subnetId = text(fd, "subnetId", 20);
    const inv = await getInventory();
    if (status === "free") {
      const r = await mutateInventory((i) => setIpEntry(i, { ip, status: "free" }));
      if ("error" in r) return fail(r.error);
    } else {
      const v = validateIpEntry({ ip, status, serverId: text(fd, "serverId", 20), ptr: text(fd, "ptr", 253), note: text(fd, "note", 200) });
      if (!v.ok) return fail(v.errors.join(" "));
      if (v.data.serverId && !inv.servers.some((s) => s.id === v.data.serverId)) return fail("Server nicht gefunden.");
      const r = await mutateInventory((i) => setIpEntry(i, v.data));
      if ("error" in r) return fail(r.error);
    }
    revalidatePath(`/admin/ip/${subnetId}/`);
    revalidatePath("/admin/ip/");
    return done("ip_changed", who, `${ip} → ${status}${text(fd, "serverId", 20) ? " (Server)" : ""}`, "Gespeichert.");
  });
}

export async function scanNowAction(_p: FormState, _fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    await requestWorker({ type: "scan-now" });
    return done("worker_request", who, "Erreichbarkeits-Scan", "Scan angestoßen – in etwa einer Minute Seite neu laden.");
  });
}
