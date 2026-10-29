#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const names = 'leia yoda ahsoka obi-wan luke han chewbacca padme lando qui-gon mace rey finn poe din grogu bo-katan cassian jyn ezra'.split(' ');
const defaultPrompts = fileURLToPath(new URL('.', import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const requireString = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
};
// Orca accepts --retry-request only in UUID shape; derive it from a stable seed so retries replay, not duplicate.
const stableUuid = (seed) => createHash('sha256').update(seed).digest('hex').slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const shellQuote = (arg) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
const command = (cli, args) => ({ argv: [cli, ...args], command: [cli, ...args].map(shellQuote).join(' ') });

function flags(args, allowed) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.includes(flag)) throw new Error(`unknown option ${flag}`);
    if (Object.hasOwn(out, flag)) throw new Error(`duplicate option ${flag}`);
    if (flag === '--no-oracle') out[flag] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      out[flag] = value;
    }
  }
  return out;
}

// agent[:model]; the model is opaque and may itself contain colons.
function selection(value) {
  const colon = value.indexOf(':');
  const agent = colon === -1 ? value : value.slice(0, colon);
  const model = colon === -1 ? null : value.slice(colon + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent) || model === '' || /\s/.test(value)) throw new Error(`expected agent[:model], got ${value}`);
  return { agent, model };
}

function effortList(raw, count, label) {
  if (raw === undefined) return [null];
  const list = raw.split(',');
  if (list.some((e) => !/^[A-Za-z0-9-]+$/.test(e))) throw new Error(`invalid ${label} ${raw}`);
  if (list.length !== 1 && list.length !== count) throw new Error(`${label} list must have exactly --workers entries`);
  return list;
}

// Orca labels a worker tab worker-<taskId> whatever --task-title says, so bootstrap renames each tab to this.
const displayName = (name) => name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('-');
function tabTitle(squad, { name, role }) {
  const label = role === 'Worker' ? `${displayName(name)} (Worker)` : role;
  return squad ? `${squad} -- ${label}` : label;
}

// Run files live in the squad's workspace (its git root when there is one), not /tmp, so a reboot cannot wipe them.
function meshRoot() {
  if (process.env.ORCA_MESH_ROOT) return resolve(process.env.ORCA_MESH_ROOT);
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return join(git.status === 0 ? git.stdout.trim() : process.cwd(), '.orca-mesh');
}

function runDir(run) {
  if (!/^orcamesh-\d{14}-[a-f0-9]{4}$/.test(run ?? '')) throw new Error('invalid --run');
  return join(meshRoot(), run);
}

function plan(f) {
  const orcaRun = requireString(f['--orca-run'], '--orca-run');
  if (/\s/.test(orcaRun)) throw new Error('--orca-run must not contain whitespace');
  const orcaCli = f['--orca-cli'] ?? 'orca';
  const squad = f['--squad']?.trim() || null;
  if (squad && (squad.length > 40 || /[\r\n\t]/.test(squad))) throw new Error('--squad must be a single line of at most 40 characters');
  const raw = f['--workers'] ?? '4';
  const count = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(count) || count < 1) throw new Error('--workers must be an integer >= 1');
  if (f['--no-oracle'] && f['--oracle']) throw new Error('--oracle and --no-oracle are mutually exclusive');
  if (f['--no-oracle'] && f['--oracle-effort']) throw new Error('--oracle-effort and --no-oracle are mutually exclusive');
  const oracle = f['--no-oracle'] ? null : { ...selection(f['--oracle'] ?? 'codex:gpt-6-astra'), effort: effortList(f['--oracle-effort'], 1, '--oracle-effort')[0] };
  if (count + (oracle ? 1 : 0) > 20) throw new Error('at most 20 workers can be started');
  const models = (f['--worker-model'] ?? 'codex:gpt-6.1-sol').split(',').map(selection);
  if (models.length !== 1 && models.length !== count) throw new Error('worker-model list must have exactly --workers entries');
  const efforts = effortList(f['--worker-effort'], count, '--worker-effort');
  const workers = names.slice(0, count).map((name, i) => ({
    name, role: 'Worker', ...models[models.length === 1 ? 0 : i], effort: efforts[efforts.length === 1 ? 0 : i],
  }));
  for (const member of [...(oracle ? [{ name: 'oracle', ...oracle }] : []), ...workers]) {
    // Orca refuses --effort without --model, so reject it before anything launches.
    if (member.effort && !member.model) throw new Error(`effort for ${member.name} requires an explicit model`);
  }
  const promptsDir = resolve(f['--prompts-dir'] ?? defaultPrompts);
  const members = [
    { name: 'orchestrator', role: 'Orchestrator' },
    ...(oracle ? [{ name: 'oracle', role: 'Oracle', ...oracle }] : []),
    ...workers,
  ].map((member, index) => {
    const roleFile = join(promptsDir, member.role === 'Worker' ? 'workers.md' : `${member.name}.md`);
    return { index, ...member, roleFile, sha256: createHash('sha256').update(readFileSync(roleFile)).digest('hex') };
  });
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const run = `orcamesh-${stamp}-${randomBytes(2).toString('hex')}`;
  const dir = runDir(run);
  mkdirSync(meshRoot(), { recursive: true });
  // The default root ignores itself, so git never sees it and the repo's own .gitignore stays untouched.
  if (!process.env.ORCA_MESH_ROOT) writeFileSync(join(meshRoot(), '.gitignore'), '*\n');
  mkdirSync(dir, { recursive: false });
  // Each non-orchestrator member is a supervised worker on the orchestrator's Run; ids are unknown until start.
  const workerStarts = members.slice(1).map(({ name, role, agent, model, effort, roleFile }) => {
    const standby = join(dir, `standby-${name}.txt`);
    writeFileSync(standby, standbyText(run, orcaRun, name, role, roleFile));
    const retryRequest = stableUuid(`${run}-start-${name}`);
    const spec = `MESH_STANDBY ${run} TO ${name}: you are ${name} (${role}), a standing member of an Orca meshed-agent squad. Read ${standby} completely and follow it. This Task is squad membership: send worker_done only after MESH_DISBAND ${run} arrives from the orchestrator.`;
    return {
      name,
      save: join(dir, `start-${name}.json`),
      retryRequest,
      ...command(orcaCli, [
        'orchestration', 'worker-start', '--spec', spec, '--task-title', `${name} (${role})`,
        '--worktree', 'current', '--agent', agent,
        ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
        '--retry-request', retryRequest, '--json',
      ]),
    };
  });
  writeJson(join(dir, 'plan.json'), { run, dir, orcaRun, orcaCli, squad, promptsDir, members, workerStarts });
  return { run, dir, orcaRun, squad, workerStarts };
}

