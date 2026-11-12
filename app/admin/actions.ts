"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  adminExists,
  confirmTotpEnrollment,
  consumeRecoveryCode,
  createAdmin,
  getAdmin,
  mutateAdmin,
  newRecoveryCodes,
  safeEqual,
  useTotpCode,
  USERNAME_RE,
} from "@/lib/server/admin";
import { audit, auditThrottled } from "@/lib/server/audit";
import type { FormState as ActionFormState } from "@/lib/server/action";
import { saveLegal, validateLegal } from "@/lib/server/legal";
import { clientIp, requireAdmin, sameOrigin } from "@/lib/server/guard";
import { hashPassword, validateNewPassword, verifyPassword } from "@/lib/server/password";
import { attempt, backoffMs, BusyError, ipBucket, limited, release, sleep, used } from "@/lib/server/ratelimit";
import {
  clearPending,
  createPending,
  createSession,
  destroyAllSessions,
  destroySession,
  getPending,
  takePendingAttempt,
} from "@/lib/server/session";
import { setupState, setupToken } from "@/lib/server/setup";
import { generateTotpSecret } from "@/lib/server/totp";

/** Ergebnis einer Formular-Aktion (wird im Formular angezeigt). */
export type FormState = ActionFormState;

const text = (fd: FormData, key: string, max = 256) => String(fd.get(key) ?? "").slice(0, max);
const TOO_MANY: FormState = { error: "Zu viele Versuche. Bitte in ein paar Minuten erneut versuchen." };
const BAD_REQUEST: FormState = { error: "Ungültige Anfrage. Bitte die Seite neu laden." };
const BUSY: FormState = { error: "Der Server ist gerade ausgelastet. Bitte in einem Moment erneut versuchen." };

/** Höchstzahl an Versuchen je 15 Minuten */
const LIMIT_IP = 8;
const LIMIT_2FA = 10;
const LIMIT_PASSWORD_CHECK = 8;
const LIMIT_SETUP = 5;
const ACCOUNT_KEY = "acct:login";

const withUsername = (state: FormState, username: string): FormState => ({ ...state, fields: { username } });

/** Prüft ein Passwort mit begrenzter Parallelität. Rückgabe null = Server ausgelastet. */
async function verifyLimited(password: string, hash: string | null | undefined): Promise<boolean | null> {
  try {
    return await limited(() => verifyPassword(password, hash));
  } catch (e) {
    if (e instanceof BusyError) return null;
    throw e;
  }
}

/* ------------------------------------------------------------------ Anmeldung */
export async function loginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const ipRaw = await clientIp();
  const ipKey = `login:${ipBucket(ipRaw)}`;
  const username = text(fd, "username", 64).trim().toLowerCase();
  const password = text(fd, "password");

  // Versuch sofort (synchron) reservieren – bevor irgendetwas Asynchrones passiert.
  const slot = attempt(ipKey, LIMIT_IP);
  attempt(ACCOUNT_KEY, Number.MAX_SAFE_INTEGER);
  if (!slot.ok) {
    await auditThrottled(ipKey, "login_blocked", { ip: ipRaw });
    return withUsername(TOO_MANY, username);
  }
  // Kontoweite Bremse: je mehr Versuche insgesamt, desto länger die Wartezeit (auch bei wechselnden Adressen).
  const wait = backoffMs(used(ACCOUNT_KEY), 6);
  if (wait > 0) await sleep(wait);

  const admin = await getAdmin();
  const passwordOk = await verifyLimited(password, admin?.passwordHash);
  if (passwordOk === null) return withUsername(BUSY, username);
  const userOk = admin ? safeEqual(admin.username, username) : false;

  if (!admin || !passwordOk || !userOk) {
    await auditThrottled(ipKey, "login_failed", { ip: ipRaw, user: username.slice(0, 32) });
    await sleep(backoffMs(used(ipKey), 1));
    return withUsername({ error: "Benutzername oder Passwort falsch." }, username);
  }
  if (admin.totp?.enabled) {
    // Das Passwort allein setzt kein Limit zurück: Die Versuche für den Code zählen weiter.
    await createPending(admin.username);
    redirect("/admin/login/code/");
  }
  release(ipKey);
  release(ACCOUNT_KEY);
  await createSession(admin.username);
  await audit("login_ok", { ip: ipRaw, user: admin.username });
  redirect("/admin/");
}

