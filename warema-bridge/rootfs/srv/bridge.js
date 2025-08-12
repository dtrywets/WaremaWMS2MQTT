// bridge.js — robuste, defensive Version
'use strict';

const warema = require('warema-wms-api');
const mqtt = require('mqtt');

/** ============= ENV & Defaults ============= */
const env = (name, def) => (process.env[name] ?? def);

const listEnv = (name) => {
  const v = env(name, '').trim();
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(Boolean);
};

// WMS
const WMS_SERIAL_PORT = env('WMS_SERIAL_PORT', '/dev/ttyUSB0');
const WMS_CHANNEL     = parseInt(env('WMS_CHANNEL', '17'), 10);
const WMS_PAN_ID      = env('WMS_PAN_ID', 'FFFF');
const WMS_KEY         = env('WMS_KEY', '00112233445566778899AABBCCDDEEFF');

// MQTT
const MQTT_SERVER   = env('MQTT_SERVER', 'mqtt://localhost:1883');
const MQTT_USER     = env('MQTT_USER', '');
const MQTT_PASSWORD = env('MQTT_PASSWORD', '');

// Verhalten
const POLLING_INTERVAL = Math.max(0, parseInt(env('POLLING_INTERVAL', '30000'), 10) || 30000);
const MOVING_INTERVAL  = Math.max(0, parseInt(env('MOVING_INTERVAL', '1000'), 10) || 1000);

// Gerätesteuerung
const IGNORED_DEVICES = new Set(listEnv('IGNORED_DEVICES')); // SNR (dezimal, ohne führende Nullen)
const FORCE_DEVICES_RAW = listEnv('FORCE_DEVICES');          // Einträge: "SNR" oder "SNR:TYPE"

// Sonstiges
const HA_PREFIX = 'homeassistant';
const BRIDGE_AVAIL_TOPIC = 'warema/bridge/state';
const DISCOVERY_RETAIN = true;

/** ============= State ============= */
let stickUsb = null;

// Geräte-Registry: SNR (Number) -> { snr:Number, name:String, type:Number }
const devices = new Map();

// Positionen: SNR -> { position:Number, angle:Number }
const positions = new Map();

// Bereits per HA Discovery veröffentlichte Weather-Sensoren
const weatherAnnounced = new Set();

/** ============= Helpers ============= */

