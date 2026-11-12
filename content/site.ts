/** Zentrale, typisierte Stammdaten der Website. Die Adresse wird beim Bauen aus SITE_URL übernommen (Installer setzt sie). */
const url = (process.env.SITE_URL ?? "https://security.vylaris.it").replace(/\/+$/, "");

export const site = {
  name: "VylarisSecurity",
  url,
  host: new URL(url).host,
  tagline: "Protecting the Vylaris Ecosystem.",
  tri: "DNS. Proxy. Protection.",
  owner: "CircleUpWilms",
  group: "VylarisGroup",
  area: "Software Development & Technology",
  description:
    "VylarisSecurity ist das Sicherheitssystem der VylarisGroup: eigene Nameserver, ein Reverse-Proxy, der die IP-Adressen der Server verbirgt, eine IP-Verwaltung für alle Netze und die Anbindung an Cloudflare für DDoS-Schutz.",
  links: {
    eu: "https://vylaris.eu",
    ch: "https://vylaris.ch",
    contact: "https://vylaris.eu/contact",
    data: "https://vylarisdata.com",
  },
} as const;

export type NavItem = { href: string; label: string };

export const nav: readonly NavItem[] = [
  { href: "/", label: "Start" },
  { href: "/funktionen/", label: "Funktionen" },
  { href: "/status/", label: "Status" },
  { href: "/kontakt/", label: "Kontakt" },
];

export const footerColumns = [
  {
    title: "Entdecken.",
    links: [
      { href: "/funktionen/", label: "Funktionen" },
      { href: "/status/", label: "Systemstatus" },
      { href: "/kontakt/", label: "Kontakt" },
    ],
  },
  {
    title: "Netzwerk.",
    links: [
      { href: site.links.eu, label: "VylarisGroupEurope" },
      { href: site.links.ch, label: "VylarisGroup Schweiz" },
      { href: site.links.data, label: "VylarisData" },
    ],
  },
  {
    title: "Konto & Recht.",
    links: [
      { href: "/impressum/", label: "Impressum" },
      { href: "/datenschutz/", label: "Datenschutz" },
      { href: "/admin/login/", label: "Anmelden" },
    ],
  },
] as const;
