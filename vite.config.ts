import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // Chemins relatifs : nécessaire pour l'app Android (fichiers servis localement)
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { chunkSizeWarningLimit: 3000 },
});
