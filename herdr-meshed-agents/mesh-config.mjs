#!/usr/bin/env node
// Deterministic helpers for the herdr-meshed-agents skill. Dependency-free, no side effects
// except reading inputs and writing standup plans in the CLI. herdr-core transport only (no cmux).
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Role prompts (orchestrator.md, workers.md, oracle.md) live beside this helper and SKILL.md.
const DEFAULT_PROMPT_DIR = dirname(fileURLToPath(import.meta.url));

export const USAGE =
	"[worker_count] [model_slug[:effort]] [--kind claude|codex|cursor|pi] [--effort <level>] [--oracle claude|codex|cursor|pi] [--oracle-model <slug[:effort]>] [--oracle-effort <level>]";
export const KINDS = ["claude", "codex", "cursor", "pi"];
const KIND_HINT = "expected claude, codex, cursor, or pi";
// Default Worker harness when --kind is omitted and the model slug names no family (see inferKind).
export const DEFAULT_KIND = "claude";
// Reasoning-effort levels each harness accepts at launch. cursor has no effort flag: it encodes effort in the model slug.
export const EFFORTS = {
	claude: ["low", "medium", "high", "xhigh", "max"],
	codex: ["minimal", "low", "medium", "high", "xhigh", "max"],
	pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	cursor: [],
};
const ALL_EFFORTS = new Set(Object.values(EFFORTS).flat());
export const ADDRESS_RE = /^[A-Za-z0-9_.:-]+(\/[A-Za-z0-9_.:-]+)?$/; // hc address: t12 or machine/t12
export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/; // hc terminal-name rule
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // run and consult ids
const PANE_RE = /^[A-Za-z0-9_:.-]+$/;
export const MAX_BRIEF_BYTES = 16 * 1024;
export const MAX_ANALYSIS_BYTES = 64 * 1024;

const q = (v) => JSON.stringify(v);
const emptyModel = (v) => typeof v !== "string" || !v.trim();

// ---------- invocation parsing ----------

/**
 * Model family to harness, used only when the kind is omitted: GPT/Codex/o-series models run on Codex,
 * Anthropic models on Claude Code. Returns undefined when the slug names no known family.
 */
export function inferKind(modelSlug) {
	if (typeof modelSlug !== "string") return undefined;
	const bare = modelSlug.replace(/^.*\//, "").toLowerCase();
	if (/^(gpt-|codex|o\d)/.test(bare)) return "codex";
	if (/^(claude|opus|sonnet|haiku|fable)/.test(bare)) return "claude";
	return undefined;
}

/** Split a trailing ":<effort>" off a model slug ("gpt-6.1-sol:high"). Other suffixes (":batch") stay in the slug. */
export function splitModelEffort(slug) {
	const i = slug.lastIndexOf(":");
	if (i > 0 && ALL_EFFORTS.has(slug.slice(i + 1))) return { modelSlug: slug.slice(0, i), effort: slug.slice(i + 1) };
	return { modelSlug: slug };
}

function checkEffort(kind, effort, label) {
	if (effort === undefined) return;
	if (kind === "cursor") throw new Error(`Invalid ${label} ${q(effort)}: cursor has no effort flag; choose a cursor model slug that encodes the effort.`);
	if (!EFFORTS[kind].includes(effort)) throw new Error(`Invalid ${label} ${q(effort)} for ${kind}: expected ${EFFORTS[kind].join(", ")}.`);
}

function modelAndEffort(slug, flagEffort, label, effortLabel) {
	if (emptyModel(slug) || slug.startsWith("-")) throw new Error(`Invalid ${label} ${q(slug)}: expected a non-empty model slug.`);
	const split = splitModelEffort(slug);
	if (emptyModel(split.modelSlug)) throw new Error(`Invalid ${label} ${q(slug)}: expected a non-empty model slug.`);
	if (split.effort !== undefined && flagEffort !== undefined)
		throw new Error(`Effort given twice: ${q(slug)} and ${effortLabel} ${q(flagEffort)}; use one.`);
	return { modelSlug: split.modelSlug, effort: split.effort ?? flagEffort };
}

/** @param {string[]} args @returns {{workerCount:number, modelSlug?:string, effort?:string, kind:string, oracle?:{kind:string, modelSlug?:string, effort?:string}}} */
export function parseInvocation(args) {
	if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error("Arguments must be an array of strings.");
	const flags = {};
	const positional = [];
	const known = new Set(["--kind", "--effort", "--oracle", "--oracle-model", "--oracle-effort"]);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		if (!known.has(flag)) throw new Error(`Unknown option ${q(arg)}: expected ${USAGE}.`);
		if (flag in flags) throw new Error(`Duplicate ${flag}: expected at most one.`);
		let value;
		if (eq !== -1) value = arg.slice(eq + 1);
		else {
			const next = args[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
			value = next;
			i++;
		}
		flags[flag] = value;
	}
	if (positional.length > 2) throw new Error(`Unexpected arguments: expected ${USAGE}.`);

	let workerCount = 2;
	if (positional.length >= 1) {
		const raw = positional[0];
		if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)
			throw new Error(`Invalid worker_count ${q(raw)}: expected a positive integer.`);
		workerCount = Number(raw);
	}
	const config = { workerCount };
	if (positional.length === 2) Object.assign(config, modelAndEffort(positional[1], flags["--effort"], "model_slug", "--effort"));
	else if ("--effort" in flags) config.effort = flags["--effort"];
	if (config.effort === undefined) delete config.effort;
	if ("--kind" in flags) {
		if (!KINDS.includes(flags["--kind"])) throw new Error(`Invalid --kind ${q(flags["--kind"])}: ${KIND_HINT}.`);
		config.kind = flags["--kind"];
	} else config.kind = inferKind(config.modelSlug) ?? DEFAULT_KIND;
	checkEffort(config.kind, config.effort, "--effort");

	const wantsOracle = "--oracle" in flags || "--oracle-model" in flags || "--oracle-effort" in flags;
	if (wantsOracle) {
		const oracle = {};
		if ("--oracle-model" in flags)
			Object.assign(oracle, modelAndEffort(flags["--oracle-model"], flags["--oracle-effort"], "--oracle-model", "--oracle-effort"));
		else if ("--oracle-effort" in flags) oracle.effort = flags["--oracle-effort"];
		if (oracle.effort === undefined) delete oracle.effort;
		if ("--oracle" in flags) {
			if (!KINDS.includes(flags["--oracle"])) throw new Error(`Invalid --oracle ${q(flags["--oracle"])}: ${KIND_HINT}.`);
			oracle.kind = flags["--oracle"];
		} else {
			oracle.kind = inferKind(oracle.modelSlug);
			if (!oracle.kind) throw new Error("--oracle-model and --oracle-effort need --oracle claude|codex|cursor|pi when the model names no known family.");
		}
		checkEffort(oracle.kind, oracle.effort, "--oracle-effort");
		config.oracle = { kind: oracle.kind, ...oracle };
	}
	return config;
}

