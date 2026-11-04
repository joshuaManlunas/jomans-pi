#!/usr/bin/env node
// Installs mesh-aware Herdr mods so people can tell squad members apart.
//
// Herdr's shipped pane header shows only the program ("Codex", "Claude Code") and its folder, and the
// Agents list labels every agent in a tab with the tab's lead title. Neither reads hc names or the
// mesh.name / mesh.role labels this skill sets. This script:
//   1. clones the shipped `pane` and `agents` mods (herdr-app mod.clone) as `mesh-pane` / `mesh-agents`,
//   2. applies small anchored patches that show "<mesh.name> · <mesh.role>" when those labels exist
//      and nest live squad members under their orchestrator in the Agents list,
//   3. runs `herdr-app check` on each clone,
//   4. points the shown layout's pane header and Agents block at the clones. It only edits a
//      layout the person owns (a clone or their own file); shipped layouts are read-only, and it
//      refuses those with the exact clone command.
//
// Idempotent: current clones are left alone; v1 clones are replaced. Never touches shipped mods or layouts.
// Usage: node install.mjs [--check] [--uninstall] [--layout <name>]
// Exit codes: 0 ok / installed, 1 not installed (--check), 2 error.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MARKER = "mesh-names v2";
const LEGACY_MARKER = "mesh-names v1";
const HOME = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const SHIPPED_LAYOUTS = new Set(["main", "terminals", "win98"]);

const MESH_TAG = (sep) => `// ${MARKER}: herdr-meshed-agents roster names from the mesh.name / mesh.role terminal labels.
function meshTag(address) {
  const l = address ? terminals().find((t) => t.address === address)?.labels : null;
  const n = l?.["mesh.name"];
  if (!n) return null;
  const r = l["mesh.role"];
  return r && r !== n ? \`\${n}${sep}\${r}\` : n;
}

`;

export const MODS = [
	{
		from: "pane",
		as: "mesh-pane",
		title: "Pane header (mesh names)",
		patches: [
			{
				anchor: `import { panes, props, run, theme, home } from "herdr";`,
				replace: `import { panes, props, run, theme, home, terminals } from "herdr";`,
			},
			{ anchor: "export default class Pane extends View {", replace: `${MESH_TAG(" · ")}export default class Pane extends View {` },
			{
				anchor: `    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";`,
				replace: `    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const tag = meshTag(p.terminal);`,
			},
			{
				anchor: `      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))`,
				replace: `      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .when(Boolean(tag), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.accent + "26").text_size(11).font_semibold().text_color(t.accent).child(tag)))`,
			},
		],
	},
	{
		from: "agents",
		as: "mesh-agents",
		title: "Agents (mesh names)",
		patches: [
			{ anchor: "const clean = (s) =>", replace: `${MESH_TAG(" · ")}const clean = (s) =>` },
			{
				anchor: `    const kids = all.filter((k) => k.parent === addr && k.state === "live");`,
				replace: `    const kids = all.filter((k) => (k.parent === addr || k.labels?.["mesh.parent"] === addr) && k.state === "live");`,
			},
			{
				anchor: `      .on_click(() => this.peek(k.address))`,
				replace: `      .on_click(() => panes().some((p) => p.terminal === k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address))`,
			},
			{
				anchor: `.child(k.name || k.template || k.program?.name || k.address)`,
				replace: `.child(meshTag(k.address) || k.name || k.template || k.program?.name || k.address)`,
			},
			{
				anchor: `    const byPriority = sort.id === "priority";`,
				replace: `    const listedAddresses = new Set(list.map((a) => a.address));
    const childAddresses = new Set(all.filter((k) => k.state === "live" && (listedAddresses.has(k.parent) || listedAddresses.has(k.labels?.["mesh.parent"]))).map((k) => k.address));
    list = list.filter((a) => !childAddresses.has(a.address));
    const byPriority = sort.id === "priority";`,
			},
			{
				anchor: `    setAgentOrder(list.map((a) => a.address));`,
				replace: `    setAgentOrder(list.flatMap((a) => [a.address, ...this.tree(all, a.address).map((s) => s.t.address)]));`,
			},
			{
				anchor: `    const label = (a) => {\n`,
				replace: `    const label = (a) => {\n      const mesh = meshTag(a.address);\n      if (mesh) return mesh;\n`,
			},
		],
	},
];

