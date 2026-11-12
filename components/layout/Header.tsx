import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { nav } from "@/content/site";
import { Logo } from "./Logo";
import { MobileNav } from "./MobileNav";
import { NavLinks } from "./NavLinks";

export function Header() {
  return (
    <header className="header">
      <div className="wrap">
        <Link className="brand" href="/" aria-label="VylarisSecurity – zur Startseite">
          <Logo />
          <span className="brand-text">
            Vylaris<span>Security</span>
          </span>
        </Link>
        <nav className="nav" aria-label="Hauptnavigation">
          <NavLinks items={nav} />
        </nav>
        <div className="header-actions">
          <Button href="/admin/login/" size="sm">
            Anmelden
          </Button>
          <MobileNav items={nav} />
        </div>
      </div>
    </header>
  );
}
