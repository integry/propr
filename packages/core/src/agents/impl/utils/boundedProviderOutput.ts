export const MAX_PROVIDER_OUTPUT_BYTES = 1024 * 1024;

/**
 * Keeps a provider's first record plus its newest complete records (and the
 * record still being written) within `maximumBytes`.
 *
 * Every size is tracked incrementally: dropping the oldest record or growing
 * the partial one never re-measures the retained output. A provider streaming
 * many short records at the cap previously cost a full rebuild and UTF-8 scan
 * of the ~1 MiB output per dropped record, which blocked the event loop for
 * minutes.
 */
export class BoundedProviderRecordBuffer {
    private pinned = '';
    private pinnedBytes = 0;
    private records: string[] = [];
    private recordBytes: number[] = [];
    private head = 0;
    private completeBytes = 0;
    private partial = '';
    private partialBytes = 0;
    private droppingOversizedRecord = false;
    private sawFirstRecord = false;
    private cachedOutput: string | null = '';

    constructor(private readonly maximumBytes = MAX_PROVIDER_OUTPUT_BYTES) {}

    /** Adds provider output; read `output` only when the retained text is needed. */
    append(chunk: string): void {
        let remaining = chunk;
        while (remaining) {
            const boundary = remaining.indexOf('\n');
            if (this.droppingOversizedRecord) {
                if (boundary < 0) return;
                this.droppingOversizedRecord = false;
                remaining = remaining.slice(boundary + 1);
                continue;
            }
            if (boundary < 0) {
                const addedBytes = Buffer.byteLength(remaining);
                this.cachedOutput = null;
                if (this.partialBytes + addedBytes > this.maximumBytes) {
                    this.partial = '';
                    this.partialBytes = 0;
                    this.droppingOversizedRecord = true;
                } else {
                    this.partial += remaining;
                    this.partialBytes += addedBytes;
                    this.trimComplete();
                }
                return;
            }
            const tail = remaining.slice(0, boundary + 1);
            const record = `${this.partial}${tail}`;
            const recordBytes = this.partialBytes + Buffer.byteLength(tail);
            this.partial = '';
            this.partialBytes = 0;
            this.cachedOutput = null;
            if (recordBytes <= this.maximumBytes) {
                if (!this.sawFirstRecord) {
                    this.pinned = record;
                    this.pinnedBytes = recordBytes;
                } else {
                    this.records.push(record);
                    this.recordBytes.push(recordBytes);
                    this.completeBytes += recordBytes;
                }
                this.trimComplete();
            }
            this.sawFirstRecord = true;
            remaining = remaining.slice(boundary + 1);
        }
    }

    get output(): string {
        if (this.cachedOutput === null) {
            this.compact();
            this.cachedOutput = this.pinned + this.records.join('') + this.partial;
        }
        return this.cachedOutput;
    }

    private get totalBytes(): number {
        return this.pinnedBytes + this.completeBytes + this.partialBytes;
    }

    private trimComplete(): void {
        while (this.totalBytes > this.maximumBytes) {
            if (this.head >= this.records.length) {
                this.clearRecords();
                if (this.totalBytes > this.maximumBytes) {
                    this.partial = '';
                    this.partialBytes = 0;
                }
                return;
            }
            this.completeBytes -= this.recordBytes[this.head];
            // Release text immediately, even if live records delay compaction.
            this.records[this.head] = '';
            this.recordBytes[this.head] = 0;
            this.head += 1;
        }
        // Bound backing arrays even when output is never read. Copy only when
        // at least half the queue was consumed, amortizing over dropped records.
        if (this.head * 2 >= this.records.length) this.compact();
    }

    private clearRecords(): void {
        this.records = [];
        this.recordBytes = [];
        this.head = 0;
        this.completeBytes = 0;
    }

    /** Drops the records already trimmed from the front of the queue. */
    private compact(): void {
        if (this.head === 0) return;
        this.records = this.records.slice(this.head);
        this.recordBytes = this.recordBytes.slice(this.head);
        this.head = 0;
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

/**
 * Accumulates a byte-bounded diagnostic tail without re-encoding the whole
 * retained text for every chunk: bytes are counted incrementally, and once past
 * the cap the tail is cut to three quarters of it, so each trim pays for at
 * least a quarter of the cap of new output. `value` is the newest output: at
 * most `maximumBytes`, and at least three quarters of that once it overflowed.
 */
export class BoundedDiagnosticTail {
    private text = '';
    private bytes = 0;

    constructor(private readonly maximumBytes = MAX_PROVIDER_OUTPUT_BYTES) {}

    append(chunk: string): void {
        if (!chunk) return;
        this.text += chunk;
        this.bytes += Buffer.byteLength(chunk);
        if (this.bytes <= this.maximumBytes) return;
        this.text = boundedProviderDiagnostic(this.text, Math.floor(this.maximumBytes * 3 / 4));
        this.bytes = Buffer.byteLength(this.text);
    }

    get value(): string {
        return this.bytes <= this.maximumBytes ? this.text : boundedProviderDiagnostic(this.text, this.maximumBytes);
    }
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
