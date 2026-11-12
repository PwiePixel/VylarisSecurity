import type { ReactNode } from "react";
import { Button } from "./Button";
import type { IconName } from "./Icon";

type CtaAction = { href: string; label: string; icon?: IconName };

type CtaProps = {
  /** id der Überschrift (aria-labelledby) */
  id?: string;
  /** optionale id für den ganzen Abschnitt, z. B. als Sprungziel */
  sectionId?: string;
  title: ReactNode;
  text: ReactNode;
  primary: CtaAction;
  secondary?: CtaAction;
};

/** Abschluss-Block am Seitenende. */
export function Cta({ id = "cta-h", sectionId, title, text, primary, secondary }: CtaProps) {
  return (
    <section className="section" id={sectionId} aria-labelledby={id}>
      <div className="wrap">
        <div className="cta">
          <div className="glow" aria-hidden="true" />
          <div className="in">
            <h2 className="h2" id={id}>
              {title}
            </h2>
            <p>{text}</p>
            <div className="btns">
              <Button href={primary.href} size="lg" icon={primary.icon ?? "arrow"}>
                {primary.label}
              </Button>
              {secondary && (
                <Button href={secondary.href} variant="secondary" size="lg" icon={secondary.icon}>
                  {secondary.label}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Hervorgehobenes Wort in Überschriften (Farbverlauf). */
export function Gradient({ children }: { children: ReactNode }) {
  return <span className="text-gradient">{children}</span>;
}
