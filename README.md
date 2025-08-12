# WaremaWMS2MQTT

Docker‑Bridge: **Warema WMS USB‑Stick → MQTT**. Kein HA‑Addon, nur MQTT.

## Quick Facts

* Docker (Alpine + Node.js)
* Serielle Anbindung an WMS‑Stick
* MQTT Topics für Cover (Position/Tilt) + optional Wetter‑Broadcasts
* Discovery via `WMS_PAN_ID=FFFF`
* Steuerung über `FORCE_DEVICES` / `IGNORED_DEVICES`

## Build

```bash
docker build -t wms-bridge-standalone \
  -f warema-bridge/Dockerfile.standalone \
  warema-bridge
```

## Discovery (Netzparameter ermitteln)

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

# Logs beobachten, Kanal/PAN/Key notieren, dann stoppen:
docker rm -f wms-bridge-discovery
```

## Run (Produktion)

```bash
docker run -d --name wms-bridge --restart unless-stopped \
  --device=/dev/ttyUSB0 \
  -v /dev/serial/by-id:/dev/serial/by-id:ro \
  -e WMS_SERIAL_PORT="/dev/ttyUSB0" \
  -e WMS_CHANNEL="17" \
  -e WMS_PAN_ID="2221" \
  -e WMS_KEY="<128bit_hex>" \
  -e MQTT_SERVER="mqtt://MQTT_HOST:1883" \
  -e MQTT_USER="USER" \
  -e MQTT_PASSWORD="PASS" \
  -e FORCE_DEVICES="00969444:25" \
  -e IGNORED_DEVICES="01163235,01232902" \
  -e POLLING_INTERVAL="30000" \
  -e MOVING_INTERVAL="1000" \
  wms-bridge-standalone
```

## Env

| Var                           | Desc                        | Example                    |
| ----------------------------- | --------------------------- | -------------------------- |
| `WMS_SERIAL_PORT`             | USB‑Stick                   | `/dev/ttyUSB0` / by‑id     |
| `WMS_CHANNEL`                 | Funkkanal                   | `17`                       |
| `WMS_PAN_ID`                  | PAN‑ID (`FFFF` = Discovery) | `2221`                     |
| `WMS_KEY`                     | Netzschlüssel (32 hex)      | `6DD46B…C957`              |
| `MQTT_SERVER`                 | Broker URL                  | `mqtt://192.168.1.10:1883` |
| `MQTT_USER` / `MQTT_PASSWORD` | Broker Auth                 |                            |
| `FORCE_DEVICES`               | `SNR[:TYPE]` (default `25`) | `00969444:25`              |
| `IGNORED_DEVICES`             | CSV SNRs                    | `01163235,01232902`        |
| `POLLING_INTERVAL`            | ms                          | `30000`                    |
| `MOVING_INTERVAL`             | ms                          | `1000`                     |

## Topics

**Cover**

* `warema/<SNR>/availability` → `online|offline`
* `warema/<SNR>/position` → `0..100`
* `warema/<SNR>/tilt` → `-100..100`
* `warema/<SNR>/set` → `OPEN|CLOSE|STOP`
* `warema/<SNR>/set_position` → `0..100`
* `warema/<SNR>/set_tilt` → `-100..100`

**Wetter** (falls vorhanden)

* `warema/<SNR>/illuminance/state`, `.../temperature/state`, `.../wind/state`, `.../rain/state`

**Bridge**

* `warema/bridge/state` → `online|offline`

## Notes

* Stick muss im WMS‑Netz eingebucht sein (sonst Timeouts).
* Windsensoren nicht pollen → in `IGNORED_DEVICES` packen.
* Stabiler Gerätepafd: `/dev/serial/by-id` mounten und verwenden.

## License

MIT
