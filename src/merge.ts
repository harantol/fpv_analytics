import { haversine } from './analysis';
import { parseFlightMode } from './events';
import type { FlightLog, TelemetrySample } from './types';

/**
 * Combinaison d'un log radio (EdgeTX, .csv) et d'un log Blackbox du même vol.
 *
 * Le log radio apporte la liaison ELRS (RQly, RSSI, SNR, puissance…), le Blackbox
 * le GPS, la batterie, les gaz et les modes de vol, bien plus fréquents. Les deux
 * horloges sont indépendantes : il faut d'abord caler le Blackbox sur le log radio.
 */

/** Comment le décalage a été trouvé. */
export type AlignMethod = 'gps' | 'arm' | 'clock' | 'none';

export interface Alignment {
  /** Instant du log radio (s) qui correspond au début du Blackbox. */
  offset: number;
  method: AlignMethod;
  /** Écart médian entre les deux traces GPS une fois calées (m), si calage GPS. */
  error?: number;
}

/** Une valeur radio est reprise au plus pendant cette durée autour de son instant (s). */
const HOLD = 1.5;
/** Écart médian maximal pour accepter un calage par le GPS (m). */
const GPS_MAX_ERROR = 40;
/** Le drone doit s'être déplacé d'au moins cette distance pour caler par le GPS (m). */
const GPS_MIN_SPREAD = 50;

interface Fix {
  t: number;
  lat: number;
  lon: number;
}

/** Positions GPS distinctes (le log radio répète la même position sur plusieurs lignes). */
function fixes(log: FlightLog): Fix[] {
  const out: Fix[] = [];
  for (const s of log.samples) {
    if (s.lat === undefined || s.lon === undefined || (s.lat === 0 && s.lon === 0)) continue;
    const last = out[out.length - 1];
    if (last && last.lat === s.lat && last.lon === s.lon) continue;
    out.push({ t: s.t, lat: s.lat, lon: s.lon });
  }
  return out;
}

