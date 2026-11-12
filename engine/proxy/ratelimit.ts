/**
 * Anfragelimit (Gleitfenster, zwei Zeitfenster gewichtet) und Drosselung für Ereignisse.
 * Speicher ist begrenzt: ältere Schlüssel werden entfernt, sobald zu viele vorhanden sind.
 */

type Entry = { w: number; cur: number; prev: number };

export class RateLimiter {
  private readonly map = new Map<string, Entry>();
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(opts: { windowMs?: number; maxKeys?: number } = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxKeys = opts.maxKeys ?? 100_000;
  }

  /** Zählt eine Anfrage. ok=false, wenn die Grenze im gleitenden Fenster erreicht ist. */
  check(key: string, limit: number, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    if (limit <= 0) return { ok: true, retryAfterSec: 0 };
    const w = Math.floor(now / this.windowMs);
    const elapsed = now - w * this.windowMs;
    let e = this.map.get(key);
    if (!e) {
      e = { w, cur: 0, prev: 0 };
      this.map.set(key, e);
      this.evict();
    } else if (e.w !== w) {
      e.prev = e.w === w - 1 ? e.cur : 0;
      e.cur = 0;
      e.w = w;
    }
    const estimated = e.prev * (1 - elapsed / this.windowMs) + e.cur;
    if (estimated >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((this.windowMs - elapsed) / 1000)) };
    e.cur++;
    return { ok: true, retryAfterSec: 0 };
  }

  /** Entfernt Einträge, die länger als zwei Fenster nicht benutzt wurden. */
  sweep(now = Date.now()): void {
    const w = Math.floor(now / this.windowMs);
    for (const [k, e] of this.map) if (w - e.w >= 2) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }

  private evict(): void {
    while (this.map.size > this.maxKeys) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
  }
}

/** Lässt je Schlüssel höchstens einmal pro Zeitraum durch (begrenzter Speicher). */
export class Throttle {
  private readonly map = new Map<string, number>();
  private readonly maxKeys: number;
  constructor(maxKeys = 10_000) {
    this.maxKeys = maxKeys;
  }

  allow(key: string, windowMs: number, now = Date.now()): boolean {
    const last = this.map.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    this.map.delete(key);
    this.map.set(key, now);
    while (this.map.size > this.maxKeys) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
    return true;
  }
}

/** Höchstens `max` Durchläufe je Minute insgesamt. */
export class Budget {
  private minute = 0;
  private used = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  allow(now = Date.now()): boolean {
    const m = Math.floor(now / 60_000);
    if (m !== this.minute) {
      this.minute = m;
      this.used = 0;
    }
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
}
