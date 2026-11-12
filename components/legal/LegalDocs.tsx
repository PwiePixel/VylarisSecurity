import type { ReactNode } from "react";
import { A } from "@/components/ui";
import { Fill, LegalPage, type LegalSection } from "@/components/ui/LegalPage";
import { site } from "@/content/site";
import { legalForms, registerTypes, type LegalData } from "@/lib/server/legal-shared";

/** Zeilenumbrüche aus Freitext sichtbar machen (React escaped den Text, es gibt kein HTML aus Eingaben). */
function Lines({ text }: { text: string }) {
  const parts = text.split("\n");
  return (
    <>
      {parts.map((l, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {l}
        </span>
      ))}
    </>
  );
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((p, i) => (
          <p key={i}>
            <Lines text={p} />
          </p>
        ))}
    </>
  );
}

const or = (v: string, placeholder: string): ReactNode => (v ? v : <Fill>{placeholder}</Fill>);

/* ----------------------------------------------------------------- Impressum */
export function ImpressumPage({ d }: { d: LegalData }) {
  const form = legalForms.find((f) => f.value === d.legalForm);
  const showForm = d.legalForm !== "einzelunternehmen" && d.legalForm !== "freiberufler";
  const ownerLabel = d.legalForm === "einzelunternehmen" || d.legalForm === "ek" || d.legalForm === "freiberufler" ? "Inhaber" : "Anbieter";
  const reg = registerTypes.find((r) => r.value === d.registerType);

  const sections: LegalSection[] = [
    {
      heading: "Angaben gemäß § 5 DDG",
      body: (
        <p>
          {d.brandName ? `${d.brandName} – eine Marke von ` : ""}
          {d.companyName || d.ownerName}
          {showForm && form ? ` (${form.label})` : ""}
          <br />
          {ownerLabel}: {or(d.ownerName, "Name")}
          <br />
          {or(d.street, "Straße und Hausnummer")}
          <br />
          {d.zip || d.city ? `${d.zip} ${d.city}`.trim() : <Fill>PLZ Ort</Fill>}
          {d.country ? (
            <>
              <br />
              {d.country}
            </>
          ) : null}
        </p>
      ),
    },
  ];

  if (form?.needsRepresentative) {
    sections.push({ heading: "Vertreten durch", body: <p>{or(d.representative, "Vertretungsberechtigte Person(en)")}</p> });
  }

  sections.push({
    heading: "Kontakt",
    body: (
      <p>
        E-Mail: {d.email ? <a href={`mailto:${d.email}`}>{d.email}</a> : <Fill>E-Mail-Adresse</Fill>}
        {d.phone ? (
          <>
            <br />
            Telefon: {d.phone}
          </>
        ) : null}
        {d.showGroupContactPath ? (
          <>
            <br />
            Kontakt und Tickets über die VylarisGroup: <A href={site.links.contact}>vylaris.eu/contact</A>
          </>
        ) : null}
      </p>
    ),
  });

  if (d.registerEnabled) {
    sections.push({
      heading: "Registereintrag",
      body: (
        <p>
          Eintragung im {reg?.label ?? "Register"}
          <br />
          Registergericht: {or(d.registerCourt, "Registergericht")}
          <br />
          Registernummer: {or(d.registerNumber, "Registernummer")}
        </p>
      ),
    });
  }

  if (d.vatMode === "small") {
    sections.push({
      heading: "Umsatzsteuer",
      body: <p>Kleinunternehmer im Sinne von § 19 UStG. Es wird keine Umsatzsteuer berechnet und ausgewiesen.</p>,
    });
  } else if (d.vatMode === "regular" && d.vatId) {
    sections.push({ heading: "Umsatzsteuer-Identifikationsnummer", body: <p>Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: {d.vatId}</p> });
  } else if (d.vatMode === "unset") {
    sections.push({ heading: "Umsatzsteuer", body: <p><Fill>Umsatzsteuer-Status im Admin-Bereich festlegen</Fill></p> });
  }

  if (d.supervisoryAuthority) {
    sections.push({ heading: "Zuständige Aufsichtsbehörde", body: <p><Lines text={d.supervisoryAuthority} /></p> });
  }

  if (d.contentResponsibleEnabled) {
    sections.push({
      heading: "Verantwortlich für den Inhalt gemäß § 18 Abs. 2 MStV",
      body: (
        <p>
          {or(d.contentResponsibleName || d.ownerName, "Name")}
          <br />
          {d.contentResponsibleAddress ? (
            <Lines text={d.contentResponsibleAddress} />
          ) : (
            <>
              {d.street}, {d.zip} {d.city}
            </>
          )}
        </p>
      ),
    });
  }

  if (d.disputeMode === "not_willing") {
    sections.push({
      heading: "Verbraucherstreitbeilegung",
      body: <p>Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>,
    });
  } else if (d.disputeMode === "willing") {
    sections.push({
      heading: "Verbraucherstreitbeilegung",
      body: (
        <>
          <p>Wir sind bereit, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>
          {d.disputeNote ? <p><Lines text={d.disputeNote} /></p> : null}
        </>
      ),
    });
  }

  sections.push({
    heading: "Zugehörigkeit",
    body: (
      <p>
        {site.name} gehört zur {site.group} (Geschäftsbereich {site.area}). Weitere Informationen: <A href={site.links.eu}>vylaris.eu</A> und{" "}
        <A href={site.links.ch}>vylaris.ch</A>.
      </p>
    ),
  });
  sections.push({
    heading: "Haftung für externe Links",
    body: (
      <p>
        Diese Seite verlinkt auf externe Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Für diese Inhalte ist stets der jeweilige Anbieter
        verantwortlich.
      </p>
    ),
  });
  if (d.extraImpressum) sections.push({ heading: "Weitere Hinweise", body: <Paragraphs text={d.extraImpressum} /> });

  return <LegalPage title="Impressum" sections={sections} />;
}

