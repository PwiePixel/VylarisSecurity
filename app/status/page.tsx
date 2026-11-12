import { PageHero, Section, Status } from "@/components/ui";
import { isFresh } from "@/lib/core/runtime-model";
import { pageMetadata } from "@/lib/metadata";
import { getDnsRuntime, getProxyRuntime, getWorkerRuntime } from "@/lib/server/runtime";
import { time } from "@/lib/format";

export const dynamic = "force-dynamic"; // Zustand wird bei jedem Aufruf frisch gelesen

export const metadata = pageMetadata({ title: "Systemstatus", description: "Betriebszustand von DNS-Server, Proxy und Panel von VylarisSecurity.", path: "/status/" });

/** Öffentlicher Status: nur der Zustand, keine Zahlen, Namen oder Adressen. */
export default async function StatusPage() {
  const [dns, proxy, worker] = await Promise.all([getDnsRuntime(), getProxyRuntime(), getWorkerRuntime()]);
  const items = [
    { name: "Panel", detail: "Verwaltungsoberfläche", ok: true },
    { name: "DNS-Server", detail: "Namensauflösung", ok: isFresh(dns?.updatedAt) },
    { name: "Proxy", detail: "Weiterleitung und Schutz", ok: isFresh(proxy?.updatedAt) },
    { name: "Hintergrunddienst", detail: "Abgleich, Prüfungen, Messwerte", ok: isFresh(worker?.updatedAt) },
  ];
  const all = items.every((i) => i.ok);
  const latest = [dns?.updatedAt, proxy?.updatedAt, worker?.updatedAt].filter(Boolean).sort().pop();
  return (
    <>
      <PageHero crumbs={[{ label: "Start", href: "/" }, { label: "Systemstatus" }]} eyebrow="Systemstatus" title={all ? "Alle Systeme im Betrieb." : "Einzelne Systeme melden sich nicht."} lead="Der Zustand wird bei jedem Aufruf aus den Herzschlägen der Dienste gelesen." />
      <Section>
        <div className="livestatus" aria-live="polite">
          <div className="livestatus-head">
            <Status tone={all ? "ok" : "warn"}>{all ? "Alles im Normalbetrieb" : "Einschränkung"}</Status>
            {latest && <span className="muted">Letzter Herzschlag: {time(latest)}</span>}
          </div>
          <div className="livestatus-group">
            <ul>
              {items.map((i) => (
                <li key={i.name}>
                  <div><strong>{i.name}</strong><span>{i.detail}</span></div>
                  <Status tone={i.ok ? "ok" : "warn"}>{i.ok ? "Im Betrieb" : "Keine Antwort"}</Status>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>
    </>
  );
}
