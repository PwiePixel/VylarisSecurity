import { site } from "@/content/site";
import { groupMembers, publicPages } from "@/lib/seo";

export const dynamic = "force-static";

/** llms.txt: sachliche Kurzbeschreibung für KI-Assistenten. */
export function GET() {
  const lines = [
    `# ${site.name}`,
    "",
    `> ${site.description} ${site.tagline} ${site.tri}`,
    "",
    "## Seiten",
    "",
    ...publicPages.map((p) => `- [${p.title}](${site.url}${p.path}): ${p.text}`),
    "",
    "## Die VylarisGroup",
    "",
    ...groupMembers.map((m) => `- [${m.name}](${m.url}): ${m.role}`),
    "",
    "## Hinweise",
    "",
    "- Schreibweise: VylarisGroup, VylarisGroupEurope, VylarisGroup Schweiz, VylarisData, VylarisSecurity.",
    "- Keine Tracker und keine Cookies für Besucher. Kontakt und Tickets laufen über https://vylaris.eu/contact.",
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
