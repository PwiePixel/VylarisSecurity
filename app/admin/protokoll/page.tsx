import { AdminShell } from "@/components/admin/AdminShell";
import { AuditTable } from "@/components/admin/AuditTable";
import { getAudit } from "@/lib/server/audit";
import { requireAdmin } from "@/lib/server/guard";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const admin = await requireAdmin();
  const events = await getAudit(200);
  return (
    <AdminShell user={admin.username} active="/admin/protokoll/" title="Protokoll" lead="Die letzten 200 sicherheitsrelevanten Ereignisse (neueste zuerst). Passwörter und Codes werden nie protokolliert.">
      <AuditTable events={events} />
    </AdminShell>
  );
}
