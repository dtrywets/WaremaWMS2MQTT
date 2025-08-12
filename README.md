# WaremaWMS2MQTT

**WaremaWMS2MQTT** ist ein schlanker, **standalone** Docker-Container, der einen **Warema WMS USB‑Stick** anbindet und Zustände/Kommandos über **MQTT** bereitstellt. Jede MQTT‑fähige Hausautomation (z. B. Home Assistant) kann diese Topics konsumieren. **Kein Home‑Assistant‑Addon**, keine Supervisor‑Abhängigkeiten.

---

## Features

* **Standalone**: Alpine + Node.js als Docker‑Image
* **Serielle WMS‑Anbindung** (USB‑Stick)
* **MQTT‑Brücke** für Cover (Markisen/Rollos) inkl. Setzen/Abfragen von Position & Neigung
* Optional: **Wetter‑Broadcasts** (Licht, Temperatur, Wind, Regen)
* **Discovery‑Modus** (`WMS_PAN_ID=FFFF`) um **Kanal/PAN‑ID/Key** des WMS‑Netzes zu ermitteln
* **FORCE\_DEVICES** / **IGNORED\_DEVICES** für gezielte Gerätesteuerung
* Robuste Fehlerbehandlung (keine Crashes bei fehlenden Winkeln/Unbekannt‑Zuständen)

---

## Voraussetzungen

* Linux (getestet mit **Debian 12**), Docker/Podman
* **Warema WMS USB‑Stick** (am Host als `/dev/ttyUSB*` o. ä.)
* MQTT‑Broker (z. B. Mosquitto)

---

## Projektstruktur

```
warema-bridge/
  Dockerfile.standalone
  rootfs/
    srv/
      bridge.js
      package.json
```

> Hinweis: Es gibt **keine** Home‑Assistant‑Addon‑Dateien – das Projekt läuft als normaler Container.

---

## Build

Im Repository‑Root:

```bash
docker build -t wms-bridge-standalone \
  -f warema-bridge/Dockerfile.standalone \
  warema-bridge
```

---

## Discovery (WMS‑Netzparameter ermitteln)

Falls Kanal/PAN‑ID/Key unbekannt sind:

```bash
docker run -d --name wms-bridge-discovery --restart unless-stopped \
  --device=/dev/ttyUSB0 \
  -v /dev/serial/by-id:/dev/serial/by-id:ro \
  -e WMS_SERIAL_PORT="/dev/ttyUSB0" \
  -e WMS_PAN_ID="FFFF" \
  -e WMS_CHANNEL="17" \
  -e MQTT_SERVER="mqtt://MQTT_HOST:1883" \
  -e MQTT_USER="USER" \
  -e MQTT_PASSWORD="PASS" \
  wms-bridge-standalone

docker logs -f wms-bridge-discovery
```

* Folge dem im Log beschriebenen Ablauf (kurz in den Anlern/Broadcast gehen).
* Notiere dir **Kanal**, **PAN‑ID** und **Key** des richtigen WMS‑Netzes.
* Discovery stoppen:

```bash
docker rm -f wms-bridge-discovery
```

---

## Produktion (normaler Betrieb)

```bash
docker run -d --name wms-bridge --restart unless-stopped \
  --device=/dev/ttyUSB0 \
  -v /dev/serial/by-id:/dev/serial/by-id:ro \
  -e WMS_SERIAL_PORT="/dev/ttyUSB0" \
  -e WMS_CHANNEL="17" \
  -e WMS_PAN_ID="2221" \
  -e WMS_KEY="YOUR_128BIT_HEX_KEY" \
  -e MQTT_SERVER="mqtt://MQTT_HOST:1883" \
  -e MQTT_USER="USER" \
  -e MQTT_PASSWORD="PASS" \
  -e FORCE_DEVICES="00969444:25" \
  -e IGNORED_DEVICES="01163235,01232902" \
  -e POLLING_INTERVAL="30000" \
  -e MOVING_INTERVAL="1000" \
  wms-bridge-standalone
```

**Tipps**

* Stabiler Gerätepfad: `-v /dev/serial/by-id:/dev/serial/by-id:ro` mounten und `WMS_SERIAL_PORT` auf den **by‑id**‑Pfad setzen.
* `FORCE_DEVICES`: erzwingt Geräteanlage (Format `SNR[:TYPE]`, Default `TYPE=25` für Funkmotor/Cover).
* `IGNORED_DEVICES`: z. B. **Windsensoren** (antworten nicht auf Positionsabfragen).

