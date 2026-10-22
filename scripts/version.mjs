#!/usr/bin/env node
/**
 * Version de l'app, MAJEUR.MINEUR (même règle que auto_pid_tuning).
 *
 * MAJEUR est le nombre du fichier VERSION à la racine. MINEUR compte les commits de main
 * (premier parent) depuis le dernier changement de VERSION : chaque PR mergée ajoute 1, et
 * changer MAJEUR remet MINEUR à 0. APP_VERSION, si elle est définie, l'emporte.
 *
 *   node scripts/version.mjs   # -> 1.4
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function getVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  let major;
  try {
    major = Number.parseInt(readFileSync(join(ROOT, 'VERSION'), 'utf8').trim(), 10);
  } catch {
    return 'dev';
  }
  if (!Number.isInteger(major)) return 'dev';
  try {
    // --first-parent : une PR qui change VERSION compte pour son commit de merge, donc X.0
    const base = git('log', '--first-parent', '-1', '--format=%H', '--', 'VERSION');
    const minor = Number.parseInt(git('rev-list', '--count', '--first-parent', `${base}..HEAD`), 10);
    return Number.isInteger(minor) ? `${major}.${minor}` : `${major}.dev`;
  } catch {
    return `${major}.dev`;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(getVersion());
