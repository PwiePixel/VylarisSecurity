import { AdminShell } from "@/components/admin/AdminShell";
import { DisableTotpForm, PasswordForm, RecoveryForm, StartTotpForm, TotpEnrollment } from "@/components/admin/Forms";
import { Status } from "@/components/ui";
import { requireAdmin } from "@/lib/server/guard";
import { otpauthUri } from "@/lib/server/totp";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const admin = await requireAdmin();
  const totp = admin.totp;

  return (
    <AdminShell user={admin.username} active="/admin/sicherheit/" title="Sicherheit" lead="Passwort und Zwei-Faktor-Anmeldung deines Admin-Zugangs.">
      <div className="admin-list">
        <div className="admin-card">
          <h2>Passwort ändern</h2>
          <p className="muted">Nach der Änderung werden alle anderen Sitzungen beendet.</p>
          <PasswordForm />
        </div>

        <div className="admin-card">
          <div className="admin-row-head">
            <h2>Zwei-Faktor-Anmeldung (TOTP)</h2>
            {totp?.enabled ? <Status tone="ok">Aktiv</Status> : <Status tone="warn">Nicht aktiv</Status>}
          </div>

          {!totp && (
            <>
              <p>
                Zusätzlich zum Passwort wird bei der Anmeldung ein Code aus einer Authenticator-App abgefragt (z. B. Aegis, Bitwarden, 2FAS oder
                jede andere TOTP-App).
              </p>
              <StartTotpForm />
            </>
          )}

          {totp && (
            <TotpEnrollment
              secret={totp.enabled ? "" : totp.secret}
              uri={totp.enabled ? "" : otpauthUri(totp.secret, admin.username, "VylarisSecurity")}
              enabled={totp.enabled}
            />
          )}

          {totp?.enabled && (
            <>
              <p>
                Noch <strong>{admin.recovery.length}</strong> Wiederherstellungscode(s) gültig. Damit kommst du hinein, wenn dein Gerät
                nicht verfügbar ist.
              </p>
              <h3>Neue Wiederherstellungscodes</h3>
              <RecoveryForm />
              <h3>Zwei-Faktor deaktivieren</h3>
              <p className="muted">Nicht empfohlen. Der Zugang ist dann nur noch durch das Passwort geschützt.</p>
              <DisableTotpForm />
            </>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