// ---------- launch argv ----------

const ROLE_FILE = { worker: "workers.md", oracle: "oracle.md" };
const isRole = (r) => typeof r === "string" && Object.hasOwn(ROLE_FILE, r); // own keys only: rejects "toString" etc.
// pi and claude load the role file as a system prompt at launch. codex and cursor have no such flag:
// codex gets the role bootstrap as its initial prompt (a send to a booting agent can be dropped), cursor gets it by hc send.
const PROMPT_FLAG = { pi: "--system-prompt", claude: "--append-system-prompt-file" };
const EXECUTABLE = { pi: "pi", claude: "claude", codex: "codex", cursor: "cursor-agent" };
export const ROLE_DELIVERY = { pi: "system-prompt", claude: "system-prompt", codex: "launch-prompt", cursor: "send" };
const CODEX_SANDBOX_FACT =
	"Codex's sandbox blocks the hc socket. Run every hc command with sandbox escalation, from the first try. " +
	"Exit 5 or 'unavailable' means nothing was sent: rerun the same command escalated. For any other send failure, report it; do not resend. " +
	"If you still cannot send, print ROLE_BLOCKED <reason> (or MESH_BLOCKED <reason> after role load) as your last line and stop.";

/** Role prompt file for a role under a prompt directory. */
export const rolePromptPath = (role, promptDirectory) => {
	if (!isRole(role)) throw new Error(`Invalid role ${q(role)}: expected worker or oracle.`);
	return join(promptDirectory, ROLE_FILE[role]);
};

const checkName = (name) => {
	if (!NAME_RE.test(name ?? "")) throw new Error(`Invalid agent name ${q(name)}: expected [a-z][a-z0-9_-]{0,31}.`);
};
const checkExecutor = (executor, kind) => {
	if (typeof executor !== "string" || !ADDRESS_RE.test(executor))
		throw new Error(`Invalid or missing executor ${q(executor)}: ${kind} needs the executor's hc address (for example t12) so it can report ROLE_LOADED.`);
};

/**
 * Agent argv that starts one interactive agent in a pane created by `herdr-app do pane.split`.
 * pi/claude take the role file path as a prompt flag; codex takes the role bootstrap as its initial prompt.
 * Effort maps to each harness's own flag; no permission flags are ever added.
 */
export function buildAgentStartArgs({ name, kind, role, promptDirectory, resolvedModel, effort, cwd, executor }) {
	checkName(name);
	if (!KINDS.includes(kind)) throw new Error(`Invalid kind ${q(kind)}: ${KIND_HINT}.`);
	if (!isRole(role)) throw new Error(`Invalid role ${q(role)}: expected worker or oracle.`);
	if (typeof promptDirectory !== "string" || !promptDirectory) throw new Error("promptDirectory is required.");
	if (resolvedModel !== undefined && (emptyModel(resolvedModel) || /\s/.test(resolvedModel)))
		throw new Error(`Invalid resolvedModel ${q(resolvedModel)}.`);
	checkEffort(kind, effort, "effort");
	if (cwd !== undefined && (typeof cwd !== "string" || !cwd.startsWith("/") || /[\n\r]/.test(cwd))) throw new Error(`Invalid cwd ${q(cwd)}: expected an absolute path.`);
	if (kind === "codex") {
		const { instruction } = buildRoleBootstrap({ kind, role, promptDirectory, name, executor });
		return [
			"codex",
			"--no-daemon", // hc --skill: without it, Codex commands run outside hc
			...(cwd === undefined ? [] : ["-C", cwd]),
			"-c", "suppress_unstable_features_warning=true",
			...(resolvedModel === undefined ? [] : ["-m", resolvedModel]),
			...(effort === undefined ? [] : ["-c", `model_reasoning_effort=${q(effort)}`]),
			instruction,
		];
	}
	return [
		EXECUTABLE[kind],
		...(kind === "cursor" ? [] : [PROMPT_FLAG[kind], rolePromptPath(role, promptDirectory), "--name", name]),
		...(resolvedModel === undefined ? [] : ["--model", resolvedModel]),
		...(effort === undefined ? [] : kind === "pi" ? ["--thinking", effort] : ["--effort", effort]),
	];
}

