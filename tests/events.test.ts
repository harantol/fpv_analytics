import { describe, expect, it } from 'vitest';
import { compactEvents, detectEvents, parseFlightMode } from '../src/events';
import type { Point } from '../src/analysis';
import { generateDemo } from '../src/demo';
import { parseEdgeTxCsv } from '../src/parsers/edgetx';
import { buildFlight } from '../src/analysis';

const pts = (rows: Partial<Point>[]): Point[] => rows.map((r, i) => ({ t: i, ...r }));

describe('parseFlightMode', () => {
  it('reconnaît armement, failsafe et GPS Rescue', () => {
    expect(parseFlightMode('ACRO*')).toMatchObject({ armed: false, mode: 'ACRO' });
    expect(parseFlightMode('ANGL')).toMatchObject({ armed: true, mode: 'ANGL', failsafe: false });
    expect(parseFlightMode('!FS!')).toMatchObject({ failsafe: true });
    expect(parseFlightMode('RTH')).toMatchObject({ rescue: true });
    expect(parseFlightMode('!ERR')).toMatchObject({ armed: false });
  });
});

describe('detectEvents', () => {
  it('détecte armement, perte de liaison, failsafe et désarmement', () => {
    const ev = detectEvents(
      pts([
        { flightMode: 'ACRO*', rqly: 100 },
        { flightMode: 'ACRO', rqly: 100 },
        { flightMode: 'ACRO', rqly: 0 },
        { flightMode: '!FS!', rqly: 0 },
        { flightMode: 'ACRO', rqly: 90 },
        { flightMode: 'ACRO*', rqly: 100 },
      ]),
    );
    expect(ev.map((e) => e.kind)).toEqual(['arm', 'linkLost', 'failsafe', 'disarm']);
    expect(ev.find((e) => e.kind === 'linkLost')?.duration).toBe(2);
  });

  it('signale une liaison faible seulement si elle dure', () => {
    const ev = detectEvents(pts([{ rqly: 100 }, { rqly: 40 }, { rqly: 30 }, { rqly: 45 }, { rqly: 90 }, { rqly: 40 }, { rqly: 90 }]));
    const low = ev.filter((e) => e.kind === 'linkLow');
    expect(low).toHaveLength(2);
    expect(low[0]).toMatchObject({ t: 1, duration: 3, label: 'Liaison faible (min 30 %)' });
  });

  it('regroupe les variations rapides de puissance', () => {
    const ev = compactEvents(detectEvents(pts([{ tpwr: 25 }, { tpwr: 50 }, { tpwr: 100 }, { tpwr: 250 }])));
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe('Puissance 25 → 250 mW');
  });

  it('signale les interruptions du log', () => {
    const ev = detectEvents([{ t: 0 }, { t: 1 }, { t: 20 }] as Point[]);
    expect(ev[0]).toMatchObject({ kind: 'gap', t: 1 });
  });

  it('trouve la perte de liaison du vol de démo', () => {
    const f = buildFlight(parseEdgeTxCsv(generateDemo().csv), null);
    const kinds = detectEvents(f.points).map((e) => e.kind);
    expect(kinds).toContain('arm');
    expect(kinds).toContain('linkLost');
    expect(kinds[kinds.length - 1]).toBe('disarm');
  });
});
