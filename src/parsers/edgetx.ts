import type { FlightLog, TelemetrySample } from '../types';

type NumField = Exclude<keyof TelemetrySample, 't' | 'rfmd' | 'flightMode'>;

interface Column {
  index: number;
  key: string; // nom normalisé, ex. "rqly"
  unit: string; // unité entre parenthèses, ex. "%"
}

/** Colonnes numériques reconnues, par ordre de priorité pour chaque champ. */
const NUMERIC_COLUMNS: Record<NumField, string[]> = {
  lat: [],
  lon: [],
  alt: ['alt', 'galt', 'gpsalt'],
  speed: ['gspd', 'gpsspeed', 'spd'],
  heading: ['hdg', 'gpshdg'],
  sats: ['sats', 'sat'],
  voltage: ['rxbt', 'vfas', 'bat', 'batt', 'vbat'],
  current: ['curr', 'current'],
  capacity: ['capa', 'fuel(mah)', 'mah'],
  batPct: ['bat%', 'fuel(%)', 'batpct'],
  rssi1: ['1rss', 'rssi'],
  rssi2: ['2rss'],
  rqly: ['rqly'],
  rsnr: ['rsnr'],
  tpwr: ['tpwr'],
  tqly: ['tqly'],
  trss: ['trss'],
  tsnr: ['tsnr'],
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      quoted = !quoted;
    } else if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseHeader(cells: string[]): Column[] {
  return cells.map((raw, index) => {
    const m = raw.match(/^([^()]*)\(([^)]*)\)\s*$/);
    const key = (m ? m[1] : raw).trim().toLowerCase();
    const unit = (m ? m[2] : '').trim().toLowerCase();
    return { index, key, unit };
  });
}

function parseTime(date: string | undefined, time: string | undefined): number | null {
  if (!time) return null;
  const m = time.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  if (date) {
    const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (d) {
      return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) / 1000 + secs;
    }
  }
  return secs;
}

/** Convertit vers les unités internes (m, km/h). */
function convert(field: NumField, value: number, unit: string): number {
  if (field === 'alt' && (unit === 'ft' || unit === 'feet')) return value * 0.3048;
  if (field === 'speed') {
    if (unit === 'kts' || unit === 'kt' || unit === 'knots') return value * 1.852;
    if (unit === 'm/s' || unit === 'mps') return value * 3.6;
    if (unit === 'mph') return value * 1.609344;
  }
  return value;
}

/**
 * Parse un log CSV de radio EdgeTX / OpenTX (ELRS, Crossfire, FrSky…).
 * Les colonnes sont détectées par leur nom, donc l'ordre n'a pas d'importance.
 */
export function parseEdgeTxCsv(text: string, name = 'log.csv'): FlightLog {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Fichier CSV vide ou sans données.');

  const header = parseHeader(splitCsvLine(lines[0]));
  const find = (keys: string[]): Column | undefined => {
    for (const k of keys) {
      const col = header.find((c) => c.key === k || `${c.key}(${c.unit})` === k);
      if (col) return col;
    }
    return undefined;
  };

  const dateCol = find(['date']);
  const timeCol = find(['time']);
  const gpsCol = find(['gps']);
  const latCol = find(['lat', 'latitude']);
  const lonCol = find(['lon', 'lng', 'longitude']);
  const rfmdCol = find(['rfmd']);
  const fmCol = find(['fm', 'flightmode', 'fmode']);

  const numCols: [NumField, Column][] = [];
  for (const [field, keys] of Object.entries(NUMERIC_COLUMNS) as [NumField, string[]][]) {
    const col = find(keys);
    if (col) numCols.push([field, col]);
  }

  if (!timeCol) throw new Error('Colonne "Time" introuvable : ce fichier ne ressemble pas à un log EdgeTX/OpenTX.');

  const fields = new Set<keyof TelemetrySample>(['t']);
  const samples: TelemetrySample[] = [];
  let t0: number | null = null;
  let lastAbs: number | null = null;
  let dayOffset = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    let abs = parseTime(dateCol && cells[dateCol.index], cells[timeCol.index]);
    if (abs === null) continue;
    abs += dayOffset;
    // Passage de minuit sans colonne Date
    if (lastAbs !== null && abs < lastAbs - 43200) {
      dayOffset += 86400;
      abs += 86400;
    }
    lastAbs = abs;
    if (t0 === null) t0 = abs;

    const s: TelemetrySample = { t: abs - t0 };

    for (const [field, col] of numCols) {
      const raw = cells[col.index];
      if (raw === undefined || raw === '') continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      s[field] = convert(field, v, col.unit);
      fields.add(field);
    }

    let lat: number | undefined;
    let lon: number | undefined;
    if (gpsCol) {
      const parts = (cells[gpsCol.index] ?? '').split(/[\s;]+/).filter(Boolean);
      if (parts.length >= 2) {
        lat = Number(parts[0]);
        lon = Number(parts[1]);
      }
    } else if (latCol && lonCol) {
      lat = Number(cells[latCol.index]);
      lon = Number(cells[lonCol.index]);
    }
    // Ignore les positions sans fix (0,0) ou invalides
    if (lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      s.lat = lat;
      s.lon = lon;
      fields.add('lat').add('lon');
    }

    if (rfmdCol && cells[rfmdCol.index]) {
      s.rfmd = cells[rfmdCol.index];
      fields.add('rfmd');
    }
    if (fmCol && cells[fmCol.index]) {
      s.flightMode = cells[fmCol.index];
      fields.add('flightMode');
    }
    samples.push(s);
  }

  if (samples.length === 0) throw new Error('Aucune ligne de données lisible dans le CSV.');

  let start: Date | null = null;
  if (dateCol && t0 !== null && t0 > 86400 * 365) start = new Date(t0 * 1000);

  return { name, start, samples, fields };
}
