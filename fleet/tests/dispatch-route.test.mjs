import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const probe = fileURLToPath(new URL("../scripts/dispatch-route.mjs", import.meta.url));
const pane = "session:tab";
const cases = [
  ["Pi in Orca", { PI_CODING_AGENT: "true", ORCA_PANE_KEY: pane }, "orca"],
  ["Pi outside Orca", { PI_CODING_AGENT: "true" }, "native"],
  ["empty pane key", { PI_CODING_AGENT: "true", ORCA_PANE_KEY: "" }, "native"],
  ["no runtime markers", {}, "native"],
  ["Orca without Pi", { ORCA_PANE_KEY: pane }, "native"],
  ["empty Pi marker", { PI_CODING_AGENT: "", ORCA_PANE_KEY: pane }, "native"],
  ["false Pi marker", { PI_CODING_AGENT: "false", ORCA_PANE_KEY: pane }, "native"],
  ["noncanonical Pi marker", { PI_CODING_AGENT: "1", ORCA_PANE_KEY: pane }, "native"],
  ["unrelated Orca variables", {
    PI_CODING_AGENT: "true", ORCA_WORKTREE_ID: "workspace", ORCA_CLI_COMMAND: "orca",
    ORCA_DEV_REPO_ROOT: "/dev/orca", TERM_PROGRAM: "Orca",
  }, "native"],
  ["Claude Code in Orca", { CLAUDECODE: "1", ORCA_PANE_KEY: pane }, "native"],
  ["Claude Code with inherited Pi markers", {
    CLAUDECODE: "1", PI_CODING_AGENT: "true", ORCA_PANE_KEY: pane,
  }, "native"],
  ["empty Claude Code marker", {
    CLAUDECODE: "", PI_CODING_AGENT: "true", ORCA_PANE_KEY: pane,
  }, "orca"],
];

for (const [name, env, expected] of cases) {
  test(name, () => {
    // Deliberately do not inherit the test runner's live Orca/Pi environment.
    const result = spawnSync(process.execPath, [probe], {
      env, encoding: "utf8", timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected + "\n", "emit exactly one route");
  });
}

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
const orca = readFileSync(new URL("../references/orca.md", import.meta.url), "utf8");

test("worker profile is complete and setup-editable", () => {
  const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
  for (const field of ["model", "provider", "thinking"]) {
    assert.equal(typeof config[field], "string");
    assert.ok(config[field].length > 0);
  }
  assert.ok(!config.model.startsWith(`${config.provider}/`));
  assert.equal(config.contextWindow, undefined);
  assert.deepEqual(Object.keys(config.claudeCode.workers), ["low", "medium", "high", "xhigh"]);
  assert.ok(config.claudeCode.maxThinking in config.claudeCode.workers);
});

test("setup mode is detected before dispatch and links its reference", () => {
  assert.ok(skill.indexOf("## Setup mode") < skill.indexOf("## Delegation rule"));
  assert.ok(skill.includes("`setup` or `--setup`"));
  assert.ok(skill.includes("references/setup.md"));
  assert.ok(!/kimi|claude-(sonnet|opus|haiku|fable)-/i.test(skill));
});

test("skill selects a route before native availability checks and links the probe", () => {
  assert.ok(skill.indexOf("## Runtime routing") < skill.indexOf("## Config and native dispatch"));
  assert.ok(skill.includes("scripts/dispatch-route.mjs"));
  assert.ok(skill.includes("references/orca.md"));
  assert.ok(skill.includes("Probe failure or unexpected output"));
  assert.ok(skill.includes("Keep exactly one route"));
  assert.ok(skill.includes("Never execute both routes"));
  assert.ok(skill.includes("recovery\ncontract before any retry"));
});

test("native dispatch, Claude Code, and explicit thread authorization remain documented", () => {
  assert.ok(skill.includes('Native `spawn_agent`') || skill.includes('native `spawn_agent`'));
  assert.ok(skill.includes('printenv CLAUDECODE'));
  assert.ok(skill.includes('claudeCode.workers'));
  assert.ok(skill.includes("Set `reasoning_effort` to `thinking`"));
  assert.ok(skill.includes('fork_turns: "none"'));
  assert.ok(skill.includes("This section applies only to the native route"));
  assert.ok(skill.includes("explicitly asks for separate or new tasks"));
});

test("Orca route delegates to the version-matched orchestration skill and preserves the profile", () => {
  assert.ok(orca.includes("discovered **`orchestration` skill**"));
  assert.ok(orca.includes("ORCA skills get orchestration"));
  assert.ok(orca.includes("references/coordinator-loop.md"));
  assert.ok(orca.includes("requires a Pi worker"));
  assert.ok(orca.includes("<config.provider>/<config.model>"));
  assert.ok(orca.includes("without launching a different agent or model"));
  assert.ok(orca.includes("launch.effective"));
  assert.ok(orca.includes("references/recovery-and-cleanup.md"));
  assert.ok(orca.includes("expected active Dispatch"));
  assert.ok(orca.includes("Never launch a native\n   worker for the same assignment"));
});
