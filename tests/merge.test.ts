import { describe, expect, it } from 'vitest';
import { alignBlackbox, mergeLogs, pairBlackbox, sameFlight } from '../src/merge';
import type { FlightLog, TelemetrySample } from '../src/types';

/** Trajectoire : boucle de 600 m de rayon, 20 m/s. */
const path = (t: number) => {
  const a = (t * 20) / 600;
  return { lat: 45.8 + (600 * Math.sin(a)) / 111320, lon: 6.17 + (600 * (1 - Math.cos(a))) / (111320 * Math.cos((45.8 * Math.PI) / 180)) };
};

function log(samples: TelemetrySample[], source: FlightLog['source'], start: Date | null = null): FlightLog {
  const fields = new Set<keyof TelemetrySample>();
  for (const s of samples) for (const k of Object.keys(s)) fields.add(k as keyof TelemetrySample);
  return { name: source === 'radio' ? 'radio.csv' : 'LOG1.BFL', start, samples, fields, source };
}

/**
 * Log radio : 5 lignes/s pendant 200 s, armé à partir de 5 s ; GPS reçu par la
 * télémétrie seulement toutes les `gpsEvery` s (répété entre deux), avec ±3 m de bruit.
 * Blackbox : démarre `offset` s après le début du log radio, 10 Hz, 150 s.
 */
function pair(offset: number, gpsEvery = 1, moving = true) {
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 6e-5 * 0.9;
  const radio: TelemetrySample[] = [];
  let last = { lat: 0, lon: 0 };
  for (let i = 0; i <= 1000; i++) {
    const t = i / 5;
    if (i % Math.round(gpsEvery * 5) === 0) {
      const p = moving ? path(t - offset) : path(0);
      last = { lat: p.lat + noise() * 0.5, lon: p.lon + noise() * 0.5 };
    }
    radio.push({ t, ...last, rqly: 100 - (i % 50), rsnr: 5, tpwr: 250, voltage: 22, batPct: 80, flightMode: t >= 5 ? 'ACRO' : 'ACRO*' });
  }
  const bbx: TelemetrySample[] = [];
  for (let i = 0; i <= 1500; i++) {
    const t = i / 10;
    const p = moving ? path(t) : path(0);
    bbx.push({ t, lat: p.lat, lon: p.lon, voltage: 23.1, current: 15, throttle: 40, flightMode: 'ANGL' });
  }
  return { radio: log(radio, 'radio', new Date(Date.UTC(2026, 9, 22, 14, 0, 0))), bbx: log(bbx, 'blackbox', new Date(Date.UTC(2026, 9, 22, 14, 0, 9))) };
}

describe('alignBlackbox', () => {
  it('retrouve le décalage par la trace GPS, même avec une position toutes les 12 s', () => {
    for (const [offset, every] of [[7.3, 1], [12.6, 12], [-4.2, 2]] as const) {
      const { radio, bbx } = pair(offset, every);
      const a = alignBlackbox(radio, bbx);
      expect(a.method).toBe('gps');
      // Avec un GPS radio espacé, le calage reste à mieux qu'une demi-seconde
      expect(Math.abs(a.offset - offset)).toBeLessThanOrEqual(every > 1 ? 0.5 : 0.2);
      expect(sameFlight(radio, bbx)).toBe(true);
    }
  });

  it('drone immobile : calage par l\'armement, sinon par les horloges', () => {
    const { radio, bbx } = pair(3, 1, false);
    expect(alignBlackbox(radio, bbx)).toEqual({ offset: 5, method: 'arm' });
    const disarmed = { ...radio, samples: radio.samples.map((s) => ({ ...s, flightMode: 'ACRO*' })) };
    expect(alignBlackbox(disarmed, bbx)).toEqual({ offset: 9, method: 'clock' });
  });

  it('deux vols différents ne sont pas confondus', () => {
    const { radio } = pair(0);
    const other = pair(0).bbx;
    other.samples = other.samples.map((s) => ({ ...s, lat: s.lat! + 0.05 }));
    expect(sameFlight(radio, other)).toBe(false);
  });
});

describe('mergeLogs', () => {
  it('liaison du log radio, GPS / batterie / modes du Blackbox, log radio autour', () => {
    const { radio, bbx } = pair(10);
    const m = mergeLogs(radio, bbx, 10);
    expect(m.source).toBe('both');
    expect(m.start).toEqual(radio.start);
    // Avant le Blackbox : lignes radio
    const before = m.samples.find((s) => s.t === 5)!;
    expect(before.voltage).toBe(22);
    expect(before.throttle).toBeUndefined();
    // Pendant : 10 Hz, valeurs Blackbox + liaison radio
    const during = m.samples.filter((s) => s.t >= 10 && s.t <= 160);
    expect(during.length).toBe(1501);
    const p = during.find((s) => s.t === 50)!;
    expect(p.voltage).toBe(23.1);
    expect(p.throttle).toBe(40);
    expect(p.flightMode).toBe('ANGL');
    expect(p.rqly).toBe(radio.samples.find((s) => s.t === 50)!.rqly);
    expect(p.tpwr).toBe(250);
    expect(p.batPct).toBe(80); // absent du Blackbox : repris du log radio
    expect(p.lat).toBeCloseTo(path(40).lat, 9);
    // Après : lignes radio
    expect(m.samples[m.samples.length - 1].t).toBe(200);
    // Temps croissant
    for (let i = 1; i < m.samples.length; i++) expect(m.samples[i].t).toBeGreaterThan(m.samples[i - 1].t);
  });

  it('Blackbox commencé avant le log radio : tout est décalé pour commencer à 0', () => {
    const { radio, bbx } = pair(-3);
    const m = mergeLogs(radio, bbx, -3);
    expect(m.samples[0].t).toBe(0);
    expect(m.start!.getTime()).toBe(radio.start!.getTime() - 3000);
  });
});

describe('pairBlackbox', () => {
  it('associe chaque Blackbox au bon log radio, même pour deux vols au même endroit', () => {
    const a = pair(4);
    const b = pair(6);
    // Deuxième vol : même terrain, trajectoire décalée de 100 m
    b.radio.samples = b.radio.samples.map((s) => ({ ...s, lat: s.lat! + 0.0009 }));
    b.bbx.samples = b.bbx.samples.map((s) => ({ ...s, lat: s.lat! + 0.0009 }));
    const p = pairBlackbox([a.radio, b.radio], [b.bbx, a.bbx]);
    expect(p.get(0)?.bbx).toBe(1);
    expect(p.get(1)?.bbx).toBe(0);
    expect(p.get(0)?.sure).toBe(true);
    expect(Math.abs(p.get(1)!.align.offset - 6)).toBeLessThanOrEqual(0.2);
  });

  it('un seul log de chaque sans GPS ni heure commune : associés, mais sans certitude', () => {
    const { radio, bbx } = pair(3, 1, false);
    const p = pairBlackbox([{ ...radio, start: null }], [bbx]);
    expect(p.get(0)).toMatchObject({ bbx: 0, sure: false });
  });
});