/**
 * Role injection per harness. pi/claude load the role file natively at launch (deliver "system-prompt", instruction null).
 * codex (deliver "launch-prompt", already inside launch-args) and cursor (deliver "send") get one conversational message.
 * The member reports ROLE_LOADED to the executor over hc, so it arrives as a tagged message instead of screen text.
 */
export function buildRoleBootstrap({ kind, role, promptDirectory, name, executor }) {
	if (!KINDS.includes(kind)) throw new Error(`Invalid kind ${q(kind)}: ${KIND_HINT}.`);
	if (!isRole(role)) throw new Error(`Invalid role ${q(role)}: expected worker or oracle.`);
	if (typeof promptDirectory !== "string" || !promptDirectory) throw new Error("promptDirectory is required.");
	const deliver = ROLE_DELIVERY[kind];
	if (name !== undefined || deliver !== "system-prompt") checkName(name);
	const path = resolve(rolePromptPath(role, promptDirectory));
	if (deliver === "system-prompt") return { path, deliver, instruction: null };
	checkExecutor(executor, kind);
	const line = roleLoadedLine({ role, name, path });
	return {
		path,
		deliver,
		instruction:
			`Role bootstrap (current-session conversational role guidance, not a system prompt): read the whole file ${q(path)} completely ` +
			`and nothing else: no other files, memory, searches, or repository exploration. Adopt it as your role guidance for this session, ` +
			`and do only setup and communication verification until the orchestrator confirms READY and a later explicit user-authorized assignment arrives. ` +
			`Then report to the orchestrator by running hc send ${executor} with exactly this one line as a single argument: ${line} ` +
			`(the exact path you read), or send the blocker the same way. ` +
			(kind === "codex" ? CODEX_SANDBOX_FACT : "If you cannot send the blocker, print ROLE_BLOCKED <reason> as your last line and stop."),
	};
}

// path is a JSON string literal: safe for spaces, quotes, newlines and shell metacharacters.
const roleLoadedLine = ({ role, name, path }) => `ROLE_LOADED ${role} FROM ${name} PATH ${q(path)}`;

const HC_TAG_RE = /^<hc from="([^"]+)"[^>]*>([\s\S]*)<\/hc>$/;

/**
 * Load receipt for a codex/cursor role bootstrap: must be that exact line (extra whitespace trimmed).
 * Accepts the line as hc delivers it (`<hc from="t13 leia">LINE</hc>`); with `from`, the tag is required and its
 * first token must be that terminal address, so the receipt is tied to the member's terminal.
 */
export function validateRoleLoaded(text, { role, name, path, from }) {
	if (!isRole(role)) throw new Error(`Invalid role ${q(role)}: expected worker or oracle.`);
	if (!NAME_RE.test(name ?? "")) throw new Error(`Invalid agent name ${q(name)}: expected [a-z][a-z0-9_-]{0,31}.`);
	if (typeof path !== "string" || !path) throw new Error(`Invalid path ${q(path)}.`);
	const want = roleLoadedLine({ role, name, path });
	let got = typeof text === "string" ? text.trim() : "";
	const tag = HC_TAG_RE.exec(got);
	if (tag) got = tag[2].trim();
	if (from !== undefined) {
		if (!tag) throw new Error(`Role not confirmed: expected an hc-tagged message from ${from}.`);
		if (tag[1].split(/\s+/)[0] !== from) throw new Error(`Role not confirmed: message came from ${q(tag[1])}, expected ${from}.`);
	}
	if (got !== want) throw new Error(`Role not confirmed: expected ${q(want)}, got ${q(got.split("\n")[0].slice(0, 200))}.`);
	return { role, name, path, loaded: true, ...(from === undefined ? {} : { from }) };
}

// ---------- role names ----------

export const ROLES = ["orchestrator", "oracle"];

/**
 * First free name from role, role2, role3, ... (never role1), filling gaps.
 * `terminals` is every live terminal from `hc ls --json` (.terminals), across all spaces; an entry's
 * `labels["mesh.name"]` (from `hc get`) takes precedence over its `.name` when both are present.
 * orchestrator: a name already owned by the caller `terminal` address is available. oracle: every owner occupies.
 */
export function selectRoleName({ role, terminals, terminal }) {
	if (!ROLES.includes(role)) throw new Error(`Invalid role ${q(role)}: expected orchestrator or oracle.`);
	if (!Array.isArray(terminals)) throw new Error("terminals must be an array.");
	if (role === "orchestrator" && (typeof terminal !== "string" || !PANE_RE.test(terminal)))
		throw new Error(`Invalid terminal ${q(terminal)}: a caller terminal address is required for role orchestrator.`);
	if (role === "oracle" && terminal !== undefined && (typeof terminal !== "string" || !PANE_RE.test(terminal))) throw new Error(`Invalid terminal ${q(terminal)}.`);
	const owners = new Map();
	terminals.forEach((entry, i) => {
		if (entry === null || typeof entry !== "object") throw new Error(`Invalid terminal entry at index ${i}.`);
		const { address: owner } = entry;
		const name = entry.labels?.["mesh.name"] ?? entry.name;
		if (name === undefined || name === null) return; // unnamed terminals occupy no name
		if (!NAME_RE.test(name ?? "") || typeof owner !== "string" || !PANE_RE.test(owner))
			throw new Error(`Invalid terminal entry at index ${i}: expected string name and address.`);
		if (owners.has(name) && owners.get(name) !== owner) throw new Error(`Duplicate terminal name ${q(name)} owned by multiple terminals.`);
		owners.set(name, owner);
	});
	for (let n = 1; n <= terminals.length + 1; n++) {
		const candidate = n === 1 ? role : `${role}${n}`;
		if (!NAME_RE.test(candidate)) break;
		if (!owners.has(candidate) || (role === "orchestrator" && owners.get(candidate) === terminal)) return candidate;
	}
	throw new Error(`No available ${role} name.`);
}

