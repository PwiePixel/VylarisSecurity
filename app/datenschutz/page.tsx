import { DatenschutzPage } from "@/components/legal/LegalDocs";
import { getLegal } from "@/lib/server/legal";
import { pageMetadata } from "@/lib/metadata";

// Die Angaben kommen aus dem Admin-Bereich und werden bei jedem Aufruf frisch gelesen.
export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Datenschutz",
  description: "Datenschutz von VylarisSecurity, einer Marke von CircleUpWilms.",
  path: "/datenschutz/",
  noindex: true,
});

export default async function Datenschutz() {
  return <DatenschutzPage d={await getLegal()} />;
}
