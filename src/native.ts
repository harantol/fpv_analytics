import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

export const isNative = Capacitor.isNativePlatform();

/**
 * Comportements propres à l'app Android :
 * - bouton retour : ferme l'aide, sinon délègue à l'app (pause, retour à la
 *   liste des vols), sinon quitte l'app ;
 * - sélecteur de fichiers sans filtre d'extension (Android ne connaît pas
 *   toujours le type MIME des .csv/.srt lus depuis la radio en USB).
 */
export function setupNative(opts: { onBack: () => boolean }) {
  if (!isNative) return;
  document.documentElement.classList.add('native');
  document.querySelectorAll<HTMLInputElement>('input[type=file]').forEach((i) => i.removeAttribute('accept'));
  App.addListener('backButton', () => {
    const openDialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (openDialog) openDialog.close();
    else if (!opts.onBack()) App.exitApp();
  });
}
