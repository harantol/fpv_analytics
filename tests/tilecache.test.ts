import { describe, expect, it } from 'vitest';
import { latToTileY, lonToTileX, tileUrls } from '../src/tilecache';

describe('tuiles hors ligne', () => {
  it('convertit lon/lat en coordonnées de tuile', () => {
    expect([lonToTileX(0.1, 1), latToTileY(-0.1, 1)]).toEqual([1, 1]);
    // Paris, zoom 10 : tuile 518/352
    expect([lonToTileX(2.3522, 10), latToTileY(48.8566, 10)]).toEqual([518, 352]);
  });

  it('liste les tuiles de la zone pour chaque zoom', () => {
    const urls = tileUrls({ west: 6.15, south: 45.85, east: 6.19, north: 45.87 }, [{ url: 'https://t/{z}/{x}/{y}.png', minZoom: 10, maxZoom: 12 }]);
    expect(urls[0]).toBe('https://t/10/529/364.png');
    // 1 tuile en z10 et z11, 1 à 2 en z12
    expect(urls.length).toBeGreaterThanOrEqual(3);
    expect(urls.length).toBeLessThanOrEqual(6);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
