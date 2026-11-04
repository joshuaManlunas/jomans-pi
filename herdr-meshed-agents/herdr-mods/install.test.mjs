// Run: node --test herdr-mods/install.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatches, retarget, MODS, MARKER } from "./install.mjs";

function shippedSource(t, spec) {
	const file = join(homedir(), ".config", "herdr-app", "mods", spec.from, "main.js");
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		t.skip(`Shipped Herdr mod is absent: ${file}`);
	}
}

for (const spec of MODS) {
	test(`${spec.from}: every patch anchor occurs exactly once in the shipped source`, (t) => {
		const source = shippedSource(t, spec);
		if (source === undefined) return;
		for (const { anchor } of spec.patches) {
			assert.equal(source.split(anchor).length - 1, 1, `${spec.from}: ${JSON.stringify(anchor)}`);
		}
	});

	test(`${spec.from}: patched source carries the marker and parses as an ES module`, (t) => {
		const source = shippedSource(t, spec);
		if (source === undefined) return;
		const patched = applyPatches(source, spec.patches);
		assert.ok(patched.includes(MARKER), `${spec.from}: missing ${MARKER}`);
		const dir = mkdtempSync(join(tmpdir(), "herdr-mod-patch-"));
		try {
			const file = join(dir, `${spec.as}.mjs`);
			writeFileSync(file, patched);
			const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr || result.stdout);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

for (const [name, source, count] of [["missing", "first\nabsent", 0], ["duplicated", "first\nsecond\nsecond", 2]]) {
	test(`applyPatches: a ${name} anchor throws without changing the input or patches`, () => {
		const patches = [{ anchor: "first", replace: "changed" }, { anchor: "second", replace: "last" }];
		const original = { source, patches: structuredClone(patches) };
		assert.throws(() => applyPatches(source, patches), new RegExp(`Patch anchor found ${count} times`));
		assert.equal(source, original.source);
		assert.deepEqual(patches, original.patches);
	});
}

test("retarget: nested blocks and pane headers map and reverse without touching other mods", () => {
	const mapping = Object.fromEntries(MODS.map(({ from, as }) => [from, as]));
	const layout = {
		type: "row",
		children: [
			{ type: "column", children: MODS.map(({ from }) => ({ type: "block", content: { mod: from } })) },
			{ content: { tab: "active", pane: { header: { content: { mod: "pane" } } } } },
			{ content: { mod: "unrelated" }, mod: "agents", title: "pane" },
		],
	};
	const original = structuredClone(layout);
	assert.equal(retarget(layout, mapping), MODS.length + 1);
	assert.deepEqual(layout.children[0].children.map((block) => block.content.mod), MODS.map(({ as }) => as));
	assert.equal(layout.children[1].content.pane.header.content.mod, mapping.pane);
	assert.deepEqual(layout.children[2], original.children[2]);
	assert.equal(retarget(layout, mapping), 0);
	const reverse = Object.fromEntries(MODS.map(({ from, as }) => [as, from]));
	assert.equal(retarget(layout, reverse), MODS.length + 1);
	assert.deepEqual(layout, original);
});

for (const [from, pattern] of [["agents", /["']mesh\.parent["']/], ["pane", /\bmeshTag\s*\(/]]) {
	test(`${from}: patched source preserves the required mesh integration`, (t) => {
		const spec = MODS.find((mod) => mod.from === from);
		assert.ok(spec, `Missing ${from} patch specification`);
		const source = shippedSource(t, spec);
		if (source === undefined) return;
		assert.match(applyPatches(source, spec.patches), pattern);
	});
}
