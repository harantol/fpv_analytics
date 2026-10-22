import semver from 'semver';
import { FlightLogParser } from '../vendor/blackbox/flightlog_parser.js';
import { FIRMWARE_TYPE_BETAFLIGHT, FIRMWARE_TYPE_INAV, FLIGHT_LOG_FLIGHT_MODE_NAME } from '../vendor/blackbox/flightlog_fielddefs.js';
import { toNaiveLocal } from '../pairing';
import type { FlightLog, TelemetrySample } from '../types';

/**
 * Lecture des logs Blackbox de Betaflight (.bbl / .bfl), avec le parseur du
 * Blackbox Explorer officiel (src/vendor/blackbox).
 *
 * Un fichier contient un log par armement : chacun devient un vol. Les trames
 * principales (500 Hz à 2 kHz) sont ramenées à 10 Hz au fil de la lecture.
 */

/** Pas de temps des échantillons produits (s). */
const STEP = 0.1;
/** Une position GPS est reprise au plus pendant cette durée sans nouvelle trame GPS (s). */
const GPS_HOLD = 2;

/** Un vol lu dans le Blackbox, avec l'empreinte de son log (pour ne pas l'importer deux fois). */
export type BlackboxLog = FlightLog & { key: string };

export interface BlackboxResult {
  logs: BlackboxLog[];
  /** Logs vides ou illisibles, ignorés. */
  skipped: number;
}

/** Le contenu ressemble-t-il à un log Blackbox ? */
export function isBlackbox(bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, 64));
  return head.includes('H Product:Blackbox flight data recorder');
}

/** Débuts de chaque log dans le fichier (un par armement). */
function logOffsets(bytes: Uint8Array): number[] {
  const marker = (FlightLogParser.prototype as unknown as { FLIGHT_LOG_START_MARKER: number[] }).FLIGHT_LOG_START_MARKER;
  const out: number[] = [];
  const first = marker[0];
  outer: for (let i = bytes.indexOf(first); i !== -1 && i <= bytes.length - marker.length; i = bytes.indexOf(first, i + 1)) {
    for (let k = 1; k < marker.length; k++) if (bytes[i + k] !== marker[k]) continue outer;
    out.push(i);
  }
  return out;
}

/** Heure de début écrite par le FC (UTC), si son horloge était réglée (par le GPS). */
function startDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 2000) return null;
  // Comme pour le log radio : heure locale « naïve » (heure locale lue comme UTC)
  return new Date(toNaiveLocal(ms));
}

/** Mode de vol au format CRSF de Betaflight, pour réutiliser la détection d'événements. */
function modeText(flags: number, failsafePhase: number): string {
  if (failsafePhase > 0) return '!FS!';
  const on = (name: string) => {
    const bit = FLIGHT_LOG_FLIGHT_MODE_NAME.indexOf(name);
    return bit >= 0 && bit < 32 && (flags & (1 << bit)) !== 0;
  };
  const mode = on('GPSRESCUE') ? 'RTH' : on('ANGLE') ? 'ANGL' : on('HORIZON') ? 'HOR' : on('AIRMODE') ? 'AIR' : 'ACRO';
  return on('ARM') ? mode : `${mode}*`;
}

