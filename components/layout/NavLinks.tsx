"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "@/content/site";

const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Hauptnavigation mit Markierung der aktuellen Seite. */
export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const path = normalize(usePathname() ?? "/");
  return (
    <ul>
      {items.map((it) => (
        <li key={it.href}>
          <Link href={it.href} aria-current={normalize(it.href) === path ? "page" : undefined}>
            {it.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
