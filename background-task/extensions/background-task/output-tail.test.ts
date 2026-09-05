import { expect, test } from "bun:test";
import { appendOutputTail } from "./index.ts";

test("output tails preserve exactly the last bounded bytes and own their storage", () => {
	for (const limit of [0, 1, 5, 128]) {
		for (const size of [0, 1, limit, limit + 1, 1_048_576]) {
			const previous = Buffer.from("previous😀");
			const chunk = Buffer.alloc(size, 97);
			const combined = Buffer.concat([previous, chunk]);
			const tail = appendOutputTail(previous, chunk, limit);
			expect(tail).toEqual(combined.subarray(Math.max(0, combined.length - limit)));
			expect(tail.buffer.byteLength).toBeLessThanOrEqual(limit);
			chunk.fill(98);
			expect(tail).toEqual(combined.subarray(Math.max(0, combined.length - limit)));
		}
	}
});
