import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { Area, Check, Field, Hidden, Pick } from "@/components/admin/fields";
import { ActionForm, RowAction } from "@/components/admin/ui";
import { Status } from "@/components/ui";
import { serverFqdn, serverPrimaryIp } from "@/lib/core/inventory-model";
import type { Route } from "@/lib/core/proxy-model";
import { getInventory } from "@/lib/server/inventory";
import { requireAdmin } from "@/lib/server/guard";
import { getProxy } from "@/lib/server/proxy";
import { getProxyRuntime, getSystem } from "@/lib/server/runtime";
import { bytes, num, time } from "@/lib/format";
import { deleteRouteAction, saveRouteAction, saveRulesAction, toggleRouteAction } from "./actions";

export const dynamic = "force-dynamic";

const reasonLabel: Record<string, string> = { "blocked-ip": "Adresse gesperrt", "deny-ip": "Route sperrt Adresse", "not-allowed": "Adresse nicht erlaubt", "user-agent": "User-Agent gesperrt", "rate-limit": "Zu viele Anfragen", "too-large": "Anfrage zu groß", "upstream-error": "Server nicht erreichbar", "unknown-host": "Unbekannter Hostname" };

export default async function ProxyPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const [inv, proxy, rt, system] = await Promise.all([getInventory(), getProxy(), getProxyRuntime(), getSystem()]);
  const me = system.find((s) => s.id === "proxy");
  const editing = sp.edit ? proxy.routes.find((r) => r.id === sp.edit) : undefined;
  const targetLabel = (r: Route) => {
    if (r.upstream.type === "custom") return `${r.upstream.host}:${r.upstream.port}`;
    const s = inv.servers.find((x) => x.id === (r.upstream as { serverId: string }).serverId);
    return s ? `${serverFqdn(s, inv)}:${r.upstream.port} (${serverPrimaryIp(inv, s) ?? "keine IP"})` : "Server fehlt";
  };
  const targetValue = (r?: Route) => (!r ? "" : r.upstream.type === "server" ? `server:${r.upstream.serverId}` : r.upstream.host);
  const serverOptions = [{ value: "", label: "– Server wählen oder unten Hostname eintippen –" }, ...inv.servers.map((s) => ({ value: `server:${s.id}`, label: `${s.name}  (${serverFqdn(s, inv)})` }))];

  return (
    <AdminShell
      user={admin.username}
      active="/admin/proxy/"
      title="Proxy"
      lead="Besucher sprechen nur mit dem Proxy – die echte IP deiner Server bleibt verborgen. Der Proxy prüft jede Anfrage (gesperrte Adressen, Anfragelimit, Größe) und leitet sie an den Server weiter. HTTPS übernimmt Cloudflare."
    >
      <div className="grid-4">
        <div className="kpi"><span className="v">{proxy.routes.filter((r) => r.enabled).length}</span><span className="l">aktive Routen (von {proxy.routes.length})</span></div>
        <div className="kpi"><span className="v">{rt ? num(rt.totals.requests) : "–"}</span><span className="l">Anfragen seit Start</span></div>
        <div className="kpi"><span className="v">{rt ? num(rt.totals.blocked + rt.totals.rateLimited) : "–"}</span><span className="l">abgewehrt (gesperrt oder zu viele)</span></div>
        <div className="kpi"><span className="v">{me ? <Status tone={me.tone}>{me.label}</Status> : "–"}</span><span className="l">Proxy · <Link href="/admin/traffic/">Verlauf</Link></span></div>
      </div>

      <h2 className="admin-h2">Routen</h2>
      {proxy.routes.length === 0 ? (
        <p className="muted">Noch keine Route. Lege unten die erste an.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Hostname</th><th>Ziel</th><th className="num">Anfragen</th><th className="num">Daten ein/aus</th><th className="num">Abgewehrt</th><th>Status</th><th /></tr></thead>
            <tbody>
              {proxy.routes.map((r) => {
                const st = rt?.routes[r.id];
                return (
                  <tr key={r.id}>
                    <td className="mono"><strong>{r.host}</strong>{r.note && <span className="muted block small">{r.note}</span>}</td>
                    <td className="mono wrap-cell">{r.upstream.scheme}://{targetLabel(r)}</td>
                    <td className="num">{st ? num(st.requests) : "–"}</td>
                    <td className="num">{st ? `${bytes(st.bytesIn)} / ${bytes(st.bytesOut)}` : "–"}</td>
                    <td className="num">{st ? num(st.blocked + st.rateLimited) : "–"}</td>
                    <td>{r.enabled ? <Status tone="ok">Aktiv</Status> : <Status tone="info">Aus</Status>}{st && st.s5xx + st.upstreamErrors > 0 && <span className="muted block small">{st.s5xx + st.upstreamErrors} Fehler</span>}</td>
                    <td className="acts">
                      <Link href={`/admin/proxy/?edit=${r.id}#form`}>Ändern</Link>
                      <RowAction action={toggleRouteAction} fields={{ id: r.id }} label={r.enabled ? "Ausschalten" : "Einschalten"} />
                      <RowAction action={deleteRouteAction} fields={{ id: r.id }} label="Löschen" confirm={`Route „${r.host}“ löschen?`} danger />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="admin-card" id="form" style={{ marginTop: "1.5rem" }}>
        <h2>{editing ? `Route ändern: ${editing.host}` : "Route anlegen"}</h2>
        {editing && <p className="small"><Link href="/admin/proxy/">Abbrechen</Link></p>}
        <ActionForm key={editing?.id ?? "new"} action={saveRouteAction} submit={editing ? "Änderung speichern" : "Route anlegen"} resetOnOk={!editing}>
          {editing && <Hidden name="id" value={editing.id} />}
          {editing && <Hidden name="enabled" value={editing.enabled ? "on" : ""} />}
          <Field label="Öffentlicher Hostname" name="host" defaultValue={editing?.host ?? ""} required placeholder="shop.example.com oder *.example.com" mono />
          <Pick label="Ziel: Server" name="target" defaultValue={targetValue(editing)} options={serverOptions} />
          <div className="cols-2">
            <Field label="oder Ziel: Hostname / IP" name="targetCustom" defaultValue={editing?.upstream.type === "custom" ? editing.upstream.host : ""} mono hint="Nur ausfüllen, wenn oben kein Server gewählt ist." />
            <Field label="Port" name="port" defaultValue={editing?.upstream.port ?? 80} required inputMode="numeric" />
          </div>
          <Pick label="Verbindung zum Server" name="scheme" defaultValue={editing?.upstream.scheme ?? "http"} options={[{ value: "http", label: "HTTP" }, { value: "https", label: "HTTPS" }]} />
          <details open={!!editing}>
            <summary>Schutz und Feinheiten</summary>
            <div className="form" style={{ marginTop: ".75rem" }}>
              <Field label="Anfragen pro Minute und Besucher (0 = globale Grenze)" name="rateLimitPerMinute" defaultValue={editing?.rateLimitPerMinute ?? 0} inputMode="numeric" />
              <Area label="Nur diese Adressen/Netze erlauben (leer = alle)" name="allowIps" defaultValue={editing?.allowIps.join("\n") ?? ""} rows={2} />
              <Area label="Diese Adressen/Netze sperren" name="denyIps" defaultValue={editing?.denyIps.join("\n") ?? ""} rows={2} />
              <Check label="Original-Hostnamen an den Server weitergeben" name="preserveHost" defaultChecked={editing?.preserveHost ?? true} />
              <Check label="Zertifikat des Servers nicht prüfen (selbstsigniert im internen Netz)" name="insecureUpstream" defaultChecked={editing?.insecureUpstream} />
              <Check label="Sicherheits-Header ergänzen (HSTS, nosniff, Referrer-Policy)" name="hardenHeaders" defaultChecked={editing?.hardenHeaders ?? true} />
              <Field label="Notiz" name="note" defaultValue={editing?.note ?? ""} />
            </div>
          </details>
        </ActionForm>
        <div className="hint-box">
          <strong>Erreichbar machen:</strong> Liegt die Domain bei Cloudflare (Betriebsart „Cloudflare“ unter DNS), legt der Worker den Tunnel-Eintrag selbst an. Bei einer Zone auf unseren Nameservern setze den Eintrag auf <em>Cloudflare-Schutz</em> (DNS → Eintrag), dann liefert der DNS-Server den Edge-Namen aus.
        </div>
      </div>

      <h2 className="admin-h2">Globale Schutzregeln</h2>
      <div className="admin-card">
        <ActionForm action={saveRulesAction} submit="Regeln speichern">
          <Area label="Gesperrte Adressen / Netze" name="blockedIps" defaultValue={proxy.rules.blockedIps.join("\n")} rows={3} hint="Eine pro Zeile, z. B. 198.51.100.0/24. Gilt für alle Routen." />
          <Area label="Gesperrte User-Agents (Teilstrings)" name="blockedUserAgents" defaultValue={proxy.rules.blockedUserAgents.join("\n")} rows={3} hint="Eine pro Zeile, Groß-/Kleinschreibung egal." />
          <div className="cols-2">
            <Field label="Anfragen pro Minute und Besucher (Standard, 0 = unbegrenzt)" name="rateLimitPerMinute" defaultValue={proxy.rules.rateLimitPerMinute} inputMode="numeric" />
            <Field label="Maximale Anfragegröße (MB)" name="maxBodyMb" defaultValue={proxy.rules.maxBodyMb} inputMode="numeric" />
            <Field label="Zeitlimit des Servers (Sekunden)" name="upstreamTimeoutSec" defaultValue={proxy.rules.upstreamTimeoutSec} inputMode="numeric" />
          </div>
        </ActionForm>
      </div>

      <h2 className="admin-h2">Zuletzt abgewehrt</h2>
      {!rt || rt.events.length === 0 ? <p className="muted">Keine Ereignisse.</p> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Zeit</th><th>Hostname</th><th>Besucher</th><th>Grund</th></tr></thead>
            <tbody>
              {rt.events.slice(0, 30).map((e, i) => (
                <tr key={i}><td className="small">{time(e.t)}</td><td className="mono">{e.host}</td><td className="mono">{e.ip}</td><td>{reasonLabel[e.reason] ?? e.reason}{e.detail ? ` – ${e.detail}` : ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
