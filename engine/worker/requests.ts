/**
 * Aufträge des Panels an den Worker. Das Panel legt requests/<id>.json an (WorkerRequest); der Worker führt sie aus,
 * schreibt runtime/results/<id>.json (WorkerResult) und löscht die Auftragsdatei. Ergebnisse werden nach 1 Tag gelöscht.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { FILES } from "../../lib/core/runtime-model.ts";
import type { WorkerRequest, WorkerResult } from "../../lib/core/runtime-model.ts";
import { abs, log, nowIso, writeJsonAtomic } from "../common/data.ts";

export type HandlerResult = { ok: boolean; message: string; data?: unknown };
export type Handlers = { [T in WorkerRequest["type"]]: (req: Extract<WorkerRequest, { type: T }>) => Promise<HandlerResult> };

const FILE_RE = /^([a-z0-9]{6,20})\.json$/;
const MAX_REQUEST_BYTES = 4096;
const RESULT_MAX_AGE_MS = 24 * 3600_000;

/** Prüft Form und Inhalt eines Auftrags. Alles Unbekannte -> null. */
export function parseRequest(id: string, raw: unknown): WorkerRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.id !== id) return null;
  const at = typeof r.at === "string" ? r.at : nowIso();
  switch (r.type) {
    case "scan-now":
    case "cloudflare-sync":
    case "proxmox-import":
      return { id, type: r.type, at };
    case "cloudflare-import":
      return typeof r.zoneId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(r.zoneId) ? { id, type: "cloudflare-import", at, zoneId: r.zoneId } : null;
    default:
      return null;
  }
}

/** Arbeitet alle vorhandenen Aufträge ab. Gibt die Zahl der ausgeführten Aufträge zurück. */
export async function processRequests(handlers: Handlers): Promise<number> {
  const dir = abs(FILES.requestsDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let done = 0;
  for (const name of names.sort()) {
    if (name.endsWith(".tmp")) continue;
    const file = path.join(dir, name);
    const m = FILE_RE.exec(name);
    const discard = async (why: string) => {
      log("requests", `${name} verworfen: ${why}`);
      await fs.rm(file, { force: true });
    };
    if (!m) {
      await discard("ungültiger Dateiname");
      continue;
    }
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size >= MAX_REQUEST_BYTES) {
        await discard("zu groß oder keine Datei");
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        await discard("kein gültiges JSON");
        continue;
      }
      const req = parseRequest(m[1]!, raw);
      if (!req) {
        await discard("unbekannter Auftrag");
        continue;
      }
      let res: HandlerResult;
      try {
        res = await (handlers[req.type] as (r: WorkerRequest) => Promise<HandlerResult>)(req);
      } catch (e) {
        res = { ok: false, message: `Auftrag fehlgeschlagen: ${(e as Error).message}` };
      }
      const result: WorkerResult = { id: req.id, done: nowIso(), ok: res.ok, message: res.message, data: res.data };
      await writeJsonAtomic(`${FILES.resultsDir}/${req.id}.json`, result);
      await fs.rm(file, { force: true });
      done++;
    } catch (e) {
      log("requests", `${name}: ${(e as Error).message}`);
    }
  }
  return done;
}

/** Löscht Ergebnisse, die älter als einen Tag sind. */
export async function cleanupResults(now = Date.now()): Promise<number> {
  const dir = abs(FILES.resultsDir);
  let removed = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (st && now - st.mtimeMs > RESULT_MAX_AGE_MS) {
        await fs.rm(file, { force: true });
        removed++;
      }
    }
  } catch {
    /* Ordner fehlt noch */
  }
  return removed;
}
