import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAdmin, safeEqual, type AdminRecord } from "./admin";
import { getSessionUser } from "./session";

/** Schützt Admin-Seiten und -Aktionen: ohne gültige Sitzung geht es zur Anmeldung. */
export async function requireAdmin(): Promise<AdminRecord> {
  const user = await getSessionUser();
  if (user) {
    const admin = await getAdmin();
    if (admin && safeEqual(admin.username, user)) return admin;
  }
  redirect("/admin/login/");
}

/**
 * Adresse des Besuchers. Die App ist nur über den Cloudflare Tunnel (cf-connecting-ip) bzw. das interne
 * Container-Netz erreichbar – direkte Zugriffe aus dem Internet gibt es nicht.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const raw = h.get("cf-connecting-ip") ?? "unbekannt"; // X-Forwarded-For ist fälschbar und wird bewusst nicht genutzt
  return raw.trim().slice(0, 64);
}

/**
 * Zusätzlicher Schutz vor fremden Seiten (CSRF), unabhängig vom Framework: Jede Aktion verlangt einen
 * Origin-Header, dessen Host zur aufgerufenen Adresse passt (oder die Browser-Angabe Sec-Fetch-Site: same-origin).
 * Anfragen ohne diese Angaben (z. B. Skripte) werden abgelehnt.
 */
export async function sameOrigin(): Promise<boolean> {
  const h = await headers();
  const host = (h.get("host") ?? "").trim().toLowerCase();
  const fetchSite = h.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const origin = h.get("origin");
  if (!origin) return fetchSite === "same-origin";
  try {
    return !!host && new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
