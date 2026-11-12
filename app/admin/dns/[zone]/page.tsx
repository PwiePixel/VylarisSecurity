import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { Area, Check, Field, Hidden, Pick } from "@/components/admin/fields";
import { ActionForm, RowAction } from "@/components/admin/ui";
import { Status } from "@/components/ui";
import { recordTypes, recordValueText, type DnsRecord, type DnsZone } from "@/lib/core/dns-model";
import { fqdn } from "@/lib/core/net";
import { getCompiled, getDns } from "@/lib/server/dns";
import { requireAdmin } from "@/lib/server/guard";
import { getResult, getWorkerRuntime } from "@/lib/server/runtime";
import { time } from "@/lib/format";
import { applyImportAction, deleteRecordAction, deleteZoneAction, requestImportAction, saveRecordAction, saveZoneAction, syncNowAction } from "../actions";

export const dynamic = "force-dynamic";

function RecordForm({ zone, rec }: { zone: DnsZone; rec?: DnsRecord }) {
  const cf = zone.mode === "cloudflare";
  return (
    <ActionForm action={saveRecordAction} submit={rec ? "Änderung speichern" : "Eintrag hinzufügen"} resetOnOk={!rec} className="form">
      <Hidden name="zoneId" value={zone.id} />
      {rec && <Hidden name="id" value={rec.id} />}
      <div className="inline-form">
        <Field label="Name" name="name" defaultValue={rec?.name ?? ""} placeholder="@ oder www" hint="@ = Zonenanfang" mono />
        <Pick label="Typ" name="type" defaultValue={rec?.type ?? "A"} options={recordTypes.map((t) => ({ value: t, label: t }))} />
        <Field label="TTL (Sekunden)" name="ttl" defaultValue={rec?.ttl ?? ""} placeholder={String(zone.defaultTtl)} inputMode="numeric" />
      </div>
      <Field label="Wert" name="value" defaultValue={rec?.value ?? ""} required mono hint="A/AAAA: IP-Adresse · CNAME/ALIAS/NS/MX/SRV/PTR: Zielname · TXT: Text · CAA: z. B. letsencrypt.org" />
      <details open={!!rec && (rec.type === "MX" || rec.type === "SRV" || rec.type === "CAA")}>
        <summary>Zusatzfelder für MX, SRV und CAA</summary>
        <div className="inline-form" style={{ marginTop: ".75rem" }}>
          <Field label="Priorität (MX, SRV)" name="priority" defaultValue={rec?.priority ?? ""} inputMode="numeric" />
          <Field label="Gewicht (SRV)" name="weight" defaultValue={rec?.weight ?? ""} inputMode="numeric" />
          <Field label="Port (SRV)" name="port" defaultValue={rec?.port ?? ""} inputMode="numeric" />
          <Field label="Flags (CAA)" name="flags" defaultValue={rec?.flags ?? 0} inputMode="numeric" />
          <Field label="Tag (CAA)" name="tag" defaultValue={rec?.tag ?? ""} placeholder="issue" />
        </div>
      </details>
      <div className="inline-form">
        {!cf && (
          <Pick label="Sichtbarkeit" name="visibility" defaultValue={rec?.visibility ?? "public"} options={[{ value: "public", label: "Öffentlich" }, { value: "internal", label: "Intern (nur aus internen Netzen)" }]} />
        )}
        <Field label="Notiz" name="comment" defaultValue={rec?.comment ?? ""} />
      </div>
      {!cf && <Check label="Über Cloudflare absichern (DDoS-Schutz, echte IP bleibt verborgen)" name="protect" defaultChecked={rec?.protect} hint="Nur A, AAAA, CNAME. Der DNS-Server liefert dann den Cloudflare-Edge-Namen aus (siehe DNS → Einstellungen)." />}
      {cf && <Check label="Über Cloudflare leiten (orange Wolke, „proxied“)" name="proxied" defaultChecked={rec?.proxied} />}
    </ActionForm>
  );
}

