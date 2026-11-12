import type { MetadataRoute } from "next";
import { site } from "@/content/site";
import { publicPages } from "@/lib/seo";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPages.map((p) => ({ url: `${site.url}${p.path}`, changeFrequency: p.path === "/status/" ? "daily" : "monthly", priority: p.path === "/" ? 1 : 0.7 }));
}
