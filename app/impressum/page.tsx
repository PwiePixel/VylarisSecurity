import { ImpressumPage } from "@/components/legal/LegalDocs";
import { getLegal } from "@/lib/server/legal";
import { pageMetadata } from "@/lib/metadata";

// Die Angaben kommen aus dem Admin-Bereich und werden bei jedem Aufruf frisch gelesen.
export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Impressum",
  description: "Impressum von VylarisSecurity, einer Marke von CircleUpWilms.",
  path: "/impressum/",
  noindex: true,
});

export default async function Impressum() {
  return <ImpressumPage d={await getLegal()} />;
}
