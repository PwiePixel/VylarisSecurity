import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";

/**
 * Kleiner JSON-Speicher auf der Platte. Schreibzugriffe laufen nacheinander (Warteschlange)
 * und atomar (temporäre Datei + fsync + Umbenennen), damit nie eine halb geschriebene Datei entsteht.
 */
let queue: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, name), "utf8");
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  const target = path.join(DATA_DIR, name);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(JSON.stringify(value, null, 2));
    await fh.sync(); // auf die Platte schreiben, bevor die alte Datei ersetzt wird
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Hängt eine Zeile an. Ab 2 MB wird die Datei rotiert (name.1), damit sie nie unbegrenzt wächst. */
export async function appendLine(name: string, line: string): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DATA_DIR, name);
  try {
    const st = await fs.stat(file);
    if (st.size > MAX_LOG_BYTES) await fs.rename(file, `${file}.1`);
  } catch {
    /* Datei existiert noch nicht */
  }
  await fs.appendFile(file, line + "\n", { mode: 0o600 });
}

/** Liest nur das Ende einer Datei (höchstens 256 KB), nicht die ganze Datei. */
export async function readLines(name: string, limit: number): Promise<string[]> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(path.join(DATA_DIR, name), "r");
    const { size } = await fh.stat();
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (size > len) lines.shift(); // erste Zeile kann angeschnitten sein
    return lines.filter(Boolean).slice(-limit);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  } finally {
    await fh?.close();
  }
}

export async function exists(name: string): Promise<boolean> {
  try {
    await fs.access(path.join(DATA_DIR, name));
    return true;
  } catch {
    return false;
  }
}
