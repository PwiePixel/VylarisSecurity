"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkZoneRecords, newZone, validateRecord, validateSettings, validateZoneName, type DnsRecord } from "@/lib/core/dns-model";
import { begin, done, formToRecord, run, text, type FormState } from "@/lib/server/action";
import { getDns, mutateDns } from "@/lib/server/dns";
import { getResult, requestWorker } from "@/lib/server/runtime";

const fail = (error: string): FormState => ({ error });

/** Nameserver, interne Netze, Cloudflare-Edge, Anfragelimit. Erhöht die Seriennummer aller Zonen (NS-Einträge ändern sich). */
export async function saveSettingsAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const v = validateSettings(formToRecord(fd));
    if (!v.ok) return fail(v.errors.join(" "));
    const ids = (await getDns()).zones.map((z) => z.id);
    const r = await mutateDns((d) => ({ ...d, settings: v.data }), ids);
    if ("error" in r) return fail(r.error);
    revalidatePath("/admin/dns/");
    return done("dns_changed", who, `Einstellungen: ${v.data.nameservers.map((n) => n.host).join(", ")}`, "Gespeichert – der DNS-Server lädt die Änderung innerhalb weniger Sekunden.");
  });
}

export async function createZoneAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const existing = (await getDns()).zones;
    const name = validateZoneName(text(fd, "name", 253), existing);
    if (!name.ok) return fail(name.errors.join(" "));
    const zone = newZone(name.data, text(fd, "mode", 20) === "cloudflare" ? "cloudflare" : "authoritative");
    const r = await mutateDns((d) => ({ ...d, zones: [...d.zones, zone] }));
    if ("error" in r) return fail(r.error);
    await done("dns_changed", who, `Zone ${zone.name} angelegt (${zone.mode})`, "");
    redirect(`/admin/dns/${zone.id}/`);
  });
}

export async function deleteZoneAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const id = text(fd, "id", 20);
    const zone = (await getDns()).zones.find((z) => z.id === id);
    if (!zone) return fail("Zone nicht gefunden.");
    if (text(fd, "confirm", 253).trim().toLowerCase() !== zone.name) return fail(`Zur Bestätigung den Zonennamen „${zone.name}“ eintippen.`);
    const r = await mutateDns((d) => ({ ...d, zones: d.zones.filter((z) => z.id !== id) }));
    if ("error" in r) return fail(r.error);
    await done("dns_changed", who, `Zone ${zone.name} gelöscht`, "");
    redirect("/admin/dns/");
  });
}

export async function saveZoneAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const id = text(fd, "id", 20);
    const n = (k: string) => Number(text(fd, k, 10));
    const rname = text(fd, "rname", 253).trim().toLowerCase().replace(/\.$/, "").replace("@", ".");
    const vals = { refresh: n("refresh"), retry: n("retry"), expire: n("expire"), minimum: n("minimum"), defaultTtl: n("defaultTtl") };
    if (!/^[a-z0-9._-]+\.[a-z0-9._-]+$/.test(rname)) return fail("E-Mail-Adresse des Verantwortlichen ungültig (z. B. hostmaster.example.com).");
    if (![vals.refresh, vals.retry, vals.expire, vals.minimum, vals.defaultTtl].every((x) => Number.isInteger(x) && x > 0)) return fail("Zeiten müssen ganze Zahlen größer 0 sein.");
    const r = await mutateDns(
      (d) => ({
        ...d,
        zones: d.zones.map((z) => (z.id === id ? { ...z, defaultTtl: vals.defaultTtl, comment: text(fd, "comment", 200).trim() || undefined, soa: { rname, refresh: vals.refresh, retry: vals.retry, expire: vals.expire, minimum: vals.minimum } } : z)),
      }),
      [id],
    );
    if ("error" in r) return fail(r.error);
    revalidatePath(`/admin/dns/${id}/`);
    return done("dns_changed", who, `Zone ${id}: SOA/TTL`, "Gespeichert.");
  });
}

