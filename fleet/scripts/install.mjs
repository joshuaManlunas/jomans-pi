#!/usr/bin/env node
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillEntries = ['SKILL.md', 'README.md', 'config.json', 'agents', 'references', 'scripts', 'tests/dispatch-route.test.mjs'];
const usage = 'Usage: node scripts/install.mjs <skills-directory> [--claude-agents <agents-directory>]';

const args = process.argv.slice(2);
const skillsDir = args[0];
const agentsFlag = args.indexOf('--claude-agents');
const agentsDir = agentsFlag === -1 ? undefined : args[agentsFlag + 1];
const valid = skillsDir && !skillsDir.startsWith('--') &&
  (agentsFlag === -1 ? args.length === 1 : agentsFlag === 1 && agentsDir && args.length === 3);

async function assertAbsent(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Target already exists; refusing to overwrite: ${path}`);
}

if (!valid) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const target = join(resolve(skillsDir), 'fleet');
    const workerSource = join(source, 'claude-code', 'agents');
    const workers = agentsDir ? (await readdir(workerSource)).filter((name) => name.endsWith('.md')) : [];

    // Check every target before writing anything, so a conflict leaves no partial install.
    await assertAbsent(target);
    for (const worker of workers) await assertAbsent(join(resolve(agentsDir), worker));

    await mkdir(join(target, 'tests'), { recursive: true });
    for (const entry of skillEntries) {
      await cp(join(source, entry), join(target, entry), { recursive: true, force: false, errorOnExist: true });
    }
    console.log(`Installed skill: ${target}`);

    if (agentsDir) {
      await mkdir(resolve(agentsDir), { recursive: true });
      for (const worker of workers) {
        const destination = join(resolve(agentsDir), worker);
        await cp(join(workerSource, worker), destination, { force: false, errorOnExist: true });
        console.log(`Installed worker: ${destination}`);
      }
    }
  } catch (error) {
    console.error(`Install failed: ${error.message}`);
    process.exitCode = 1;
  }
}
