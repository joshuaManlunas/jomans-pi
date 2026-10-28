#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { polishPrompt, SYSTEM_PROMPT } from './polish.mjs';
import { loadPolishConfig } from './config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skill = await readFile(join(root, 'SKILL.md'), 'utf8');
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
assert.ok(frontmatter, 'YAML frontmatter is required');
const name = /^name: (.+)$/m.exec(frontmatter)?.[1];
const description = /^description: (.+)$/m.exec(frontmatter)?.[1];
assert.equal(name, basename(root));
assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.ok(name.length <= 64);
assert.ok(description && description.length <= 1024);
assert.ok(skill.split('\n').length < 500);
for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) {
  assert.ok(!(match[1].startsWith('/') || match[1].includes('..')), 'Resources must be skill-relative');
  assert.ok((await stat(join(root, match[1]))).isFile());
}
assert.ok(SYSTEM_PROMPT.startsWith('# Role\n'));
assert.ok(SYSTEM_PROMPT.includes('**Define "done" (always required).**'));
for (const file of await readdir(join(root, 'scripts'))) {
  if (!['polish.mjs', 'config.mjs', 'clipboard.mjs', 'session.mjs', 'install.mjs'].includes(file)) continue;
  const text = await readFile(join(root, 'scripts', file), 'utf8');
  assert.ok(!/@(?:earendil-works|mariozechner)\/pi-|ExtensionAPI|registerShortcut|sessionManager|Bun\./.test(text), `${file} contains a harness dependency`);
}
const config = await loadPolishConfig();
assert.equal(typeof config.model, 'string');
let calls = 0;
const improved = await polishPrompt('A test prompt', {
  model: { provider: 'smoke', id: 'test' },
  backend: {
    listModels: () => [],
    complete: (_model, request) => {
      calls++;
      assert.deepEqual(request.tools, []);
      assert.ok(request.systemPrompt.includes(SYSTEM_PROMPT));
      return { stopReason: 'stop', content: [{ type: 'text', text: '  exact\n\n  prompt  ' }] };
    },
  },
});
assert.equal(improved, 'exact\n\n  prompt');
assert.equal(calls, 1);
console.log('PASS: skill metadata, resource links, portable runtime, module-relative config, and Node completion smoke test');
