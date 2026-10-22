import './style.css';
import { parseEdgeTxCsv } from './parsers/edgetx';
import { parseSrt } from './parsers/srt';
import { parseDvr } from './parsers/dvr';
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
import { deleteFlight, flightKey, fromStoredVideo, getFlight, listFlights, requestPersistence, saveFlight, toStoredVideo, updateFlight, updateFlightVideo } from './library';
import { pairVideos, toNaiveLocal } from './pairing';
import { setupOfflineDialog } from './offline-ui';
import { VideoPlayer } from './videoplayer';
import { getElrsVersion, packetRate, setElrsVersion, type ElrsVersion } from './elrs';
import { dvrHints, mergeOsdBitrate } from './osd-parse';
import type { OsdProbe } from './osd-ocr';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  /** Id du vol en bibliothèque (null pour la démo). */
  currentId: null as number | null,
  log: null as FlightLog | null,
  video: null as VideoLog | null,
  flight: null as Flight | null,
  metric: null as Metric | null,
  t: 0,
  playing: false,
  /** Échelles de couleur réglées à la main, par mesure (pour le vol affiché). */
  domains: new Map<string, [number, number]>(),
};

let map: FlightMap | null = null;
let charts: Charts | null = null;
const player = new VideoPlayer($('video-panel'));
/** Fichiers vidéo choisis pendant la session (jamais copiés : lus directement). */
const videoFiles = new Map<string, File>();

/** Lecture du débit sur l'OSD en cours (une à la fois). */
let osdJob: { name: string; abort: AbortController; label: string } | null = null;

let toastTimer = 0;
/** Message éphémère, avec éventuellement un bouton d'action. */
function toast(msg: string, error = false, action?: { label: string; run: () => void }) {
  const el = $('toast');
  $('toast-msg').textContent = msg;
  const btn = $('toast-action') as HTMLButtonElement;
  btn.hidden = !action;
  btn.textContent = action?.label ?? '';
  btn.onclick = action
    ? () => {
        el.hidden = true;
        action.run();
      }
    : null;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), action ? 12000 : 5000);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- Import des fichiers ----------

interface ParsedVideo {
  video: VideoLog;
  /** Début / fin de l'enregistrement (ms, heure locale naïve), estimés via la date du fichier. */
  start: number;
  end: number;
}

const isVideoFile = (f: File) => /\.(mp4|mov)$/i.test(f.name) || f.type.startsWith('video/');

/**
 * Lit un fichier vidéo : .srt (anciennes lunettes DJI, Walksnail) ou
 * enregistrement .mp4 des lunettes (Goggles 3), dont on n'analyse que l'index.
 */
async function parseVideoFile(file: File): Promise<ParsedVideo> {
  if (isVideoFile(file)) {
    const r = await parseDvr(file);
    // Heure de début : nom de fichier DJI ou date du MP4, sinon date de modification du fichier
    const start = r.start ?? toNaiveLocal(file.lastModified) - r.duration * 1000;
    return { video: r.video, start, end: start + r.duration * 1000 };
  }
  const video = parseSrt(await file.text(), file.name);
  const end = toNaiveLocal(file.lastModified);
  const dur = video.samples[video.samples.length - 1].t * 1000;
  return { video, start: end - dur, end };
}

/** Décalage vidéo : par la courbe de tension si possible, sinon par l'heure des fichiers. */
function videoOffsetFor(flight: Flight, pv: ParsedVideo | null): number {
  if (!pv) return 0;
  if (pv.video.fields.has('droneBat')) return guessVideoOffset(flight);
  const logStart = flight.log.start?.getTime();
  return logStart ? Math.round((pv.start - logStart) / 1000) : 0;
}

