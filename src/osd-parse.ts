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
 * Remplace le débit estimé des échantillons vidéo (tranches de 0,5 s commençant à t)
 * par le débit lu sur l'OSD : la valeur la plus basse lue dans la tranche (pour ne pas
 * masquer une chute brève), sinon la lecture la plus proche à moins de maxGap secondes.
 */
export function mergeOsdBitrate(samples: VideoSample[], readings: { t: number; v: number }[], maxGap = 1, bin = 0.5): VideoSample[] {
  const sorted = [...readings].sort((a, b) => a.t - b.t);
  return samples.map((s) => {
    const out: VideoSample = { ...s };
    const inBin = sorted.filter((r) => r.t >= s.t && r.t < s.t + bin);
    if (inBin.length) {
      out.bitrate = Math.min(...inBin.map((r) => r.v));
      return out;
    }
    const mid = s.t + bin / 2;
    let best: { t: number; v: number } | undefined;
    for (const r of sorted) if (!best || Math.abs(r.t - mid) < Math.abs(best.t - mid)) best = r;
    if (best && Math.abs(best.t - mid) <= maxGap) out.bitrate = best.v;
    else delete out.bitrate;
    return out;
  });
}

/**
 * Seconde passe : instants à relire finement (toutes les `step` s) là où il se passe
 * quelque chose — deux lectures successives nettement différentes, une lecture
 * manquante, ou un indice venant du fichier vidéo (images perdues, débit du fichier
 * qui s'effondre). Limité à `max` instants, les écarts les plus forts d'abord.
 */
export function refineTimes(
  readings: { t: number; v: number }[],
  coarseTimes: number[],
  hints: number[],
  opts: { step?: number; max?: number } = {},
): number[] {
  const step = opts.step ?? 0.2;
  const max = opts.max ?? Infinity;
  const byT = new Map(readings.map((r) => [r.t, r.v]));
  const windows: { a: number; b: number; score: number }[] = [];
  for (let i = 0; i + 1 < coarseTimes.length; i++) {
    const a = coarseTimes[i];
    const b = coarseTimes[i + 1];
    const va = byT.get(a);
    const vb = byT.get(b);
    let score = 0;
    if (va === undefined || vb === undefined) score = 20;
    else {
      const d = Math.abs(va - vb);
      if (d > Math.max(3, 0.15 * Math.max(va, vb))) score = d;
    }
    if (hints.some((h) => h >= a && h < b)) score = Math.max(score, 30);
    if (score > 0) windows.push({ a, b, score });
  }
  windows.sort((x, y) => y.score - x.score);
  const out = new Set<number>();
  for (const w of windows) {
    const n = Math.round((w.b - w.a) / step);
    if (out.size + n - 1 > max) break;
    for (let k = 1; k < n; k++) out.add(Math.round((w.a + k * step) * 1000) / 1000);
  }
  return [...out].sort((x, y) => x - y);
}

/** Instants (s, dans la vidéo) où le fichier vidéo lui-même montre un problème. */
export function dvrHints(samples: VideoSample[]): number[] {
  const rates = samples.map((s) => s.bitrate).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
  return samples.filter((s) => (s.frameLoss ?? 0) > 5 || (median > 0 && s.bitrate !== undefined && s.bitrate < 0.5 * median)).map((s) => s.t);
}

/**
 * Recherche de « Mbps » : l'OSD des Goggles 3 est écrit petit (« Mbps » ≈ 1 % de la
 * hauteur de l'image). L'image est donc analysée comme si elle faisait 2160 px de haut
 * (taille réelle en 4K, agrandie en 1080p), découpée en tuiles pour rester rapide.
 */
const LOCATE_HEIGHT = 2160;
/** Taille maximale d'une tuile analysée (px). */
const TILE = 1400;
/** Recouvrement entre tuiles (fraction de l'image), pour ne pas couper un mot. */
const TILE_OVERLAP = 0.04;

/** Tuiles couvrant l'image (en fraction), celles du bas d'abord : « Mbps » y est souvent. */
export function locateTiles(vw: number, vh: number): { box: Box; scaleTo: number }[] {
  const k = LOCATE_HEIGHT / Math.max(1, vh);
  const W = vw * k;
  const H = vh * k;
  const cols = Math.max(1, Math.ceil(W / TILE));
  const rows = Math.max(1, Math.ceil(H / TILE));
  const out: { box: Box; scaleTo: number }[] = [];
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = 0; c < cols; c++) {
      const box = {
        x0: Math.max(0, c / cols - TILE_OVERLAP),
        x1: Math.min(1, (c + 1) / cols + TILE_OVERLAP),
        y0: Math.max(0, r / rows - TILE_OVERLAP),
        y1: Math.min(1, (r + 1) / rows + TILE_OVERLAP),
      };
      out.push({ box, scaleTo: Math.round((box.x1 - box.x0) * W) });
    }
  }
  return out;
}
