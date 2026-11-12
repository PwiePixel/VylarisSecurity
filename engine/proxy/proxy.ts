/**
 * Reverse-Proxy mit Schutzfunktionen.
 *
 * Besucher -> Cloudflare -> Tunnel -> dieser Proxy (HTTP, internes Netz) -> Server (Adresse bleibt verborgen).
 * Routen kommen aus proxy.json, Server-Adressen aus inventory.json (beide gehören dem Panel).
 * Statistik und Herzschlag schreibt der Proxy nach runtime/proxy.json.
 */
import http from "node:http";
import https from "node:https";
import type { IncomingMessage, OutgoingHttpHeaders, RequestOptions, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { inAnyNet, isIp, normalizeIp, normalizeName } from "../../lib/core/net.ts";
import type { Inventory } from "../../lib/core/inventory-model.ts";
import { defaultInventory } from "../../lib/core/inventory-model.ts";
import { defaultProxyState, matchRoute, resolveUpstream } from "../../lib/core/proxy-model.ts";
import type { ProxyRules, ProxyState, Route } from "../../lib/core/proxy-model.ts";
import { FILES } from "../../lib/core/runtime-model.ts";
import type { ProxyEvent, ProxyRuntime, RouteStats } from "../../lib/core/runtime-model.ts";
import { bumpMinute, loadInventory, loadProxy, log, nowIso, watchFiles, writeJsonAtomic } from "../common/data.ts";
import { errorHeaders, errorPage, statusText } from "./pages.ts";
import { Budget, RateLimiter, Throttle } from "./ratelimit.ts";

export type LoadedState = { proxy: ProxyState; inventory: Inventory };

export type ProxyOptions = {
  /** Port (Standard: PROXY_PORT oder 8081; 0 = zufällig, für Tests) */
  port?: number;
  bind?: string;
  /** Lädt Konfiguration und Inventar (Standard: Dateien in DATA_DIR) */
  loadState?: () => Promise<LoadedState>;
  /** Dateien beobachten und bei Änderung neu laden (Standard: ja) */
  watch?: boolean;
  watchIntervalMs?: number;
  /** Statistik schreiben (Standard: runtime/proxy.json); null = nicht schreiben */
  writeStats?: ((rt: ProxyRuntime) => Promise<void>) | null;
  statsIntervalMs?: number;
};

export type ProxyHandle = {
  server: http.Server;
  port: number;
  reload(): Promise<void>;
  snapshot(): ProxyRuntime;
  flush(): Promise<void>;
  close(): Promise<void>;
};

type Live = { rules: ProxyRules; routes: Route[]; inv: Inventory };
type Reason = ProxyEvent["reason"];
type Ctx = { start: number; route: Route | null; bytesIn: number; bytesOut: number; latency?: number; done: boolean; counted101: boolean };

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const FORWARD_OWN = new Set(["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip", "forwarded"]);
const CONNECT_TIMEOUT_MS = 5000;
const DAY_MS = 24 * 3600 * 1000;

const emptyStats = (): RouteStats => ({ requests: 0, bytesIn: 0, bytesOut: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, blocked: 0, rateLimited: 0, upstreamErrors: 0, latencyMs: 0 });

const stripMapped = (a: string): string => (a.startsWith("::ffff:") && a.includes(".") ? a.slice(7) : a);

/** Besucher-IP: CF-Connecting-IP (vom Tunnel gesetzt), sonst die Socket-Adresse. X-Forwarded-For wird nie genutzt. */
export function clientIpOf(req: IncomingMessage): string {
  const h = req.headers["cf-connecting-ip"];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  if (v) {
    const n = normalizeIp(stripMapped(v));
    if (n) return n;
  }
  const a = stripMapped(req.socket.remoteAddress ?? "");
  return normalizeIp(a) ?? (a || "unbekannt");
}

const hostOf = (req: IncomingMessage): { raw: string; name: string } => {
  const raw = String(req.headers.host ?? "").trim();
  const name = normalizeName(raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.replace(/:\d+$/, ""));
  return { raw, name };
};

const dropTokens = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value.join(",") : (value ?? "")).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