export async function codeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const ipRaw = await clientIp();
  const ipKey = `login:${ipBucket(ipRaw)}`;
  const pending = await getPending();
  if (!pending) redirect("/admin/login/");

  // Alle Zähler synchron reservieren, bevor geprüft wird.
  if (!takePendingAttempt(pending.key)) redirect("/admin/login/");
  const acctKey = `2fa:${pending.user}`;
  const acct = attempt(acctKey, LIMIT_2FA);
  const byIp = attempt(ipKey, LIMIT_IP);
  if (!acct.ok || !byIp.ok) {
    await auditThrottled(acctKey, "login_blocked", { ip: ipRaw, user: pending.user, detail: "Zwei-Faktor-Code" });
    return TOO_MANY;
  }
  const admin = await getAdmin();
  if (!admin || !admin.totp?.enabled || !safeEqual(admin.username, pending.user)) redirect("/admin/login/");

  const code = text(fd, "code", 32).trim();
  let ok = false;
  let usedRecovery = false;
  if (/^\d{3}\s?\d{3}$/.test(code)) {
    ok = await useTotpCode(code);
  } else if (code.length >= 12) {
    ok = await consumeRecoveryCode(code);
    usedRecovery = ok;
  }
  if (!ok) {
    await auditThrottled(acctKey, "twofactor_failed", { ip: ipRaw, user: admin.username });
    await sleep(backoffMs(used(acctKey), 0));
    return { error: "Der Code ist falsch oder abgelaufen." };
  }
  release(acctKey);
  release(ipKey);
  release(ACCOUNT_KEY);
  await clearPending(pending.key);
  await createSession(admin.username);
  await audit("login_ok", { ip: ipRaw, user: admin.username, detail: "mit Zwei-Faktor" });
  if (usedRecovery) await audit("recovery_used", { ip: ipRaw, user: admin.username });
  redirect("/admin/");
}

export async function logoutAction(): Promise<void> {
  if (!(await sameOrigin())) return;
  const admin = await requireAdmin();
  await destroySession();
  await audit("logout", { user: admin.username, ip: await clientIp() });
  redirect("/admin/login/");
}

/* ----------------------------------------------------------- Erst-Einrichtung */
export async function setupAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const ipRaw = await clientIp();
  const key = `setup:${ipBucket(ipRaw)}`;
  const username = text(fd, "username", 64).trim().toLowerCase();
  if (!attempt(key, LIMIT_SETUP).ok) return withUsername(TOO_MANY, username);

  const state = setupState();
  if (state === "disabled") return withUsername({ error: "Die Einrichtung ist nicht freigeschaltet. Bitte ./install.sh admin ausführen." }, username);
  if (state === "expired") return withUsername({ error: "Der Einrichtungs-Schlüssel ist abgelaufen. Bitte ./install.sh admin erneut ausführen." }, username);
  if (await adminExists()) redirect("/admin/login/");

  if (!safeEqual(text(fd, "token", 128).trim(), setupToken())) {
    await sleep(backoffMs(used(key), 0));
    return withUsername({ error: "Der Einrichtungs-Schlüssel ist falsch." }, username);
  }
  const password = text(fd, "password");
  if (!USERNAME_RE.test(username)) return withUsername({ error: "Der Benutzername muss 3–32 Zeichen lang sein (Kleinbuchstaben, Zahlen, . _ -)." }, username);
  if (password !== text(fd, "password2")) return withUsername({ error: "Die Passwörter stimmen nicht überein." }, username);
  const created = await createAdmin(username, password);
  if (!created.ok) return withUsername({ error: created.error }, username);
  release(key);
  await audit("setup", { ip: ipRaw, user: username });
  await createSession(username);
  redirect("/admin/");
}

/* ------------------------------------------------------------------- Sicherheit */
/** Prüft das aktuelle Passwort vor sensiblen Änderungen. Rückgabe: Fehlermeldung oder null. */
async function checkCurrentPassword(username: string, password: string): Promise<FormState | null> {
  const key = `pw:${username}`;
  if (!attempt(key, LIMIT_PASSWORD_CHECK).ok) return TOO_MANY;
  const admin = await getAdmin();
  const ok = await verifyLimited(password, admin?.passwordHash);
  if (ok === null) return BUSY;
  if (!admin || !safeEqual(admin.username, username) || !ok) {
    await sleep(backoffMs(used(key), 0));
    return { error: "Das aktuelle Passwort ist falsch." };
  }
  release(key);
  return null;
}

