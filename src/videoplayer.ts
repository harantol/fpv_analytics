/**
 * Lecteur de la vidéo des lunettes, synchronisé avec le vol.
 *
 * Le temps du vol t et celui de la vidéo sont liés par le décalage vidéo :
 * tVidéo = t − offset. Pendant la lecture, c'est la vidéo qui donne l'heure
 * (carte, courbes et HUD la suivent) ; quand on clique sur une courbe ou un
 * événement, la vidéo se place au même instant.
 *
 * La vidéo n'est jamais copiée : elle est lue directement depuis le fichier
 * choisi, le temps de la session.
 */

/** Écart toléré (s) avant de repositionner la vidéo, pour éviter les sauts inutiles. */
const SEEK_TOLERANCE = 0.12;
/** Vitesse de lecture maximale acceptée par les navigateurs. */
const MAX_RATE = 16;

export class VideoPlayer {
  readonly video: HTMLVideoElement;
  private url: string | null = null;
  private name: string | null = null;
  private offset = 0;
  private status: HTMLElement;
  private failed = false;
  /** Dernier instant demandé : appliqué dès que la vidéo connaît sa durée. */
  private pendingT: number | null = null;

  constructor(private panel: HTMLElement) {
    this.video = panel.querySelector('video')!;
    this.status = panel.querySelector('.video-status')!;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.addEventListener('error', () => {
      this.failed = true;
      this.showStatus("Cette vidéo ne peut pas être lue sur cet appareil (codec H.265 ?). Réglez l'enregistrement des lunettes en H.264.");
    });
    this.video.addEventListener('loadedmetadata', () => {
      this.failed = false;
      if (this.pendingT !== null) this.seek(this.pendingT, true);
    });
  }

  /** Nom du fichier vidéo chargé, ou null. */
  get loadedName() {
    return this.name;
  }

  get loaded() {
    return this.url !== null && !this.failed;
  }

  load(file: File, offset: number) {
    this.clear();
    this.url = URL.createObjectURL(file);
    this.name = file.name;
    this.offset = offset;
    this.failed = false;
    this.video.src = this.url;
    this.panel.hidden = false;
    this.panel.closest('.viz')?.classList.add('has-video');
  }

  clear() {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.name = null;
    this.pendingT = null;
    this.panel.hidden = true;
    this.panel.closest('.viz')?.classList.remove('has-video');
  }

  /** Change le décalage et replace l'image en conséquence. */
  setOffset(offset: number, t?: number) {
    this.offset = offset;
    if (t !== undefined && !this.playing) this.seek(t, true);
  }

  /** L'instant t du vol est-il couvert par la vidéo ? */
  covers(t: number): boolean {
    if (!this.loaded || !Number.isFinite(this.video.duration)) return false;
    const vt = t - this.offset;
    return vt >= 0 && vt < this.video.duration - 0.05;
  }

  /** Instant du vol correspondant à l'image affichée. */
  flightTime(): number {
    return this.video.currentTime + this.offset;
  }

  get playing() {
    return !this.video.paused && !this.video.ended;
  }

  /** Place la vidéo à l'instant t du vol (sans la lancer). force : même pour un petit écart. */
  seek(t: number, force = false) {
    if (!this.loaded) return;
    this.pendingT = t;
    if (!Number.isFinite(this.video.duration)) return; // métadonnées pas encore chargées
    if (!this.covers(t)) {
      this.video.pause();
      this.showStatus('Hors de la vidéo');
      return;
    }
    this.showStatus(null);
    const vt = t - this.offset;
    if (force || Math.abs(this.video.currentTime - vt) > SEEK_TOLERANCE) this.video.currentTime = vt;
  }

  /** Lance la lecture depuis l'instant t, à la vitesse demandée. */
  play(t: number, rate: number) {
    if (!this.covers(t)) return;
    this.seek(t);
    this.video.playbackRate = Math.min(rate, MAX_RATE);
    this.video.play().catch(() => {
      /* lecture refusée (fichier illisible) : le minuteur prend le relais */
    });
  }

  pause() {
    this.video.pause();
  }

  private showStatus(text: string | null) {
    if (this.failed && text !== null && !text.startsWith('Cette')) return;
    this.status.textContent = text ?? '';
    this.status.hidden = text === null;
  }
}
