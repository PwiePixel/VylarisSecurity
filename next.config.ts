import type { NextConfig } from "next";

/**
 * Die Seite läuft als eigenständiger Node-Server (`output: "standalone"`) im Docker-Container
 * hinter dem Cloudflare Tunnel. Die Adresse der Seite kommt beim Bauen aus SITE_URL (der Installer setzt sie). Die öffentlichen Seiten werden beim Build vorgerendert; der Admin-Bereich
 * und der Live-Status laufen dynamisch.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  },
];

const siteHost = new URL(process.env.SITE_URL ?? "https://security.vylaris.it").host;

const config: NextConfig = {
  output: "standalone",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    serverActions: {
      // Formulare im Admin-Bereich werden nur von der eigenen Domain angenommen.
      allowedOrigins: [siteHost],
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/admin/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      { source: "/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/img/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] },
    ];
  },
};

export default config;
