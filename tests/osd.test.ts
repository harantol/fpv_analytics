import { describe, expect, it } from 'vitest';
import { dvrHints, findBitrateRegion, mergeOsdBitrate, parseBitrate, refineTimes, rejectOutliers, type OcrWord } from '../src/osd-parse';

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

  it('garde la valeur la plus basse d\'une tranche (chute brève)', () => {
    const merged = mergeOsdBitrate([{ t: 10 }], [
      { t: 10, v: 40 },
      { t: 10.2, v: 9 },
      { t: 10.4, v: 38 },
    ]);
    expect(merged[0].bitrate).toBe(9);
  });

  it('relit finement là où le débit change ou une lecture manque', () => {
    const coarse = [0, 1, 2, 3, 4];
    const fine = refineTimes(
      [
        { t: 0, v: 40 },
        { t: 1, v: 40 },
        { t: 2, v: 12 },
        { t: 4, v: 40 },
      ],
      coarse,
      [],
    );
    // 1→2 (chute), 2→3 et 3→4 (lecture manquante en 3) ; rien entre 0 et 1
    expect(fine).toEqual([1.2, 1.4, 1.6, 1.8, 2.2, 2.4, 2.6, 2.8, 3.2, 3.4, 3.6, 3.8]);
  });

  it('relit autour d\'un indice du fichier vidéo même si deux lectures sont égales', () => {
    const fine = refineTimes(
      [
        { t: 0, v: 40 },
        { t: 1, v: 40 },
      ],
      [0, 1],
      [0.5],
    );
    expect(fine).toEqual([0.2, 0.4, 0.6, 0.8]);
  });

  it('limite le nombre de relectures en gardant les plus gros écarts', () => {
    const fine = refineTimes(
      [
        { t: 0, v: 40 },
        { t: 1, v: 30 },
        { t: 2, v: 5 },
      ],
      [0, 1, 2],
      [],
      { max: 4 },
    );
    expect(fine).toEqual([1.2, 1.4, 1.6, 1.8]);
  });

  it('repère les problèmes visibles dans le fichier vidéo', () => {
    const hints = dvrHints([
      { t: 0, bitrate: 30, frameLoss: 0 },
      { t: 0.5, bitrate: 31, frameLoss: 40 },
      { t: 1, bitrate: 8, frameLoss: 0 },
      { t: 1.5, bitrate: 29, frameLoss: 0 },
    ]);
    expect(hints).toEqual([0.5, 1]);
  });
});
