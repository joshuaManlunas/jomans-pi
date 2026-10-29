#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

function target(value) {
  const colon = value.indexOf(':');
  if (colon < 1 || colon === value.length - 1 || /\s/.test(value)) throw new Error(`expected inst:model, got ${value}`);
  return { providerInstanceId: value.slice(0, colon), model: value.slice(colon + 1) };
}

function runDir(run) {
  if (!/^t3mesh-\d{14}-[a-f0-9]{4}$/.test(run ?? '')) throw new Error('invalid --run');
  return join(resolve(process.env.T3_MESH_ROOT || '/tmp'), run);
}

function plan(f) {
  const raw = f['--workers'] ?? '4';
  const count = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(count) || count < 1) throw new Error('--workers must be an integer >= 1');
  if (f['--no-oracle'] && f['--oracle']) throw new Error('--oracle and --no-oracle are mutually exclusive');
  const oracle = f['--no-oracle'] ? null : target(f['--oracle'] ?? 'codex:gpt-6-astra');
  if (count + (oracle ? 1 : 0) > 20) throw new Error('at most 20 threads can be created');
  const models = (f['--worker-model'] ?? 'codex:gpt-6.1-sol').split(',').map(target);
  if (models.length !== 1 && models.length !== count) throw new Error('worker-model list must have exactly --workers entries');
  const promptsDir = resolve(f['--prompts-dir'] ?? defaultPrompts);
  const members = [
    { name: 'orchestrator', role: 'Orchestrator' },
    ...(oracle ? [{ name: 'oracle', role: 'Oracle', ...oracle }] : []),
    ...names.slice(0, count).map((name, i) => ({ name, role: 'Worker', ...models[models.length === 1 ? 0 : i] })),
  ].map((member, index) => {
    const roleFile = join(promptsDir, member.role === 'Worker' ? 'workers.md' : `${member.name}.md`);
    return { index, ...member, roleFile, sha256: createHash('sha256').update(readFileSync(roleFile)).digest('hex') };
  });
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const run = `t3mesh-${stamp}-${randomBytes(2).toString('hex')}`;
  const dir = runDir(run);
  // Each non-orchestrator member is a delegate_task child thread of the orchestrator; ids are unknown until spawn.
  const delegateTasks = members.slice(1).map(({ name, role, providerInstanceId, model, roleFile }) => ({
    name,
    save: join(dir, `delegate-${name}.json`),
    args: {
      clientRequestId: `${run}-delegate-${name}`,
      title: `${name} (${role})`,
      target: { providerInstanceId, model },
      mode: 'async',
      role: 'general',
      task: standbyText(run, name, role, roleFile),
    },
  }));
  mkdirSync(resolve(process.env.T3_MESH_ROOT || '/tmp'), { recursive: true });
  mkdirSync(dir, { recursive: false });
  writeJson(join(dir, 'plan.json'), { run, dir, promptsDir, members, delegateTasks });
  return { run, dir, delegateTasks };
}