function parseSnr(val) {
  // akzeptiert "00969444" oder "969444" -> Number
  const n = parseInt(String(val).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseForcedDevices(list) {
  // "00969444:25,12345" => [{snr:9694444,type:25},{snr:12345,type:25}]
  const out = [];
  for (const item of list) {
    const [idPart, typePart] = item.split(':').map(s => s.trim());
    const snr = parseSnr(idPart);
    if (!snr) continue;
    const type = parseInt(typePart || '25', 10);
    out.push({ snr, type: Number.isFinite(type) ? type : 25 });
  }
  return out;
}

function addBlindToStick(snr, name) {
  if (!stickUsb) return;
  const addFn = stickUsb.vnBlindAdd || stickUsb.addVnBlind; // API-Namensabweichungen abfangen
  if (typeof addFn === 'function') {
    try {
      addFn.call(stickUsb, snr, name || String(snr));
    } catch (e) {
      console.log(`WMS addBlind failed for ${snr}: ${e.message || e}`);
    }
  }
}

function ensureDeviceRegistered(element) {
  // element: { snr, name?, type }
  const snr = parseSnr(element.snr);
  if (!snr) return;

  if (IGNORED_DEVICES.has(String(snr))) {
    // explizit ignoriert
    if (devices.has(snr)) devices.delete(snr);
    return;
  }

  // standardisiere Name/Typ
  const name = element.name && String(element.name).trim() ? String(element.name).trim() : String(snr);
  const type = parseInt(element.type, 10);
  if (!Number.isFinite(type)) return;

  // In Registry übernehmen / aktualisieren
  devices.set(snr, { snr, name, type });

  // Dem Stick bekannt machen (wichtig, damit vnBlindGet() im Modul nicht undefined liefert)
  addBlindToStick(snr, name);

  // HA Discovery
  publishDiscoveryForDevice({ snr, name, type });

  // Gerätespezifische Availability auf online setzen
  mqttClient.publish(`warema/${snr}/availability`, 'online', { retain: true });
}

function publishDiscoveryForDevice({ snr, name, type }) {
  const availability = [
    { topic: BRIDGE_AVAIL_TOPIC },
    { topic: `warema/${snr}/availability` }
  ];
  const baseDevice = {
    identifiers: String(snr),
    manufacturer: 'Warema',
    name: name || String(snr)
  };

  let payload = null;
  let model = null;
  const topic = `${HA_PREFIX}/cover/${snr}/${snr}/config`;

  switch (Number(type)) {
    case 6: // Weather station -> kein cover; Sensoren werden dynamisch bei Broadcast announced
      return;

    case 20: // Plug receiver
      model = 'Plug receiver';
      payload = {
        availability,
        unique_id: String(snr),
        has_entity_name: true,
        device: { ...baseDevice, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${snr}/set`,
        position_topic: `warema/${snr}/position`,
        tilt_status_topic: `warema/${snr}/tilt`,
        set_position_topic: `warema/${snr}/set_position`,
        tilt_command_topic: `warema/${snr}/set_tilt`,
        tilt_closed_value: 100,
        tilt_opened_value: -100,
        tilt_min: -100,
        tilt_max: 100
      };
      break;

    case 21: // Actuator UP
      model = 'Actuator UP';
      payload = {
        availability,
        unique_id: String(snr),
        has_entity_name: true,
        device: { ...baseDevice, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${snr}/set`,
        position_topic: `warema/${snr}/position`,
        tilt_status_topic: `warema/${snr}/tilt`,
        set_position_topic: `warema/${snr}/set_position`,
        tilt_command_topic: `warema/${snr}/set_tilt`,
        tilt_closed_value: -100,
        tilt_opened_value: 100,
        tilt_min: -100,
        tilt_max: 100
      };
      break;

    case 25: // Radio motor (Markise/Rollo)
      model = 'Radio motor (cover)';
      payload = {
        availability,
        unique_id: String(snr),
        has_entity_name: true,
        device: { ...baseDevice, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${snr}/set`,
        position_topic: `warema/${snr}/position`,
        set_position_topic: `warema/${snr}/set_position`
      };
      break;

    case 9: // WebControl Pro – ignorieren
      return;

    default:
      console.log(`Unrecognized/unsupported device type ${type} for ${snr} – skipping discovery.`);
      return;
  }

  mqttClient.publish(topic, JSON.stringify(payload), { retain: DISCOVERY_RETAIN });
}

function announceWeatherSensors(snr) {
  if (weatherAnnounced.has(snr)) return;
  weatherAnnounced.add(snr);

  const availability = [
    { topic: BRIDGE_AVAIL_TOPIC },
    { topic: `warema/${snr}/availability` }
  ];
  const base = {
    name: String(snr),
    availability,
    device: {
      identifiers: String(snr),
      manufacturer: 'Warema',
      model: 'Weather Station',
      name: String(snr)
    },
    force_update: true
  };

  const mk = (kind, extra) => ({
    ...base,
    ...extra,
    unique_id: `${snr}_${kind}`
  });

  mqttClient.publish(
    `${HA_PREFIX}/sensor/${snr}/illuminance/config`,
    JSON.stringify(mk('illuminance', { state_topic: `warema/${snr}/illuminance/state`, device_class: 'illuminance', unit_of_measurement: 'lx' })),
    { retain: DISCOVERY_RETAIN }
  );
  mqttClient.publish(
    `${HA_PREFIX}/sensor/${snr}/temperature/config`,
    JSON.stringify(mk('temperature', { state_topic: `warema/${snr}/temperature/state`, device_class: 'temperature', unit_of_measurement: 'C' })),
    { retain: DISCOVERY_RETAIN }
  );
  mqttClient.publish(
    `${HA_PREFIX}/sensor/${snr}/wind/config`,
    JSON.stringify(mk('wind', { state_topic: `warema/${snr}/wind/state`, unit_of_measurement: 'm/s' })),
    { retain: DISCOVERY_RETAIN }
  );
  mqttClient.publish(
    `${HA_PREFIX}/sensor/${snr}/rain/config`,
    JSON.stringify(mk('rain', { state_topic: `warema/${snr}/rain/state` })),
    { retain: DISCOVERY_RETAIN }
  );

  mqttClient.publish(`warema/${snr}/availability`, 'online', { retain: true });
}

function setIntervals() {
  try {
    if (typeof stickUsb.setPosUpdInterval === 'function') {
      stickUsb.setPosUpdInterval(POLLING_INTERVAL);
      console.log(`Interval for position update set to ${Math.round(POLLING_INTERVAL / 1000)}s.`);
    }
    if (typeof stickUsb.setWatchMovingBlindsInterval === 'function') {
      stickUsb.setWatchMovingBlindsInterval(MOVING_INTERVAL);
    }
  } catch (e) {
    console.log(`Failed to set intervals: ${e.message || e}`);
  }
}

function registerDevices() {
  const forced = parseForcedDevices(FORCE_DEVICES_RAW);

  if (forced.length > 0) {
    for (const fd of forced) {
      ensureDeviceRegistered(fd);
    }
  } else {
    console.log('Scanning for devices...');
    // autoAssignBlinds=false: wir kontrollieren selbst, was wir dem Stick hinzufügen
    try {
      stickUsb.scanDevices({ autoAssignBlinds: false });
    } catch (e) {
      console.log(`scanDevices failed: ${e.message || e}`);
    }
  }
}

/** ============= MQTT ============= */
const mqttClient = mqtt.connect(MQTT_SERVER, {
  username: MQTT_USER || undefined,
  password: MQTT_PASSWORD || undefined,
  will: { topic: BRIDGE_AVAIL_TOPIC, payload: 'offline', retain: true }
});

mqttClient.on('connect', () => {
  console.log('Connected to MQTT');
  mqttClient.subscribe('warema/#');
  mqttClient.subscribe('homeassistant/status');
  // Bridge online signalisieren
  mqttClient.publish(BRIDGE_AVAIL_TOPIC, 'online', { retain: true });

  // Stick initialisieren
  stickUsb = new warema(
    WMS_SERIAL_PORT,
    WMS_CHANNEL,
    WMS_PAN_ID,
    WMS_KEY,
    {},
    stickCallback
  );
});

mqttClient.on('error', (err) => {
  console.log('MQTT Error: ' + (err && err.message ? err.message : String(err)));
});

/** ============= Stick Callback ============= */
function stickCallback(err, msg) {
  if (err) {
    console.log('ERROR: ' + err);
    return;
  }
  if (!msg) return;

  switch (msg.topic) {
    case 'wms-vb-init-completion': { // Stick init fertig
      console.log('Warema init completed');
      setIntervals();
      registerDevices();
      break;
    }

    case 'wms-vb-scanned-devices': {
      // { payload: { devices: [{ snr, type, ... }, ...] } }
      if (msg.payload && Array.isArray(msg.payload.devices)) {
        for (const element of msg.payload.devices) {
          // Default-Name: SNR
          ensureDeviceRegistered({
            snr: element.snr,
            name: String(element.snr),
            type: element.type
          });
        }
      }
      break;
    }

    case 'wms-vb-rcv-weather-broadcast': {
      // msg.payload.weather: { snr, lumen, temp, wind, rain }
      if (!msg.payload || !msg.payload.weather) break;
      const w = msg.payload.weather;
      const snr = parseSnr(w.snr);
      if (!snr || IGNORED_DEVICES.has(String(snr))) break;

      announceWeatherSensors(snr);

      // Werte publizieren
      mqttClient.publish(`warema/${snr}/illuminance/state`, String(w.lumen ?? ''), { retain: false });
      mqttClient.publish(`warema/${snr}/temperature/state`, String(w.temp ?? ''), { retain: false });
      mqttClient.publish(`warema/${snr}/wind/state`,        String(w.wind ?? ''), { retain: false });
      mqttClient.publish(`warema/${snr}/rain/state`,        String(w.rain ?? ''), { retain: false });
      break;
    }

    case 'wms-vb-blind-position-update': {
      // msg.payload: { snr, position, angle }
      const snr = parseSnr(msg.payload && msg.payload.snr);
      if (!snr) break;
      if (IGNORED_DEVICES.has(String(snr))) break;

      // Wenn Gerät noch nicht bekannt: als Typ 25 anlegen (defensiv)
      if (!devices.has(snr)) {
        ensureDeviceRegistered({ snr, name: String(snr), type: 25 });
      }

      const pos = Number.isFinite(parseInt(msg.payload.position)) ? parseInt(msg.payload.position) : 0;
      const ang = Number.isFinite(parseInt(msg.payload.angle)) ? parseInt(msg.payload.angle) : 0;

      positions.set(snr, { position: pos, angle: ang });

      mqttClient.publish(`warema/${snr}/position`, String(pos), { retain: false });
      mqttClient.publish(`warema/${snr}/tilt`,     String(ang), { retain: false });
      break;
    }

    // Optional: Command-Result-Events (nur Log, kein Publish nötig)
    case 'wms-vb-cmd-result-set-position':
    case 'wms-vb-cmd-result-stop':
      // console.log('CMD RESULT:', JSON.stringify(msg));
      break;

    default:
      // Debug-Ausgabe sparsam halten
      // console.log('UNKNOWN MESSAGE:', JSON.stringify(msg));
      break;
  }
}

/** ============= Eingehende MQTT Kommandos ============= */
mqttClient.on('message', (topic, messageBuf) => {
  const msgStr = messageBuf.toString();
  const parts = topic.split('/');
  const scope = parts[0];

  if (scope === 'homeassistant') {
    if (parts[1] === 'status' && msgStr === 'online') {
      // HA neu gestartet → Discovery erneut schicken
      for (const d of devices.values()) publishDiscoveryForDevice(d);
      for (const s of weatherAnnounced.values()) announceWeatherSensors(s);
    }
    return;
  }

  if (scope !== 'warema') return;
  const snr = parseSnr(parts[1]);
  const command = parts[2];

  if (!snr || !command) return;

  // Minimal-Logging der Kommandos
  if (!['rain', 'wind', 'temperature', 'illuminance'].includes(command)) {
    console.log(`${topic}:${msgStr}`);
    console.log(`device: ${snr} === command: ${command}`);
  }

  // Defensives Fallback, falls Gerät noch nicht bekannt
  if (!devices.has(snr)) {
    ensureDeviceRegistered({ snr, name: String(snr), type: 25 });
  }

  const safePos   = (positions.get(snr) && Number.isFinite(parseInt(positions.get(snr).position))) ? parseInt(positions.get(snr).position) : 0;
  const safeAngle = (positions.get(snr) && Number.isFinite(parseInt(positions.get(snr).angle)))    ? parseInt(positions.get(snr).angle)    : 0;

  switch (command) {
    case 'set': {
      const val = msgStr.toUpperCase();
      if (val === 'CLOSE') {
        stickUsb.vnBlindSetPosition(snr, 100, 0);
      } else if (val === 'OPEN') {
        stickUsb.vnBlindSetPosition(snr, 0, -100);
      } else if (val === 'STOP') {
        stickUsb.vnBlindStop(snr);
      }
      break;
    }

    case 'set_position': {
      const target = parseInt(msgStr, 10);
      const pos = Number.isFinite(target) ? target : safePos;
      // Winkel defensiv (0 wenn unbekannt), um Crash zu vermeiden
      const ang = safeAngle;
      stickUsb.vnBlindSetPosition(snr, pos, ang);
      break;
    }

    case 'set_tilt': {
      const target = parseInt(msgStr, 10);
      const ang = Number.isFinite(target) ? target : safeAngle;
      const pos = safePos;
      stickUsb.vnBlindSetPosition(snr, pos, ang);
      break;
    }

    default:
      // ignorieren
      break;
  }
});

/** ============= Sauberes Beenden ============= */
process.on('SIGINT', () => process.exit(0));
