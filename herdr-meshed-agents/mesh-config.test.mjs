// Run: node --test mesh-config.test.mjs
import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildAgentStartArgs,
	buildRoleBootstrap,
	buildStandup,
	checkStandup,
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
	assert.throws(() => runCli(["nope"]), /split-plan.*standup\|standup-check/);
});

const RUN = "mesh-test";
const EVIDENCE = "/tmp/mesh-evidence";
const MEMBERS = [
	{ name: "orchestrator", role: "orchestrator", kind: "claude", address: "t1f", pane: "p1" },
	{ name: "leia", role: "worker", kind: "codex", address: "t1q", pane: "p2" },
	{ name: "yoda", role: "worker", kind: "claude", address: "t1r", pane: "p3" },
	{ name: "oracle", role: "oracle", kind: "claude", address: "vps/t1s", pane: "p4" },
];

test("standup plans all pairs in roster order, with members pinging the orchestrator and greedy peer balancing", () => {
	for (const [indices, directions] of [
		[[0, 1, 2, 3], ["leia orchestrator", "yoda orchestrator", "oracle orchestrator", "leia yoda", "oracle leia", "yoda oracle"]],
		[[1, 2, 0, 3], ["leia yoda", "leia orchestrator", "oracle leia", "yoda orchestrator", "yoda oracle", "oracle orchestrator"]],
	]) {
		const members = indices.map((index) => MEMBERS[index]);
		const { plan, output } = buildStandup({ run: RUN, members }, EVIDENCE);
		assert.deepEqual(output.pairs, directions.map((direction, i) => {
			const [sender, recipient] = direction.split(" ");
			return { token: `${RUN}-p${i + 1}`, sender, recipient };
		}));
		assert.deepEqual(plan, { run: RUN, members, pairs: output.pairs });
	}
});

