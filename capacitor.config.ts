import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.harantol.fpvanalytics',
  appName: 'FPV Analytics',
  webDir: 'dist',
  android: {
    // Pas de contenu mixte : toutes les tuiles sont en HTTPS
    allowMixedContent: false,
  },
};

export default config;
