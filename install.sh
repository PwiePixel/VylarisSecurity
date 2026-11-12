#!/usr/bin/env bash
# =============================================================================
#  VylarisSecurity – Installer: DNS-Server, Proxy, IP-Verwaltung und Cloudflare
# =============================================================================
#  Ein Befehl richtet alles ein: holt den Code von GitHub, installiert fehlende Voraussetzungen
#  (Docker, git, curl), richtet Cloudflare (Tunnel, DNS-Eintrag) und die Nameserver ein, baut
#  und startet alle Dienste:
#
#     web      Panel + öffentliche Seiten      (kein Port nach außen, läuft über den Cloudflare Tunnel)
#     dns      eigener DNS-Server (ns1/ns2)    (Port 53 UDP+TCP – der einzige offene Port)
#     proxy    Reverse-Proxy, verbirgt die Server-IPs (über den Tunnel erreichbar)
#     worker   Cloudflare-Abgleich, Erreichbarkeits-Scan, Traffic
#     tunnel   Cloudflare Tunnel
#
#  Erstinstallation auf einem frischen Server (als root oder mit sudo-Rechten):
#     curl -fsSL https://raw.githubusercontent.com/PwiePixel/VylarisSecurity/main/install.sh | bash
#  oder:
#     git clone https://github.com/PwiePixel/VylarisSecurity.git && cd VylarisSecurity && ./install.sh
#
#  Aufruf:
#    ./install.sh                  geführte Einrichtung (empfohlen)
#    ./install.sh --update         neueste Version holen und alles aktualisieren – ohne Rückfragen zu
#                                  Zugangsdaten; Konfiguration, Zonen, Admin-Zugang und Protokoll bleiben erhalten
#                                  (vorher wird automatisch eine Sicherung angelegt)
#    ./install.sh --update --check nur prüfen, ob ein Update verfügbar ist
#    ./install.sh status           Dienste, Tunnel, DNS-Server und Erreichbarkeit anzeigen
#    ./install.sh logs [dienst]    Logs ansehen (Strg+C beendet), z. B. logs dns
#    ./install.sh restart          alle Dienste neu starten
#    ./install.sh stop | start     Dienste stoppen bzw. starten
#    ./install.sh backup           Daten und Zugangsdaten sichern (Ordner backups/)
#    ./install.sh restore DATEI    Daten aus einer Sicherung wiederherstellen
#    ./install.sh admin            Admin-Zugang für das Panel einrichten (zeigt den Einrichtungs-Schlüssel)
#    ./install.sh admin-reset      Admin-Zugang zurücksetzen (Passwort vergessen)
#    ./install.sh cloudflare       Cloudflare-Token (neu) eingeben und prüfen
#    ./install.sh proxmox          Proxmox-API-Token (Geheimnis) für Traffic und Status eintragen
#    ./install.sh domain           Tunnel-Route und DNS-Eintrag des Panels (neu) setzen
#    ./install.sh dns-check        DNS-Server von diesem Rechner aus testen (UDP und TCP, Port 53)
#    ./install.sh verify           gespeicherten Cloudflare-Token prüfen
#    ./install.sh forget           gespeicherte Zugangsdaten löschen (Daten im Volume bleiben)
#    ./install.sh help             diese Hilfe
#
#  Optionen:
#    --yes             keine Rückfragen (Werte aus Umgebung bzw. gespeicherter Konfiguration)
#    --dry-run         nichts verändern, nur anzeigen
#    --domain DOMAIN   Adresse des Panels (Standard: security.vylaris.it)
#    --tunnel NAME     Name des Tunnels (Standard: vylarissecurity)
#    --dns-ip IP       Adresse, an die der DNS-Server Port 53 bindet (Standard: alle bzw. automatisch)
#    --ns1 NAME --ns2 NAME   Namen der Nameserver (Standard: ns1.vylaris.it, ns2.vylaris.it)
#    --server-domain D Domain für Server-Namen (Standard: server.vylaris.it)
#    --no-cloudflare   ohne Cloudflare Tunnel: Panel nur auf 127.0.0.1:8080, Proxy auf 127.0.0.1:8081
#    --no-backup       (bei --update) keine Sicherung vorher
#    --force           (bei --update) trotz lokaler Änderungen weitermachen
#
#  Umgebungsvariablen (statt Eingabe, z. B. für Automatisierung):
#    CLOUDFLARE_API_TOKEN  CLOUDFLARE_ACCOUNT_ID  SITE_DOMAIN  TUNNEL_NAME  DNS_BIND_IP
#    VS_DIR (Zielordner bei der Erstinstallation per curl, Standard /opt/vylaris-security)
#    VS_REPO (Git-Adresse), VS_BRANCH (Branch)
# =============================================================================
set -uo pipefail

REPO_URL="${VS_REPO:-https://github.com/PwiePixel/VylarisSecurity.git}"
BRANCH_OPT="${VS_BRANCH:-}"
SRC="${BASH_SOURCE[0]:-}"
ROOT=""
if [ -n "$SRC" ] && [ -f "$SRC" ]; then ROOT="$(cd "$(dirname "$SRC")" && pwd)"; fi
ENV_FILE="$ROOT/.env.local"          # Einstellungen + API-Token (nur für dieses Skript und Compose-Platzhalter)
TUNNEL_ENV="$ROOT/.env.tunnel"       # nur der Tunnel-Token (cloudflared)
APP_ENV="$ROOT/.env.app"             # Einrichtungs-Schlüssel für den Admin-Zugang (nur bis zur Einrichtung)
WORKER_ENV="$ROOT/.env.worker"       # Cloudflare-Token, Tunnel-ID, Proxmox-Geheimnis (nur der Worker liest sie)
BACKUP_DIR="$ROOT/backups"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
API="${API%/}"
DEFAULT_DOMAIN="security.vylaris.it"
DEFAULT_TUNNEL="vylarissecurity"
DEFAULT_NS1="ns1.vylaris.it"
DEFAULT_NS2="ns2.vylaris.it"
DEFAULT_SERVER_DOMAIN="server.vylaris.it"
IMAGE="vylarissecurity"
DATA_VOLUME="vylarissecurity-data"
RUNTIME_VOLUME="vylarissecurity-runtime"
PANEL_ORIGIN="http://web:8080"        # Ziele im Container-Netz (siehe compose.yaml)
PROXY_ORIGIN="http://proxy:8081"

YES=0; DRY=0; CMD="setup"; CHECK_ONLY=0; SKIP_PULL=0; NO_BACKUP=0; FORCE=0
OPT_DOMAIN=""; OPT_TUNNEL=""; OPT_DNS_IP=""; OPT_NS1=""; OPT_NS2=""; OPT_SERVER_DOMAIN=""; OPT_NO_CF=0
CMD_ARGS=()
DOCKER=(docker)

# ---------------------------------------------------------------- Ausgabe ----
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; C=$'\033[36m'; Z=$'\033[0m'
else
  B=""; D=""; G=""; R=""; Y=""; C=""; Z=""
fi
info() { printf '%s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$Z" "$*"; }
bad()  { printf '  %s✘%s %s\n' "$R" "$Z" "$*"; }
die()  { printf '\n'; bad "$*"; exit 1; }
step() { printf '\n%s[%s/%s] %s%s\n%s\n' "$B$C" "$1" "$2" "$3" "$Z" "$D────────────────────────────────────────────────────────────────$Z"; }
trap 'printf "\nAbgebrochen.\n"; exit 130' INT

# ----------------------------------------------------------------- Eingabe ----
ask() {   # ask VAR "Frage" [Standard]
  local __var="$1" __q="$2" __def="${3:-}" __val=""
  if [ "$YES" = 1 ]; then printf -v "$__var" '%s' "$__def"; return; fi
  if [ -n "$__def" ]; then read -r -p "  $__q [$__def]: " __val || die "Keine Eingabe möglich (stdin geschlossen). Nutze --yes mit Umgebungsvariablen."
  else read -r -p "  $__q: " __val || die "Keine Eingabe möglich (stdin geschlossen)."; fi
  printf -v "$__var" '%s' "${__val:-$__def}"
}
ask_secret() {   # Eingabe bleibt unsichtbar
  local __var="$1" __q="$2" __val=""
  if [ -t 0 ]; then read -r -s -p "  $__q: " __val || die "Keine Eingabe möglich."; printf '\n'
  else read -r __val || die "Keine Eingabe möglich (stdin geschlossen)."; fi
  printf -v "$__var" '%s' "$__val"
}
confirm() {   # confirm "Frage" [j|n]  – Rückgabe 0 = Ja
  local q="$1" def="${2:-j}" hint="J/n" val=""
  [ "$def" = n ] && hint="j/N"
  if [ "$YES" = 1 ]; then [ "$def" = j ]; return; fi
  read -r -p "  $q [$hint]: " val || die "Keine Eingabe möglich (stdin geschlossen)."
  val="$(printf '%s' "$val" | tr '[:upper:]' '[:lower:]')"; [ -z "$val" ] && val="$def"
  case "$val" in j|ja|y|yes) return 0 ;; *) return 1 ;; esac
}
mask() { local t="$1"; if [ "${#t}" -gt 8 ]; then printf '••••••••%s' "${t: -4}"; else printf '••••'; fi; }

# --------------------------------------------------------------- Konfiguration
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
SITE_DOMAIN="${SITE_DOMAIN:-}"
TUNNEL_NAME="${TUNNEL_NAME:-}"
TUNNEL_ID="${TUNNEL_ID:-}"
DNS_BIND_IP="${DNS_BIND_IP:-}"
USE_CLOUDFLARE="${USE_CLOUDFLARE:-}"
NS1_NAME="${NS1_NAME:-}"
NS2_NAME="${NS2_NAME:-}"
SERVER_DOMAIN="${SERVER_DOMAIN:-}"
GIT_BRANCH_SAVED=""
TUNNEL_TOKEN=""

