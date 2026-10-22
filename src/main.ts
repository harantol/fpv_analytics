import './style.css';
import { parseEdgeTxCsv } from './parsers/edgetx';
import { parseSrt } from './parsers/srt';
import { applyGround, attachVideo, buildFlight, computeStats, guessVideoOffset, indexAt, type Flight, type Point, type Stats } from './analysis';
import { availableMetrics, domainOf, gradientCss, metricById, type Metric } from './metrics';
import { FlightMap, type Basemap } from './map3d';
import { Charts } from './charts';
import { fmt, formatDistance, formatDuration } from './format';
import { groundElevations } from './elevation';
import { generateDemo } from './demo';
import type { FlightLog, VideoLog } from './types';
import { isNative, setupNative } from './native';
import { compactEvents, detectEvents, type FlightEvent } from './events';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  log: null as FlightLog | null,
  video: null as VideoLog | null,
  flight: null as Flight | null,
  metric: null as Metric | null,
  t: 0,
  playing: false,
};

let map: FlightMap | null = null;
let charts: Charts | null = null;

function toast(msg: string, error = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout((toast as unknown as { h: number }).h);
  (toast as unknown as { h: number }).h = window.setTimeout(() => (el.hidden = true), 5000);
}

// ---------- Chargement des fichiers ----------

async function loadFiles(files: File[]) {
  const isSrt = (f: File) => /\.srt$/i.test(f.name);
  // Un nouveau log chargé sans .srt remplace aussi la vidéo précédente
  if (files.some((f) => !isSrt(f)) && !files.some(isSrt)) state.video = null;
  for (const file of files) {
    try {
      const text = await file.text();
      if (isSrt(file) || /-->/.test(text.slice(0, 500))) state.video = parseSrt(text, file.name);
      else state.log = parseEdgeTxCsv(text, file.name);
    } catch (e) {
      toast(`${file.name} : ${(e as Error).message}`, true);
    }
  }
  if (!state.log) {
    if (state.video) toast('Fichier vidéo chargé. Ajoutez maintenant le log télémétrie (.csv) de la radio.');
    return;
  }
  await showFlight();
}

async function showFlight() {
  const log = state.log!;
  const flight = buildFlight(log, state.video);
  state.flight = flight;
  if (state.video) attachVideo(flight, guessVideoOffset(flight));

  $('welcome').hidden = true;
  $('app').hidden = false;
  if (!map) {
    map = new FlightMap($('map'));
    map.onPick = (t) => setTime(t);
  }
  if (!charts) {
    charts = new Charts($('charts'));
    charts.onTime = (t) => setTime(t);
  }

  if (flight.gps.length === 0) toast("Aucune position GPS dans ce log : la carte restera vide.", true);

  // Relief sous la trace (pour la 3D et la hauteur sol)
  const grounds = await groundElevations(flight.gps.map((p) => ({ lat: p.lat!, lon: p.lon! })));
  const homeIdx = flight.home ? flight.gps.findIndex((p) => p.lat === flight.home!.lat && p.lon === flight.home!.lon) : -1;
  applyGround(flight, grounds, homeIdx >= 0 ? grounds[homeIdx] : grounds[0] ?? null);

  renderFiles();
  renderMetricSelect();
  renderStats(computeStats(flight));
  charts.setFlight(flight);
  await map.setFlight(flight, state.metric!);
  const events = compactEvents(detectEvents(flight.points));
  map.setEvents(events, gpsPointAt);
  renderEvents(events);
  renderLegend();

  const slider = $<HTMLInputElement>('time-slider');
  slider.max = String(flight.duration);
  $('video-sync').hidden = !state.video;
  $<HTMLInputElement>('offset-input').value = String(flight.videoOffset);
  setTime(firstFlyingTime(flight));
}

/** Premier instant où le drone s'éloigne du départ (pour ne pas démarrer au sol). */
function firstFlyingTime(f: Flight): number {
  const p = f.points.find((x) => (x.dist ?? 0) > 15 || (x.speed ?? 0) > 10);
  return p ? Math.max(0, p.t - 3) : 0;
}

