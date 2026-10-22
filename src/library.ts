import Dexie, { type EntityTable } from 'dexie';
import type { FlightLog, TelemetrySample, VideoLog, VideoSample } from './types';
import type { Stats } from './analysis';

/** Vidéo associée à un vol : on ne garde que les mesures extraites, jamais la vidéo elle-même. */
export interface StoredVideo {
  name: string;
  samples: VideoSample[];
  fields: string[];
  /** Heure de début de l'enregistrement (ms epoch, heure locale « naïve »), si connue. */
  start?: number;
  /** Débit lu sur l'OSD de la vidéo. */
  osd?: boolean;
}

/** Log Blackbox déjà converti (10 Hz) : le fichier brut n'est jamais conservé. */
export interface StoredLog {
  name: string;
  /** Début (ms, heure locale « naïve »), si l'horloge du FC était réglée. */
  start: number | null;
  samples: TelemetrySample[];
  fields: string[];
  firmware?: string;
}

export interface StoredFlight {
  id?: number;
  /** Empreinte du log, pour ne pas importer deux fois le même vol. */
  key: string;
  name: string;
  /** Début du vol (ms, heure locale de la radio interprétée comme UTC), ou date d'import. */
  date: number;
  importedAt: number;
  /** Log radio EdgeTX (texte du .csv). */
  csv?: string;
  /** Log Blackbox du contrôleur de vol. */
  bbx?: StoredLog;
  video?: StoredVideo;
  videoOffset?: number;
  summary: Pick<Stats, 'duration' | 'maxDist' | 'totalDist' | 'maxAlt' | 'minRqly' | 'minCellV' | 'failsafes'>;
}

class FlightDb extends Dexie {
  flights!: EntityTable<StoredFlight, 'id'>;
  constructor() {
    super('fpv-analytics');
    this.version(1).stores({ flights: '++id, &key, date' });
  }
}

export const db = new FlightDb();

/** Empreinte simple (FNV-1a) du contenu du log. */
export function flightKey(csv: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < csv.length; i++) {
    h ^= csv.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${csv.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

export function toStoredLog(log: FlightLog): StoredLog {
  return { name: log.name, start: log.start ? log.start.getTime() : null, samples: log.samples, fields: [...log.fields], firmware: log.firmware };
}

export function fromStoredLog(l: StoredLog): FlightLog {
  return {
    name: l.name,
    start: l.start === null ? null : new Date(l.start),
    samples: l.samples,
    fields: new Set(l.fields as (keyof TelemetrySample)[]),
    source: 'blackbox',
    firmware: l.firmware,
  };
}

export function toStoredVideo(v: VideoLog, start?: number): StoredVideo {
  return { name: v.name, samples: v.samples, fields: [...v.fields], start, osd: v.osd };
}

export function fromStoredVideo(v: StoredVideo): VideoLog {
  return { name: v.name, samples: v.samples, fields: new Set(v.fields as (keyof VideoSample)[]), osd: v.osd };
}

/** Enregistre (ou met à jour) un vol ; renvoie son id. */
export async function saveFlight(f: Omit<StoredFlight, 'id' | 'importedAt'>): Promise<number> {
  const existing = await db.flights.where('key').equals(f.key).first();
  if (existing) {
    await db.flights.update(existing.id!, { ...f, video: f.video ?? existing.video, videoOffset: f.video ? f.videoOffset : existing.videoOffset });
    return existing.id!;
  }
  return (await db.flights.add({ ...f, importedAt: Date.now() })) as number;
}

export const listFlights = () => db.flights.orderBy('date').reverse().toArray();
export const getFlight = (id: number) => db.flights.get(id);
export const deleteFlight = (id: number) => db.flights.delete(id);
export const updateFlight = (id: number, changes: Partial<StoredFlight>) => db.flights.update(id, changes);

/** Demande au navigateur de ne pas effacer les données en cas de manque de place. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* non bloquant */
  }
}

export function logDate(log: FlightLog): number | null {
  return log.start ? log.start.getTime() : null;
}

/** Met à jour les mesures vidéo d'un vol (ex. débit lu sur l'OSD), en gardant le reste. */
export async function updateFlightVideo(id: number, video: VideoLog) {
  const f = await db.flights.get(id);
  if (!f?.video || f.video.name !== video.name) return;
  await db.flights.update(id, { video: toStoredVideo(video, f.video.start) });
}
