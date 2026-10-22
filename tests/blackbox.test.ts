import { describe, expect, it } from 'vitest';
import { isBlackbox, parseBlackbox } from '../src/parsers/blackbox';

/**
 * Petit encodeur de log Blackbox (format v2) pour les tests : trames I uniquement
 * (« I interval:1 »), plus trames GPS (G), lentes (S) et fin de log (E).
 */
function uvb(v: number): number[] {
  const out: number[] = [];
  v >>>= 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}
const svb = (v: number) => uvb((v << 1) ^ (v >> 31)); // zigzag
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

interface Frame {
  t: number; // s
  vbat: number; // V
  amps: number; // A
  rssi: number; // 0–1023
  thr: number; // 1000–2000
  gps?: { lat: number; lon: number; alt: number; speedCms: number; course: number; sats: number };
  modeFlags?: number;
  failsafe?: number;
}

function encodeLog(frames: Frame[], opts: { datetime?: string; firmware?: string } = {}): number[] {
  const h = [
    'Product:Blackbox flight data recorder by Nicholas Sherlock',
    'Data version:2',
    'I interval:1',
    'P interval:1/1',
    'Firmware type:Cleanflight',
    `Firmware revision:${opts.firmware ?? 'Betaflight 2025.12.0 (1234abcd) STM32H743'}`,
    ...(opts.datetime ? [`Log start datetime:${opts.datetime}`] : []),
    'Field I name:loopIteration,time,vbatLatest,amperageLatest,rssi,rcCommand[3]',
    'Field I signed:0,0,0,1,0,0',
    'Field I predictor:0,0,0,0,0,0',
    'Field I encoding:1,1,1,0,1,1',
    'Field P predictor:6,2,1,1,1,1',
    'Field P encoding:9,0,0,0,0,0',
    'Field G name:time,GPS_numSat,GPS_coord[0],GPS_coord[1],GPS_altitude,GPS_speed,GPS_ground_course',
    'Field G signed:0,0,1,1,1,0,0',
    // Coordonnées codées par rapport au point de départ (trame H), comme Betaflight
    'Field G predictor:0,0,7,7,0,0,0',
    'Field G encoding:1,1,0,0,0,1,1',
    'Field H name:GPS_home[0],GPS_home[1]',
    'Field H signed:1,1',
    'Field H predictor:0,0',
    'Field H encoding:0,0',
    'Field S name:flightModeFlags,stateFlags,failsafePhase,rxSignalReceived,rxFlightChannelsValid',
    'Field S signed:0,0,0,0,0',
    'Field S predictor:0,0,0,0,0',
    'Field S encoding:1,1,1,1,1',
  ];
  const out: number[] = [];
  let home: [number, number] | null = null;
  for (const line of h) out.push(...ascii(`H ${line}\n`));
  frames.forEach((f, i) => {
    const us = Math.round(f.t * 1e6);
    if (f.modeFlags !== undefined) out.push(...ascii('S'), ...uvb(f.modeFlags), ...uvb(0), ...uvb(f.failsafe ?? 0), ...uvb(1), ...uvb(1));
    out.push(...ascii('I'), ...uvb(i), ...uvb(us), ...uvb(Math.round(f.vbat * 100)), ...svb(Math.round(f.amps * 100)), ...uvb(f.rssi), ...uvb(f.thr));
    if (f.gps) {
      const g = f.gps;
      if (!home) {
        home = [Math.round(g.lat * 1e7), Math.round(g.lon * 1e7)];
        out.push(...ascii('H'), ...svb(home[0]), ...svb(home[1]));
      }
      out.push(...ascii('G'), ...uvb(us), ...uvb(g.sats), ...svb(Math.round(g.lat * 1e7) - home[0]), ...svb(Math.round(g.lon * 1e7) - home[1]), ...svb(Math.round(g.alt * 10)), ...uvb(g.speedCms), ...uvb(Math.round(g.course * 10)));
    }
  });
  // Désarmement (événement 15 : raison, puis fin de log)
  out.push(...ascii('E'), 15, ...uvb(4), ...ascii('E'), 255, ...ascii('End of log'), 0);
  return out;
}

