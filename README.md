# FPV Analytics

Application web pour analyser des vols de drone FPV long range :

- **Trace GPS en 3D** sur le relief (imagerie satellite ou carte topo), colorée selon la mesure de votre choix : link quality, RSSI, tension, signal vidéo, altitude, vitesse…
- **Batterie** : tension (par élément, nombre d'éléments estimé automatiquement), courant, mAh consommés, %.
- **Liaison radio** : RQly / TQly, RSSI, SNR, puissance d'émission, mode RF. Détection des pertes de liaison (RQly à 0 %) et du temps passé sous 50 %.
- **Liaison vidéo** : signal (0–4), débit et latence lus dans le `.srt` des lunettes DJI / Walksnail.
- **Lecture du vol** : timeline, lecture accélérée, suivi caméra, HUD, curseur synchronisé entre la carte et les graphiques.

Tout est traité dans le navigateur : aucun fichier n'est envoyé sur un serveur.

## Fichiers acceptés

| Fichier | Où le trouver | Contenu utilisé |
| --- | --- | --- |
| `.csv` | Carte SD de la radio EdgeTX / OpenTX, dossier `LOGS` | GPS, altitude, vitesse, batterie, liaison radio (ELRS, Crossfire, FrSky…) |
| `.srt` (optionnel) | À côté de la vidéo enregistrée par les lunettes DJI (O3, O4, FPV V2) ou Walksnail | Signal vidéo, débit, latence |

Pour obtenir les logs radio : dans EdgeTX, ajoutez une *Fonction spéciale* → **Écrire logs SD** (intervalle 0,2 s) déclenchée par l'interrupteur d'armement.

**Synchro vidéo** : le `.srt` démarre au début de l'enregistrement vidéo, pas au début du log. L'app cherche le décalage automatiquement en comparant la tension batterie des deux fichiers ; vous pouvez l'ajuster à la main (± 1 s).

**Altitude 3D** : la trace est placée à « altitude du sol au point de départ + altitude relative au départ ». La hauteur au-dessus du sol est calculée avec les tuiles d'élévation AWS Terrain Tiles (~20 m de précision).

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173  (ajoutez ?demo pour charger le vol de démo)
npm test         # tests des parseurs et des calculs
npm run build    # version statique dans dist/
```

Le workflow `.github/workflows/deploy.yml` publie l'app sur GitHub Pages à chaque push sur `main` (activez *Settings → Pages → Source : GitHub Actions*).

## Structure

- `src/parsers/` – lecture des logs EdgeTX (`edgetx.ts`) et des sous-titres vidéo (`srt.ts`)
- `src/analysis.ts` – fusion télémétrie + vidéo, distance, statistiques, synchro vidéo
- `src/map3d.ts` – carte 3D (MapLibre + relief, trace deck.gl)
- `src/charts.ts` – graphiques (uPlot)
- `src/demo.ts` – génération d'un vol de démonstration

## Pistes pour la suite

- Blackbox Betaflight / INAV (`.bbl`, `.txt`) pour les données haute fréquence
- Export KML / GPX, comparaison de plusieurs vols
- Lecture de la vidéo DVR synchronisée avec la carte
