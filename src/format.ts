export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '–';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const out = `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
  return neg ? `-${out}` : out;
}

export function formatDistance(m: number | undefined): string {
  if (m === undefined) return '–';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export function fmt(v: number | undefined, digits = 0, unit = ''): string {
  if (v === undefined || !Number.isFinite(v)) return '–';
  return `${v.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}