/** Vol simple : 500 Hz pendant `dur` s, GPS à 10 Hz, armé (bit ARM) avec ANGLE. */
function flight(dur: number, opts: { lat0?: number; failsafeAt?: number } = {}): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < dur * 500; i++) {
    const t = i / 500;
    const fs = opts.failsafeAt !== undefined && t >= opts.failsafeAt ? 1 : 0;
    frames.push({
      t: 10 + t, // le temps du FC ne commence pas à 0
      vbat: 25.2 - t * 0.1,
      amps: 18,
      rssi: 1023,
      thr: 1500,
      gps: i % 50 === 0 ? { lat: (opts.lat0 ?? 45.8) + t * 1e-4, lon: 6.17, alt: 500 + t, speedCms: 1000, course: 90, sats: 14 } : undefined,
      modeFlags: i % 100 === 0 ? 0b11 : undefined, // ARM + ANGLE (bits 0 et 1)
      failsafe: fs,
    });
  }
  return frames;
}

describe('parseBlackbox', () => {
  const file = new Uint8Array([
    ...encodeLog(flight(3), { datetime: '2026-10-22T12:49:03.000+00:00' }),
    ...encodeLog(flight(2, { lat0: 46, failsafeAt: 1 })),
  ]);

  it('reconnaît un log Blackbox', () => {
    expect(isBlackbox(file)).toBe(true);
    expect(isBlackbox(new TextEncoder().encode('Date,Time,1RSS(dB)\n'))).toBe(false);
  });

  it('un vol par log, ré-échantillonné à 10 Hz, temps depuis le début du log', () => {
    const { logs, skipped } = parseBlackbox(file, 'LOG00001.BFL');
    expect(skipped).toBe(0);
    expect(logs.map((l) => l.name)).toEqual(['LOG00001.BFL #1', 'LOG00001.BFL #2']);
    const s = logs[0].samples;
    expect(s[0].t).toBe(0);
    expect(s.length).toBeGreaterThanOrEqual(29);
    expect(s.length).toBeLessThanOrEqual(31);
    expect(s[10].t).toBeCloseTo(1, 5);
    expect(logs[0].source).toBe('blackbox');
    expect(logs[0].firmware).toMatch(/Betaflight 2025\.12/);
    expect(logs[0].key).not.toBe(logs[1].key);
  });

  it('convertit les unités (V, A, mAh, %, GPS)', () => {
    const s = parseBlackbox(file).logs[0].samples;
    const p = s[10];
    expect(p.voltage).toBeCloseTo(25.1, 1);
    expect(p.current).toBeCloseTo(18, 5);
    expect(p.throttle).toBe(50);
    expect(p.fcRssi).toBe(100);
    expect(p.lat).toBeCloseTo(45.8001, 4);
    expect(p.lon).toBeCloseTo(6.17, 6);
    expect(p.alt).toBeCloseTo(501, 1);
    expect(p.speed).toBeCloseTo(36, 1);
    expect(p.heading).toBe(90);
    expect(p.sats).toBe(14);
    // 18 A pendant ~3 s ≈ 15 mAh
    expect(s[s.length - 1].capacity).toBeGreaterThanOrEqual(14);
    expect(s[s.length - 1].capacity).toBeLessThanOrEqual(15);
  });

  it('heure de début du FC, modes de vol et failsafe', () => {
    const [a, b] = parseBlackbox(file).logs;
    expect(a.start).not.toBeNull();
    expect(b.start).toBeNull();
    expect(a.samples[5].flightMode).toBe('ANGL');
    expect(b.samples[5].flightMode).toBe('ANGL');
    expect(b.samples[b.samples.length - 1].flightMode).toBe('!FS!');
  });

  it('désarmement en fin de log ; logs vides ignorés et non numérotés', () => {
    const [a] = parseBlackbox(file).logs;
    expect(a.samples[a.samples.length - 1].flightMode).toBe('ANGL*');
    // Un log réduit à ses en-têtes (armement très court) suivi d'un vrai vol
    const empty = encodeLog([]);
    const r = parseBlackbox(new Uint8Array([...empty, ...encodeLog(flight(2))]), 'KL.BBL');
    expect(r.skipped).toBe(1);
    expect(r.logs.map((l) => l.name)).toEqual(['KL.BBL']);
  });

  it('refuse un fichier qui n\'est pas un Blackbox', () => {
    expect(() => parseBlackbox(new TextEncoder().encode('bonjour'))).toThrow();
  });
});