async function importFiles(files: File[]) {
  const logs: { id: string; log: FlightLog; csv: string }[] = [];
  const videos: (ParsedVideo & { id: string })[] = [];
  if (files.some(isVideoFile)) toast('Analyse de la vidéo…');
  for (const [i, file] of files.entries()) {
    try {
      if (isVideoFile(file) || /\.srt$/i.test(file.name)) {
        if (isVideoFile(file)) videoFiles.set(file.name, file);
        videos.push({ id: `v${i}`, ...(await parseVideoFile(file)) });
        continue;
      }
      const text = await file.text();
      if (/-->/.test(text.slice(0, 500))) videos.push({ id: `v${i}`, ...(await parseVideoFile(file)) });
      else logs.push({ id: `l${i}`, log: parseEdgeTxCsv(text, file.name), csv: text });
    } catch (e) {
      toast(`${file.name} : ${(e as Error).message}`, true);
    }
  }

  // Vidéo seule : on l'ajoute au vol affiché
  if (logs.length === 0) {
    if (videos.length && state.log) {
      state.video = videos[0].video;
      const offset = state.flight ? videoOffsetFor(buildFlight(state.log, state.video), videos[0]) : 0;
      if (state.currentId !== null) await updateFlight(state.currentId, { video: toStoredVideo(videos[0].video, videos[0].start), videoOffset: offset });
      await showFlight(offset);
    } else if (videos.length) {
      toast('Ouvrez d\'abord le log radio (.csv), puis ajoutez la vidéo.');
    }
    return;
  }

  // Association vidéo ↔ log : évidente s'il n'y a qu'un log, sinon par l'heure
  const spans = logs.map(({ id, log }) => {
    const start = log.start?.getTime() ?? 0;
    return { id, start, end: start + log.samples[log.samples.length - 1].t * 1000 };
  });
  const pairs = logs.length === 1 ? new Map(videos.slice(0, 1).map((v) => [v.id, logs[0].id])) : pairVideos(spans.filter((s) => s.start > 0), videos);

  let lastId = -1;
  for (const { id, log, csv } of logs) {
    const pv = videos.find((v) => pairs.get(v.id) === id) ?? null;
    const flight = buildFlight(log, pv?.video ?? null);
    const videoOffset = videoOffsetFor(flight, pv);
    const st = computeStats(flight);
    lastId = await saveFlight({
      key: flightKey(csv),
      name: log.name,
      date: log.start?.getTime() ?? toNaiveLocal(Date.now()),
      csv,
      video: pv ? toStoredVideo(pv.video, pv.start) : undefined,
      videoOffset,
      summary: { duration: st.duration, maxDist: st.maxDist, totalDist: st.totalDist, maxAlt: st.maxAlt, minRqly: st.minRqly, minCellV: st.minCellV, failsafes: st.failsafes },
    });
  }
  requestPersistence();
  const unpaired = videos.length - pairs.size;
  if (unpaired > 0) toast(`${unpaired} vidéo(s) sans log radio correspondant.`);
  if (logs.length === 1) await openFlight(lastId);
  else {
    toast(`${logs.length} vols importés.`);
    await showLibrary();
  }
}

async function openFlight(id: number) {
  const f = await getFlight(id);
  if (!f) return;
  try {
    state.currentId = id;
    state.log = parseEdgeTxCsv(f.csv, f.name);
    state.video = f.video ? fromStoredVideo(f.video) : null;
    await showFlight(f.videoOffset ?? 0);
  } catch (e) {
    toast(`${f.name} : ${(e as Error).message}`, true);
  }
}

// ---------- Bibliothèque ----------

async function showLibrary() {
  setPlaying(false);
  $('app').hidden = true;
  $('welcome').hidden = false;
  const flights = await listFlights();
  const el = $('library');
  $('intro').hidden = flights.length > 0;
  $('intro-short').hidden = flights.length === 0;
  if (flights.length === 0) {
    el.innerHTML = '';
    return;
  }
  const fmtDate = (ms: number) => new Date(ms).toLocaleString('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  el.innerHTML =
    `<h2>Mes vols <span class="muted">(${flights.length})</span></h2>` +
    flights
      .map((f) => {
        const s = f.summary;
        const lq = s.minRqly === undefined ? '' : `<span class="badge ${s.minRqly < 30 ? 'bad' : s.minRqly < 70 ? 'warn' : 'ok'}">LQ min ${s.minRqly} %</span>`;
        const fs = s.failsafes ? `<span class="badge bad">${s.failsafes} perte${s.failsafes > 1 ? 's' : ''} de liaison</span>` : '';
        return `<div class="flight-card card" data-id="${f.id}">
          <button class="flight-open" data-id="${f.id}">
            <div class="flight-date">${fmtDate(f.date)}</div>
            <div class="flight-name">${escapeHtml(f.name)}${f.video ? ' · 🎥' : ''}</div>
            <div class="flight-stats">
              <span>⏱ ${formatDuration(s.duration)}</span>
              <span>↔ ${formatDistance(s.maxDist)}</span>
              <span>∑ ${formatDistance(s.totalDist)}</span>
              ${s.maxAlt !== undefined ? `<span>↑ ${Math.round(s.maxAlt)} m</span>` : ''}
            </div>
            <div class="flight-badges">${lq}${fs}</div>
          </button>
          <button class="flight-delete btn small" data-id="${f.id}" aria-label="Supprimer">🗑</button>
        </div>`;
      })
      .join('');
  el.querySelectorAll<HTMLButtonElement>('.flight-open').forEach((b) => b.addEventListener('click', () => openFlight(Number(b.dataset.id))));
  el.querySelectorAll<HTMLButtonElement>('.flight-delete').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer ce vol de la bibliothèque ?')) return;
      await deleteFlight(Number(b.dataset.id));
      showLibrary();
    }),
  );
}

