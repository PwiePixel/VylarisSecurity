import { Button, Callout, Cards, PageHero, Section, Tile } from "@/components/ui";
import { site } from "@/content/site";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({ title: "Kontakt", description: "So erreichst du VylarisSecurity über die Kontaktseite der VylarisGroup.", path: "/kontakt/" });

export default function Kontakt() {
  return (
    <>
      <PageHero crumbs={[{ label: "Start", href: "/" }, { label: "Kontakt" }]} eyebrow="Kontakt" title="So erreichst du uns." lead="Anfragen, Hinweise auf Schwachstellen und Tickets laufen über die Kontaktseite der VylarisGroup." actions={<Button href={site.links.contact} icon="ext">Zur Kontaktseite</Button>} />
      <Section>
        <Cards cols={2}>
          <Tile icon="mail" title="Allgemeine Anfragen" href={site.links.contact} more="Kontaktseite öffnen">Fragen, Wünsche und Rückmeldungen.</Tile>
          <Tile icon="shield" title="Sicherheitslücke melden" href={site.links.contact} more="Kontaktseite öffnen">Bitte Details nur über die Kontaktseite senden, nicht öffentlich.</Tile>
        </Cards>
        <Callout icon="lock">Bitte schick uns niemals Passwörter, API-Tokens oder Schlüssel – auch nicht auf Nachfrage.</Callout>
      </Section>
    </>
  );
}
