import { Callout, Cta, Faq, PageHero, Section, SectionHead, SpecTable, Split, Visual, Checks } from "@/components/ui";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "Funktionen",
  description: "Eigene Nameserver, Reverse-Proxy, IP-Verwaltung, Cloudflare-Schutz und Traffic-Übersicht von VylarisSecurity.",
  path: "/funktionen/",
});

export default function Funktionen() {
  return (
    <>
      <PageHero crumbs={[{ label: "Start", href: "/" }, { label: "Funktionen" }]} eyebrow="Funktionen" title="Alles, was ein Sicherheitssystem für Server braucht." lead="DNS, Proxy, Adressen, Schutz und Überblick – aus einem Guss." />

      <Section labelledBy="dns-h">
        <Split
          copy={
            <>
              <SectionHead eyebrow="DNS" id="dns-h" title="Eigene Nameserver für alle Domains." />
              <Checks items={["Zonen und Einträge: A, AAAA, CNAME, ALIAS, MX, TXT, SRV, CAA, NS, PTR", "Interne Einträge, die nur aus dem eigenen Netz sichtbar sind", "Server-Namen entstehen automatisch aus der Server-Liste", "Antworten per UDP und TCP, mit Anfragelimit gegen Missbrauch"]} />
            </>
          }
          visual={<Visual soft><p className="mono">web01.server.vylaris.it → 10.0.0.21</p><p className="mono">shop.example.com → Cloudflare</p></Visual>}
        />
      </Section>

      <Section band labelledBy="proxy-h">
        <Split
          reverse
          copy={
            <>
              <SectionHead eyebrow="Proxy" id="proxy-h" title="Die IP deines Servers bleibt privat." />
              <Checks items={["Besucher erreichen nur den Proxy – nie den Server selbst", "Routen per Hostname, auch Wildcards, mit Namen statt IP-Adressen", "Sperrlisten, Anfragelimit, Größenlimit, WebSocket-Unterstützung", "Zähler und abgewehrte Anfragen live im Panel"]} />
            </>
          }
          visual={<Visual soft><p className="mono">Besucher → Cloudflare → Tunnel → Proxy → Server</p></Visual>}
        />
      </Section>

      <Section labelledBy="cf-h">
        <SectionHead eyebrow="Cloudflare" id="cf-h" title="DDoS-Schutz, ohne die Kontrolle abzugeben." lead="Unsere Nameserver bleiben die Quelle der Wahrheit. Für geschützte Namen liefern sie den Cloudflare-Namen aus; für Zonen bei Cloudflare gleicht das Panel automatisch ab." />
        <SpecTable
          head={["Betriebsart", "Wer antwortet?"]}
          rows={[
            ["Eigene Nameserver", "ns1/ns2 beantworten die Zone. Geschützte Einträge zeigen auf Cloudflare."],
            ["Cloudflare-Zone", "Cloudflare antwortet. Das Panel pflegt die Einträge und legt Tunnel-Verbindungen an."],
          ]}
        />
      </Section>

      <Section band labelledBy="ip-h">
        <SectionHead eyebrow="IP-Verwaltung" id="ip-h" title="Alle Adressen, alle Netze." />
        <Checks items={["Frei, zugewiesen, reserviert, gesperrt – pro Adresse", "Mehrere Adressen pro VM", "Erreichbarkeits-Scan: erkennt Konflikte und ausgefallene Server", "Traffic pro VM direkt aus Proxmox"]} />
      </Section>

      <Section labelledBy="faq-h">
        <SectionHead eyebrow="Fragen" id="faq-h" title="Kurz beantwortet." />
        <Faq
          items={[
            { q: "Brauche ich offene Ports?", a: "Für den DNS-Server ja: Port 53 (UDP und TCP). Panel und Proxy laufen über einen ausgehenden Cloudflare-Tunnel ohne offene Ports." },
            { q: "Gehen bei einem Update Daten verloren?", a: "Nein. Konfiguration, Zugangsdaten und Zonen liegen in einem eigenen Daten-Volume und Dateien neben dem Projekt – ein Update tauscht nur den Programmcode." },
            { q: "Kann ich auch Domains bei Cloudflare lassen?", a: "Ja, pro Zone wählbar. Das Panel ist dann nur die gemeinsame Oberfläche." },
          ]}
          openFirst
        />
        <Callout icon="info">Bei VylarisSecurity gibt es keine Tracker und keine Cookies für Besucher.</Callout>
      </Section>

      <Cta title="Fragen zu VylarisSecurity?" text="Schreib uns über die Kontaktseite der VylarisGroup." primary={{ href: "/kontakt/", label: "Zum Kontakt" }} />
    </>
  );
}