function standbyText(run, orcaRun, name, role, roleFile) {
  return `MESH_STANDBY ${run} TO ${name}
You are ${name}, role ${role}, a supervised Orca worker and standing member of a meshed-agent squad (mesh run ${run}, Orca Run ${orcaRun}). The terminal that started you is the orchestrator.
This Orca Task is squad membership, not one unit of work: it lasts as long as the squad. Stay on this Dispatch, accept later work only as the orchestrator routes it, and send worker_done only after MESH_DISBAND ${run} FROM orchestrator TO ${name}.
Your Orca preamble is authoritative for the executable, --from value, Task ID, Dispatch ID, check command, and heartbeat cadence. Copy them exactly; never reconstruct them.
Do now, and nothing else:
1. Read ${roleFile} completely and adopt it for this session (repo and safety rules still win).
2. Confirm your preamble's Orca executable runs \`orchestration send --help\` and \`orchestration check --help\`.
3. Send one message to the orchestrator with your preamble's send command shape: --to run:${orcaRun} --type status --subject "STANDBY ${run} FROM ${name} tools=<ok|missing>" --json
4. Drain your mailbox: run your preamble's check command, process every returned message, and acknowledge that Delivery with --ack <delivery_id> on the next check; repeat until a check returns no messages. Then end your turn. Orca cannot wake you for new mail while a Delivery stays unacknowledged.
No repo exploration, tests, or edits. Message no one else yet. Do not send worker_done.
A later message, MESH_BOOTSTRAP ${run} TO ${name}, will carry your roster and mesh instructions.
`;
}

function enumeratePairs(run, members) {
  const pairs = [];
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    pairs.push({ token: `${run}-${i}-${j}`, sender: members[i].name, recipient: members[j].name });
  }
  return pairs;
}

