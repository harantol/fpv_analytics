/** Un échantillon de télémétrie radio (EdgeTX / OpenTX). */
export interface TelemetrySample {
  /** Secondes depuis le début du log. */
  t: number;
  lat?: number;
  lon?: number;
  /** Altitude en mètres (relative ou MSL selon le capteur). */
  alt?: number;
  /** Vitesse sol en km/h. */
  speed?: number;
  heading?: number;
  sats?: number;
  /** Tension batterie de vol (V). */
  voltage?: number;
  current?: number;
  /** Capacité consommée (mAh). */
  capacity?: number;
  batPct?: number;
  /** RSSI antenne 1 / 2 en dBm. */
  rssi1?: number;
  rssi2?: number;
  /** Link quality montante (%). */
  rqly?: number;
  rsnr?: number;
  /** Puissance d'émission (mW). */
  tpwr?: number;
  tqly?: number;
  trss?: number;
  tsnr?: number;
  rfmd?: string;
  flightMode?: string;
  /** RSSI vu par le contrôleur de vol (%), depuis le Blackbox. */
  fcRssi?: number;
  /** Gaz (%), depuis le Blackbox. */
  throttle?: number;
}

export interface FlightLog {
  name: string;
  /** Date/heure absolue du premier échantillon, si connue. */
  start: Date | null;
  samples: TelemetrySample[];
  /** Champs effectivement présents dans le log. */
  fields: Set<keyof TelemetrySample>;
  /** Origine des données : log radio, Blackbox du contrôleur de vol, ou les deux. */
  source?: 'radio' | 'blackbox' | 'both';
  /** Firmware du contrôleur de vol (Blackbox). */
  firmware?: string;
}

/** Un échantillon issu d'un fichier .srt des lunettes (DJI O3/O4, Walksnail…). */
export interface VideoSample {
  /** Secondes depuis le début de l'enregistrement. */
  t: number;
  /** Qualité du signal (0–4 chez DJI/Walksnail). */
  signal?: number;
  /** Débit vidéo en Mbps. */
  bitrate?: number;
  /** Latence en ms. */
  delay?: number;
  channel?: number;
  /** Tension batterie drone vue par le système vidéo (V). */
  droneBat?: number;
  /** Tension batterie lunettes (V). */
  gogglesBat?: number;
  /** Images perdues (%), estimées depuis l'enregistrement des lunettes. */
  frameLoss?: number;
  /** Images reçues par seconde. */
  fps?: number;
}

export interface VideoLog {
  name: string;
  samples: VideoSample[];
  fields: Set<keyof VideoSample>;
  /** Le débit vient de l'OSD lu sur les images (sinon : estimé depuis le fichier). */
  osd?: boolean;
}
