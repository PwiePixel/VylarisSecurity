import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { UsageBar } from "@/components/admin/charts";
import { Check, Field, Pick } from "@/components/admin/fields";
import { ActionForm } from "@/components/admin/ui";
import { buildIpRows, serverFqdn, summarizeRows } from "@/lib/core/inventory-model";
import { getInventory } from "@/lib/server/inventory";
import { requireAdmin } from "@/lib/server/guard";
import { getScan } from "@/lib/server/runtime";
import { ago, num } from "@/lib/format";
import { saveSubnetAction, scanNowAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function IpPage() {
  const admin = await requireAdmin();
  const [inv, scan] = await Promise.all([getInventory(), getScan()]);
  const nets = inv.subnets.map((sn) => {
    const rows = buildIpRows(inv, sn, scan);
    return { sn, rows, sum: summarizeRows(rows) };
  });
  const total = nets.reduce((a, n) => ({ usable: a.usable + n.sum.usable, free: a.free + n.sum.free, assigned: a.assigned + n.sum.assigned, reserved: a.reserved + n.sum.reserved, blocked: a.blocked + n.sum.blocked }), { usable: 0, free: 0, assigned: 0, reserved: 0, blocked: 0 });
  const alerts = nets.flatMap((n) => n.rows.filter((r) => r.alert).map((r) => ({ ...r, net: n.sn })));
  const name = (id?: string) => {
    const s = inv.servers.find((x) => x.id === id);
    return s ? serverFqdn(s, inv) : "?";
  };

  return (
    <AdminShell user={admin.username} active="/admin/ip/" title="IP-Adressen" lead="Alle Netze und Adressen der Gruppe auf einen Blick: was frei, zugewiesen, reserviert oder gesperrt ist – und ob die Adressen wirklich erreichbar sind.">
      <div className="grid-4">
        <div className="kpi"><span className="v">{num(total.usable)}</span><span className="l">nutzbare Adressen in {nets.length} Netz(en)</span></div>
        <div className="kpi"><span className="v">{num(total.assigned)}</span><span className="l">zugewiesen</span></div>
        <div className="kpi"><span className="v">{num(total.free)}</span><span className="l">frei</span></div>
        <div className="kpi"><span className="v">{num(total.reserved + total.blocked)}</span><span className="l">reserviert oder gesperrt</span></div>
      </div>

      {alerts.length > 0 && (
        <ul className="alerts">
          {alerts.slice(0, 20).map((a) => (
            <li key={a.ip}>
              <strong className="mono">{a.ip}</strong> ({a.net.name}):{" "}
              {a.alert === "free-but-up" && "als frei markiert, antwortet aber – möglicherweise von jemandem genutzt (Adresskonflikt?)."}
              {a.alert === "reserved-but-up" && "reserviert, antwortet aber."}
              {a.alert === "assigned-but-down" && `zugewiesen an ${name(a.serverId)}, antwortet aber nicht.`}{" "}
              <Link href={`/admin/ip/${a.net.id}/?ip=${a.ip}`}>Ansehen</Link>
            </li>
          ))}
        </ul>
      )}

      <h2 className="admin-h2">Netze</h2>
      {nets.length === 0 ? (
        <p className="muted">Noch kein Netz. Lege unten dein Subnetz an (z. B. den Block, den du für die VMs bekommen hast).</p>
      ) : (
        <div className="admin-list">
          {nets.map(({ sn, sum }) => (
            <div className="admin-card" key={sn.id}>
              <div className="admin-row-head">
                <div>
                  <h3><Link href={`/admin/ip/${sn.id}/`}>{sn.name}</Link> <span className="mono muted">{sn.cidr}</span></h3>
                  <p className="muted small">
                    {sn.scope === "public" ? "öffentlich" : "privat"}{sn.gateway ? ` · Gateway ${sn.gateway}` : ""}{sn.vlan ? ` · VLAN ${sn.vlan}` : ""} · {sn.scan ? `Scan aktiv, zuletzt ${ago(scan?.updatedAt)}` : "kein Scan"}
                  </p>
                </div>
                <Link href={`/admin/ip/${sn.id}/`}>Adressen ansehen →</Link>
              </div>
              <div style={{ marginTop: ".9rem" }}><UsageBar free={sum.free} assigned={sum.assigned} reserved={sum.reserved} blocked={sum.blocked} /></div>
              <div className="legend"><span>{sum.assigned} zugewiesen</span><span>{sum.reserved} reserviert</span><span>{sum.blocked} gesperrt</span><span>{sum.free} frei</span>{sum.alerts > 0 && <span>⚠ {sum.alerts} Hinweis(e)</span>}</div>
            </div>
          ))}
        </div>
      )}

      <div className="admin-grid">
        <div className="admin-card">
          <h2>Netz anlegen</h2>
          <ActionForm action={saveSubnetAction} submit="Netz anlegen">
            <Field label="Name" name="name" required placeholder="Öffentlicher Block" />
            <Field label="Netz (CIDR)" name="cidr" required placeholder="203.0.113.0/28" mono hint="IPv4, bis zu 4096 Adressen (/20)." />
            <div className="cols-2">
              <Field label="Gateway (optional)" name="gateway" placeholder="203.0.113.1" mono />
              <Field label="VLAN (optional)" name="vlan" inputMode="numeric" />
            </div>
            <Pick label="Art" name="scope" options={[{ value: "public", label: "Öffentlich (aus dem Internet routbar)" }, { value: "private", label: "Privat" }]} />
            <Check label="Erreichbarkeit regelmäßig prüfen" name="scan" defaultChecked hint="Der Worker prüft jede Adresse (Ping, ARP, offene Ports) und meldet Konflikte." />
            <Field label="Notiz" name="comment" />
          </ActionForm>
        </div>
        <div className="admin-card">
          <h2>Erreichbarkeit prüfen</h2>
          <p className="muted">Der Worker prüft automatisch alle paar Minuten. Hier kannst du sofort einen Durchlauf anstoßen. Letzter Durchlauf: {ago(scan?.updatedAt)}.</p>
          <ActionForm action={scanNowAction} submit="Jetzt prüfen" variant="secondary" />
          <div className="hint-box">
            „Erreichbar“ heißt: Die Adresse antwortet auf Ping, steht in der ARP-Tabelle oder nimmt TCP-Verbindungen an bzw. lehnt sie aktiv ab. Ein Server, der alles still verwirft, erscheint als „nicht erreichbar“.
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