function bootstrapText(plan, member, members, pairs) {
  const { run, dir, orcaRun } = plan;
  const outbound = pairs.filter((p) => p.sender === member.name);
  const inbound = pairs.filter((p) => p.recipient === member.name);
  const roster = members.map((m) => `| ${m.name} | ${m.role} | ${m.address} |`).join('\n');
  const expectations = (list, direction) => list.length ? list.map((p) => {
    const peer = members.find((m) => m.name === p[direction === '→' ? 'recipient' : 'sender']);
    return `- ${p.token} ${direction} ${peer.name} (address ${peer.address})`;
  }).join('\n') : '- none';
  return `MESH_BOOTSTRAP ${run} TO ${member.name}

## Identity and transport
You are ${member.name}, role ${member.role}, mesh run ${run}, own address ${member.address} (Task ${member.taskId}) in Orca Run ${orcaRun}.
You are a supervised Orca worker started by the orchestrator; every peer is a separate Dispatch you can address directly.
Messages travel only via Orca \`orchestration send\`, using your preamble's executable and exact --from: --to <roster address> --type status --subject "<envelope line>" --json. Never use group addresses (@all, @idle, ...) for protocol traffic.
For a multi-line envelope (PAIR_REPORT, ORACLE_QUERY/RESULT, TASK_REPORT), put its first line in --subject and the whole envelope in --body; pass the body through single quotes or a quoted heredoc, never shell interpolation.
Read mail only with your preamble's check command (\`orchestration check --terminal <your handle> --json\`). A check returns one Delivery (deliveryId plus messages) and replays it until acknowledged.
A successful send proves durable enqueue, not receipt. Your final turn text and terminal output are never protocol evidence; send every envelope explicitly.

## Waking and draining
Drain invariant: process every message in a returned Delivery, then run the check again with --ack <delivery_id>; that acknowledges the batch and returns the next one. Repeat until a check returns no messages, and only then end your turn.
Orca notifies an idle agent when mail reaches its Dispatch mailbox, but never while a Delivery is still unacknowledged, so ending a turn with one outstanding silences all later mail.
On every wake, drain first. Mid-turn, drain at each natural checkpoint.
Draining delivered mail is not polling: never sleep, loop on an empty mailbox, or use check --wait.

## Role
Read ${member.roleFile} completely and adopt it for this whole session; repo and safety rules still win.
Role-file terms map: pane/target = roster address; sending a prompt = \`orchestration send\`; the orchestrator's mailbox = run:${orcaRun}.

## Roster
| name | role | address |
|---|---|---|
${roster}

## Standup boundary
Until MESH_READY ${run}, do only setup and communication checks: no repo exploration, tests, or edits.
Optional protocol evidence may be appended only to ${join(dir, `${member.name}.log`)}.

## Envelopes
MESH_PING ${run} <token> FROM <s> TO <r>
MESH_ACK ${run} <token> FROM <r> TO <s>
BOOT_ACK ${run} FROM ${member.name} TO orchestrator role=${member.role} sha256=<hash> model=<model>
PAIR_REPORT ${run} FROM ${member.name} complete=<true|false> acks_received=[t,...] pings_answered=[t,...]
READY_ACK ${run} FROM ${member.name}

## Exact expectations
Outbound PINGs (accept corresponding ACKs FROM the recipient TO ${member.name}):
${expectations(outbound, '→')}
Inbound PINGs (FROM the listed sender TO ${member.name}):
${expectations(inbound, '←')}
Accept a PING or ACK only if run, token, sender AND recipient all match an entry above. Ignore everything else and log it in the optional evidence log.

## Communication rules
Answer valid inbound PINGs any time after bootstrap, even before PAIRS_GO: send the matching ACK directly to the sender's roster address, with the same token and FROM/TO swapped.
Send outbound PINGs only after PAIRS_GO ${run} FROM orchestrator TO ${member.name}.
Duplicates are idempotent: re-ACK a duplicate PING; repeated PAIRS_GO resends only PINGs still lacking ACK; repeated MESH_READY resends READY_ACK.
Track tokens exactly. Send PAIR_REPORT complete=true exactly when all outbound ACKs are received AND all inbound PINGs are answered. A member with zero outbound sends it once inbound is complete.
On PAIRS_STATUS? ${run}, send the current PAIR_REPORT to orchestrator (complete=false if incomplete).
Never route peer traffic via the orchestrator. Never poll or sleep: drain, then end the turn; incoming mail wakes you.

## Do now
1. Load the role file completely.
2. Run shasum -a 256 '${member.roleFile.replaceAll("'", "'\\''")}'.
3. Send BOOT_ACK to run:${orcaRun} using the computed hash and your actual model id${member.model ? ` (expected ${member.model})` : ''}.
4. Drain your mailbox, acknowledging this bootstrap's Delivery, then end your turn.

## After READY
On MESH_READY ${run} FROM orchestrator TO ${member.name}, send READY_ACK to orchestrator, drain your mailbox, then end your turn and stay idle until a later user-authorized assignment is routed by the orchestrator. Drain before ending every later turn too.
Assignments arrive as ASSIGN ${run} <assignment-id> FROM orchestrator TO ${member.name}. Reply ASSIGN_ACK ${run} <assignment-id> FROM ${member.name} on receipt, and on reaching a terminal state send TASK_REPORT ${run} <assignment-id> FROM ${member.name} status=<completed|partial|blocked|failed> with the report your role file requires. These are status messages, never worker_done.
Ask the orchestrator blocking questions with your preamble's \`orchestration ask\` command; never open a local question prompt it cannot answer.
On MESH_DISBAND ${run} FROM orchestrator TO ${member.name}, start no new work, drain your mailbox once more, send worker_done exactly once with your preamble's command (--outcome succeeded unless your membership failed), then idle.
Oracle follows oracle.md ORACLE_QUERY/ACK/RESULT protocol.
Members share one workspace (same project/branch); touch only files you are assigned.
`;
}

