import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { A } from "./Link";

/* ------------------------------------------------------------ Status & Chips */

export type Tone = "ok" | "warn" | "info";

export function Status({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`status ${tone}`}>
      <i />
      {children}
    </span>
  );
}

export function Chips({ items, blue }: { items: readonly string[]; blue?: boolean }) {
  return (
    <div className="chips">
      {items.map((t) => (
        <span key={t} className={blue ? "chip blue" : "chip"}>
          {t}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- Listen */

export function Checks({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="checks">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

export function Dots({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="dots">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------- Karten */

export function Cards({ cols = 3, children }: { cols?: 2 | 3 | 4; children: ReactNode }) {
  return <ul className={`cards c${cols}`}>{children}</ul>;
}

type TileProps = {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  /** macht die Karte klickbar */
  href?: string;
  /** Text des Pfeil-Links unten (nur mit href) */
  more?: string;
  variant?: "default" | "soft" | "feature";
  /** Wrapper als <li> (für Cards) oder <div> */
  as?: "li" | "div";
};

export function Tile({ icon, title, children, href, more, variant = "default", as = "li" }: TileProps) {
  const cls = ["tile", variant === "soft" ? "soft" : "", variant === "feature" ? "feature" : ""].filter(Boolean).join(" ");
  const body = (
    <>
      {icon && (
        <span className="icon">
          <Icon name={icon} />
        </span>
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {href && (
        <span className="more">
          {more ?? "Mehr erfahren"}
          <Icon name="arrow" />
        </span>
      )}
    </>
  );
  const inner = href ? (
    <A href={href} className={cls}>
      {body}
    </A>
  ) : (
    <div className={cls}>{body}</div>
  );
  return as === "li" ? <li>{inner}</li> : inner;
}

/* ------------------------------------------------------- Zweispaltig / Visual */

type SplitProps = {
  copy: ReactNode;
  visual: ReactNode;
  reverse?: boolean;
  even?: boolean;
};

export function Split({ copy, visual, reverse, even }: SplitProps) {
  const cls = ["split", reverse ? "reverse" : "", even ? "even" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="copy">{copy}</div>
      <div>{visual}</div>
    </div>
  );
}

export function Visual({ soft, children }: { soft?: boolean; children: ReactNode }) {
  return <div className={soft ? "visual soft" : "visual"}>{children}</div>;
}

/* -------------------------------------------------------------------- Callout */

export function Callout({ icon = "info", tone, children }: { icon?: IconName; tone?: "warn"; children: ReactNode }) {
  return (
    <div className={tone === "warn" ? "callout warn" : "callout"}>
      <span className="icon">
        <Icon name={icon} />
      </span>
      <div>{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- Schichten */

export type LayerItem = {
  icon: IconName;
  name: string;
  description: ReactNode;
  highlight?: boolean;
};

export function Stack({ layers, arrows = true }: { layers: readonly LayerItem[]; arrows?: boolean }) {
  return (
    <div className="stack">
      {layers.map((l, i) => (
        <div key={l.name}>
          {arrows && i > 0 && (
            <div className="layer-arrow" aria-hidden="true">
              <Icon name="down" />
            </div>
          )}
          <div className={l.highlight ? "layer hi" : "layer"}>
            <div className="lname">
              <span className="icon">
                <Icon name={l.icon} />
              </span>
              {l.name}
            </div>
            <div className="ldesc">{l.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------- Zeitleiste & Schritte */

export type TimelineItem = {
  title: string;
  text: ReactNode;
  status?: { tone: Tone; label: string };
};

export function Timeline({ items }: { items: readonly TimelineItem[] }) {
  return (
    <div className="timeline">
      {items.map((it) => (
        <div className="tl-item" key={it.title}>
          {it.status && <Status tone={it.status.tone}>{it.status.label}</Status>}
          <h3>{it.title}</h3>
          <p>{it.text}</p>
        </div>
      ))}
    </div>
  );
}

export type StepItem = { title: string; text: ReactNode; status?: { tone: Tone; label: string } };

export function Steps({ items }: { items: readonly StepItem[] }) {
  return (
    <ol className="steps" style={{ padding: 0, listStyle: "none" }}>
      {items.map((it) => (
        <li className="step" key={it.title}>
          <h3>{it.title}</h3>
          <p>{it.text}</p>
          {it.status && <Status tone={it.status.tone}>{it.status.label}</Status>}
        </li>
      ))}
    </ol>
  );
}

/* ----------------------------------------------------------------- Tabelle */

export function SpecTable({ rows, head }: { rows: readonly (readonly [ReactNode, ReactNode])[]; head?: readonly [string, string] }) {
  return (
    <div className="table-wrap">
      <table className="spec">
        {head && (
          <thead>
            <tr>
              <th scope="col">{head[0]}</th>
              <th scope="col">{head[1]}</th>
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map(([a, b], i) => (
            <tr key={i}>
              <th scope="row">{a}</th>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------- FAQ */

export type FaqItem = { q: string; a: ReactNode };

export function Faq({ items, openFirst }: { items: readonly FaqItem[]; openFirst?: boolean }) {
  return (
    <div className="faq">
      {items.map((it, i) => (
        <details key={it.q} open={openFirst && i === 0}>
          <summary>{it.q}</summary>
          <div className="ans">{typeof it.a === "string" ? <p>{it.a}</p> : it.a}</div>
        </details>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Fakten-Reihe */

export type FactItem = { value: string; label: ReactNode; icon?: IconName };

export function Facts({ items }: { items: readonly FactItem[] }) {
  return (
    <div className="facts">
      {items.map((f) => (
        <div className="fact" key={f.value}>
          {f.icon && (
            <span className="icon">
              <Icon name={f.icon} />
            </span>
          )}
          <b>{f.value}</b>
          <span>{f.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- Markenkarte */

type BrandCardProps = {
  name: string;
  sub?: string;
  icon: IconName;
  status?: { tone: Tone; label: string };
  current?: boolean;
  children: ReactNode;
  action?: ReactNode;
};

export function BrandCard({ name, sub, icon, status, current, children, action }: BrandCardProps) {
  return (
    <div className={current ? "brandcard current" : "brandcard"}>
      <div className="top">
        <span className="icon">
          <Icon name={icon} />
        </span>
        {status && <Status tone={status.tone}>{status.label}</Status>}
      </div>
      <h3>{name}</h3>
      {sub && <p className="sub">{sub}</p>}
      <p>{children}</p>
      {action}
    </div>
  );
}

/* -------------------------------------------------------------------- Prose */

export function Prose({ children }: { children: ReactNode }) {
  return <div className="prose">{children}</div>;
}
