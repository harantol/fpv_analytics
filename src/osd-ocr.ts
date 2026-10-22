import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { set as idbSet } from 'idb-keyval';
import { relaxedSimd, simd } from 'wasm-feature-detect';
import { findBitrateRegion, locateTiles, parseBitrate, refineTimes, rejectOutliers, type Box, type OcrWord } from './osd-parse';

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

/** Image de test gardée quand « Mbps » n'est pas trouvé, pour voir ce que l'app a reçu. */
export interface OsdProbe {
  /** Image telle qu'extraite de la vidéo (data URL). */
  raw: string;
  /** Même image après le filtre « texte blanc » (data URL). */
  bw: string;
  /** Luminosité moyenne (0–255) : proche de 0 = image noire. */
  brightness: number;
  width: number;
  height: number;
}

export interface OsdResult {
  /** Mesures, ou null si « Mbps » n'a été trouvé sur aucune image. */
  readings: OsdReading[] | null;
  probe?: OsdProbe;
}

export interface OsdProgress {
  /** Étape en cours : chargement de la vidéo, démarrage de l'OCR, recherche de « Mbps », lecture. */
  stage: 'video' | 'engine' | 'locate' | 'read';
  done: number;
  total: number;
}

/** Rejette si la promesse n'aboutit pas à temps (évite un blocage silencieux). */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Zone en fraction de l'image (indépendante de la résolution). */
type RelBox = Box;

const OCR_BASE = () => new URL('./ocr/', document.baseURI).href;

/**
 * Démarre Tesseract sans qu'il ait besoin du réseau.
 *
 * Dans l'app Android, les fichiers de l'app sont servis par une adresse locale simulée
 * (https://localhost) que la WebView ne fournit pas toujours aux Web Workers : le moteur
 * restait alors bloqué au démarrage. La page principale charge donc elle-même le script
 * du worker, le moteur (WebAssembly) et les données de langue, et les lui transmet :
 *  - script du worker et moteur sous forme d'adresses blob: (lues en mémoire) ;
 *  - données de langue déposées dans le cache de Tesseract (IndexedDB), relu par le worker.
 */
let assets: Promise<{ worker: string; core: string }> | null = null;

async function blobUrlOf(url: string, type: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fichier ${url.split('/').pop()} introuvable (${res.status})`);
  return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
}

function loadAssets(): Promise<{ worker: string; core: string }> {
  assets ??= (async () => {
    const base = OCR_BASE();
    // Même choix de moteur que Tesseract : selon les instructions SIMD du processeur
    const core = (await relaxedSimd()) ? 'tesseract-core-relaxedsimd-lstm.wasm.js' : (await simd()) ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
    const [worker, coreUrl, lang] = await Promise.all([
      blobUrlOf(`${base}worker.min.js`, 'application/javascript'),
      blobUrlOf(`${base}${core}`, 'application/javascript'),
      fetch(`${base}eng.traineddata.bin`).then((r) => {
        if (!r.ok) throw new Error(`données de langue introuvables (${r.status})`);
        return r.arrayBuffer();
      }),
    ]);
    // Clé lue par le worker : `${cachePath || '.'}/${langue}.traineddata` (gzip accepté)
    await idbSet('./eng.traineddata', new Uint8Array(lang));
    // Tesseract ne prend une adresse comme fichier précis que si elle finit par « js »
    return { worker, core: `${coreUrl}#core.js` };
  })().catch((e) => {
    assets = null;
    throw e;
  });
  return assets;
}