function upstreamHeaders(req: IncomingMessage, ip: string, origHost: string, hostHeader: string, upgrade: boolean): OutgoingHttpHeaders {
  const drop = new Set(HOP);
  for (const t of dropTokens(req.headers.connection)) if (!(upgrade && t === "upgrade")) drop.add(t);
  if (upgrade) drop.delete("upgrade");
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || drop.has(k) || FORWARD_OWN.has(k) || k.startsWith("x-vylaris-")) continue;
    out[k] = v;
  }
  out.host = hostHeader;
  out["x-forwarded-for"] = ip; // Vorgaben des Besuchers werden verworfen
  out["x-real-ip"] = ip;
  out["x-forwarded-proto"] = "https";
  out["x-forwarded-host"] = origHost;
  if (upgrade) {
    out.connection = "Upgrade";
    out.upgrade = req.headers.upgrade;
  }
  return out;
}

function downstreamHeaders(up: IncomingMessage, route: Route): OutgoingHttpHeaders {
  const drop = new Set([...HOP, "server", "x-powered-by"]);
  for (const t of dropTokens(up.headers.connection)) drop.add(t);
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !drop.has(k)) out[k] = v;
  if (route.hardenHeaders) {
    out["x-content-type-options"] ??= "nosniff";
    out["referrer-policy"] ??= "strict-origin-when-cross-origin";
    out["strict-transport-security"] ??= "max-age=31536000";
  }
  return out;
}

const bracket = (h: string): string => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

function targetHostHeader(route: Route, up: { host: string; port: number; scheme: "http" | "https"; serverName?: string }, inv: Inventory, orig: string): string {
  if (route.preserveHost && orig) return orig;
  const base = route.upstream.type === "server" && up.serverName ? `${up.serverName}.${inv.settings.serverDomain}` : bracket(up.host);
  return up.port === (up.scheme === "https" ? 443 : 80) ? base : `${base}:${up.port}`;
}

const timeoutErr = (code: string, msg: string): Error => Object.assign(new Error(msg), { code });

