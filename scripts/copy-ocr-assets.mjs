#!/usr/bin/env node
/**
 * Copie dans public/ocr/ les fichiers de Tesseract.js (moteur de lecture de texte)
 * nécessaires à la lecture du débit sur l'OSD de la vidéo. Ils sont embarqués dans
 * l'app pour qu'elle fonctionne sans réseau.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'ocr');
mkdirSync(OUT, { recursive: true });

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const tess = pkgDir('tesseract.js');
const core = pkgDir('tesseract.js-core');
const eng = pkgDir('@tesseract.js-data/eng');

const files = [
  [join(tess, 'dist', 'worker.min.js'), 'worker.min.js'],
  // Moteur LSTM uniquement (le plus précis) : variantes choisies selon le processeur
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [join(core, f), f]),
  // Nom neutre : le build Android décompresse les fichiers « .gz » des assets et retire
  // leur extension. Le contenu reste compressé (gzip), Tesseract le reconnaît seul.
  [join(eng, '4.0.0_best_int', 'eng.traineddata.gz'), 'eng.traineddata.bin'],
];
for (const [from, to] of files) copyFileSync(from, join(OUT, to));
console.log(`OCR : ${files.length} fichiers copiés dans public/ocr/`);
