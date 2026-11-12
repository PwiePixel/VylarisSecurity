import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { AreaChart } from "@/components/admin/charts";
import { serverFqdn } from "@/lib/core/inventory-model";
import type { TrafficSeries } from "@/lib/core/runtime-model";
import { getInventory } from "@/lib/server/inventory";
import { requireAdmin } from "@/lib/server/guard";
import { getDnsRuntime, getProxyRuntime, getTraffic } from "@/lib/server/runtime";
import { ago, bps, bytes, num, uptime } from "@/lib/format";

export const dynamic = "force-dynamic";

function SeriesChart({ s, link }: { s: TrafficSeries; link?: { href: string; label: string } }) {
  return (
    <div className="chart">
      <h3>{link ? <Link href={link.href}>{link.label}</Link> : s.label} {s.status && <span className="muted small">· {s.status}{s.uptimeSec ? ` · Laufzeit ${uptime(s.uptimeSec)}` : ""}</span>}</h3>
      <div className="meta">
        <span>↓ <b>{bps(s.rxBps)}</b> ({bytes(s.rxBytes)})</span>
        <span>↑ <b>{bps(s.txBps)}</b> ({bytes(s.txBytes)})</span>
        {s.cpu !== undefined && <span>CPU <b>{Math.round(s.cpu * 100)} %</b></span>}
      </div>
      <AreaChart points={s.points.map((p) => ({ t: p.t, a: p.rxBps, b: p.txBps }))} />
    </div>
  );
}

export default async function TrafficPage() {
  const admin = await requireAdmin();
  const [traffic, proxy, dns, inv] = await Promise.all([getTraffic(), getProxyRuntime(), getDnsRuntime(), getInventory()]);
  const vms = traffic?.series.filter((s) => s.kind === "proxmox-vm") ?? [];
  const nodes = traffic?.series.filter((s) => s.kind === "proxmox-node") ?? [];
  const ifaces = traffic?.series.filter((s) => s.kind === "host-interface") ?? [];
  const totalRx = vms.reduce((a, s) => a + s.rxBps, 0);
  const totalTx = vms.reduce((a, s) => a + s.txBps, 0);

  return (
    <AdminShell user={admin.username} active="/admin/traffic/" title="Traffic" lead="Netzwerkverkehr der VMs (aus Proxmox), der Schnittstellen dieses Servers, des Proxys und des DNS-Servers. Aktualisiert sich etwa alle 30 Sekunden – Seite neu laden für den neuesten Stand.">
      <div className="grid-4">
        <div className="kpi"><span className="v">{vms.length}</span><span className="l">VMs mit Messwerten{traffic ? ` · ${ago(traffic.updatedAt)}` : ""}</span></div>
        <div className="kpi"><span className="v">{bps(totalRx)}</span><span className="l">Eingang aller VMs (↓)</span></div>
        <div className="kpi"><span className="v">{bps(totalTx)}</span><span className="l">Ausgang aller VMs (↑)</span></div>
        <div className="kpi"><span className="v">{proxy ? num(proxy.totals.requests) : "–"}</span><span className="l">Proxy-Anfragen seit Start</span></div>
      </div>

      <h2 className="admin-h2">VMs (Proxmox)</h2>
      {vms.length === 0 ? (
        <p className="muted">Keine Messwerte. Richte unter <Link href="/admin/integrationen/">Anbindungen</Link> den Zugang zu Proxmox ein.</p>
      ) : (
        <div className="grid-3">
          {vms.map((s) => {
            const sv = inv.servers.find((x) => x.id === s.serverId);
            return <SeriesChart key={s.key} s={s} link={sv ? { href: `/admin/server/${sv.id}/`, label: `${sv.name} (${serverFqdn(sv, inv)})` } : undefined} />;
          })}
        </div>
      )}

      {nodes.length > 0 && (
        <>
          <h2 className="admin-h2">Proxmox-Knoten</h2>
          <div className="grid-3">{nodes.map((s) => <SeriesChart key={s.key} s={s} />)}</div>
        </>
      )}

      <h2 className="admin-h2">Schnittstellen dieses Servers</h2>
      {ifaces.length === 0 ? <p className="muted">Keine Daten (Worker läuft nicht oder liefert noch nichts).</p> : <div className="grid-3">{ifaces.map((s) => <SeriesChart key={s.key} s={s} />)}</div>}

      <h2 className="admin-h2">Proxy</h2>
      {!proxy ? <p className="muted">Keine Daten.</p> : (
        <>
          <div className="grid-3">
            <div className="chart">
              <h3>Anfragen pro Minute</h3>
              <div className="meta"><span>Gesamt <b>{num(proxy.totals.requests)}</b></span><span>abgewehrt <b>{num(proxy.totals.blocked + proxy.totals.rateLimited)}</b></span><span>Fehler <b>{num(proxy.totals.s5xx + proxy.totals.upstreamErrors)}</b></span></div>
              <AreaChart points={proxy.perMinute.map((m) => ({ t: m.t, a: m.req, b: m.blocked }))} fmt={(n) => `${num(n)} / min`} labels={["Anfragen", "abgewehrt"]} />
            </div>
            <div className="chart">
              <h3>Datenmenge pro Minute</h3>
              <div className="meta"><span>Ein <b>{bytes(proxy.totals.bytesIn)}</b></span><span>Aus <b>{bytes(proxy.totals.bytesOut)}</b></span></div>
              <AreaChart points={proxy.perMinute.map((m) => ({ t: m.t, a: m.bytesIn, b: m.bytesOut }))} fmt={(n) => `${bytes(n)} / min`} labels={["Eingang", "Ausgang"]} />
            </div>
          </div>
        </>
      )}

      <h2 className="admin-h2">DNS-Server</h2>
      {!dns ? <p className="muted">Keine Daten.</p> : (
        <div className="grid-3">
          <div className="chart">
            <h3>Anfragen pro Minute</h3>
            <div className="meta"><span>Gesamt <b>{num(dns.totals.queries)}</b></span><span>UDP <b>{num(dns.totals.udp)}</b></span><span>TCP <b>{num(dns.totals.tcp)}</b></span></div>
            <AreaChart points={dns.perMinute.map((m) => ({ t: m.t, a: m.q }))} fmt={(n) => `${num(n)} / min`} labels={["Anfragen", ""]} />
          </div>
          <div className="chart">
            <h3>Antworten</h3>
            <ul className="dots">
              <li>Erfolgreich: <b>{num(dns.totals.noerror)}</b></li>
              <li>Nicht vorhanden (NXDOMAIN): <b>{num(dns.totals.nxdomain)}</b></li>
              <li>Abgelehnt (fremde Domain): <b>{num(dns.totals.refused)}</b></li>
              <li>Durch Limit verworfen: <b>{num(dns.totals.rateLimited)}</b></li>
              <li>Interne Sicht: <b>{num(dns.totals.internalViews)}</b></li>
            </ul>
          </div>
          <div className="chart">
            <h3>Häufigste Typen und Zonen</h3>
            <p className="small">{Object.entries(dns.byType).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}: ${num(v)}`).join(" · ") || "–"}</p>
            <p className="small">{Object.entries(dns.byZone).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}: ${num(v)}`).join(" · ") || "–"}</p>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