# Liest .env.local ohne es auszuführen; Umgebungsvariablen haben Vorrang. Unbekannte Schlüssel bleiben unberührt.
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    case "$k" in
      CLOUDFLARE_API_TOKEN)  [ -z "$CLOUDFLARE_API_TOKEN" ]  && CLOUDFLARE_API_TOKEN="$v" ;;
      CLOUDFLARE_ACCOUNT_ID) [ -z "$CLOUDFLARE_ACCOUNT_ID" ] && CLOUDFLARE_ACCOUNT_ID="$v" ;;
      SITE_DOMAIN)           [ -z "$SITE_DOMAIN" ]           && SITE_DOMAIN="$v" ;;
      TUNNEL_NAME)           [ -z "$TUNNEL_NAME" ]           && TUNNEL_NAME="$v" ;;
      TUNNEL_ID)             [ -z "$TUNNEL_ID" ]             && TUNNEL_ID="$v" ;;
      DNS_BIND_IP)           [ -z "$DNS_BIND_IP" ]           && DNS_BIND_IP="$v" ;;
      USE_CLOUDFLARE)        [ -z "$USE_CLOUDFLARE" ]        && USE_CLOUDFLARE="$v" ;;
      NS1_NAME)              [ -z "$NS1_NAME" ]              && NS1_NAME="$v" ;;
      NS2_NAME)              [ -z "$NS2_NAME" ]              && NS2_NAME="$v" ;;
      SERVER_DOMAIN)         [ -z "$SERVER_DOMAIN" ]         && SERVER_DOMAIN="$v" ;;
      GIT_BRANCH)            GIT_BRANCH_SAVED="$v" ;;
    esac
  done < "$ENV_FILE"
}
apply_defaults() {
  [ -n "$OPT_DOMAIN" ] && SITE_DOMAIN="$OPT_DOMAIN"
  [ -n "$OPT_TUNNEL" ] && TUNNEL_NAME="$OPT_TUNNEL"
  [ -n "$OPT_DNS_IP" ] && DNS_BIND_IP="$OPT_DNS_IP"
  [ -n "$OPT_NS1" ] && NS1_NAME="$OPT_NS1"
  [ -n "$OPT_NS2" ] && NS2_NAME="$OPT_NS2"
  [ -n "$OPT_SERVER_DOMAIN" ] && SERVER_DOMAIN="$OPT_SERVER_DOMAIN"
  [ "$OPT_NO_CF" = 1 ] && USE_CLOUDFLARE=0
  [ -z "$SITE_DOMAIN" ] && SITE_DOMAIN="$DEFAULT_DOMAIN"
  [ -z "$TUNNEL_NAME" ] && TUNNEL_NAME="$DEFAULT_TUNNEL"
  [ -z "$NS1_NAME" ] && NS1_NAME="$DEFAULT_NS1"
  [ -z "$NS2_NAME" ] && NS2_NAME="$DEFAULT_NS2"
  [ -z "$SERVER_DOMAIN" ] && SERVER_DOMAIN="$DEFAULT_SERVER_DOMAIN"
  [ -z "$USE_CLOUDFLARE" ] && USE_CLOUDFLARE=1
  return 0
}
save_env() {
  local branch="${BRANCH_OPT:-$GIT_BRANCH_SAVED}"
  ( umask 077
    { echo "# VylarisSecurity – lokale Einstellungen und Zugangsdaten. NICHT ins Repository committen, NICHT weitergeben."
      echo "# Erzeugt von install.sh und bei Updates unverändert beibehalten. Löschen mit: ./install.sh forget"
      echo "CLOUDFLARE_API_TOKEN=\"$CLOUDFLARE_API_TOKEN\""
      echo "CLOUDFLARE_ACCOUNT_ID=\"$CLOUDFLARE_ACCOUNT_ID\""
      echo "SITE_DOMAIN=\"$SITE_DOMAIN\""
      echo "SITE_URL=\"https://$SITE_DOMAIN\""
      echo "TUNNEL_NAME=\"$TUNNEL_NAME\""
      [ -n "$TUNNEL_ID" ] && echo "TUNNEL_ID=\"$TUNNEL_ID\""
      echo "USE_CLOUDFLARE=\"$USE_CLOUDFLARE\""
      echo "DNS_BIND_IP=\"${DNS_BIND_IP:-0.0.0.0}\""
      echo "NS1_NAME=\"$NS1_NAME\""
      echo "NS2_NAME=\"$NS2_NAME\""
      echo "SERVER_DOMAIN=\"$SERVER_DOMAIN\""
      [ -n "$branch" ] && echo "GIT_BRANCH=\"$branch\""
      return 0
    } > "$ENV_FILE" )
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}
save_tunnel_env() {   # nur der Tunnel-Token – der cloudflared-Container bekommt NICHT den API-Token
  ( umask 077; printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" > "$TUNNEL_ENV" )
  chmod 600 "$TUNNEL_ENV" 2>/dev/null || true
}
# .env.worker: Cloudflare-Zugang des Workers. Das Proxmox-Geheimnis (und alles Unbekannte) bleibt erhalten.
worker_env_get() { [ -f "$WORKER_ENV" ] && sed -n "s/^$1=//p" "$WORKER_ENV" | tail -n1; return 0; }
write_worker_env() {
  local pm; pm="$(worker_env_get PROXMOX_TOKEN_SECRET)"; [ -n "${1:-}" ] && pm="$1"
  ( umask 077
    { echo "# VylarisSecurity – Zugang des Workers (Cloudflare-Abgleich, Proxmox). Nur der Worker-Container liest diese Datei."
      echo "CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN"
      echo "CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID"
      echo "CF_TUNNEL_ID=$TUNNEL_ID"
      [ -n "$pm" ] && echo "PROXMOX_TOKEN_SECRET=$pm"
      return 0
    } > "$WORKER_ENV" )
  chmod 600 "$WORKER_ENV" 2>/dev/null || true
}
ensure_gitignore() {
  [ -n "$ROOT" ] || return 0
  local gi="$ROOT/.gitignore" added="" w
  touch "$gi"
  for w in ".env.local" ".env.tunnel" ".env.app" ".env.worker" ".env" "backups/" "out/" ".next/" "node_modules/" ".data/"; do
    grep -qxF "$w" "$gi" || { printf '%s\n' "$w" >> "$gi"; added="$added $w"; }
  done
  [ -n "$added" ] && ok ".gitignore ergänzt:$added"
  return 0
}

# ------------------------------------------------------------ Cloudflare-API ---
# Der Token wird NIE als Argument übergeben (sonst in der Prozessliste sichtbar),
# sondern als curl-Konfiguration über stdin.
CF_BODY=""; CF_CODE=""
cf() {   # cf METHOD PFAD [JSON]  ->  CF_BODY, CF_CODE
  local method="$1" path="$2" data="${3:-}" resp
  local -a args=(-sS --max-time 30 -X "$method" -H "Content-Type: application/json" -H "User-Agent: vylarissecurity-installer/1.0")
  [ -n "$data" ] && args+=(--data "$data")
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" \
          | curl -K - "${args[@]}" -w $'\n%{http_code}' "$API$path" 2>&1)" || {
    die "Keine Verbindung zu Cloudflare. Internetverbindung prüfen. ($(printf '%s' "$resp" | head -n1))"
  }
  CF_CODE="${resp##*$'\n'}"; CF_BODY="${resp%$'\n'*}"
}
cf_ok() { { [ "$CF_CODE" = 200 ] || [ "$CF_CODE" = 201 ]; } && [ "$(printf '%s' "$CF_BODY" | jget success)" = true ]; }
cf_denied() { [ "$CF_CODE" = 401 ] || [ "$CF_CODE" = 403 ]; }

JSON_TOOL=""
jget() {   # liest JSON von stdin, gibt einen Wert aus (z. B. "result.0.id"); leer, wenn nicht vorhanden
  if [ "$JSON_TOOL" = python3 ]; then
    python3 -c '
import sys, json
try:
    v = json.load(sys.stdin)
    for k in sys.argv[1].split("."):
        if v is None: break
        v = v[int(k)] if isinstance(v, list) else v.get(k)
    if v is None: out = ""
    elif isinstance(v, bool): out = "true" if v else "false"
    elif isinstance(v, (dict, list)): out = json.dumps(v)
    else: out = str(v)
    sys.stdout.write(out)
except Exception:
    pass' "$1"
  else
    node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);
        for(const k of process.argv[1].split(".")){ if(v==null)break; v=v[k]; }
        process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)));}catch{}})' "$1"
  fi
}
cf_errors() {   # lesbare Fehlermeldung aus CF_BODY
  if [ "$JSON_TOOL" = python3 ]; then
    printf '%s' "$CF_BODY" | python3 -c '
import sys, json
try:
    e = json.load(sys.stdin).get("errors") or []
    sys.stdout.write("; ".join("%s (Code %s)" % (x.get("message","?"), x.get("code","?")) for x in e) or "unbekannter Fehler")
except Exception:
    sys.stdout.write("unbekannter Fehler")'
  else
    printf '%s' "$CF_BODY" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const e=(JSON.parse(s).errors||[]).map(x=>`${x.message} (Code ${x.code})`).join("; ");process.stdout.write(e||"unbekannter Fehler")}catch{process.stdout.write("unbekannter Fehler")}})'
  fi
}

# ------------------------------------------------------------------ Texte -----
token_help() {
  cat <<EOF

  ${B}So legst du den Cloudflare-API-Token an${Z} (dauert ca. 2 Minuten):

   1. Öffne ${C}https://dash.cloudflare.com/profile/api-tokens${Z} und melde dich an.
   2. ${B}„Create Token“${Z} → bei „Create Custom Token“ ${B}„Get started“${Z}.
   3. Token-Name: ${B}VylarisSecurity${Z}
   4. Berechtigungen (Permissions) – diese Zeilen hinzufügen:
        ${B}Account${Z} · ${B}Cloudflare Tunnel${Z}        · ${B}Edit${Z}   ${D}← Tunnel anlegen und konfigurieren${Z}
        ${B}Zone${Z}    · ${B}DNS${Z}                      · ${B}Edit${Z}   ${D}← Einträge in Cloudflare-Zonen pflegen${Z}
        ${B}Zone${Z}    · ${B}Zone${Z}                     · ${B}Read${Z}   ${D}← Domains im Konto finden${Z}
        ${B}Zone${Z}    · ${B}SSL and Certificates${Z}     · ${B}Edit${Z}   ${D}← nur für „Cloudflare-Schutz“ (Cloudflare for SaaS), optional${Z}
   5. Account Resources: Include → ${B}dein Account${Z}
      Zone Resources:    Include → ${B}All zones${Z} ${D}(damit das Panel alle Domains der Gruppe verwalten kann)${Z}
   6. Optional, aber empfohlen: bei „TTL“ ein Ablaufdatum setzen.
   7. ${B}„Continue to summary“${Z} → ${B}„Create Token“${Z} und den Token sofort kopieren (wird nur einmal angezeigt).

  ${B}Wo finde ich die Account-ID?${Z}
   Cloudflare-Dashboard → Startseite deines Kontos → rechte Seitenleiste „Account ID“
   (oder in der Adresszeile: dash.cloudflare.com/${B}<ACCOUNT-ID>${Z}/…).

  ${Y}Sicherheit:${Z} Gib den Token niemals in Chats, Tickets oder Commits weiter. Er liegt nur in ${B}.env.local${Z} und
  ${B}.env.worker${Z} (Rechte 600). Das Panel selbst (web) bekommt ihn nicht; der Tunnel läuft mit einem eigenen Token.

EOF
}

