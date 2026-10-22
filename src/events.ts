import type { Point } from './analysis';

export type EventKind = 'arm' | 'disarm' | 'failsafe' | 'linkLost' | 'linkLow' | 'rescue' | 'mode' | 'rfmd' | 'tpwr' | 'gap' | 'videoLoss';

export interface FlightEvent {
  t: number;
  kind: EventKind;
  label: string;
  /** Durée de l'événement (s) quand elle a un sens (perte de liaison…). */
  duration?: number;
  severity: 'info' | 'warn' | 'bad';
}

/**
 * Mode de vol Betaflight transmis par CRSF : "ACRO", "ANGL", "HOR", "AIR",
 * "!FS!" (failsafe), "RTH" (GPS Rescue), "!ERR", "WAIT"…
 * Un "*" final signifie que le drone est désarmé.
 */
export function parseFlightMode(fm: string | undefined): { armed?: boolean; mode?: string; failsafe: boolean; rescue: boolean } {
  if (!fm) return { failsafe: false, rescue: false };
  const raw = fm.trim();
  const armed = !raw.endsWith('*') && !/^(!ERR|WAIT|OK)$/i.test(raw);
  const mode = raw.replace(/\*$/, '');
  return { armed, mode, failsafe: /!FS!|FAILSAFE/i.test(mode), rescue: /^(RTH|GPS ?RESCUE|RESC)$/i.test(mode) };
}

const LOW_LQ = 50;
/** Part d'images perdues (%) à partir de laquelle on signale une coupure vidéo. */
const VIDEO_LOSS = 50;

function videoLossEvent(start: number, end: number, max: number): FlightEvent {
  return { t: start, kind: 'videoLoss', label: max >= 99 ? 'Coupure vidéo' : `Vidéo saccadée (${Math.round(max)} % perdues)`, duration: end - start, severity: max >= 99 ? 'bad' : 'warn' };
}
/** Durée minimale (s) pour signaler une liaison faible, afin d'éviter le bruit. */
const MIN_LOW = 1;
/** Trou dans le log au-delà duquel on signale une interruption (s). */
const GAP = 5;

export function detectEvents(points: Point[]): FlightEvent[] {
  const ev: FlightEvent[] = [];
  let prev: Point | undefined;
  let armed: boolean | undefined;
  let mode: string | undefined;
  let lostStart: number | null = null;
  let lowStart: number | null = null;
  let lowMin = 100;
  let fsActive = false;
  let rescueActive = false;
  let videoLossStart: number | null = null;
  let videoLossMax = 0;

  const closeLow = (t: number) => {
    if (lowStart !== null && t - lowStart >= MIN_LOW) {
      ev.push({ t: lowStart, kind: 'linkLow', label: `Liaison faible (min ${lowMin} %)`, duration: t - lowStart, severity: 'warn' });
    }
    lowStart = null;
    lowMin = 100;
  };

  for (const p of points) {
    if (prev && p.t - prev.t > GAP) {
      ev.push({ t: prev.t, kind: 'gap', label: `Log interrompu ${Math.round(p.t - prev.t)} s`, duration: p.t - prev.t, severity: 'warn' });
    }

    const fm = parseFlightMode(p.flightMode);
    if (fm.armed !== undefined && fm.armed !== armed) {
      if (armed !== undefined || fm.armed) ev.push({ t: p.t, kind: fm.armed ? 'arm' : 'disarm', label: fm.armed ? 'Armement' : 'Désarmement', severity: 'info' });
      armed = fm.armed;
    }
    if (fm.failsafe && !fsActive) ev.push({ t: p.t, kind: 'failsafe', label: 'Failsafe Betaflight', severity: 'bad' });
    fsActive = fm.failsafe;
    if (fm.rescue && !rescueActive) ev.push({ t: p.t, kind: 'rescue', label: 'GPS Rescue', severity: 'bad' });
    rescueActive = fm.rescue;
    if (fm.mode && armed && mode !== undefined && fm.mode !== mode && !fm.failsafe && !fm.rescue && !/^!FS!$/.test(mode)) {
      ev.push({ t: p.t, kind: 'mode', label: `Mode ${fm.mode}`, severity: 'info' });
    }
    if (fm.mode) mode = fm.mode;

    if (p.rqly !== undefined) {
      if (p.rqly === 0) {
        if (lostStart === null) lostStart = p.t;
      } else if (lostStart !== null) {
        ev.push({ t: lostStart, kind: 'linkLost', label: 'Perte de liaison radio', duration: p.t - lostStart, severity: 'bad' });
        lostStart = null;
      }
      if (p.rqly < LOW_LQ && p.rqly > 0) {
        if (lowStart === null) lowStart = p.t;
        lowMin = Math.min(lowMin, p.rqly);
      } else if (p.rqly >= LOW_LQ) {
        closeLow(p.t);
      }
    }

    const loss = p.video?.frameLoss;
    if (loss !== undefined && loss >= VIDEO_LOSS) {
      if (videoLossStart === null) videoLossStart = p.t;
      videoLossMax = Math.max(videoLossMax, loss);
    } else if (videoLossStart !== null) {
      ev.push(videoLossEvent(videoLossStart, p.t, videoLossMax));
      videoLossStart = null;
      videoLossMax = 0;
    }

    if (prev && p.rfmd && prev.rfmd && p.rfmd !== prev.rfmd) {
      ev.push({ t: p.t, kind: 'rfmd', label: `Mode ELRS ${prev.rfmd} → ${p.rfmd}`, severity: 'info' });
    }
    if (prev && p.tpwr !== undefined && prev.tpwr !== undefined && p.tpwr !== prev.tpwr && p.tpwr > 0 && prev.tpwr > 0) {
      ev.push({ t: p.t, kind: 'tpwr', label: `Puissance ${prev.tpwr} → ${p.tpwr} mW`, severity: 'info' });
    }
    prev = p;
  }
  const end = points.length ? points[points.length - 1].t : 0;
  if (lostStart !== null) ev.push({ t: lostStart, kind: 'linkLost', label: 'Perte de liaison radio', duration: end - lostStart, severity: 'bad' });
  closeLow(end);
  if (videoLossStart !== null) ev.push(videoLossEvent(videoLossStart, end, videoLossMax));
  return ev.sort((a, b) => a.t - b.t);
}

/** Regroupe les changements de puissance trop rapprochés (ELRS Dynamic Power). */
export function compactEvents(events: FlightEvent[], window = 5): FlightEvent[] {
  const out: FlightEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && e.kind === 'tpwr' && last.kind === 'tpwr' && e.t - last.t < window) {
      const from = last.label.match(/Puissance (\d+)/)?.[1];
      const to = e.label.match(/→ (\d+)/)?.[1];
      last.label = `Puissance ${from} → ${to} mW`;
      last.t = e.t;
      continue;
    }
    out.push({ ...e });
  }
  // Supprime les allers-retours de puissance qui reviennent à la valeur de départ
  return out.filter((e) => e.kind !== 'tpwr' || e.label.match(/Puissance (\d+)/)?.[1] !== e.label.match(/→ (\d+)/)?.[1]);
}

export const EVENT_COLORS: Record<FlightEvent['severity'], [number, number, number]> = {
  info: [96, 165, 250],
  warn: [245, 158, 11],
  bad: [239, 68, 68],
};
