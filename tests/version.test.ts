import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Exécute scripts/version.mjs dans un dépôt git jetable. */
function repoWith(commits: (dir: string, git: (...a: string[]) => void) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'ver-'));
  mkdirSync(join(dir, 'scripts'));
  cpSync('scripts/version.mjs', join(dir, 'scripts/version.mjs'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  commits(dir, git);
  const env = { ...process.env };
  delete env.APP_VERSION;
  return execFileSync('node', ['scripts/version.mjs'], { cwd: dir, encoding: 'utf8', env }).trim();
}

describe('version MAJEUR.MINEUR', () => {
  it('compte les commits depuis le changement de VERSION', () => {
    const v = repoWith((dir, git) => {
      writeFileSync(join(dir, 'VERSION'), '1\n');
      git('add', '.');
      git('commit', '-qm', 'v1');
      for (const n of [1, 2, 3]) {
        writeFileSync(join(dir, `f${n}`), '');
        git('add', '.');
        git('commit', '-qm', `pr ${n}`);
      }
    });
    expect(v).toBe('1.3');
  });

  it('repart à 0 quand le majeur change', () => {
    const v = repoWith((dir, git) => {
      writeFileSync(join(dir, 'VERSION'), '1\n');
      git('add', '.');
      git('commit', '-qm', 'v1');
      writeFileSync(join(dir, 'a'), '');
      git('add', '.');
      git('commit', '-qm', 'pr');
      writeFileSync(join(dir, 'VERSION'), '2\n');
      git('add', '.');
      git('commit', '-qm', 'v2');
    });
    expect(v).toBe('2.0');
  });
});