function unwrapReceipt(raw, save) {
  if (raw && typeof raw === 'object' && raw.ok === false) throw new Error(`worker-start failed in ${save}: ${raw.error?.code ?? 'unknown error'}`);
  const receipt = raw?.result ?? raw;
  if (!receipt || typeof receipt !== 'object') throw new Error(`invalid worker-start receipt ${save}`);
  return receipt;
}

function bootstrap(f) {
  const dir = runDir(f['--run']);
  const planned = readJson(join(dir, 'plan.json'));
  const dispatchIds = new Set();
  const taskIds = new Set();
  const warnings = [];
  const members = planned.members.map((member, i) => {
    if (!i) return { ...member, address: `run:${planned.orcaRun}` };
    const { save } = planned.workerStarts[i - 1];
    let raw;
    try { raw = readJson(save); } catch { throw new Error(`missing or invalid worker-start receipt ${save}`); }
    const receipt = unwrapReceipt(raw, save);
    if (receipt.state !== 'ready') throw new Error(`worker-start for ${member.name} is ${receipt.state ?? 'unknown'}, not ready`);
    if (receipt.runId !== planned.orcaRun) throw new Error(`Run mismatch for ${member.name}`);
    const dispatchId = requireString(receipt.dispatchId, `dispatchId for ${member.name}`);
    const taskId = requireString(receipt.taskId, `taskId for ${member.name}`);
    if (dispatchIds.has(dispatchId)) throw new Error(`duplicate dispatchId ${dispatchId}`);
    if (taskIds.has(taskId)) throw new Error(`duplicate taskId ${taskId}`);
    // The agent must be provable even when the model is inherited; effective wins over requested.
    const effective = receipt.launch?.effective;
    const launched = effective ?? receipt.launch?.requested;
    if (!launched || launched.agent !== member.agent) throw new Error(`launch agent missing or mismatched for ${member.name}`);
    if (member.model && !effective) throw new Error(`launch.effective missing for ${member.name}; cannot verify its model`);
    if (effective && ((member.model && effective.model !== member.model) || (member.effort && effective.effort !== member.effort))) {
      throw new Error(`model/effort mismatch for ${member.name}`);
    }
    if (!effective) warnings.push(`${member.name}: launch.effective absent; agent verified from launch.requested only`);
    dispatchIds.add(dispatchId);
    taskIds.add(taskId);
    const handle = receipt.agentTerminalHandle ?? receipt.effects?.find?.((e) => e?.kind === 'terminal' && e.role === 'agent')?.id ?? null;
    if (!handle) warnings.push(`${member.name}: terminal handle unresolved (address by Dispatch only)`);
    return { ...member, address: `dispatch:${dispatchId}`, dispatchId, taskId, handle, effectiveModel: effective?.model ?? member.model ?? null };
  });
  const pairs = enumeratePairs(planned.run, members);
  writeJson(join(dir, 'roster.json'), members);
  writeJson(join(dir, 'pairs.json'), pairs);
  for (const member of members.slice(1)) writeFileSync(join(dir, `bootstrap-${member.name}.txt`), bootstrapText(planned, member, members, pairs));
  // Retry bootstrap without losing receipts already collected by the executor.
  writeFileSync(join(dir, 'reports.log'), '', { flag: 'a' });
  return {
    dir,
    orcaRun: planned.orcaRun,
    warnings,
    members: members.slice(1).map(({ name, role, address, dispatchId, taskId, handle }) => {
      const title = tabTitle(planned.squad, { name, role });
      return {
        name, address, dispatchId, taskId, handle, title,
        rename: handle ? command(planned.orcaCli, ['terminal', 'rename', '--terminal', handle, '--title', title, '--json']) : null,
        ...memberMessages(planned, pairs, name, address, ''),
      };
    }),
    orchestrator: { address: `run:${planned.orcaRun}`, title: tabTitle(planned.squad, members[0]), outbound: pairs.filter((p) => p.sender === 'orchestrator').map((p) => p.token), inbound: [] },
  };
}

// The retry seed suffix separates a replay of one uncertain send ('') from a deliberate new protocol round.
function memberMessages(planned, pairs, name, address, round) {
  const { run, dir } = planned;
  const send = (kind, subject, body) => {
    const retryRequest = stableUuid(`${run}-${kind}-${name}${round}`);
    return { retryRequest, ...command(planned.orcaCli, ['orchestration', 'send', '--to', address, '--type', 'status', '--subject', subject,
      ...(body ? ['--body', body] : []), '--retry-request', retryRequest, '--json']) };
  };
  const ping = pairs.find((p) => p.sender === 'orchestrator' && p.recipient === name);
  return {
    boot: send('boot', `MESH_BOOTSTRAP ${run} TO ${name}`, `Read ${join(dir, `bootstrap-${name}.txt`)} completely and follow it; do its Do now steps, then end your turn.`),
    go: send('go', `PAIRS_GO ${run} FROM orchestrator TO ${name}`),
    ping: send('ping', `MESH_PING ${run} ${ping.token} FROM orchestrator TO ${name}`),
    ready: send('ready', `MESH_READY ${run} FROM orchestrator TO ${name}`, 'Reply READY_ACK, drain your mailbox, then end your turn and stay idle until a user-authorized assignment is routed to you.'),
    disband: send('disband', `MESH_DISBAND ${run} FROM orchestrator TO ${name}`, 'Start no new work. Drain your mailbox, send worker_done exactly once with your preamble command (--outcome succeeded unless your membership failed), then idle.'),
  };
}