// ---------- pane geometry ----------

// Smallest pane an agent TUI stays usable in, in terminal cells.
export const MIN_COLS = 80;
export const MIN_ROWS = 16;
// Terminal cells are about 2-2.5x taller than wide: split "right" only when the pane is visually wide.
const WIDE_RATIO = 2.5;

/**
 * Deterministic split order for `count` new panes beside the caller pane (cols x rows from `hc get`).
 * Each step splits the largest pane (ties: the newest member pane, so the caller keeps its size longest)
 * along its visually longer side, never below MIN_COLS x MIN_ROWS. `from` is "caller" or a member index.
 * Throws when the layout cannot fit the squad: report that instead of shrinking the count.
 */
export function planSplits({ count, cols, rows }) {
	for (const [label, v] of [["count", count], ["cols", cols], ["rows", rows]])
		if (!Number.isSafeInteger(v) || v < 1) throw new Error(`Invalid ${label} ${q(v)}: expected a positive integer.`);
	const panes = [{ id: "caller", cols, rows }];
	const plan = [];
	for (let member = 0; member < count; member++) {
		const options = [];
		panes.forEach((p, order) => {
			const right = { direction: "right", a: { cols: Math.floor(p.cols / 2), rows: p.rows }, b: { cols: p.cols - Math.floor(p.cols / 2) - 1, rows: p.rows } };
			const down = { direction: "down", a: { cols: p.cols, rows: Math.floor(p.rows / 2) }, b: { cols: p.cols, rows: p.rows - Math.floor(p.rows / 2) - 1 } };
			const fits = (s) => s.a.cols >= MIN_COLS && s.b.cols >= MIN_COLS && s.a.rows >= MIN_ROWS && s.b.rows >= MIN_ROWS;
			const preferred = p.cols >= WIDE_RATIO * p.rows ? [right, down] : [down, right];
			const split = preferred.find(fits);
			if (split) options.push({ p, order, split });
		});
		if (!options.length) throw new Error(`Layout capacity: no pane can split for member ${member + 1} of ${count} without going below ${MIN_COLS}x${MIN_ROWS} cells.`);
		options.sort((x, y) => y.p.cols * y.p.rows - x.p.cols * x.p.rows || y.order - x.order);
		const { p, split } = options[0];
		Object.assign(p, split.a);
		panes.push({ id: member, ...split.b });
		plan.push({ member, from: p.id, direction: split.direction, size: `${split.b.cols}x${split.b.rows}` });
	}
	return plan;
}

// ---------- roster ----------

/** Ordered member names: orchestrator, workers, then oracle when configured. */
export function buildRoster(config, { orchestrator = "orchestrator", workers, oracle = "oracle" }) {
	if (!Array.isArray(workers) || workers.length !== config.workerCount)
		throw new Error(`Expected ${config.workerCount} worker names, got ${Array.isArray(workers) ? workers.length : 0}.`);
	const names = [orchestrator, ...workers, ...(config.oracle ? [oracle] : [])];
	enumeratePairs(names); // validates name shape and uniqueness
	return names;
}

/** All n(n-1)/2 unordered pairs, i<j, in roster order. */
export function enumeratePairs(names) {
	if (!Array.isArray(names) || names.length < 2) throw new Error("Roster needs at least two members.");
	for (const n of names) if (!NAME_RE.test(n ?? "")) throw new Error(`Invalid roster name ${q(n)}.`);
	if (new Set(names).size !== names.length) throw new Error("Duplicate roster names.");
	const pairs = [];
	for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) pairs.push([names[i], names[j]]);
	return pairs;
}

// ---------- standup ----------

const shellWord = (word) => `'${word.replaceAll("'", "'\\''")}'`;
const shellPath = (path) => /^[A-Za-z0-9_./:-]+$/.test(path) ? path : shellWord(path);
const sendLine = (address, text) => `hc send ${address} ${shellWord(text)}`;
const pingLine = (run, { token, sender, recipient }) => `MESH_PING ${run} ${token} FROM ${sender} TO ${recipient}`;
const ackLine = (run, { token, sender, recipient }) => `MESH_ACK ${run} ${token} FROM ${recipient} TO ${sender}`;
const doneLine = (run, name, tokens) => `PAIRS_DONE ${run} FROM ${name} TOKENS ${tokens.join(",")}`;
const readyAckLine = (run, name) => `READY_ACK ${run} FROM ${name}`;
const ackPath = (evidenceDir, token) => join(evidenceDir, `${token}.ack`);

