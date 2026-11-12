import { site } from "@/content/site";
import { graph, ids } from "@/lib/seo";

/** JSON-LD-Block. "<" wird maskiert, damit nichts den Skriptblock beenden kann. */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}

/** Organisationen der Gruppe und die Website (steht auf jeder Seite im Layout). */
export function SiteJsonLd() {
  return <JsonLd data={{ "@context": "https://schema.org", "@graph": graph() }} />;
}

/** Eigener Eintrag für eine einzelne Seite (WebPage oder AboutPage), verbunden mit Website und Organisation. */
export function pageSchema({ type, name, description, path }: { type: "WebPage" | "AboutPage"; name: string; description: string; path: string }) {
  return {
    "@context": "https://schema.org",
    "@type": type,
    "@id": `${site.url}${path}#webpage`,
    url: `${site.url}${path}`,
    name,
    description,
    inLanguage: "de-DE",
    isPartOf: { "@id": ids.website },
    about: { "@id": ids.data },
  };
}
