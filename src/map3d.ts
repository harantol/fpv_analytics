import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Flight, Point } from './analysis';
import { EVENT_COLORS, type FlightEvent } from './events';
import { colorFor, domainOf, type Metric } from './metrics';
import { TERRAIN_URL } from './elevation';
import { registerTileProtocol, viaCache, type Bounds } from './tilecache';

export type Basemap = 'satellite' | 'topo';

const BASEMAPS: Record<Basemap, { tiles: string[]; attribution: string; maxzoom: number }> = {
  satellite: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics',
    maxzoom: 19,
  },
  topo: {
    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap, SRTM | OpenTopoMap (CC-BY-SA)',
    maxzoom: 17,
  },
};

/** Modèles d'URL à télécharger pour utiliser la carte hors ligne. */
export function offlineTemplates(basemap: Basemap, maxZoom: number) {
  return [
    { url: BASEMAPS[basemap].tiles[0], minZoom: 8, maxZoom: Math.min(maxZoom, BASEMAPS[basemap].maxzoom) },
    { url: TERRAIN_URL, minZoom: 8, maxZoom: Math.min(maxZoom - 1, 15) },
  ];
}

function style(basemap: Basemap): StyleSpecification {
  const b = BASEMAPS[basemap];
  const dem = {
    type: 'raster-dem' as const,
    tiles: [viaCache(TERRAIN_URL)],
    encoding: 'terrarium' as const,
    tileSize: 256,
    maxzoom: 15,
  };
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: b.tiles.map(viaCache), tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution },
      terrain: { ...dem, attribution: 'Relief : AWS Terrain Tiles (Mapzen)' },
      hillshadeSrc: dem,
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      { id: 'hillshade', type: 'hillshade', source: 'hillshadeSrc', paint: { 'hillshade-exaggeration': 0.25, 'hillshade-shadow-color': '#0b1220' } },
    ],
    terrain: { source: 'terrain', exaggeration: 1 },
    sky: { 'sky-color': '#5b8fd6', 'horizon-color': '#cfe0f5', 'fog-color': '#dde7f3', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 },
  };
}

interface Segment {
  from: [number, number, number];
  to: [number, number, number];
  color: [number, number, number];
}

export class FlightMap {
  readonly map: maplibregl.Map;
  private overlay: MapboxOverlay;
  private flight: Flight | null = null;
  private metric: Metric | null = null;
  /** Échelle de couleur imposée par l'utilisateur (sinon automatique). */
  private domain: [number, number] | null = null;
  private segments: Segment[] = [];
  private curtain: Segment[] = [];
  private current: Point | null = null;
  private events: { event: FlightEvent; pos: [number, number, number] }[] = [];
  private follow = false;
  private ready: Promise<void>;
  onPick: ((t: number) => void) | null = null;

  basemap: Basemap = 'satellite';

  constructor(container: HTMLElement) {
    registerTileProtocol();
    this.map = new maplibregl.Map({
      container,
      style: style('satellite'),
      center: [6.17, 45.86],
      zoom: 11,
      pitch: 60,
      maxPitch: 85,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    this.map.addControl(this.overlay);
    // On attend seulement le style, pas les tuiles : l'événement « load » n'arrive
    // jamais si des tuiles échouent (pas de réseau sur le terrain).
    this.ready = new Promise((resolve) => {
      if (this.map.isStyleLoaded()) resolve();
      else this.map.once('style.load', () => resolve());
    });
    // L'attribution compacte s'affiche dépliée au démarrage : on la replie
    this.ready.then(() => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    this.map.on('style.load', () => this.addShadowLayer());
  }

  /** Zone actuellement visible. */
  viewBounds(): Bounds {
    const b = this.map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  }

  setBasemap(b: Basemap) {
    this.basemap = b;
    this.map.setStyle(style(b));
  }

  private addShadowLayer() {
    if (this.map.getSource('shadow')) return;
    this.map.addSource('shadow', { type: 'geojson', data: this.shadowGeoJson() });
    this.map.addLayer({
      id: 'shadow',
      type: 'line',
      source: 'shadow',
      paint: { 'line-color': '#000', 'line-opacity': 0.45, 'line-width': 3, 'line-blur': 1.5 },
    });
  }

  private shadowGeoJson(): GeoJSON.Feature {
    const coords = (this.flight?.gps ?? []).map((p) => [p.lon!, p.lat!]);
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
  }

  async setFlight(flight: Flight, metric: Metric) {
    await this.ready;
    this.flight = flight;
    this.metric = metric;
    this.domain = null;
    this.current = null;
    (this.map.getSource('shadow') as maplibregl.GeoJSONSource | undefined)?.setData(this.shadowGeoJson());
    this.rebuild();
    this.fit();
  }

  fit() {
    const g = this.flight?.gps;
    if (!g || g.length === 0) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of g) b.extend([p.lon!, p.lat!]);
    this.map.fitBounds(b, { padding: 60, pitch: 60, bearing: this.map.getBearing(), duration: 1200, maxZoom: 16 });
  }

  setMetric(metric: Metric, domain: [number, number] | null = null) {
    this.metric = metric;
    this.domain = domain;
    this.rebuild();
  }

  setFollow(on: boolean) {
    this.follow = on;
    if (on && this.current) this.centerOn(this.current);
  }

  private rebuild() {
    const f = this.flight;
    const m = this.metric;
    if (!f || !m) return;
    const g = f.gps;
    const dom = this.domain ?? domainOf(m, f.points);
    this.segments = [];
    this.curtain = [];
    const step = Math.max(1, Math.round(g.length / 400));
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1];
      const b = g[i];
      // Pas de segment à travers une interruption du log
      if (b.t - a.t > 5) continue;
      this.segments.push({
        from: [a.lon!, a.lat!, a.z ?? 0],
        to: [b.lon!, b.lat!, b.z ?? 0],
        color: colorFor(m, m.get(b), dom),
      });
      if (i % step === 0 && b.ground !== undefined && b.z !== undefined && b.z > b.ground) {
        this.curtain.push({ from: [b.lon!, b.lat!, b.z], to: [b.lon!, b.lat!, b.ground], color: colorFor(m, m.get(b), dom) });
      }
    }
    this.render();
  }

