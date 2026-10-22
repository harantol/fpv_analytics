import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

export const isNative = Capacitor.isNativePlatform();

/**
 * Comportements propres à l'app Android :
 * - bouton retour : met en pause la lecture, sinon quitte l'app ;
 * - sélecteur de fichiers sans filtre d'extension (Android ne connaît pas
 *   toujours le type MIME des .csv/.srt lus depuis la radio en USB).
 */
export function setupNative(opts: { isPlaying: () => boolean; stop: () => void }) {
  if (!isNative) return;
  document.documentElement.classList.add('native');
  document.querySelectorAll<HTMLInputElement>('input[type=file]').forEach((i) => i.removeAttribute('accept'));
  App.addListener('backButton', () => {
    if (opts.isPlaying()) opts.stop();
    else App.exitApp();
  });
}