export async function startProxy(opts: ProxyOptions = {}): Promise<ProxyHandle> {
  const startedAt = nowIso();
  const loadState =
    opts.loadState ??
    (async (): Promise<LoadedState> => {
      const inventory = await loadInventory();
      return { proxy: await loadProxy(inventory), inventory };
    });
  let live: Live = { rules: defaultProxyState().rules, routes: [], inv: defaultInventory() };

  const stats = new Map<string, RouteStats>();
  const removedSince = new Map<string, number>();
  const totals = emptyStats();
  let unknownHost = 0;
  const perMinute: ProxyRuntime["perMinute"] = [];
  const events: ProxyEvent[] = [];
  const limiter = new RateLimiter();
  const eventThrottle = new Throttle();
  const eventBudget = new Budget(120);
  const wsSockets = new Set<Socket>();

  const agents = {
    http: new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 }),
    httpsInsecure: new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, rejectUnauthorized: false }),
  };

  /* ------------------------------------------------------------ Statistik */
  const statsFor = (id: string): RouteStats => {
    let s = stats.get(id);
    if (!s) stats.set(id, (s = emptyStats()));
    return s;
  };
  const count = (route: Route | null, fn: (s: RouteStats) => void): void => {
    fn(totals);
    if (route) fn(statsFor(route.id));
  };
  const minute = (fn: (m: ProxyRuntime["perMinute"][number]) => void): void =>
    bumpMinute(perMinute, (t) => ({ t, req: 0, bytesIn: 0, bytesOut: 0, blocked: 0 }), fn);

  const recordEvent = (reason: Reason, host: string, ip: string, detail?: string): void => {
    if (!eventBudget.allow() || !eventThrottle.allow(`${reason}|${ip}`, 30_000)) return;
    events.unshift({ t: nowIso(), host: host.slice(0, 253), ip, reason, ...(detail ? { detail: detail.slice(0, 120) } : {}) });
    if (events.length > 100) events.pop();
  };

  const finalize = (ctx: Ctx, status: number): void => {
    if (ctx.done) return;
    ctx.done = true;
    const lat = ctx.latency ?? Date.now() - ctx.start;
    const now = nowIso();
    count(ctx.route, (s) => {
      s.requests++;
      s.bytesIn += ctx.bytesIn;
      s.bytesOut += ctx.bytesOut;
      s.latencyMs += lat;
      s.lastRequestAt = now;
      if (status >= 500) s.s5xx++;
      else if (status >= 400) s.s4xx++;
      else if (status >= 300) s.s3xx++;
      else if (status >= 200) s.s2xx++;
    });
    minute((m) => {
      m.req++;
      m.bytesIn += ctx.bytesIn;
      m.bytesOut += ctx.bytesOut;
    });
  };

  const snapshot = (): ProxyRuntime => {
    const routes: Record<string, RouteStats> = {};
    for (const r of live.routes) routes[r.id] = { ...(stats.get(r.id) ?? emptyStats()) };
    for (const [id, s] of stats) if (!routes[id]) routes[id] = { ...s };
    return { updatedAt: nowIso(), startedAt, routes, totals: { ...totals }, unknownHost, perMinute: perMinute.map((m) => ({ ...m })), events: events.map((e) => ({ ...e })) };
  };

  const cleanup = (): void => {
    const now = Date.now();
    const ids = new Set(live.routes.map((r) => r.id));
    for (const id of ids) removedSince.delete(id);
    for (const id of stats.keys()) {
      if (ids.has(id)) continue;
      const since = removedSince.get(id) ?? now;
      removedSince.set(id, since);
      if (now - since > DAY_MS) {
        stats.delete(id);
        removedSince.delete(id);
      }
    }
    limiter.sweep();
  };

  const writeStats =
    opts.writeStats === undefined ? async (rt: ProxyRuntime) => writeJsonAtomic(FILES.proxyRuntime, rt) : opts.writeStats;
  const flush = async (): Promise<void> => {
    cleanup();
    if (!writeStats) return;
    try {
      await writeStats(snapshot());
    } catch (e) {
      log("proxy", `Statistik nicht geschrieben: ${(e as Error).message}`);
    }
  };

  /* --------------------------------------------------------- Konfiguration */
  let reloading: Promise<void> = Promise.resolve();
  const reload = (): Promise<void> => {
    reloading = reloading.then(async () => {
      try {
        const s = await loadState();
        live = { rules: s.proxy.rules, routes: s.proxy.routes, inv: s.inventory };
        log("proxy", `Konfiguration geladen: ${live.routes.length} Route(n)`);
      } catch (e) {
        log("proxy", `Konfiguration nicht geladen (alter Stand bleibt): ${(e as Error).message}`);
      }
    });
    return reloading;
  };

  /* ---------------------------------------------------------- Prüfungen */
  type Pre = { ip: string; host: { raw: string; name: string }; route: Route | null; deny?: { status: number; reason: Reason; retryAfter?: number } };

  /** Gemeinsame Prüfungen für normale Anfragen und Upgrades (WebSocket). */
  const precheck = (req: IncomingMessage): Pre => {
    const ip = clientIpOf(req);
    const host = hostOf(req);
    const route = host.name ? (matchRoute(live.routes, host.name) ?? null) : null;
    const pre: Pre = { ip, host, route };
    const deny = (status: number, reason: Reason, retryAfter?: number): Pre => {
      pre.deny = { status, reason, retryAfter };
      return pre;
    };
    if (!route) return deny(404, "unknown-host");
    const { rules } = live;
    if (inAnyNet(rules.blockedIps, ip)) return deny(403, "blocked-ip");
    if (inAnyNet(route.denyIps, ip)) return deny(403, "deny-ip");
    if (route.allowIps.length > 0 && !inAnyNet(route.allowIps, ip)) return deny(403, "not-allowed");
    const ua = String(req.headers["user-agent"] ?? "").toLowerCase();
    if (ua && rules.blockedUserAgents.some((b) => ua.includes(b))) return deny(403, "user-agent");
    const limit = route.rateLimitPerMinute > 0 ? route.rateLimitPerMinute : rules.rateLimitPerMinute;
    const rl = limiter.check(`${route.id}|${ip}`, limit);
    if (!rl.ok) return deny(429, "rate-limit", rl.retryAfterSec);
    return pre;
  };

  const countDeny = (pre: Pre): void => {
    const d = pre.deny!;
    if (d.reason === "unknown-host") {
      unknownHost++;
    } else if (d.reason === "rate-limit") {
      count(pre.route, (s) => s.rateLimited++);
      minute((m) => m.blocked++);
    } else {
      count(pre.route, (s) => s.blocked++);
      minute((m) => m.blocked++);
    }
    recordEvent(d.reason, pre.host.name || pre.host.raw, pre.ip);
  };

  const sendPage = (res: ServerResponse, status: number, extra: Record<string, string | number> = {}): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { ...errorHeaders(status), ...extra });
    res.end(errorPage(status));
  };

  const rawReject = (socket: Socket, status: number): void => {
    socket.end(`HTTP/1.1 ${status} ${statusText(status)}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroySoon();
  };

  const upstreamFailure = (route: Route | null, host: string, ip: string, err: Error & { code?: string }): number => {
    count(route, (s) => s.upstreamErrors++);
    recordEvent("upstream-error", host, ip, err.code ?? "Fehler");
    return err.code === "ECONNTIMEOUT" || err.code === "ERESPTIMEOUT" ? 504 : 502;
  };

  /* ---------------------------------------------------------- Anfragen */
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const ctx: Ctx = { start: Date.now(), route: null, bytesIn: 0, bytesOut: 0, done: false, counted101: false };
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    res.on("close", () => finalize(ctx, res.statusCode));

    const { name } = hostOf(req);
    if ((name === "localhost" || name === "127.0.0.1" || name === "[::1]") && !matchRoute(live.routes, name)) {
      if (req.url === "/healthz" || req.url?.startsWith("/healthz?")) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("ok");
        ctx.done = true; // Gesundheitsabfragen nicht mitzählen
        return;
      }
    }

    const pre = precheck(req);
    ctx.route = pre.route;
    if (pre.deny) {
      countDeny(pre);
      sendPage(res, pre.deny.status, pre.deny.retryAfter ? { "retry-after": pre.deny.retryAfter } : {});
      return;
    }
    const route = pre.route!;
    const { rules, inv } = live;

    const maxBytes = rules.maxBodyMb * 1024 * 1024;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      count(route, (s) => s.blocked++);
      minute((m) => m.blocked++);
      recordEvent("too-large", pre.host.name, pre.ip);
      sendPage(res, 413, { connection: "close" });
      return;
    }

    const target = resolveUpstream(route, inv);
    if (!target) {
      upstreamFailure(route, pre.host.name, pre.ip, Object.assign(new Error("kein Ziel"), { code: "NOTARGET" }));
      sendPage(res, 503);
      return;
    }

    const headers = upstreamHeaders(req, pre.ip, pre.host.raw, targetHostHeader(route, target, inv, pre.host.raw), false);
    const isHttps = target.scheme === "https";
    const options: RequestOptions & https.RequestOptions = {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      setHost: false,
      agent: isHttps ? (route.insecureUpstream ? agents.httpsInsecure : agents.https) : agents.http,
    };
    if (isHttps) {
      const sni = String(headers.host).replace(/:\d+$/, "");
      if (!isIp(sni.replace(/^\[|\]$/g, ""))) options.servername = sni;
    }

    let aborted = false;
    let up: http.ClientRequest;
    try {
      up = (isHttps ? https : http).request(options);
    } catch {
      sendPage(res, 400);
      return;
    }
    up.on("socket", (s) => {
      if (!s.connecting) return;
      const t = setTimeout(() => up.destroy(timeoutErr("ECONNTIMEOUT", "Verbindungs-Zeitlimit")), CONNECT_TIMEOUT_MS);
      s.once("connect", () => clearTimeout(t));
      up.once("close", () => clearTimeout(t));
    });
    up.setTimeout(rules.upstreamTimeoutSec * 1000, () => up.destroy(timeoutErr("ERESPTIMEOUT", "Antwort-Zeitlimit")));
    up.on("error", (err: Error & { code?: string }) => {
      if (aborted) return;
      const status = upstreamFailure(route, pre.host.name, pre.ip, err);
      if (res.headersSent) res.destroy();
      else sendPage(res, status);
    });
    up.on("response", (upRes) => {
      ctx.latency = Date.now() - ctx.start;
      res.writeHead(upRes.statusCode ?? 502, downstreamHeaders(upRes, route));
      upRes.on("data", (c: Buffer) => {
        ctx.bytesOut += c.length;
      });
      upRes.on("error", () => res.destroy());
      upRes.pipe(res);
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        aborted = true;
        up.destroy();
      }
    });

    req.on("data", (c: Buffer) => {
      ctx.bytesIn += c.length;
      if (!aborted && ctx.bytesIn > maxBytes) {
        aborted = true;
        req.unpipe(up);
        up.destroy();
        count(route, (s) => s.blocked++);
        minute((m) => m.blocked++);
        recordEvent("too-large", pre.host.name, pre.ip);
        sendPage(res, 413, { connection: "close" });
      }
    });
    req.pipe(up);
  };

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const ctx: Ctx = { start: Date.now(), route: null, bytesIn: 0, bytesOut: 0, done: false, counted101: false };
    socket.on("error", () => socket.destroy());
    wsSockets.add(socket);
    let status = 0;
    socket.once("close", () => {
      wsSockets.delete(socket);
      finalize(ctx, status);
    });

    const pre = precheck(req);
    ctx.route = pre.route;
    if (pre.deny) {
      status = pre.deny.status;
      countDeny(pre);
      rawReject(socket, status);
      return;
    }
    const route = pre.route!;
    const { inv } = live;
    const target = resolveUpstream(route, inv);
    if (!target) {
      status = 503;
      upstreamFailure(route, pre.host.name, pre.ip, Object.assign(new Error("kein Ziel"), { code: "NOTARGET" }));
      rawReject(socket, 503);
      return;
    }
    const headers = upstreamHeaders(req, pre.ip, pre.host.raw, targetHostHeader(route, target, inv, pre.host.raw), true);
    const isHttps = target.scheme === "https";
    const options: https.RequestOptions = { host: target.host, port: target.port, method: req.method, path: req.url, headers, setHost: false, agent: false };
    if (isHttps) {
      options.rejectUnauthorized = !route.insecureUpstream;
      const sni = String(headers.host).replace(/:\d+$/, "");
      if (!isIp(sni.replace(/^\[|\]$/g, ""))) options.servername = sni;
    }
    let up: http.ClientRequest;
    try {
      up = (isHttps ? https : http).request(options);
    } catch {
      status = 400;
      rawReject(socket, 400);
      return;
    }
    const fail = (err: Error & { code?: string }): void => {
      status = upstreamFailure(route, pre.host.name, pre.ip, err);
      rawReject(socket, status);
    };
    up.on("socket", (s) => {
      if (!s.connecting) return;
      const t = setTimeout(() => up.destroy(timeoutErr("ECONNTIMEOUT", "Verbindungs-Zeitlimit")), CONNECT_TIMEOUT_MS);
      s.once("connect", () => clearTimeout(t));
      up.once("close", () => clearTimeout(t));
    });
    let established = false;
    up.on("error", (err: Error & { code?: string }) => {
      if (established) socket.destroy();
      else fail(err);
    });
    socket.on("close", () => up.destroy());

    // Der Ursprung lehnt das Upgrade ab und antwortet normal: unverändert zurückreichen.
    up.on("response", (upRes) => {
      established = true;
      status = upRes.statusCode ?? 502;
      ctx.latency = Date.now() - ctx.start;
      let raw = `HTTP/1.1 ${status} ${upRes.statusMessage ?? ""}\r\n`;
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        const k = upRes.rawHeaders[i]!;
        if (!HOP.has(k.toLowerCase()) && !["server", "x-powered-by"].includes(k.toLowerCase())) raw += `${k}: ${upRes.rawHeaders[i + 1]}\r\n`;
      }
      socket.write(`${raw}Connection: close\r\n\r\n`);
      upRes.on("data", (c: Buffer) => {
        ctx.bytesOut += c.length;
      });
      upRes.pipe(socket);
    });

    up.on("upgrade", (upRes, upSocket, upHead) => {
      established = true;
      status = 101;
      ctx.latency = Date.now() - ctx.start;
      upSocket.on("error", () => socket.destroy());
      upSocket.setNoDelay(true);
      socket.setNoDelay(true);
      let raw = `HTTP/1.1 101 ${upRes.statusMessage || "Switching Protocols"}\r\n`;
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        const k = upRes.rawHeaders[i]!;
        if (!["server", "x-powered-by"].includes(k.toLowerCase())) raw += `${k}: ${upRes.rawHeaders[i + 1]}\r\n`;
      }
      socket.write(`${raw}\r\n`);
      if (upHead.length) {
        ctx.bytesOut += upHead.length;
        socket.write(upHead);
      }
      upSocket.on("data", (c: Buffer) => {
        ctx.bytesOut += c.length;
      });
      socket.on("data", (c: Buffer) => {
        ctx.bytesIn += c.length;
      });
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on("close", () => socket.destroy());
      socket.on("close", () => upSocket.destroy());
      // Schließt eine Seite ihre Hälfte, bekommt die andere Seite kurz Zeit zum Auslaufen, danach wird alles beendet
      // (HTTP-Server halten Sockets halb offen; ohne das blieben Verbindungen hängen).
      const grace = (): void => {
        const t = setTimeout(() => {
          socket.destroy();
          upSocket.destroy();
        }, 1000);
        t.unref();
      };
      socket.once("end", grace);
      upSocket.once("end", grace);
    });
    up.end(head.length ? head : undefined);
  };

  /* ------------------------------------------------------------- Server */
  const server = http.createServer({ keepAliveTimeout: 75_000, headersTimeout: 20_000, requestTimeout: 600_000 }, onRequest);
  server.on("upgrade", onUpgrade);
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });

  await reload();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? Number(process.env.PROXY_PORT ?? 8081), opts.bind ?? process.env.PROXY_BIND ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const stopWatch = opts.watch === false ? () => undefined : watchFiles([FILES.proxy, FILES.inventory], reload, opts.watchIntervalMs ?? 2000);
  const timer = setInterval(() => void flush(), opts.statsIntervalMs ?? 10_000);
  timer.unref();
  void flush();

  const close = async (): Promise<void> => {
    stopWatch();
    clearInterval(timer);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    const force = setTimeout(() => {
      server.closeAllConnections();
      for (const s of wsSockets) s.destroy();
    }, 5000);
    force.unref();
    await closed;
    clearTimeout(force);
    agents.http.destroy();
    agents.https.destroy();
    agents.httpsInsecure.destroy();
    await flush();
  };

  return { server, port, reload, snapshot, flush, close };
}
