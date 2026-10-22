import type { FlightLog, TelemetrySample, VideoLog, VideoSample } from './types';

/** Un point de la timeline fusionnée (télémétrie + vidéo). */
export interface Point extends TelemetrySample {
  /** Distance au point de départ (m). */
  dist?: number;
  /** Tension par élément (V). */
  cellV?: number;
  /** Altitude par rapport au point de départ (m). */
  relAlt?: number;
  /** Altitude du sol sous le drone (m, MSL). */
  ground?: number;
  /** Altitude absolue utilisée pour l'affichage 3D (m, MSL). */
  z?: number;
  /** Hauteur au-dessus du sol (m). */
  agl?: number;
  video?: VideoSample;
}

export interface Flight {
  log: FlightLog;
  video: VideoLog | null;
  /** Décalage (s) appliqué à la vidéo : tVidéo = tTélémétrie - offset. */
  videoOffset: number;
  points: Point[];
  /** Points ayant une position GPS valide. */
  gps: Point[];
  home: { lat: number; lon: number; alt: number } | null;
  cells: number | null;
  duration: number;
}

const R = 6371000;
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Estime le nombre d'éléments LiPo/Li-ion à partir de la tension maximale. */
export function estimateCells(maxVoltage: number): number | null {
  if (!(maxVoltage > 2.5)) return null;
  // On suppose la batterie chargée (≤ 4.35 V/élément) au début du vol.
  return Math.max(1, Math.ceil(maxVoltage / 4.35 - 0.05));
}

