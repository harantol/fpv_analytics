import { describe, expect, it } from 'vitest';
import { findBitrateRegion, mergeOsdBitrate, parseBitrate, rejectOutliers, type OcrWord } from '../src/osd-parse';

const word = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90): OcrWord => ({ text, bbox: { x0, y0, x1, y1 }, confidence });

describe('lecture du débit sur l\'OSD', () => {
  it('trouve la zone du nombre au-dessus de « Mbps »', () => {
    const r = findBitrateRegion([word('4.12V', 30, 20, 90, 45), word('41', 850, 18, 880, 44), word('Mbps', 848, 46, 886, 60)])!;
    expect(r).not.toBeNull();
    // la zone contient le nombre et reste au-dessus de « Mbps »
    expect(r.x0).toBeLessThanOrEqual(850);
    expect(r.x1).toBeGreaterThanOrEqual(880);
    expect(r.y0).toBeLessThanOrEqual(18);
    expect(r.y1).toBeLessThanOrEqual(52);
  });

  it('estime la zone quand le nombre n\'a pas été lu', () => {
    const r = findBitrateRegion([word('Mbps', 100, 200, 140, 214)])!;
    expect(r.y1).toBeLessThanOrEqual(200);
    expect(r.y0).toBeLessThan(200 - 14 * 2);
  });

  it('tolère les erreurs de lecture de « Mbps »', () => {
    expect(findBitrateRegion([word('M6ps', 0, 50, 40, 64)])).not.toBeNull();
    expect(findBitrateRegion([word('Mbp5', 0, 50, 40, 64)])).not.toBeNull();
    expect(findBitrateRegion([word('ms', 0, 50, 40, 64)])).toBeNull();
  });

  it('lit un nombre plausible', () => {
    expect(parseBitrate('41\n')).toBe(41);
    expect(parseBitrate('38.5')).toBe(38.5);
    expect(parseBitrate('2O.4')).toBe(20.4);
    expect(parseBitrate('')).toBeNull();
    expect(parseBitrate('250')).toBeNull();
  });

  it('écarte une lecture isolée aberrante', () => {
    const r = rejectOutliers([
      { t: 1, v: 40 },
      { t: 2, v: 4 },
      { t: 3, v: 41 },
    ]);
    expect(r.map((x) => x.v)).toEqual([40, 41]);
  });

  it('écarte aussi une lecture aberrante en fin de vidéo (chiffre manqué)', () => {
    const r = rejectOutliers([
      { t: 1, v: 45 },
      { t: 2, v: 44 },
      { t: 3, v: 4 },
    ]);
    expect(r.map((x) => x.v)).toEqual([45, 44]);
  });

  it('remplace le débit estimé par le débit lu', () => {
    const merged = mergeOsdBitrate(
      [
        { t: 0, bitrate: 10, frameLoss: 0 },
        { t: 0.5, bitrate: 11 },
        { t: 5, bitrate: 12 },
      ],
      [
        { t: 0.4, v: 40 },
        { t: 1.4, v: 42 },
      ],
    );
    expect(merged.map((s) => s.bitrate)).toEqual([40, 40, undefined]);
    expect(merged[0].frameLoss).toBe(0);
  });
});
