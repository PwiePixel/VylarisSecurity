import { audit, type AuditEvent } from "./audit";
import { clientIp, requireAdmin, sameOrigin } from "./guard";
import type { AdminRecord } from "./admin";

export type FormState = { error?: string; ok?: string; codes?: string[]; fields?: { username?: string } } | undefined;

/** Gemeinsamer Anfang jeder Admin-Aktion: Herkunft prüfen, Anmeldung prüfen. */
export async function begin(): Promise<{ admin: AdminRecord; ip: string }> {
  if (!(await sameOrigin())) throw new ActionError("Ungültige Anfrage. Bitte die Seite neu laden.");
  const admin = await requireAdmin();
  return { admin, ip: await clientIp() };
}

export class ActionError extends Error {}

export const text = (fd: FormData, key: string, max = 512): string => String(fd.get(key) ?? "").slice(0, max);

export function formToRecord(fd: FormData, max = 4000): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) raw[k] = v.slice(0, max);
  return raw;
}

export const done = async (event: AuditEvent, who: { admin: AdminRecord; ip: string }, detail: string, ok: string): Promise<FormState> => {
  await audit(event, { user: who.admin.username, ip: who.ip, detail });
  return { ok };
};

/** Führt eine Aktion aus und macht aus Fehlern eine Meldung für das Formular. */
export async function run(fn: () => Promise<FormState>): Promise<FormState> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ActionError) return { error: e.message };
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_")) throw e; // redirect()/notFound() weiterreichen
    console.error("Aktion fehlgeschlagen:", e);
    return { error: "Das hat nicht geklappt. Bitte erneut versuchen." };
  }
}
