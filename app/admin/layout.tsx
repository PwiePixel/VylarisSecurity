import type { Metadata } from "next";
import type { ReactNode } from "react";

/** Der Admin-Bereich wird nie von Suchmaschinen erfasst und nie zwischengespeichert. */
export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