function index(names: string[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  names?.forEach((n, i) => (out[n] = i));
  return out;
}

function parseOne(parser: FlightLogParser, begin: number, end: number, name: string): FlightLog | null {
  parser.parseHeader(begin, end);
  const cfg = parser.sysConfig;
  const I = index(parser.frameDefs.I?.name);
  const G = index(parser.frameDefs.G?.name);
  const S = index(parser.frameDefs.S?.name);
  if (I.time === undefined) return null;

  // Unités selon la version (comme le Blackbox Explorer) : 0,01 V depuis Betaflight 4.0
  const revision = typeof cfg['Firmware revision'] === 'string' ? cfg['Firmware revision'] : '';
  const bf = cfg.firmwareType === FIRMWARE_TYPE_BETAFLIGHT || /betaflight/i.test(revision);
  const version = semver.valid(semver.coerce(cfg.firmwareVersion)) ?? '0.0.0';
  const vScale = (bf && semver.gte(version, '4.0.0')) || cfg.firmwareType === FIRMWARE_TYPE_INAV ? 100 : 10;

  const samples: TelemetrySample[] = [];
  let t0: number | null = null;
  let lastT = 0;
  let mah = 0;
  // Modes inconnus tant qu'aucune trame lente (S) n'a été lue
  let flags: number | null = null;
  let fsPhase = 0;
  let gps: Partial<TelemetrySample> | null = null;
  let gpsT = -Infinity;
  // Échantillon en cours (une tranche de 0,1 s) : moyenne du courant, dernière valeur sinon
  let bin = -1;
  let cur: TelemetrySample | null = null;
  let ampSum = 0;
  let ampN = 0;

  const flush = () => {
    if (!cur) return;
    if (ampN) cur.current = Math.round((ampSum / ampN) * 100) / 100;
    cur.capacity = Math.round(mah);
    if (flags !== null) cur.flightMode = modeText(flags, fsPhase);
    if (gps && cur.t - gpsT <= GPS_HOLD) Object.assign(cur, gps);
    samples.push(cur);
    cur = null;
    ampSum = 0;
    ampN = 0;
  };

  parser.onFrameReady = (valid, frame, type) => {
    if (!valid || !Array.isArray(frame)) return;
    if (type === 'I' || type === 'P') {
      // Calcul en microsecondes entières : évite qu'un arrondi range une trame dans la tranche précédente
      const us: number = frame[I.time];
      if (t0 === null) t0 = us;
      const start: number = t0;
      const t = (us - start) / 1e6;
      if (t < lastT - 1) return; // horodatage incohérent (trame corrompue)
      const amps = I.amperageLatest !== undefined ? frame[I.amperageLatest] / 100 : undefined;
      if (amps !== undefined && t > lastT) mah += (amps * (t - lastT) * 1000) / 3600;
      lastT = Math.max(lastT, t);
      const b = Math.floor((us - start) / (STEP * 1e6));
      if (b !== bin) {
        flush();
        bin = b;
        cur = { t: Math.round(b * STEP * 10) / 10 };
        if (I.vbatLatest !== undefined) cur.voltage = frame[I.vbatLatest] / vScale;
        if (I.rssi !== undefined) cur.fcRssi = Math.round((frame[I.rssi] / 1023) * 100);
        if (I['rcCommand[3]'] !== undefined) cur.throttle = Math.max(0, Math.min(100, Math.round((frame[I['rcCommand[3]']] - 1000) / 10)));
      }
      if (amps !== undefined) {
        ampSum += amps;
        ampN++;
      }
    } else if (type === 'S') {
      if (S.flightModeFlags !== undefined) flags = frame[S.flightModeFlags];
      if (S.failsafePhase !== undefined) fsPhase = frame[S.failsafePhase];
    } else if (type === 'G' && t0 !== null) {
      const lat = frame[G['GPS_coord[0]']] / 1e7;
      const lon = frame[G['GPS_coord[1]']] / 1e7;
      if (!lat || !lon || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      gps = { lat, lon };
      if (G.GPS_altitude !== undefined) gps.alt = frame[G.GPS_altitude] / 10;
      if (G.GPS_speed !== undefined) gps.speed = Math.round((frame[G.GPS_speed] / 100) * 3.6 * 10) / 10;
      if (G.GPS_ground_course !== undefined) gps.heading = frame[G.GPS_ground_course] / 10;
      if (G.GPS_numSat !== undefined) gps.sats = frame[G.GPS_numSat];
      gpsT = G.time !== undefined ? (frame[G.time] - (t0 ?? 0)) / 1e6 : lastT;
    }
  };
  parser.parseLogData(false);
  flush();
  if (samples.length < 2) return null;

  const fields = new Set<keyof TelemetrySample>();
  for (const s of samples) for (const k of Object.keys(s)) fields.add(k as keyof TelemetrySample);
  const fw = revision || `${bf ? 'Betaflight' : 'FC'} ${cfg.firmwareVersion}`;
  return { name, start: startDate(cfg['Log start datetime']), samples, fields, source: 'blackbox', firmware: fw };
}

/** Empreinte (FNV-1a) d'une partie du fichier. */
export function bytesKey(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `b${bytes.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

/** Lit tous les logs d'un fichier Blackbox. */
export function parseBlackbox(data: ArrayBuffer | Uint8Array, name = 'log.bbl'): BlackboxResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const starts = logOffsets(bytes);
  if (starts.length === 0) throw new Error("ce fichier n'est pas un log Blackbox.");
  const parser = new FlightLogParser(bytes);
  const logs: BlackboxLog[] = [];
  let skipped = 0;
  for (const [i, begin] of starts.entries()) {
    const end = starts[i + 1] ?? bytes.length;
    const label = starts.length > 1 ? `${name} #${i + 1}` : name;
    try {
      const log = parseOne(parser, begin, end, label);
      if (log) logs.push({ ...log, key: bytesKey(bytes.subarray(begin, end)) });
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { logs, skipped };
}