function renderFiles() {
  const parts = [`<span class="chip">📈 ${state.log!.name}</span>`];
  if (state.flight?.log.start) parts.push(`<span class="chip">${state.flight.log.start.toLocaleString('fr-FR', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })}</span>`);
  parts.push(state.video ? `<span class="chip">🎥 ${state.video.name}</span>` : `<label class="chip add">+ Ajouter le .srt vidéo<input type="file" ${isNative ? '' : 'accept=".srt"'} hidden id="srt-input" /></label>`);
  $('files').innerHTML = parts.join('');
  const srtInput = document.getElementById('srt-input') as HTMLInputElement | null;
  srtInput?.addEventListener('change', () => srtInput.files && loadFiles([...srtInput.files]));
}

// ---------- Couleur de la trace ----------

function renderMetricSelect() {
  const f = state.flight!;
  const metrics = availableMetrics(f.points);
  const sel = $<HTMLSelectElement>('metric-select');
  const prev = state.metric?.id;
  sel.innerHTML = metrics.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  const preferred = [prev, 'rqly', 'relAlt', 'cellV'].find((id) => id && metrics.some((m) => m.id === id));
  state.metric = metricById(preferred ?? metrics[0]?.id ?? 'relAlt');
  sel.value = state.metric.id;
}

function renderLegend() {
  const m = state.metric!;
  const dom = domainOf(m, state.flight!.points);
  $('legend-bar').style.background = gradientCss(m);
  $('legend-min').textContent = fmt(dom[0], m.digits);
  $('legend-max').textContent = `${fmt(dom[1], m.digits)} ${m.unit}`;
}

// ---------- Événements ----------

function renderEvents(events: FlightEvent[]) {
  const el = $('events');
  el.hidden = events.length === 0;
  const icon: Record<FlightEvent['kind'], string> = {
    arm: '🟢', disarm: '⚪', failsafe: '⛔', linkLost: '📡', linkLow: '📶', rescue: '🛟', mode: '🎛️', rfmd: '📻', tpwr: '⚡', gap: '⏸️',
  };
  el.innerHTML =
    `<h3>Événements <span class="muted">(${events.length})</span></h3><div class="event-list">` +
    events
      .map(
        (e) =>
          `<button class="event ${e.severity}" data-t="${e.t}"><span class="mono">${formatDuration(e.t)}</span> ${icon[e.kind]} ${e.label}${
            e.duration !== undefined && e.kind !== 'gap' ? ` <span class="muted">${e.duration < 10 ? e.duration.toFixed(1) : Math.round(e.duration)} s</span>` : ''
          }</button>`,
      )
      .join('') +
    '</div>';
  el.querySelectorAll<HTMLButtonElement>('.event').forEach((b) => b.addEventListener('click', () => setTime(Number(b.dataset.t))));
}

// ---------- Statistiques ----------

