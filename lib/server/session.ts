import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { SECURE_COOKIES } from "./config";
import { readJson, withLock, writeJson } from "./store";

/**
 * Serverseitige Sitzungen: Im Cookie liegt ein zufälliger 256-Bit-Wert, auf der Platte nur dessen
 * SHA-256-Hash. Cookie: HttpOnly, Secure (Produktion), SameSite=Strict, Präfix __Host-.
 */
export const SESSION_COOKIE = SECURE_COOKIES ? "__Host-vd_session" : "vd_session";
export const PENDING_COOKIE = SECURE_COOKIES ? "__Host-vd_pending" : "vd_pending";

const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // maximale Lebensdauer
const IDLE_MS = 2 * 60 * 60 * 1000; // Ablauf bei Inaktivität
const TOUCH_MS = 60 * 1000;
const MAX_SESSIONS = 10;
const PENDING_MS = 5 * 60 * 1000;
const FILE = "sessions.json";

type SessionRec = { user: string; created: number; lastSeen: number };
type SessionStore = { sessions: Record<string, SessionRec> };

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

const cookieBase = { httpOnly: true, secure: SECURE_COOKIES, sameSite: "strict" as const, path: "/" };

const alive = (s: SessionRec, now: number) => now - s.created < ABSOLUTE_MS && now - s.lastSeen < IDLE_MS;

function prune(store: SessionStore, now: number) {
  for (const [k, v] of Object.entries(store.sessions)) if (!alive(v, now)) delete store.sessions[k];
}

export async function createSession(user: string): Promise<void> {
  const token = newToken();
  const now = Date.now();
  await withLock(async () => {
    const store = await readJson<SessionStore>(FILE, { sessions: {} });
    prune(store, now);
    const mine = Object.entries(store.sessions).filter(([, v]) => v.user === user).sort((a, b) => a[1].created - b[1].created);
    while (mine.length >= MAX_SESSIONS) {
      const oldest = mine.shift();
      if (oldest) delete store.sessions[oldest[0]];
    }
    store.sessions[sha(token)] = { user, created: now, lastSeen: now };
    await writeJson(FILE, store);
  });
  (await cookies()).set(SESSION_COOKIE, token, { ...cookieBase, maxAge: ABSOLUTE_MS / 1000 });
}

/** Liefert den angemeldeten Benutzer oder null. Darf auch in Server-Komponenten aufgerufen werden. */
export async function getSessionUser(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length < 32 || token.length > 128) return null;
  const key = sha(token);
  const store = await readJson<SessionStore>(FILE, { sessions: {} });
  const rec = store.sessions[key];
  const now = Date.now();
  if (!rec || !alive(rec, now)) return null;
  if (now - rec.lastSeen > TOUCH_MS) {
    await withLock(async () => {
      const s = await readJson<SessionStore>(FILE, { sessions: {} });
      const r = s.sessions[key];
      if (r) {
        r.lastSeen = now;
        prune(s, now);
        await writeJson(FILE, s);
      }
    });
  }
  return rec.user;
}

/** Beendet die aktuelle Sitzung (nur in Server Actions / Route Handlers). */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await withLock(async () => {
      const store = await readJson<SessionStore>(FILE, { sessions: {} });
      delete store.sessions[sha(token)];
      await writeJson(FILE, store);
    });
  }
  jar.delete({ name: SESSION_COOKIE, path: "/" });
}

/** Beendet alle Sitzungen eines Benutzers (z. B. nach Passwortänderung). */
export async function destroyAllSessions(user: string): Promise<void> {
  await withLock(async () => {
    const store = await readJson<SessionStore>(FILE, { sessions: {} });
    for (const [k, v] of Object.entries(store.sessions)) if (v.user === user) delete store.sessions[k];
    await writeJson(FILE, store);
  });
}

/* ------------------------------------------- Zwischenschritt Zwei-Faktor-Code */
type Pending = { user: string; expires: number; attempts: number };
const pending = new Map<string, Pending>();
const MAX_CODE_ATTEMPTS = 5;

export async function createPending(user: string): Promise<void> {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const token = newToken();
  pending.set(sha(token), { user, expires: now + PENDING_MS, attempts: 0 });
  (await cookies()).set(PENDING_COOKIE, token, { ...cookieBase, maxAge: PENDING_MS / 1000 });
}

export async function getPending(): Promise<{ key: string; user: string } | null> {
  const token = (await cookies()).get(PENDING_COOKIE)?.value;
  if (!token) return null;
  const key = sha(token);
  const rec = pending.get(key);
  if (!rec || rec.expires < Date.now()) {
    pending.delete(key);
    return null;
  }
  return { key, user: rec.user };
}

/**
 * Reserviert synchron einen Code-Versuch für diesen Zwischenschritt (vor jeder Prüfung, damit parallele Anfragen
 * das Limit nicht umgehen). Rückgabe: false = keine Versuche mehr, der Zwischenschritt wurde verworfen.
 */
export function takePendingAttempt(key: string): boolean {
  const rec = pending.get(key);
  if (!rec) return false;
  rec.attempts += 1;
  if (rec.attempts > MAX_CODE_ATTEMPTS) {
    pending.delete(key);
    return false;
  }
  return true;
}

export async function clearPending(key: string): Promise<void> {
  pending.delete(key);
  (await cookies()).delete({ name: PENDING_COOKIE, path: "/" });
}
