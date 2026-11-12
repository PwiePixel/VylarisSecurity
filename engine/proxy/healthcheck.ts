/** Docker-Healthcheck: fragt /healthz des lokalen Proxys ab (Host "localhost"). Exit 0 = gesund. */
import http from "node:http";

const port = Number(process.env.PROXY_PORT ?? 8081);
const req = http.get({ host: "127.0.0.1", port, path: "/healthz", headers: { host: "localhost" }, timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", () => req.destroy());
req.on("error", () => process.exit(1));
