# VylarisSecurity

**Das Sicherheitssystem der VylarisGroup** – *Protecting the Vylaris Ecosystem. DNS. Proxy. Protection.*

Ein Panel, ein Installationsbefehl, vier Dienste:

| Dienst | Aufgabe | Erreichbar |
|---|---|---|
| `dns` | **eigener autoritativer DNS-Server** (ns1/ns2): Zonen, Einträge, interne Sicht, ALIAS, Ratenbegrenzung | Port **53 UDP+TCP** (einziger offener Port) |
| `proxy` | **Reverse-Proxy**: verbirgt die IPs der Server, Sperrlisten, Anfragelimit, WebSocket, Zähler | nur über den Cloudflare Tunnel |
| `web` | **Panel** (DNS, Server, IP-Adressen, Proxy, Traffic, Anbindungen) + öffentliche Seiten – im Look von VylarisData | nur über den Cloudflare Tunnel |
| `worker` | Cloudflare-Abgleich, **Erreichbarkeits-Scan** der IP-Adressen, **Traffic** (Host und Proxmox) | intern |
| `tunnel` | Cloudflare Tunnel (nur ausgehende Verbindungen) | – |

Gebaut mit **Next.js** (App Router, React, TypeScript strict) für das Panel und reinem **Node.js 22 ohne Abhängigkeiten** für DNS-Server, Proxy und Worker.
Kein Tracking, keine Cookies für Besucher, keine Drittanbieter-Ressourcen.

## Wie alles zusammenspielt

```
                         Besucher
                            │
            ┌───────────────┴────────────────┐
            ▼                                ▼
   (1) Namensauflösung                (2) Webverkehr
   ns1/ns2 = unser dns-Container      geschützter Name → Cloudflare (DDoS-Schutz, HTTPS)
   (Port 53)                                  │  ausgehender Tunnel
            │                                 ▼
            │                         proxy-Container ── prüft Sperrlisten, Limit, Größe
            │                                 │  internes Netz, Ziel = Server-Name aus der Server-Liste
            ▼                                 ▼
     Panel pflegt Zonen                  deine Server (IP bleibt verborgen)
```

* **Server bekommen Domainnamen.** Jede VM heißt z. B. `web01.server.vylaris.it` (Domain einstellbar). Der Name entsteht automatisch im DNS und wird überall statt der IPv4-Adresse benutzt – im Proxy, im DNS, in der Übersicht.
* **Ursprungs-IPs bleiben geschützt.** Server-Namen sind standardmäßig **intern** (Split-Horizon): Nur Anfragen aus den eingestellten internen Netzen sehen sie, aus dem Internet gibt es sie nicht.
* **Eigenes DNS + Cloudflare-DDoS-Schutz** gehen zusammen (siehe unten, „Zwei Betriebsarten“).

## Installation: ein Befehl

