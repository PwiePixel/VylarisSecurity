import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { exists, readJson, withLock, writeJson } from "./store";
import { hashPassword, validateNewPassword } from "./password";
import { verifyTotp } from "./totp";

/** Der (eine) Admin-Zugang. Gespeichert in admin.json im Daten-Volume (Rechte 600). */
export type AdminRecord = {
  username: string;
  passwordHash: string;
  createdAt: string;
  totp?: { secret: string; enabled: boolean; lastStep: number };
  /** SHA-256-Hashes der noch gültigen Wiederherstellungscodes */
  recovery: string[];
};

const FILE = "admin.json";
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const adminExists = () => exists(FILE);
export const getAdmin = () => readJson<AdminRecord | null>(FILE, null);

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Ändert den Admin-Datensatz atomar und seriell. Gibt den Rückgabewert der Funktion zurück. */
export function mutateAdmin<T>(fn: (admin: AdminRecord) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    const admin = await getAdmin();
    if (!admin) throw new Error("Kein Admin-Zugang vorhanden");
    const result = await fn(admin);
    await writeJson(FILE, admin);
    return result;
  });
}

export async function createAdmin(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) {
    return { ok: false, error: "Der Benutzername muss 3–32 Zeichen lang sein (Kleinbuchstaben, Zahlen, . _ -)." };
  }
  const problem = validateNewPassword(password, name);
  if (problem) return { ok: false, error: problem };
  const passwordHash = await hashPassword(password);
  return withLock(async () => {
    if (await adminExists()) return { ok: false as const, error: "Es gibt bereits einen Admin-Zugang." };
    const record: AdminRecord = { username: name, passwordHash, createdAt: new Date().toISOString(), recovery: [] };
    await writeJson(FILE, record);
    return { ok: true as const };
  });
}

/* ------------------------------------------------------ Wiederherstellungscodes */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne leicht verwechselbare Zeichen

export const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashRecovery = (code: string) => createHash("sha256").update(normalizeRecovery(code)).digest("hex");

/** Erzeugt 8 Einmalcodes der Form XXXX-XXXX-XXXX (nur einmal sichtbar, gespeichert werden Hashes). */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = randomBytes(12);
    const raw = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return { codes, hashes: codes.map(hashRecovery) };
}

/** Löst einen Wiederherstellungscode ein (einmalig verwendbar). */
export function consumeRecoveryCode(code: string): Promise<boolean> {
  const h = hashRecovery(code);
  return mutateAdmin((admin) => {
    const idx = admin.recovery.findIndex((x) => safeEqual(x, h));
    if (idx < 0) return false;
    admin.recovery.splice(idx, 1);
    return true;
  });
}

/**
 * Prüft einen TOTP-Code und merkt sich den Zeitschritt in EINEM atomaren Schritt: Derselbe Code kann auch bei
 * gleichzeitigen Anfragen nur einmal verwendet werden.
 */
export function useTotpCode(code: string): Promise<boolean> {
  return mutateAdmin((admin) => {
    if (!admin.totp?.enabled) return false;
    const step = verifyTotp(admin.totp.secret, code, admin.totp.lastStep);
    if (step === null) return false;
    admin.totp.lastStep = step;
    return true;
  });
}

/** Wie useTotpCode, aber für die Bestätigung beim Aktivieren (Secret noch nicht aktiv). */
export function confirmTotpEnrollment(code: string, recoveryHashes: string[]): Promise<boolean> {
  return mutateAdmin((admin) => {
    if (!admin.totp || admin.totp.enabled) return false;
    const step = verifyTotp(admin.totp.secret, code, -1);
    if (step === null) return false;
    admin.totp.enabled = true;
    admin.totp.lastStep = step;
    admin.recovery = recoveryHashes;
    return true;
  });
}
