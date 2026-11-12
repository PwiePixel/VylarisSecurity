import type { MetadataRoute } from "next";
import { site } from "@/content/site";

export const dynamic = "force-static";

/** Bekannte KI- und Suchcrawler: ausdrücklich erlaubt, mit denselben Sperren wie für alle. */
const aiCrawlers = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
];

const allow = ["/", "/llms.txt"];
const disallow = ["/admin/", "/healthz"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow, disallow: [...disallow, "/api/"] },
      { userAgent: aiCrawlers, allow, disallow: [...disallow, "/api/"] },
    ],
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url,
  };
}
