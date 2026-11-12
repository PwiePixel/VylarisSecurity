import type { Metadata } from "next";
import { NetworkGraphic } from "@/components/graphics/NetworkGraphic";
import { HomeHero } from "@/components/sections/HomeHero";
import { Button, Callout, Cards, Cta, Gradient, Section, SectionHead, Steps, Tile } from "@/components/ui";
import { site } from "@/content/site";
import { pageMetadata } from "@/lib/metadata";

const meta = {
  title: "VylarisSecurity – DNS, Proxy und Schutz für die VylarisGroup",
  description: site.description,
  path: "/",
} as const;
const base = pageMetadata(meta);
export const metadata: Metadata = { ...base, title: { absolute: meta.title }, openGraph: { ...base.openGraph, title: meta.title } };

export default function HomePage() {
  return (
    <>
      <HomeHero
        title="VylarisSecurity – das Sicherheitssystem der Gruppe"
        tagline={site.tagline}
        tri={site.tri}
        sub="Eigene Nameserver, ein Proxy, der die IP-Adressen unserer Server verbirgt, eine Übersicht über alle Netze und Adressen – und Cloudflare davor als Schutzschild. Alles in einem Panel, in einem Installationsbefehl."
        stats={["Eigene Nameserver", "Reverse-Proxy", "IP-Verwaltung", "Cloudflare-Schutz"]}
        actions={[
          { href: "/funktionen/", label: "Funktionen ansehen", variant: "primary", icon: "arrow" },
          { href: "/status/", label: "Systemstatus", variant: "secondary" },
        ]}
        art={<NetworkGraphic />}
      />

      <Section id="funktionen" labelledBy="f-h">
        <SectionHead eyebrow="Was drin ist" id="f-h" title={<>Ein System statt vieler <Gradient>Einzelteile</Gradient>.</>} lead="Vom Domainnamen bis zum Server: Alles läuft über dieselbe Verwaltung." />
        <Cards cols={3}>
          <Tile icon="globe" title="Eigener DNS-Server">Unsere Nameserver ns1 und ns2 beantworten die Domains der Gruppe selbst – mit Zonen, Einträgen und Übersicht im Panel.</Tile>
          <Tile icon="shield" title="Server-IPs bleiben verborgen">Besucher sprechen nur mit dem Proxy. Die echte Adresse eines Servers erfährt niemand.</Tile>
          <Tile icon="cloud" title="Cloudflare als Schutzschild">DDoS-Schutz und Zertifikate von Cloudflare – die Namen verwalten wir trotzdem selbst.</Tile>
          <Tile icon="server" title="Server mit Domainnamen">Jede VM bekommt einen Namen wie web01.server.vylaris.it. Statt IPv4-Adressen trägst du nur noch Namen ein.</Tile>
          <Tile icon="network" title="IP-Verwaltung">Alle Netze, alle Adressen: frei, zugewiesen, reserviert – und ob sie wirklich erreichbar sind. Mehrere Adressen pro VM sind kein Problem.</Tile>
          <Tile icon="activity" title="Traffic im Blick">Ein- und ausgehender Verkehr jeder VM, des Proxys und des DNS-Servers als Diagramm.</Tile>
        </Cards>
      </Section>

      <Section band id="ablauf" labelledBy="a-h">
        <SectionHead eyebrow="So läuft eine Anfrage" id="a-h" title="Vom Besucher zum Server – ohne offene Flanke." />
        <Steps
          items={[
            { title: "1. Namensauflösung", text: "Wer eine unserer Domains sucht, landet bei unseren Nameservern. Geschützte Namen zeigen auf Cloudflare, nicht auf unsere Server." },
            { title: "2. Cloudflare", text: "Cloudflare nimmt die Anfrage an, wehrt Angriffe ab und sorgt für HTTPS." },
            { title: "3. Tunnel und Proxy", text: "Ein ausgehender Tunnel bringt die Anfrage zum Proxy. Der prüft Sperrlisten, Anfragelimit und Größe." },
            { title: "4. Dein Server", text: "Der Proxy erreicht den Server über sein internes Netz. Ein Port nach außen ist nicht nötig." },
          ]}
        />
        <Callout icon="lock">Die Verwaltung ist durch Anmeldung und Zwei-Faktor-Schutz gesichert, protokolliert jede Änderung und setzt weder Tracker noch Cookies für Besucher ein.</Callout>
      </Section>

      <Cta title={<>Betrieb ansehen: <Gradient>Systemstatus</Gradient>.</>} text="Den aktuellen Zustand von DNS-Server, Proxy und Panel zeigen wir offen." primary={{ href: "/status/", label: "Zum Systemstatus" }} secondary={{ href: "/kontakt/", label: "Kontakt" }} />
    </>
  );
}
