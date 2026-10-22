/**
 * Débit de paquets ExpressLRS à partir du champ RFMD de la télémétrie CRSF.
 *
 * Le récepteur ELRS y place l'identifiant interne du débit actif
 * (`linkStats.rf_Mode = ExpressLRS_currAirRate_Modparams->enum_rate`), dont la
 * numérotation a changé entre ELRS 3.x et 4.x (enum `expresslrs_RFrates_e`).
 */

export type ElrsVersion = 3 | 4;

export interface PacketRate {
  /** Paquets par seconde. */
  hz: number;
  /** Libellé court, ex. « 250 Hz », « 100 Hz 8 voies ». */
  label: string;
  /** Détail : modulation et bande, si connues. */
  detail?: string;
}

type Entry = [hz: number, detail: string, ch8?: boolean];

/** ELRS 3.x (énumération 0–19, toutes bandes confondues). */
const V3: Record<number, Entry> = {
  0: [4, 'LoRa'],
  1: [25, 'LoRa'],
  2: [50, 'LoRa'],
  3: [100, 'LoRa'],
  4: [100, 'LoRa', true],
  5: [150, 'LoRa'],
  6: [200, 'LoRa'],
  7: [250, 'LoRa'],
  8: [333, 'LoRa', true],
  9: [500, 'LoRa'],
  10: [250, 'DVDA'],
  11: [500, 'DVDA'],
  12: [500, 'FLRC'],
  13: [1000, 'FLRC'],
  14: [50, 'DVDA'],
  15: [200, 'LoRa', true],
  16: [500, 'FSK DVDA 2,4 GHz'],
  17: [1000, 'FSK 2,4 GHz'],
  18: [1000, 'FSK 900 MHz'],
  19: [1000, 'FSK 900 MHz', true],
};

/** ELRS 4.x (0–11 : 900 MHz, 20–36 : 2,4 GHz, 100+ : double bande). */
const V4: Record<number, Entry> = {
  0: [25, 'LoRa 900 MHz'],
  1: [50, 'LoRa 900 MHz'],
  2: [100, 'LoRa 900 MHz'],
  3: [100, 'LoRa 900 MHz', true],
  4: [150, 'LoRa 900 MHz'],
  5: [200, 'LoRa 900 MHz'],
  6: [200, 'LoRa 900 MHz', true],
  7: [250, 'LoRa 900 MHz'],
  8: [333, 'LoRa 900 MHz', true],
  9: [500, 'LoRa 900 MHz'],
  10: [50, 'LoRa 900 MHz DVDA'],
  11: [1000, 'FSK 900 MHz', true],
  20: [25, 'LoRa 2,4 GHz'],
  21: [50, 'LoRa 2,4 GHz'],
  22: [100, 'LoRa 2,4 GHz'],
  23: [100, 'LoRa 2,4 GHz', true],
  24: [150, 'LoRa 2,4 GHz'],
  25: [200, 'LoRa 2,4 GHz'],
  26: [200, 'LoRa 2,4 GHz', true],
  27: [250, 'LoRa 2,4 GHz'],
  28: [333, 'LoRa 2,4 GHz', true],
  29: [500, 'LoRa 2,4 GHz'],
  30: [250, 'FLRC 2,4 GHz DVDA'],
  31: [500, 'FLRC 2,4 GHz DVDA'],
  32: [500, 'FLRC 2,4 GHz'],
  33: [1000, 'FLRC 2,4 GHz'],
  34: [250, 'FSK 2,4 GHz DVDA'],
  35: [500, 'FSK 2,4 GHz DVDA'],
  36: [1000, 'FSK 2,4 GHz'],
  100: [100, 'LoRa double bande', true],
  101: [150, 'LoRa double bande'],
};

export function packetRate(rfmd: string | undefined, version: ElrsVersion): PacketRate | null {
  if (rfmd === undefined || !/^\d+$/.test(rfmd.trim())) return null;
  const e = (version === 3 ? V3 : V4)[Number(rfmd)];
  if (!e) return null;
  const [hz, detail, ch8] = e;
  return { hz, label: `${hz} Hz${ch8 ? ' 8 voies' : ''}`, detail };
}

const KEY = 'fpv-analytics.elrsVersion';

/** Version d'ELRS choisie (4.x par défaut, la version actuelle). */
export function getElrsVersion(): ElrsVersion {
  try {
    return localStorage.getItem(KEY) === '3' ? 3 : 4;
  } catch {
    return 4;
  }
}

export function setElrsVersion(v: ElrsVersion) {
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* stockage indisponible : réglage gardé pour la session seulement */
  }
}
