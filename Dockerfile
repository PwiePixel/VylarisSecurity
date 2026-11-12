# syntax=docker/dockerfile:1
# Ein Image für alles: Panel (Next.js) und die Engines (DNS-Server, Proxy, Worker). Welcher Dienst läuft, bestimmt der Startbefehl in compose.yaml.

# Stufe 1: Seite bauen (Next.js, Standalone-Server)
FROM node:22-alpine AS build
ENV NEXT_TELEMETRY_DISABLED=1
ARG SITE_URL=https://security.vylaris.it
ENV SITE_URL=$SITE_URL
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Stufe 2: schlanker Laufzeit-Container ohne Root-Rechte
FROM node:22-alpine AS run
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    UV_THREADPOOL_SIZE=8
WORKDIR /app
# /data: Konfiguration, Zugang, Protokoll (Volume). Die Engines führen TypeScript direkt aus (Node 22) – ohne Build-Schritt.
RUN mkdir -p /data/runtime && chown -R node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/engine ./engine
COPY --from=build --chown=node:node /app/lib/core ./lib/core
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "server.js"]
