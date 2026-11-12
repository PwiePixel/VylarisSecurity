import type { ReactNode } from "react";

type SectionProps = {
  id?: string;
  /** id der Überschrift, für aria-labelledby */
  labelledBy?: string;
  /** abgesetzter Hintergrundstreifen */
  band?: boolean;
  /** größerer Abstand */
  large?: boolean;
  children: ReactNode;
};

export function Section({ id, labelledBy, band, large, children }: SectionProps) {
  const cls = ["section", large ? "section-lg" : "", band ? "band" : ""].filter(Boolean).join(" ");
  return (
    <section className={cls} id={id} aria-labelledby={labelledBy}>
      <div className="wrap">{children}</div>
    </section>
  );
}

type SectionHeadProps = {
  eyebrow?: string;
  title: ReactNode;
  /** id für das h2 (passend zu Section.labelledBy) */
  id?: string;
  lead?: ReactNode;
  center?: boolean;
  /** schmalere Maximalbreite */
  narrow?: boolean;
};

export function SectionHead({ eyebrow, title, id, lead, center, narrow }: SectionHeadProps) {
  const inner = (
    <>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2 className="h2" id={id}>
        {title}
      </h2>
      {lead && <p className="lead">{lead}</p>}
    </>
  );
  if (center) return <div className="center">{inner}</div>;
  return <div className={narrow ? "max-2xl" : "max-3xl"}>{inner}</div>;
}
