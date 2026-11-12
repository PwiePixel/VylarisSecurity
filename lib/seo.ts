import { site } from "@/content/site";

/**
 * Entitäten der VylarisGroup für Suchmaschinen und KI-Assistenten (JSON-LD und llms.txt).
 * Es stehen nur Angaben darin, die auch öffentlich auf den Seiten stehen.
 */
export const ids = {
  group: "https://vylaris.eu/#vylarisgroup",
  europe: "https://vylaris.eu/#organization",
  data: `${site.url}/#organization`,
  website: `${site.url}/#website`,
} as const;

export const logoUrl = `${site.url}/img/logo-mark-on-light.svg`;

export const groupMembers = [
  { name: "VylarisGroup Schweiz", url: "https://vylaris.ch", role: "Schweizer Ursprungsverein (nicht gewinnorientiert), von dem die Idee der VylarisGroup ausgeht." },
  { name: "VylarisGroupEurope", url: "https://vylaris.eu", role: "Europäische Zweitstelle und Firma der Gruppe: zentraler Betrieb, kostenlose Open-Source-SaaS-Dienste, Hosting." },
  { name: "VylarisData", url: site.links.data, role: "Technologie- und Infrastruktur-Untermarke: Server, Netzwerk, Software Development." },
  { name: "VylarisSecurity", url: site.url, role: "Sicherheitssystem der Gruppe: eigene Nameserver, Reverse-Proxy, IP-Verwaltung, Cloudflare-Anbindung." },
] as const;

export function graph() {
  return [
    {
      "@type": "Organization",
      "@id": ids.group,
      name: "VylarisGroup",
      description: "Die VylarisGroup ist ein Verbund aus dem Schweizer Verein VylarisGroup Schweiz, der europäischen Zweitstelle VylarisGroupEurope und Untermarken wie VylarisData und VylarisSecurity.",
    },
    {
      "@type": "Organization",
      "@id": ids.data,
      name: site.name,
      alternateName: "Vylaris Security",
      url: site.url,
      logo: logoUrl,
      slogan: site.tagline,
      description: site.description,
      memberOf: { "@id": ids.group },
      knowsAbout: ["DNS", "Reverse-Proxy", "DDoS-Schutz", "IP-Adressverwaltung", "Cloudflare"],
    },
    { "@type": "WebSite", "@id": ids.website, name: site.name, url: site.url, inLanguage: "de-DE", publisher: { "@id": ids.data } },
  ];
}

/** Öffentliche, indexierbare Seiten – Grundlage für Sitemap und llms.txt. */
export const publicPages = [
  { path: "/", title: "Start", text: "Überblick über VylarisSecurity." },
  { path: "/funktionen/", title: "Funktionen", text: "Eigene Nameserver, Reverse-Proxy, IP-Verwaltung, Cloudflare-Schutz, Traffic-Übersicht." },
  { path: "/status/", title: "Systemstatus", text: "Betriebszustand von DNS-Server, Proxy und Panel." },
  { path: "/kontakt/", title: "Kontakt", text: "So erreichst du uns über die Kontaktseite der VylarisGroup." },
] as const;
