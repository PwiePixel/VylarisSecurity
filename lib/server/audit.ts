import { appendLine, readLines } from "./store";
import { shouldLogOnce } from "./ratelimit";

/** Protokoll sicherheitsrelevanter Ereignisse (eine JSON-Zeile je Ereignis, nie Passwörter oder Codes). */
export type AuditEvent =
  | "setup"
  | "login_ok"
  | "login_failed"
  | "login_blocked"
  | "twofactor_failed"
  | "logout"
  | "password_changed"
  | "twofactor_enabled"
  | "twofactor_disabled"
  | "recovery_used"
  | "recovery_regenerated"
  | "legal_changed"
  | "dns_changed"
  | "server_changed"
  | "ip_changed"
  | "proxy_changed"
  | "integration_changed"
  | "worker_request";

export type AuditEntry = { t: string; event: AuditEvent; user?: string; ip?: string; detail?: string };

export async function audit(event: AuditEvent, info: { user?: string; ip?: string; detail?: string } = {}): Promise<void> {
  const entry: AuditEntry = { t: new Date().toISOString(), event, ...info };
  if (entry.detail) entry.detail = entry.detail.slice(0, 300);
  try {
    await appendLine("audit.log", JSON.stringify(entry));
  } catch {
    /* Protokollfehler dürfen eine Anmeldung nicht verhindern */
  }
}

export async function getAudit(limit = 100): Promise<AuditEntry[]> {
  const lines = await readLines("audit.log", limit);
  const out: AuditEntry[] = [];
  for (const l of lines.reverse()) {
    try {
      out.push(JSON.parse(l) as AuditEntry);
    } catch {
      /* defekte Zeile überspringen */
    }
  }
  return out;
}

export const auditLabels: Record<AuditEvent, string> = {
  setup: "Admin-Zugang eingerichtet",
  login_ok: "Anmeldung erfolgreich",
  login_failed: "Anmeldung fehlgeschlagen",
  login_blocked: "Anmeldung blockiert (zu viele Versuche)",
  twofactor_failed: "Zwei-Faktor-Code falsch",
  logout: "Abgemeldet",
  password_changed: "Passwort geändert",
  twofactor_enabled: "Zwei-Faktor-Anmeldung aktiviert",
  twofactor_disabled: "Zwei-Faktor-Anmeldung deaktiviert",
  recovery_used: "Wiederherstellungscode verwendet",
  recovery_regenerated: "Wiederherstellungscodes neu erzeugt",
  legal_changed: "Rechtliche Angaben geändert",
  dns_changed: "DNS geändert",
  server_changed: "Server geändert",
  ip_changed: "IP-Verwaltung geändert",
  proxy_changed: "Proxy geändert",
  integration_changed: "Anbindung (Cloudflare/Proxmox) geändert",
  worker_request: "Auftrag an den Worker",
};

/** Wie audit(), aber je Schlüssel höchstens einmal in 5 Minuten – schützt das Protokoll vor Fluten. */
export async function auditThrottled(key: string, event: AuditEvent, info: { user?: string; ip?: string; detail?: string } = {}): Promise<void> {
  if (shouldLogOnce(`${event}:${key}`)) await audit(event, info);
}