/** Nach Änderungen an Passwort oder Zwei-Faktor: alle Sitzungen beenden, nur die aktuelle neu ausstellen. */
async function rotateSessions(username: string): Promise<void> {
  await destroyAllSessions(username);
  await createSession(username);
}

export async function changePasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const admin = await requireAdmin();
  const wrong = await checkCurrentPassword(admin.username, text(fd, "current"));
  if (wrong) return wrong;
  const next = text(fd, "next");
  if (next !== text(fd, "next2")) return { error: "Die neuen Passwörter stimmen nicht überein." };
  const problem = validateNewPassword(next, admin.username);
  if (problem) return { error: problem };
  const passwordHash = await hashPassword(next);
  await mutateAdmin((a) => {
    a.passwordHash = passwordHash;
  });
  await rotateSessions(admin.username);
  await audit("password_changed", { user: admin.username, ip: await clientIp() });
  return { ok: "Passwort geändert. Alle anderen Sitzungen wurden beendet." };
}

export async function startTotpAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const admin = await requireAdmin();
  if (admin.totp?.enabled) return { error: "Zwei-Faktor ist bereits aktiv." };
  const wrong = await checkCurrentPassword(admin.username, text(fd, "current"));
  if (wrong) return wrong;
  const secret = generateTotpSecret();
  await mutateAdmin((a) => {
    a.totp = { secret, enabled: false, lastStep: -1 };
  });
  redirect("/admin/sicherheit/");
}

export async function enableTotpAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const admin = await requireAdmin();
  if (!admin.totp || admin.totp.enabled) return { error: "Bitte die Einrichtung neu starten." };
  const wrong = await checkCurrentPassword(admin.username, text(fd, "current"));
  if (wrong) return wrong;
  if (!attempt(`2fa-enroll:${admin.username}`, LIMIT_2FA).ok) return TOO_MANY;
  const { codes, hashes } = newRecoveryCodes();
  const ok = await confirmTotpEnrollment(text(fd, "code", 16), hashes);
  if (!ok) return { error: "Der Code stimmt nicht. Bitte den aktuellen Code der App eingeben." };
  release(`2fa-enroll:${admin.username}`);
  await rotateSessions(admin.username);
  await audit("twofactor_enabled", { user: admin.username, ip: await clientIp() });
  return { ok: "Zwei-Faktor-Anmeldung ist aktiv. Bitte die Wiederherstellungscodes jetzt sicher speichern – sie werden nur einmal angezeigt.", codes };
}

export async function disableTotpAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const admin = await requireAdmin();
  const wrong = await checkCurrentPassword(admin.username, text(fd, "current"));
  if (wrong) return wrong;
  await mutateAdmin((a) => {
    delete a.totp;
    a.recovery = [];
  });
  await rotateSessions(admin.username);
  await audit("twofactor_disabled", { user: admin.username, ip: await clientIp() });
  return { ok: "Zwei-Faktor-Anmeldung ist deaktiviert." };
}

export async function regenerateRecoveryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const admin = await requireAdmin();
  if (!admin.totp?.enabled) return { error: "Zwei-Faktor-Anmeldung ist nicht aktiv." };
  const wrong = await checkCurrentPassword(admin.username, text(fd, "current"));
  if (wrong) return wrong;
  const { codes, hashes } = newRecoveryCodes();
  await mutateAdmin((a) => {
    a.recovery = hashes;
  });
  await audit("recovery_regenerated", { user: admin.username, ip: await clientIp() });
  return { ok: "Neue Wiederherstellungscodes erzeugt. Die alten sind ungültig.", codes };
}

/* ------------------------------------------------------- Rechtliche Angaben */
export async function saveLegalAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!(await sameOrigin())) return BAD_REQUEST;
  const admin = await requireAdmin();
  const raw: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) raw[k] = v.slice(0, 4000);
  const result = validateLegal(raw);
  if (!result.ok) return { error: result.errors.join(" ") };
  const changed = await saveLegal(result.data);
  await audit("legal_changed", { user: admin.username, ip: await clientIp(), detail: changed.length ? changed.join(", ") : "keine Änderung" });
  revalidatePath("/admin/rechtliches/");
  // Seite neu laden: Das Formular zeigt dann die gespeicherten Werte, die Meldung steht oben auf der Seite.
  redirect("/admin/rechtliches/?saved=1");
}

