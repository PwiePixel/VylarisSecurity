/**
 * Start des DNS-Servers im Container.
 * Umgebung: DNS_PORT (5353), DNS_BIND (::), DNS_UPSTREAM (1.1.1.1,9.9.9.9 – nur für ALIAS), DATA_DIR (/data).
 */
import { log } from "../common/data.ts";
import { startDnsServer } from "./server.ts";

const num = (v: string | undefined, d: number): number => (v && /^\d+$/.test(v) ? Number(v) : d);

process.on("uncaughtException", (e) => log("dns", `Unerwarteter Fehler (läuft weiter): ${e.stack ?? e.message}`));
process.on("unhandledRejection", (e) => log("dns", `Unbehandelte Ablehnung (läuft weiter): ${String(e)}`));

const server = await startDnsServer({
  port: num(process.env.DNS_PORT, 5353),
  bind: process.env.DNS_BIND || "::",
  upstream: (process.env.DNS_UPSTREAM ?? "").split(/[\s,]+/).filter(Boolean).length ? process.env.DNS_UPSTREAM!.split(/[\s,]+/).filter(Boolean) : undefined,
});

let closing = false;
const shutdown = async (sig: string): Promise<void> => {
  if (closing) return;
  closing = true;
  log("dns", `${sig} empfangen, beende …`);
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
