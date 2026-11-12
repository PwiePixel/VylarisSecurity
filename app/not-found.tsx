import { Button } from "@/components/ui";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "Seite nicht gefunden",
  description: "Diese Seite existiert nicht.",
  path: "/404/",
  noindex: true,
});

export default function NotFound() {
  return (
    <section className="doc" style={{ padding: "5rem 0 2rem" }}>
      <div className="wrap">
        <p className="eyebrow">Fehler 404</p>
        <h1>Diese Seite gibt es nicht.</h1>
        <p>Der Link ist veraltet oder die Adresse wurde falsch eingegeben.</p>
        <p className="mt-8">
          <Button href="/" size="lg" icon="arrow">
            Zur Startseite
          </Button>
        </p>
      </div>
    </section>
  );
}