Auf dem Server (Linux; als root oder mit sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/PwiePixel/VylarisSecurity/main/install.sh | bash
```

oder von Hand:

```bash
git clone https://github.com/PwiePixel/VylarisSecurity.git
```

```bash
cd VylarisSecurity && ./install.sh
```

Der Installer führt der Reihe nach durch:

1. Voraussetzungen prüfen und **fehlende selbst installieren** (Docker über get.docker.com, git, curl, python3),
2. Einstellungen abfragen (Panel-Adresse, Namen der Nameserver, Server-Domain),
3. erklären, wie du den **Cloudflare-API-Token** anlegst, und Token + Account-ID prüfen,
4. Einstellungen lokal speichern (`.env.local`, `.env.worker`, `.env.tunnel` – Rechte 600, nicht im Git),
5. **Tunnel** anlegen: Panel-Adresse → Panel, **alle anderen Namen → Proxy**; DNS-Eintrag (CNAME) für das Panel setzen,
6. Port 53 prüfen (belegt ein lokaler Resolver wie `systemd-resolved` den Port, bindet der DNS-Server an die Server-Adresse – der Resolver bleibt unangetastet),
7. alle Dienste bauen und starten, Grundkonfiguration anlegen (Nameserver, Server-Domain),
8. DNS-Server, Tunnel und Erreichbarkeit prüfen und den **Admin-Zugang** einrichten.

Nichts davon fragt zweimal: Alle Angaben werden gespeichert.

### Cloudflare-Token

<https://dash.cloudflare.com/profile/api-tokens> → *Create Token* → *Custom Token*:

* **Account · Cloudflare Tunnel · Edit** (Tunnel anlegen)
* **Zone · DNS · Edit** und **Zone · Zone · Read** (Einträge in Cloudflare-Zonen)
* **Zone · SSL and Certificates · Edit** (nur für „Cloudflare-Schutz“ über Cloudflare for SaaS, optional)
* Zone Resources: *All zones*

Die Account-ID steht im Cloudflare-Dashboard in der rechten Seitenleiste.
Ohne Cloudflare gibt es `./install.sh --no-cloudflare` (Panel nur auf `127.0.0.1:8080`, Proxy auf `127.0.0.1:8081`).

### Admin-Zugang

```bash
./install.sh admin
```

zeigt einen Einrichtungs-Schlüssel (gilt 1 Stunde). Danach unter `https://<panel>/admin/setup/` Benutzername und Passwort wählen und unter *Sicherheit* die Zwei-Faktor-Anmeldung (TOTP) aktivieren.

## Update: `--update`

```bash
./install.sh --update
```

* holt die neueste Version aus Git, erneuert die Basis-Images, baut neu und startet neu,
* fragt **keine** Zugangsdaten erneut ab – `.env.local`, `.env.worker`, `.env.tunnel` bleiben unberührt,
* **Zonen, Server, IP-Verwaltung, Proxy-Routen, Admin-Zugang und Protokoll bleiben erhalten** (liegen in Docker-Volumes, die Updates nie anfassen),
* legt **vorher automatisch eine Sicherung** an (`backups/`, die letzten 10 bleiben),
* prüft danach alle Dienste und **rollt bei Problemen automatisch auf den vorherigen Stand zurück**,
* ergänzt Einstellungen, die ältere Installationen noch nicht hatten, ohne Vorhandenes zu überschreiben.

`./install.sh --update --check` prüft nur, ob etwas Neues da ist. `--yes` fragt nichts nach, `--force` macht trotz lokaler Änderungen weiter.

Weitere Befehle: `status`, `logs [dienst]`, `restart`, `stop`/`start`, `backup`, `restore DATEI`, `admin`, `admin-reset`, `cloudflare`, `proxmox`, `domain`, `dns-check`, `help`.

## Das Panel

| Seite | Was du dort tust |
|---|---|
| **Übersicht** | Zustand aller Dienste, Kennzahlen, **Hinweise, die Aufmerksamkeit brauchen** (Adresskonflikte, ausgefallene Server, Fehler) |
| **DNS** | Zonen und Einträge (A, AAAA, CNAME, ALIAS, MX, TXT, SRV, CAA, NS, PTR), Nameserver, interne Netze, Vorschau „was der Server ausliefert“ |
| **Server** | VMs mit Namen, **beliebig vielen IPs**, Hauptadresse, Proxmox-Knoten/VM-ID, Traffic |
| **IP-Adressen** | alle Netze: frei / zugewiesen / reserviert / gesperrt, Adressraster, **Erreichbarkeit** und Konflikte, MAC, PTR |
| **Proxy** | Routen (Hostname → Server), Schutzregeln, Zähler je Route, abgewehrte Anfragen |
| **Traffic** | Diagramme: VMs und Proxmox-Knoten (aus Proxmox), Host-Schnittstellen, Proxy, DNS-Server |
| **Anbindungen** | Cloudflare- und Proxmox-Status, Abgleich anstoßen, VMs aus Proxmox übernehmen |
| Rechtliches · Sicherheit · Protokoll | Impressum/Datenschutz pflegen · Passwort und Zwei-Faktor · Protokoll aller Änderungen |

### Eigene Nameserver einrichten

1. Panel → **DNS**: Nameserver eintragen (z. B. `ns1.vylaris.it` mit der IPv4 dieses Servers) und Zonen anlegen.
2. Firewall/Hoster: **Port 53 UDP und TCP** eingehend freigeben (sonst nichts).
3. Beim Registrar der Domain die Nameserver auf `ns1.vylaris.it` und `ns2.vylaris.it` stellen. Liegen die Nameserver in einer Domain von dir (`vylaris.it`), beim Registrar zusätzlich **Glue-Einträge** (Name + IP) anlegen.
4. Für Ausfallsicherheit einen **zweiten Server** mit eigener Adresse für `ns2` betreiben (zweite Installation, Zonen identisch pflegen).
5. Testen: `./install.sh dns-check` (lokal) und `dig @<server-ip> vylaris.it NS` (von außen).

### Zwei Betriebsarten pro Zone – und wie Cloudflare dazugehört

Cloudflare schützt vor DDoS nur Namen, die über Cloudflare laufen. Beides gleichzeitig – **eigene Nameserver** *und* Cloudflare-Schutz – geht so:

* **Betriebsart „Eigene Nameserver“**: ns1/ns2 beantworten die Zone. Einen Eintrag markierst du mit **„Über Cloudflare absichern“**. Der DNS-Server liefert dann statt der echten IP den **Cloudflare-Edge-Namen** aus (CNAME, am Zonenanfang per ALIAS aufgelöst). Der Worker legt dazu bei Cloudflare den *Custom Hostname* an (**Cloudflare for SaaS**, die ersten 100 Namen sind kostenlos). Voraussetzung einmalig: Eine Domain, die bei Cloudflare liegt, mit einem geschützten Namen `edge.<domain>` (CNAME auf den Tunnel), der als *Fallback Origin* eingetragen ist; diesen Namen trägst du unter *DNS → Einstellungen* ein.
* **Betriebsart „Cloudflare“**: Die Zone liegt bei Cloudflare, das Panel ist nur die gemeinsame Oberfläche. Der Worker gleicht Einträge (inkl. orange Wolke) per API ab und verändert **nur Einträge, die er selbst angelegt hat** (Notiz `vylaris-security`). Bestehende Einträge bleiben unberührt, bis du sie über „Einträge aus Cloudflare einlesen“ übernimmst. Proxy-Routen für Namen in solchen Zonen bekommen den Tunnel-Eintrag automatisch.

> Ehrlich dazu: Die Cloudflare-Anbindung ist gegen **Testserver** geprüft, nicht gegen dein echtes Konto. Cloudflare for SaaS (Custom Hostnames) musst du in Cloudflare für die Edge-Zone einmalig aktivieren. Prüfe die erste Zone mit einer unwichtigen Domain.

### Server-Namen und Proxy

1. **Server** anlegen (`web01`) und IPs zuweisen → der Name `web01.server.vylaris.it` entsteht im DNS (Zone `vylaris.it` muss unter *DNS* existieren).
2. **Proxy** → Route: Hostname `shop.example.com` → Server `web01`, Port 80. Der Proxy erreicht den Server über dessen Hauptadresse; Besucher sehen sie nie.
3. Damit der Name im Internet ankommt: Zone bei Cloudflare (Tunnel-Eintrag automatisch) **oder** Eintrag in einer eigenen Zone mit „Über Cloudflare absichern“.

## Mehrere IPv4-Adressen pro VM (Proxmox)

Proxmox verwaltet für normale VMs **keine** IP-Adressen – die Adresse wird *im Gast* eingestellt. (Mit Cloud-Init gibt es `ipconfig0`, `ipconfig1` … – pro **Netzwerkkarte** eine IPv4.) Mehrere Adressen für eine VM gehen so:

**Weg 1 – mehrere Adressen auf einer Netzwerkkarte (einfachster Weg).** Im Gast alle Adressen eintragen, z. B. Ubuntu `/etc/netplan/50-cloud-init.yaml`:

```yaml
network:
  version: 2
  ethernets:
    ens18:
      addresses:
        - 203.0.113.11/28
        - 203.0.113.12/28
        - 203.0.113.13/28
      routes:
        - to: default
          via: 203.0.113.1
      nameservers:
        addresses: [1.1.1.1, 9.9.9.9]
```

Danach `sudo netplan apply`. Bei Cloud-Init-VMs mit mehreren Adressen eine eigene Netzwerk-Datei über `qm set 101 --cicustom "network=local:snippets/101-network.yaml"` verwenden, sonst überschreibt Cloud-Init die Datei.

**Weg 2 – mehrere virtuelle Netzwerkkarten.** Proxmox → VM → *Hardware* → *Add* → *Network Device* (je Adresse eine, ggf. eigene MAC). Pro Karte `ipconfigN` (Cloud-Init) oder im Gast. Sinnvoll, wenn der Hoster pro IP eine eigene (virtuelle) MAC verlangt.

**Weg 3 – Subnetz geroutet (Proxmox-Host als Gateway).** Hat dein Hoster das Netz auf den Host geroutet, richtest du eine interne Bridge ein (`vmbr1`) und routest das Netz bzw. einzelne Adressen dorthin (`post-up ip route add 203.0.113.12/32 dev vmbr1` in `/etc/network/interfaces`). Die VM trägt die Adressen wie in Weg 1 ein.

**Damit die VM nur ihre zugewiesenen Adressen benutzen darf** (ohne dass jemand fremde Adressen „klauen“ kann) – Proxmox-Firewall mit IP-Filter:

1. Datacenter → Firewall → *Options*: Firewall **aktivieren**; VM-Karte mit Firewall: `qm set 101 --net0 virtio,bridge=vmbr0,firewall=1`.
2. Datei `/etc/pve/firewall/101.fw`:

```ini
[OPTIONS]
enable: 1
ipfilter: 1
macfilter: 1

[IPSET ipfilter-net0]
203.0.113.11
203.0.113.12
203.0.113.13
```

Der Name `ipfilter-net0` gilt für die Karte `net0` (`ipfilter-net1` für `net1` usw.). Alles, was die VM mit einer anderen Quelladresse sendet, wird verworfen.

**Verwaltung der Zuordnung in diesem Panel:** *Server → web01 → Adresse hinzufügen* (oder „nächste freie Adresse aus Netz …“). Jede Adresse gehört genau einem Server; das Panel verhindert Doppelvergabe. Der Scan zeigt, ob eine Adresse wirklich antwortet, ob eine „freie“ Adresse in Wahrheit benutzt wird (Konflikt) und ob eine zugewiesene nicht antwortet. **Traffic je VM** kommt aus der Proxmox-API (*Anbindungen*; Token mit nur-lesender Rolle `PVEAuditor`, Einrichtung mit `./install.sh proxmox`).

## Daten, Sicherung, Sicherheit

* **Speicherorte:** Docker-Volumes `vylarissecurity-data` (Konfiguration, Admin-Zugang, Protokoll) und `vylarissecurity-runtime` (Laufzeitwerte). Updates, `stop`, `restart` und `forget` löschen sie nie.
* **Sicherung:** `./install.sh backup` (automatisch vor jedem Update); `./install.sh restore backups/data-….tgz`.
* **Rechte:** DNS-Server und Proxy sehen die Konfiguration nur lesend. Der Cloudflare-Token liegt ausschließlich im Worker (`.env.worker`), nie im Panel. Alle Container: ohne Root, ohne Capabilities, schreibgeschütztes Dateisystem. Das Panel hat keinen Internetzugang.
* **Panel-Schutz:** Anmeldung mit Argon-ähnlichem Hash (scrypt), Zwei-Faktor (TOTP) und Wiederherstellungscodes, Ratenbegrenzung, CSRF-Prüfung, Sitzungs-Rotation, Protokoll aller Änderungen.
* **Proxy:** Besucher-IP nur aus `CF-Connecting-IP` (der Proxy ist ausschließlich über den Tunnel erreichbar); `X-Forwarded-For` des Clients wird ignoriert.
* **DNS:** kein Zonentransfer (AXFR → REFUSED), `ANY` wird minimal beantwortet, Ratenbegrenzung je Quelladresse, interne Einträge unsichtbar für externe Anfragen.

## Grenzen (ehrlich)

* Kein DNSSEC (in Cloudflare-Zonen kann es Cloudflare übernehmen).
* Der DNS-Server schützt sich selbst nur durch Ratenbegrenzung; gegen große Flutangriffe auf **Port 53** hilft nur der Schutz deines Hosters/Rechenzentrums (Cloudflare schützt den Webverkehr, nicht unsere Nameserver).
* TLS endet bei Cloudflare; der Proxy hat kein eigenes TLS.
* Der Erreichbarkeits-Scan nutzt ARP, Ping (wenn im Container erlaubt) und TCP-Verbindungsversuche. Ein Server, der alles still verwirft, erscheint als „nicht erreichbar“.
* Es gibt einen Admin-Zugang (keine Kunden-Konten). Eine nur-lesende Ansicht für Kunden ist nicht enthalten.
* Cloudflare- und Proxmox-Anbindung sind mit Testservern geprüft, nicht mit echten Konten.

## Entwicklung

```bash
npm ci
npm run typecheck     # TypeScript strict
npm test              # Modelle, DNS-Server, Proxy, Worker, Sicherheit
npm run build         # Panel bauen
npm run dns           # DNS-Server lokal:   DATA_DIR=./.data DNS_PORT=5353 npm run dns
npm run proxy         # Proxy lokal:        DATA_DIR=./.data PROXY_PORT=8081 npm run proxy
npm run worker        # Worker lokal
```

Aufbau: `lib/core` (reine Modelle, von Panel **und** Engines genutzt) · `lib/server` (Panel) · `app`, `components` (Panel und Seiten) · `engine/dns`, `engine/proxy`, `engine/worker` (laufen mit Node 22 direkt als TypeScript, ohne Build) · `install.sh`, `compose.yaml`, `Dockerfile`.

Jeder Dienst schreibt nur seine eigenen Dateien (`runtime/…`); die Konfiguration (`dns.json`, `inventory.json`, `proxy.json`) gehört dem Panel und wird von den Engines nur gelesen und bei Änderung automatisch neu geladen.
