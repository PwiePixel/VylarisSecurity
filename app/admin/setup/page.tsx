import { redirect } from "next/navigation";
import { AuthCard } from "@/components/admin/AdminShell";
import { SetupForm } from "@/components/admin/Forms";
import { adminExists } from "@/lib/server/admin";
import { setupState } from "@/lib/server/setup";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await adminExists()) redirect("/admin/login/");
  const state = setupState();
  if (state === "expired") {
    return (
      <AuthCard title="Einrichtungs-Schlüssel abgelaufen" lead="Aus Sicherheitsgründen gilt der Schlüssel nur kurze Zeit.">
        <p>
          Auf dem Server <code>./install.sh admin</code> erneut ausführen – der Befehl erzeugt einen neuen Schlüssel.
        </p>
      </AuthCard>
    );
  }
  if (state !== "ok") {
    return (
      <AuthCard title="Einrichtung nicht freigeschaltet" lead="Die Einrichtung wird nur auf Anforderung des Betreibers freigeschaltet.">
        <p>
          Auf dem Server <code>./install.sh admin</code> ausführen – der Befehl schaltet die Einrichtung frei und zeigt den
          Einrichtungs-Schlüssel.
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Admin-Zugang einrichten" lead="Einmalig: Benutzername und Passwort festlegen. Danach ist diese Seite gesperrt.">
      <SetupForm />
    </AuthCard>
  );
}
