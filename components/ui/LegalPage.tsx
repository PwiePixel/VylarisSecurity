import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { A } from "./Link";

export type LegalSection = { heading: string; body: ReactNode };

/** Platzhalter, der noch von Hand auszufüllen ist (wird gelb hervorgehoben). */
export function Fill({ children }: { children: ReactNode }) {
  return <mark>[{children}]</mark>;
}

export function LegalPage({ title, sections }: { title: string; sections: readonly LegalSection[] }) {
  return (
    <section className="doc" style={{ padding: "5rem 0 2rem" }}>
      <div className="wrap">
        <A href="/" className="back">
          <Icon name="back" />
          Zurück zur Startseite
        </A>
        <h1>{title}</h1>
        {sections.map((s) => (
          <div key={s.heading}>
            <h2>{s.heading}</h2>
            {s.body}
          </div>
        ))}
      </div>
    </section>
  );
}
