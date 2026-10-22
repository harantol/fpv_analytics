import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzeFrames, parseDvr, readFrames, startFromName } from '../src/parsers/dvr';

const FIXTURE = 'tests/fixtures/DJI_20260914143210_0001_D.mp4';

describe('analyse des images', () => {
  it('mesure le débit et les images perdues par tranche', () => {
    // 60 images/s pendant 2 s, sauf un trou entre 1,0 et 1,5 s
    const frames = Array.from({ length: 120 }, (_, i) => ({ t: i / 60, size: 10000, key: i % 60 === 0 })).filter((f) => f.t < 1 || f.t >= 1.5);
    const { samples, fps } = analyzeFrames(frames, 2);
    expect(fps).toBe(60);
    expect(samples).toHaveLength(4);
    expect(samples[0].bitrate).toBeCloseTo((30 * 10000 * 8) / 0.5 / 1e6);
    expect(samples[0].frameLoss).toBeCloseTo(0);
    expect(samples[2].frameLoss).toBe(100);
  });

  it('compte les images quasi vides comme perdues', () => {
    const frames = Array.from({ length: 60 }, (_, i) => ({ t: i / 60, size: i >= 30 ? 50 : 10000, key: false }));
    const { samples } = analyzeFrames(frames, 1);
    expect(samples[1].frameLoss).toBe(100);
  });
});

describe('nom de fichier DJI', () => {
  it("lit l'heure de début", () => {
    expect(startFromName('DJI_20260914143210_0001_D.MP4')).toBe(Date.UTC(2026, 8, 14, 14, 32, 10));
    expect(startFromName('DJIG0001.mp4')).toBeNull();
  });
});

describe('parseDvr', () => {
  it('lit un MP4 dont l\'index est en fin de fichier et trouve la coupure', async () => {
    const buf = readFileSync(FIXTURE);
    const file = new File([buf], 'DJI_20260914143210_0001_D.mp4');
    const r = await parseDvr(file);
    expect(r.fps).toBe(60);
    expect(r.duration).toBeCloseTo(10, 0);
    expect(r.start).toBe(Date.UTC(2026, 8, 14, 14, 32, 10));
    const at = (t: number) => r.video.samples.find((s) => s.t === t)!;
    expect(at(4).frameLoss).toBeGreaterThan(90);
    expect(at(4.5).frameLoss).toBeGreaterThan(90);
    expect(at(2).frameLoss).toBeLessThan(5);
    expect(at(2).bitrate).toBeGreaterThan(0.1);
  });

  it('lit l\'index par petits morceaux sans tout charger', async () => {
    const buf = readFileSync(FIXTURE);
    const { frames } = await readFrames(new Blob([buf]), 64 << 10);
    expect(frames).toHaveLength(539);
  });
});
