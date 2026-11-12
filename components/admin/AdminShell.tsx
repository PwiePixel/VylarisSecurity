import Link from "next/link";
import type { ReactNode } from "react";
import { LogoutForm } from "./Forms";

const links = [
  { href: "/admin/", label: "Übersicht" },
  { href: "/admin/dns/", label: "DNS" },
  { href: "/admin/server/", label: "Server" },
  { href: "/admin/ip/", label: "IP-Adressen" },
  { href: "/admin/proxy/", label: "Proxy" },
  { href: "/admin/traffic/", label: "Traffic" },
  { href: "/admin/integrationen/", label: "Anbindungen" },
  { href: "/admin/rechtliches/", label: "Rechtliches" },
  { href: "/admin/sicherheit/", label: "Sicherheit" },
  { href: "/admin/protokoll/", label: "Protokoll" },
] as const;

type Props = { user: string; active: (typeof links)[number]["href"]; title: string; lead?: string; children: ReactNode; crumb?: { href: string; label: string } };

/** Rahmen für alle geschützten Admin-Seiten. */
export function AdminShell({ user, active, title, lead, children, crumb }: Props) {
  return (
    <section className="admin">
      <div className="wrap">
        <div className="admin-bar">
          <nav aria-label="Admin-Navigation">
            {links.map((l) => (
              <Link key={l.href} href={l.href} aria-current={l.href === active ? "page" : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="admin-user">
            <span>
              Angemeldet als <strong>{user}</strong>
            </span>
            <LogoutForm />
          </div>
        </div>
        {crumb && (
          <p className="small">
            <Link href={crumb.href}>← {crumb.label}</Link>
          </p>
        )}
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
        {children}
      </div>
    </section>
  );
}

/** Zentrierte Karte für Anmeldung und Einrichtung. */
export function AuthCard({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <section className="admin">
      <div className="wrap">
        <div className="auth-card">
          <p className="eyebrow">Admin-Bereich</p>
          <h1>{title}</h1>
          {lead && <p className="lead">{lead}</p>}
          {children}
        </div>
      </div>
    </section>
  );
}