export function buildStandup(input, evidenceDir) {
	const { run, members } = input ?? {};
	if (typeof run !== "string" || !ID_RE.test(run)) throw new Error(`Invalid run ${q(run)}.`);
	if (!Array.isArray(members)) throw new Error("Roster must contain a members array.");
	const addresses = new Set();
	for (const member of members) {
		const { name, address, role, kind } = member ?? {};
		if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`Invalid roster name ${q(name)}.`);
		if (typeof address !== "string" || !ADDRESS_RE.test(address)) throw new Error(`Invalid address ${q(address)} for ${name}.`);
		if (addresses.has(address)) throw new Error(`Duplicate roster address ${q(address)}.`);
		if (!["orchestrator", "worker", "oracle"].includes(role)) throw new Error(`Invalid role ${q(role)} for ${name}.`);
		if (!KINDS.includes(kind)) throw new Error(`Invalid kind ${q(kind)} for ${name}: ${KIND_HINT}.`);
		addresses.add(address);
	}
	const orchestrators = members.filter(({ role }) => role === "orchestrator");
	if (orchestrators.length !== 1) throw new Error("Roster must contain exactly one orchestrator.");
	const [orchestrator] = orchestrators;
	const peers = members.filter(({ role }) => role !== "orchestrator");
	const names = members.map(({ name }) => name);
	const roster = new Map(members.map((member) => [member.name, member]));
	const sends = new Map(names.map((name) => [name, 0]));
	const pairs = enumeratePairs(names).map(([first, second], i) => {
		const firstSends = second === orchestrator.name ||
			(first !== orchestrator.name && sends.get(first) <= sends.get(second));
		const [sender, recipient] = firstSends ? [first, second] : [second, first];
		sends.set(sender, sends.get(sender) + 1);
		return { token: `${run}-p${i + 1}`, sender, recipient };
	});
	const rosterPath = join(evidenceDir, "roster.md");
	const planPath = join(evidenceDir, "plan.json");
	const rosterLines = members.map(({ address, name, role }) => `${address} ${name} (${role})`);
	const rosterCard = [
		`# Standup for ${run}`, "", "## Roster", "", "```text", ...rosterLines, "```", "",
		`Evidence directory: ${evidenceDir}`, "", "## Envelope formats", "", "```text",
		"MESH_PING <run> <token> FROM <sender> TO <recipient>",
		"MESH_ACK <run> <token> FROM <recipient> TO <sender>", "PAIRS_DONE <run> FROM <name> TOKENS <t1,t2>",
		"MESH_READY <run> TO <name>: all <k> pairs verified.", "READY_ACK <run> FROM <name>", "```", "",
	].join("\n");
	const bootstraps = peers.map(({ name, address, role, kind }) => {
		const outgoing = pairs.filter(({ sender }) => sender === name);
		const incoming = pairs.filter(({ recipient }) => recipient === name);
		const record = outgoing.map((pair) =>
			`   printf '%s\\n' ${shellWord(ackLine(run, pair))} > ${shellPath(ackPath(evidenceDir, pair.token))}`);
		const text = [
			`MESH_BOOTSTRAP ${run}`,
			`You are ${name} (${role}) at ${address}. Orchestrator: ${orchestrator.name} at ${orchestrator.address}.`,
			"Roster:", ...rosterLines, `Card copy: ${rosterPath}`,
			"Standup is exactly these steps; there is nothing else to set up or look up:",
			"1. Send each of your PINGs now, as written below.",
			"2. Answer every MESH_PING you receive with its MESH_ACK, sent to the tag's from address (rule in your role file).",
			"3. When an ACK for one of your PINGs arrives, record it with the literal command given per token:", ...record,
			"4. Once every PING you sent has a recorded ACK:",
			`   ${sendLine(orchestrator.address, doneLine(run, name, outgoing.map(({ token }) => token)))}`,
			"5. End your turn and wait for READY. Reply as READY says. No repository work until an assignment arrives after READY.",
			"Your PINGs:", ...outgoing.map((pair) => sendLine(roster.get(pair.recipient).address, pingLine(run, pair))),
			"PINGs to expect:", ...(incoming.length ? [] : ["none"]), ...incoming.map(({ token, sender }) => `${token} from ${sender} (${roster.get(sender).address})`),
		];
		if (kind === "codex") text.push(CODEX_SANDBOX_FACT);
		return { name, address, text: text.join("\n") };
	});
	const ready = peers.map(({ name, address }) => ({
		name, address,
		text: `MESH_READY ${run} TO ${name}: all ${pairs.length} pairs verified. Reply with: ${sendLine(orchestrator.address, readyAckLine(run, name))}. Then end your turn; wait for an assignment.`,
	}));
	return { plan: { ...input, pairs }, rosterCard, output: { run, pairs, bootstraps, ready, rosterPath, planPath } };
}

const STANDUP_RUN_RE = /^(?:MESH_(?:PING|ACK|BOOTSTRAP|READY)|PAIRS_DONE|READY_ACK) (\S+)/;
const PING_RE = /^MESH_PING \S+ (\S+) FROM (\S+) TO (\S+)$/;
const PAIRS_DONE_RE = /^PAIRS_DONE \S+ FROM (\S+) TOKENS (\S+)$/;
const READY_ACK_RE = /^READY_ACK \S+ FROM (\S+)$/;