/** Legt einen Eintrag an oder ändert ihn (mit id). */
export async function saveRecordAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const zoneId = text(fd, "zoneId", 20);
    const dns = await getDns();
    const zone = dns.zones.find((z) => z.id === zoneId);
    if (!zone) return fail("Zone nicht gefunden.");
    const raw = formToRecord(fd);
    const v = validateRecord(zone, raw);
    if (!v.ok) return fail(v.errors.join(" "));
    const records: DnsRecord[] = zone.records.some((r) => r.id === v.data.id) ? zone.records.map((r) => (r.id === v.data.id ? v.data : r)) : [...zone.records, v.data];
    const problems = checkZoneRecords(records);
    if (problems.length) return fail(problems.join(" "));
    const r = await mutateDns((d) => ({ ...d, zones: d.zones.map((z) => (z.id === zoneId ? { ...z, records } : z)) }), [zoneId]);
    if ("error" in r) return fail(r.error);
    revalidatePath(`/admin/dns/${zoneId}/`);
    await done("dns_changed", who, `${zone.name}: ${v.data.type} ${v.data.name} → ${v.data.value}`, "");
    if (raw.id) redirect(`/admin/dns/${zoneId}/`);
    return { ok: `${v.data.type}-Eintrag gespeichert.` };
  });
}

export async function deleteRecordAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const zoneId = text(fd, "zoneId", 20);
    const id = text(fd, "id", 20);
    const zone = (await getDns()).zones.find((z) => z.id === zoneId);
    const rec = zone?.records.find((r) => r.id === id);
    if (!zone || !rec) return fail("Eintrag nicht gefunden.");
    const r = await mutateDns((d) => ({ ...d, zones: d.zones.map((z) => (z.id === zoneId ? { ...z, records: z.records.filter((x) => x.id !== id) } : z)) }), [zoneId]);
    if ("error" in r) return fail(r.error);
    revalidatePath(`/admin/dns/${zoneId}/`);
    return done("dns_changed", who, `${zone.name}: ${rec.type} ${rec.name} gelöscht`, "Gelöscht.");
  });
}

/** Cloudflare-Zone: Einträge aus Cloudflare einlesen lassen (der Worker liefert eine Vorschlagsliste). */
export async function requestImportAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const zoneId = text(fd, "zoneId", 20);
    const id = await requestWorker({ type: "cloudflare-import", zoneId });
    await done("worker_request", who, `Cloudflare-Import ${zoneId}`, "");
    redirect(`/admin/dns/${zoneId}/?import=${id}`);
  });
}

/** Übernimmt die Vorschläge eines Imports in die Zone (bereits vorhandene gleiche Einträge werden übersprungen). */
export async function applyImportAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const zoneId = text(fd, "zoneId", 20);
    const result = await getResult(text(fd, "request", 30));
    const proposals = (result?.data as { records?: unknown } | undefined)?.records;
    if (!result?.ok || !Array.isArray(proposals)) return fail("Das Ergebnis liegt nicht (mehr) vor. Import neu starten.");
    const zone = (await getDns()).zones.find((z) => z.id === zoneId);
    if (!zone) return fail("Zone nicht gefunden.");
    const records = [...zone.records];
    let added = 0;
    for (const raw of proposals as Record<string, unknown>[]) {
      const v = validateRecord(zone, { ...raw, id: undefined });
      if (!v.ok) continue;
      const same = records.some((r) => r.name === v.data.name && r.type === v.data.type && r.value === v.data.value && r.priority === v.data.priority);
      if (same) continue;
      records.push(v.data);
      added++;
    }
    const problems = checkZoneRecords(records);
    if (problems.length) return fail(`Import widerspricht sich selbst: ${problems.slice(0, 3).join(" ")}`);
    const r = await mutateDns((d) => ({ ...d, zones: d.zones.map((z) => (z.id === zoneId ? { ...z, records } : z)) }), [zoneId]);
    if ("error" in r) return fail(r.error);
    await done("dns_changed", who, `${zone.name}: ${added} Einträge aus Cloudflare übernommen`, "");
    redirect(`/admin/dns/${zoneId}/?imported=${added}`);
  });
}

export async function syncNowAction(_p: FormState, _fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    await requestWorker({ type: "cloudflare-sync" });
    return done("worker_request", who, "Cloudflare-Abgleich", "Abgleich angestoßen – das Ergebnis erscheint in wenigen Sekunden unter „Anbindungen“.");
  });
}