/* --------------------------------------------------------------- Datenschutz */
export function DatenschutzPage({ d }: { d: LegalData }) {
  const addr = [d.street, [d.zip, d.city].filter(Boolean).join(" "), d.country].filter(Boolean).join(", ");

  const sections: LegalSection[] = [
    {
      heading: "Verantwortlicher",
      body: (
        <p>
          {d.companyName || d.ownerName} (Marke {d.brandName || site.name}), {d.ownerName}
          <br />
          {addr || <Fill>Anschrift im Admin-Bereich ergänzen</Fill>}
          <br />
          E-Mail: {d.email ? <a href={`mailto:${d.email}`}>{d.email}</a> : <Fill>E-Mail-Adresse</Fill>}
          <br />
          Weitere Angaben siehe <A href="/impressum/">Impressum</A>.
        </p>
      ),
    },
  ];
  if (d.dpoName || d.dpoEmail) {
    sections.push({
      heading: "Datenschutzbeauftragte(r)",
      body: (
        <p>
          {d.dpoName}
          {d.dpoName && d.dpoEmail ? <br /> : null}
          {d.dpoEmail ? <a href={`mailto:${d.dpoEmail}`}>{d.dpoEmail}</a> : null}
        </p>
      ),
    });
  }
  sections.push(
    {
      heading: "Keine Cookies, kein Tracking für Besucher",
      body: (
        <p>
          Besucher dieser Website erhalten keine Cookies und werden nicht getrackt. Es kommen weder Analyse- noch Tracking-Dienste zum Einsatz. Schriftarten und
          Skripte werden von dieser Domain ausgeliefert, nicht von Drittanbietern.
        </p>
      ),
    },
    {
      heading: "Lokale Einstellungen",
      body: (
        <p>
          Wenn du im Footer zwischen hellem und dunklem Design wählst, speichert dein Browser diese Auswahl lokal (Local Storage). Die Information verlässt dein
          Gerät nicht und wird nicht an uns übertragen.
        </p>
      ),
    },
    {
      heading: "Auslieferung über Cloudflare",
      body: (
        <p>
          Diese Website wird über einen Cloudflare Tunnel ausgeliefert. Dabei verarbeitet Cloudflare technisch notwendige Verbindungsdaten (z. B. IP-Adresse,
          Zeitpunkt, aufgerufene Seite), um die Seite bereitzustellen und abzusichern. Rechtsgrundlage ist unser berechtigtes Interesse an einer sicheren und
          zuverlässigen Bereitstellung (Art. 6 Abs. 1 lit. f DSGVO). Es gelten zusätzlich die Datenschutzhinweise von Cloudflare:{" "}
          <A href="https://www.cloudflare.com/privacypolicy/">cloudflare.com/privacypolicy</A>.
        </p>
      ),
    },
    {
      heading: "Server-Logfiles",
      body: (
        <p>
          Beim Aufruf der Website verarbeitet der Webserver technisch notwendige Verbindungsdaten (z. B. IP-Adresse, Datum und Uhrzeit, aufgerufene Seite,
          Browsertyp), um die Seite auszuliefern und den sicheren Betrieb zu gewährleisten (Art. 6 Abs. 1 lit. f DSGVO).{" "}
          {d.logRetentionDays ? `Die Daten werden nach ${d.logRetentionDays} Tagen gelöscht.` : <Fill>Speicherdauer der Logfiles im Admin-Bereich festlegen</Fill>}
        </p>
      ),
    },
    {
      heading: "Admin-Bereich (nur für Betreiber)",
      body: (
        <p>
          Für die Anmeldung im Admin-Bereich wird ein technisch notwendiges Sitzungs-Cookie gesetzt. Es dient ausschließlich der Anmeldung der Betreiber und
          betrifft keine normalen Besucher. Bei Anmeldeversuchen werden IP-Adresse und Zeitpunkt in einem Sicherheitsprotokoll gespeichert, um Angriffe zu
          erkennen und abzuwehren (Art. 6 Abs. 1 lit. f DSGVO).
        </p>
      ),
    },
    {
      heading: "Externe Links",
      body: <p>Wir verlinken auf vylaris.eu, vylaris.ch und weitere Seiten. Beim Anklicken gelten die Datenschutzhinweise der jeweiligen Betreiber.</p>,
    },
    {
      heading: "Deine Rechte",
      body: (
        <>
          <p>
            Du hast nach der DSGVO das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch sowie das
            Recht, dich bei einer Aufsichtsbehörde zu beschweren.
          </p>
          {d.privacyAuthority ? (
            <p>
              Zuständige Aufsichtsbehörde:
              <br />
              <Lines text={d.privacyAuthority} />
            </p>
          ) : null}
        </>
      ),
    },
  );
  if (d.extraPrivacy) sections.push({ heading: "Weitere Hinweise", body: <Paragraphs text={d.extraPrivacy} /> });
  return <LegalPage title="Datenschutz" sections={sections} />;
}