/** Check a snapshot of evidence. The CLI supplies raw file contents keyed by ACK token. */
export function checkStandup({ plan, evidenceDir, inbox = "", orchSent = "", ackFiles = {}, phase = "pairs" }) {
	if (phase !== "pairs" && phase !== "ready") throw new Error(`Invalid --phase ${q(phase)}: expected pairs or ready.`);
	const { run, members, pairs } = plan;
	const orchestrator = members.find(({ role }) => role === "orchestrator").name;
	const peers = members.filter(({ role }) => role !== "orchestrator");
	const addresses = new Map(members.map(({ name, address }) => [name, address]));
	const pairByToken = new Map(pairs.map((pair) => [pair.token, pair]));
	const tokensBySender = new Map(peers.map(({ name }) => [name, pairs.filter(({ sender }) => sender === name).map(({ token }) => token)]));
	const pairsDone = Object.fromEntries(peers.map(({ name }) => [name, false]));
	const readyAcks = { ...pairsDone };
	const sent = new Set(orchSent.split(/\r?\n/));
	const acksToSend = [];
	const invalid = [];
	for (const [, tagFrom, body] of inbox.matchAll(/<hc from="([^"]+)"[^>]*>([\s\S]*?)<\/hc>/g)) {
		const text = body.trim();
		const messageRun = STANDUP_RUN_RE.exec(text)?.[1];
		if (messageRun && messageRun !== run) continue;
		const ping = PING_RE.exec(text);
		const done = PAIRS_DONE_RE.exec(text);
		const ready = READY_ACK_RE.exec(text);
		const from = ping?.[2] ?? done?.[1] ?? ready?.[1];
		const address = addresses.get(from);
		const tagAddress = tagFrom.split(/\s+/)[0];
		if (!from) invalid.push({ text, reason: "Malformed or unexpected standup envelope." });
		else if (!address) invalid.push({ text, reason: `Unknown sender ${from}.` });
		else if (address !== tagAddress) invalid.push({ text, reason: `Wrong from-address for ${from}: expected ${address}, got ${tagAddress}.` });
		else if (ping) {
			const pair = pairByToken.get(ping[1]);
			if (ping[3] !== orchestrator || !pair || text !== pingLine(run, pair)) {
				invalid.push({ text, reason: "PING token or endpoints do not match a planned PING to the orchestrator." });
				continue;
			}
			const ack = ackLine(run, pair);
			if (!sent.has(ack)) {
				acksToSend.push({ address, text: ack });
				sent.add(ack);
			}
		} else if (done) {
			const expected = tokensBySender.get(from);
			const tokens = done[2].split(",");
			if (!expected || tokens.length !== expected.length || !expected.every((token) => tokens.includes(token))) {
				invalid.push({ text, reason: "PAIRS_DONE tokens do not match the member's planned PINGs." });
			} else pairsDone[from] = true;
		} else if (Object.hasOwn(readyAcks, from)) readyAcks[from] = true;
		else invalid.push({ text, reason: "READY_ACK must come from a member other than the orchestrator." });
	}
	const pairResults = pairs.map((pair) => {
		const ack = ackFiles[pair.token]?.replace(/\r?\n$/, "");
		return { ...pair, status: ack === ackLine(run, pair) ? "pass" : "pending", evidence: ackPath(evidenceDir, pair.token) };
	});
	const outstanding = [
		...acksToSend.map(({ address, text }) => `Send to ${address}: ${text}`),
		...pairResults.filter(({ status }) => status === "pending").map(({ token, sender }) => `Record ACK for ${token} sent by ${sender}.`),
		...peers.filter(({ name }) => !pairsDone[name]).map(({ name }) => `Await PAIRS_DONE from ${name}.`),
	];
	if (phase === "ready") outstanding.push(...peers.filter(({ name }) => !readyAcks[name]).map(({ name }) => `Await READY_ACK from ${name}.`));
	return { phase, acksToSend, pairs: pairResults, pairsDone, readyAcks, invalid, outstanding, done: outstanding.length === 0 };
}

// ---------- Oracle consultation envelopes ----------

const HEADER_RE = /^ORACLE_(QUERY|RESULT|ACK) (\S+) (\S+) FROM (\S+) TO (\S+)$/;
const NESTED_RE = /^ORACLE_(QUERY|RESULT|ACK) /m;

function checkIds({ run, id, from, to, roster }) {
	if (!ID_RE.test(run ?? "")) throw new Error(`Invalid run ${q(run)}.`);
	if (!ID_RE.test(id ?? "")) throw new Error(`Invalid id ${q(id)}.`);
	for (const [label, n] of [["from", from], ["to", to]]) {
		if (!NAME_RE.test(n ?? "")) throw new Error(`Invalid ${label} ${q(n)}.`);
		if (!Array.isArray(roster) || !roster.includes(n)) throw new Error(`${label} ${q(n)} is not in the roster.`);
	}
	if (from === to) throw new Error("from and to must differ.");
}

function checkBody(body, label, max) {
	if (typeof body !== "string" || !body.trim()) throw new Error(`${label} is empty.`);
	if (Buffer.byteLength(body) > max) throw new Error(`${label} exceeds ${max} bytes.`);
	if (NESTED_RE.test(body)) throw new Error(`${label} contains a nested ORACLE_ envelope header.`);
}

export function formatQuery(p) {
	checkIds(p);
	checkBody(p.brief, "Brief", MAX_BRIEF_BYTES);
	return `ORACLE_QUERY ${p.run} ${p.id} FROM ${p.from} TO ${p.to}\n${p.brief.trim()}`;
}

export function formatResult(p) {
	checkIds(p);
	checkBody(p.analysis, "Analysis", MAX_ANALYSIS_BYTES);
	return `ORACLE_RESULT ${p.run} ${p.id} FROM ${p.from} TO ${p.to}\n${p.analysis.trim()}`;
}

export function formatAck(p) {
	checkIds(p);
	return `ORACLE_ACK ${p.run} ${p.id} FROM ${p.from} TO ${p.to}`;
}

