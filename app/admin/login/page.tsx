import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/admin/AdminShell";
import { LoginForm } from "@/components/admin/Forms";
import { adminExists } from "@/lib/server/admin";
import { getSessionUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/admin/");
  const hasAdmin = await adminExists();
  if (!hasAdmin) {
    return (
      <AuthCard title="Noch kein Admin-Zugang" lead="Der Admin-Zugang wurde noch nicht eingerichtet.">
        <p>
          Die Einrichtung startest du auf dem Server mit <code>./install.sh admin</code>. Der Befehl zeigt dir den
          Einrichtungs-Schlüssel für die Seite <Link href="/admin/setup/">/admin/setup/</Link>.
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Anmelden" lead="Zugang für Betreiber von VylarisSecurity.">
      <LoginForm />
    </AuthCard>
  );
}
