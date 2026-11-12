/**
 * Docker-Healthcheck: fragt `health.check` (TXT) per UDP auf 127.0.0.1:DNS_PORT.
 * Jede gültige Antwort (auch REFUSED) zählt als gesund -> Exit 0, sonst Exit 1.
 */
import dgram from "node:dgram";
import { decodeMessage, emptyMessage, encodeMessage, QTYPE } from "./wire.ts";

const port = /^\d+$/.test(process.env.DNS_PORT ?? "") ? Number(process.env.DNS_PORT) : 5353;
const q = emptyMessage(0x4848);
q.questions.push({ name: "health.check", rawName: "health.check", type: QTYPE.TXT, cls: 1 });

const sock = dgram.createSocket("udp4");
const fail = (): never => process.exit(1);
const timer = setTimeout(fail, 2000);
sock.on("error", fail);
sock.on("message", (buf) => {
  try {
    const m = decodeMessage(buf);
    if (m.qr && m.id === q.id) {
      clearTimeout(timer);
      process.exit(0);
    }
  } catch {
    /* ungültig: weiter warten bis zum Zeitlimit */
  }
});
sock.send(encodeMessage(q), port, "127.0.0.1", (err) => {
  if (err) fail();
});
