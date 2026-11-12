import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { AreaChart } from "@/components/admin/charts";
import { Area, Field, Hidden, Pick } from "@/components/admin/fields";
import { ActionForm, RowAction } from "@/components/admin/ui";
import { buildIpRows, serverFqdn, serverIps, serverPrimaryIp, subnetOf } from "@/lib/core/inventory-model";
import { getInventory } from "@/lib/server/inventory";
import { requireAdmin } from "@/lib/server/guard";
import { getProxy } from "@/lib/server/proxy";
import { getScan, getTraffic } from "@/lib/server/runtime";
import { ago, bps, bytes, time, uptime } from "@/lib/format";
import { assignIpAction, assignNextFreeAction, deleteServerAction, saveServerAction, setPrimaryAction, unassignIpAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ServerPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const [inv, scan, traffic, proxy] = await Promise.all([getInventory(), getScan(), getTraffic(), getProxy()]);
  const server = inv.servers.find((s) => s.id === id);
  if (!server) notFound();
  const ips = serverIps(inv, id);
  const primary = serverPrimaryIp(inv, server);
  const series = traffic?.series.find((x) => x.serverId === id);
  const routes = proxy.routes.filter((r) => r.upstream.type === "server" && r.upstream.serverId === id);
  // freie Adressen zur Auswahl (je Netz höchstens 40)
  const freeByNet = inv.subnets.map((sn) => ({ sn, free: buildIpRows(inv, sn, scan).filter((r) => r.kind === "host" && !r.isGateway && r.status === "free").slice(0, 40) })).filter((x) => x.free.length > 0);

  return (
    <AdminShell user={admin.username} active="/admin/server/" title={server.name} crumb={{ href: "/admin/server/", label: "Alle Server" }} lead={`Erreichbar unter dem Namen ${serverFqdn(server, inv)}${server.dnsVisibility === "internal" ? " (nur intern auflösbar)" : ""}.`}>
      <h2 className="admin-h2">IP-Adressen ({ips.length})</h2>
      <p className="muted">Eine VM kann mehrere Adressen haben – auch mehrere IPv4. Die Hauptadresse (★) nutzen Proxy und DNS, wenn der Server als Ziel gewählt ist.</p>
      {ips.length === 0 ? (
        <p className="muted">Noch keine Adresse zugewiesen.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Adresse</th><th>Netz</th><th>Erreichbar</th><th>MAC</th><th>PTR</th><th /></tr></thead>
            <tbody>
              {ips.map((ip) => {
                const h = scan?.hosts[ip];
                const sn = subnetOf(inv, ip);
                const entry = inv.ips.find((e) => e.ip === ip);
                return (
                  <tr key={ip}>
                    <td className="mono"><strong>{ip}</strong> {ip === primary && <span className="pill assigned">Haupt</span>}</td>
                    <td>{sn ? <Link href={`/admin/ip/${sn.id}/`}>{sn.name}</Link> : <span className="muted">kein Netz</span>}</td>
                    <td><span className={`dot ${h ? (h.up ? "up" : "down") : "unknown"}`} />{h ? (h.up ? "ja" : `nein (zuletzt ${ago(h.lastUp)})`) : "nicht geprüft"}</td>
                    <td className="mono">{h?.mac ?? "–"}</td>
                    <td className="mono">{entry?.ptr ?? "–"}</td>
                    <td className="acts">
                      {ip !== primary && <RowAction action={setPrimaryAction} fields={{ serverId: id, ip }} label="Zur Hauptadresse" />}
                      <RowAction action={unassignIpAction} fields={{ serverId: id, ip }} label="Entfernen" confirm={`${ip} vom Server entfernen? Die Adresse wird wieder frei.`} danger />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="admin-grid">
        <div className="admin-card">
          <h2>Adresse hinzufügen</h2>
          <ActionForm action={assignIpAction} submit="Zuweisen" resetOnOk>
            <Hidden name="serverId" value={id} />
            {freeByNet.length > 0 && (
              <Pick label="Freie Adresse wählen" name="ipPick" options={[{ value: "", label: "– oder unten eintippen –" }, ...freeByNet.flatMap(({ sn, free }) => free.map((r) => ({ value: r.ip, label: `${r.ip}  (${sn.name})` })))]} />
            )}
            <Field label="Adresse eintippen" name="ip" placeholder="203.0.113.12" mono hint="Hat Vorrang vor der Auswahl. IPv4 oder IPv6." />
            <Field label="PTR (Rückwärtsname, optional)" name="ptr" placeholder={serverFqdn(server, inv)} mono />
          </ActionForm>
          {inv.subnets.length > 0 && (
            <>
              <h3>Nächste freie Adresse</h3>
              <div className="inline-form">
                {inv.subnets.map((sn) => (
                  <ActionForm key={sn.id} action={assignNextFreeAction} submit={`aus ${sn.name}`} variant="secondary" className="form">
                    <Hidden name="serverId" value={id} />
                    <Hidden name="subnetId" value={sn.id} />
                  </ActionForm>
                ))}
              </div>
            </>
          )}
          <div className="hint-box">
            <strong>Wichtig:</strong> Das Panel verwaltet nur die Zuordnung. Damit die VM die zusätzliche Adresse wirklich nutzt, muss sie im Gast-Betriebssystem eingetragen sein (siehe Anleitung „Mehrere IPv4 pro VM“ in der README).
          </div>
        </div>
        <div className="admin-card">
          <h2>Einstellungen</h2>
          <ActionForm action={saveServerAction} submit="Speichern">
            <Hidden name="id" value={id} />
            <Field label="Name" name="name" defaultValue={server.name} required mono />
            <Field label="Aufgabe" name="role" defaultValue={server.role ?? ""} />
            <div className="cols-2">
              <Field label="Proxmox-Knoten" name="node" defaultValue={server.node ?? ""} />
              <Field label="VM-ID" name="vmid" defaultValue={server.vmid ?? ""} inputMode="numeric" />
            </div>
            <Pick label="Domainname im Internet" name="dnsVisibility" defaultValue={server.dnsVisibility} options={[{ value: "internal", label: "Nur intern auflösbar (empfohlen)" }, { value: "public", label: "Öffentlich auflösbar" }]} />
            <Pick label="Hauptadresse" name="primaryIp" defaultValue={server.primaryIp ?? ""} options={[{ value: "", label: "automatisch (erste IPv4)" }, ...ips.map((ip) => ({ value: ip, label: ip }))]} />
            <Area label="Notiz" name="note" defaultValue={server.note ?? ""} rows={2} />
          </ActionForm>
        </div>
      </div>

      <h2 className="admin-h2">Traffic</h2>
      {series ? (
        <div className="chart">
          <h3>{series.label} <span className="muted small">({series.status ?? "?"} · Laufzeit {uptime(series.uptimeSec)})</span></h3>
          <div className="meta">
            <span>Empfangen <b>{bps(series.rxBps)}</b> · gesamt {bytes(series.rxBytes)}</span>
            <span>Gesendet <b>{bps(series.txBps)}</b> · gesamt {bytes(series.txBytes)}</span>
            {series.cpu !== undefined && <span>CPU <b>{Math.round(series.cpu * 100)} %</b></span>}
          </div>
          <AreaChart points={series.points.map((p) => ({ t: p.t, a: p.rxBps, b: p.txBps }))} />
        </div>
      ) : (
        <p className="muted">Kein Traffic zugeordnet. Trage bei den Einstellungen Proxmox-Knoten und VM-ID ein und richte unter <Link href="/admin/integrationen/">Anbindungen</Link> Proxmox ein.</p>
      )}

      <h2 className="admin-h2">Proxy-Routen auf diesen Server ({routes.length})</h2>
      {routes.length === 0 ? <p className="muted">Keine. Routen legst du unter <Link href="/admin/proxy/">Proxy</Link> an.</p> : (
        <ul className="dots">{routes.map((r) => <li key={r.id}><code>{r.host}</code> → Port {r.upstream.type === "server" ? r.upstream.port : ""}</li>)}</ul>
      )}

      <h2 className="admin-h2">Server löschen</h2>
      <div className="admin-card">
        <p className="muted">Entfernt den Server und gibt alle seine Adressen frei. Proxy-Routen auf diesen Server werden entfernt. Die VM selbst in Proxmox bleibt unberührt. Zuletzt geändert: {time(inv.updatedAt)}.</p>
        <ActionForm action={deleteServerAction} submit="Server löschen" variant="danger" confirm={`Server „${server.name}“ wirklich löschen?`}>
          <Hidden name="id" value={id} />
        </ActionForm>
      </div>
    </AdminShell>
  );
}