# ------------------------------------------------- Selbstinstallation ---------
SUDO=""
detect_sudo() {
  [ "$(id -u)" = 0 ] && return 0
  command -v sudo >/dev/null 2>&1 && SUDO="sudo"
  return 0
}
pkg_install() {   # Systempakete per Paketmanager installieren; Rückgabe 0 = Erfolg
  detect_sudo
  local pkgs="$*" pm=""
  for pm in apt-get dnf yum pacman zypper apk brew; do command -v "$pm" >/dev/null 2>&1 && break || pm=""; done
  [ -n "$pm" ] || return 1
  if [ "$pm" != brew ] && [ "$(id -u)" != 0 ] && [ -z "$SUDO" ]; then return 1; fi
  info "  Installiere $pkgs mit $pm …"
  case "$pm" in
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y -qq $pkgs ;;
    dnf)     $SUDO dnf install -y -q $pkgs ;;
    yum)     $SUDO yum install -y -q $pkgs ;;
    pacman)  $SUDO pacman -S --noconfirm --needed $pkgs ;;
    zypper)  $SUDO zypper --non-interactive install $pkgs ;;
    apk)     $SUDO apk add --no-progress $pkgs ;;
    brew)    brew install $pkgs ;;
  esac
}

# Findet einen nutzbaren Docker-Zugang: direkt oder über sudo. Rückgabe 0 = Docker + Compose bereit
docker_ready() {
  command -v docker >/dev/null 2>&1 || return 1
  if docker info >/dev/null 2>&1; then DOCKER=(docker)
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker)
  else return 2; fi
  "${DOCKER[@]}" compose version >/dev/null 2>&1 || return 3
  return 0
}
# Compose mit den gespeicherten Einstellungen. Der Tunnel gehört zum Profil "cloudflare".
dc() {
  local -a files=(-f "$ROOT/compose.yaml")
  [ "$USE_CLOUDFLARE" = 0 ] && files+=(-f "$ROOT/compose.local.yaml")
  [ -f "$ENV_FILE" ] || ( umask 077; : > "$ENV_FILE" )
  local profile="cloudflare"; [ "$USE_CLOUDFLARE" = 0 ] && profile=""
  COMPOSE_PROFILES="$profile" "${DOCKER[@]}" compose --env-file "$ENV_FILE" "${files[@]}" "$@"
}

install_docker() {
  case "$(uname -s)" in
    Linux) ;;
    Darwin) bad "Bitte Docker Desktop installieren und starten: https://www.docker.com/products/docker-desktop/ – danach ./install.sh erneut ausführen."; return 1 ;;
    *) bad "Dieses Betriebssystem wird nicht unterstützt (Windows: bitte WSL mit Ubuntu verwenden)."; return 1 ;;
  esac
  detect_sudo
  if [ "$(id -u)" != 0 ] && [ -z "$SUDO" ]; then bad "Für die Docker-Installation werden Administrator-Rechte benötigt (sudo fehlt)."; return 1; fi
  local tmp; tmp="$(mktemp -d)" || return 1
  info "  Lade das offizielle Docker-Installationsskript (get.docker.com) …"
  curl -fsSL --max-time 60 https://get.docker.com -o "$tmp/get-docker.sh" || { rm -rf "$tmp"; bad "get.docker.com nicht erreichbar."; return 1; }
  $SUDO sh "$tmp/get-docker.sh" || { rm -rf "$tmp"; bad "Docker-Installation fehlgeschlagen."; return 1; }
  rm -rf "$tmp"
  command -v systemctl >/dev/null 2>&1 && $SUDO systemctl enable --now docker >/dev/null 2>&1
  [ -n "$SUDO" ] && $SUDO usermod -aG docker "${USER:-$(id -un)}" >/dev/null 2>&1 || true
  ok "Docker installiert"
}

TOOLS_OK=0
ensure_tools() {
  [ "$TOOLS_OK" = 1 ] && return 0
  TOOLS_OK=1
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*)
    die "Unter Windows bitte WSL verwenden (PowerShell: wsl --install, danach in Ubuntu ./install.sh ausführen)." ;;
  esac
  # curl
  if command -v curl >/dev/null 2>&1; then ok "curl"
  else
    warn "curl fehlt."
    if [ "$DRY" = 1 ]; then warn "Trockenlauf: würde curl per Paketmanager installieren."
    elif confirm "curl jetzt installieren?" j && pkg_install curl && command -v curl >/dev/null 2>&1; then ok "curl installiert"
    else die "curl konnte nicht installiert werden. Bitte von Hand installieren (z. B. sudo apt install curl)."; fi
  fi
  # JSON-Werkzeug (python3 oder node)
  if command -v python3 >/dev/null 2>&1; then JSON_TOOL=python3; ok "python3 (zum Lesen der API-Antworten und für den DNS-Test)"
  elif command -v node >/dev/null 2>&1; then JSON_TOOL=node; ok "node (zum Lesen der API-Antworten)"
  else
    warn "Weder python3 noch node gefunden (wird zum Lesen der API-Antworten gebraucht)."
    if [ "$DRY" = 1 ]; then warn "Trockenlauf: würde python3 installieren."; JSON_TOOL=python3
    elif confirm "python3 jetzt installieren?" j && pkg_install python3 && command -v python3 >/dev/null 2>&1; then JSON_TOOL=python3; ok "python3 installiert"
    else die "python3 konnte nicht installiert werden. Bitte von Hand installieren."; fi
  fi
  # Docker + Compose
  local rc=0
  if [ "$DRY" = 1 ]; then
    if command -v docker >/dev/null 2>&1; then ok "Docker gefunden"; else warn "Trockenlauf: Docker fehlt – würde über get.docker.com installiert."; fi
    return 0
  fi
  docker_ready || rc=$?
  case "$rc" in
    0) ok "Docker $("${DOCKER[@]}" version --format '{{.Server.Version}}' 2>/dev/null) · Compose $("${DOCKER[@]}" compose version --short 2>/dev/null)" ;;
    2) warn "Docker ist installiert, der Dienst läuft aber nicht (oder dir fehlt die Berechtigung)."
       detect_sudo
       if command -v systemctl >/dev/null 2>&1 && confirm "Docker-Dienst jetzt starten?" j; then $SUDO systemctl enable --now docker >/dev/null 2>&1; sleep 3; fi
       docker_ready || die "Docker ist nicht nutzbar. Prüfen mit:  docker info   (Dienst starten: sudo systemctl start docker)"
       ok "Docker bereit" ;;
    3) warn "Docker Compose (Plugin) fehlt."
       confirm "Docker Compose jetzt installieren?" j && pkg_install docker-compose-plugin
       docker_ready || die "Docker Compose fehlt. Installation: https://docs.docker.com/compose/install/linux/"
       ok "Docker Compose bereit" ;;
    *) warn "Docker ist nicht installiert."
       info "  Der Installer richtet Docker über das offizielle Skript von get.docker.com ein (Administrator-Rechte nötig)."
       confirm "Docker jetzt installieren?" j || die "Ohne Docker kann das System nicht betrieben werden. Abgebrochen."
       install_docker || die "Docker konnte nicht installiert werden: https://docs.docker.com/engine/install/"
       docker_ready || die "Docker ist installiert, aber noch nicht nutzbar. Bitte ab- und wieder anmelden (Gruppe „docker“) und erneut starten."
       ok "Docker $("${DOCKER[@]}" version --format '{{.Server.Version}}' 2>/dev/null) bereit" ;;
  esac
}

need_tools() {
  ensure_tools
  if [ -f "$ROOT/compose.yaml" ] && [ -f "$ROOT/Dockerfile" ]; then ok "compose.yaml und Dockerfile vorhanden"
  else die "compose.yaml/Dockerfile fehlen – bitte im Projektordner ausführen."; fi
}

# ------------------------------------------------ Erstinstallation per curl ----
# Läuft das Skript nicht aus einem Projektordner (curl … | bash), holt es zuerst den Code von GitHub.
bootstrap_if_needed() {
  [ -n "$ROOT" ] && [ -f "$ROOT/compose.yaml" ] && return 0
  printf '\n%sVylarisSecurity – Installer%s\n%sHole den Code von GitHub …%s\n' "$B" "$Z" "$D" "$Z"
  detect_sudo
  local dir="${VS_DIR:-}"
  if [ -z "$dir" ]; then
    if [ "$(id -u)" = 0 ] || [ -n "$SUDO" ]; then dir="/opt/vylaris-security"; else dir="$HOME/vylaris-security"; fi
  fi
  if ! command -v git >/dev/null 2>&1; then
    warn "git fehlt."
    pkg_install git && command -v git >/dev/null 2>&1 || die "git konnte nicht installiert werden. Bitte von Hand installieren (z. B. sudo apt install git)."
    ok "git installiert"
  fi
  if [ -d "$dir/.git" ]; then
    ok "Projekt bereits vorhanden: $dir"
    git -C "$dir" pull --ff-only --quiet 2>/dev/null || warn "git pull nicht möglich – vorhandener Stand wird genutzt."
  else
    if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then die "$dir existiert und ist nicht leer. Anderen Ordner wählen: VS_DIR=/pfad bash install.sh"; fi
    local parent; parent="$(dirname "$dir")"
    if [ ! -w "$parent" ] && [ -n "$SUDO" ]; then $SUDO mkdir -p "$dir" && $SUDO chown "$(id -u):$(id -g)" "$dir"; else mkdir -p "$dir"; fi
    local -a bopt=(); [ -n "$BRANCH_OPT" ] && bopt=(--branch "$BRANCH_OPT")
    git clone --quiet "${bopt[@]}" "$REPO_URL" "$dir" || die "Klonen fehlgeschlagen ($REPO_URL). Internetverbindung und Adresse prüfen."
    ok "Code geladen nach $dir"
  fi
  info "  Starte den Installer aus $dir …"
  if [ -e /dev/tty ] && [ ! -t 0 ]; then exec bash "$dir/install.sh" "$@" </dev/tty; fi
  exec bash "$dir/install.sh" "$@"
}

# ------------------------------------------------------------- Schritte -------
collect_credentials() {
  local tries
  if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    [ "$YES" = 1 ] && die "CLOUDFLARE_API_TOKEN und CLOUDFLARE_ACCOUNT_ID fehlen (Umgebungsvariablen oder .env.local)."
    token_help
  fi
  if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    for tries in 1 2 3; do
      ask_secret CLOUDFLARE_API_TOKEN "API-Token einfügen (Eingabe bleibt unsichtbar)"
      if [ "${#CLOUDFLARE_API_TOKEN}" -ge 20 ] && [[ "$CLOUDFLARE_API_TOKEN" != *" "* ]]; then ok "Token übernommen ($(mask "$CLOUDFLARE_API_TOKEN"))"; break; fi
      bad "Das sieht nicht wie ein Token aus (zu kurz oder Leerzeichen). Bitte erneut einfügen."; CLOUDFLARE_API_TOKEN=""
      [ "$tries" = 3 ] && die "Kein gültiger Token eingegeben."
    done
  else ok "Token gefunden ($(mask "$CLOUDFLARE_API_TOKEN"))"; fi
  if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    for tries in 1 2 3; do
      ask CLOUDFLARE_ACCOUNT_ID "Account-ID (32 Zeichen, siehe Hinweis oben)"
      CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
      if [[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]]; then ok "Account-ID übernommen"; break; fi
      bad "Die Account-ID besteht aus genau 32 Hex-Zeichen (0-9, a-f)."; CLOUDFLARE_ACCOUNT_ID=""
      [ "$tries" = 3 ] && die "Keine gültige Account-ID eingegeben."
    done
  else ok "Account-ID gefunden (${CLOUDFLARE_ACCOUNT_ID:0:6}…)"; fi
}