const herdr = (...args) => execFileSync("herdr-app", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const modDir = (name) => join(HOME, "mods", name);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Apply anchored patches; every anchor must occur exactly once, or nothing is written. */
export function applyPatches(source, patches) {
	let out = source;
	for (const { anchor, replace } of patches) {
		const count = out.split(anchor).length - 1;
		if (count !== 1) throw new Error(`Patch anchor found ${count} times (expected 1): ${JSON.stringify(anchor.slice(0, 80))}`);
		out = out.replace(anchor, () => replace);
	}
	return out;
}

function modState(spec) {
	const main = join(modDir(spec.as), "main.js");
	if (!existsSync(main)) return "missing";
	const source = readFileSync(main, "utf8");
	return source.includes(MARKER) ? "installed" : source.includes(LEGACY_MARKER) ? "outdated" : "foreign";
}

function installMod(spec) {
	const state = modState(spec);
	if (state === "installed") return `${spec.as}: already installed`;
	if (state === "foreign") throw new Error(`mods/${spec.as} exists but was not made by this installer (no "${MARKER}" marker); not touching it.`);
	if (state === "outdated") rmSync(modDir(spec.as), { recursive: true, force: true });
	herdr("do", "mod.clone", JSON.stringify({ name: spec.from, as: spec.as }));
	const dir = modDir(spec.as);
	try {
		const main = join(dir, "main.js");
		writeFileSync(main, applyPatches(readFileSync(main, "utf8"), spec.patches));
		const metaPath = join(dir, "mod.json");
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		writeFileSync(metaPath, `${JSON.stringify({ ...meta, title: spec.title }, null, 2)}\n`);
		herdr("check", dir);
	} catch (error) {
		rmSync(dir, { recursive: true, force: true }); // never leave a half-patched clone behind
		throw new Error(`${spec.as}: ${error.stderr?.toString().trim() || error.message}`);
	}
	return `${spec.as}: cloned from ${spec.from}, patched, check passed`;
}

/** Rewrite content.mod values in a layout tree; returns the number of changes. */
export function retarget(node, mapping) {
	let changes = 0;
	const walk = (v) => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		if (v.content && typeof v.content === "object" && Object.hasOwn(mapping, v.content.mod)) {
			v.content.mod = mapping[v.content.mod];
			changes++;
		}
		for (const k of Object.keys(v)) walk(v[k]);
	};
	walk(node);
	return changes;
}

function shownLayout() {
	return JSON.parse(herdr("status")).layout;
}

function updateLayout(name, mapping) {
	const file = join(HOME, "layouts", `${name}.json`);
	if (!existsSync(file)) throw new Error(`Layout file not found: ${file}`);
	const raw = readFileSync(file, "utf8");
	const tree = JSON.parse(raw);
	if (SHIPPED_LAYOUTS.has(name) && !tree.cloned_from)
		throw new Error(
			`Layout "${name}" is shipped by Herdr and read-only. Clone it first (this switches to the clone), then rerun: ` +
				`herdr-app do layout.clone '${JSON.stringify({ name, as: `${name}-mesh` })}'`,
		);
	const changes = retarget(tree, mapping);
	if (!changes) return `layout ${name}: already points at ${Object.values(mapping).join(", ")} (no change)`;
	const backup = `${file}.pre-mesh-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	copyFileSync(file, backup);
	const indent = /^\{\n(\s+)/.exec(raw)?.[1] ?? 2;
	writeFileSync(file, `${JSON.stringify(tree, null, indent)}\n`);
	pause(1500); // the app applies layout edits within a second and writes <name>.error when invalid
	const errorFile = join(HOME, "layouts", `${name}.error`);
	if (existsSync(errorFile)) {
		copyFileSync(backup, file);
		throw new Error(`layout ${name} rejected (restored from backup): ${readFileSync(errorFile, "utf8").trim()}`);
	}
	return `layout ${name}: ${changes} block(s) now use ${Object.values(mapping).join(", ")} (backup: ${backup})`;
}

function main(argv) {
	const args = [...argv];
	const flag = (f) => {
		const i = args.indexOf(f);
		return i === -1 ? false : (args.splice(i, 1), true);
	};
	const value = (f) => {
		const i = args.indexOf(f);
		if (i === -1) return undefined;
		const v = args[i + 1];
		if (!v || v.startsWith("--")) throw new Error(`Missing value for ${f}.`);
		args.splice(i, 2);
		return v;
	};
	const check = flag("--check");
	const uninstall = flag("--uninstall");
	const layoutName = value("--layout") ?? shownLayout();
	if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}. Usage: install.mjs [--check] [--uninstall] [--layout <name>]`);

	if (check) {
		const mods = MODS.map((m) => `${m.as}=${modState(m)}`);
		const tree = JSON.parse(readFileSync(join(HOME, "layouts", `${layoutName}.json`), "utf8"));
		const pending = retarget(structuredClone(tree), Object.fromEntries(MODS.map((m) => [m.from, m.as])));
		const ok = MODS.every((m) => modState(m) === "installed") && pending === 0;
		console.log(JSON.stringify({ installed: ok, mods, layout: layoutName, layoutBlocksToRetarget: pending }));
		return ok ? 0 : 1;
	}
	if (uninstall) {
		console.log(updateLayout(layoutName, Object.fromEntries(MODS.map((m) => [m.as, m.from]))));
		console.log(`Clones left in place: ${MODS.map((m) => `mods/${m.as}`).join(", ")} (delete them by hand if wanted).`);
		return 0;
	}
	// Validate every shipped-source anchor before cloning or replacing any installed mod.
	for (const spec of MODS) applyPatches(readFileSync(join(modDir(spec.from), "main.js"), "utf8"), spec.patches);
	for (const spec of MODS) console.log(installMod(spec));
	console.log(updateLayout(layoutName, Object.fromEntries(MODS.map((m) => [m.from, m.as]))));
	return 0;
}

const isMain = () => {
	try {
		return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
};

if (isMain()) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 2;
	}
}
