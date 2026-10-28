export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function abortError(signal: AbortSignal, fallback: string): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

/** Rejects as soon as `signal` aborts; the underlying promise keeps running but is ignored. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal, "Aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal, "Aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}