export default async function ZonePage({ params, searchParams }: { params: Promise<{ zone: string }>; searchParams: Promise<{ edit?: string; import?: string; imported?: string }> }) {
  const admin = await requireAdmin();
  const { zone: zoneId } = await params;
  const sp = await searchParams;
  const [dns, compiled, worker] = await Promise.all([getDns(), getCompiled(), getWorkerRuntime()]);
  const zone = dns.zones.find((z) => z.id === zoneId);
  if (!zone) notFound();
  const editing = sp.edit ? zone.records.find((r) => r.id === sp.edit) : undefined;
  const served = compiled.zones.find((z) => z.name === zone.name);
  const cfStat = worker?.cloudflare?.zones?.[zone.id] ?? worker?.cloudflare?.zones?.[zone.name];
  const importResult = sp.import ? await getResult(sp.import) : null;
  const importRecords = (importResult?.data as { records?: unknown } | undefined)?.records;
  const importList = importResult?.ok && Array.isArray(importRecords) ? (importRecords as Record<string, unknown>[]) : null;

  return (
    <AdminShell user={admin.username} active="/admin/dns/" title={zone.name} crumb={{ href: "/admin/dns/", label: "Alle Zonen" }} lead={zone.comment}>
      <p>
        {zone.mode === "authoritative" ? <Status tone="ok">Wird von unseren Nameservern beantwortet</Status> : <Status tone="info">Liegt bei Cloudflare – das Panel gleicht ab</Status>}{" "}
        <span className="muted small">Seriennummer {zone.serial} · geändert {time(zone.updatedAt)}</span>
      </p>
      {sp.imported && <p className="alert ok">{sp.imported} Einträge aus Cloudflare übernommen.</p>}

      {zone.mode === "authoritative" && (
        <div className="hint-box">
          Beim Registrar von <strong>{zone.name}</strong> als Nameserver eintragen: {dns.settings.nameservers.map((n, i) => (
            <span key={n.host}>{i > 0 && ", "}<code>{n.host}</code></span>
          ))}.
          {dns.settings.nameservers.some((n) => n.host.endsWith(`.${zone.name}`) || n.host === zone.name) && " Da die Nameserver in dieser Zone liegen, braucht der Registrar zusätzlich Glue-Einträge (Nameserver mit IP-Adresse)."}
        </div>
      )}
      {zone.mode === "cloudflare" && (
        <div className="admin-card" style={{ marginTop: "1rem" }}>
          <div className="admin-row-head">
            <div>
              <h2>Abgleich mit Cloudflare</h2>
              <p className="muted small">
                {cfStat
                  ? cfStat.error
                    ? `Fehler: ${cfStat.error}`
                    : `Zuletzt ${time(cfStat.syncedAt)} · ${cfStat.created} angelegt, ${cfStat.updated} aktualisiert, ${cfStat.deleted} gelöscht, ${cfStat.unmanaged} fremde Einträge unangetastet`
                  : "Noch kein Abgleich. Der Worker gleicht automatisch ab, sobald ein Cloudflare-Token eingerichtet ist (./install.sh cloudflare)."}
              </p>
            </div>
            <div className="inline-form">
              <ActionForm action={syncNowAction} submit="Jetzt abgleichen" variant="secondary" className="form" />
              <ActionForm action={requestImportAction} submit="Einträge aus Cloudflare einlesen" variant="secondary" className="form">
                <Hidden name="zoneId" value={zone.id} />
              </ActionForm>
            </div>
          </div>
          <p className="muted small">Das Panel verwaltet nur Einträge, die es selbst angelegt hat (Notiz „vylaris-security“). Bestehende Cloudflare-Einträge bleiben unberührt, bis du sie übernimmst.</p>
          {sp.import && !importResult && <p className="alert ok">Auftrag läuft … Seite in ein paar Sekunden neu laden.</p>}
          {importResult && !importResult.ok && <p className="alert error">{importResult.message}</p>}
          {importList && (
            <>
              <p className="alert ok">{importList.length} Einträge in Cloudflare gefunden.</p>
              <ActionForm action={applyImportAction} submit={`${importList.length} Einträge übernehmen`}>
                <Hidden name="zoneId" value={zone.id} />
                <Hidden name="request" value={sp.import ?? ""} />
              </ActionForm>
            </>
          )}
        </div>
      )}

      <h2 className="admin-h2">Einträge</h2>
      {zone.records.length === 0 ? (
        <p className="muted">Noch keine Einträge.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Name</th><th>Typ</th><th>Wert</th><th className="num">TTL</th><th>Optionen</th><th /></tr>
            </thead>
            <tbody>
              {zone.records.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.name}</td>
                  <td><strong>{r.type}</strong></td>
                  <td className="mono wrap-cell">{recordValueText(r)}{r.comment && <span className="muted block small">{r.comment}</span>}</td>
                  <td className="num">{r.ttl}</td>
                  <td>
                    {r.visibility === "internal" && <span className="pill plain">intern</span>}{" "}
                    {r.protect && <span className="pill assigned">Cloudflare-Schutz</span>}
                    {r.proxied && <span className="pill reserved">proxied</span>}
                  </td>
                  <td className="acts">
                    <Link href={`/admin/dns/${zone.id}/?edit=${r.id}`}>Ändern</Link>
                    <RowAction action={deleteRecordAction} fields={{ zoneId: zone.id, id: r.id }} label="Löschen" confirm={`${r.type}-Eintrag „${r.name}“ löschen?`} danger />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="admin-card" style={{ marginTop: "1.5rem" }}>
        <h2>{editing ? `Eintrag ändern: ${editing.name} (${editing.type})` : "Eintrag hinzufügen"}</h2>
        {editing && <p className="small"><Link href={`/admin/dns/${zone.id}/`}>Abbrechen</Link></p>}
        <RecordForm key={editing?.id ?? "new"} zone={zone} rec={editing} />
      </div>

      {zone.mode === "authoritative" && served && (
        <details className="admin-card" style={{ marginTop: "1.5rem" }}>
          <summary>Das liefert der DNS-Server tatsächlich aus ({served.rrs.length + 1} Einträge)</summary>
          <p className="muted small">Inklusive automatischer Einträge: SOA, Nameserver, Server-Namen aus der Server-Liste, PTR aus der IP-Verwaltung und Cloudflare-Absicherung.</p>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Name</th><th>Typ</th><th>Daten</th><th className="num">TTL</th><th>Herkunft</th></tr></thead>
              <tbody>
                {[served.soa, ...served.rrs].map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.name}</td>
                    <td>{r.data.type}</td>
                    <td className="mono wrap-cell">{Object.entries(r.data).filter(([k]) => k !== "type").map(([, v]) => String(v)).join(" ")}</td>
                    <td className="num">{r.ttl}</td>
                    <td className="small">{{ zone: "Zone", server: "Server-Liste", glue: "Glue", edge: "Cloudflare-Absicherung", ptr: "IP-Verwaltung", ns: "Nameserver", soa: "Zone" }[r.source ?? "zone"]}{r.internal ? " · intern" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <h2 className="admin-h2">Zonen-Einstellungen</h2>
      <div className="admin-grid">
        <div className="admin-card">
          <h2>Zeiten (SOA)</h2>
          <ActionForm action={saveZoneAction} submit="Speichern">
            <Hidden name="id" value={zone.id} />
            <Field label="Verantwortlicher (als Name)" name="rname" defaultValue={zone.soa.rname} mono hint="E-Mail-Adresse mit Punkt statt @, z. B. hostmaster.example.com" />
            <div className="cols-2">
              <Field label="Standard-TTL" name="defaultTtl" defaultValue={zone.defaultTtl} inputMode="numeric" />
              <Field label="Negativ-TTL (minimum)" name="minimum" defaultValue={zone.soa.minimum} inputMode="numeric" />
              <Field label="Refresh" name="refresh" defaultValue={zone.soa.refresh} inputMode="numeric" />
              <Field label="Retry" name="retry" defaultValue={zone.soa.retry} inputMode="numeric" />
              <Field label="Expire" name="expire" defaultValue={zone.soa.expire} inputMode="numeric" />
            </div>
            <Area label="Notiz" name="comment" defaultValue={zone.comment ?? ""} rows={2} />
          </ActionForm>
        </div>
        <div className="admin-card">
          <h2>Zone löschen</h2>
          <p className="muted">Entfernt die Zone und alle Einträge aus dem Panel{zone.mode === "cloudflare" ? ". Bei Cloudflare angelegte Einträge bleiben bestehen." : ". Danach antwortet unser DNS-Server für diese Domain nicht mehr (REFUSED)."}</p>
          <ActionForm action={deleteZoneAction} submit="Zone löschen" variant="danger">
            <Hidden name="id" value={zone.id} />
            <Field label={`Zum Bestätigen „${zone.name}“ eintippen`} name="confirm" />
          </ActionForm>
        </div>
      </div>
      <p className="muted small">Beispiel-Name: <code>{fqdn(zone.name, "www")}</code></p>
    </AdminShell>
  );
}
