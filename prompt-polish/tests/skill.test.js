import { expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'skills', 'prompt-polish');

// Catches a skill that harnesses silently skip or that points at a moved file.
test('skill metadata is loadable and every linked resource exists inside the skill', async () => {
  const skill = await readFile(join(dir, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
  expect(/^name: (.+)$/m.exec(frontmatter)?.[1]).toBe('prompt-polish');
  const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? '';
  expect(description.length).toBeGreaterThan(0);
  expect(description.length).toBeLessThanOrEqual(1024);

  const links = [...skill.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
  expect(links).toContain('references/polishing.md');
  for (const link of links) {
    expect(link.startsWith('/') || link.includes('..')).toBe(false);
    expect((await stat(join(dir, link))).isFile()).toBe(true);
  }
});