function resend(f) {
  const dir = runDir(f['--run']);
  const planned = readJson(join(dir, 'plan.json'));
  const roster = readJson(join(dir, 'roster.json'));
  const pairs = readJson(join(dir, 'pairs.json'));
  const round = f['--round'] ?? '';
  if (!/^[1-9]\d*$/.test(round)) throw new Error('--round must be an integer >= 1');
  const kind = f['--kind'];
  if (!['boot', 'go', 'ping', 'ready', 'disband'].includes(kind)) throw new Error('--kind must be boot|go|ping|ready|disband');
  const member = roster.find((m) => m.name === f['--name'] && m.name !== 'orchestrator');
  if (!member) throw new Error(`unknown member ${f['--name']}`);
  return { name: member.name, kind, round: Number(round), ...memberMessages(planned, pairs, member.name, member.address, `-round${round}`)[kind] };
}

function matrix(f) {
  const run = f['--run'];
  const dir = runDir(run);
  const members = readJson(join(dir, 'roster.json'));
  const pairs = readJson(join(dir, 'pairs.json'));
  const evidence = new Map(members.map((m) => [m.name, { acks_received: new Set(), pings_answered: new Set() }]));
  const knownTokens = new Set(pairs.map((p) => p.token));
  const errors = [];
  for (const line of readFileSync(join(dir, 'reports.log'), 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('PAIR_REPORT ')) continue;
    const header = /^PAIR_REPORT (\S+) FROM (\S+)(?:\s|$)/.exec(line);
    if (header && header[1] !== run) continue;
    if (!header) { errors.push(`malformed report: ${line}`); continue; }
    const member = header[2];
    if (!evidence.has(member)) { errors.push(`unknown member ${member}`); continue; }
    if (!/\bcomplete=(true|false)(?:\s|$)/.test(line)) errors.push(`missing or invalid complete for ${member}`);
    for (const field of ['acks_received', 'pings_answered']) {
      const match = new RegExp(`(?:^|\\s)${field}=\\[([^\\]]*)\\]`).exec(line);
      if (!match) { errors.push(`missing ${field} for ${member}`); continue; }
      for (const token of match[1].split(',').map((t) => t.trim()).filter(Boolean)) {
        if (!knownTokens.has(token)) errors.push(`unknown token ${token} from ${member}`);
        else evidence.get(member)[field].add(token);
      }
    }
  }
  const results = pairs.map((pair) => {
    const missing = [];
    if (!evidence.get(pair.sender).acks_received.has(pair.token)) missing.push(`${pair.sender}:acks_received`);
    if (!evidence.get(pair.recipient).pings_answered.has(pair.token)) missing.push(`${pair.recipient}:pings_answered`);
    return { ...pair, pass: missing.length === 0, missing };
  });
  const passed = results.filter((p) => p.pass).length;
  writeFileSync(join(dir, 'pair-matrix.txt'), [
    `${run}: ${passed}/${results.length} PASS`,
    ...results.map((p) => `${p.token} ${p.sender} -> ${p.recipient} ${p.pass ? 'PASS' : `FAIL ${p.missing.join(', ')}`}`),
    ...errors.map((e) => `ERROR ${e}`), '',
  ].join('\n'));
  return { run, total: results.length, passed, pairs: results, errors };
}

