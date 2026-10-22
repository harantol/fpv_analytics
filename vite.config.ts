import { defineConfig } from 'vite';

export default defineConfig({
  // Chemins relatifs : l'app fonctionne aussi bien sur GitHub Pages qu'en local
  base: './',
  build: { chunkSizeWarningLimit: 3000 },
});