test("standup uses each member's address and literal commands, with sandbox guidance only for Codex", () => {
	const { output } = buildStandup({ run: RUN, members: MEMBERS }, EVIDENCE);
	const sandboxFact = "Codex's sandbox blocks the hc socket. Run every hc command with sandbox escalation, from the first try. " +
		"Exit 5 or 'unavailable' means nothing was sent: rerun the same command escalated. For any other send failure, report it; do not resend. " +
		"If you still cannot send, print ROLE_BLOCKED <reason> (or MESH_BLOCKED <reason> after role load) as your last line and stop.";
	assert.deepEqual(output.bootstraps.map(({ name, address }) => [name, address]), [["leia", "t1q"], ["yoda", "t1r"], ["oracle", "vps/t1s"]]);
	for (const [name, address, pingNumber, otherPingNumber, incoming] of [
		["leia", "t1q", 1, 4, "mesh-test-p5 from oracle (vps/t1s)"],
		["yoda", "t1r", 2, 6, "mesh-test-p4 from leia (t1q)"],
	]) {
		const { text } = output.bootstraps.find((member) => member.name === name);
		const lines = text.split("\n").map((line) => line.trim());
		assert.ok(lines.includes(`You are ${name} (worker) at ${address}. Orchestrator: orchestrator at t1f.`));
		assert.ok(lines.includes(`hc send t1f 'MESH_PING ${RUN} ${RUN}-p${pingNumber} FROM ${name} TO orchestrator'`));
		assert.ok(lines.includes(`printf '%s\\n' 'MESH_ACK ${RUN} ${RUN}-p${pingNumber} FROM orchestrator TO ${name}' > ${EVIDENCE}/${RUN}-p${pingNumber}.ack`));
		assert.ok(lines.includes(`hc send t1f 'PAIRS_DONE ${RUN} FROM ${name} TOKENS ${RUN}-p${pingNumber},${RUN}-p${otherPingNumber}'`));
		assert.ok(lines.includes(incoming));
		assert.doesNotMatch(text, /hc --skill|AGENTS\.md|HC_TERMINAL_ID|BOOT_ACK/);
		if (name === "leia") assert.ok(text.endsWith(sandboxFact));
		else assert.doesNotMatch(text, /Codex's sandbox/);
		assert.deepEqual(output.ready.find((member) => member.name === name), {
			name, address, text: `MESH_READY ${RUN} TO ${name}: all 6 pairs verified. Reply with: hc send t1f 'READY_ACK ${RUN} FROM ${name}'. Then end your turn; wait for an assignment.`,
		});
	}
	assert.equal(buildRoleBootstrap({ kind: "claude", role: "worker", promptDirectory: DIR }).instruction, null);
	for (const kind of ["codex", "cursor"]) {
		const { instruction } = buildRoleBootstrap({ kind, role: "worker", promptDirectory: DIR, name: "leia", executor: "t1f" });
		if (kind === "codex") assert.ok(instruction.endsWith(sandboxFact));
		else assert.doesNotMatch(instruction, /Codex's sandbox/);
		assert.match(instruction, /ROLE_BLOCKED <reason>.*as your last line and stop\.$/);
	}
});

test("standup-check finds wrapped hc blocks, validates sender addresses, ignores stale runs, and suppresses sent ACKs", () => {
	const { plan } = buildStandup({ run: RUN, members: MEMBERS }, EVIDENCE);
	const leiaAck = "MESH_ACK mesh-test mesh-test-p1 FROM orchestrator TO leia";
	const yodaAck = "MESH_ACK mesh-test mesh-test-p2 FROM orchestrator TO yoda";
	const wrongAddress = "MESH_PING mesh-test mesh-test-p3 FROM oracle TO orchestrator";
	const wrongToken = "MESH_PING mesh-test mesh-test-p2 FROM oracle TO orchestrator";
	const result = checkStandup({
		plan, evidenceDir: EVIDENCE, orchSent: `${yodaAck}\n`,
		ackFiles: { "mesh-test-p1": `${leiaAck}\n`, "mesh-test-p2": `${yodaAck} \n` },
		inbox: [
			'<pasted_content filename="paste.txt">',
			'<hc from="t1q leia">MESH_PING mesh-test mesh-test-p1 FROM leia TO orchestrator</hc>',
			'<hc from="t1r">MESH_PING mesh-test mesh-test-p2 FROM yoda TO orchestrator</hc>',
			'</pasted_content>',
			`<hc from="t1r">${wrongAddress}</hc>`,
			`<hc from="vps/t1s">${wrongToken}</hc>`,
			'<hc from="t99">MESH_PING mesh-old mesh-old-p3 FROM oracle TO orchestrator</hc>',
		].join("\n"),
	});
	assert.deepEqual(result.acksToSend, [{ address: "t1q", text: leiaAck }]);
	assert.deepEqual(result.pairs.map(({ status }) => status), ["pass", "pending", "pending", "pending", "pending", "pending"]);
	assert.equal(result.pairs[0].evidence, `${EVIDENCE}/mesh-test-p1.ack`);
	assert.deepEqual(result.invalid.map(({ text }) => text), [wrongAddress, wrongToken]);
	assert.match(result.invalid[0].reason, /expected vps\/t1s, got t1r/);
	assert.match(result.invalid[1].reason, /token or endpoints/);
});

test("standup-check completes the pairs and ready phases only with their required evidence", () => {
	const { plan } = buildStandup({ run: RUN, members: MEMBERS }, EVIDENCE);
	const ackFiles = Object.fromEntries(plan.pairs.map(({ token, sender, recipient }) => [token, `MESH_ACK ${RUN} ${token} FROM ${recipient} TO ${sender}\n`]));
	const receipts = [
		'<hc from="t1q">PAIRS_DONE mesh-test FROM leia TOKENS mesh-test-p1,mesh-test-p4</hc>',
		'<hc from="t1r">PAIRS_DONE mesh-test FROM yoda TOKENS mesh-test-p2,mesh-test-p6</hc>',
		'<hc from="vps/t1s oracle">PAIRS_DONE mesh-test FROM oracle TOKENS mesh-test-p3,mesh-test-p5</hc>',
	];
	const ready = MEMBERS.slice(1).map(({ name, address }) => `<hc from="${address}">READY_ACK ${RUN} FROM ${name}</hc>`);
	const ping = '<hc from="t1q">MESH_PING mesh-test mesh-test-p1 FROM leia TO orchestrator</hc>';
	for (const [phase, inbox, orchSent, done, outstanding, invalid] of [
		["pairs", receipts, "", true, [], 0],
		["pairs", [ping, ...receipts], "", false, ["Send to t1q: MESH_ACK mesh-test mesh-test-p1 FROM orchestrator TO leia"], 0],
		["pairs", [receipts[0].replace("mesh-test-p4", "mesh-test-p1"), ...receipts.slice(1)], "", false, ["Await PAIRS_DONE from leia."], 1],
		["ready", [...receipts, ...ready.slice(0, 2)], "", false, ["Await READY_ACK from oracle."], 0],
		["ready", [ping, ...receipts, ...ready], ackFiles["mesh-test-p1"], true, [], 0],
	]) {
		const result = checkStandup({ plan, evidenceDir: EVIDENCE, phase, inbox: inbox.join("\n"), orchSent, ackFiles });
		assert.equal(result.done, done);
		assert.deepEqual(result.outstanding, outstanding);
		assert.equal(result.invalid.length, invalid);
		assert.equal(result.pairsDone.leia, invalid === 0);
		assert.equal(result.readyAcks.oracle, phase === "ready" && done);
	}
});
