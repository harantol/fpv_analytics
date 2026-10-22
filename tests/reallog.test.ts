import { describe, expect, it } from 'vitest';
import { estimateCells, buildFlight } from '../src/analysis';
import { detectEvents, parseFlightMode } from '../src/events';
import { parseEdgeTxCsv } from '../src/parsers/edgetx';

describe('mode de vol Betaflight (suffixes de désarmement)', () => {
  it('reconnaît « ! », « * » et « ? » comme désarmé', () => {
    expect(parseFlightMode('AIR!')).toMatchObject({ armed: false, mode: 'AIR', armingDisabled: true });
    expect(parseFlightMode('ACRO*')).toMatchObject({ armed: false, mode: 'ACRO' });
    expect(parseFlightMode('ANGL?')).toMatchObject({ armed: false, mode: 'ANGL' });
    expect(parseFlightMode('AIR')).toMatchObject({ armed: true, mode: 'AIR' });
    expect(parseFlightMode('!FS!')).toMatchObject({ failsafe: true });
    expect(parseFlightMode('!FS!').armed).toBeUndefined();
  });

  it('détecte l\'armement quand « AIR! » devient « AIR »', () => {
    const pts = ['AIR!', 'AIR!', 'AIR', 'AIR', 'AIR!'].map((fm, i) => ({ t: i, flightMode: fm }));
    expect(detectEvents(pts).map((e) => e.kind)).toEqual(['arm', 'disarm']);
  });
});

describe('nombre d\'éléments avec une batterie entamée', () => {
  // Betaflight réglé 3,0–4,2 V/élément (Li-ion), batterie 6S à 47 % au décollage
  const pct = (v: number, cells: number, min: number, max: number) => Math.round(((v / cells - min) / (max - min)) * 100);
  it('trouve une 6S Li-ion partant à 47 %', () => {
    const samples = [21.4, 20.8, 20.2, 20.0, 19.8].map((v) => ({ voltage: v, batPct: pct(v, 6, 3.0, 4.2) }));
    expect(estimateCells(21.4, samples)).toBe(6);
  });

  it('trouve une 4S LiPo (3,3–4,2 V) entamée', () => {
    const samples = [15.6, 15.2, 14.8, 14.4].map((v) => ({ voltage: v, batPct: pct(v, 4, 3.3, 4.2) }));
    expect(estimateCells(15.6, samples)).toBe(4);
  });

  it('sans pourcentage, suppose la batterie pleine au départ', () => {
    expect(estimateCells(25.2, [])).toBe(6);
  });
});

describe('télémétrie lente (une position toutes les 12 s)', () => {
  it('donne la vraie fréquence GPS et interpole entre les positions', () => {
    const rows = ['Date,Time,FM,RQly(%),GPS,Alt(m)'];
    for (let i = 0; i <= 240; i++) {
      const t = i * 0.5;
      const fix = Math.floor(t / 12) * 12;
      const lat = 45 + (20 * fix) / 111320; // 20 m/s vers le nord
      const s = 10 + t;
      rows.push(`2026-10-22,14:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.round((s % 1) * 1000)).padStart(3, '0')},AIR,98,${lat.toFixed(6)} 6.000000,1700`);
    }
    const f = buildFlight(parseEdgeTxCsv(rows.join('\n')), null);
    expect(f.gpsInterval).toBeCloseTo(12);
    expect(f.gpsFixes).toBe(11);
    // la position avance entre deux positions reçues (interpolation)
    const mid = f.gps.find((p) => Math.abs(p.t - 6) < 0.01)!;
    expect((mid.lat! - 45) * 111320).toBeCloseTo(120, 0);
  });
});
