import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { findBitrateRegion, parseBitrate, rejectOutliers, type Box, type OcrWord } from './osd-parse';

/**
 * Lecture du débit vidéo affiché sur l'OSD des lunettes (DJI Goggles 3), image par image.
 *
 * La vidéo est parcourue avec un élément <video> caché (une image par seconde),
 * chaque image est dessinée dans un canvas, puis le nombre au-dessus de « Mbps »
 * est lu par Tesseract.js, embarqué dans l'app (public/ocr/), donc sans réseau.
 */

export interface OsdReading {
  /** Instant dans la vidéo (s). */
  t: number;
  /** Débit lu (Mbps). */
  v: number;
}

export interface OsdProgress {
  done: number;
  total: number;
}

/** Zone en fraction de l'image (indépendante de la résolution). */
type RelBox = Box;

const OCR_BASE = () => new URL('./ocr/', document.baseURI).href;
/** Largeur de l'image analysée pour chercher « Mbps ». */
const LOCATE_WIDTH = 1280;

async function newWorker(): Promise<Worker> {
  const base = OCR_BASE();
  return createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${base}worker.min.js`,
    corePath: base,
    langPath: base.replace(/\/$/, ''),
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
  });
}

/**
 * Seuils de luminosité essayés pour isoler le texte blanc de l'OSD. Le fond peut être
 * très clair (ciel, neige, sol gris) : on part d'un seuil qui garde « Mbps » lisible
 * sans garder le fond, puis on essaie plus haut et plus bas.
 */
const THRESHOLDS = [205, 225, 185];

/** Garde le texte blanc de l'OSD (en noir sur fond blanc), efface l'image derrière. */
function binarize(ctx: CanvasRenderingContext2D, w: number, h: number, threshold: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const white = min > threshold && max - min < 60;
    const v = white ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

class FrameGrabber {
  readonly video = document.createElement('video');
  private url: string;
  constructor(file: Blob) {
    this.url = URL.createObjectURL(file);
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.src = this.url;
  }

  ready(): Promise<void> {
    if (this.video.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      this.video.addEventListener('error', () => reject(new Error('Vidéo illisible sur cet appareil (codec H.265 ?).')), { once: true });
    });
  }

  get duration() {
    return this.video.duration;
  }

  async seek(t: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      this.video.addEventListener('seeked', done, { once: true });
      setTimeout(done, 3000); // sécurité si l'événement ne vient pas
      this.video.currentTime = t;
    });
  }

  /** Dessine l'image courante (ou une partie, en fraction de l'image) dans un canvas. */
  draw(threshold: number, region?: RelBox, scaleTo?: number): HTMLCanvasElement {
    return drawFrame(this.video, this.video.videoWidth, this.video.videoHeight, threshold, region, scaleTo);
  }

  dispose() {
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}

/** Dessine une image (ou une partie) dans un canvas, en ne gardant que le texte blanc. */
function drawFrame(source: CanvasImageSource, vw: number, vh: number, threshold: number, region?: RelBox, scaleTo?: number): HTMLCanvasElement {
  const sx = region ? region.x0 * vw : 0;
  const sy = region ? region.y0 * vh : 0;
  const sw = region ? (region.x1 - region.x0) * vw : vw;
  const sh = region ? (region.y1 - region.y0) * vh : vh;
  const k = scaleTo ? scaleTo / sw : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * k));
  canvas.height = Math.max(1, Math.round(sh * k));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  binarize(ctx, canvas.width, canvas.height, threshold);
  return canvas;
}

/** Une image à analyser : image de la vidéo ou image fixe (tests). */
interface Frame {
  draw(threshold: number, region?: RelBox, scaleTo?: number): HTMLCanvasElement;
  readonly width: number;
}

function wordsOf(data: { blocks: { paragraphs: { lines: { words: { text: string; bbox: Box; confidence: number }[] }[] }[] }[] | null }): OcrWord[] {
  const out: OcrWord[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) out.push({ text: w.text, bbox: w.bbox, confidence: w.confidence });
  return out;
}

/** Zone du nombre (en fraction de l'image) et seuil qui a permis de la trouver. */
interface Located {
  region: RelBox;
  threshold: number;
}

/** Cherche « Mbps » sur une image ; renvoie la zone du nombre en fraction de l'image. */
async function locate(worker: Worker, frame: Frame): Promise<Located | null> {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '', user_defined_dpi: '300' });
  for (const threshold of THRESHOLDS) {
    const canvas = frame.draw(threshold, undefined, Math.min(LOCATE_WIDTH, frame.width));
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const box = findBitrateRegion(wordsOf(data as never));
    if (box) {
      return {
        threshold,
        region: { x0: box.x0 / canvas.width, x1: Math.min(1, box.x1 / canvas.width), y0: box.y0 / canvas.height, y1: Math.min(1, box.y1 / canvas.height) },
      };
    }
  }
  return null;
}

async function readNumber(worker: Worker, frame: Frame, at: Located): Promise<number | null> {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789.', user_defined_dpi: '300' });
  // Seuil retenu d'abord, puis un peu plus haut si le fond clair gêne la lecture
  for (const threshold of [at.threshold, at.threshold + 20]) {
    // Agrandi : Tesseract lit mieux des chiffres d'environ 40 px de haut
    const canvas = frame.draw(threshold, at.region, 360);
    const { data } = await worker.recognize(canvas);
    const v = parseBitrate(data.text);
    if (v !== null) return v;
  }
  return null;
}

/** Lit le débit sur une image fixe (capture d'écran de la vidéo). */
export async function readBitrateFromImage(img: HTMLImageElement | HTMLCanvasElement): Promise<number | null> {
  const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  const frame: Frame = { width: w, draw: (th, region, scaleTo) => drawFrame(img, w, h, th, region, scaleTo) };
  const worker = await newWorker();
  try {
    const at = await locate(worker, frame);
    return at ? await readNumber(worker, frame, at) : null;
  } finally {
    await worker.terminate();
  }
}

/**
 * Lit le débit affiché sur l'OSD toutes les `step` secondes.
 * Renvoie null si « Mbps » n'a été trouvé sur aucune image.
 */
export async function readOsdBitrate(file: Blob, opts: { step?: number; onProgress?: (p: OsdProgress) => void; signal?: AbortSignal } = {}): Promise<OsdReading[] | null> {
  const step = opts.step ?? 1;
  const grab = new FrameGrabber(file);
  const worker = await newWorker();
  try {
    await grab.ready();
    const duration = grab.duration;
    const times: number[] = [];
    for (let t = 0.5; t < duration; t += step) times.push(t);

    const frame: Frame = { get width() { return grab.video.videoWidth; }, draw: (th, region, scaleTo) => grab.draw(th, region, scaleTo) };
    let at: Located | null = null;
    // L'OSD ne bouge pas pendant une vidéo (il peut changer d'une vidéo à l'autre) :
    // on cherche « Mbps » une fois, sur quelques images réparties dans la vidéo
    for (const f of [0.05, 0.2, 0.4, 0.6, 0.8]) {
      await grab.seek(duration * f);
      at = await locate(worker, frame);
      if (at) break;
    }
    if (!at) return null;

    const readings: OsdReading[] = [];
    for (const [i, t] of times.entries()) {
      if (opts.signal?.aborted) break;
      await grab.seek(t);
      // Une image sans nombre lisible (coupure, image figée) est simplement ignorée
      const v = await readNumber(worker, frame, at);
      if (v !== null) readings.push({ t, v });
      opts.onProgress?.({ done: i + 1, total: times.length });
    }
    return rejectOutliers(readings);
  } finally {
    await worker.terminate();
    grab.dispose();
  }
}
