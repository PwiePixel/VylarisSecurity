import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { Field, Pick, Area } from "@/components/admin/fields";
import { ActionForm } from "@/components/admin/ui";
import { serverFqdn, serverIps, serverPrimaryIp } from "@/lib/core/inventory-model";
import { getInventory } from "@/lib/server/inventory";
import { requireAdmin } from "@/lib/server/guard";
import { getScan, getTraffic } from "@/lib/server/runtime";
import { bps } from "@/lib/format";
import { saveServerAction, saveServerDomainAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ServersPage() {
  const admin = await requireAdmin();
  const [inv, scan, traffic] = await Promise.all([getInventory(), getScan(), getTraffic()]);
  return (
    <AdminShell
      user={admin.username}
      active="/admin/server/"
      title="Server"
      lead={`Jeder Server (jede VM) bekommt einen Namen unter ${inv.settings.serverDomain}. Mit diesem Namen – statt der IPv4-Adresse – bindest du ihn in Proxy, DNS und alles Weitere ein. Ein Server kann beliebig viele Adressen haben.`}
    >
      {inv.servers.length === 0 ? (
        <p className="muted">Noch kein Server. Lege unten den ersten an.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Name</th><th>Domainname</th><th>IP-Adressen</th><th>Proxmox</th><th className="num">Traffic jetzt</th><th /></tr>
            </thead>
            <tbody>
              {inv.servers.map((s) => {
                const ips = serverIps(inv, s.id);
                const primary = serverPrimaryIp(inv, s);
                const t = traffic?.series.find((x) => x.serverId === s.id);
                return (
                  <tr key={s.id}>
                    <td><Link href={`/admin/server/${s.id}/`}><strong>{s.name}</strong></Link>{s.role && <span className="muted block small">{s.role}</span>}</td>
                    <td className="mono">{serverFqdn(s, inv)}<span className="muted block small">{s.dnsVisibility === "internal" ? "nur intern sichtbar" : "öffentlich sichtbar"}</span></td>
                    <td className="mono">
                      {ips.length === 0 && <span className="muted">keine</span>}
                      {ips.map((ip) => {
                        const h = scan?.hosts[ip];
                        return (
                          <span className="block" key={ip}>
                            <span className={`dot ${h ? (h.up ? "up" : "down") : "unknown"}`} title={h ? (h.up ? "erreichbar" : "nicht erreichbar") : "nicht geprüft"} />
                            {ip}{ip === primary && ips.length > 1 ? " ★" : ""}
                          </span>
                        );
                      })}
                    </td>
                    <td>{s.node || s.vmid ? `${s.node ?? "?"} · VM ${s.vmid ?? "?"}` : <span className="muted">–</span>}</td>
                    <td className="num">{t ? `↓ ${bps(t.rxBps)} ↑ ${bps(t.txBps)}` : <span className="muted">–</span>}</td>
                    <td className="acts"><Link href={`/admin/server/${s.id}/`}>Öffnen</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="admin-grid">
        <div className="admin-card">
          <h2>Server anlegen</h2>
          <ActionForm action={saveServerAction} submit="Server anlegen">
            <Field label="Name" name="name" required placeholder="web01" hint={`Wird zu web01.${inv.settings.serverDomain}`} mono />
            <Field label="Aufgabe (optional)" name="role" placeholder="Webserver" />
            <div className="cols-2">
              <Field label="Proxmox-Knoten (optional)" name="node" placeholder="pve1" />
              <Field label="VM-ID (optional)" name="vmid" placeholder="101" inputMode="numeric" hint="Damit zeigt das Panel Traffic und Status dieser VM." />
            </div>
            <Pick label="Domainname im Internet" name="dnsVisibility" options={[{ value: "internal", label: "Nur intern auflösbar (Ursprungs-IP bleibt geschützt) – empfohlen" }, { value: "public", label: "Öffentlich auflösbar" }]} />
            <Area label="Notiz" name="note" rows={2} />
          </ActionForm>
          <p className="muted small">Die IP-Adressen weist du danach auf der Seite des Servers zu.</p>
        </div>
        <div className="admin-card">
          <h2>Domain für Server-Namen</h2>
          <p className="muted">Alle Server erhalten ihren Namen unterhalb dieser Domain. Dafür muss es in „DNS“ eine Zone geben, die sie enthält (z. B. <code>vylaris.it</code>) – Einträge entstehen automatisch.</p>
          <ActionForm action={saveServerDomainAction} submit="Speichern">
            <Field label="Server-Domain" name="serverDomain" defaultValue={inv.settings.serverDomain} mono />
          </ActionForm>
        </div>
      </div>
    </AdminShell>
  );
}
