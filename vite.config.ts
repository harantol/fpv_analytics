import { defineConfig } from 'vite';
// @ts-expect-error script JavaScript sans types
import { getVersion } from './scripts/version.mjs';

export default defineConfig({
  // Chemins relatifs : nécessaire pour l'app Android (fichiers servis localement)
  base: './',
  // Version MAJEUR.MINEUR calculée depuis git (scripts/version.mjs)
  define: { __APP_VERSION__: JSON.stringify(getVersion()) },
  build: { chunkSizeWarningLimit: 3000 },
});
