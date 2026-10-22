import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Flight, Point } from './analysis';
import { formatDuration } from './format';

interface SeriesDef {
  label: string;
  unit: string;
  color: string;
  get: (p: Point) => number | undefined;
  /** Axe : 0 = gauche, 1 = droite */
  axis?: 0 | 1;
  dash?: number[];
}

interface ChartDef {
  id: string;
  title: string;
  series: SeriesDef[];
  /** Plages fixes par axe */
  ranges?: [([number, number] | null)?, ([number, number] | null)?];
}

const bestRssi = (p: Point) => {
  if (p.rssi1 === undefined) return p.rssi2;
  if (p.rssi2 === undefined || p.rssi2 === 0) return p.rssi1;
  return Math.max(p.rssi1, p.rssi2);
};

export const CHARTS: ChartDef[] = [
  {
    id: 'battery',
    title: 'Batterie',
    series: [
      { label: 'Tension / élément', unit: 'V', color: '#22c55e', get: (p) => p.cellV },
      { label: 'Tension', unit: 'V', color: '#22c55e', get: (p) => (p.cellV === undefined ? p.voltage : undefined) },
      { label: 'Courant', unit: 'A', color: '#f97316', get: (p) => p.current, axis: 1 },
      { label: 'Batterie', unit: '%', color: '#a3a3a3', get: (p) => p.batPct, axis: 1, dash: [4, 4] },
    ],
  },
  {
    id: 'radio',
    title: 'Liaison radio',
    series: [
      { label: 'RQly', unit: '%', color: '#3b82f6', get: (p) => p.rqly },
      { label: 'TQly', unit: '%', color: '#93c5fd', get: (p) => p.tqly, dash: [4, 4] },
      { label: 'RSSI', unit: 'dBm', color: '#eab308', get: bestRssi, axis: 1 },
      { label: 'SNR', unit: 'dB', color: '#a855f7', get: (p) => p.rsnr, axis: 1, dash: [2, 3] },
    ],
    ranges: [[0, 105], null],
  },
  {
    id: 'power',
    title: "Puissance d'émission",
    series: [{ label: 'TPWR', unit: 'mW', color: '#ef4444', get: (p) => p.tpwr }],
  },
  {
    id: 'video',
    title: 'Liaison vidéo',
    series: [
      { label: 'Débit', unit: 'Mbps', color: '#06b6d4', get: (p) => p.video?.bitrate },
      { label: 'Signal', unit: '/4', color: '#22c55e', get: (p) => p.video?.signal, axis: 1 },
      { label: 'Latence', unit: 'ms', color: '#f43f5e', get: (p) => p.video?.delay, dash: [4, 4] },
      { label: 'Images perdues', unit: '%', color: '#f43f5e', get: (p) => p.video?.frameLoss, axis: 1 },
    ],
  },
  {
    id: 'flight',
    title: 'Altitude & vitesse',
    series: [
      { label: 'Altitude', unit: 'm', color: '#38bdf8', get: (p) => p.relAlt },
      { label: 'Hauteur sol', unit: 'm', color: '#10b981', get: (p) => p.agl, dash: [4, 4] },
      { label: 'Distance', unit: 'km', color: '#e879f9', get: (p) => (p.dist === undefined ? undefined : p.dist / 1000), axis: 1, dash: [2, 3] },
      { label: 'Vitesse', unit: 'km/h', color: '#facc15', get: (p) => p.speed, axis: 1 },
    ],
  },
];

export class Charts {
  private plots: uPlot[] = [];
  private flight: Flight | null = null;
  private lastT = 0;
  onTime: ((t: number) => void) | null = null;

  constructor(private container: HTMLElement) {
    new ResizeObserver(() => this.resize()).observe(container);
  }

  private width() {
    const first = this.container.querySelector('.chart-body') as HTMLElement | null;
    return Math.max(260, (first?.clientWidth ?? this.container.clientWidth) - 2);
  }

  private resize() {
    const w = this.width();
    for (const p of this.plots) p.setSize({ width: w, height: p.height });
  }

  setFlight(flight: Flight) {
    this.flight = flight;
    for (const p of this.plots) p.destroy();
    this.plots = [];
    this.container.innerHTML = '';
    const pts = flight.points;
    const xs = pts.map((p) => p.t);

    for (const def of CHARTS) {
      const series = def.series.filter((s) => pts.some((p) => s.get(p) !== undefined));
      if (series.length === 0) continue;

      const card = document.createElement('section');
      card.className = 'chart card';
      card.innerHTML = `<h3>${def.title}</h3><div class="chart-body"></div>`;
      this.container.appendChild(card);
      const body = card.querySelector('.chart-body') as HTMLElement;

      const data: uPlot.AlignedData = [xs, ...series.map((s) => pts.map((p) => s.get(p) ?? null))];
      const hasRight = series.some((s) => s.axis === 1);
      const unitOf = (axis: 0 | 1) => [...new Set(series.filter((s) => (s.axis ?? 0) === axis).map((s) => s.unit))].join(' · ');
      const axisColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
      const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() || '#8883';

      const opts: uPlot.Options = {
        width: this.width(),
        height: 190,
        cursor: {
          sync: { key: 'fpv', setSeries: false },
          drag: { x: true, y: false, setScale: true },
        },
        legend: { live: true },
        scales: {
          x: { time: false },
          y: def.ranges?.[0] ? { range: def.ranges[0] } : {},
          y2: def.ranges?.[1] ? { range: def.ranges[1] } : {},
        },
        axes: [
          { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: gridColor }, values: (_u, v) => v.map((x) => formatDuration(x)) },
          { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: gridColor }, label: unitOf(0), size: 48 },
          ...(hasRight ? [{ scale: 'y2', side: 1 as const, stroke: axisColor, grid: { show: false }, ticks: { stroke: gridColor }, label: unitOf(1), size: 48 }] : []),
        ],
        series: [
          { label: 'Temps', value: (_u, v) => (v == null ? '–' : formatDuration(v)) },
          ...series.map((s) => ({
            label: s.label,
            stroke: s.color,
            width: 1.5,
            dash: s.dash,
            scale: s.axis === 1 ? 'y2' : 'y',
            spanGaps: false,
            value: (_u: uPlot, v: number | null) => (v == null ? '–' : `${v.toFixed(Math.abs(v) < 10 && s.unit !== '%' ? 2 : 0)} ${s.unit}`),
          })),
        ],
        hooks: { setScale: [() => this.setTime(this.lastT)] },
      };
      const plot = new uPlot(opts, data, body);
      // Un clic dans le graphique place la lecture à cet instant
      plot.over.addEventListener('click', () => {
        const idx = plot.cursor.idx;
        if (idx != null && this.onTime) this.onTime(xs[idx]);
      });
      plot.over.addEventListener('dblclick', () => this.resetZoom());
      this.plots.push(plot);
    }
  }

  resetZoom() {
    if (!this.flight) return;
    for (const p of this.plots) p.setScale('x', { min: 0, max: this.flight.duration });
  }

  /** Affiche un repère vertical à l'instant t sur tous les graphiques. */
  setTime(t: number) {
    this.lastT = t;
    for (const p of this.plots) {
      const left = p.valToPos(t, 'x');
      let marker = p.over.querySelector('.time-marker') as HTMLElement | null;
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'time-marker';
        p.over.appendChild(marker);
      }
      marker.style.left = `${left}px`;
      marker.style.display = left >= 0 && left <= p.over.clientWidth ? 'block' : 'none';
    }
  }
}