ZONE_ID=""
find_zone() {   # sucht die Cloudflare-Zone zu SITE_DOMAIN (auch für Subdomains). Rückgabe: 0 gefunden, 2 keine Rechte, 3 nicht im Konto
  local zone="$SITE_DOMAIN"; ZONE_ID=""
  while [[ "$zone" == *.* ]]; do
    cf GET "/zones?name=$zone"
    cf_denied && return 2
    ZONE_ID="$(printf '%s' "$CF_BODY" | jget result.0.id)"
    [ -n "$ZONE_ID" ] && return 0
    zone="${zone#*.}"
  done
  return 3
}

check_token() {   # Rückgabe 0 = Token gültig, Tunnel-Rechte vorhanden
  if [ "$DRY" = 1 ]; then warn "Trockenlauf: Token wird nicht gegen Cloudflare geprüft."; return 0; fi
  local status expires
  cf GET "/user/tokens/verify"
  if [ "$CF_CODE" != 200 ] || [ "$(printf '%s' "$CF_BODY" | jget success)" != true ]; then
    cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify"   # Account-Tokens
    if [ "$CF_CODE" != 200 ] || [ "$(printf '%s' "$CF_BODY" | jget success)" != true ]; then
      bad "Cloudflare lehnt den Token ab: $(cf_errors)"
      cat <<EOF

  Mögliche Ursachen:
   • Token wurde unvollständig kopiert (bitte neu einfügen)
   • Token ist abgelaufen oder wurde in Cloudflare gelöscht
   • Account-ID gehört nicht zu diesem Token
EOF
      return 1
    fi
  fi
  status="$(printf '%s' "$CF_BODY" | jget result.status)"; expires="$(printf '%s' "$CF_BODY" | jget result.expires_on)"
  ok "Token ist gültig (Status: ${status:-active})${expires:+, läuft ab: $expires}"
  cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?is_deleted=false&per_page=1"
  if [ "$CF_CODE" = 200 ]; then ok "Berechtigung „Cloudflare Tunnel“ vorhanden"
  elif cf_denied; then
    bad "Der Token darf keine Tunnel verwalten."
    printf '\n  Behebung: Token in Cloudflare öffnen → Berechtigungen bearbeiten und hinzufügen:\n      %sAccount · Cloudflare Tunnel · Edit%s\n  und prüfen, dass unter „Account Resources“ dein Account ausgewählt ist.\n' "$B" "$Z"
    return 1
  else bad "Unerwartete Antwort von Cloudflare (HTTP $CF_CODE): $(cf_errors)"; return 1; fi
  find_zone; case $? in
    0) ok "Domain $SITE_DOMAIN liegt in deinem Cloudflare-Konto" ;;
    2) warn "Der Token darf keine Zonen/DNS-Einträge lesen (fehlt: „Zone · Zone · Read“, „Zone · DNS · Edit“) – den DNS-Eintrag musst du später von Hand setzen." ;;
    *) warn "Die Domain $SITE_DOMAIN liegt (noch) nicht in diesem Cloudflare-Konto – den DNS-Eintrag für das Panel musst du von Hand setzen (siehe Hinweis am Ende)." ;;
  esac
  return 0
}

# Tunnel anlegen oder wiederverwenden. Route: Panel-Domain -> web, ALLES andere -> proxy (der Proxy wählt nach Hostname).
ensure_tunnel() {
  if [ "$DRY" = 1 ]; then
    warn "Trockenlauf: würde Tunnel „$TUNNEL_NAME“ anlegen, $SITE_DOMAIN → Panel und alles andere → Proxy setzen und .env.tunnel/.env.worker schreiben."
    TUNNEL_ID="00000000-0000-0000-0000-000000000000"; return 0
  fi
  cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false"
  TUNNEL_ID="$(printf '%s' "$CF_BODY" | jget result.0.id)"
  if [ -n "$TUNNEL_ID" ]; then
    ok "Tunnel „$TUNNEL_NAME“ existiert bereits (${TUNNEL_ID:0:8}…)"
    cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token"
    TUNNEL_TOKEN="$(printf '%s' "$CF_BODY" | jget result)"
  else
    cf POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" "{\"name\":\"$TUNNEL_NAME\",\"config_src\":\"cloudflare\"}"
    cf_ok || { bad "Tunnel konnte nicht angelegt werden: $(cf_errors)"; return 1; }
    TUNNEL_ID="$(printf '%s' "$CF_BODY" | jget result.id)"
    TUNNEL_TOKEN="$(printf '%s' "$CF_BODY" | jget result.token)"
    [ -n "$TUNNEL_ID" ] && ok "Tunnel „$TUNNEL_NAME“ angelegt (${TUNNEL_ID:0:8}…)"
  fi
  if [ -z "$TUNNEL_ID" ] || [ -z "$TUNNEL_TOKEN" ]; then bad "Tunnel-ID oder Tunnel-Token fehlen in der Antwort von Cloudflare."; return 1; fi
  cf PUT "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
     "{\"config\":{\"ingress\":[{\"hostname\":\"$SITE_DOMAIN\",\"service\":\"$PANEL_ORIGIN\"},{\"service\":\"$PROXY_ORIGIN\"}]}}"
  cf_ok || { bad "Tunnel-Route konnte nicht gesetzt werden: $(cf_errors)"; return 1; }
  ok "Routen gesetzt: $SITE_DOMAIN → Panel · alle anderen Namen → Proxy (kein Port auf dem Server offen)"
  save_tunnel_env && ok "Tunnel-Token gespeichert in .env.tunnel (Rechte 600)"
}

# CNAME  <domain> -> <tunnel-id>.cfargotunnel.com  (proxied). Rückgabe: 0 ok, 2 keine Rechte, 3 Zone fehlt, 4 Fehler
ensure_dns() {
  local host="$SITE_DOMAIN" target="$TUNNEL_ID.cfargotunnel.com" rid rtype rcontent rc
  if [ "$DRY" = 1 ]; then warn "Trockenlauf: würde CNAME $host → $target anlegen."; return 0; fi
  find_zone; rc=$?; [ "$rc" = 0 ] || return "$rc"
  cf GET "/zones/$ZONE_ID/dns_records?name=$host"
  cf_denied && return 2
  rid="$(printf '%s' "$CF_BODY" | jget result.0.id)"; rtype="$(printf '%s' "$CF_BODY" | jget result.0.type)"; rcontent="$(printf '%s' "$CF_BODY" | jget result.0.content)"
  local body="{\"type\":\"CNAME\",\"name\":\"$host\",\"content\":\"$target\",\"proxied\":true,\"ttl\":1}"
  if [ -n "$rid" ]; then
    if [ "$rtype" = CNAME ] && [ "$rcontent" = "$target" ]; then ok "DNS-Eintrag für $host zeigt bereits auf den Tunnel"; return 0; fi
    warn "Für $host gibt es schon einen Eintrag ($rtype → ${rcontent:-?})."
    confirm "Diesen Eintrag durch CNAME → $target ersetzen?" j || { warn "Eintrag bleibt unverändert – das Panel ist so nicht über den Tunnel erreichbar."; return 4; }
    cf PUT "/zones/$ZONE_ID/dns_records/$rid" "$body"
  else
    cf POST "/zones/$ZONE_ID/dns_records" "$body"
  fi
  if cf_ok; then ok "DNS-Eintrag gesetzt: CNAME $host → $target (über Cloudflare, HTTPS inklusive)"; return 0; fi
  cf_denied && return 2
  bad "DNS-Eintrag konnte nicht gesetzt werden: $(cf_errors)"; return 4
}

dns_manual_help() {
  cat <<EOF

  ${B}DNS-Eintrag für das Panel von Hand anlegen${Z} – ohne ihn bleibt $SITE_DOMAIN unerreichbar:
     Liegt die Domain bei Cloudflare: Dashboard → ${B}$SITE_DOMAIN${Z} → DNS → Records → „Add record“:
       Typ ${B}CNAME${Z} · Name ${B}${SITE_DOMAIN%%.*}${Z} · Ziel ${B}${TUNNEL_ID:-<TUNNEL-ID>}.cfargotunnel.com${Z} · Proxy-Status ${B}Proxied (orange Wolke)${Z}
     Soll die Domain später von unseren eigenen Nameservern beantwortet werden: Domain in Cloudflare behalten
     (z. B. eine eigene Domain nur für Panel und Edge) oder das Panel unter einer Cloudflare-Domain betreiben.
EOF
}
dns_result() {   # wertet den Rückgabecode von ensure_dns aus
  case "$1" in
    0) ;;
    2) warn "Der Token darf keine DNS-Einträge anlegen (fehlt: „Zone · DNS · Edit“ und „Zone · Zone · Read“)."; dns_manual_help ;;
    3) warn "Die Domain $SITE_DOMAIN liegt nicht in diesem Cloudflare-Konto."; dns_manual_help ;;
    *) dns_manual_help ;;
  esac
}

