import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { themeInitScript } from "@/components/layout/ThemeSwitch";
import { SiteJsonLd } from "@/components/seo/JsonLd";
import { site } from "@/content/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name} – ${site.tagline}`,
    template: `%s – ${site.name}`,
  },
  description: site.description,
  applicationName: site.name,
  robots: { index: true, follow: true },
  icons: { icon: "/img/favicon.svg" },
  authors: [{ name: site.group, url: site.links.eu }],
  creator: site.owner,
  publisher: site.group,
  keywords: ["VylarisSecurity", "VylarisGroup", "DNS-Server", "Reverse-Proxy", "DDoS-Schutz", "IP-Verwaltung", "Cloudflare"],
  openGraph: {
    siteName: site.name,
    title: `${site.name} – ${site.tagline}`,
    description: site.description,
    locale: "de_DE",
    type: "website",
    images: [{ url: "/img/og-image.png", width: 1620, height: 850 }],
  },
  twitter: { card: "summary_large_image", title: `${site.name} – ${site.tagline}`, description: site.description, images: ["/img/og-image.png"] },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f8ff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d11" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <SiteJsonLd />
      </head>
      <body>
        <a className="skip" href="#main">
          Zum Inhalt springen
        </a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