function standbyText(run, name, role, roleFile) {
  return `MESH_STANDBY ${run} TO ${name}
You are ${name}, role ${role}, a delegated member of a T3 meshed-agent squad (run ${run}). Your parent thread is the orchestrator.
Do now, and nothing else: read ${roleFile} completely and adopt it for this thread (repo and safety rules still win), and confirm the t3-code MCP tool t3_thread_send is available to you.
No repo exploration, tests, or edits. Do not message anyone yet.
End your turn with exactly: STANDBY ${run} FROM ${name} tools=<ok|missing>
A later turn, MESH_BOOTSTRAP ${run} TO ${name}, will carry your roster and mesh instructions.
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
  const { run, dir } = plan;
  const outbound = pairs.filter((p) => p.sender === member.name);
  const inbound = pairs.filter((p) => p.recipient === member.name);
  const roster = members.map((m) => `| ${m.name} | ${m.role} | ${m.threadId} |`).join('\n');
  const expectations = (list, direction) => list.length ? list.map((p) => {
    const peer = members.find((m) => m.name === p[direction === '→' ? 'recipient' : 'sender']);
    return `- ${p.token} ${direction} ${peer.name} (threadId ${peer.threadId})`;
  }).join('\n') : '- none';
  return `MESH_BOOTSTRAP ${run} TO ${member.name}

## Identity and transport
You are ${member.name}, role ${member.role}, run ${run}, own threadId ${member.threadId}.
You are a delegate_task child thread of the orchestrator; every peer is a separate thread you can address directly.
Messages travel only via t3-code MCP \`t3_thread_send\` (threadId, message, mode "auto", clientRequestId \`${run}-<kind>-<token|name>\`); not Herdr.
Your turn's final text reaches only the orchestrator, as a task notification; it is never protocol evidence. Send every envelope explicitly with t3_thread_send.
Use stable clientRequestIds for retries. Delivery accepted (started/queued/steered) is not proof of receipt.

## Role
Read ${member.roleFile} completely and adopt it for this whole thread; repo and safety rules still win.
Herdr terms map: pane/target = T3 threadId; \`herdr agent prompt\` = \`t3_thread_send\`.

## Roster
| name | role | threadId |
|---|---|---|
${roster}

## Standup boundary
Until MESH_READY ${run}, do only setup and communication checks: no repo exploration, tests, or edits.
Optional protocol evidence may be appended only to ${join(dir, `${member.name}.log`)}.

## Envelopes
MESH_PING ${run} <token> FROM <s> TO <r>
MESH_ACK ${run} <token> FROM <r> TO <s>
BOOT_ACK ${run} FROM ${member.name} TO orchestrator role=${member.role} sha256=<hash> model=${member.model}
PAIR_REPORT ${run} FROM ${member.name} complete=<true|false> acks_received=[t,...] pings_answered=[t,...]
READY_ACK ${run} FROM ${member.name}

## Exact expectations
Outbound PINGs (accept corresponding ACKs FROM the recipient TO ${member.name}):
${expectations(outbound, '→')}
Inbound PINGs (FROM the listed sender TO ${member.name}):
${expectations(inbound, '←')}
Accept a PING or ACK only if run, token, sender AND recipient all match an entry above. Ignore everything else and log it in the optional evidence log.

## Communication rules
Answer valid inbound PINGs any time after bootstrap, even before PAIRS_GO: send the matching ACK directly to the sender's roster threadId, with the same token and FROM/TO swapped.
Send outbound PINGs only after PAIRS_GO ${run} FROM orchestrator TO ${member.name}.
Duplicates are idempotent: re-ACK a duplicate PING; repeated PAIRS_GO resends only PINGs still lacking ACK; repeated MESH_READY resends READY_ACK.
Track tokens exactly. Send PAIR_REPORT complete=true exactly when all outbound ACKs are received AND all inbound PINGs are answered. A member with zero outbound sends it once inbound is complete.
On PAIRS_STATUS? ${run}, send the current PAIR_REPORT to orchestrator (complete=false if incomplete).
Never route peer traffic via the orchestrator. Never poll or sleep: end the turn; incoming messages wake you.

## Do now
1. Load the role file completely.
2. Run shasum -a 256 '${member.roleFile.replaceAll("'", "'\\''")}'.
3. Send BOOT_ACK to the orchestrator's roster threadId using the computed hash and your actual model id (expected ${member.model}).
4. End your turn.

## After READY
On MESH_READY ${run} FROM orchestrator TO ${member.name}, send READY_ACK to orchestrator, then stay idle until a later user-authorized assignment is routed by the orchestrator.
Oracle follows oracle.md ORACLE_QUERY/ACK/RESULT protocol.
Members share one checkout (same project/branch); touch only files you are assigned.
`;
}

