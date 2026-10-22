import type { Point } from './analysis';

export type Ramp = 'quality' | 'inverse' | 'sequential';

export interface Metric {
  id: string;
  label: string;
  unit: string;
  get: (p: Point) => number | undefined;
  /** Domaine fixe pour la coloration ; sinon min/max des données. */
  domain?: [number, number];
  ramp: Ramp;
  digits: number;
}

const bestRssi = (p: Point) => {
  const a = p.rssi1;
  const b = p.rssi2;
  if (a === undefined) return b;
  if (b === undefined || b === 0) return a;
  return Math.max(a, b);
};

export const METRICS: Metric[] = [
  { id: 'relAlt', label: 'Altitude (départ)', unit: 'm', get: (p) => p.relAlt, ramp: 'sequential', digits: 0 },
  { id: 'agl', label: 'Hauteur sol', unit: 'm', get: (p) => p.agl, ramp: 'quality', digits: 0 },
  { id: 'speed', label: 'Vitesse', unit: 'km/h', get: (p) => p.speed, ramp: 'sequential', digits: 0 },
  { id: 'dist', label: 'Distance', unit: 'm', get: (p) => p.dist, ramp: 'sequential', digits: 0 },
  { id: 'cellV', label: 'Tension / élément', unit: 'V', get: (p) => p.cellV, domain: [3.0, 4.2], ramp: 'quality', digits: 2 },
  { id: 'voltage', label: 'Tension batterie', unit: 'V', get: (p) => p.voltage, ramp: 'quality', digits: 1 },
  { id: 'batPct', label: 'Batterie', unit: '%', get: (p) => p.batPct, domain: [0, 100], ramp: 'quality', digits: 0 },
  { id: 'current', label: 'Courant', unit: 'A', get: (p) => p.current, ramp: 'inverse', digits: 1 },
  { id: 'capacity', label: 'Consommé', unit: 'mAh', get: (p) => p.capacity, ramp: 'inverse', digits: 0 },
  { id: 'rqly', label: 'Link quality (RQly)', unit: '%', get: (p) => p.rqly, domain: [0, 100], ramp: 'quality', digits: 0 },
  { id: 'rssi', label: 'RSSI', unit: 'dBm', get: bestRssi, domain: [-115, -50], ramp: 'quality', digits: 0 },
  { id: 'rsnr', label: 'SNR', unit: 'dB', get: (p) => p.rsnr, domain: [-10, 10], ramp: 'quality', digits: 0 },
  { id: 'tpwr', label: "Puissance d'émission", unit: 'mW', get: (p) => p.tpwr, ramp: 'inverse', digits: 0 },
  { id: 'pktRate', label: 'Débit de paquets ELRS', unit: 'Hz', get: (p) => p.pktRate, ramp: 'sequential', digits: 0 },
  { id: 'tqly', label: 'Downlink (TQly)', unit: '%', get: (p) => p.tqly, domain: [0, 100], ramp: 'quality', digits: 0 },
  { id: 'vSignal', label: 'Signal vidéo', unit: '/4', get: (p) => p.video?.signal, domain: [0, 4], ramp: 'quality', digits: 0 },
  { id: 'vBitrate', label: 'Débit vidéo', unit: 'Mbps', get: (p) => p.video?.bitrate, domain: [0, 50], ramp: 'quality', digits: 1 },
  { id: 'vFrameLoss', label: 'Images vidéo perdues', unit: '%', get: (p) => p.video?.frameLoss, domain: [0, 50], ramp: 'inverse', digits: 0 },
  { id: 'vDelay', label: 'Latence vidéo', unit: 'ms', get: (p) => p.video?.delay, domain: [20, 60], ramp: 'inverse', digits: 0 },
];

export const metricById = (id: string) => METRICS.find((m) => m.id === id)!;

export function availableMetrics(points: Point[]): Metric[] {
  return METRICS.filter((m) => points.some((p) => m.get(p) !== undefined));
}

export function domainOf(m: Metric, points: Point[]): [number, number] {
  if (m.domain) return m.domain;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const v = m.get(p);
    if (v === undefined) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi - lo < 1e-6) hi = lo + 1;
  return [lo, hi];
}

type RGB = [number, number, number];
const QUALITY: RGB[] = [
  [220, 38, 38],
  [245, 158, 11],
  [234, 216, 52],
  [34, 197, 94],
];
const SEQUENTIAL: RGB[] = [
  [59, 130, 246],
  [6, 182, 212],
  [250, 204, 21],
  [239, 68, 68],
];

function lerpStops(stops: RGB[], f: number): RGB {
  const x = Math.min(1, Math.max(0, f)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = stops[i];
  const b = stops[i + 1];
  const k = x - i;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k].map(Math.round) as RGB;
}

export function colorFor(m: Metric, v: number | undefined, dom: [number, number]): RGB {
  if (v === undefined) return [150, 150, 150];
  const f = (v - dom[0]) / (dom[1] - dom[0]);
  if (m.ramp === 'quality') return lerpStops(QUALITY, f);
  if (m.ramp === 'inverse') return lerpStops(QUALITY, 1 - f);
  return lerpStops(SEQUENTIAL, f);
}

/**
 * Dégradé CSS de la légende. lo et hi (0–100 %) placent les bornes de l'échelle
 * sur la barre : avant lo et après hi, la couleur reste celle de la borne.
 */
export function gradientCss(m: Metric, lo = 0, hi = 100): string {
  const color = (f: number) => {
    const [r, g, b] = m.ramp === 'quality' ? lerpStops(QUALITY, f) : m.ramp === 'inverse' ? lerpStops(QUALITY, 1 - f) : lerpStops(SEQUENTIAL, f);
    return `rgb(${r},${g},${b})`;
  };
  const steps = [0, 0.25, 0.5, 0.75, 1].map((f) => `${color(f)} ${lo + f * (hi - lo)}%`);
  return `linear-gradient(90deg, ${color(0)} 0%, ${steps.join(', ')}, ${color(1)} 100%)`;
}