tunnel_status() { cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID"; printf '%s' "$CF_BODY" | jget result.status; }

wait_for_tunnel() {
  local i st=""
  info "  Warte, bis der Tunnel mit Cloudflare verbunden ist (bis zu 90 s) …"
  for i in $(seq 1 18); do
    st="$(tunnel_status)"
    if [ "$st" = healthy ]; then ok "Tunnel ist verbunden (Status: healthy)"; return 0; fi
    sleep 5
  done
  warn "Tunnel meldet noch „${st:-unbekannt}“. Logs ansehen:  ./install.sh logs tunnel"
  return 1
}

check_live() {   # prüft https://<domain>/ – DNS kann einige Minuten brauchen
  local i code=""
  info "  Prüfe https://$SITE_DOMAIN/ …"
  local tries="${VS_LIVE_TRIES:-6}"
  for i in $(seq 1 "$tries"); do
    code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$SITE_DOMAIN/healthz/" 2>/dev/null || true)"
    if [ "$code" = 200 ]; then ok "https://$SITE_DOMAIN/ antwortet mit HTTP 200"; return 0; fi
    [ "$i" -lt "$tries" ] && sleep 8
  done
  warn "https://$SITE_DOMAIN/ ist noch nicht erreichbar (zuletzt: ${code:-keine Antwort}). DNS braucht manchmal einige Minuten – später:  ./install.sh status"
  return 1
}

# ---------------------------------------------------------- DNS-Server (Port 53)
detect_ips() { ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }
port53_listeners() { ss -lntuH 'sport = :53' 2>/dev/null; }

# Ermittelt die Adresse, an die Port 53 gebunden wird. Belegt ein lokaler Resolver (systemd-resolved, 127.0.0.53) den
# Port, wird an eine konkrete Server-Adresse gebunden – der Resolver bleibt dann unangetastet.
choose_dns_bind() {
  local listen
  if [ -n "$DNS_BIND_IP" ] && [ "$DNS_BIND_IP" != "0.0.0.0" ]; then ok "DNS-Server bindet an $DNS_BIND_IP (Port 53)"; return 0; fi
  if ! command -v ss >/dev/null 2>&1; then DNS_BIND_IP="${DNS_BIND_IP:-0.0.0.0}"; info "  (ss nicht gefunden – Port 53 wird nicht vorab geprüft)"; return 0; fi
  # eigene, bereits laufende Container zählen nicht als Konflikt
  listen="$(port53_listeners | grep -v 'docker-proxy' | grep -E '(^|[[:space:]])(0\.0\.0\.0|\*|\[::\]):53' || true)"
  if [ -z "$listen" ]; then DNS_BIND_IP="0.0.0.0"; ok "Port 53 ist frei"; return 0; fi
  warn "Port 53 ist auf allen Adressen belegt:"; printf '%s\n' "$listen" | sed 's/^/      /'
  bad "Ein anderer Dienst (z. B. dnsmasq/bind) belegt Port 53 auf allen Adressen. Bitte beenden oder umkonfigurieren."
  return 1
}
choose_dns_bind_auto() {   # systemd-resolved belegt nur 127.0.0.53 – dann an die Server-Adresse binden
  [ -n "$DNS_BIND_IP" ] && [ "$DNS_BIND_IP" != "0.0.0.0" ] && { ok "DNS-Server bindet an $DNS_BIND_IP (Port 53)"; return 0; }
  command -v ss >/dev/null 2>&1 || { DNS_BIND_IP="${DNS_BIND_IP:-0.0.0.0}"; info "  (ss nicht gefunden – Port 53 wird nicht vorab geprüft; DNS-Server bindet an alle Adressen)"; return 0; }
  local all stub ips
  all="$(port53_listeners | grep -v 'docker-proxy' || true)"
  if [ -z "$all" ]; then DNS_BIND_IP="0.0.0.0"; ok "Port 53 ist frei"; return 0; fi
  if printf '%s\n' "$all" | grep -qE '(^|[[:space:]])(0\.0\.0\.0|\*|\[::\]):53'; then choose_dns_bind; return $?; fi
  stub="$(printf '%s\n' "$all" | awk '{print $5}' | sort -u | tr '\n' ' ')"
  ips="$(detect_ips)"
  if [ "$(printf '%s\n' "$ips" | grep -c .)" -eq 1 ]; then
    DNS_BIND_IP="$ips"
    ok "Ein lokaler Resolver belegt Port 53 auf ${stub}– der DNS-Server bindet deshalb an $DNS_BIND_IP (Resolver bleibt unangetastet)"
    return 0
  fi
  if [ "$YES" = 1 ]; then DNS_BIND_IP="$(printf '%s\n' "$ips" | head -n1)"; ok "DNS-Server bindet an $DNS_BIND_IP (Resolver belegt ${stub})"; return 0; fi
  info "  Ein lokaler Resolver belegt Port 53 auf ${stub}. Der DNS-Server soll an eine konkrete Adresse binden."
  info "  Gefundene Adressen dieses Servers:"; printf '%s\n' "$ips" | sed 's/^/      /'
  ask DNS_BIND_IP "Adresse für den DNS-Server" "$(printf '%s\n' "$ips" | head -n1)"
  return 0
}

# Sendet eine DNS-Anfrage per UDP und TCP an host:53. Jede gültige Antwort (auch REFUSED) gilt als „läuft“.
dns_probe() {   # dns_probe HOST -> gibt "udp=ok tcp=ok" aus; Rückgabe 0 wenn beides
  command -v python3 >/dev/null 2>&1 || { echo "python3 fehlt"; return 2; }
  python3 - "$1" <<'PY'
import socket, struct, sys
host = sys.argv[1]
q = struct.pack(">HHHHHH", 0x5678, 0x0100, 1, 0, 0, 0) + b"\x06health\x05check\x00" + struct.pack(">HH", 16, 1)
udp = tcp = False
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3); s.sendto(q, (host, 53)); d, _ = s.recvfrom(2048); udp = len(d) >= 12 and d[:2] == b"\x56\x78"
except Exception:
    pass
try:
    s = socket.create_connection((host, 53), timeout=3); s.settimeout(3); s.sendall(struct.pack(">H", len(q)) + q); d = s.recv(2048); tcp = len(d) >= 14 and d[2:4] == b"\x56\x78"
except Exception:
    pass
print("udp=%s tcp=%s" % ("ok" if udp else "FEHLT", "ok" if tcp else "FEHLT"))
sys.exit(0 if (udp and tcp) else 1)
PY
}
dns_selftest() {
  local target="${DNS_BIND_IP:-0.0.0.0}" out i
  [ "$target" = "0.0.0.0" ] && target="127.0.0.1"
  for i in 1 2 3 4 5; do
    out="$(dns_probe "$target")" && { ok "DNS-Server antwortet auf $target:53 ($out)"; return 0; }
    sleep 2
  done
  bad "DNS-Server antwortet nicht vollständig auf $target:53 ($out). Logs:  ./install.sh logs dns"
  return 1
}

