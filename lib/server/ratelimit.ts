/**
 * Begrenzung von Anmelde-Versuchen im Arbeitsspeicher (eine Instanz).
 *
 * Wichtig: Ein Versuch wird VOR der eigentlichen Prüfung (synchron) reserviert und bei Erfolg wieder
 * freigegeben. So kann ein Schwung paralleler Anfragen das Limit nicht umgehen, weil alle gleichzeitig
 * prüfen, bevor der erste Fehlversuch gezählt ist.
 */
type Bucket = { count: number; first: number };
const buckets = new Map<string, Bucket>();

export const WINDOW_MS = 15 * 60 * 1000;

function prune(now: number) {
  if (buckets.size < 1000) return;
  for (const [k, v] of buckets) if (now - v.first > WINDOW_MS) buckets.delete(k);
}

export type Attempt = { ok: true } | { ok: false; retryAfter: number };

/** Reserviert einen Versuch. Nach `max` Versuchen im Zeitfenster wird bis zum Fensterende abgelehnt. */
export function attempt(key: string, max: number, now = Date.now()): Attempt {
  prune(now);
  let b = buckets.get(key);
  if (!b || now - b.first > WINDOW_MS) {
    b = { count: 0, first: now };
    buckets.set(key, b);
  }
  if (b.count >= max) return { ok: false, retryAfter: Math.ceil((WINDOW_MS - (now - b.first)) / 1000) };
  b.count += 1;
  return { ok: true };
}

/** Gibt die reservierten Versuche frei (nur nach vollständig erfolgreicher Anmeldung aufrufen). */
export function release(key: string): void {
  buckets.delete(key);
}

/** Aktuelle Anzahl der Versuche im laufenden Zeitfenster. */
export function used(key: string, now = Date.now()): number {
  const b = buckets.get(key);
  return b && now - b.first <= WINDOW_MS ? b.count : 0;
}

/** Wachsende Wartezeit je Fehlversuch, ab `free` Versuchen ohne Verzögerung. */
export function backoffMs(count: number, free = 0): number {
  return count <= free ? 0 : Math.min(250 * 2 ** (count - free - 1), 8000);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Begrenzt, wie viele rechenintensive Prüfungen (scrypt) gleichzeitig laufen. Weitere Anfragen warten in einer
 * kurzen Schlange; ist sie voll, wird sofort abgelehnt, statt den Server zu überlasten.
 */
const MAX_PARALLEL = 2;
const MAX_QUEUE = 6;
let running = 0;
const waiting: Array<() => void> = [];

export class BusyError extends Error {
  constructor() {
    super("busy");
  }
}

export async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) {
    if (waiting.length >= MAX_QUEUE) throw new BusyError();
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    running += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

/** Protokolliert Ereignisse einer Art höchstens einmal je Zeitraum (gegen Log-Fluten). */
const lastLogged = new Map<string, number>();
export function shouldLogOnce(key: string, everyMs = 5 * 60 * 1000, now = Date.now()): boolean {
  const last = lastLogged.get(key) ?? 0;
  if (now - last < everyMs) return false;
  lastLogged.set(key, now);
  if (lastLogged.size > 1000) for (const [k, t] of lastLogged) if (now - t > everyMs) lastLogged.delete(k);
  return true;
}

/** Fasst IPv6-Adressen auf das /64-Präfix zusammen, damit die Rotation innerhalb eines Netzes nichts bringt. */
export function ipBucket(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(":")) return raw;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail = ""] = raw.split("::");
  const h = head ? head.split(":") : [];
  const t = raw.includes("::") && tail ? tail.split(":") : [];
  const groups = raw.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