/** Position interpolée à l'instant t (null hors de la trace ou dans un trou de plus de 3 s). */
function positionAt(track: Fix[], t: number): Fix | null {
  if (track.length < 2 || t < track[0].t || t > track[track.length - 1].t) return null;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  if (b.t - a.t > 3) return null;
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { t, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Écart médian (m) entre les positions radio et Blackbox pour un décalage donné. */
function gpsError(radio: Fix[], bbx: Fix[], offset: number, minPairs: number): number {
  const d: number[] = [];
  for (const r of radio) {
    const p = positionAt(bbx, r.t - offset);
    if (p) d.push(haversine(r.lat, r.lon, p.lat, p.lon));
  }
  return d.length >= minPairs ? median(d) : Infinity;
}

/** Étendue de la trace (m) : un drone immobile ne permet pas de caler par le GPS. */
function spread(track: Fix[]): number {
  let max = 0;
  for (const p of track) max = Math.max(max, haversine(track[0].lat, track[0].lon, p.lat, p.lon));
  return max;
}

/** Décalage par superposition des traces GPS : balayage à 0,5 s puis affinage à 0,1 s. */
function alignByGps(radio: FlightLog, bbx: FlightLog): Alignment | null {
  const r = fixes(radio);
  const b = fixes(bbx);
  if (r.length < 5 || b.length < 5 || spread(b) < GPS_MIN_SPREAD) return null;
  const minPairs = Math.max(5, Math.min(20, Math.floor(r.length / 4)));
  // Deux vols différents au même endroit ne doivent pas se superposer : départs proches,
  // et le Blackbox doit recouvrir le log radio sur au moins la moitié du plus court
  if (haversine(r[0].lat, r[0].lon, b[0].lat, b[0].lon) > 2000) return null;
  const rEnd = radio.samples[radio.samples.length - 1].t;
  const bEnd = bbx.samples[bbx.samples.length - 1].t;
  const minOverlap = 0.5 * Math.min(rEnd, bEnd);
  let best = { offset: 0, error: Infinity };
  for (let off = minOverlap - bEnd; off <= rEnd - minOverlap; off += 0.5) {
    const e = gpsError(r, b, off, minPairs);
    if (e < best.error) best = { offset: off, error: e };
  }
  if (!Number.isFinite(best.error)) return null;
  const coarse = best.offset;
  for (let off = coarse - 0.5; off <= coarse + 0.5 + 1e-9; off += 0.1) {
    const e = gpsError(r, b, off, minPairs);
    if (e < best.error) best = { offset: Math.round(off * 10) / 10, error: e };
  }
  if (best.error > GPS_MAX_ERROR) return null;
  return { offset: best.offset, method: 'gps', error: Math.round(best.error * 10) / 10 };
}

/** Le Blackbox démarre à l'armement : premier instant armé dans le log radio. */
function armTime(radio: FlightLog): number | null {
  const s = radio.samples.find((x) => parseFlightMode(x.flightMode).armed === true);
  return s ? s.t : null;
}

/** Cale le Blackbox sur le log radio : GPS, sinon armement, sinon horloges. */
export function alignBlackbox(radio: FlightLog, bbx: FlightLog): Alignment {
  const gps = alignByGps(radio, bbx);
  if (gps) return gps;
  const arm = armTime(radio);
  if (arm !== null) return { offset: arm, method: 'arm' };
  if (radio.start && bbx.start) return { offset: Math.round((bbx.start.getTime() - radio.start.getTime()) / 100) / 10, method: 'clock' };
  return { offset: 0, method: 'none' };
}

/** Champs du log radio gardés quand le Blackbox les fournit aussi : la liaison. */
const RADIO_FIRST: (keyof TelemetrySample)[] = ['rssi1', 'rssi2', 'rqly', 'rsnr', 'tpwr', 'tqly', 'trss', 'tsnr', 'rfmd'];

/**
 * Fusionne les deux logs sur la ligne de temps du log radio (décalage `offset`).
 * Pendant le Blackbox : ses échantillons (10 Hz), complétés par la valeur radio la
 * plus proche (à moins de 1,5 s) pour la liaison et les champs absents du Blackbox.
 * Avant et après : les lignes du log radio.
 */
export function mergeLogs(radio: FlightLog, bbx: FlightLog, offset: number): FlightLog {
  const rs = radio.samples;
  const bs = bbx.samples;
  const bStart = offset;
  const bEnd = offset + (bs.length ? bs[bs.length - 1].t : 0);
  // Champs pris dans le log radio pendant le Blackbox
  const fromRadio = [...radio.fields].filter((k) => k !== 't' && (RADIO_FIRST.includes(k) || !bbx.fields.has(k)));

  const out: TelemetrySample[] = [];
  for (const s of rs) if (s.t < bStart) out.push({ ...s });
  let k = 0;
  for (const s of bs) {
    const t = Math.round((s.t + offset) * 10) / 10;
    const m: TelemetrySample = { ...s, t };
    // Ligne radio la plus proche
    while (k + 1 < rs.length && Math.abs(rs[k + 1].t - t) <= Math.abs(rs[k].t - t)) k++;
    const r = rs[k];
    if (r && Math.abs(r.t - t) <= HOLD) for (const f of fromRadio) if (r[f] !== undefined) (m as unknown as Record<string, unknown>)[f] = r[f];
    out.push(m);
  }
  for (const s of rs) if (s.t > bEnd) out.push({ ...s });

  // Le log commence à 0 : si le Blackbox démarre avant le log radio, tout est décalé
  const shift = out.length ? Math.min(0, out[0].t) : 0;
  if (shift < 0) for (const s of out) s.t = Math.round((s.t - shift) * 10) / 10;
  const start = radio.start ? new Date(radio.start.getTime() + shift * 1000) : bbx.start;

  return {
    name: radio.name,
    start,
    samples: out,
    fields: new Set([...radio.fields, ...bbx.fields]),
    source: 'both',
    firmware: bbx.firmware,
  };
}

/** Le Blackbox et le log radio décrivent-ils le même vol ? (par la trace GPS) */
export function sameFlight(radio: FlightLog, bbx: FlightLog): boolean {
  return alignByGps(radio, bbx) !== null;
}

/** Recouvrement (0–1 du plus court) des deux logs d'après leurs heures, si elles sont connues. */
function timeOverlap(radio: FlightLog, bbx: FlightLog): number {
  if (!radio.start || !bbx.start) return 0;
  const r0 = radio.start.getTime();
  const b0 = bbx.start.getTime();
  const r1 = r0 + radio.samples[radio.samples.length - 1].t * 1000;
  const b1 = b0 + bbx.samples[bbx.samples.length - 1].t * 1000;
  // 30 s de tolérance : les deux horloges ne sont pas parfaitement à l'heure
  const ov = Math.min(r1, b1 + 30000) - Math.max(r0, b0 - 30000);
  return Math.max(0, Math.min(1, ov / Math.max(1000, Math.min(r1 - r0, b1 - b0))));
}

/**
 * Associe logs radio et Blackbox d'un même import (chacun au plus une fois).
 * Préférence : superposition des traces GPS (la plus précise), puis recouvrement
 * des heures, puis, s'il n'y a qu'un log de chaque, l'évidence.
 * Renvoie, pour chaque log radio associé, l'indice du Blackbox et le calage.
 */
export function pairBlackbox(radios: FlightLog[], bbxs: FlightLog[]): Map<number, { bbx: number; align: Alignment; sure: boolean }> {
  const cands: { r: number; b: number; score: number; align: Alignment }[] = [];
  radios.forEach((radio, r) =>
    bbxs.forEach((bbx, b) => {
      const gps = alignByGps(radio, bbx);
      if (gps) return cands.push({ r, b, score: gps.error ?? 0, align: gps });
      const ov = timeOverlap(radio, bbx);
      if (ov >= 0.3) return cands.push({ r, b, score: 1000 + (1 - ov) * 100, align: alignBlackbox(radio, bbx) });
      if (radios.length === 1 && bbxs.length === 1) cands.push({ r, b, score: 5000, align: alignBlackbox(radio, bbx) });
    }),
  );
  cands.sort((x, y) => x.score - y.score);
  const out = new Map<number, { bbx: number; align: Alignment; sure: boolean }>();
  const usedB = new Set<number>();
  for (const c of cands) {
    if (out.has(c.r) || usedB.has(c.b)) continue;
    // « sûr » : confirmé par le GPS ou les heures (pas seulement parce qu'il n'y a qu'un log de chaque)
    out.set(c.r, { bbx: c.b, align: c.align, sure: c.score < 5000 });
    usedB.add(c.b);
  }
  return out;
}