  /** Repères d'événements (failsafe, armement…) positionnés sur la trace. */
  setEvents(events: FlightEvent[], at: (t: number) => Point | null) {
    this.events = [];
    for (const e of events) {
      const p = at(e.t);
      if (p && p.lat !== undefined) this.events.push({ event: e, pos: [p.lon!, p.lat!, p.z ?? 0] });
    }
    this.render();
  }

  setCurrent(p: Point | null) {
    this.current = p && p.lat !== undefined ? p : null;
    this.render();
    if (this.follow && this.current) this.centerOn(this.current);
  }

  private centerOn(p: Point) {
    this.map.easeTo({ center: [p.lon!, p.lat!], duration: 250, easing: (x) => x });
  }

  private render() {
    const f = this.flight;
    if (!f) return;
    const layers: unknown[] = [
      new LineLayer<Segment>({
        id: 'curtain',
        data: this.curtain,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getColor: (d) => [...d.color, 70] as [number, number, number, number],
        getWidth: 1,
      }),
      new LineLayer<Segment>({
        id: 'path',
        data: this.segments,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getColor: (d) => d.color,
        getWidth: 4,
        widthMinPixels: 2,
        pickable: true,
        onClick: (info) => {
          const idx = info.index;
          if (idx >= 0 && this.onPick) this.onPick(f.gps[idx + 1].t);
        },
      }),
    ];
    layers.push(
      new ScatterplotLayer<{ event: FlightEvent; pos: [number, number, number] }>({
        id: 'events',
        data: this.events,
        getPosition: (d) => d.pos,
        getRadius: (d) => (d.event.severity === 'info' ? 5 : 7),
        radiusUnits: 'pixels',
        getFillColor: (d) => EVENT_COLORS[d.event.severity],
        getLineColor: [255, 255, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        pickable: true,
        onClick: (info) => {
          if (info.object && this.onPick) this.onPick(info.object.event.t);
        },
      }),
    );
    if (f.home) {
      const h = f.gps.find((p) => p.lat === f.home!.lat && p.lon === f.home!.lon) ?? f.gps[0];
      layers.push(
        new ScatterplotLayer({
          id: 'home',
          data: [h],
          getPosition: (p: Point) => [p.lon!, p.lat!, p.ground ?? p.z ?? 0],
          getRadius: 8,
          radiusUnits: 'pixels',
          getFillColor: [255, 255, 255],
          getLineColor: [16, 185, 129],
          lineWidthMinPixels: 3,
          stroked: true,
        }),
      );
    }
    const c = this.current;
    if (c) {
      const top: [number, number, number] = [c.lon!, c.lat!, c.z ?? 0];
      if (c.ground !== undefined) {
        layers.push(
          new LineLayer({
            id: 'drop',
            data: [{ from: top, to: [c.lon!, c.lat!, c.ground] }],
            getSourcePosition: (d: Segment) => d.from,
            getTargetPosition: (d: Segment) => d.to,
            getColor: [255, 255, 255, 200],
            getWidth: 2,
          }),
        );
      }
      layers.push(
        new ScatterplotLayer({
          id: 'drone',
          data: [top],
          getPosition: (d: [number, number, number]) => d,
          getRadius: 9,
          radiusUnits: 'pixels',
          getFillColor: [236, 72, 153],
          getLineColor: [255, 255, 255],
          lineWidthMinPixels: 3,
          stroked: true,
          billboard: true,
        }),
      );
    }
    this.overlay.setProps({ layers: layers as never });
  }
}