// ---------- Affichage d'un vol ----------

async function showFlight(videoOffset: number) {
  const log = state.log!;
  const flight = buildFlight(log, state.video, videoOffset);
  applyPacketRate(flight);
  state.domains.clear();
  state.flight = flight;

  $('welcome').hidden = true;
  $('app').hidden = false;
  window.scrollTo(0, 0);
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
  renderFlightEvents();
  renderLegend();

  const slider = $<HTMLInputElement>('time-slider');
  slider.max = String(flight.duration);
  $('video-sync').hidden = !state.video;
  $<HTMLInputElement>('offset-input').value = String(flight.videoOffset);
  attachPlayer();
  startOsdRead();
  // Avec la vidéo, on démarre là où elle commence
  setTime(player.loaded ? Math.max(0, flight.videoOffset) : firstFlyingTime(flight));
}

/** Premier instant où le drone s'éloigne du départ (pour ne pas démarrer au sol). */
function firstFlyingTime(f: Flight): number {
  const p = f.points.find((x) => (x.dist ?? 0) > 15 || (x.speed ?? 0) > 10);
  return p ? Math.max(0, p.t - 3) : 0;
}

function renderFiles() {
  const parts = [`<button id="back-btn" class="chip back">← Mes vols</button>`, `<span class="chip">📈 ${escapeHtml(state.log!.name)}</span>`];
  if (state.flight?.log.start) parts.push(`<span class="chip">${state.flight.log.start.toLocaleString('fr-FR', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })}</span>`);
  const v = state.video;
  if (!v) parts.push(`<label class="chip add">+ Ajouter la vidéo<input type="file" ${isNative ? '' : 'accept=".srt,.mp4,.mov"'} hidden id="srt-input" /></label>`);
  else if (/\.(mp4|mov)$/i.test(v.name) && !videoFiles.has(v.name))
    // Vol rouvert depuis la bibliothèque : la vidéo n'est pas gardée, on la redemande pour la regarder
    parts.push(`<label class="chip add">🎥 ${escapeHtml(v.name)} · ▶ Ouvrir la vidéo<input type="file" ${isNative ? '' : 'accept=".mp4,.mov"'} hidden id="video-open" /></label>`);
  else parts.push(`<span class="chip">🎥 ${escapeHtml(v.name)}</span>`);
  if (osdJob && osdJob.name === v?.name)
    parts.push(`<button id="osd-cancel" class="chip osd" title="Annuler">🔎 Débit OSD : <b>${osdJob.label}</b> ✕</button>`);
  else if (v?.osd) parts.push(`<span class="chip">📶 Débit lu sur l'OSD</span>`);
  $('files').innerHTML = parts.join('');
  document.getElementById('osd-cancel')?.addEventListener('click', () => osdJob?.abort.abort());
  const videoOpen = document.getElementById('video-open') as HTMLInputElement | null;
  videoOpen?.addEventListener('change', () => {
    const file = videoOpen.files?.[0];
    if (!file) return;
    if (file.name === state.video?.name) {
      videoFiles.set(file.name, file);
      renderFiles();
      attachPlayer();
      startOsdRead();
      setTime(state.t);
    } else importFiles([file]);
  });
  $('back-btn').addEventListener('click', () => showLibrary());
  const srtInput = document.getElementById('srt-input') as HTMLInputElement | null;
  srtInput?.addEventListener('change', () => srtInput.files && importFiles([...srtInput.files]));
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

/** Échelle de couleur actuelle : réglée à la main, ou null (automatique). */
function currentDomain(): [number, number] | null {
  return state.metric ? state.domains.get(state.metric.id) ?? null : null;
}

/** Étendue des curseurs de la légende : échelle automatique et valeurs du vol. */
function legendExtent(): [number, number] {
  const m = state.metric!;
  const auto = domainOf(m, state.flight!.points);
  let lo = auto[0];
  let hi = auto[1];
  for (const p of state.flight!.points) {
    const v = m.get(p);
    if (v === undefined) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

function renderLegend() {
  const m = state.metric!;
  const [eLo, eHi] = legendExtent();
  const dom = currentDomain() ?? domainOf(m, state.flight!.points);
  const pos = (v: number) => Math.min(1000, Math.max(0, Math.round(((v - eLo) / (eHi - eLo)) * 1000)));
  $<HTMLInputElement>('legend-lo').value = String(pos(dom[0]));
  $<HTMLInputElement>('legend-hi').value = String(pos(dom[1]));
  $('legend-bar').style.background = gradientCss(m, pos(dom[0]) / 10, pos(dom[1]) / 10);
  $('legend-min').textContent = fmt(dom[0], m.digits);
  $('legend-max').textContent = `${fmt(dom[1], m.digits)} ${m.unit}`;
  $('legend-reset').hidden = !currentDomain();
}

let legendFrame = 0;
/** Une poignée de la légende a bougé : nouvelle échelle pour la carte. */
function onLegendInput(which: 'lo' | 'hi') {
  const m = state.metric;
  if (!m || !state.flight) return;
  const [eLo, eHi] = legendExtent();
  const lo = $<HTMLInputElement>('legend-lo');
  const hi = $<HTMLInputElement>('legend-hi');
  // Les poignées ne se croisent pas (écart minimal de 2 %)
  if (Number(hi.value) - Number(lo.value) < 20) {
    if (which === 'lo') lo.value = String(Number(hi.value) - 20);
    else hi.value = String(Number(lo.value) + 20);
  }
  const val = (x: string) => eLo + (Number(x) / 1000) * (eHi - eLo);
  state.domains.set(m.id, [val(lo.value), val(hi.value)]);
  renderLegend();
  cancelAnimationFrame(legendFrame);
  legendFrame = requestAnimationFrame(() => map?.setMetric(m, currentDomain()));
}

// ---------- Débit de paquets ELRS ----------

function applyPacketRate(f: Flight) {
  const v = getElrsVersion();
  for (const p of f.points) {
    const r = packetRate(p.rfmd, v);
    if (r) p.pktRate = r.hz;
    else delete p.pktRate;
  }
}

/**
 * Débit le plus utilisé pendant le vol, et les autres débits rencontrés.
 * Toujours présent dès que le log contient RFMD (pour garder le choix de version).
 */
function packetRateSummary(f: Flight): { main: string; detail: string } | null {
  const v = getElrsVersion();
  const time = new Map<string, number>();
  let detail = '';
  let unknown = false;
  for (let i = 1; i < f.points.length; i++) {
    const raw = f.points[i].rfmd;
    if (raw === undefined) continue;
    const r = packetRate(raw, v);
    if (!r) unknown = true;
    const label = r?.label ?? `RFMD ${raw}`;
    time.set(label, (time.get(label) ?? 0) + (f.points[i].t - f.points[i - 1].t));
    detail ||= r?.detail ?? '';
  }
  if (!time.size) return null;
  const sorted = [...time].sort((a, b) => b[1] - a[1]);
  const others = sorted.slice(1).map(([l]) => l);
  const note = unknown ? `valeur inconnue en ELRS ${v}.x` : others.length ? `aussi ${others.join(', ')}` : detail;
  return { main: sorted[0][0], detail: note };
}

function renderFlightEvents() {
  const f = state.flight!;
  const v = getElrsVersion();
  const events = compactEvents(detectEvents(f.points)).map((e) => {
    if (e.kind !== 'rfmd') return e;
    const from = packetRate(e.from, v)?.label ?? e.from;
    const to = packetRate(e.to, v)?.label ?? e.to;
    return { ...e, label: `Débit ELRS ${from} → ${to}` };
  });
  map?.setEvents(events, gpsPointAt);
  renderEvents(events);
}

/** Changement de version d'ELRS : les débits sont recalculés partout. */
function onElrsVersion(v: ElrsVersion) {
  const f = state.flight;
  setElrsVersion(v);
  if (!f) return;
  applyPacketRate(f);
  renderMetricSelect();
  renderStats(computeStats(f));
  charts?.setFlight(f);
  renderFlightEvents();
  if (state.metric) map?.setMetric(state.metric, currentDomain());
  renderLegend();
  setTime(state.t);
}

// ---------- Événements ----------

function renderEvents(events: FlightEvent[]) {
  const el = $('events');
  el.hidden = events.length === 0;
  const icon: Record<FlightEvent['kind'], string> = {
    arm: '🟢', disarm: '⚪', failsafe: '⛔', linkLost: '📡', linkLow: '📶', rescue: '🛟', mode: '🎛️', rfmd: '📻', tpwr: '⚡', gap: '⏸️', videoLoss: '🎥',
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
  if (f.gpsInterval !== null)
    cards.push({
      label: 'Fréquence GPS',
      value: `1 pos. / ${f.gpsInterval.toFixed(1).replace('.', ',')} s`,
      sub: `${f.gpsFixes} positions reçues${f.gpsInterval > 1.5 ? ' · voir l\'aide' : ''}`,
      level: f.gpsInterval > 3 ? 'bad' : f.gpsInterval > 1.5 ? 'warn' : 'ok',
    });
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
  const rates = packetRateSummary(f);
  if (rates)
    cards.push({
      label: 'Débit de paquets ELRS',
      value: rates.main,
      sub: `${rates.detail} · <select class="elrs-version" aria-label="Version d'ELRS"><option value="3"${getElrsVersion() === 3 ? ' selected' : ''}>ELRS 3.x</option><option value="4"${getElrsVersion() === 4 ? ' selected' : ''}>ELRS 4.x</option></select>`,
    });
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

/**
 * Lit le débit affiché sur l'OSD de la vidéo (bien plus juste que l'estimation
 * depuis le fichier), en arrière-plan, puis met à jour courbes, stats et bibliothèque.
 */
async function startOsdRead() {
  const video = state.video;
  const file = video ? videoFiles.get(video.name) : undefined;
  if (!video || !file || video.osd || osdJob) return;
  const job = { name: video.name, abort: new AbortController(), label: 'préparation…' };
  osdJob = job;
  const flightId = state.currentId;
  renderFiles();
  try {
    const { readOsdBitrate } = await import('./osd-ocr');
    const { readings, probe } = await readOsdBitrate(file, {
      signal: job.abort.signal,
      hints: dvrHints(video.samples),
      onProgress: ({ stage, done, total }) => {
        const label =
          stage === 'video'
            ? 'chargement de la vidéo…'
            : stage === 'engine'
              ? 'démarrage du moteur de lecture…'
              : stage === 'locate'
                ? `recherche de « Mbps » (${done + 1}/${total})…`
                : `${Math.floor((100 * done) / total)} %`;
        if (label !== job.label) {
          job.label = label;
          if (state.video?.name === job.name) renderFiles();
        }
      },
    });
    if (job.abort.signal.aborted) return;
    if (!readings || readings.length < 3) {
      const dark = probe && probe.brightness < 10;
      toast(
        dark
          ? "Les images lues dans la vidéo sont noires : débit OSD illisible, l'estimation est conservée."
          : "Débit introuvable sur l'OSD de la vidéo : l'estimation est conservée.",
        Boolean(dark),
        probe ? { label: "Voir l'image", run: () => showOsdProbe(probe) } : undefined,
      );
      return;
    }
    video.samples = mergeOsdBitrate(video.samples, readings);
    video.osd = true;
    if (flightId !== null) await updateFlightVideo(flightId, video);
    if (state.video === video && state.flight) {
      attachVideo(state.flight, state.flight.videoOffset);
      renderStats(computeStats(state.flight));
      charts?.setFlight(state.flight);
      if (state.metric) map?.setMetric(state.metric, currentDomain());
      setTime(state.t);
    }
    toast(`Débit lu sur l'OSD (${readings.length} mesures).`);
  } catch (e) {
    toast(`Lecture de l'OSD impossible : ${(e as Error).message}`, true);
  } finally {
    osdJob = null;
    if (state.video?.name === job.name) renderFiles();
  }
}

/** Montre l'image analysée quand « Mbps » n'a pas été trouvé. */
function showOsdProbe(p: OsdProbe) {
  ($('osd-probe-raw') as HTMLImageElement).src = p.raw;
  ($('osd-probe-bw') as HTMLImageElement).src = p.bw;
  $('osd-probe-info').textContent = `Vidéo ${p.width}×${p.height}, luminosité moyenne ${Math.round(p.brightness)}/255. « Mbps » n'a été trouvé sur aucune des 5 images testées.`;
  ($('osd-probe') as HTMLDialogElement).showModal();
}

/** Charge dans le lecteur la vidéo du vol affiché, si son fichier est disponible. */
function attachPlayer() {
  const f = state.flight;
  const file = state.video ? videoFiles.get(state.video.name) : undefined;
  if (!f || !file) {
    player.clear();
    return;
  }
  if (player.loadedName !== file.name) {
    player.load(file, f.videoOffset);
    $<HTMLSelectElement>('speed-select').value = '1';
  } else player.setOffset(f.videoOffset);
}

/**
 * Place la lecture à l'instant t du vol. fromVideo : l'instant vient de la
 * vidéo en cours de lecture, il ne faut donc pas la repositionner.
 */
function setTime(t: number, fromVideo = false) {
  const f = state.flight;
  if (!f) return;
  state.t = Math.min(f.duration, Math.max(0, t));
  if (!fromVideo) player.seek(state.t);
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
    ['TX', fmt(p.tpwr, 0, 'mW')],
    ['ELRS', packetRate(p.rfmd, getElrsVersion())?.label ?? (p.rfmd ? `RFMD ${p.rfmd}` : '–')],
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
  // Pendant la vidéo, c'est elle qui donne l'heure du vol
  if (player.covers(state.t)) {
    if (!player.playing) player.play(state.t, speed);
    else player.video.playbackRate = Math.min(speed, 16);
    setTime(player.flightTime(), true);
    requestAnimationFrame(tick);
    return;
  }
  if (player.playing) player.pause();
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
  if (!on) player.pause();
  if (on) {
    if (state.flight && state.t >= state.flight.duration - 0.1) setTime(0);
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
}

// ---------- Interactions ----------

$<HTMLInputElement>('file-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) importFiles([...input.files]);
  input.value = '';
});

$('demo-btn').addEventListener('click', () => {
  const d = generateDemo();
  state.currentId = null;
  state.log = parseEdgeTxCsv(d.csv, 'Démo – lac d\'Annecy.csv');
  state.video = parseSrt(d.srt, 'Démo – DJI O3.srt');
  showFlight(guessVideoOffset(buildFlight(state.log, state.video)));
});

$<HTMLSelectElement>('metric-select').addEventListener('change', (e) => {
  state.metric = metricById((e.target as HTMLSelectElement).value);
  map?.setMetric(state.metric, currentDomain());
  renderLegend();
});
$('legend-lo').addEventListener('input', () => onLegendInput('lo'));
$('legend-hi').addEventListener('input', () => onLegendInput('hi'));
$('legend-reset').addEventListener('click', () => {
  if (!state.metric) return;
  state.domains.delete(state.metric.id);
  map?.setMetric(state.metric, null);
  renderLegend();
});
$('stats').addEventListener('change', (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains('elrs-version')) onElrsVersion(Number((t as HTMLSelectElement).value) as ElrsVersion);
});

$<HTMLSelectElement>('basemap-select').addEventListener('change', (e) => map?.setBasemap((e.target as HTMLSelectElement).value as Basemap));
$('fit-btn').addEventListener('click', () => map?.fit());
$<HTMLInputElement>('time-slider').addEventListener('input', (e) => setTime(Number((e.target as HTMLInputElement).value)));
$('play-btn').addEventListener('click', () => setPlaying(!state.playing));
player.video.addEventListener('click', () => setPlaying(!state.playing));
$<HTMLInputElement>('follow-check').addEventListener('change', (e) => map?.setFollow((e.target as HTMLInputElement).checked));

function setOffset(off: number) {
  const f = state.flight;
  if (!f) return;
  off = Math.round(off * 10) / 10;
  attachVideo(f, off);
  player.setOffset(off, state.t);
  $<HTMLInputElement>('offset-input').value = String(off);
  if (state.currentId !== null) updateFlight(state.currentId, { videoOffset: off });
  renderStats(computeStats(f));
  charts?.setFlight(f);
  if (state.metric) map?.setMetric(state.metric, currentDomain());
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
  if (files.length) importFiles(files);
});

// Aide « Configurer mon drone »
const help = $<HTMLDialogElement>('help');
document.querySelectorAll('[data-open-help]').forEach((b) => b.addEventListener('click', () => help.showModal()));
$('help-close').addEventListener('click', () => help.close());
$('osd-probe-close').addEventListener('click', () => ($('osd-probe') as HTMLDialogElement).close());
help.addEventListener('click', (e) => e.target === help && help.close());

setupOfflineDialog(() => map);

$('app-version').textContent = `v${__APP_VERSION__}`;
setupNative({
  onBack: () => {
    if (state.playing) setPlaying(false);
    else if (!$('app').hidden) showLibrary();
    else return false;
    return true;
  },
});

if (new URLSearchParams(location.search).has('demo')) $('demo-btn').click();
else showLibrary();
