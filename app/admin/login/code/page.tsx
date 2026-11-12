import { redirect } from "next/navigation";
import { AuthCard } from "@/components/admin/AdminShell";
import { CodeForm } from "@/components/admin/Forms";
import { getPending } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function CodePage() {
  if (!(await getPending())) redirect("/admin/login/");
  return (
    <AuthCard title="Zwei-Faktor-Code" lead="Zur Sicherheit brauchen wir noch den Code aus deiner Authenticator-App.">
      <CodeForm />
    </AuthCard>
  );
}
