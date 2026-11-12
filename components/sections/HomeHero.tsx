import type { ReactNode } from "react";
import { Button, Chips, type IconName } from "@/components/ui";

export type HeroAction = {
  href: string;
  label: string;
  variant: "primary" | "secondary";
  icon?: IconName;
};

export type HeroContent = {
  title: string;
  tagline: string;
  tri: string;
  sub: string;
  /** Kurze Kennzahlen unter den Buttons */
  stats?: readonly string[];
  actions: readonly HeroAction[];
};

type HomeHeroProps = HeroContent & {
  /** Grafik unter dem Text (Netzwerk-Motiv) */
  art: ReactNode;
};

/** Startseiten-Hero mit eigener h1 und animierter Grafik. */
export function HomeHero({ title, tagline, tri, sub, stats, actions, art }: HomeHeroProps) {
  return (
    <section className="hero" id="start">
      <div className="wrap">
        <div className="hero-inner fade-up">
          <h1>{title}</h1>
          <p className="tagline" lang="en">
            {tagline}
          </p>
          <p className="tri" lang="en">
            {tri}
          </p>
          <p className="sub">{sub}</p>
          <div className="hero-cta">
            {actions.map((a) => (
              <Button key={a.href} href={a.href} variant={a.variant} size="lg" icon={a.icon}>
                {a.label}
              </Button>
            ))}
          </div>
          {stats && stats.length > 0 && (
            <div className="mt-6">
              <Chips items={stats} blue />
            </div>
          )}
        </div>
        <div className="hero-art">{art}</div>
      </div>
    </section>
  );
}
