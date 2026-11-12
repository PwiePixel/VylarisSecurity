/** Docker-Healthcheck des Workers: Der Herzschlag in runtime/worker.json darf höchstens 45 s alt sein. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { FILES, isFresh } from "../../lib/core/runtime-model.ts";

try {
  const dir = path.resolve(process.env.DATA_DIR ?? "/data");
  const j = JSON.parse(readFileSync(path.join(dir, FILES.workerRuntime), "utf8")) as { updatedAt?: string };
  process.exit(isFresh(j.updatedAt) ? 0 : 1);
} catch {
  process.exit(1);
}
