import { AdminShell } from "@/components/admin/AdminShell";
import { Check, Field, Hidden } from "@/components/admin/fields";
import { ActionForm } from "@/components/admin/ui";
import { Status } from "@/components/ui";
import { getDns } from "@/lib/server/dns";
import { requireAdmin } from "@/lib/server/guard";
import { getInventory } from "@/lib/server/inventory";
import { getIntegrations, getResult, getSystem, getWorkerRuntime } from "@/lib/server/runtime";
import { ago, time } from "@/lib/format";
import { importVmsAction, saveCloudflareAction, saveProxmoxAction, workerRequestAction } from "./actions";

export const dynamic = "force-dynamic";

type Vm = { node: string; vmid: number; name: string; status?: string; ips?: string[] };

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ import?: string }> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const [integ, worker, dns, inv, system] = await Promise.all([getIntegrations(), getWorkerRuntime(), getDns(), getInventory(), getSystem()]);
  const cf = worker?.cloudflare;
  const pm = worker?.proxmox;
  const cfItem = system.find((s) => s.id === "cloudflare");
  const pmItem = system.find((s) => s.id === "proxmox");
  const importResult = sp.import ? await getResult(sp.import) : null;
  const foundVms = (importResult?.data as { vms?: unknown } | undefined)?.vms;
  const vms = importResult?.ok && Array.isArray(foundVms) ? (foundVms as Vm[]) : null;
  const known = new Set(inv.servers.filter((s) => s.vmid).map((s) => s.vmid));
  const cfZones = dns.zones.filter((z) => z.mode === "cloudflare");
  const protectedRecords = dns.zones.flatMap((z) => z.records.filter((r) => r.protect).map((r) => (r.name === "@" ? z.name : `${r.name}.${z.name}`)));

  return (
    <AdminShell user={admin.username} active="/admin/integrationen/" title="Anbindungen" lead="Cloudflare (DNS-Abgleich, DDoS-Schutz, Tunnel) und Proxmox (Traffic und Status der VMs). Geheime Schlüssel liegen nie im Panel, sondern nur in einer Datei auf dem Server – eingerichtet mit dem Installer.">
      <div className="admin-grid">
        <div className="admin-card">
          <div className="admin-row-head"><h2>Cloudflare</h2>{cfItem && <Status tone={cfItem.tone}>{cfItem.label}</Status>}</div>
          <p className="muted">{cfItem?.detail}</p>
          {!cf?.configured && (
            <div className="hint-box">Token einrichten (auf dem Server):<br /><code>./install.sh cloudflare</code></div>
          )}
          <ul className="dots" style={{ marginTop: "1rem" }}>
            <li>Token geprüft: {cf?.checkedAt ? ago(cf.checkedAt) : "noch nie"}</li>
            <li>Tunnel: {cf?.tunnelId ? <code>{cf.tunnelId.slice(0, 8)}…</code> : "nicht gesetzt"}</li>
            <li>Zonen bei Cloudflare: {cfZones.length}</li>
            <li>Mit Cloudflare abgesicherte Namen: {protectedRecords.length}</li>
          </ul>
          <ActionForm action={saveCloudflareAction} submit="Speichern">
            <Check label="Cloudflare-Anbindung verwenden" name="enabled" defaultChecked={integ.cloudflare.enabled} />
          </ActionForm>
          <ActionForm action={workerRequestAction} submit="Jetzt mit Cloudflare abgleichen" variant="secondary">
            <Hidden name="type" value="cloudflare-sync" />
          </ActionForm>
        </div>

        <div className="admin-card">
          <div className="admin-row-head"><h2>Proxmox</h2>{pmItem && <Status tone={pmItem.tone}>{pmItem.label}</Status>}</div>
          <p className="muted">{pm?.error ?? pmItem?.detail}{pm?.lastRun ? ` · letzte Abfrage ${ago(pm.lastRun)}` : ""}</p>
          <ActionForm action={saveProxmoxAction} submit="Speichern">
            <Check label="Proxmox anbinden (Traffic und Status der VMs)" name="enabled" defaultChecked={integ.proxmox.enabled} />
            <Field label="Adresse der Proxmox-Oberfläche" name="url" defaultValue={integ.proxmox.url} placeholder="https://192.168.1.10:8006" mono />
            <Field label="API-Token-ID" name="tokenId" defaultValue={integ.proxmox.tokenId} placeholder="security@pve!panel" mono hint="Das Geheimnis des Tokens trägst du mit ./install.sh proxmox auf dem Server ein." />
            <Check label="Zertifikat prüfen" name="verifyTls" defaultChecked={integ.proxmox.verifyTls} hint="Aus lassen, wenn Proxmox sein eigenes (selbstsigniertes) Zertifikat nutzt." />
          </ActionForm>
          <details>
            <summary>Token in Proxmox anlegen (nur lesen)</summary>
            <ol className="admin-steps">
              <li>Proxmox: Datacenter → Permissions → Users → Add: <code>security@pve</code>.</li>
              <li>Permissions → API Tokens → Add: Benutzer <code>security@pve</code>, Token-ID <code>panel</code>, „Privilege Separation“ <strong>aktiv</strong>. Das Geheimnis wird nur einmal angezeigt.</li>
              <li>Permissions → Add → API Token Permission: Pfad <code>/</code>, Token <code>security@pve!panel</code>, Rolle <strong>PVEAuditor</strong> (nur lesen), „Propagate“ an.</li>
            </ol>
          </details>
          <ActionForm action={workerRequestAction} submit="VMs aus Proxmox abfragen" variant="secondary">
            <Hidden name="type" value="proxmox-import" />
          </ActionForm>
        </div>
      </div>

      {sp.import && !importResult && <p className="alert ok">Abfrage läuft … Seite in ein paar Sekunden neu laden.</p>}
      {importResult && !importResult.ok && <p className="alert error">{importResult.message}</p>}
      {vms && (
        <div className="admin-card" style={{ marginTop: "1.5rem" }}>
          <h2>VMs in Proxmox ({vms.length})</h2>
          <ActionForm action={importVmsAction} submit="Ausgewählte als Server anlegen">
            <Hidden name="request" value={sp.import ?? ""} />
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th /><th>Name</th><th>Knoten · VM</th><th>Zustand</th><th>Adressen (Cloud-Init)</th></tr></thead>
                <tbody>
                  {vms.map((vm) => (
                    <tr key={`${vm.node}:${vm.vmid}`}>
                      <td><input type="checkbox" name="vm" value={`${vm.node}:${vm.vmid}`} defaultChecked={!known.has(vm.vmid)} disabled={known.has(vm.vmid)} aria-label={`${vm.name} auswählen`} /></td>
                      <td><strong>{vm.name}</strong>{known.has(vm.vmid) && <span className="muted block small">schon angelegt</span>}</td>
                      <td className="mono">{vm.node} · {vm.vmid}</td>
                      <td>{vm.status ?? "–"}</td>
                      <td className="mono">{vm.ips?.join(", ") || "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ActionForm>
        </div>
      )}

      <h2 className="admin-h2">Cloudflare im Detail</h2>
      <div className="admin-grid">
        <div className="admin-card">
          <h2>Zonen bei Cloudflare</h2>
          {cfZones.length === 0 ? <p className="muted">Keine. Lege unter DNS eine Zone mit der Betriebsart „Cloudflare“ an.</p> : (
            <ul className="dots">
              {cfZones.map((z) => {
                const s = cf?.zones?.[z.id] ?? cf?.zones?.[z.name];
                return <li key={z.id}><strong>{z.name}</strong>: {s ? (s.error ? `Fehler – ${s.error}` : `abgeglichen ${ago(s.syncedAt)} (${s.created}+ ${s.updated}~ ${s.deleted}−, ${s.unmanaged} fremde)`) : "noch nicht abgeglichen"}</li>;
              })}
            </ul>
          )}
        </div>
        <div className="admin-card">
          <h2>Cloudflare-Absicherung (Custom Hostnames)</h2>
          {protectedRecords.length === 0 ? <p className="muted">Kein Eintrag ist als „Cloudflare-Schutz“ markiert.</p> : (
            <ul className="dots">
              {protectedRecords.map((h) => {
                const s = cf?.edge?.[h];
                return <li key={h}><strong className="mono">{h}</strong>: {s ? `${s.status}${s.sslStatus ? ` / Zertifikat ${s.sslStatus}` : ""}${s.error ? ` – ${s.error}` : ""} (${ago(s.checkedAt)})` : "noch nicht geprüft"}</li>;
              })}
            </ul>
          )}
          {cf?.edgeNote && <p className="alert error">{cf.edgeNote}</p>}
          {!dns.settings.edge.enabled && <p className="muted small">Die Cloudflare-Absicherung ist unter DNS → Einstellungen noch nicht aktiviert.</p>}
        </div>
        <div className="admin-card">
          <h2>Tunnel-Routen</h2>
          {cf?.tunnelNote && <p className="alert error">{cf.tunnelNote}</p>}
          {!cf?.tunnelRoutes || Object.keys(cf.tunnelRoutes).length === 0 ? <p className="muted">Keine. Routen für Domains in Cloudflare-Zonen bekommen automatisch einen Tunnel-Eintrag.</p> : (
            <ul className="dots">{Object.entries(cf.tunnelRoutes).map(([h, s]) => <li key={h}><span className="mono">{h}</span>: {s.ok ? "Eintrag gesetzt" : `Fehler – ${s.error}`}</li>)}</ul>
          )}
        </div>
        <div className="admin-card">
          <h2>Worker</h2>
          <ul className="dots">
            <li>Herzschlag: {ago(worker?.updatedAt)}</li>
            <li>Scan: {worker?.scan.lastRun ? `${worker.scan.hosts} Adressen, ${ago(worker.scan.lastRun)}${worker.scan.error ? ` – ${worker.scan.error}` : ""}` : "noch nicht gelaufen"}</li>
            <li>Gestartet: {time(worker?.startedAt)}</li>
          </ul>
        </div>
      </div>
    </AdminShell>
  );
}
