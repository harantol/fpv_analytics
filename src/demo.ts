/**
 * Génère un vol de démonstration (log EdgeTX + SRT DJI) au-dessus du lac d'Annecy.
 * Les fichiers produits passent par les mêmes parseurs que les vrais fichiers.
 */

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function generateDemo(): { csv: string; srt: string } {
  const rand = rng(42);
  const noise = (a: number) => (rand() - 0.5) * 2 * a;

  const home = { lat: 45.8655, lon: 6.1705 };
  // Points de passage (lat, lon, altitude relative m)
  const wps: [number, number, number][] = [
    [home.lat, home.lon, 0],
    [45.8615, 6.175, 120],
    [45.845, 6.185, 290],
    [45.825, 6.193, 280],
    [45.805, 6.203, 290],
    [45.797, 6.215, 300],
    [45.803, 6.222, 290],
    [45.822, 6.205, 280],
    [45.845, 6.19, 220],
    [45.862, 6.176, 60],
    [home.lat + 0.0002, home.lon + 0.0001, 0],
  ];
  const segDur = [30, 70, 75, 75, 40, 30, 70, 80, 70, 40];
  const hz = 5;
  const preArm = 8; // secondes au sol avant décollage
  const total = preArm + segDur.reduce((a, b) => a + b, 0) + 6;
  const n = Math.round(total * hz);

  const header = [
    'Date', 'Time', '1RSS(dB)', '2RSS(dB)', 'RQly(%)', 'RSNR(dB)', 'ANT', 'RFMD', 'TPWR(mW)',
    'TRSS(dB)', 'TQly(%)', 'TSNR(dB)', 'RxBt(V)', 'Curr(A)', 'Capa(mAh)', 'Bat%(%)',
    'FM', 'GPS', 'GSpd(kmh)', 'Hdg(@)', 'Alt(m)', 'Sats', 'Thr', 'TxBat(V)',
  ];
  const rows = [header.join(',')];
  const srt: string[] = [];

  const startSec = 14 * 3600 + 32 * 60 + 5;
  let mah = 0;
  let prev: [number, number] | null = null;
  const baseAlt = 452; // altitude MSL du point de départ

  for (let i = 0; i < n; i++) {
    const t = i / hz;
    let lat = home.lat;
    let lon = home.lon;
    let alt = 0;
    let flying = false;
    let tt = t - preArm;
    if (tt >= 0) {
      for (let k = 0; k < segDur.length; k++) {
        if (tt <= segDur[k]) {
          const f = tt / segDur[k];
          const e = f;
          const a = wps[k];
          const b = wps[k + 1];
          lat = a[0] + (b[0] - a[0]) * e;
          lon = a[1] + (b[1] - a[1]) * e;
          alt = a[2] + (b[2] - a[2]) * e;
          flying = true;
          break;
        }
        tt -= segDur[k];
      }
      if (!flying) {
        const last = wps[wps.length - 1];
        lat = last[0];
        lon = last[1];
      }
    }
    const clean: [number, number] = [lat, lon];
    lat += noise(0.0000015);
    lon += noise(0.0000015);
    alt = Math.max(0, alt + (flying ? noise(0.6) : 0));

    const dLat = (lat - home.lat) * 111320;
    const dLon = (lon - home.lon) * 111320 * Math.cos((home.lat * Math.PI) / 180);
    const dist = Math.hypot(dLat, dLon);

    let speed = 0;
    let hdg = 0;
    if (prev) {
      const dy = (clean[0] - prev[0]) * 111320;
      const dx = (clean[1] - prev[1]) * 111320 * Math.cos((lat * Math.PI) / 180);
      speed = flying ? Math.hypot(dx, dy) * hz * 3.6 + noise(2) : 0;
      hdg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    }
    prev = clean;

    // Radio : le RSSI baisse avec la distance, la puissance d'émission monte
    const tpwr = dist < 1500 ? 100 : dist < 4000 ? 250 : 500;
    const pathLoss = 20 * Math.log10(Math.max(dist, 5)) + 30;
    const rssi1 = Math.round(Math.min(-35, 10 * Math.log10(tpwr) - pathLoss - 15 + noise(3)));
    const rssi2 = Math.round(rssi1 - 2 + noise(3));
    const snr = Math.round(Math.max(-12, Math.min(12, (rssi1 + 105) / 3.5 + noise(1.5))));
    // Zone de mauvaise réception (masquage) au point le plus éloigné
    const shadow = dist > 7000 ? (dist - 7000) / 30 : 0;
    let rqly = Math.round(Math.max(0, Math.min(100, 100 - Math.max(0, -snr) * 4 - shadow + noise(2))));
    if (dist < 1500) rqly = Math.min(100, Math.max(rqly, 98));

    // Batterie 6S Li-ion
    const thr = flying ? 1500 + Math.round(alt > 100 ? 120 : 220) + Math.round(noise(40)) : 1000;
    const curr = flying ? 6 + (thr - 1500) / 40 + noise(1.5) : 0.4;
    mah += (curr * 1000) / 3600 / hz;
    const capacity = 4000;
    const rest = 25.0 - (mah / capacity) * 6.5;
    const volt = rest - curr * 0.035 + noise(0.04);
    const pct = Math.max(0, Math.round(100 - (mah / capacity) * 100));

    const sec = startSec + t;
    const time = `${pad(sec / 3600)}:${pad((sec / 60) % 60)}:${pad(sec % 60)}.${pad(Math.round((sec % 1) * 1000), 3)}`;
    const fm = !flying && t < preArm ? '!ERR' : flying ? 'ANGL' : 'ACRO';

    rows.push([
      '2026-09-14', time, rssi1, rssi2, rqly, snr, 0, 'D250', tpwr,
      Math.round(-40 - dist / 400 + noise(3)), Math.max(0, rqly - 2), Math.round(snr + noise(1)),
      volt.toFixed(1), curr.toFixed(1), Math.round(mah), pct,
      fm, `${lat.toFixed(6)} ${lon.toFixed(6)}`, speed.toFixed(1), Math.round(hdg),
      Math.round(baseAlt + alt), dist > 6000 ? 14 : 17, thr, '7.9',
    ].join(','));

    // SRT vidéo : l'enregistrement commence 4 s après le début du log
    const tv = t - 4;
    if (tv >= 0) {
      const sig = dist < 3000 ? 4 : dist < 5500 ? 3 : dist < 7200 ? 2 : 1;
      const bitrate = Math.max(2, (sig >= 4 ? 45 : sig === 3 ? 28 : sig === 2 ? 14 : 5) + noise(3));
      const delay = Math.round((sig >= 3 ? 26 : sig === 2 ? 34 : 45) + noise(3));
      const toSrt = (x: number) => `${pad(x / 3600)}:${pad((x / 60) % 60)}:${pad(x % 60)},${pad(Math.round((x % 1) * 1000), 3)}`;
      srt.push(
        `${srt.length + 1}\n${toSrt(tv)} --> ${toSrt(tv + 1 / hz)}\n` +
          `Signal:${sig} CH:3 FlightTime:${Math.max(0, Math.round(t - preArm))} SBat:${volt.toFixed(1)}V GBat:7.4V Delay:${delay}ms Bitrate:${bitrate.toFixed(1)}Mbps Distance:${Math.round(dist)}m Height:${Math.round(alt)}m\n`,
      );
    }
  }
  return { csv: rows.join('\n'), srt: srt.join('\n') };
}
