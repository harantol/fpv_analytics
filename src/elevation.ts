/**
 * Lecture de l'altitude du sol à partir des tuiles d'élévation « terrarium »
 * (AWS Terrain Tiles, libres d'accès), celles-là mêmes qu'utilise la carte 3D.
 */
export const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const ZOOM = 13;
const SIZE = 256;

const cache = new Map<string, Promise<Uint8ClampedArray | null>>();

function loadTile(x: number, y: number): Promise<Uint8ClampedArray | null> {
  const key = `${x}/${y}`;
  let p = cache.get(key);
  if (!p) {
    const url = TERRAIN_URL.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y));
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.statusText))))
      .then((b) => createImageBitmap(b))
      .then((img) => {
        const canvas = new OffscreenCanvas(SIZE, SIZE);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, SIZE, SIZE).data;
      })
      .catch(() => null);
    cache.set(key, p);
  }
  return p;
}

function project(lat: number, lon: number) {
  const n = 2 ** ZOOM;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

function sample(data: Uint8ClampedArray, px: number, py: number): number {
  const i = (Math.min(SIZE - 1, Math.max(0, py)) * SIZE + Math.min(SIZE - 1, Math.max(0, px))) * 4;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}

/** Altitude du sol (m, MSL) pour chaque coordonnée ; null si indisponible. */
export async function groundElevations(coords: { lat: number; lon: number }[]): Promise<(number | null)[]> {
  const proj = coords.map((c) => project(c.lat, c.lon));
  const tiles = new Map<string, Promise<Uint8ClampedArray | null>>();
  for (const p of proj) {
    const key = `${Math.floor(p.x)}/${Math.floor(p.y)}`;
    if (!tiles.has(key)) tiles.set(key, loadTile(Math.floor(p.x), Math.floor(p.y)));
  }
  const loaded = new Map<string, Uint8ClampedArray | null>();
  await Promise.all([...tiles].map(async ([k, pr]) => loaded.set(k, await pr)));
  return proj.map((p) => {
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);
    const data = loaded.get(`${tx}/${ty}`);
    if (!data) return null;
    // Interpolation bilinéaire dans la tuile
    const fx = (p.x - tx) * SIZE - 0.5;
    const fy = (p.y - ty) * SIZE - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const ay = fy - y0;
    const v00 = sample(data, x0, y0);
    const v10 = sample(data, x0 + 1, y0);
    const v01 = sample(data, x0, y0 + 1);
    const v11 = sample(data, x0 + 1, y0 + 1);
    return v00 * (1 - ax) * (1 - ay) + v10 * ax * (1 - ay) + v01 * (1 - ax) * ay + v11 * ax * ay;
  });
}
