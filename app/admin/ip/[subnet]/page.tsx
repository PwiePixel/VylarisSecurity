import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { UsageBar } from "@/components/admin/charts";
import { Check, Field, Hidden, Pick } from "@/components/admin/fields";
import { ActionForm } from "@/components/admin/ui";
import { buildIpRows, ipStatusLabels, serverFqdn, summarizeRows } from "@/lib/core/inventory-model";
import { getInventory } from "@/lib/server/inventory";
import { requireAdmin } from "@/lib/server/guard";
import { getScan } from "@/lib/server/runtime";
import { ago } from "@/lib/format";
import { deleteSubnetAction, saveSubnetAction, setIpAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SubnetPage({ params, searchParams }: { params: Promise<{ subnet: string }>; searchParams: Promise<{ ip?: string; show?: string }> }) {
  const admin = await requireAdmin();
  const { subnet: id } = await params;
  const sp = await searchParams;
  const [inv, scan] = await Promise.all([getInventory(), getScan()]);
  const sn = inv.subnets.find((s) => s.id === id);
  if (!sn) notFound();
  const rows = buildIpRows(inv, sn, scan);
  const sum = summarizeRows(rows);
  const sel = sp.ip ? rows.find((r) => r.ip === sp.ip) : undefined;
  const filter = sp.show ?? "all";
  const shown = rows.filter((r) => filter === "all" || (filter === "alerts" ? !!r.alert : r.status === filter));
  const serverName = (sid?: string) => {
    const s = inv.servers.find((x) => x.id === sid);
    return s ? <Link href={`/admin/server/${s.id}/`}>{serverFqdn(s, inv)}</Link> : <span className="muted">–</span>;
  };

  return (
    <AdminShell user={admin.username} active="/admin/ip/" title={`${sn.name} · ${sn.cidr}`} crumb={{ href: "/admin/ip/", label: "Alle Netze" }}>
      <div className="grid-4">
        <div className="kpi"><span className="v">{sum.usable}</span><span className="l">nutzbare Adressen</span></div>
        <div className="kpi"><span className="v">{sum.assigned}</span><span className="l">zugewiesen</span></div>
        <div className="kpi"><span className="v">{sum.free}</span><span className="l">frei</span></div>
        <div className="kpi"><span className="v">{sum.alerts}</span><span className="l">Hinweise (Konflikte)</span></div>
      </div>
      <div style={{ marginTop: "1rem" }}><UsageBar free={sum.free} assigned={sum.assigned} reserved={sum.reserved} blocked={sum.blocked} /></div>
      <div className="legend"><span>Blau: zugewiesen</span><span>Gelb: reserviert</span><span>Rot: gesperrt</span><span>Grün: frei</span><span>Orange Rand: Hinweis</span></div>

      <div className="ipgrid" aria-label="Adressraster">
        {rows.map((r) => (
          <Link key={r.ip} href={`/admin/ip/${id}/?ip=${r.ip}`} title={`${r.ip} – ${r.kind !== "host" ? (r.kind === "network" ? "Netzadresse" : "Broadcast") : r.isGateway ? "Gateway" : ipStatusLabels[r.status]}${r.reach !== "unknown" ? (r.reach === "up" ? " · erreichbar" : " · nicht erreichbar") : ""}`} className={`ipcell ${r.kind !== "host" || r.isGateway ? "net" : r.status}${r.alert ? " alert" : ""}${r.ip === sp.ip ? " alert" : ""}`}>
            {r.ip.split(".").pop()}
          </Link>
        ))}
      </div>

      {sel && (
        <div className="admin-card" style={{ marginTop: "1.5rem" }}>
          <h2 className="mono">{sel.ip}</h2>
          <p className="muted small">
            {sel.kind !== "host" ? "Netz-/Broadcast-Adresse – nicht vergebbar." : `Erreichbar: ${sel.reach === "unknown" ? "nicht geprüft" : sel.reach === "up" ? "ja" : "nein"}${sel.scan?.mac ? ` · MAC ${sel.scan.mac}` : ""}${sel.scan?.method ? ` · erkannt per ${sel.scan.method}` : ""}${sel.scan?.lastUp ? ` · zuletzt gesehen ${ago(sel.scan.lastUp)}` : ""}`}
          </p>
          {sel.alert && <p className="alerts"><span className="alert error">Hinweis: {sel.alert === "free-but-up" ? "Die Adresse ist als frei markiert, antwortet aber." : sel.alert === "reserved-but-up" ? "Die Adresse ist reserviert, antwortet aber." : "Die Adresse ist zugewiesen, antwortet aber nicht."}</span></p>}
          {sel.kind === "host" && (
            <ActionForm action={setIpAction} submit="Speichern" key={sel.ip}>
              <Hidden name="ip" value={sel.ip} />
              <Hidden name="subnetId" value={id} />
              <div className="cols-2">
                <Pick label="Status" name="status" defaultValue={sel.status} options={[{ value: "free", label: "Frei" }, { value: "assigned", label: "Zugewiesen (Server wählen)" }, { value: "reserved", label: "Reserviert" }, { value: "blocked", label: "Gesperrt" }]} />
                <Pick label="Server (bei „Zugewiesen“)" name="serverId" defaultValue={sel.serverId ?? ""} options={[{ value: "", label: "–" }, ...inv.servers.map((s) => ({ value: s.id, label: serverFqdn(s, inv) }))]} />
              </div>
              <Field label="PTR (Rückwärtsname)" name="ptr" defaultValue={sel.entry?.ptr ?? ""} mono />
              <Field label="Notiz" name="note" defaultValue={sel.entry?.note ?? ""} />
            </ActionForm>
          )}
        </div>
      )}

      <h2 className="admin-h2">Alle Adressen</h2>
      <p className="small">
        Filter:{" "}
        {[["all", "alle"], ["assigned", "zugewiesen"], ["free", "frei"], ["reserved", "reserviert"], ["blocked", "gesperrt"], ["alerts", "mit Hinweis"]].map(([k, l]) => (
          <span key={k}><Link href={`/admin/ip/${id}/?show=${k}`} style={filter === k ? { fontWeight: 700 } : undefined}>{l}</Link>{" · "}</span>
        ))}
      </p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Adresse</th><th>Status</th><th>Server</th><th>Erreichbar</th><th>MAC</th><th>PTR / Notiz</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.ip}>
                <td className="mono"><strong>{r.ip}</strong></td>
                <td>{r.kind !== "host" ? <span className="pill plain">{r.kind === "network" ? "Netz" : "Broadcast"}</span> : r.isGateway ? <span className="pill plain">Gateway</span> : <span className={`pill ${r.status}`}>{ipStatusLabels[r.status]}</span>}{r.alert && " ⚠"}</td>
                <td>{serverName(r.serverId)}</td>
                <td><span className={`dot ${r.reach}`} />{r.reach === "unknown" ? "–" : r.reach === "up" ? "ja" : `nein${r.scan?.lastUp ? ` (gesehen ${ago(r.scan.lastUp)})` : ""}`}</td>
                <td className="mono">{r.scan?.mac ?? "–"}</td>
                <td className="small">{[r.entry?.ptr, r.entry?.note].filter(Boolean).join(" · ") || "–"}</td>
                <td className="acts">{r.kind === "host" && <Link href={`/admin/ip/${id}/?ip=${r.ip}`}>Bearbeiten</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="admin-h2">Netz-Einstellungen</h2>
      <div className="admin-grid">
        <div className="admin-card">
          <ActionForm action={saveSubnetAction} submit="Speichern">
            <Hidden name="id" value={id} />
            <Field label="Name" name="name" defaultValue={sn.name} required />
            <Field label="Netz (CIDR)" name="cidr" defaultValue={sn.cidr} required mono />
            <div className="cols-2">
              <Field label="Gateway" name="gateway" defaultValue={sn.gateway ?? ""} mono />
              <Field label="VLAN" name="vlan" defaultValue={sn.vlan ?? ""} inputMode="numeric" />
            </div>
            <Pick label="Art" name="scope" defaultValue={sn.scope} options={[{ value: "public", label: "Öffentlich" }, { value: "private", label: "Privat" }]} />
            <Check label="Erreichbarkeit regelmäßig prüfen" name="scan" defaultChecked={sn.scan} />
            <Field label="Notiz" name="comment" defaultValue={sn.comment ?? ""} />
          </ActionForm>
        </div>
        <div className="admin-card">
          <h2>Netz löschen</h2>
          <p className="muted">Entfernt das Netz und alle Zuordnungen darin. Die Server bleiben bestehen.</p>
          <ActionForm action={deleteSubnetAction} submit="Netz löschen" variant="danger" confirm={`Netz ${sn.cidr} und alle Zuordnungen löschen?`}>
            <Hidden name="id" value={id} />
          </ActionForm>
        </div>
      </div>
    </AdminShell>
  );
}