---

## Umgebungsvariablen

| Variable           | Bedeutung                                                  | Beispiel                    |
| ------------------ | ---------------------------------------------------------- | --------------------------- |
| `WMS_SERIAL_PORT`  | Serieller Port des Sticks                                  | `/dev/ttyUSB0` / by‑id‑Pfad |
| `WMS_CHANNEL`      | WMS Funkkanal                                              | `17`                        |
| `WMS_PAN_ID`       | PAN‑ID des Netzes. **`FFFF`** aktiviert **Discovery**      | `2221` / `FFFF`             |
| `WMS_KEY`          | 128‑bit Netzschlüssel (Hex, 32 Zeichen)                    | `6DD46B…C957`               |
| `MQTT_SERVER`      | MQTT‑Broker URL                                            | `mqtt://192.168.1.10:1883`  |
| `MQTT_USER`        | MQTT Benutzer                                              | `user`                      |
| `MQTT_PASSWORD`    | MQTT Passwort                                              | `pass`                      |
| `FORCE_DEVICES`    | Kommagetrennte Liste: `SNR[:TYPE]` (Default `25`)          | `00969444:25`               |
| `IGNORED_DEVICES`  | Kommagetrennte Liste von SNRs, die ignoriert werden sollen | `01163235,01232902`         |
| `POLLING_INTERVAL` | Abfrageintervall Position (ms)                             | `30000`                     |
| `MOVING_INTERVAL`  | Intervall zur Bewegungserkennung (ms)                      | `1000`                      |

> **SNR‑Format**: Dezimal, führende Nullen sind ok (werden intern als Zahl verwendet).

---

## MQTT‑Topics

**Cover (Markise/Rollo):**

* Status

  * `warema/<SNR>/availability` → `online|offline`
  * `warema/<SNR>/position` → `0..100`
  * `warema/<SNR>/tilt` → `-100..100` (falls unterstützt)
* Kommandos

  * `warema/<SNR>/set` → `OPEN|CLOSE|STOP`
  * `warema/<SNR>/set_position` → `0..100`
  * `warema/<SNR>/set_tilt` → `-100..100`

**Wetter (Broadcast, falls Geräte vorhanden):**

* `warema/<SNR>/illuminance/state` (lx)
* `warema/<SNR>/temperature/state` (°C)
* `warema/<SNR>/wind/state` (m/s)
* `warema/<SNR>/rain/state` (0/1)

**Bridge‑Availability:**

* `warema/bridge/state` → `online|offline`

---

## Troubleshooting

**Keine Antworten / Timeouts**

* Stelle sicher, dass **Kanal/PAN‑ID/Key exakt** zum WMS‑Netz passen → ggf. **Discovery** fahren.
* USB‑Stick muss **ins WMS‑Netz eingebucht** sein (einmaliges Pairing/Join).
* Antenne/USB‑Verlängerung nutzen, etwas Abstand zu Störquellen.

**Falsche/unnötige Geräte**

* **Windsensoren** in `IGNORED_DEVICES` aufnehmen (sie antworten nicht auf Positionsabfragen).
* Markise (oder gewünschte Aktoren) via `FORCE_DEVICES="SNR[:TYPE]"` explizit setzen.

**Serielle Rechte**

* Notfalls mit `--privileged` testen. Besser: passendes `/dev/ttyUSB*` als `--device` mappen und by‑id mounten.

**Home Assistant zeigt „unbekannt“**

* HA braucht **erste State‑Payloads** (Position etc.). Sobald der Stick Antworten liefert, verschwinden „unknown“‑Zustände.

---

## Sicherheit / Versionierung

* **Keine Secrets committen**: `.env`/Run‑Skripte außerhalb der Versionskontrolle halten.
* Image lokal bauen oder eigene Registry verwenden.

---

## Lizenz

MIT (sofern nicht anders angegeben).

---

## Disclaimer

Dies ist ein Community‑Projekt ohne Gewähr. Nutzung auf eigene Verantwortung. WMS ist ein Markenzeichen der jeweiligen Rechteinhaber.