function bootstrap(f) {
  const dir = runDir(f['--run']);
  const planned = readJson(join(dir, 'plan.json'));
  const orchestratorId = requireString(f['--orchestrator-thread'], '--orchestrator-thread');
  const ids = new Set([orchestratorId]);
  const members = planned.members.map((member, i) => {
    if (!i) return { ...member, threadId: orchestratorId };
    const { save } = planned.delegateTasks[i - 1];
    let task;
    try { task = readJson(save); } catch { throw new Error(`missing or invalid delegate_task response ${save}`); }
    task = task.structuredContent ?? task;
    const threadId = requireString(task.childThreadId, `childThreadId for ${member.name}`);
    const taskId = requireString(task.taskId, `taskId for ${member.name}`);
    if (ids.has(threadId)) throw new Error(`duplicate threadId ${threadId}`);
    if (task.providerInstanceId !== member.providerInstanceId || task.model !== member.model) throw new Error(`provider/model mismatch for ${member.name}`);
    ids.add(threadId);
    return { ...member, threadId, taskId };
  });
  const pairs = enumeratePairs(planned.run, members);
  writeJson(join(dir, 'roster.json'), members);
  writeJson(join(dir, 'pairs.json'), pairs);
  for (const member of members.slice(1)) writeFileSync(join(dir, `bootstrap-${member.name}.txt`), bootstrapText(planned, member, members, pairs));
  // Retry bootstrap without losing receipts already collected by the executor.
  writeFileSync(join(dir, 'reports.log'), '', { flag: 'a' });
  return {
    dir,
    members: members.slice(1).map(({ name, threadId, taskId }) => {
      const ping = pairs.find((p) => p.sender === 'orchestrator' && p.recipient === name);
      const message = (kind, text) => ({ clientRequestId: `${planned.run}-${kind}-${name}`, message: text });
      return { name, threadId, taskId,
        boot: message('boot', `MESH_BOOTSTRAP ${planned.run} TO ${name} — read ${join(dir, `bootstrap-${name}.txt`)} completely and follow it; do step 'Do now' then end your turn`),
        go: message('go', `PAIRS_GO ${planned.run} FROM orchestrator TO ${name}\nMESH_PING ${planned.run} ${ping.token} FROM orchestrator TO ${name}`),
        ready: message('ready', `MESH_READY ${planned.run} FROM orchestrator TO ${name} — reply READY_ACK, then stay idle until a user-authorized assignment is routed to you.`),
      };
    }),
    orchestrator: { outbound: pairs.filter((p) => p.sender === 'orchestrator').map((p) => p.token), inbound: [] },
  };
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
  const root = mkdtempSync(join(tmpdir(), 't3-mesh-selftest-'));
  const script = fileURLToPath(import.meta.url);
  let checks = 0;
  const cli = (args, expected = 0) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, T3_MESH_ROOT: root } });
    assert.equal(result.status, expected, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    checks++;
    if (expected === 1) { assert.match(result.stderr, /^error: /); assert.equal(result.stdout, ''); return; }
    return JSON.parse(result.stdout);
  };
  try {
    const prompts = join(root, 'prompts');
    mkdirSync(prompts);
    for (const role of ['orchestrator', 'oracle', 'workers']) writeFileSync(join(prompts, `${role}.md`), `Role ${role}\n`);
    const makePlan = (...args) => cli(['plan', '--prompts-dir', prompts, ...args]);
    const defaults = makePlan();
    assert.equal(defaults.delegateTasks.length, 5);
    assert.equal(defaults.delegateTasks[0].args.target.model, 'gpt-6-astra');
    assert.equal(defaults.delegateTasks[0].args.mode, 'async');
    assert.ok(defaults.delegateTasks[1].args.task.includes('workers.md'));
    assert.equal(readJson(join(defaults.dir, 'plan.json')).members[0].model, undefined);
    const noOracle = makePlan('--no-oracle');
    assert.equal(noOracle.delegateTasks.length, 4);
    const maximum = makePlan('--no-oracle', '--workers', '20');
    assert.equal(maximum.delegateTasks.length, 20);
    assert.equal(maximum.delegateTasks.at(-1).args.title, 'ezra (Worker)');
    const mixed = makePlan('--workers', '2', '--worker-model', 'codex:gpt-6.1-sol,claudeAgent:claude-sonnet-5-5');
    assert.equal(mixed.delegateTasks[2].args.target.providerInstanceId, 'claudeAgent');
    const colon = makePlan('--workers', '1', '--worker-model', 'custom:org/model:version');
    assert.equal(colon.delegateTasks[1].args.target.model, 'org/model:version');
    for (const args of [['--workers', '0'], ['--workers', '20'], ['--worker-model', 'bad'], ['--workers', '2', '--worker-model', 'a:b,c:d,e:f'], ['--oracle', 'a:b', '--no-oracle']]) cli(['plan', '--prompts-dir', prompts, ...args], 1);
    const planned = makePlan('--workers', '10');
    const tasks = planned.delegateTasks.map((d, i) => ({ taskId: `node:test:${i}`, childThreadId: `thread:test:${i}`, ...d.args.target, status: 'running' }));
    const saveAll = (list) => { rmSync(planned.delegateTasks[0].save, { force: true }); list.forEach((t, i) => t && writeJson(planned.delegateTasks[i].save, t)); };
    const bootArgs = ['bootstrap', '--run', planned.run, '--orchestrator-thread', 'thread:orchestrator'];
    const invalidTasks = [[undefined, ...tasks.slice(1)], tasks.map((t, i) => i === 1 ? { ...t, childThreadId: tasks[0].childThreadId } : t), tasks.map((t, i) => i === 1 ? { ...t, childThreadId: 'thread:orchestrator' } : t), tasks.map((t, i) => i === 1 ? { ...t, model: 'wrong' } : t), tasks.map((t, i) => i === 1 ? { ...t, taskId: undefined } : t)];
    for (const fixture of invalidTasks) { saveAll(fixture); cli(bootArgs, 1); }
    saveAll(tasks.map((t, i) => i === 0 ? { structuredContent: t } : t));
    const boot = cli(bootArgs);
    assert.equal(boot.members.length, 11);
    assert.equal(boot.members[0].threadId, 'thread:test:0');
    assert.equal(boot.members[0].taskId, 'node:test:0');
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
    for (const required of ['own threadId', 'delegate_task child', 'never protocol evidence', 'clientRequestId', 'not Herdr', '## Role', '## Roster', '## Standup boundary', '## Envelopes', '## Exact expectations', '## Communication rules', '## Do now', '## After READY', 'ORACLE_QUERY/ACK/RESULT', 'AND all inbound', 'Never poll or sleep']) assert.ok(text.includes(required), required);
    return { ok: true, checks };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'plan') result = plan(flags(args, ['--workers', '--worker-model', '--oracle', '--no-oracle', '--prompts-dir']));
  else if (command === 'bootstrap') result = bootstrap(flags(args, ['--run', '--orchestrator-thread']));
  else if (command === 'matrix') {
    result = matrix(flags(args, ['--run']));
    if (result.passed !== result.total || result.errors.length) process.exitCode = 2;
  } else if (command === 'selftest' && !args.length) result = selftest();
  else throw new Error('usage: t3-mesh.mjs plan|bootstrap|matrix|selftest');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
