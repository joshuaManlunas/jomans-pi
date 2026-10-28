#!/usr/bin/env node
import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetParent = process.argv[2];
if (!targetParent || process.argv.length !== 3) {
  console.error('Usage: node scripts/install.mjs <harness-skills-directory>');
  process.exitCode = 1;
} else {
  const target = join(resolve(targetParent), 'prompt-polish');
  try {
    try {
      await stat(target);
      throw new Error(`Target already exists; refusing to overwrite: ${target}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await mkdir(resolve(targetParent), { recursive: true });
    await mkdir(target);
    for (const entry of ['SKILL.md', 'README.md', 'references', 'scripts', 'assets']) {
      await cp(join(source, entry), join(target, entry), { recursive: true, force: false, errorOnExist: true });
    }
    console.log(`Installed skill: ${target}`);
  } catch (error) {
    console.error(`Install failed: ${error.message}`);
    process.exitCode = 1;
  }
}
