import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { Area, Check, Field, Pick } from "@/components/admin/fields";
import { ActionForm } from "@/components/admin/ui";
import { Status } from "@/components/ui";
import { getCompiled, getDns } from "@/lib/server/dns";
import { requireAdmin } from "@/lib/server/guard";
import { getDnsRuntime, getSystem } from "@/lib/server/runtime";
import { num } from "@/lib/format";
import { createZoneAction, saveSettingsAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function DnsPage() {
  const admin = await requireAdmin();
  const [dns, compiled, rt, system] = await Promise.all([getDns(), getCompiled(), getDnsRuntime(), getSystem()]);
  const me = system.find((s) => s.id === "dns");
  const ns = [...dns.settings.nameservers, ...Array.from({ length: 4 }, () => ({ host: "", ipv4: "", ipv6: "" }))].slice(0, Math.max(2, dns.settings.nameservers.length + 1));

  return (
    <AdminShell
      user={admin.username}
      active="/admin/dns/"
      title="DNS"
      lead="Eigene Nameserver für alle Domains der Gruppe. Zonen, die wir selbst beantworten (ns1/ns2), liegen hier; Zonen bei Cloudflare pflegst du ebenfalls hier, der Worker gleicht sie per Schnittstelle ab."
    >
      <div className="grid-4">
        <div className="kpi"><span className="v">{dns.zones.length}</span><span className="l">Zonen ({dns.zones.filter((z) => z.mode === "authoritative").length} eigene, {dns.zones.filter((z) => z.mode === "cloudflare").length} bei Cloudflare)</span></div>
        <div className="kpi"><span className="v">{num(compiled.zones.reduce((n, z) => n + z.rrs.length, 0))}</span><span className="l">Einträge, die der DNS-Server ausliefert</span></div>
        <div className="kpi"><span className="v">{rt ? num(rt.totals.queries) : "–"}</span><span className="l">Anfragen seit Start · <Link href="/admin/traffic/">Verlauf</Link></span></div>
        <div className="kpi">
          <span className="v">{me ? <Status tone={me.tone}>{me.label}</Status> : "–"}</span>
          <span className="l">DNS-Server · {me?.detail}</span>
        </div>
      </div>

      {compiled.warnings.length > 0 && (
        <ul className="alerts">
          {compiled.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <h2 className="admin-h2">Zonen</h2>
      {dns.zones.length === 0 ? (
        <p className="muted">Noch keine Zone. Lege unten die erste an – z. B. <code>vylaris.it</code>.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Zone</th><th>Betriebsart</th><th className="num">Einträge</th><th>Seriennummer</th><th /></tr>
            </thead>
            <tbody>
              {dns.zones.map((z) => (
                <tr key={z.id}>
                  <td><Link href={`/admin/dns/${z.id}/`}><strong>{z.name}</strong></Link></td>
                  <td>{z.mode === "authoritative" ? <Status tone="ok">Eigene Nameserver</Status> : <Status tone="info">Cloudflare</Status>}</td>
                  <td className="num">{z.records.length}</td>
                  <td className="mono">{z.serial}</td>
                  <td className="acts"><Link href={`/admin/dns/${z.id}/`}>Bearbeiten</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="admin-grid">
        <div className="admin-card">
          <h2>Zone anlegen</h2>
          <ActionForm action={createZoneAction} submit="Zone anlegen">
            <Field label="Domain" name="name" required placeholder="vylaris.it" hint="Nur die Domain, ohne www." />
            <Pick
              label="Betriebsart"
              name="mode"
              options={[
                { value: "authoritative", label: "Eigene Nameserver (ns1/ns2 beantworten die Zone)" },
                { value: "cloudflare", label: "Cloudflare (die Zone liegt dort, das Panel gleicht ab)" },
              ]}
            />
          </ActionForm>
        </div>
        <div className="admin-card">
          <h2>So wird eine Domain unsere</h2>
          <ol className="admin-steps">
            <li>Zone hier anlegen und Einträge pflegen.</li>
            <li>Beim Registrar der Domain die Nameserver auf {dns.settings.nameservers.map((n, i) => (
              <span key={n.host}>{i > 0 && " und "}<code>{n.host}</code></span>
            ))}{" "}stellen.</li>
            <li>Gehört der Nameserver selbst zu einer Domain von uns (z. B. <code>ns1.vylaris.it</code>), beim Registrar zusätzlich die <strong>Glue-Einträge</strong> (Nameserver mit IP) anlegen.</li>
            <li>Port 53 (UDP und TCP) muss am Server erreichbar sein – der Installer prüft das.</li>
          </ol>
        </div>
      </div>

      <h2 className="admin-h2">Nameserver und Einstellungen</h2>
      <div className="admin-card">
        <ActionForm action={saveSettingsAction} submit="Einstellungen speichern">
          <div className="cols-2">
            {ns.map((n, i) => (
              <div className="admin-card" key={i} style={{ boxShadow: "none" }}>
                <h3 style={{ marginTop: 0 }}>Nameserver {i + 1}</h3>
                <Field label="Name" name={`ns${i + 1}`} defaultValue={n.host} placeholder={`ns${i + 1}.vylaris.it`} mono />
                <Field label="IPv4 (für Glue)" name={`ns${i + 1}v4`} defaultValue={n.ipv4 ?? ""} placeholder="203.0.113.10" mono />
                <Field label="IPv6 (optional)" name={`ns${i + 1}v6`} defaultValue={n.ipv6 ?? ""} mono />
              </div>
            ))}
          </div>
          <Area label="Interne Netze" name="internalNets" defaultValue={dns.settings.internalNets.join("\n")} hint="Anfragen aus diesen Netzen sehen auch „interne“ Einträge (z. B. Server-Adressen). Aus dem Internet sind sie unsichtbar." rows={3} />
          <Field label="Anfragelimit pro Adresse und Sekunde" name="rateLimitPerSecond" defaultValue={dns.settings.rateLimitPerSecond} inputMode="numeric" hint="0 = aus. Schützt vor Überflutung; interne Netze sind ausgenommen." />
          <Check label="Cloudflare-Absicherung verwenden" name="edgeEnabled" defaultChecked={dns.settings.edge.enabled} hint="Einträge mit „Cloudflare-Schutz“ liefern dann den Edge-Namen statt der echten IP aus." />
          <Field label="Edge-Name bei Cloudflare" name="edgeTarget" defaultValue={dns.settings.edge.target} placeholder="edge.vylaris.eu" mono hint="Ein über Cloudflare geschützter Name (CNAME auf den Tunnel), der als „Fallback-Origin“ bei Cloudflare for SaaS eingetragen ist." />
        </ActionForm>
      </div>
    </AdminShell>
  );
}
