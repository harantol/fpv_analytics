import type { VideoLog, VideoSample } from '../types';

type NumField = Exclude<keyof VideoSample, 't'>;

/** Clés reconnues dans les sous-titres DJI (O3, O4, FPV V2) et Walksnail. */
const KEYS: Record<string, NumField> = {
  signal: 'signal',
  ch: 'channel',
  delay: 'delay',
  bitrate: 'bitrate',
  sbat: 'droneBat',
  uavbat: 'droneBat',
  gbat: 'gogglesBat',
  glsbat: 'gogglesBat',
};

function parseTimestamp(s: string): number {
  const m = s.match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** Parse un fichier .srt d'OSD/télémétrie vidéo (DJI, Walksnail). */
export function parseSrt(text: string, name = 'video.srt'): VideoLog {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  const samples: VideoSample[] = [];
  const fields = new Set<keyof VideoSample>(['t']);

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const t = parseTimestamp(lines[timeIdx].split('-->')[0]);
    if (!Number.isFinite(t)) continue;
    const body = lines.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, ' ');

    const s: VideoSample = { t };
    const re = /([A-Za-z]+)\s*[:=]\s*(-?\d+(?:\.\d+)?)([A-Za-z/%]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const field = KEYS[m[1].toLowerCase()];
      if (!field) continue;
      let v = Number(m[2]);
      const unit = m[3].toLowerCase();
      if (field === 'bitrate' && unit.startsWith('kbps')) v /= 1000;
      s[field] = v;
      fields.add(field);
    }
    if (Object.keys(s).length > 1) samples.push(s);
  }

  if (samples.length === 0) throw new Error('Aucune donnée vidéo (Signal, Bitrate, Delay…) trouvée dans le fichier SRT.');
  samples.sort((a, b) => a.t - b.t);
  return { name, samples, fields };
}
