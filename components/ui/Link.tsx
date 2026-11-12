import NextLink from "next/link";
import type { ComponentProps, ReactNode } from "react";

type LinkProps = Omit<ComponentProps<"a">, "href"> & {
  href: string;
  children: ReactNode;
};

export const isExternal = (href: string) => /^(https?:)?\/\//.test(href);

/**
 * Einheitlicher Link: interne Ziele laufen über next/link,
 * externe öffnen in neuem Tab (mit Hinweis für Screenreader).
 */
export function A({ href, children, ...rest }: LinkProps) {
  if (isExternal(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
        <span className="sr-only"> (öffnet in neuem Tab)</span>
      </a>
    );
  }
  return (
    <NextLink href={href} {...rest}>
      {children}
    </NextLink>
  );
}
