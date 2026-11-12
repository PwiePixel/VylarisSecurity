import Link from "next/link";
import { A } from "@/components/ui/Link";
import { footerColumns, site } from "@/content/site";
import { Logo } from "./Logo";
import { ThemeSwitch } from "./ThemeSwitch";

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap cols">
        <div>
          <Link className="brand" href="/" aria-label="VylarisSecurity – zur Startseite">
            <Logo />
            <span className="brand-text">
              Vylaris<span>Security</span>
            </span>
          </Link>
          <p>
            {site.tagline} {site.tri} VylarisSecurity ist eine Marke von {site.owner} und gehört zur {site.group}.
          </p>
        </div>
        {footerColumns.map((col) => (
          <nav key={col.title} aria-label={col.title.replace(/\.$/, "")}>
            <h2>{col.title}</h2>
            <ul>
              {col.links.map((l) => (
                <li key={l.label}>
                  <A href={l.href}>{l.label}</A>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="legal">
        <div className="wrap">
          <p>
            Copyright © {new Date().getFullYear()} {site.name} · eine Marke von {site.owner}
          </p>
          <p>Kein Tracking · Keine Cookies</p>
          <ThemeSwitch />
        </div>
      </div>
    </footer>
  );
}