async function newWorker(): Promise<Worker> {
  const { worker, core } = await loadAssets();
  return createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: worker,
    workerBlobURL: false,
    corePath: core,
    cacheMethod: 'readOnly',
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
  private loaded: Promise<void>;
  constructor(file: Blob) {
    this.url = URL.createObjectURL(file);
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    // Écoute posée AVANT de charger la vidéo : une erreur immédiate ne peut pas être manquée
    this.loaded = new Promise((resolve, reject) => {
      this.video.addEventListener('loadeddata', () => resolve(), { once: true });
      this.video.addEventListener('error', () => reject(new Error("cette vidéo ne peut pas être décodée sur cet appareil (enregistrement en H.265 ?). Réglez l'enregistrement des lunettes en H.264.")), { once: true });
    });
    // Certaines WebView ne chargent pas une vidéo hors de la page : on l'y ajoute, invisible
    // (presque invisible plutôt qu'invisible : certaines WebView ne décodent pas une vidéo transparente)
    Object.assign(this.video.style, { position: 'fixed', left: '0', top: '0', width: '16px', height: '9px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
    document.body.appendChild(this.video);
    this.video.src = this.url;
  }

  async ready(): Promise<void> {
    if (this.video.error) throw new Error('cette vidéo ne peut pas être décodée sur cet appareil.');
    if (this.video.readyState < 2) await withTimeout(this.loaded, 30000, 'la vidéo ne se charge pas (fichier trop lourd ou format non pris en charge ?).');
    // Sur Android, une vidéo jamais lancée peut donner des images noires au canvas :
    // on la lance un instant pour démarrer le décodeur, puis on la met en pause.
    try {
      await withTimeout(this.video.play(), 3000, '');
    } catch {
      /* lecture refusée : on tente quand même */
    }
    this.video.pause();
  }

  get duration() {
    return this.video.duration;
  }

  async seek(t: number): Promise<void> {
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    // On attend l'image elle-même, pas seulement la fin du déplacement : sinon le
    // canvas peut recevoir l'image précédente, ou une image noire.
    const frame = v.requestVideoFrameCallback
      ? new Promise<void>((resolve) => {
          v.requestVideoFrameCallback!(() => resolve());
          setTimeout(resolve, 1000);
        })
      : Promise.resolve();
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      v.addEventListener('seeked', done, { once: true });
      setTimeout(done, 3000); // sécurité si l'événement ne vient pas
      v.currentTime = t;
    });
    await frame;
  }

  /** Image courante réduite, sans filtre, et sa luminosité moyenne. */
  snapshot(threshold: number): OsdProbe {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    const width = Math.min(640, w);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.max(1, Math.round((h * width) / Math.max(1, w)));
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 16) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    const brightness = sum / (d.length / 16);
    const raw = canvas.toDataURL('image/jpeg', 0.8);
    const bw = this.draw(threshold, undefined, width).toDataURL('image/png');
    return { raw, bw, brightness, width: w, height: h };
  }

  /** Dessine l'image courante (ou une partie, en fraction de l'image) dans un canvas. */
  draw(threshold: number, region?: RelBox, scaleTo?: number): HTMLCanvasElement {
    return drawFrame(this.video, this.video.videoWidth, this.video.videoHeight, threshold, region, scaleTo);
  }

  dispose() {
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
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
  readonly height: number;
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
  const tiles = locateTiles(frame.width, frame.height);
  for (const threshold of THRESHOLDS) {
    for (const { box: tile, scaleTo } of tiles) {
      const canvas = frame.draw(threshold, tile, scaleTo);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      const box = findBitrateRegion(wordsOf(data as never));
      if (box) {
        // Zone ramenée en fraction de l'image entière
        const tw = tile.x1 - tile.x0;
        const th = tile.y1 - tile.y0;
        return {
          threshold,
          region: {
            x0: tile.x0 + (box.x0 / canvas.width) * tw,
            x1: Math.min(1, tile.x0 + (box.x1 / canvas.width) * tw),
            y0: tile.y0 + (box.y0 / canvas.height) * th,
            y1: Math.min(1, tile.y0 + (box.y1 / canvas.height) * th),
          },
        };
      }
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
  const frame: Frame = { width: w, height: h, draw: (th, region, scaleTo) => drawFrame(img, w, h, th, region, scaleTo) };
  const worker = await newWorker();
  try {
    const at = await locate(worker, frame);
    return at ? await readNumber(worker, frame, at) : null;
  } finally {
    await worker.terminate();
  }
}

/**
 * Lit le débit affiché sur l'OSD, en deux passes :
 *  1. une image toutes les `step` secondes sur toute la vidéo ;
 *  2. une image toutes les 0,2 s là où il se passe quelque chose (débit qui change,
 *     lecture manquante, ou indice `hints` venant du fichier : images perdues…),
 *     pour ne pas rater une chute de débit brève.
 * Si « Mbps » n'est trouvé sur aucune image, renvoie readings = null et une image
 * de test (probe) pour comprendre pourquoi.
 */
export async function readOsdBitrate(
  file: Blob,
  opts: { step?: number; hints?: number[]; onProgress?: (p: OsdProgress) => void; signal?: AbortSignal } = {},
): Promise<OsdResult> {
  const step = opts.step ?? 1;
  const progress = opts.onProgress ?? (() => {});
  progress({ stage: 'video', done: 0, total: 1 });
  const grab = new FrameGrabber(file);
  let worker: Worker | null = null;
  try {
    await grab.ready();
    progress({ stage: 'engine', done: 0, total: 1 });
    worker = await withTimeout(newWorker(), 60000, 'le moteur de lecture de texte ne démarre pas.');
    const duration = grab.duration;
    const times: number[] = [];
    for (let t = 0.5; t < duration; t += step) times.push(t);

    const frame: Frame = {
      get width() { return grab.video.videoWidth; },
      get height() { return grab.video.videoHeight; },
      draw: (th, region, scaleTo) => grab.draw(th, region, scaleTo),
    };
    let at: Located | null = null;
    let probe: OsdProbe | undefined;
    // L'OSD ne bouge pas pendant une vidéo (il peut changer d'une vidéo à l'autre) :
    // on cherche « Mbps » une fois, sur quelques images réparties dans la vidéo
    const probes = [0.05, 0.2, 0.4, 0.6, 0.8];
    for (const [i, f] of probes.entries()) {
      if (opts.signal?.aborted) return { readings: null };
      progress({ stage: 'locate', done: i, total: probes.length });
      await grab.seek(duration * f);
      at = await locate(worker, frame);
      if (at) break;
      // On garde l'image la plus lumineuse : la plus parlante pour comprendre l'échec
      const snap = grab.snapshot(THRESHOLDS[0]);
      if (!probe || snap.brightness > probe.brightness) probe = snap;
    }
    if (!at) return { readings: null, probe };

    const readings: OsdReading[] = [];
    const readAt = async (t: number) => {
      await grab.seek(t);
      // Une image sans nombre lisible (coupure, image figée) est simplement ignorée
      const v = await readNumber(worker!, frame, at!);
      if (v !== null) readings.push({ t, v });
    };
    // Passe 1 : 0 → 75 % de la progression
    for (const [i, t] of times.entries()) {
      if (opts.signal?.aborted) return { readings: null };
      await readAt(t);
      progress({ stage: 'read', done: Math.round((750 * (i + 1)) / times.length), total: 1000 });
    }
    // Passe 2 : lecture fine autour des changements (au plus autant d'images qu'en passe 1)
    const fine = refineTimes(readings, times, opts.hints ?? [], { step: 0.2, max: times.length });
    for (const [i, t] of fine.entries()) {
      if (opts.signal?.aborted) return { readings: null };
      await readAt(t);
      progress({ stage: 'read', done: 750 + Math.round((250 * (i + 1)) / fine.length), total: 1000 });
    }
    readings.sort((a, b) => a.t - b.t);
    return { readings: rejectOutliers(readings) };
  } finally {
    await worker?.terminate();
    grab.dispose();
  }
}
