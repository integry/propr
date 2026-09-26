export const MAX_PROVIDER_OUTPUT_BYTES = 1024 * 1024;

export class BoundedProviderRecordBuffer {
    private pinned = '';
    private complete = '';
    private partial = '';
    private droppingOversizedRecord = false;
    private sawFirstRecord = false;

    constructor(private readonly maximumBytes = MAX_PROVIDER_OUTPUT_BYTES) {}

    append(chunk: string): string {
        let remaining = chunk;
        while (remaining) {
            const boundary = remaining.indexOf('\n');
            if (this.droppingOversizedRecord) {
                if (boundary < 0) return this.output;
                this.droppingOversizedRecord = false;
                remaining = remaining.slice(boundary + 1);
                continue;
            }
            if (boundary < 0) {
                const partial = this.partial + remaining;
                if (Buffer.byteLength(partial) > this.maximumBytes) {
                    this.partial = '';
                    this.droppingOversizedRecord = true;
                } else {
                    this.partial = partial;
                    this.trimComplete();
                }
                return this.output;
            }
            const record = `${this.partial}${remaining.slice(0, boundary + 1)}`;
            this.partial = '';
            if (Buffer.byteLength(record) <= this.maximumBytes) {
                if (!this.sawFirstRecord) this.pinned = record;
                else this.complete += record;
                this.trimComplete();
            }
            this.sawFirstRecord = true;
            remaining = remaining.slice(boundary + 1);
        }
        return this.output;
    }

    get output(): string {
        return this.pinned + this.complete + this.partial;
    }

    private trimComplete(): void {
        while (Buffer.byteLength(this.output) > this.maximumBytes) {
            const boundary = this.complete.indexOf('\n');
            if (boundary < 0) {
                this.complete = '';
                if (Buffer.byteLength(this.output) > this.maximumBytes) this.partial = '';
                return;
            }
            this.complete = this.complete.slice(boundary + 1);
        }
    }
}

/** Keep the newest complete provider records without splitting UTF-8 characters. */
export function boundedProviderOutput(
    value: string,
    maximumBytes = MAX_PROVIDER_OUTPUT_BYTES,
): string {
    if (maximumBytes <= 0 || !value) return '';
    const encoded = Buffer.from(value);
    if (encoded.byteLength <= maximumBytes) return value;

    // Provider streams are JSONL (or line-oriented plain text). Starting after
    // the first newline rejects an individual oversized record and guarantees
    // that retained JSONL never begins in the middle of a record or code point.
    const tail = encoded.subarray(encoded.byteLength - maximumBytes).toString('utf8');
    const boundary = tail.indexOf('\n');
    return boundary < 0 ? '' : tail.slice(boundary + 1);
}

/** Keep a byte-bounded diagnostic tail when record boundaries are irrelevant. */
export function boundedProviderDiagnostic(
    value: string,
    maximumBytes = MAX_PROVIDER_OUTPUT_BYTES,
): string {
    if (maximumBytes <= 0 || !value) return '';
    const encoded = Buffer.from(value);
    if (encoded.byteLength <= maximumBytes) return value;
    let tail = encoded.subarray(encoded.byteLength - maximumBytes).toString('utf8');
    while (Buffer.byteLength(tail) > maximumBytes || tail.startsWith('\uFFFD')) tail = tail.slice(1);
    return tail;
}

/** Read at most one bounded tail from a provider transcript on disk. */
export async function readBoundedProviderOutputFile(filePath: string): Promise<string> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const stats = await handle.stat();
        const start = Math.max(0, stats.size - MAX_PROVIDER_OUTPUT_BYTES);
        const buffer = Buffer.alloc(stats.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        let output = buffer.toString('utf8');
        if (start > 0) {
            const boundary = output.indexOf('\n');
            output = boundary < 0 ? '' : output.slice(boundary + 1);
        }
        return boundedProviderOutput(output);
    } finally {
        await handle.close();
    }
}
import fs from 'node:fs';
