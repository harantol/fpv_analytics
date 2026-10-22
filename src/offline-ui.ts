import { offlineTemplates, type FlightMap } from './map3d';
import { cachedTileCount, clearTileCache, downloadTiles, tileUrls } from './tilecache';

/** Au-delà, on demande de réduire la zone (respect des serveurs de tuiles). */
const MAX_TILES = 3000;

/** Fenêtre « Carte hors ligne » : téléchargement de la zone visible et gestion du cache. */
export function setupOfflineDialog(getMap: () => FlightMap | null) {
  const dlg = document.getElementById('offline') as HTMLDialogElement;
  const q = <T extends HTMLElement>(sel: string) => dlg.querySelector(sel) as T;
  const zoomSel = q<HTMLSelectElement>('#offline-zoom');
  const info = q<HTMLElement>('#offline-info');
  const start = q<HTMLButtonElement>('#offline-start');
  const progress = q<HTMLProgressElement>('#offline-progress');
  const cacheInfo = q<HTMLElement>('#offline-cache');
  let abort: AbortController | null = null;

  const urls = () => {
    const map = getMap();
    return map ? tileUrls(map.viewBounds(), offlineTemplates(map.basemap, Number(zoomSel.value))) : [];
  };

  const refresh = async () => {
    const n = urls().length;
    const tooMany = n > MAX_TILES;
    info.textContent = tooMany
      ? `Zone trop grande (${n} tuiles, maximum ${MAX_TILES}) : rapprochez la carte ou baissez le niveau de détail.`
      : `${n} tuiles à vérifier (environ ${Math.max(1, Math.round((n * 25) / 1024))} Mo au maximum).`;
    start.disabled = tooMany || n === 0 || abort !== null;
    cacheInfo.textContent = `${await cachedTileCount()} tuiles en cache sur l'appareil.`;
  };

  document.getElementById('offline-btn')!.addEventListener('click', () => {
    dlg.showModal();
    refresh();
  });
  q('#offline-close').addEventListener('click', () => {
    abort?.abort();
    dlg.close();
  });
  zoomSel.addEventListener('change', refresh);

  start.addEventListener('click', async () => {
    const list = urls();
    abort = new AbortController();
    start.disabled = true;
    progress.hidden = false;
    progress.max = list.length;
    try {
      const failed = await downloadTiles(list, (done) => (progress.value = done), abort.signal);
      info.textContent = abort.signal.aborted
        ? 'Téléchargement interrompu.'
        : failed
          ? `Terminé, ${failed} tuile(s) en échec (réseau ?). Relancez pour compléter.`
          : 'Zone disponible hors ligne ✔';
    } catch (e) {
      info.textContent = (e as Error).message;
    } finally {
      abort = null;
      progress.hidden = true;
      start.disabled = false;
      cacheInfo.textContent = `${await cachedTileCount()} tuiles en cache sur l'appareil.`;
    }
  });

  q('#offline-clear').addEventListener('click', async () => {
    if (!confirm('Supprimer toutes les tuiles de carte gardées sur l\'appareil ?')) return;
    await clearTileCache();
    refresh();
  });
}