/** @returns {{type:"QUERY"|"RESULT"|"ACK", run, id, from, to, body:string}|null} */
export function parseOracleEnvelope(text) {
	if (typeof text !== "string") return null;
	const normalized = text.replace(/\r\n/g, "\n").trim();
	const nl = normalized.indexOf("\n");
	const header = nl === -1 ? normalized : normalized.slice(0, nl);
	const m = HEADER_RE.exec(header);
	if (!m) return null;
	return { type: m[1], run: m[2], id: m[3], from: m[4], to: m[5], body: nl === -1 ? "" : normalized.slice(nl + 1).trim() };
}

/** Strict check of an actual received ORACLE_RESULT; ACKs and mismatches are errors. */
export function validateResult(text, expected) {
	checkIds(expected);
	const env = parseOracleEnvelope(text);
	if (!env) throw new Error("Not an ORACLE envelope.");
	if (env.type === "ACK") throw new Error("ORACLE_ACK is not an ORACLE_RESULT: no consultation result received.");
	if (env.type !== "RESULT") throw new Error(`Expected ORACLE_RESULT, got ORACLE_${env.type}.`);
	if (env.run !== expected.run) throw new Error(`Stale or wrong run: expected ${expected.run}, got ${env.run}.`);
	if (env.id !== expected.id) throw new Error(`Stale or wrong id: expected ${expected.id}, got ${env.id}.`);
	if (env.from !== expected.from) throw new Error(`Wrong sender: expected ${expected.from}, got ${env.from}.`);
	if (env.to !== expected.to) throw new Error(`Wrong recipient: expected ${expected.to}, got ${env.to}.`);
	checkBody(env.body, "Analysis", MAX_ANALYSIS_BYTES);
	return { run: env.run, id: env.id, from: env.from, to: env.to, analysis: env.body };
}

/** Validates an ORACLE_ACK. It only proves delivery; it is never a consultation result. */
export function validateAck(text, expected) {
	checkIds(expected);
	const env = parseOracleEnvelope(text);
	if (!env || env.type !== "ACK") throw new Error("Not an ORACLE_ACK envelope.");
	if (env.body) throw new Error("ORACLE_ACK must be a single line: receipt only, no body.");
	for (const k of ["run", "id", "from", "to"]) if (env[k] !== expected[k]) throw new Error(`Stale or wrong ${k}: expected ${expected[k]}, got ${env[k]}.`);
	return { run: env.run, id: env.id, from: env.from, to: env.to, ack: true, result: false };
}

/** Direct hc send argv: never --wait (peer waits can deadlock). */
export const hcSendArgs = (target, text) => ["send", target, text];

/** Adapter over an `hc` runner: run(argv) => Promise. Only roster members are valid prompt targets. */
export const hcSendAdapter = (run, roster) => (target, text) => {
	if (!NAME_RE.test(target ?? "") || !Array.isArray(roster) || !roster.includes(target))
		throw new Error(`Target ${q(target)} is not in the roster.`);
	return run(hcSendArgs(target, text));
};

/**
 * Send ORACLE_QUERY to the oracle and wait for the matching ORACLE_RESULT.
 * send(target, text) and receive(remainingMs) => string|null are injected (direct hc adapters).
 * ACKs and stale/unrelated messages are skipped; participant mismatch on a matching run/id throws.
 */
export async function consult({ send, receive, run, id, orchestrator, oracle, roster, brief, timeoutMs = 120000, now = Date.now }) {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000)
		throw new Error(`Invalid timeoutMs ${q(timeoutMs)}: expected a positive number <= 120000.`);
	const query = formatQuery({ run, id, from: orchestrator, to: oracle, brief, roster });
	const deadline = now() + timeoutMs; // bound starts before send
	const EXPIRED = Symbol("expired");
	let timer;
	const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(EXPIRED), timeoutMs); });
	const within = (work) => Promise.race([Promise.resolve().then(work), expired]);
	let ackSeen = false;
	let stale = 0;
	let ignored = 0;
	try {
		if ((await within(() => send(oracle, query))) !== EXPIRED) {
			for (let remaining = deadline - now(); remaining > 0; remaining = deadline - now()) {
				const text = await within(() => receive(remaining));
				if (text === EXPIRED || text === null || text === undefined) break;
				const env = parseOracleEnvelope(text);
				if (!env) { ignored++; continue; }
				if (env.run !== run || env.id !== id) { stale++; continue; }
				if (env.type === "ACK") {
					if (env.from === oracle && env.to === orchestrator && !env.body) ackSeen = true;
					else ignored++;
					continue;
				}
				if (env.type === "QUERY") { ignored++; continue; }
				return { ...validateResult(text, { run, id, from: oracle, to: orchestrator, roster }), ackSeen };
			}
		}
	} finally {
		clearTimeout(timer);
	}
	const err = new Error(
		`No ORACLE_RESULT for ${run} ${id} from ${oracle} within ${timeoutMs}ms (ack seen: ${ackSeen ? "yes" : "no"}; stale: ${stale}; ignored: ${ignored}).`,
	);
	err.code = "ORACLE_TIMEOUT";
	throw err;
}

// ---------- CLI ----------

function flagArgs(args, names) {
	const out = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const eq = a.indexOf("=");
		const flag = eq === -1 ? a : a.slice(0, eq);
		if (!names.includes(flag)) throw new Error(`Unknown option ${q(a)}.`);
		if (flag in out) throw new Error(`Duplicate ${flag}.`);
		let value;
		if (eq !== -1) value = a.slice(eq + 1);
		else {
			value = args[i + 1];
			if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
			i++;
		}
		out[flag] = value;
	}
	return out;
}

const csv = (v) => (v === undefined ? undefined : v.split(",").filter(Boolean));
const stdin = () => readFileSync(0, "utf8");

function readOptionalFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return "";
		throw error;
	}
}

export function runCli(argv, io = { stdin }) {
	const [cmd, ...rest] = argv;
	if (cmd === "parse") {
		if (rest.length && rest[0] !== "--") throw new Error("Usage: mesh-config.mjs parse -- [args...]");
		return parseInvocation(rest.slice(1));
	}
	if (cmd === "launch-args") {
		const f = flagArgs(rest, ["--name", "--kind", "--role", "--prompt-dir", "--model", "--effort", "--cwd", "--executor"]);
		const argvOut = buildAgentStartArgs({
			name: f["--name"], kind: f["--kind"], role: f["--role"],
			promptDirectory: f["--prompt-dir"] ?? DEFAULT_PROMPT_DIR, resolvedModel: f["--model"],
			effort: f["--effort"], cwd: f["--cwd"], executor: f["--executor"],
		});
		const file = rolePromptPath(f["--role"], f["--prompt-dir"] ?? DEFAULT_PROMPT_DIR);
		if (!existsSync(file)) throw new Error(`Prompt file not found: ${file}`);
		return argvOut;
	}
	if (cmd === "role-bootstrap") {
		const f = flagArgs(rest, ["--role", "--kind", "--prompt-dir", "--name", "--executor"]);
		const out = buildRoleBootstrap({
			kind: f["--kind"], role: f["--role"], promptDirectory: f["--prompt-dir"] ?? DEFAULT_PROMPT_DIR, name: f["--name"], executor: f["--executor"],
		});
		if (!existsSync(out.path)) throw new Error(`Prompt file not found: ${out.path}`);
		return out;
	}
	if (cmd === "role-loaded") {
		const f = flagArgs(rest, ["--role", "--name", "--path", "--from"]);
		return validateRoleLoaded(io.stdin(), { role: f["--role"], name: f["--name"], path: f["--path"], from: f["--from"] });
	}
	if (cmd === "role-name") {
		const f = flagArgs(rest, ["--role", "--terminal"]);
		let parsed;
		try {
			parsed = JSON.parse(io.stdin());
		} catch {
			throw new Error("Invalid terminal list JSON.");
		}
		const terminals = parsed?.terminals;
		if (!Array.isArray(terminals)) throw new Error("Terminal list JSON must contain a terminals array.");
		if (f["--role"] === "orchestrator" && f["--terminal"] === undefined) throw new Error("--terminal is required for --role orchestrator.");
		return { name: selectRoleName({ role: f["--role"], terminals, terminal: f["--terminal"] }) };
	}
	if (cmd === "split-plan") {
		const f = flagArgs(rest, ["--count", "--cols", "--rows"]);
		const int = (v, label) => {
			if (!/^[0-9]+$/.test(v ?? "")) throw new Error(`Invalid ${label} ${q(v)}: expected a positive integer.`);
			return Number(v);
		};
		return planSplits({ count: int(f["--count"], "--count"), cols: int(f["--cols"], "--cols"), rows: int(f["--rows"], "--rows") });
	}
	if (cmd === "pairs") {
		const f = flagArgs(rest, ["--names"]);
		return enumeratePairs(csv(f["--names"]));
	}
	if (cmd === "standup" || cmd === "standup-check") {
		const f = flagArgs(rest, cmd === "standup" ? ["--evidence"] : ["--evidence", "--phase"]);
		if (!f["--evidence"]) throw new Error("--evidence is required.");
		const evidenceDir = resolve(f["--evidence"]);
		if (!statSync(evidenceDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Evidence directory does not exist: ${evidenceDir}`);
		if (cmd === "standup") {
			const { plan, rosterCard, output } = buildStandup(JSON.parse(io.stdin()), evidenceDir);
			writeFileSync(output.planPath, `${JSON.stringify(plan, null, 2)}\n`);
			writeFileSync(output.rosterPath, rosterCard);
			return output;
		}
		const plan = JSON.parse(readFileSync(join(evidenceDir, "plan.json"), "utf8"));
		return checkStandup({
			phase: f["--phase"], plan, evidenceDir,
			inbox: readOptionalFile(join(evidenceDir, "inbox.txt")),
			orchSent: readOptionalFile(join(evidenceDir, "orch-sent.txt")),
			ackFiles: Object.fromEntries(plan.pairs.map(({ token }) => [token, readOptionalFile(ackPath(evidenceDir, token))])),
		});
	}
	if (cmd === "consult-query" || cmd === "consult-validate") {
		const f = flagArgs(rest, ["--run", "--id", "--from", "--to", "--roster", "--kind"]);
		const p = { run: f["--run"], id: f["--id"], from: f["--from"], to: f["--to"], roster: csv(f["--roster"]) };
		if (cmd === "consult-query") return { envelope: formatQuery({ ...p, brief: io.stdin() }) };
		const kind = f["--kind"] ?? "result";
		if (kind === "ack") return validateAck(io.stdin(), p);
		if (kind !== "result") throw new Error(`Invalid --kind ${q(kind)}: expected ack or result.`);
		return validateResult(io.stdin(), p);
	}
	throw new Error("Usage: mesh-config.mjs parse|launch-args|role-bootstrap|role-loaded|role-name|split-plan|pairs|standup|standup-check|consult-query|consult-validate");
}

// Run the CLI only when this file is the entry point. Host argv[1] may be "-", a
// nonexistent path, or a symlink; detection must never throw when imported as a library.
function isMain() {
	try {
		return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isMain()) {
	try {
		process.stdout.write(`${JSON.stringify(runCli(process.argv.slice(2)))}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
