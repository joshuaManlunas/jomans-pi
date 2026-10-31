import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
const workers = ["fleet-worker-high.md", "fleet-worker-low.md", "fleet-worker-max.md", "fleet-worker-medium.md", "fleet-worker-xhigh.md"];
const install = (...args) => spawnSync(process.execPath, [installer, ...args], { cwd: tmpdir(), encoding: "utf8" });

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-install-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("installs the skill and worker agents, and the installed copy passes its own tests", () =>
  withTemp(async (dir) => {
    const result = install(join(dir, "skills"), "--claude-agents", join(dir, "agents"));
    assert.equal(result.status, 0, result.stderr);
    const skill = join(dir, "skills", "fleet");
    for (const entry of ["SKILL.md", "config.json", "references/setup.md", "references/orca.md", "scripts/dispatch-route.mjs"]) {
      assert.ok((await stat(join(skill, entry))).isFile(), entry);
    }
    await assert.rejects(stat(join(skill, "claude-code")), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(skill, "tests")), ["dispatch-route.test.mjs"]);
    assert.deepEqual((await readdir(join(dir, "agents"))).sort(), workers);
    const tests = spawnSync(process.execPath, ["--test", join(skill, "tests", "dispatch-route.test.mjs")], { encoding: "utf8" });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  }));

test("skill-only install leaves the agents directory alone", () =>
  withTemp(async (dir) => {
    assert.equal(install(join(dir, "skills")).status, 0);
    await assert.rejects(stat(join(dir, "agents")), { code: "ENOENT" });
  }));

test("refuses to overwrite and writes nothing when any target exists", () =>
  withTemp(async (dir) => {
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "fleet-worker-low.md"), "mine");
    const result = install(join(dir, "skills"), "--claude-agents", join(dir, "agents"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to overwrite/);
    await assert.rejects(stat(join(dir, "skills", "fleet")), { code: "ENOENT" });
  }));

test("rejects malformed arguments", () => {
  for (const args of [[], ["--claude-agents", "x"], ["a", "--claude-agents"], ["a", "b"]]) {
    assert.equal(install(...args).status, 1, args.join(" "));
  }
});
