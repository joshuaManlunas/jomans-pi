import { appendOutputTail } from "./index.ts";

const limit = 64 * 1024;
function original(previous: Buffer, chunk: Buffer): Buffer {
	const combined = Buffer.concat([previous, chunk]);
	return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
}

console.log(JSON.stringify({ runtime: process.version, bun: Bun.version, platform: process.platform, arch: process.arch, limit }));
for (const bytes of [1024, limit, 1024 * 1024]) {
	const chunk = Buffer.alloc(bytes, 97);
	for (const [name, append] of [["original", original], ["bounded", appendOutputTail]] as const) {
		let tail = Buffer.alloc(0);
		for (let i = 0; i < 100; i++) tail = append(tail, chunk, limit);
		const samples: number[] = [];
		for (let repeat = 0; repeat < 9; repeat++) {
			const start = performance.now();
			for (let i = 0; i < 1000; i++) tail = append(tail, chunk, limit);
			samples.push(performance.now() - start);
		}
		samples.sort((a, b) => a - b);
		console.log(JSON.stringify({ name, bytes, iterations: 1000, medianMs: samples[4], maxMs: samples[8], retainedBackingBytes: tail.buffer.byteLength }));
	}
}
