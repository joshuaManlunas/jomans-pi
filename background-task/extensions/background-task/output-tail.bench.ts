import {
	appendOutputTail,
	type OutputTailMetrics,
} from "./index.ts";

const limit = 64 * 1024;
const iterations = 1_000;
const repeats = 9;

function original(
	previous: Buffer,
	chunk: Buffer,
	limit: number,
	metrics: OutputTailMetrics,
): Buffer {
	const combined = Buffer.concat([previous, chunk]);
	// Buffer.concat allocates a combined payload and copies both inputs before a
	// possible subarray view narrows the retained result.
	metrics.allocatedBytes += combined.length;
	metrics.copiedBytes += previous.length + chunk.length;
	return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
}

function bounded(
	previous: Buffer,
	chunk: Buffer,
	limit: number,
	metrics: OutputTailMetrics,
): Buffer {
	return appendOutputTail(previous, chunk, limit, metrics);
}

console.log(JSON.stringify({
	runtime: process.version,
	bun: Bun.version,
	platform: process.platform,
	arch: process.arch,
	limit,
	iterations,
	repeats,
	measurement: "algorithmic Buffer payload bytes; allocator metadata and RSS excluded",
}));
for (const bytes of [1024, limit, 1024 * 1024]) {
	const chunk = Buffer.alloc(bytes, 97);
	for (const [name, append] of [["original", original], ["bounded", bounded]] as const) {
		let tail = Buffer.alloc(0);
		const warmupMetrics: OutputTailMetrics = { allocatedBytes: 0, copiedBytes: 0 };
		for (let i = 0; i < 100; i++) tail = append(tail, chunk, limit, warmupMetrics);
		const samples: Array<{
			durationMs: number;
			metrics: OutputTailMetrics;
			retainedBackingBytes: number;
		}> = [];
		for (let repeat = 0; repeat < repeats; repeat++) {
			const metrics: OutputTailMetrics = { allocatedBytes: 0, copiedBytes: 0 };
			const start = performance.now();
			for (let i = 0; i < iterations; i++)
				tail = append(tail, chunk, limit, metrics);
			samples.push({
				durationMs: performance.now() - start,
				metrics,
				retainedBackingBytes: tail.buffer.byteLength,
			});
		}
		samples.sort((a, b) => a.durationMs - b.durationMs);
		const median = samples[Math.floor(samples.length / 2)]!;
		const max = samples[samples.length - 1]!;
		console.log(JSON.stringify({
			name,
			bytes,
			iterations,
			medianMs: median.durationMs,
			maxMs: max.durationMs,
			medianAllocatedPayloadBytes: median.metrics.allocatedBytes,
			medianCopiedPayloadBytes: median.metrics.copiedBytes,
			allocatedPayloadBytesPerAppend: median.metrics.allocatedBytes / iterations,
			copiedPayloadBytesPerAppend: median.metrics.copiedBytes / iterations,
			retainedBackingBytes: median.retainedBackingBytes,
		}));
	}
}