nameserver_guide() {
  local ip="${DNS_BIND_IP:-}"
  [ -z "$ip" ] || [ "$ip" = "0.0.0.0" ] && ip="$(detect_ips | head -n1)"
  cat <<EOF

  ${B}So machst du aus diesem Server deine Nameserver${Z}
   1. Firewall/Hoster: ${B}Port 53 UDP und TCP${Z} eingehend freigeben (nur das – Panel und Proxy brauchen keine offenen Ports).
   2. Panel → ${B}DNS${Z}: Nameserver ${B}$NS1_NAME${Z}${ip:+ mit der Adresse ${B}$ip${Z}} eintragen und Zonen anlegen.
   3. Beim Registrar der Domain(s) die Nameserver auf ${B}$NS1_NAME${Z} und ${B}$NS2_NAME${Z} stellen. Liegen die Nameserver in einer
      eigenen Domain (z. B. vylaris.it), beim Registrar zusätzlich ${B}Glue-Einträge${Z} anlegen (Nameserver-Name + IP-Adresse).
   4. Für ausfallsichere Namensauflösung einen zweiten Server mit zweiter Adresse für ${B}$NS2_NAME${Z} betreiben
      (zweite Installation; die Zonen im Panel einfach doppelt pflegen oder die Konfiguration kopieren).
   5. Test von außen:  ${D}dig @${ip:-<server-ip>} ${NS1_NAME#*.} NS${Z}   oder   ${B}./install.sh dns-check${Z}
EOF
}

start_stack() {
  if [ "$DRY" = 1 ]; then warn "Trockenlauf: würde 'docker compose up -d --build' ausführen."; return 0; fi
  [ "$USE_CLOUDFLARE" = 0 ] || [ -f "$TUNNEL_ENV" ] || die ".env.tunnel fehlt – bitte zuerst ./install.sh ausführen."
  info "  Baue das Image und starte die Dienste (beim ersten Mal dauert das 2–4 Minuten) …"
  ( cd "$ROOT" && dc up -d --build --remove-orphans ) || { bad "Start fehlgeschlagen. Meldung oben lesen."; return 1; }
  if [ "$USE_CLOUDFLARE" = 0 ]; then ok "Dienste laufen (web, dns, proxy, worker)"; else ok "Dienste laufen (web, dns, proxy, worker, tunnel)"; fi
}

firewall_note() {
  cat <<EOF

  ${B}Offene Ports:${Z} Nur ${B}53/udp und 53/tcp${Z} (DNS-Server). Panel und Proxy erreichen Cloudflare über den ausgehenden Tunnel
  (Port 7844, TCP/UDP) – eingehend muss dafür nichts offen sein. SSH nur aus dem eigenen Netz/VPN erlauben.
  Beispiel (Ubuntu):  ${D}sudo ufw default deny incoming && sudo ufw allow 53 && sudo ufw allow from <dein-netz> to any port 22 && sudo ufw enable${Z}
EOF
}

# Legt Nameserver und Server-Domain im Panel an – nur wenn es noch keine Konfiguration gibt (überschreibt nie etwas).
seed_config() {
  [ "$DRY" = 1 ] && return 0
  local ip="${DNS_BIND_IP:-}"; [ "$ip" = "0.0.0.0" ] && ip="$(detect_ips | head -n1)"
  ( cd "$ROOT" && dc exec -T -e NS1="$NS1_NAME" -e NS2="$NS2_NAME" -e NSIP="$ip" -e SDOM="$SERVER_DOMAIN" web node -e '
const fs=require("fs"),p="/data/";
const w=(f,o)=>{ if(!fs.existsSync(p+f)) { fs.writeFileSync(p+f,JSON.stringify(o,null,2),{mode:0o600}); console.log("angelegt:",f); } };
const ns=[{host:process.env.NS1}]; if(process.env.NSIP) ns[0].ipv4=process.env.NSIP; if(process.env.NS2) ns.push({host:process.env.NS2});
w("dns.json",{version:1,settings:{nameservers:ns},zones:[]});
w("inventory.json",{version:1,settings:{serverDomain:process.env.SDOM},subnets:[],ips:[],servers:[]});
' ) 2>/dev/null | sed 's/^/  ✔ Grundkonfiguration /' || true
}

# ---------------------------------------------------------------- Befehle -----
cmd_setup() {
  local total=8 attempt rc
  printf '\n%sVylarisSecurity – Installer%s\n%sDNS · Proxy · IP-Verwaltung · Cloudflare%s\n' "$B" "$Z" "$D" "$Z"
  [ "$DRY" = 1 ] && warn "TROCKENLAUF – es wird nichts verändert."
  load_env; apply_defaults

  step 1 $total "Voraussetzungen"
  need_tools

  step 2 $total "Einstellungen"
  if [ "$YES" != 1 ]; then
    ask SITE_DOMAIN "Adresse des Panels (Domain)" "$SITE_DOMAIN"
    ask NS1_NAME "Name des ersten Nameservers" "$NS1_NAME"
    ask NS2_NAME "Name des zweiten Nameservers" "$NS2_NAME"
    ask SERVER_DOMAIN "Domain für Server-Namen (z. B. web01.<diese Domain>)" "$SERVER_DOMAIN"
    if [ "$USE_CLOUDFLARE" = 1 ] && ! confirm "Cloudflare Tunnel verwenden (empfohlen: keine offenen Ports für Panel/Proxy)?" j; then USE_CLOUDFLARE=0; fi
  fi
  [ -n "$SITE_DOMAIN" ] || die "Keine Domain angegeben."
  ok "Panel: https://$SITE_DOMAIN/ · Nameserver: $NS1_NAME, $NS2_NAME · Server-Domain: $SERVER_DOMAIN"

  step 3 $total "Cloudflare-Zugang"
  if [ "$USE_CLOUDFLARE" = 1 ]; then
    collect_credentials
    if [ "$YES" != 1 ]; then ask TUNNEL_NAME "Name des Tunnels" "$TUNNEL_NAME"; fi
  else warn "Ohne Cloudflare Tunnel: Panel nur auf 127.0.0.1:8080, Proxy auf 127.0.0.1:8081. Der Worker-Abgleich mit Cloudflare bleibt aus."; fi

  step 4 $total "Token prüfen"
  if [ "$USE_CLOUDFLARE" = 1 ]; then
    for attempt in 1 2; do
      check_token && break
      { [ "$YES" = 1 ] || [ "$attempt" = 2 ]; } && die "Token konnte nicht bestätigt werden."
      confirm "Token neu eingeben?" j || die "Abgebrochen."
      CLOUDFLARE_API_TOKEN=""; collect_credentials
    done
  else info "  (übersprungen)"; fi

  step 5 $total "Sicher speichern und Tunnel einrichten"
  if [ "$DRY" = 1 ]; then warn "Trockenlauf: .env.local wird nicht geschrieben."
  else
    save_env; ok "Einstellungen gespeichert in .env.local (Rechte 600 – nur du kannst sie lesen)"
    ensure_gitignore
  fi
  if [ "$USE_CLOUDFLARE" = 1 ]; then
    ensure_tunnel || die "Tunnel-Einrichtung fehlgeschlagen."
    if [ "$DRY" != 1 ]; then save_env; write_worker_env; ok "Zugang des Workers gespeichert in .env.worker (Rechte 600)"; fi
    ensure_dns; rc=$?; dns_result "$rc"
  fi

  step 6 $total "DNS-Server (Port 53)"
  if [ "$DRY" = 1 ]; then warn "Trockenlauf: Port 53 wird nicht geprüft."
  else choose_dns_bind_auto || die "Port 53 ist belegt. Siehe Meldung oben."; save_env; fi

  step 7 $total "Starten"
  start_stack || exit 1
  if [ "$DRY" != 1 ]; then
    wait_web_healthy || warn "Das Panel meldet sich noch nicht – Logs:  ./install.sh logs web"
    seed_config
    dns_selftest || true
  fi

  step 8 $total "Prüfen"
  if [ "$DRY" != 1 ]; then
    if [ "$USE_CLOUDFLARE" = 1 ]; then wait_for_tunnel || true; check_live || true; fi
    firewall_note
    nameserver_guide
    if [ "$YES" != 1 ]; then
      if confirm "Admin-Zugang für das Panel jetzt einrichten?" j; then issue_setup_token && show_setup_token
      else info "  Später einrichten mit:  ./install.sh admin"; fi
    fi
  fi

  local url="https://$SITE_DOMAIN/"; [ "$USE_CLOUDFLARE" = 0 ] && url="http://127.0.0.1:8080/"
  cat <<EOF

${B}${G}Fertig.${Z}

  Panel:     ${B}${url}admin/${Z}
  Nächste Schritte:
   • Update auf die neueste Version:        ${B}./install.sh --update${Z}   ${D}(Daten und Einstellungen bleiben erhalten)${Z}
   • Status anzeigen:                        ${B}./install.sh status${Z}
   • Logs ansehen:                           ${B}./install.sh logs [web|dns|proxy|worker|tunnel]${Z}
   • Admin-Zugang einrichten/zurücksetzen:   ${B}./install.sh admin${Z} / ${B}admin-reset${Z}
   • Proxmox für Traffic anbinden:           ${B}./install.sh proxmox${Z}
EOF
}

# ---------------------------------------------------------------- Sicherung ----
backup_data() {   # sichert beide Volumes und alle .env-Dateien nach backups/
  local stamp tmp f
  stamp="$(date +%Y%m%d-%H%M%S)"
  "${DOCKER[@]}" volume inspect "$DATA_VOLUME" >/dev/null 2>&1 || { info "  (Noch kein Daten-Volume – nichts zu sichern.)"; return 0; }
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  # Das Image des Projekts enthält ein tar (busybox); es ist ohnehin vorhanden. Sonst alpine.
  local img="$IMAGE:latest"; "${DOCKER[@]}" image inspect "$img" >/dev/null 2>&1 || img="alpine:3"
  if ! "${DOCKER[@]}" run --rm -u 0 --entrypoint tar -v "$DATA_VOLUME":/data:ro -v "$BACKUP_DIR":/backup "$img" czf "/backup/data-$stamp.tgz" -C /data . 2>/dev/null; then
    bad "Sicherung der Daten fehlgeschlagen."; return 1
  fi
  tmp="$(mktemp -d)"; for f in .env.local .env.tunnel .env.app .env.worker; do [ -f "$ROOT/$f" ] && cp -p "$ROOT/$f" "$tmp/"; done
  ( umask 077; tar czf "$BACKUP_DIR/env-$stamp.tgz" -C "$tmp" . 2>/dev/null ); rm -rf "$tmp"
  chmod 600 "$BACKUP_DIR"/*-"$stamp".tgz 2>/dev/null || true
  ok "Sicherung angelegt: backups/data-$stamp.tgz (+ env-$stamp.tgz mit den Zugangsdaten – sicher aufbewahren)"
  # nur die letzten 10 behalten
  ls -1t "$BACKUP_DIR"/data-*.tgz 2>/dev/null | tail -n +11 | while read -r old; do rm -f "$old" "${old/data-/env-}"; done
  return 0
}
cmd_backup() { load_env; apply_defaults; printf '\n%sSicherung%s\n' "$B" "$Z"; ensure_tools; backup_data; }

cmd_restore() {
  local file="${CMD_ARGS[0]:-}"
  load_env; apply_defaults; printf '\n%sWiederherstellen%s\n' "$B" "$Z"; ensure_tools
  [ -n "$file" ] || { info "  Verfügbare Sicherungen:"; ls -1t "$BACKUP_DIR"/data-*.tgz 2>/dev/null | sed 's/^/    /' || true; die "Aufruf: ./install.sh restore backups/data-DATUM.tgz"; }
  if [ ! -f "$file" ] && [ -f "$BACKUP_DIR/$file" ]; then file="$BACKUP_DIR/$file"; fi
  [ -f "$file" ] || die "Datei nicht gefunden: $file"
  warn "Der aktuelle Inhalt des Daten-Volumes wird durch die Sicherung ersetzt (vorher wird eine neue Sicherung angelegt)."
  confirm "Wirklich wiederherstellen?" n || die "Abgebrochen."
  [ "$DRY" = 1 ] && { warn "Trockenlauf: nichts verändert."; return 0; }
  backup_data || die "Die Vorab-Sicherung ist fehlgeschlagen – Abbruch."
  ( cd "$ROOT" && dc stop web dns proxy worker ) >/dev/null 2>&1
  local img="$IMAGE:latest"; "${DOCKER[@]}" image inspect "$img" >/dev/null 2>&1 || img="alpine:3"
  "${DOCKER[@]}" run --rm -u 0 --entrypoint sh -v "$DATA_VOLUME":/data -v "$(cd "$(dirname "$file")" && pwd)":/backup:ro "$img" -c "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar xzf /backup/$(basename "$file") -C /data && chown -R 1000:1000 /data" || die "Wiederherstellen fehlgeschlagen. Die Vorab-Sicherung liegt in backups/."
  ( cd "$ROOT" && dc up -d ) >/dev/null 2>&1
  ok "Wiederhergestellt aus $(basename "$file")"
}

# ---------------------------------------------------------------- Update ----
wait_healthy() {   # wait_healthy DIENST [Sekunden] – wartet auf einen gesunden Container
  local svc="$1" max="${2:-90}" cid st="" i
  cid="$( cd "$ROOT" && dc ps -q "$svc" 2>/dev/null | head -n1 )"
  [ -n "$cid" ] || return 1
  for i in $(seq 1 $((max / 3))); do
    st="$("${DOCKER[@]}" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null)"
    case "$st" in healthy|running) return 0 ;; unhealthy|exited|dead) return 1 ;; esac
    sleep 3
  done
  return 1
}
wait_web_healthy() { wait_healthy web 90; }

# Ergänzt Dateien/Einstellungen, die ältere Installationen noch nicht hatten – ohne etwas zu überschreiben oder nachzufragen.
migrate_config() {
  local changed=0
  if [ -f "$ENV_FILE" ] && ! grep -q '^SITE_URL=' "$ENV_FILE"; then save_env; changed=1; fi
  if [ ! -f "$WORKER_ENV" ] && [ -n "$CLOUDFLARE_API_TOKEN" ] && [ "$USE_CLOUDFLARE" = 1 ]; then write_worker_env; ok ".env.worker aus den gespeicherten Zugangsdaten angelegt"; changed=1; fi
  [ "$changed" = 1 ] && info "  Konfiguration ergänzt (vorhandene Werte unverändert)."
  return 0
}

cmd_update() {
  local before after upstream sum_before sum_after dirty branch
  local behind=0
  load_env; apply_defaults
  printf '\n%sUpdate%s\n' "$B" "$Z"
  [ -f "$ENV_FILE" ] || die "Noch keine Installation gefunden (.env.local fehlt). Bitte zuerst ausführen:  ./install.sh"
  if ! command -v git >/dev/null 2>&1; then
    warn "git fehlt."
    if [ "$DRY" = 1 ] || [ "$CHECK_ONLY" = 1 ]; then die "git wird für das Update benötigt."; fi
    confirm "git jetzt installieren?" j && pkg_install git && command -v git >/dev/null 2>&1 || die "git konnte nicht installiert werden. Bitte von Hand installieren."
  fi
  [ -d "$ROOT/.git" ] || die "Dies ist kein Git-Klon. Für Updates das Projekt mit „git clone $REPO_URL“ holen."
  cd "$ROOT" || die "Projektordner nicht erreichbar."
  before="$(git rev-parse --short HEAD)"
  branch="${BRANCH_OPT:-$GIT_BRANCH_SAVED}"

  # --- 1) Neue Version aus Git holen ---
  if [ "$SKIP_PULL" != 1 ]; then
    info "  Suche nach Updates …"
    [ -n "$branch" ] && git checkout --quiet "$branch" 2>/dev/null
    git fetch --quiet 2>/dev/null || die "Git-Server nicht erreichbar (git fetch fehlgeschlagen). Internetverbindung prüfen."
    upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || upstream="origin/$(git rev-parse --abbrev-ref HEAD)"
    git rev-parse --verify --quiet "$upstream" >/dev/null || die "Kein Upstream-Branch gefunden ($upstream)."
    behind="$(git rev-list --count "HEAD..$upstream")"
    if [ "$behind" -gt 0 ]; then
      ok "$behind neue Änderung(en) verfügbar:"
      git log --no-merges --pretty='      %C(yellow)%h%C(reset) %s' --abbrev-commit -n 12 "HEAD..$upstream"
      [ "$behind" -gt 12 ] && info "      … und weitere"
    else
      ok "Der Code ist bereits aktuell ($before)."
    fi
    if [ "$CHECK_ONLY" = 1 ]; then
      if [ "$behind" -gt 0 ]; then info "  Zum Installieren:  ./install.sh --update"; exit 10; fi
      info "  Die Basis-Images (node, cloudflared) werden bei jedem „./install.sh --update“ auf Sicherheitsupdates geprüft."
      exit 0
    fi
    if [ "$DRY" = 1 ]; then warn "Trockenlauf: würde ${behind:-0} Änderung(en) holen, sichern, Images erneuern und neu starten."; return 0; fi
    if [ "$behind" -gt 0 ]; then
      dirty="$(git status --porcelain --untracked-files=no)"
      if [ -n "$dirty" ]; then
        warn "Es gibt lokale, nicht gespeicherte Änderungen an Projektdateien:"
        printf '%s\n' "$dirty" | sed 's/^/      /'
        if [ "$FORCE" != 1 ]; then confirm "Update trotzdem versuchen? (bricht bei Konflikten ab, nichts geht verloren)" n || die "Abgebrochen. Änderungen zuerst sichern (git stash) oder --force nutzen."; fi
      fi
      confirm "Update jetzt installieren?" j || die "Abgebrochen."
      ensure_tools
      [ "$NO_BACKUP" = 1 ] || backup_data || { confirm "Die Sicherung ist fehlgeschlagen. Trotzdem weitermachen?" n || die "Abgebrochen."; }
      sum_before="$(sha256sum "$ROOT/install.sh" 2>/dev/null | cut -d' ' -f1)"
      git pull --ff-only --quiet || die "Update nicht möglich (lokaler Stand weicht ab). Bitte prüfen: git status"
      after="$(git rev-parse --short HEAD)"
      ok "Code aktualisiert: $before → $after"
      sum_after="$(sha256sum "$ROOT/install.sh" 2>/dev/null | cut -d' ' -f1)"
      if [ -n "$sum_before" ] && [ "$sum_before" != "$sum_after" ]; then
        info "  Der Installer selbst wurde aktualisiert – starte mit der neuen Version neu …"
        local -a again=(update --skip-pull --no-backup); [ "$YES" = 1 ] && again+=(--yes)
        exec "$ROOT/install.sh" "${again[@]}"
      fi
    fi
  fi

  # --- 2) Dienste erneuern (Daten-Volumes und .env-Dateien bleiben unberührt) ---
  ensure_tools
  if [ "$behind" = 0 ] && [ "$SKIP_PULL" != 1 ] && [ "$NO_BACKUP" != 1 ]; then backup_data || true; fi
  migrate_config
  [ "$USE_CLOUDFLARE" = 0 ] || [ -f "$TUNNEL_ENV" ] || die ".env.tunnel fehlt – bitte zuerst ./install.sh ausführen."
  local prev=""
  prev="$("${DOCKER[@]}" image inspect -f '{{.Id}}' "$IMAGE:latest" 2>/dev/null)" || prev=""
  [ -n "$prev" ] && "${DOCKER[@]}" tag "$prev" "$IMAGE:previous" >/dev/null 2>&1 && ok "Aktueller Stand als Rückfallstand gesichert ($IMAGE:previous)"

  info "  Lade aktuelle Basis-Images und baue neu (2–4 Minuten) …"
  ( dc pull tunnel ) >/dev/null 2>&1 && ok "cloudflared auf neuestem Stand" || warn "cloudflared-Image konnte nicht erneuert werden (weiter mit vorhandenem)."
  if ! ( dc build --pull web ); then
    bad "Der Build ist fehlgeschlagen – die laufenden Dienste bleiben unverändert."; return 1
  fi
  ( dc up -d --remove-orphans ) || { bad "Start fehlgeschlagen."; return 1; }

  # --- 3) Prüfen, bei Problemen zurückrollen ---
  local svc failed=""
  for svc in web dns proxy worker; do wait_healthy "$svc" 90 || failed="$failed $svc"; done
  if [ -z "$failed" ]; then
    ok "Neue Version läuft und alle Dienste sind gesund"
  else
    bad "Nicht gesund:$failed"
    if [ -n "$prev" ]; then
      warn "Rolle auf den vorherigen Stand zurück …"
      "${DOCKER[@]}" tag "$IMAGE:previous" "$IMAGE:latest" >/dev/null 2>&1
      ( dc up -d --no-build --force-recreate web dns proxy worker ) >/dev/null 2>&1
      if wait_healthy web 60; then ok "Vorherige Version läuft wieder."; else bad "Auch der vorherige Stand startet nicht. Logs:  ./install.sh logs"; fi
    fi
    info "  Der Code bleibt auf $(git rev-parse --short HEAD). Zurücksetzen mit:  git reset --hard $before"
    info "  Deine Daten sind unverändert; Sicherungen liegen in backups/."
    return 1
  fi
  dns_selftest || true
  if [ "$USE_CLOUDFLARE" = 1 ] && [ -n "$TUNNEL_ID" ] && [ -n "$CLOUDFLARE_API_TOKEN" ] && [ -n "$CLOUDFLARE_ACCOUNT_ID" ]; then wait_for_tunnel || true
  else info "  (Tunnel-Status wird nicht geprüft.)"; fi
  [ "$USE_CLOUDFLARE" = 1 ] && { check_live || true; }
  "${DOCKER[@]}" image prune -f >/dev/null 2>&1 && ok "Alte, nicht mehr genutzte Images entfernt"

  printf '\n%s%sUpdate abgeschlossen.%s  Version: %s%s%s\n' "$B" "$G" "$Z" "$B" "$(git rev-parse --short HEAD)" "$Z"
}

# ---------------------------------------------------------------- Admin ------
SETUP_TOKEN=""
gen_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24
  else head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
web_running() { [ -n "$( cd "$ROOT" && dc ps -q web 2>/dev/null | head -n1 )" ]; }
admin_exists() { ( cd "$ROOT" && dc exec -T web test -f /data/admin.json ) >/dev/null 2>&1; }

# Erzeugt einen frischen Einrichtungs-Schlüssel und startet das Panel neu, damit er greift
issue_setup_token() {
  SETUP_TOKEN="$(gen_token)"
  # Der Schlüssel gilt nur eine Stunde (Unix-Zeit); danach ignoriert ihn das Panel
  ( umask 077; printf 'ADMIN_SETUP_TOKEN=%s\nADMIN_SETUP_EXPIRES=%s\n' "$SETUP_TOKEN" "$(( $(date +%s) + 3600 ))" > "$APP_ENV" ); chmod 600 "$APP_ENV" 2>/dev/null || true
  ( cd "$ROOT" && dc up -d --force-recreate web ) >/dev/null 2>&1 || { bad "Das Panel konnte nicht neu gestartet werden."; return 1; }
  wait_web_healthy || { bad "Das Panel wird nach dem Neustart nicht gesund. Logs:  ./install.sh logs web"; return 1; }
}
# Entfernt einen übrig gebliebenen Einrichtungs-Schlüssel (nach erfolgter Einrichtung)
clear_setup_token() {
  [ -f "$APP_ENV" ] || return 0
  rm -f "$APP_ENV"
  ( cd "$ROOT" && dc up -d --force-recreate web ) >/dev/null 2>&1 || true
  wait_web_healthy || true
  ok "Der Einrichtungs-Schlüssel wurde entfernt."
}
panel_url() { if [ "$USE_CLOUDFLARE" = 0 ]; then printf 'http://127.0.0.1:8080'; else printf 'https://%s' "$SITE_DOMAIN"; fi; }
show_setup_token() {
  cat <<EOF

  ${B}Admin-Zugang einrichten${Z}
   1. Öffne:  ${B}$(panel_url)/admin/setup/${Z}
   2. Einrichtungs-Schlüssel (gilt 1 Stunde, nur jetzt sichtbar, nicht weitergeben):

        ${B}$SETUP_TOKEN${Z}

   3. Benutzername und ein langes Passwort wählen. Danach ist die Einrichtungsseite dauerhaft gesperrt.
   4. Im Panel unter „Sicherheit“ die Zwei-Faktor-Anmeldung aktivieren (dringend empfohlen).

   Der Schlüssel liegt nur in ${B}.env.app${Z} (Rechte 600), läuft nach einer Stunde ab und wird nach der
   Einrichtung beim nächsten ${B}./install.sh admin${Z} automatisch entfernt.
EOF
}

cmd_admin() {
  load_env; apply_defaults; printf '\n%sAdmin-Zugang%s\n' "$B" "$Z"
  ensure_tools
  web_running || die "Das Panel läuft nicht. Bitte zuerst ./install.sh ausführen."
  if admin_exists; then
    ok "Der Admin-Zugang ist bereits eingerichtet:  $(panel_url)/admin/login/"
    clear_setup_token
    info "  Passwort vergessen oder Zugang verloren?  ./install.sh admin-reset"
    return 0
  fi
  if [ "$DRY" = 1 ]; then warn "Trockenlauf: würde einen Einrichtungs-Schlüssel erzeugen und das Panel neu starten."; return 0; fi
  issue_setup_token || return 1
  show_setup_token
}

cmd_admin_reset() {
  load_env; apply_defaults; printf '\n%sAdmin-Zugang zurücksetzen%s\n' "$B" "$Z"
  ensure_tools
  web_running || die "Das Panel läuft nicht. Bitte zuerst ./install.sh ausführen."
  warn "Der bestehende Admin-Zugang (Passwort, Zwei-Faktor, alle Sitzungen) wird gelöscht. Zonen, Server, Proxy-Routen und Protokoll bleiben erhalten."
  confirm "Wirklich zurücksetzen?" n || die "Abgebrochen."
  [ "$DRY" = 1 ] && { warn "Trockenlauf: nichts verändert."; return 0; }
  # Reihenfolge ist wichtig: Zuerst einen NEUEN Schlüssel setzen und neu starten (der alte wird sofort ungültig,
  # solange der Admin-Zugang noch besteht) – erst danach den Zugang löschen.
  issue_setup_token || return 1
  ( cd "$ROOT" && dc exec -T web sh -c 'rm -f /data/admin.json /data/sessions.json' ) || die "Zurücksetzen fehlgeschlagen."
  ok "Admin-Zugang gelöscht"
  show_setup_token
}

need_config() {
  load_env; apply_defaults
  ensure_tools
  if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    die "Noch keine Cloudflare-Zugangsdaten gespeichert. Bitte ausführen:  ./install.sh cloudflare"
  fi
}

cmd_verify() { need_config; printf '\n%sToken prüfen%s\n' "$B" "$Z"; check_token || die "Token ungültig oder unzureichende Rechte."; }
cmd_cloudflare() {
  load_env; apply_defaults; printf '\n%sCloudflare-Zugang%s\n' "$B" "$Z"
  ensure_tools
  CLOUDFLARE_API_TOKEN=""
  collect_credentials
  check_token || die "Token ungültig oder unzureichende Rechte."
  USE_CLOUDFLARE=1
  [ "$DRY" = 1 ] && return 0
  ensure_tunnel || die "Tunnel-Einrichtung fehlgeschlagen."
  save_env; write_worker_env
  ok "Zugangsdaten gespeichert (.env.local, .env.worker)"
  ( cd "$ROOT" && dc up -d --force-recreate worker ) >/dev/null 2>&1 && ok "Worker neu gestartet – der Abgleich mit Cloudflare beginnt"
}
cmd_proxmox() {
  local secret=""
  load_env; apply_defaults; printf '\n%sProxmox-Anbindung%s\n' "$B" "$Z"
  ensure_tools
  cat <<EOF

  Der Worker liest Traffic und Status der VMs über die Proxmox-API (nur lesend).
  ${B}Token in Proxmox anlegen:${Z}
   1. Datacenter → Permissions → Users → Add:  security@pve
   2. Permissions → API Tokens → Add:  Benutzer security@pve, Token-ID „panel“, „Privilege Separation“ aktiv.
      Das ${B}Geheimnis${Z} (Secret) wird nur einmal angezeigt – hier einfügen.
   3. Permissions → Add → API Token Permission:  Pfad /, Token security@pve!panel, Rolle ${B}PVEAuditor${Z}, Propagate an.
  Danach im Panel unter ${B}Anbindungen${Z} Adresse und Token-ID (security@pve!panel) eintragen.

EOF
  ask_secret secret "Token-Geheimnis einfügen (Eingabe bleibt unsichtbar)"
  [ "${#secret}" -ge 16 ] || die "Das sieht nicht wie ein Token-Geheimnis aus."
  [ "$DRY" = 1 ] && { warn "Trockenlauf: nichts gespeichert."; return 0; }
  write_worker_env "$secret"
  ok "Geheimnis gespeichert in .env.worker (Rechte 600)"
  ( cd "$ROOT" && dc up -d --force-recreate worker ) >/dev/null 2>&1 && ok "Worker neu gestartet"
}
cmd_start()   { load_env; apply_defaults; ensure_tools; printf '\n%sStarten%s\n' "$B" "$Z"; ( cd "$ROOT" && dc up -d ) && ok "Dienste gestartet"; }
cmd_restart() { load_env; apply_defaults; ensure_tools; printf '\n%sNeu starten%s\n' "$B" "$Z"; ( cd "$ROOT" && dc restart ) && ok "Dienste neu gestartet"; }
cmd_deploy()  { load_env; apply_defaults; printf '\n%sNeu bauen und starten%s\n' "$B" "$Z"; ensure_tools; start_stack || exit 1; }
cmd_stop()    { load_env; apply_defaults; ensure_tools; printf '\n%sStoppen%s\n' "$B" "$Z"; ( cd "$ROOT" && dc stop ) && ok "Dienste gestoppt (Daten bleiben erhalten; Start mit ./install.sh start)"; }
cmd_logs()    { load_env; apply_defaults; ensure_tools; ( cd "$ROOT" && dc logs --tail=100 -f ${CMD_ARGS[@]+"${CMD_ARGS[@]}"} ); }
cmd_domain() {
  local rc
  need_config; printf '\n%sPanel-Domain und Tunnel-Route%s\n' "$B" "$Z"
  check_token || die "Token ungültig oder unzureichende Rechte."
  ensure_tunnel || die "Tunnel-Einrichtung fehlgeschlagen."
  save_env; [ "$DRY" = 1 ] || write_worker_env
  ensure_dns; rc=$?; dns_result "$rc"
  if [ "$DRY" != 1 ]; then ( cd "$ROOT" && dc up -d ) >/dev/null 2>&1 || true; fi
}
cmd_dns_check() {
  load_env; apply_defaults; printf '\n%sDNS-Server prüfen%s\n' "$B" "$Z"
  JSON_TOOL=python3
  command -v python3 >/dev/null 2>&1 || die "python3 wird für den Test gebraucht."
  local target="${CMD_ARGS[0]:-${DNS_BIND_IP:-127.0.0.1}}" out
  [ "$target" = "0.0.0.0" ] && target="127.0.0.1"
  out="$(dns_probe "$target")" && ok "$target:53 antwortet ($out)" || { bad "$target:53 antwortet nicht vollständig ($out)"; info "  Läuft der Dienst?  ./install.sh status   ·   Firewall: Port 53 UDP+TCP freigeben"; exit 1; }
  info "  Von außen testen (von einem anderen Rechner):  dig @<server-ip> <deine-domain> NS"
}
cmd_status() {
  load_env; apply_defaults; ensure_tools; printf '\n%sStatus%s\n' "$B" "$Z"
  ( cd "$ROOT" && dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null ) | sed 's/^/    /'
  local ip="${DNS_BIND_IP:-127.0.0.1}"; [ "$ip" = "0.0.0.0" ] && ip="127.0.0.1"
  local out; out="$(dns_probe "$ip")" && ok "DNS-Server antwortet ($out)" || warn "DNS-Server antwortet nicht vollständig ($out)"
  if [ "$USE_CLOUDFLARE" = 1 ] && [ -n "$TUNNEL_ID" ] && [ -n "$CLOUDFLARE_API_TOKEN" ]; then
    local st; st="$(tunnel_status)"
    case "$st" in
      healthy) ok "Tunnel „$TUNNEL_NAME“: healthy (verbunden)" ;;
      "")      bad "Tunnel nicht abrufbar: $(cf_errors)" ;;
      *)       warn "Tunnel „$TUNNEL_NAME“: $st" ;;
    esac
    check_live || true
  fi
  [ -d "$ROOT/.git" ] && info "  Version: $(git -C "$ROOT" rev-parse --short HEAD) ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD))"
}
cmd_forget() {
  printf '\n%sZugangsdaten löschen%s\n' "$B" "$Z"
  if [ -f "$ENV_FILE" ] || [ -f "$TUNNEL_ENV" ] || [ -f "$WORKER_ENV" ]; then
    if confirm ".env.local, .env.tunnel und .env.worker wirklich löschen?" n; then
      rm -f "$ENV_FILE" "$TUNNEL_ENV" "$WORKER_ENV"; ok "Zugangsdaten gelöscht"
      warn "Den API-Token in Cloudflare selbst widerrufen: dash.cloudflare.com/profile/api-tokens → Token → „Roll“/„Delete“."
      warn "Admin-Zugang, Zonen, Server und Protokoll liegen im Docker-Volume und bleiben erhalten."
      warn "Ohne .env.tunnel kann der Tunnel-Container nicht mehr starten. Den Tunnel selbst löschst du im Zero-Trust-Dashboard (Networks → Tunnels)."
    fi
  else info "  Keine Zugangsdaten vorhanden."; fi
}
usage() { awk 'NR==1{next} /^# =+$/{n++; next} n==2{sub(/^# ?/,""); print} n>=3{exit}' "$SRC"; }

# ---------------------------------------------------------------- Start -------
while [ $# -gt 0 ]; do
  case "$1" in
    setup|deploy|update|verify|status|logs|stop|start|restart|domain|admin|admin-reset|forget|backup|restore|cloudflare|proxmox|dns-check) CMD="$1" ;;
    --update) CMD="update" ;;
    --status) CMD="status" ;;
    help|-h|--help) CMD="help" ;;
    --yes|-y) YES=1 ;;
    --dry-run) DRY=1 ;;
    --check) CHECK_ONLY=1 ;;
    --skip-pull) SKIP_PULL=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    --force) FORCE=1 ;;
    --no-cloudflare) OPT_NO_CF=1 ;;
    --domain) shift; OPT_DOMAIN="${1:-}" ;;
    --tunnel) shift; OPT_TUNNEL="${1:-}" ;;
    --dns-ip) shift; OPT_DNS_IP="${1:-}" ;;
    --ns1) shift; OPT_NS1="${1:-}" ;;
    --ns2) shift; OPT_NS2="${1:-}" ;;
    --server-domain) shift; OPT_SERVER_DOMAIN="${1:-}" ;;
    --branch) shift; BRANCH_OPT="${1:-}" ;;
    -*) die "Unbekannte Option: $1  (Hilfe: ./install.sh help)" ;;
    *) CMD_ARGS+=("$1") ;;
  esac
  shift
done

# Fehlt der Projektordner (curl … | bash), erst den Code holen und dann neu starten
if [ -z "$ROOT" ] || [ ! -f "$ROOT/compose.yaml" ]; then
  [ "$CMD" = help ] && { echo "Aufruf: curl -fsSL https://raw.githubusercontent.com/PwiePixel/VylarisSecurity/main/install.sh | bash"; exit 0; }
  fwd=("$CMD"); [ "$YES" = 1 ] && fwd+=(--yes); [ "$DRY" = 1 ] && fwd+=(--dry-run); [ "$OPT_NO_CF" = 1 ] && fwd+=(--no-cloudflare)
  [ -n "$OPT_DOMAIN" ] && fwd+=(--domain "$OPT_DOMAIN"); [ -n "$OPT_TUNNEL" ] && fwd+=(--tunnel "$OPT_TUNNEL"); [ -n "$OPT_DNS_IP" ] && fwd+=(--dns-ip "$OPT_DNS_IP")
  [ -n "$OPT_NS1" ] && fwd+=(--ns1 "$OPT_NS1"); [ -n "$OPT_NS2" ] && fwd+=(--ns2 "$OPT_NS2"); [ -n "$OPT_SERVER_DOMAIN" ] && fwd+=(--server-domain "$OPT_SERVER_DOMAIN")
  bootstrap_if_needed "${fwd[@]}" ${CMD_ARGS[@]+"${CMD_ARGS[@]}"}
fi

case "$CMD" in
  setup) cmd_setup ;; deploy) cmd_deploy ;; update) cmd_update ;; verify) cmd_verify ;; status) cmd_status ;;
  logs) cmd_logs ;; stop) cmd_stop ;; start) cmd_start ;; restart) cmd_restart ;; domain) cmd_domain ;;
  admin) cmd_admin ;; admin-reset) cmd_admin_reset ;; forget) cmd_forget ;; backup) cmd_backup ;; restore) cmd_restore ;;
  cloudflare) cmd_cloudflare ;; proxmox) cmd_proxmox ;; dns-check) cmd_dns_check ;; help) usage ;;
esac