/** Recherche binaire du dernier échantillon avec t ≤ target. */
export function indexAt<T extends { t: number }>(arr: T[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  if (hi < 0) return -1;
  if (target <= arr[0].t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].t <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Supprime les sauts GPS aberrants (vitesse implicite > 500 km/h). */
function isGlitch(prev: Point, p: Point): boolean {
  const dt = p.t - prev.t;
  if (dt <= 0) return false;
  const d = haversine(prev.lat!, prev.lon!, p.lat!, p.lon!);
  return d / dt > 140;
}

export function buildFlight(log: FlightLog, video: VideoLog | null, videoOffset = 0): Flight {
  let maxV = 0;
  for (const s of log.samples) if ((s.voltage ?? 0) > maxV) maxV = s.voltage!;
  const cells = estimateCells(maxV);

  const points: Point[] = log.samples.map((s) => ({ ...s }));
  const gps: Point[] = [];
  for (const p of points) {
    if (p.lat === undefined || p.lon === undefined) continue;
    if (gps.length && isGlitch(gps[gps.length - 1], p)) {
      delete p.lat;
      delete p.lon;
      continue;
    }
    gps.push(p);
  }

  // Point de départ : première position avec suffisamment de satellites si dispo
  const homePt = gps.find((p) => (p.sats ?? 99) >= 6) ?? gps[0];
  const home = homePt ? { lat: homePt.lat!, lon: homePt.lon!, alt: homePt.alt ?? 0 } : null;

  for (const p of points) {
    if (home && p.lat !== undefined && p.lon !== undefined) p.dist = haversine(home.lat, home.lon, p.lat, p.lon);
    if (cells && p.voltage !== undefined) p.cellV = p.voltage / cells;
    if (home && p.alt !== undefined) p.relAlt = p.alt - home.alt;
  }

  const flight: Flight = {
    log,
    video,
    videoOffset,
    points,
    gps,
    home,
    cells,
    duration: points.length ? points[points.length - 1].t : 0,
  };
  attachVideo(flight, videoOffset);
  return flight;
}

/**
 * Place la trace en 3D sur le relief : l'altitude relative au départ est
 * ajoutée à l'altitude du sol au point de départ (fonctionne que le capteur
 * donne une altitude baro relative ou une altitude GPS MSL).
 */
export function applyGround(flight: Flight, grounds: (number | null)[], homeGround: number | null): void {
  const base = homeGround ?? 0;
  flight.gps.forEach((p, i) => {
    const g = grounds[i];
    if (g !== null && g !== undefined) p.ground = g;
    p.z = base + (p.relAlt ?? 0);
    if (p.ground !== undefined) p.agl = p.z - p.ground;
  });
}

/** (Re)associe les échantillons vidéo aux points de télémétrie selon le décalage. */
export function attachVideo(flight: Flight, offset: number): void {
  flight.videoOffset = offset;
  const v = flight.video?.samples;
  for (const p of flight.points) {
    if (!v || v.length === 0) {
      delete p.video;
      continue;
    }
    const tv = p.t - offset;
    if (tv < v[0].t - 1 || tv > v[v.length - 1].t + 1) {
      delete p.video;
      continue;
    }
    p.video = v[indexAt(v, tv)];
  }
}

/**
 * Propose un décalage vidéo. Si le SRT contient la tension batterie du drone,
 * on cherche le décalage qui colle le mieux à la courbe de tension télémétrie ;
 * sinon on aligne le début de la vidéo sur le début du log.
 */
export function guessVideoOffset(flight: Flight): number {
  if (!flight.video) return 0;
  const v = flight.video.samples;
  const withBat = v.filter((s) => s.droneBat !== undefined && s.droneBat > 1);
  const tel = flight.points.filter((p) => p.voltage !== undefined);
  if (withBat.length > 20 && tel.length > 20) {
    const step = Math.max(1, Math.floor(withBat.length / 200));
    let best = 0;
    let bestErr = Infinity;
    const span = flight.duration;
    for (let off = -Math.round(span); off <= span; off += 1) {
      let err = 0;
      let n = 0;
      for (let i = 0; i < withBat.length; i += step) {
        const s = withBat[i];
        const tt = s.t + off;
        if (tt < 0 || tt > span) continue;
        const p = tel[indexAt(tel, tt)];
        err += (p.voltage! - s.droneBat!) ** 2;
        n++;
      }
      if (n < withBat.length / step / 3) continue;
      err /= n;
      if (err < bestErr) {
        bestErr = err;
        best = off;
      }
    }
    return best;
  }
  return 0;
}

export interface Stats {
  duration: number;
  maxDist?: number;
  totalDist?: number;
  maxAlt?: number;
  maxSpeed?: number;
  minVoltage?: number;
  minCellV?: number;
  maxCurrent?: number;
  usedMah?: number;
  minRqly?: number;
  minRssi?: number;
  lowLinkSeconds?: number;
  failsafes?: number;
  maxTpwr?: number;
  minVideoSignal?: number;
  avgBitrate?: number;
  maxDelay?: number;
}

function extreme(points: Point[], f: (p: Point) => number | undefined, sign: 1 | -1): number | undefined {
  let m: number | undefined;
  for (const p of points) {
    const v = f(p);
    if (v !== undefined && Number.isFinite(v) && (m === undefined || sign * v < sign * m)) m = v;
  }
  return m;
}
const minOf = (pts: Point[], f: (p: Point) => number | undefined) => extreme(pts, f, 1);
const maxOf = (pts: Point[], f: (p: Point) => number | undefined) => extreme(pts, f, -1);

export function computeStats(f: Flight): Stats {
  const pts = f.points;
  const s: Stats = { duration: f.duration };
  s.maxDist = maxOf(pts, (p) => p.dist);
  if (f.gps.length > 1) {
    let d = 0;
    for (let i = 1; i < f.gps.length; i++) d += haversine(f.gps[i - 1].lat!, f.gps[i - 1].lon!, f.gps[i].lat!, f.gps[i].lon!);
    s.totalDist = d;
  }
  s.maxAlt = maxOf(pts, (p) => p.relAlt);
  s.maxSpeed = maxOf(pts, (p) => p.speed);
  // On ignore les 3 premières secondes (branchement) pour la tension min
  const flying = pts.filter((p) => p.t > 3);
  s.minVoltage = minOf(flying, (p) => (p.voltage && p.voltage > 0.5 ? p.voltage : undefined));
  s.minCellV = minOf(flying, (p) => (p.cellV && p.cellV > 0.5 ? p.cellV : undefined));
  s.maxCurrent = maxOf(pts, (p) => p.current);
  s.usedMah = maxOf(pts, (p) => p.capacity);
  s.minRqly = minOf(pts, (p) => p.rqly);
  s.minRssi = minOf(pts, (p) => {
    const a = p.rssi1;
    const b = p.rssi2;
    if (a === undefined) return b;
    if (b === undefined || b === 0) return a;
    return Math.max(a, b);
  });
  s.maxTpwr = maxOf(pts, (p) => p.tpwr);
  if (f.log.fields.has('rqly')) {
    let low = 0;
    let fs = 0;
    let inFs = false;
    for (let i = 1; i < pts.length; i++) {
      const q = pts[i].rqly;
      if (q === undefined) continue;
      if (q < 50) low += pts[i].t - pts[i - 1].t;
      if (q === 0 && !inFs) fs++;
      inFs = q === 0;
    }
    s.lowLinkSeconds = low;
    s.failsafes = fs;
  }
  if (f.video) {
    const v = f.video.samples;
    const sig = v.map((x) => x.signal).filter((x): x is number => x !== undefined);
    if (sig.length) s.minVideoSignal = sig.reduce((a, b) => Math.min(a, b));
    const br = v.map((x) => x.bitrate).filter((x): x is number => x !== undefined);
    if (br.length) s.avgBitrate = br.reduce((a, b) => a + b, 0) / br.length;
    const dl = v.map((x) => x.delay).filter((x): x is number => x !== undefined);
    if (dl.length) s.maxDelay = dl.reduce((a, b) => Math.max(a, b));
  }
  return s;
}
