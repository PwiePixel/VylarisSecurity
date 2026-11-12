import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { AuditTable } from "@/components/admin/AuditTable";
import { Status } from "@/components/ui";
import { buildIpRows, serverFqdn, serverIps, summarizeRows } from "@/lib/core/inventory-model";
import { getAudit } from "@/lib/server/audit";
import { getCompiled, getDns } from "@/lib/server/dns";
import { requireAdmin } from "@/lib/server/guard";
import { getInventory } from "@/lib/server/inventory";
import { getLegal, legalGaps } from "@/lib/server/legal";
import { getProxy } from "@/lib/server/proxy";
import { getProxyRuntime, getScan, getSystem, getTraffic, getWorkerRuntime } from "@/lib/server/runtime";
import { bps, num } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const admin = await requireAdmin();
  const [system, dns, compiled, inv, proxy, scan, traffic, proxyRt, worker, events, legal] = await Promise.all([
    getSystem(), getDns(), getCompiled(), getInventory(), getProxy(), getScan(), getTraffic(), getProxyRuntime(), getWorkerRuntime(), getAudit(8), getLegal(),
  ]);
  const nets = inv.subnets.map((sn) => ({ sn, rows: buildIpRows(inv, sn, scan) }));
  const sums = nets.map((n) => summarizeRows(n.rows));
  const usable = sums.reduce((a, s) => a + s.usable, 0);
  const free = sums.reduce((a, s) => a + s.free, 0);
  const assigned = sums.reduce((a, s) => a + s.assigned, 0);
  const vms = traffic?.series.filter((s) => s.kind === "proxmox-vm") ?? [];

  // Hinweise, die Aufmerksamkeit brauchen
  const alerts: { text: string; href: string }[] = [];
  for (const s of system) if (s.tone === "warn") alerts.push({ text: `${s.name}: ${s.label} – ${s.detail}`, href: s.id === "dns" ? "/admin/dns/" : s.id === "proxy" ? "/admin/proxy/" : "/admin/integrationen/" });
  for (const n of nets) for (const r of n.rows) if (r.alert === "free-but-up") alerts.push({ text: `${r.ip} (${n.sn.name}) ist als frei markiert, antwortet aber – Adresskonflikt?`, href: `/admin/ip/${n.sn.id}/?ip=${r.ip}` });
  for (const s of inv.servers) {
    const ips = serverIps(inv, s.id);
    const down = ips.filter((ip) => scan?.hosts[ip] && !scan.hosts[ip]!.up);
    if (ips.length > 0 && down.length === ips.length) alerts.push({ text: `${serverFqdn(s, inv)}: keine seiner Adressen antwortet.`, href: `/admin/server/${s.id}/` });
  }
  for (const w of compiled.warnings) alerts.push({ text: w, href: "/admin/dns/" });
  const gaps = legalGaps(legal);
  if (!admin.totp?.enabled) alerts.push({ text: "Die Zwei-Faktor-Anmeldung ist nicht aktiv (dringend empfohlen).", href: "/admin/sicherheit/" });

  return (
    <AdminShell user={admin.username} active="/admin/" title="Übersicht" lead="Der Zustand der ganzen Gruppe auf einen Blick: DNS, Proxy, Server, IP-Adressen und Netzwerkverkehr.">
      {alerts.length > 0 ? (
        <>
          <h2 className="admin-h2" style={{ marginTop: "1rem" }}>Braucht Aufmerksamkeit</h2>
          <ul className="alerts">{alerts.slice(0, 12).map((a, i) => <li key={i}>{a.text} <Link href={a.href}>Ansehen</Link></li>)}</ul>
        </>
      ) : (
        <p style={{ marginTop: "1rem" }}><Status tone="ok">Alles in Ordnung</Status></p>
      )}

      <div className="grid-4" style={{ marginTop: "1.5rem" }}>
        <div className="kpi"><span className="v">{dns.zones.length}</span><span className="l">DNS-Zonen · <Link href="/admin/dns/">verwalten</Link></span></div>
        <div className="kpi"><span className="v">{inv.servers.length}</span><span className="l">Server · <Link href="/admin/server/">verwalten</Link></span></div>
        <div className="kpi"><span className="v">{num(assigned)} / {num(usable)}</span><span className="l">IP-Adressen zugewiesen ({num(free)} frei) · <Link href="/admin/ip/">ansehen</Link></span></div>
        <div className="kpi"><span className="v">{proxy.routes.filter((r) => r.enabled).length}</span><span className="l">Proxy-Routen · <Link href="/admin/proxy/">verwalten</Link></span></div>
      </div>

      <div className="admin-grid">
        <div className="admin-card">
          <h2>Systeme</h2>
          <ul className="sys">
            {system.map((s) => (
              <li key={s.id}><div><strong>{s.name}</strong><span className="d">{s.detail}</span></div><Status tone={s.tone}>{s.label}</Status></li>
            ))}
          </ul>
        </div>
        <div className="admin-card">
          <h2>Verkehr jetzt</h2>
          <ul className="dots">
            <li>VMs mit Messwerten: <b>{vms.length}</b>{vms.length > 0 && <> · Eingang <b>{bps(vms.reduce((a, s) => a + s.rxBps, 0))}</b> · Ausgang <b>{bps(vms.reduce((a, s) => a + s.txBps, 0))}</b></>}</li>
            <li>Proxy: <b>{proxyRt ? num(proxyRt.totals.requests) : "–"}</b> Anfragen, <b>{proxyRt ? num(proxyRt.totals.blocked + proxyRt.totals.rateLimited) : "–"}</b> abgewehrt</li>
            <li>Scan: {worker?.scan.lastRun ? `${worker.scan.hosts} Adressen geprüft` : "noch nicht gelaufen"}</li>
          </ul>
          <p><Link href="/admin/traffic/">Alle Diagramme</Link></p>
          <h3>Rechtliche Angaben</h3>
          <p>{gaps.length === 0 ? <Status tone="ok">Vollständig</Status> : <Status tone="warn">{gaps.length} Angabe(n) fehlen</Status>} · <Link href="/admin/rechtliches/">pflegen</Link></p>
        </div>
      </div>

      <h2 className="admin-h2">Letzte Ereignisse</h2>
      <AuditTable events={events} />
      <p><Link href="/admin/protokoll/">Gesamtes Protokoll ansehen</Link></p>
    </AdminShell>
  );
}
