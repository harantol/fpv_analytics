import { createFile, MP4BoxBuffer, type Movie } from 'mp4box';
import type { VideoLog, VideoSample } from '../types';

/**
 * Lecture des enregistrements vidéo des lunettes (DJI Goggles 3…).
 *
 * Les lunettes enregistrent la vidéo telle qu'elle arrive par la liaison.
 * On lit seulement l'index du MP4 (taille et horodatage de chaque image),
 * sans décoder la vidéo, pour en déduire :
 *  - le débit vidéo réellement reçu, tranche par tranche ;
 *  - les images perdues (trous dans l'horodatage, images quasi vides).
 */

export interface FrameInfo {
  /** Instant de l'image (s depuis le début). */
  t: number;
  /** Taille de l'image compressée (octets). */
  size: number;
  key: boolean;
}

export interface DvrResult {
  video: VideoLog;
  /** Début de l'enregistrement (ms, heure locale naïve) ou null si inconnu. */
  start: number | null;
  duration: number;
  /** Cadence nominale estimée (images/s). */
  fps: number;
}

const BIN = 0.5;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Calcule débit et pertes d'images par tranches de 0,5 s. */
export function analyzeFrames(frames: FrameInfo[], duration: number): { samples: VideoSample[]; fps: number } {
  if (frames.length < 2) return { samples: [], fps: 0 };
  // Cadence nominale : intervalle médian entre deux images
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t);
  const step = median(gaps.filter((g) => g > 0));
  const fps = step > 0 ? Math.round(1 / step) : 0;
  // Une image quasi vide (< 3 % de la taille médiane hors images clés) est comptée comme perdue
  const tiny = 0.03 * median(frames.filter((f) => !f.key).map((f) => f.size));

  const nBins = Math.max(1, Math.ceil(duration / BIN));
  const bytes = new Float64Array(nBins);
  const good = new Float64Array(nBins);
  for (const f of frames) {
    const b = Math.min(nBins - 1, Math.floor(f.t / BIN));
    bytes[b] += f.size;
    if (f.size > tiny) good[b]++;
  }
  const samples: VideoSample[] = [];
  for (let b = 0; b < nBins; b++) {
    const binDur = Math.min(BIN, duration - b * BIN);
    if (binDur <= 0.05) break;
    const expected = fps * binDur;
    samples.push({
      t: b * BIN,
      bitrate: (bytes[b] * 8) / binDur / 1e6,
      frameLoss: expected > 0 ? Math.max(0, Math.min(100, 100 * (1 - good[b] / expected))) : undefined,
      fps: good[b] / binDur,
    });
  }
  return { samples, fps };
}

/** Heure dans le nom de fichier DJI : DJI_20260914143210_0001_D.MP4 (heure locale). */
export function startFromName(name: string): number | null {
  const m = name.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** Lit l'index d'un MP4 par morceaux, sans charger la vidéo en mémoire. */
export async function readFrames(file: Blob, chunkSize = 4 << 20): Promise<{ info: Movie; frames: FrameInfo[] }> {
  const mp4 = createFile();
  let info: Movie | null = null;
  let error: string | null = null;
  mp4.onReady = (i) => (info = i);
  mp4.onError = (_m, e) => (error = e);

  let offset = 0;
  while (offset < file.size && !info && !error) {
    const buf = await file.slice(offset, offset + chunkSize).arrayBuffer();
    const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, offset), offset + buf.byteLength >= file.size);
    // mp4box indique où reprendre : il saute les données vidéo (mdat) pour aller à l'index
    offset = next > offset ? next : offset + buf.byteLength;
  }
  mp4.flush();
  if (error) throw new Error(`MP4 illisible : ${error}`);
  if (!info) throw new Error('Index MP4 introuvable (fichier incomplet ou enregistrement interrompu ?).');
  const movie = info as Movie;
  const track = movie.videoTracks[0];
  if (!track) throw new Error('Aucune piste vidéo dans ce fichier.');
  const raw = mp4.getTrackSamplesInfo(track.id);
  const t0 = raw.length ? raw[0].cts : 0;
  const frames = raw
    .map((s) => ({ t: (s.cts - t0) / s.timescale, size: s.size, key: s.is_sync }))
    .sort((a, b) => a.t - b.t);
  return { info: movie, frames };
}

export async function parseDvr(file: File): Promise<DvrResult> {
  const { info, frames } = await readFrames(file);
  const duration = info.duration / info.timescale;
  const { samples, fps } = analyzeFrames(frames, duration);
  if (!samples.length) throw new Error('Vidéo trop courte pour être analysée.');

  // Heure de début : nom de fichier DJI, sinon date du MP4 (UTC → heure locale naïve)
  let start = startFromName(file.name);
  if (start === null && info.created && info.created.getFullYear() > 2015) {
    start = info.created.getTime() - info.created.getTimezoneOffset() * 60000;
  }
  return {
    video: { name: file.name, samples, fields: new Set(['t', 'bitrate', 'frameLoss', 'fps']) },
    start,
    duration,
    fps,
  };
}
