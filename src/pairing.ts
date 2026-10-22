/**
 * Associe les fichiers vidéo aux logs radio d'un même import, d'après l'heure.
 *
 * Les heures des logs EdgeTX sont « naïves » (heure locale de la radio, sans
 * fuseau) : on les compare donc à l'heure locale naïve des vidéos.
 */
export interface LogSpan {
  id: string;
  /** ms epoch, heure locale naïve */
  start: number;
  end: number;
}
export interface VideoSpan {
  id: string;
  start: number;
  end: number;
}

/** Convertit un horodatage réel (ms) en heure locale « naïve » (même convention que les logs). */
export function toNaiveLocal(epochMs: number, tzOffsetMin = new Date(epochMs).getTimezoneOffset()): number {
  return epochMs - tzOffsetMin * 60000;
}

/** Pour chaque vidéo, le log qui la recouvre le plus (au moins 30 % de la vidéo). */
export function pairVideos(logs: LogSpan[], videos: VideoSpan[], tolerance = 120000): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of videos) {
    let best: string | null = null;
    let bestOverlap = 0;
    for (const l of logs) {
      const overlap = Math.min(v.end, l.end + tolerance) - Math.max(v.start, l.start - tolerance);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = l.id;
      }
    }
    if (best && bestOverlap >= 0.3 * Math.max(1000, v.end - v.start)) out.set(v.id, best);
  }
  return out;
}
