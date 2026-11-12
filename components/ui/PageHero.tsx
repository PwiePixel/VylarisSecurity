import type { ReactNode } from "react";
import { Logo } from "@/components/layout/Logo";
import { A } from "./Link";

export type Crumb = { label: string; href?: string };

type PageHeroProps = {
  crumbs?: Crumb[];
  eyebrow: string;
  title: ReactNode;
  lead: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
};

/** Seitenkopf für Unterseiten. */
export function PageHero({ crumbs, eyebrow, title, lead, actions, children }: PageHeroProps) {
  return (
    <section className="page-hero">
      <div className="deco" aria-hidden="true">
        <Logo />
      </div>
      <div className="wrap">
        {crumbs && crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Brotkrumen">
            {crumbs.map((c, i) => (
              <span key={c.label} style={{ display: "contents" }}>
                {i > 0 && <span aria-hidden="true">/</span>}
                {c.href ? <A href={c.href}>{c.label}</A> : <span aria-current="page">{c.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
        {actions && <div className="hero-cta mt-8">{actions}</div>}
        {children}
      </div>
    </section>
  );
}