function renderStats(s: Stats) {
  const f = state.flight!;
  type Card = { label: string; value: string; level?: 'ok' | 'warn' | 'bad'; sub?: string };
  const level = (v: number | undefined, warn: number, bad: number, higherBetter = true): Card['level'] => {
    if (v === undefined) return undefined;
    if (higherBetter) return v < bad ? 'bad' : v < warn ? 'warn' : 'ok';
    return v > bad ? 'bad' : v > warn ? 'warn' : 'ok';
  };
  const cards: Card[] = [
    { label: 'Durée', value: formatDuration(s.duration) },
    { label: 'Distance max', value: formatDistance(s.maxDist) },
    { label: 'Distance parcourue', value: formatDistance(s.totalDist) },
    { label: 'Altitude max', value: fmt(s.maxAlt, 0, 'm'), sub: 'par rapport au départ' },
    { label: 'Vitesse max', value: fmt(s.maxSpeed, 0, 'km/h') },
  ];
  if (s.minVoltage !== undefined)
    cards.push({
      label: 'Tension min',
      value: s.minCellV !== undefined ? fmt(s.minCellV, 2, 'V/él.') : fmt(s.minVoltage, 1, 'V'),
      sub: f.cells ? `${fmt(s.minVoltage, 1, 'V')} · ${f.cells}S estimé` : undefined,
      level: level(s.minCellV, 3.3, 3.0),
    });
  if (s.usedMah !== undefined) cards.push({ label: 'Consommé', value: fmt(s.usedMah, 0, 'mAh'), sub: s.maxCurrent !== undefined ? `pic ${fmt(s.maxCurrent, 1, 'A')}` : undefined });
  if (s.minRqly !== undefined) cards.push({ label: 'RQly min', value: fmt(s.minRqly, 0, '%'), level: level(s.minRqly, 70, 30) });
  if (s.lowLinkSeconds !== undefined) cards.push({ label: 'Temps RQly < 50 %', value: formatDuration(s.lowLinkSeconds), level: s.lowLinkSeconds > 5 ? 'bad' : s.lowLinkSeconds > 0 ? 'warn' : 'ok' });
  if (s.failsafes !== undefined) cards.push({ label: 'Pertes de liaison', value: String(s.failsafes), sub: 'RQly à 0 %', level: s.failsafes > 0 ? 'bad' : 'ok' });
  if (s.minRssi !== undefined) cards.push({ label: 'RSSI min', value: fmt(s.minRssi, 0, 'dBm'), level: level(s.minRssi, -100, -108) });
  if (s.maxTpwr !== undefined) cards.push({ label: 'Puissance max', value: fmt(s.maxTpwr, 0, 'mW') });
  if (s.minVideoSignal !== undefined) cards.push({ label: 'Signal vidéo min', value: `${s.minVideoSignal}/4`, level: level(s.minVideoSignal, 2, 1) });
  if (s.avgBitrate !== undefined) cards.push({ label: 'Débit vidéo moyen', value: fmt(s.avgBitrate, 1, 'Mbps') });
  if (s.maxDelay !== undefined) cards.push({ label: 'Latence max', value: fmt(s.maxDelay, 0, 'ms'), level: level(s.maxDelay, 40, 60, false) });

  $('stats').innerHTML = cards
    .map((c) => `<div class="stat card ${c.level ?? ''}"><div class="label">${c.label}</div><div class="value">${c.value}</div>${c.sub ? `<div class="sub">${c.sub}</div>` : ''}</div>`)
    .join('');
}

// ---------- Lecture / position courante ----------

function pointAt(t: number): Point | null {
  const f = state.flight;
  if (!f || f.points.length === 0) return null;
  return f.points[indexAt(f.points, t)];
}

function gpsPointAt(t: number): Point | null {
  const f = state.flight;
  if (!f || f.gps.length === 0) return null;
  return f.gps[indexAt(f.gps, t)];
}

function setTime(t: number) {
  const f = state.flight;
  if (!f) return;
  state.t = Math.min(f.duration, Math.max(0, t));
  $<HTMLInputElement>('time-slider').value = String(state.t);
  $('time-label').textContent = `${formatDuration(state.t)} / ${formatDuration(f.duration)}`;
  map?.setCurrent(gpsPointAt(state.t));
  charts?.setTime(state.t);
  renderHud(pointAt(state.t));
}

function renderHud(p: Point | null) {
  if (!p) return;
  const rssi = p.rssi1 === undefined ? p.rssi2 : p.rssi2 === undefined || p.rssi2 === 0 ? p.rssi1 : Math.max(p.rssi1, p.rssi2);
  const rows: [string, string, string?][] = [
    ['Dist', formatDistance(p.dist)],
    ['Alt', fmt(p.relAlt, 0, 'm'), p.agl !== undefined ? `sol ${fmt(p.agl, 0, 'm')}` : undefined],
    ['Vit', fmt(p.speed, 0, 'km/h')],
    ['Batt', p.cellV !== undefined ? fmt(p.cellV, 2, 'V') : fmt(p.voltage, 1, 'V'), [p.voltage !== undefined && p.cellV !== undefined ? fmt(p.voltage, 1, 'V') : '', p.batPct !== undefined ? `${p.batPct}%` : ''].filter(Boolean).join(' · ') || undefined],
    ['LQ', fmt(p.rqly, 0, '%'), rssi !== undefined ? `${rssi} dBm` : undefined],
    ['TX', fmt(p.tpwr, 0, 'mW'), p.rfmd],
  ];
  if (state.video) rows.push(['Vidéo', p.video?.signal !== undefined ? `${p.video.signal}/4` : '–', p.video ? [fmt(p.video.bitrate, 1, 'Mbps'), fmt(p.video.delay, 0, 'ms')].join(' · ') : 'hors vidéo']);
  if (p.flightMode) rows.push(['Mode', p.flightMode]);
  $('hud').innerHTML = rows
    .filter((r) => r[1] !== '–' || r[2])
    .map(([k, v, sub]) => `<div><span class="k">${k}</span><span class="v">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`)
    .join('');
}

