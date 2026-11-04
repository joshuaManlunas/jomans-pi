// Run: node --test mesh-config.test.mjs
import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildAgentStartArgs,
	buildRoleBootstrap,
	enumeratePairs,
	inferKind,
	parseInvocation,
	planSplits,
	runCli,
	splitModelEffort,
	validateRoleLoaded,
} from "./mesh-config.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));

test("parse: model:effort suffix and kind inference (the natural-language request shape)", () => {
	assert.deepEqual(parseInvocation(["3", "gpt-6.1-sol:high", "--oracle-model", "claude-fable-5-1:medium"]), {
		workerCount: 3,
		modelSlug: "gpt-6.1-sol",
		effort: "high",
		kind: "codex",
		oracle: { kind: "claude", modelSlug: "claude-fable-5-1", effort: "medium" },
	});
});

test("parse: defaults to claude, never pi, when nothing names a harness", () => {
	assert.deepEqual(parseInvocation([]), { workerCount: 2, kind: "claude" });
	assert.equal(parseInvocation(["2", "some-unknown-model"]).kind, "claude");
	assert.equal(parseInvocation(["2", "gpt-6.1-sol", "--kind", "pi"]).kind, "pi");
});

test("parse: effort flags, conflicts, and per-kind validation", () => {
	assert.equal(parseInvocation(["2", "sonnet", "--effort", "xhigh"]).effort, "xhigh");
	assert.equal(parseInvocation(["2", "--kind", "codex", "--effort=low"]).effort, "low");
	assert.throws(() => parseInvocation(["2", "gpt-6.1-sol:high", "--effort", "low"]), /Effort given twice/);
	assert.throws(() => parseInvocation(["2", "opus", "--effort", "off"]), /for claude/);
	assert.throws(() => parseInvocation(["2", "composer-2.5", "--kind", "cursor", "--effort", "high"]), /cursor has no effort flag/);
	assert.throws(() => parseInvocation(["2", "--oracle-model", "mystery"]), /need --oracle/);
	assert.throws(() => parseInvocation(["2", "--oracle", "agent"]), /Invalid --oracle/);
});

test("splitModelEffort keeps non-effort suffixes", () => {
	assert.deepEqual(splitModelEffort("openrouter/openai/gpt-6.1-sol:batch"), { modelSlug: "openrouter/openai/gpt-6.1-sol:batch" });
	assert.deepEqual(splitModelEffort("gpt-6.1-sol:max"), { modelSlug: "gpt-6.1-sol", effort: "max" });
	assert.equal(inferKind("openai/gpt-6.1-sol"), "codex");
	assert.equal(inferKind("claude-fable-5-1"), "claude");
	assert.equal(inferKind("composer-2.5"), undefined);
});

test("launch-args: codex argv carries no-daemon, cwd, warning suppression, model, effort, and role prompt", () => {
	const argv = buildAgentStartArgs({
		name: "leia", kind: "codex", role: "worker", promptDirectory: DIR,
		resolvedModel: "gpt-6.1-sol", effort: "high", cwd: "/repo", executor: "t12",
	});
	assert.deepEqual(argv.slice(0, 10), [
		"codex", "--no-daemon", "-C", "/repo", "-c", "suppress_unstable_features_warning=true",
		"-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"',
	]);
	assert.match(argv[10], /hc send t12 .*ROLE_LOADED worker FROM leia PATH ".*workers\.md"/);
	assert.match(argv[10], /nothing else: no other files, memory, searches/);
	assert.throws(() => buildAgentStartArgs({ name: "leia", kind: "codex", role: "worker", promptDirectory: DIR }), /executor/);
});

test("launch-args: effort flags per harness", () => {
	const claude = buildAgentStartArgs({ name: "oracle", kind: "claude", role: "oracle", promptDirectory: DIR, resolvedModel: "claude-fable-5-1", effort: "medium" });
	assert.deepEqual(claude.slice(-4), ["--model", "claude-fable-5-1", "--effort", "medium"]);
	const pi = buildAgentStartArgs({ name: "yoda", kind: "pi", role: "worker", promptDirectory: DIR, effort: "high" });
	assert.deepEqual(pi.slice(-2), ["--thinking", "high"]);
	assert.deepEqual(buildAgentStartArgs({ name: "yoda", kind: "cursor", role: "worker", promptDirectory: DIR }), ["cursor-agent"]);
});

test("role bootstrap: delivery per kind, executor required for conversational kinds", () => {
	assert.equal(buildRoleBootstrap({ kind: "claude", role: "worker", promptDirectory: DIR }).deliver, "system-prompt");
	assert.equal(buildRoleBootstrap({ kind: "codex", role: "worker", promptDirectory: DIR, name: "leia", executor: "t12" }).deliver, "launch-prompt");
	assert.equal(buildRoleBootstrap({ kind: "cursor", role: "oracle", promptDirectory: DIR, name: "oracle", executor: "vps/t3" }).deliver, "send");
	assert.throws(() => buildRoleBootstrap({ kind: "cursor", role: "worker", promptDirectory: DIR, name: "leia" }), /executor/);
});

test("role-loaded: accepts the hc-tagged receipt and checks the sender terminal", () => {
	const path = `${DIR}/workers.md`;
	const line = `ROLE_LOADED worker FROM leia PATH ${JSON.stringify(path)}`;
	assert.equal(validateRoleLoaded(line, { role: "worker", name: "leia", path }).loaded, true);
	assert.equal(validateRoleLoaded(`<hc from="t13 leia">${line}</hc>`, { role: "worker", name: "leia", path, from: "t13" }).from, "t13");
	assert.throws(() => validateRoleLoaded(`<hc from="t14">${line}</hc>`, { role: "worker", name: "leia", path, from: "t13" }), /expected t13/);
	assert.throws(() => validateRoleLoaded(line, { role: "worker", name: "leia", path, from: "t13" }), /hc-tagged/);
});

test("split-plan: balanced grid, never slivers, capacity errors instead of shrinking", () => {
	const plan = planSplits({ count: 4, cols: 339, rows: 69 });
	assert.deepEqual(plan.map((s) => [s.from, s.direction]), [["caller", "right"], [0, "down"], ["caller", "down"], [2, "right"]]);
	for (const s of plan) {
		const [c, r] = s.size.split("x").map(Number);
		assert.ok(c >= 80 && r >= 16, s.size);
	}
	assert.throws(() => planSplits({ count: 9, cols: 160, rows: 40 }), /Layout capacity/);
});

test("pairs and CLI usage stay stable", () => {
	assert.equal(enumeratePairs(["orchestrator", "leia", "yoda", "ahsoka", "oracle"]).length, 10);
	assert.throws(() => runCli(["nope"]), /split-plan/);
});
