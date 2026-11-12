/**
 * Startpunkt des Proxy-Containers.
 * Umgebung: PROXY_PORT (8081), PROXY_BIND (0.0.0.0), DATA_DIR (/data).
 */
import { log } from "../common/data.ts";
import { startProxy } from "./proxy.ts";

async function main(): Promise<void> {
  const port = Number(process.env.PROXY_PORT ?? 8081);
  const bind = process.env.PROXY_BIND ?? "0.0.0.0";
  const proxy = await startProxy({ port, bind });
  log("proxy", `lauscht auf ${bind}:${proxy.port}`);
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log("proxy", `${sig}: fahre herunter …`);
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  // Einzelne Verbindungsfehler dürfen den Proxy nicht beenden.
  process.on("uncaughtException", (e) => log("proxy", `Fehler: ${e.stack ?? e.message}`));
  process.on("unhandledRejection", (e) => log("proxy", `Fehler: ${String(e)}`));
}

void main();
