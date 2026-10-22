import { describe, expect, it } from 'vitest';
import { parseEdgeTxCsv } from '../src/parsers/edgetx';
import { buildFlight } from '../src/analysis';

/**
 * Log réaliste : 5 lignes/s, mais la position GPS (télémétrie ELRS) n'est
 * rafraîchie que toutes les 2 s. Drone en ligne droite à 100 km/h vers le nord.
 */
function staleGpsLog(seconds = 60, gpsEvery = 2) {
  const rows = ['Date,Time,RQly(%),GPS,Alt(m),Sats'];
  const speed = 100 / 3.6; // m/s
  let lat = 45;
  for (let i = 0; i <= seconds * 5; i++) {
    const t = i / 5;
    if (i % (gpsEvery * 5) === 0) lat = 45 + (speed * t) / 111320;
    const s = 10 + t;
    const time = `14:00:${String(Math.floor(s)).padStart(2, '0')}.${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
    rows.push(`2026-09-14,${time},100,${lat.toFixed(6)} 6.000000,500,14`);
  }
  return rows.join('\n');
}

describe('trace GPS', () => {
  it('garde toutes les positions GPS reçues même si le GPS est rafraîchi lentement', () => {
    const f = buildFlight(parseEdgeTxCsv(staleGpsLog()), null);
    // 60 s / 2 s = 30 rafraîchissements + la position de départ
    expect(f.gpsFixes).toBe(31);
    expect(f.gpsInterval).toBeCloseTo(2);
  });

  it('interpole la position entre deux rafraîchissements', () => {
    const f = buildFlight(parseEdgeTxCsv(staleGpsLog()), null);
    // Le drone avance régulièrement : chaque ligne (0,2 s) avance d'environ 5,6 m
    const steps = f.gps.slice(1, 300).map((p, i) => (p.lat! - f.gps[i].lat!) * 111320);
    for (const d of steps) expect(d).toBeCloseTo(100 / 3.6 / 5, 0);
  });

  it('écarte un saut GPS aberrant, même répété sur plusieurs lignes', () => {
    const csv = staleGpsLog(20).split('\n');
    // 3 lignes avec une position à 50 km
    for (const i of [40, 41, 42]) csv[i] = csv[i].replace(/,45\.\d+ 6\.000000,/, ',45.500000 6.000000,');
    const f = buildFlight(parseEdgeTxCsv(csv.join('\n')), null);
    expect(f.gps.some((p) => p.lat! > 45.1)).toBe(false);
    expect(f.gpsFixes).toBe(11);
  });
});
