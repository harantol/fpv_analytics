import maplibregl from 'maplibre-gl';

/**
 * Cache des tuiles de carte et de relief (Cache API du navigateur / WebView).
 *
 * - Toute tuile affichée est gardée : un terrain déjà consulté reste
 *   disponible sans réseau.
 * - Une zone peut être téléchargée à l'avance (« Hors ligne »).
 */
const CACHE = 'fpv-tiles-v1';
export const PROTOCOL = 'cache';

const hasCacheApi = () => typeof caches !== 'undefined';

/** Fetch avec cache : le réseau d'abord si la tuile est absente, sinon le cache. */
export async function cachedFetch(url: string, signal?: AbortSignal): Promise<Response> {
  if (!hasCacheApi()) return fetch(url, { signal });
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return hit;
  const res = await fetch(url, { signal });
  if (res.ok) await cache.put(url, res.clone());
  return res;
}

let registered = false;
/** Déclare le protocole cache:// auprès de MapLibre. */
export function registerTileProtocol() {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol(PROTOCOL, async (params, abort) => {
    const res = await cachedFetch(params.url.replace(`${PROTOCOL}://`, 'https://'), abort.signal);
    if (!res.ok) throw new Error(`Tuile indisponible (${res.status})`);
    return { data: await res.arrayBuffer() };
  });
}

/** Transforme une URL https en URL passant par le cache. */
export const viaCache = (url: string) => url.replace(/^https:\/\//, `${PROTOCOL}://`);

// ---------- Téléchargement d'une zone ----------

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function lonToTileX(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
export function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** Liste les URL de tuiles couvrant la zone, pour chaque modèle d'URL et sa plage de zoom. */
export function tileUrls(b: Bounds, templates: { url: string; minZoom: number; maxZoom: number }[]): string[] {
  const out: string[] = [];
  for (const t of templates) {
    for (let z = t.minZoom; z <= t.maxZoom; z++) {
      const x0 = lonToTileX(b.west, z);
      const x1 = lonToTileX(b.east, z);
      const y0 = latToTileY(b.north, z);
      const y1 = latToTileY(b.south, z);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          out.push(t.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
        }
      }
    }
  }
  return out;
}

/** Télécharge les tuiles manquantes (4 en parallèle). Renvoie le nombre d'échecs. */
export async function downloadTiles(urls: string[], onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<number> {
  if (!hasCacheApi()) throw new Error('Cache indisponible sur cet appareil.');
  const cache = await caches.open(CACHE);
  let done = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < urls.length && !signal?.aborted) {
      const url = urls[next++];
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { signal });
          if (res.ok) await cache.put(url, res);
          else failed++;
        }
      } catch {
        failed++;
      }
      onProgress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return failed;
}

export async function clearTileCache() {
  if (hasCacheApi()) await caches.delete(CACHE);
}

/** Nombre de tuiles en cache. */
export async function cachedTileCount(): Promise<number> {
  if (!hasCacheApi()) return 0;
  return (await (await caches.open(CACHE)).keys()).length;
}
