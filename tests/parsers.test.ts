import { describe, expect, it } from 'vitest';
import { parseEdgeTxCsv } from '../src/parsers/edgetx';
import { parseSrt } from '../src/parsers/srt';
import { buildFlight, computeStats, estimateCells, guessVideoOffset } from '../src/analysis';
import { generateDemo } from '../src/demo';

const ELRS = `Date,Time,1RSS(dB),2RSS(dB),RQly(%),RSNR(dB),ANT,RFMD,TPWR(mW),TRSS(dB),TQly(%),TSNR(dB),RxBt(V),Curr(A),Capa(mAh),Bat%(%),FM,GPS,GSpd(kmh),Hdg(@),Alt(m),Sats,TxBat(V)
2026-05-12,10:00:00.000,-45,-47,100,10,0,D250,100,-40,100,9,25.1,0.5,0,100,ACRO,0.000000 0.000000,0.0,0,0,0,7.9
2026-05-12,10:00:00.500,-46,-48,100,10,0,D250,100,-41,100,9,25.0,0.5,1,100,ACRO,45.100000 6.100000,0.0,0,500,12,7.9
2026-05-12,10:00:01.000,-80,-82,62,1,1,D250,250,-60,60,2,23.4,20.0,5,98,ANGL,45.100100 6.100000,40.5,0,530,12,7.9
2026-05-12,10:00:01.500,-110,-112,0,-12,1,D250,500,-80,0,-5,23.0,22.0,8,97,ANGL,45.100200 6.100000,40.5,0,560,12,7.9`;

describe('parseEdgeTxCsv', () => {
  it('lit un log ELRS', () => {
    const log = parseEdgeTxCsv(ELRS);
    expect(log.samples).toHaveLength(4);
    expect(log.start?.toISOString()).toBe('2026-05-12T10:00:00.000Z');
    expect(log.samples[1].t).toBeCloseTo(0.5);
    // Pas de fix GPS sur la première ligne
    expect(log.samples[0].lat).toBeUndefined();
    expect(log.samples[2]).toMatchObject({ lat: 45.1001, lon: 6.1, rqly: 62, rssi1: -80, tpwr: 250, voltage: 23.4, rfmd: 'D250', flightMode: 'ANGL' });
    expect(log.fields.has('rqly')).toBe(true);
  });

  it('convertit les pieds et les nœuds', () => {
    const log = parseEdgeTxCsv('Time,Alt(ft),GSpd(kts)\n10:00:00.0,100,10');
    expect(log.samples[0].alt).toBeCloseTo(30.48);
    expect(log.samples[0].speed).toBeCloseTo(18.52);
  });

  it('rejette un fichier sans colonne Time', () => {
    expect(() => parseEdgeTxCsv('a,b\n1,2')).toThrow();
  });
});

describe('parseSrt', () => {
  it('lit un SRT DJI O3', () => {
    const v = parseSrt(`1
00:00:00,000 --> 00:00:00,100
Signal:4 CH:3 FlightTime:0 SBat:16.6V GBat:7.1V Delay:24ms Bitrate:42.4Mbps Distance:0m

2
00:00:01,500 --> 00:00:01,600
Signal:2 CH:3 FlightTime:1 SBat:16.2V GBat:7.1V Delay:31ms Bitrate:12.0Mbps Distance:10m`);
    expect(v.samples).toHaveLength(2);
    expect(v.samples[1]).toMatchObject({ t: 1.5, signal: 2, delay: 31, bitrate: 12, droneBat: 16.2, channel: 3 });
  });

  it('lit un SRT DJI FPV V2 (clés en minuscules)', () => {
    const v = parseSrt(`1\n00:00:00,000 --> 00:00:01,000\nsignal:3 ch:8 flightTime:0 uavBat:16.6V glsBat:15.4V delay:28ms bitrate:25.0Mbps`);
    expect(v.samples[0]).toMatchObject({ signal: 3, droneBat: 16.6, gogglesBat: 15.4, delay: 28, bitrate: 25 });
  });
});

describe('analyse', () => {
  it('estime le nombre d\'éléments', () => {
    expect(estimateCells(16.8)).toBe(4);
    expect(estimateCells(25.2)).toBe(6);
    expect(estimateCells(12.6)).toBe(3);
  });

  it('calcule les statistiques', () => {
    const f = buildFlight(parseEdgeTxCsv(ELRS), null);
    const s = computeStats(f);
    expect(f.cells).toBe(6);
    expect(f.home).toMatchObject({ lat: 45.1, lon: 6.1, alt: 500 });
    expect(s.maxAlt).toBe(60);
    expect(s.maxDist).toBeGreaterThan(20);
    expect(s.minRqly).toBe(0);
    expect(s.failsafes).toBe(1);
  });

  it('retrouve le décalage vidéo de la démo', () => {
    const d = generateDemo();
    const f = buildFlight(parseEdgeTxCsv(d.csv), parseSrt(d.srt));
    expect(guessVideoOffset(f)).toBe(4);
  });
});
