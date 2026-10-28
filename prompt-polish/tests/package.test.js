import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYSTEM_PROMPT } from '../scripts/polish.mjs';

const root = join(import.meta.dirname, '..');

test('canonical source snapshot and full polishing contract match the port', async () => {
  const provenance = JSON.parse(await readFile(join(root, 'assets/source-provenance.json'), 'utf8'));
  try { await stat(join(root, 'extensions/prompt-polish/index.ts')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const [file, expected] of Object.entries(provenance.files)) {
    const actual = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
    expect(actual).toBe(expected);
  }
  const src = await readFile(join(root, 'extensions/prompt-polish/index.ts'), 'utf8');
  const start = src.indexOf('const SYSTEM_PROMPT = ') + 'const SYSTEM_PROMPT = '.length;
  const end = src.indexOf(';\n\nconst RETRY_SYSTEM_PROMPT', start);
  const canonical = Function('return ' + src.slice(start, end))();
  expect(SYSTEM_PROMPT).toBe(canonical);
  expect(await readFile(join(root, 'assets/polish.config.json'), 'utf8')).toBe(await readFile(join(root, 'extensions/prompt-polish/polish.config.json'), 'utf8'));
});

test('standalone install excludes harness code, runs on Node from a different cwd, and refuses overwrite', async () => {
  const temporary = await mkdtemp(join(import.meta.dirname, 'install-check-'));
  try {
    const installed = join(temporary, 'prompt-polish');
    const run = (args) => spawnSync('node', args, { cwd: import.meta.dirname, encoding: 'utf8' });
    const install = run([join(root, 'scripts/install.mjs'), temporary]);
    expect(install.status).toBe(0);
    expect((await stat(join(installed, 'SKILL.md'))).isFile()).toBe(true);
    for (const absent of ['extensions', 'claude-code', 'node_modules', 'package.json']) {
      await expect(stat(join(installed, absent))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const validated = run([join(installed, 'scripts/validate.mjs')]);
    expect(validated.stderr).toBe('');
    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain('PASS:');
    const duplicate = run([join(root, 'scripts/install.mjs'), temporary]);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain('refusing to overwrite');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
