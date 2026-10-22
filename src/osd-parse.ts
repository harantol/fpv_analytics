/**
 * Logique de lecture du débit affiché sur l'OSD des lunettes DJI :
 * un nombre, avec « Mbps » écrit juste en dessous. La position n'est pas fixe,
 * on la retrouve donc en cherchant le mot « Mbps ».
 */

import type { VideoSample } from './types';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  bbox: Box;
  confidence: number;
}

/** « Mbps » tel que l'OCR peut le lire (M6ps, Mbp5, Mops…). */
const MBPS = /^[mM][bBhH68o0][pP][sS5]$/;

const width = (b: Box) => b.x1 - b.x0;
const height = (b: Box) => b.y1 - b.y0;

/**
 * Zone (en pixels de l'image analysée) où lire le nombre du débit, à partir des mots
 * trouvés sur une image entière. Renvoie null si « Mbps » est introuvable.
 */
export function findBitrateRegion(words: OcrWord[]): Box | null {
  const units = words.filter((w) => MBPS.test(w.text.replace(/[^A-Za-z0-9]/g, '')));
  if (units.length === 0) return null;
  const unit = units.sort((a, b) => b.confidence - a.confidence)[0].bbox;
  const cx = (unit.x0 + unit.x1) / 2;
  const h = height(unit);

  // Le nombre, s'il a été lu : mot numérique juste au-dessus, centré sur « Mbps »
  const number = words
    .filter((w) => /\d/.test(w.text) && w.bbox.y1 <= unit.y0 + h * 0.3 && w.bbox.y1 >= unit.y0 - h * 2)
    .filter((w) => Math.abs((w.bbox.x0 + w.bbox.x1) / 2 - cx) < Math.max(width(unit), width(w.bbox)))
    .sort((a, b) => b.bbox.y1 - a.bbox.y1)[0];

  // Zone assez large pour un nombre à 3 chiffres et une décimale
  const w = Math.max(width(unit) * 2.2, number ? width(number.bbox) * 1.8 : 0);
  const top = number ? number.bbox.y0 - height(number.bbox) * 0.35 : unit.y0 - h * 2.6;
  const bottom = number ? number.bbox.y1 + height(number.bbox) * 0.25 : unit.y0 - h * 0.1;
  return { x0: Math.max(0, cx - w / 2), x1: cx + w / 2, y0: Math.max(0, top), y1: bottom };
}

/** Débit lu (Mbps), ou null si le texte ne ressemble pas à un débit plausible. */
export function parseBitrate(text: string): number | null {
  const cleaned = text
    .replace(/[oO]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/,/g, '.')
    .replace(/[^0-9.]/g, '');
  const m = cleaned.match(/\d{1,3}(?:\.\d)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) && v >= 0 && v <= 200 ? v : null;
}

/**
 * Lisse les lectures : écarte une valeur isolée très différente de ses voisines
 * (erreur d'OCR typique : chiffre manquant ou en trop).
 */
export function rejectOutliers(readings: { t: number; v: number }[]): { t: number; v: number }[] {
  const far = (v: number, ref: number) => Math.abs(v - ref) > Math.max(8, ref * 0.6);
  return readings.filter((r, i) => {
    const prev = readings[i - 1]?.v;
    const next = readings[i + 1]?.v;
    if (prev === undefined && next === undefined) return true;
    // Aux extrémités, on compare aux deux voisines du même côté
    if (prev === undefined) return !(far(r.v, next!) && readings[i + 2] && !far(readings[i + 2].v, next!));
    if (next === undefined) return !(far(r.v, prev) && readings[i - 2] && !far(readings[i - 2].v, prev));
    const ref = (prev + next) / 2;
    const close = Math.abs(prev - next) < Math.max(5, ref * 0.3);
    return !(close && far(r.v, ref));
  });
}

/**
 * Remplace le débit estimé des échantillons vidéo par le débit lu sur l'OSD
 * (lecture la plus proche à moins de maxGap secondes ; sinon pas de valeur).
 */
export function mergeOsdBitrate(samples: VideoSample[], readings: { t: number; v: number }[], maxGap = 1): VideoSample[] {
  const sorted = [...readings].sort((a, b) => a.t - b.t);
  let j = 0;
  return samples.map((s) => {
    while (j + 1 < sorted.length && Math.abs(sorted[j + 1].t - s.t) <= Math.abs(sorted[j].t - s.t)) j++;
    const r = sorted[j];
    const out: VideoSample = { ...s };
    if (r && Math.abs(r.t - s.t) <= maxGap) out.bitrate = r.v;
    else delete out.bitrate;
    return out;
  });
}
