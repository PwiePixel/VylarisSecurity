/** Anzeigehilfen (deutsch). */
const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
export const num = (n: number): string => n.toLocaleString("de-DE");

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : nf.format(v)} ${u[i]}`;
}

/** Bytes pro Sekunde als Bit pro Sekunde (üblich bei Netzwerken). */
export function bps(bytesPerSec: number): string {
  const b = bytesPerSec * 8;
  if (!Number.isFinite(b) || b < 0) return "–";
  const u = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? Math.round(v) : nf.format(v)} ${u[i]}`;
}

export const time = (iso?: string): string => (iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Berlin" }) : "–");

export function ago(iso?: string, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "nie";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `vor ${s} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return `vor ${Math.round(s / 86400)} Tagen`;
}

export function uptime(sec?: number): string {
  if (!sec) return "–";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${d} d ${h} h` : `${h} h ${Math.floor((sec % 3600) / 60)} min`;
}
