"use server";

import { revalidatePath } from "next/cache";
import { validateRoute, validateRules } from "@/lib/core/proxy-model";
import { begin, done, formToRecord, run, text, type FormState } from "@/lib/server/action";
import { getInventory } from "@/lib/server/inventory";
import { getProxy, mutateProxy } from "@/lib/server/proxy";

const fail = (error: string): FormState => ({ error });

export async function saveRouteAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const [inv, proxy] = await Promise.all([getInventory(), getProxy()]);
    const raw = formToRecord(fd);
    raw.enabled = raw.enabled ?? (raw.id ? "" : "on");
    if (!raw.target && raw.targetCustom) raw.target = raw.targetCustom.trim();
    const v = validateRoute(raw, inv, proxy.routes);
    if (!v.ok) return fail(v.errors.join(" "));
    const exists = proxy.routes.some((r) => r.id === v.data.id);
    const r = await mutateProxy((p) => ({ ...p, routes: exists ? p.routes.map((x) => (x.id === v.data.id ? v.data : x)) : [...p.routes, v.data] }));
    if ("error" in r) return fail(r.error);
    revalidatePath("/admin/proxy/");
    return done("proxy_changed", who, `${exists ? "Route geändert" : "Route angelegt"}: ${v.data.host}`, exists ? "Gespeichert." : "Route angelegt – der Proxy lädt sie innerhalb weniger Sekunden.");
  });
}

export async function deleteRouteAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const id = text(fd, "id", 20);
    const proxy = await getProxy();
    const route = proxy.routes.find((r) => r.id === id);
    if (!route) return fail("Route nicht gefunden.");
    const r = await mutateProxy((p) => ({ ...p, routes: p.routes.filter((x) => x.id !== id) }));
    if ("error" in r) return fail(r.error);
    revalidatePath("/admin/proxy/");
    return done("proxy_changed", who, `Route gelöscht: ${route.host}`, "Gelöscht.");
  });
}

export async function toggleRouteAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const id = text(fd, "id", 20);
    const r = await mutateProxy((p) => ({ ...p, routes: p.routes.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)) }));
    if ("error" in r) return fail(r.error);
    revalidatePath("/admin/proxy/");
    return done("proxy_changed", who, `Route ${id} umgeschaltet`, "Umgeschaltet.");
  });
}

export async function saveRulesAction(_p: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const who = await begin();
    const v = validateRules(formToRecord(fd));
    if (!v.ok) return fail(v.errors.join(" "));
    const r = await mutateProxy((p) => ({ ...p, rules: v.data }));
    if ("error" in r) return fail(r.error);
    revalidatePath("/admin/proxy/");
    return done("proxy_changed", who, "Schutzregeln geändert", "Gespeichert.");
  });
}
