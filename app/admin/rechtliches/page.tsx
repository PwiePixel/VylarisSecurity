import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { LegalForm } from "@/components/admin/LegalForm";
import { Status } from "@/components/ui";
import { requireAdmin } from "@/lib/server/guard";
import { getLegal, legalGaps } from "@/lib/server/legal";

export const dynamic = "force-dynamic";

export default async function LegalAdminPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const admin = await requireAdmin();
  const saved = (await searchParams).saved === "1";
  const data = await getLegal();
  const gaps = legalGaps(data);

  return (
    <AdminShell
      user={admin.username}
      active="/admin/rechtliches/"
      title="Rechtliches"
      lead="Alle Angaben für Impressum und Datenschutzerklärung. Änderungen erscheinen sofort auf den öffentlichen Seiten."
    >
      {saved && (
        <p className="alert ok" role="status">
          Gespeichert – Impressum und Datenschutz sind aktualisiert.
        </p>
      )}
      <div className="admin-grid">
        <div className="admin-card">
          <h2>Vollständigkeit</h2>
          {gaps.length === 0 ? (
            <p>
              <Status tone="ok">Alle Pflichtangaben vorhanden</Status>
            </p>
          ) : (
            <>
              <p>
                <Status tone="warn">{gaps.length} Angabe(n) fehlen</Status>
              </p>
              <ul className="gaps">
                {gaps.map((g) => (
                  <li key={g.field}>
                    {g.label} <span className="muted small">({g.area === "impressum" ? "Impressum" : "Datenschutz"})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="admin-card">
          <h2>Vorschau</h2>
          <p>
            <Link href="/impressum/">Impressum ansehen</Link>
            <br />
            <Link href="/datenschutz/">Datenschutzerklärung ansehen</Link>
          </p>
        </div>
      </div>

      <LegalForm key={data.updatedAt ?? "neu"} data={data} />
    </AdminShell>
  );
}
