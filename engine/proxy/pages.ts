/** Schlichte Fehlerseiten des Proxys (Deutsch, ohne externe Ressourcen, hell/dunkel per prefers-color-scheme). */

type Info = { title: string; text: string };

const infos: Record<number, Info> = {
  400: { title: "Ungültige Anfrage", text: "Die Anfrage konnte nicht verarbeitet werden." },
  403: { title: "Zugriff verweigert", text: "Der Zugriff auf diese Adresse ist nicht erlaubt." },
  404: { title: "Nicht gefunden", text: "Unter dieser Adresse ist nichts eingerichtet." },
  413: { title: "Anfrage zu groß", text: "Die gesendeten Daten überschreiten die erlaubte Größe." },
  429: { title: "Zu viele Anfragen", text: "Bitte einen Moment warten und es dann erneut versuchen." },
  502: { title: "Server nicht erreichbar", text: "Der Server hinter dieser Adresse antwortet gerade nicht. Bitte später erneut versuchen." },
  503: { title: "Vorübergehend nicht verfügbar", text: "Dieser Dienst ist gerade nicht erreichbar. Bitte später erneut versuchen." },
  504: { title: "Zeitüberschreitung", text: "Der Server hinter dieser Adresse hat nicht rechtzeitig geantwortet." },
};

const css =
  ":root{color-scheme:light dark;--bg:#f5f9fe;--card:#fff;--ink:#010109;--text:#444;--brand:#1e73be;--border:#d3d9e4}" +
  "@media(prefers-color-scheme:dark){:root{--bg:#0b0d11;--card:#11141a;--ink:#fff;--text:#a1a1aa;--brand:#5aa9e6;--border:#27272a}}" +
  "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;line-height:1.5}" +
  "main{width:min(92vw,30rem);background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:2rem}" +
  "p.code{margin:0 0 .5rem;font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--brand)}" +
  "h1{margin:0 0 .5rem;font-size:1.5rem;color:var(--ink)}p{margin:0}footer{margin-top:1.5rem;font-size:.8rem;opacity:.8}";

const cache = new Map<number, string>();

export function errorPage(status: number): string {
  const hit = cache.get(status);
  if (hit) return hit;
  const i = infos[status] ?? { title: "Fehler", text: "Die Anfrage konnte nicht bearbeitet werden." };
  const html =
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${i.title}</title><style>${css}</style></head><body><main>` +
    `<p class="code">Fehler ${status}</p><h1>${i.title}</h1><p>${i.text}</p><footer>Vylaris Security</footer></main></body></html>`;
  cache.set(status, html);
  return html;
}

export const errorHeaders = (status: number): Record<string, string | number> => ({
  "content-type": "text/html; charset=utf-8",
  "content-length": Buffer.byteLength(errorPage(status)),
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
});

export const statusText = (status: number): string =>
  ({ 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" })[status] ?? "Error";