function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'orca-mesh-selftest-'));
  const script = fileURLToPath(import.meta.url);
  let checks = 0;
  const cli = (args, expected = 0) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ORCA_MESH_ROOT: root } });
    assert.equal(result.status, expected, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    checks++;
    if (expected === 1) { assert.match(result.stderr, /^error: /); assert.equal(result.stdout, ''); return; }
    return JSON.parse(result.stdout);
  };
  try {
    const prompts = join(root, 'prompts');
    mkdirSync(prompts);
    for (const role of ['orchestrator', 'oracle', 'workers']) writeFileSync(join(prompts, `${role}.md`), `Role ${role}\n`);
    const makePlan = (...args) => cli(['plan', '--orca-run', 'run_test', '--prompts-dir', prompts, ...args]);
    const argOf = (start, flag) => start.argv[start.argv.indexOf(flag) + 1];
    const defaults = makePlan();
    assert.equal(defaults.workerStarts.length, 5);
    assert.equal(argOf(defaults.workerStarts[0], '--model'), 'gpt-6-astra');
    assert.equal(argOf(defaults.workerStarts[0], '--agent'), 'codex');
    assert.equal(argOf(defaults.workerStarts[0], '--worktree'), 'current');
    assert.equal(defaults.workerStarts[0].argv[0], 'orca');
    assert.match(argOf(defaults.workerStarts[0], '--retry-request'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(readFileSync(join(defaults.dir, 'standby-leia.txt'), 'utf8').includes('workers.md'));
    assert.ok(!defaults.workerStarts[0].argv.includes('--effort'));
    assert.equal(readJson(join(defaults.dir, 'plan.json')).members[0].model, undefined);
    const noOracle = makePlan('--no-oracle');
    assert.equal(noOracle.workerStarts.length, 4);
    const maximum = makePlan('--no-oracle', '--workers', '20');
    assert.equal(maximum.workerStarts.length, 20);
    assert.equal(argOf(maximum.workerStarts.at(-1), '--task-title'), 'ezra (Worker)');
    const mixed = makePlan('--workers', '2', '--worker-model', 'codex:gpt-6.1-sol,claude:claude-sonnet-5-5', '--worker-effort', 'high,low');
    assert.equal(argOf(mixed.workerStarts[2], '--agent'), 'claude');
    assert.equal(argOf(mixed.workerStarts[2], '--effort'), 'low');
    const inherit = makePlan('--workers', '1', '--worker-model', 'claude', '--orca-cli', 'orca-dev');
    assert.ok(!inherit.workerStarts[1].argv.includes('--model'));
    assert.equal(inherit.workerStarts[1].argv[0], 'orca-dev');
    const colon = makePlan('--workers', '1', '--worker-model', 'custom:org/model:version');
    assert.equal(argOf(colon.workerStarts[1], '--model'), 'org/model:version');
    assert.match(colon.workerStarts[1].command, /--spec 'MESH_STANDBY/);
    for (const args of [['--workers', '0'], ['--workers', '20'], ['--worker-model', 'bad agent'], ['--worker-model', 'codex:'], ['--workers', '2', '--worker-model', 'a:b,c:d,e:f'], ['--oracle', 'a:b', '--no-oracle'], ['--worker-model', 'claude', '--worker-effort', 'high'], ['--no-oracle', '--oracle-effort', 'high'], ['--workers', '2', '--worker-effort', 'a,b,c'], ['--squad', 'a\nb'], ['--squad', 'x'.repeat(41)]]) cli(['plan', '--orca-run', 'run_test', '--prompts-dir', prompts, ...args], 1);
    cli(['plan', '--prompts-dir', prompts], 1);
    // Without ORCA_MESH_ROOT, runs land in <workspace>/.orca-mesh: the git root when there is one, else the cwd.
    const { ORCA_MESH_ROOT: _, ...bareEnv } = process.env;
    const planIn = (cwd) => {
      const result = spawnSync(process.execPath, [script, 'plan', '--orca-run', 'run_test', '--prompts-dir', prompts], { cwd, encoding: 'utf8', env: bareEnv });
      assert.equal(result.status, 0, result.stderr);
      checks++;
      return JSON.parse(result.stdout).dir;
    };
    const folder = realpathSync(mkdtempSync(join(root, 'folder-')));
    assert.equal(dirname(planIn(folder)), join(folder, '.orca-mesh'));
    assert.equal(readFileSync(join(folder, '.orca-mesh', '.gitignore'), 'utf8'), '*\n');
    if (spawnSync('git', ['--version']).status === 0) {
      const repo = realpathSync(mkdtempSync(join(root, 'repo-')));
      assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
      mkdirSync(join(repo, 'sub'));
      assert.equal(dirname(planIn(join(repo, 'sub'))), join(repo, '.orca-mesh'));
      assert.equal(spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '');
    }
    const planned = makePlan('--workers', '10');
    const starts = readJson(join(planned.dir, 'plan.json')).members.slice(1);
    const receipts = starts.map((m, i) => ({ runId: 'run_test', taskId: `task_${i}`, dispatchId: `dispatch_${i}`, state: 'ready', launch: { requested: { agent: m.agent, model: m.model, effort: null }, effective: { agent: m.agent, model: m.model, effort: null } }, effects: [{ kind: 'terminal', role: 'agent', id: `term_${i}` }] }));
    const saveAll = (list) => { rmSync(planned.workerStarts[0].save, { force: true }); list.forEach((r, i) => r && writeJson(planned.workerStarts[i].save, r)); };
    const bootArgs = ['bootstrap', '--run', planned.run];
    const invalid = [
      [undefined, ...receipts.slice(1)],
      receipts.map((r, i) => i === 1 ? { ...r, dispatchId: receipts[0].dispatchId } : r),
      receipts.map((r, i) => i === 1 ? { ...r, runId: 'run_other' } : r),
      receipts.map((r, i) => i === 1 ? { ...r, launch: { ...r.launch, effective: { ...r.launch.effective, model: 'wrong' } } } : r),
      receipts.map((r, i) => i === 1 ? { ...r, launch: undefined } : r),
      receipts.map((r, i) => i === 1 ? { ...r, taskId: undefined } : r),
      receipts.map((r, i) => i === 1 ? { ...r, taskId: receipts[0].taskId } : r),
      receipts.map((r, i) => i === 1 ? { ...r, launch: { ...r.launch, effective: { ...r.launch.effective, agent: 'claude' } } } : r),
      receipts.map((r, i) => i === 1 ? { ...r, state: 'outcome_unknown' } : r),
      receipts.map((r, i) => i === 1 ? { ok: false, error: { code: 'runtime_error' } } : r),
    ];
    for (const fixture of invalid) { saveAll(fixture); cli(bootArgs, 1); }
    saveAll(receipts.map((r, i) => i === 0 ? { id: 'x', ok: true, result: r } : r));
    const boot = cli(bootArgs);
    assert.equal(boot.members.length, 11);
    assert.equal(boot.members[0].address, 'dispatch:dispatch_0');
    assert.equal(boot.members[0].taskId, 'task_0');
    assert.equal(boot.members[0].handle, 'term_0');
    assert.equal(boot.orchestrator.address, 'run:run_test');
    assert.deepEqual(boot.members[0].boot.argv.slice(0, 5), ['orca', 'orchestration', 'send', '--to', 'dispatch:dispatch_0']);
    assert.equal(boot.members[0].boot.retryRequest, cli(bootArgs).members[0].boot.retryRequest);
    assert.notEqual(boot.members[0].boot.retryRequest, boot.members[0].go.retryRequest);
    assert.deepEqual(boot.warnings, []);
    assert.equal(boot.members[0].title, 'Oracle');
    assert.equal(boot.members.find((m) => m.name === 'obi-wan').title, 'Obi-Wan (Worker)');
    assert.equal(boot.orchestrator.title, 'Orchestrator');
    assert.deepEqual(boot.members[0].rename.argv, ['orca', 'terminal', 'rename', '--terminal', 'term_0', '--title', 'Oracle', '--json']);
    const squad = makePlan('--squad', 'Hedwig', '--workers', '4');
    assert.equal(readJson(join(squad.dir, 'plan.json')).squad, 'Hedwig');
    squad.workerStarts.forEach((start, i) => writeJson(start.save, receipts[i]));
    const squadBoot = cli(['bootstrap', '--run', squad.run]);
    assert.deepEqual(squadBoot.members.map((m) => m.title), ['Hedwig -- Oracle', 'Hedwig -- Leia (Worker)', 'Hedwig -- Yoda (Worker)', 'Hedwig -- Ahsoka (Worker)', 'Hedwig -- Obi-Wan (Worker)']);
    assert.equal(squadBoot.orchestrator.title, 'Hedwig -- Orchestrator');
    assert.match(squadBoot.members[4].rename.command, /--title 'Hedwig -- Obi-Wan \(Worker\)'/);
    const resendArgs = (...extra) => ['resend', '--run', planned.run, '--name', 'leia', '--kind', 'ready', ...extra];
    const fresh = cli(resendArgs('--round', '1'));
    const readyLeia = boot.members.find((m) => m.name === 'leia').ready;
    assert.equal(fresh.argv[fresh.argv.indexOf('--subject') + 1], readyLeia.argv[readyLeia.argv.indexOf('--subject') + 1]);
    assert.notEqual(fresh.retryRequest, readyLeia.retryRequest);
    assert.equal(fresh.retryRequest, cli(resendArgs('--round', '1')).retryRequest);
    assert.notEqual(fresh.retryRequest, cli(resendArgs('--round', '2')).retryRequest);
    for (const bad of [resendArgs(), resendArgs('--round', '0'), ['resend', '--run', planned.run, '--name', 'leia', '--kind', 'nope', '--round', '1'], ['resend', '--run', planned.run, '--name', 'orchestrator', '--kind', 'go', '--round', '1']]) cli(bad, 1);
    // Bare agents inherit their model, but the launched agent must still be provable.
    const bare = makePlan('--workers', '2', '--no-oracle', '--worker-model', 'codex');
    const bareReceipt = (i, launch) => ({ runId: 'run_test', taskId: `bare_task_${i}`, dispatchId: `bare_dispatch_${i}`, state: 'ready', launch, effects: [] });
    const bareBoot = (list) => { list.forEach((r, i) => writeJson(bare.workerStarts[i].save, r)); return ['bootstrap', '--run', bare.run]; };
    cli(bareBoot([bareReceipt(0), bareReceipt(1)]), 1);
    cli(bareBoot([bareReceipt(0, { requested: { agent: 'claude' }, effective: null }), bareReceipt(1, { requested: { agent: 'codex' }, effective: null })]), 1);
    const bareOk = cli(bareBoot([bareReceipt(0, { requested: { agent: 'codex', model: null }, effective: null }), bareReceipt(1, { requested: { agent: 'codex' }, effective: { agent: 'codex', model: null, effort: null } })]));
    assert.ok(bareOk.warnings.some((w) => w.includes('launch.effective absent')));
    assert.ok(bareOk.warnings.some((w) => w.includes('terminal handle unresolved')));
    assert.equal(bareOk.members[0].rename, null);
    assert.match(readFileSync(join(bare.dir, 'standby-leia.txt'), 'utf8'), /--ack <delivery_id>/);
    const roster = readJson(join(planned.dir, 'roster.json'));
    const pairs = readJson(join(planned.dir, 'pairs.json'));
    assert.equal(pairs.length, 66);
    assert.ok(pairs.some((p) => p.token === `${planned.run}-1-10`));
    const report = (name) => `PAIR_REPORT ${planned.run} FROM ${name} complete=true acks_received=[${pairs.filter((p) => p.sender === name).map((p) => p.token)}] pings_answered=[${pairs.filter((p) => p.recipient === name).map((p) => p.token)}]`;
    const lines = roster.map((m) => report(m.name));
    const matrixArgs = ['matrix', '--run', planned.run];
    const reportsFile = join(planned.dir, 'reports.log');
    writeFileSync(reportsFile, `${lines.join('\n')}\n${lines[0]}\nPAIR_REPORT wrong-run FROM nobody complete=true acks_received=[bad] pings_answered=[]\n`);
    assert.equal(cli(matrixArgs).passed, pairs.length);
    assert.match(lines.at(-1), /acks_received=\[\]/);
    cli(bootArgs);
    assert.equal(cli(matrixArgs).passed, pairs.length);
    writeFileSync(reportsFile, `${lines.join('\n')}\nPAIR_REPORT ${planned.run} FROM orchestrator complete=true acks_received=[${planned.run}-unknown] pings_answered=[]\n`);
    assert.ok(cli(matrixArgs, 2).errors.some((e) => e.includes('unknown token')));
    writeFileSync(reportsFile, `${lines.join('\n')}\nPAIR_REPORT ${planned.run} FROM nobody complete=true acks_received=[] pings_answered=[]\n`);
    assert.ok(cli(matrixArgs, 2).errors.some((e) => e.includes('unknown member')));
    writeFileSync(reportsFile, lines.slice(0, -1).join('\n'));
    assert.ok(cli(matrixArgs, 2).passed < pairs.length);
    writeFileSync(reportsFile, lines.map((line, i) => i === 1 ? line.replace(/pings_answered=\[[^\]]*\]/, '') : line).join('\n'));
    assert.ok(cli(matrixArgs, 2).errors.some((e) => e.includes('missing pings_answered')));
    writeFileSync(reportsFile, lines.map((line, i) => i === 1 ? line.replace(`${planned.run}-0-1`, `${planned.run}-0-10`) : line).join('\n'));
    assert.equal(cli(matrixArgs, 2).pairs.find((p) => p.token === `${planned.run}-0-1`).pass, false);
    const text = readFileSync(join(planned.dir, 'bootstrap-oracle.txt'), 'utf8');
    for (const required of ['own address dispatch:', 'supervised Orca worker', 'never protocol evidence', 'orchestration send', 'run:run_test', 'Never use group addresses', '## Waking and draining', 'Drain invariant', 'never while a Delivery is still unacknowledged', '## Role', '## Roster', '## Standup boundary', '## Envelopes', '## Exact expectations', '## Communication rules', '## Do now', '## After READY', 'MESH_DISBAND', 'ORACLE_QUERY/ACK/RESULT', 'AND all inbound', 'Never poll or sleep']) assert.ok(text.includes(required), required);
    return { ok: true, checks };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  const [cmd, ...args] = process.argv.slice(2);
  let result;
  if (cmd === 'plan') result = plan(flags(args, ['--orca-run', '--orca-cli', '--squad', '--workers', '--worker-model', '--worker-effort', '--oracle', '--oracle-effort', '--no-oracle', '--prompts-dir']));
  else if (cmd === 'bootstrap') result = bootstrap(flags(args, ['--run']));
  else if (cmd === 'resend') result = resend(flags(args, ['--run', '--name', '--kind', '--round']));
  else if (cmd === 'matrix') {
    result = matrix(flags(args, ['--run']));
    if (result.passed !== result.total || result.errors.length) process.exitCode = 2;
  } else if (cmd === 'selftest' && !args.length) result = selftest();
  else throw new Error('usage: orca-mesh.mjs plan|bootstrap|resend|matrix|selftest');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