let lastFrame = 0;
function tick(now: number) {
  if (!state.playing || !state.flight) return;
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  const speed = Number($<HTMLSelectElement>('speed-select').value);
  const next = state.t + dt * speed;
  if (next >= state.flight.duration) {
    setTime(state.flight.duration);
    setPlaying(false);
    return;
  }
  setTime(next);
  requestAnimationFrame(tick);
}

function setPlaying(on: boolean) {
  state.playing = on;
  $('play-btn').textContent = on ? '❚❚' : '▶';
  if (on) {
    if (state.flight && state.t >= state.flight.duration - 0.1) setTime(0);
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
}

// ---------- Événements ----------

$<HTMLInputElement>('file-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) loadFiles([...input.files]);
  input.value = '';
});

$('demo-btn').addEventListener('click', () => {
  const d = generateDemo();
  state.log = parseEdgeTxCsv(d.csv, 'Démo – lac d\'Annecy.csv');
  state.video = parseSrt(d.srt, 'Démo – DJI O3.srt');
  showFlight();
});

$<HTMLSelectElement>('metric-select').addEventListener('change', (e) => {
  state.metric = metricById((e.target as HTMLSelectElement).value);
  map?.setMetric(state.metric);
  renderLegend();
});

$<HTMLSelectElement>('basemap-select').addEventListener('change', (e) => map?.setBasemap((e.target as HTMLSelectElement).value as Basemap));
$('fit-btn').addEventListener('click', () => map?.fit());
$<HTMLInputElement>('time-slider').addEventListener('input', (e) => setTime(Number((e.target as HTMLInputElement).value)));
$('play-btn').addEventListener('click', () => setPlaying(!state.playing));
$<HTMLInputElement>('follow-check').addEventListener('change', (e) => map?.setFollow((e.target as HTMLInputElement).checked));

function setOffset(off: number) {
  const f = state.flight;
  if (!f) return;
  attachVideo(f, off);
  $<HTMLInputElement>('offset-input').value = String(off);
  renderStats(computeStats(f));
  charts?.setFlight(f);
  if (state.metric) map?.setMetric(state.metric);
  setTime(state.t);
}
$<HTMLInputElement>('offset-input').addEventListener('change', (e) => setOffset(Number((e.target as HTMLInputElement).value) || 0));
document.querySelectorAll<HTMLButtonElement>('#video-sync [data-off]').forEach((b) =>
  b.addEventListener('click', () => setOffset((state.flight?.videoOffset ?? 0) + Number(b.dataset.off))),
);
$('offset-auto').addEventListener('click', () => state.flight && setOffset(guessVideoOffset(state.flight)));

document.addEventListener('keydown', (e) => {
  if (!state.flight || (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if (e.code === 'ArrowRight') setTime(state.t + (e.shiftKey ? 10 : 1));
  else if (e.code === 'ArrowLeft') setTime(state.t - (e.shiftKey ? 10 : 1));
});

// Glisser-déposer
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('drop-overlay').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) loadFiles(files);
});

// Aide « Configurer mon drone »
const help = $<HTMLDialogElement>('help');
document.querySelectorAll('[data-open-help]').forEach((b) => b.addEventListener('click', () => help.showModal()));
$('help-close').addEventListener('click', () => help.close());
help.addEventListener('click', (e) => e.target === help && help.close());

$('app-version').textContent = `v${__APP_VERSION__}`;
setupNative({ isPlaying: () => state.playing, stop: () => setPlaying(false) });

if (new URLSearchParams(location.search).has('demo')) $('demo-btn').click();
