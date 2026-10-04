import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BoundedDiagnosticTail,
    BoundedProviderRecordBuffer,
    boundedProviderDiagnostic,
} from '../packages/core/src/agents/impl/utils/boundedProviderOutput.js';

/** The previous implementation, kept verbatim as the behavioural reference. */
class ReferenceRecordBuffer {
    private pinned = '';
    private complete = '';
    private partial = '';
    private droppingOversizedRecord = false;
    private sawFirstRecord = false;

    constructor(private readonly maximumBytes: number) {}

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


/** Small deterministic PRNG so failures reproduce. */
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

const PIECES = ['{"type":"assistant"}', 'plain text', 'é', '日本語', '🙂', '', 'x'.repeat(40), 'y'.repeat(300)];

describe('BoundedProviderRecordBuffer', () => {
    test('retains exactly what the previous implementation retained, chunk by chunk', () => {
        for (let seed = 1; seed <= 60; seed += 1) {
            const next = random(seed);
            const maximumBytes = [64, 200, 1000, 4096][seed % 4];
            const reference = new ReferenceRecordBuffer(maximumBytes);
            const buffer = new BoundedProviderRecordBuffer(maximumBytes);
            const deferredBuffer = new BoundedProviderRecordBuffer(maximumBytes);
            for (let step = 0; step < 400; step += 1) {
                let chunk = '';
                const parts = 1 + Math.floor(next() * 6);
                for (let part = 0; part < parts; part += 1) {
                    chunk += PIECES[Math.floor(next() * PIECES.length)];
                    if (next() < 0.5) chunk += '\n';
                }
                const expected = reference.append(chunk);
                buffer.append(chunk);
                deferredBuffer.append(chunk);
                assert.equal(buffer.output, expected, `seed ${seed}, step ${step}`);
            }
            assert.equal(deferredBuffer.output, reference.output, `deferred read, seed ${seed}`);
        }
    });

    for (const [name, chunks] of [
        ['complete records', ['a\nb\nc\nd\n']],
        ['partial records', ['a\nb\nc\nd', 'é', '🙂', '\n']],
        ['mixed record sizes', [`${'é'.repeat(80)}\n`, '\n'.repeat(80), '🙂'.repeat(30), '\n']],
    ] as const) {
        test(`bounds backing storage while appending ${name} without reading output`, () => {
            const maximumBytes = 256;
            const buffer = new BoundedProviderRecordBuffer(maximumBytes);
            const reference = new ReferenceRecordBuffer(maximumBytes);
            buffer.append('first\n');
            reference.append('first\n');
            // Over a hundred caps of output, matching callers that read only on exit.
            for (let step = 0; step < 4096; step += 1) {
                for (const chunk of chunks) {
                    buffer.append(chunk);
                    reference.append(chunk);
                    // Inspect storage directly: the output getter itself compacts it.
                    assert.ok(buffer['records'].length <= 2 * maximumBytes, 'record slots stay bounded');
                    assert.ok(buffer['recordBytes'].length <= 2 * maximumBytes, 'size slots stay bounded');
                    const storedBytes = buffer['records'].reduce((sum, record) => sum + Buffer.byteLength(record), 0);
                    assert.ok(storedBytes <= maximumBytes, 'discarded record text is released');
                }
            }
            assert.equal(buffer.output, reference.output);
        });
    }

    test('stays linear when a provider streams many short records at the cap', () => {
        const buffer = new BoundedProviderRecordBuffer(1024 * 1024);
        const record = `${JSON.stringify({ type: 'stream_event', delta: 'ok' })}\n`;
        const chunk = record.repeat(Math.floor(1024 / record.length));
        const started = performance.now();
        // About 8 MiB of 40-byte records in 1 KiB chunks: every chunk is past the cap.
        for (let index = 0; index < 8 * 1024; index += 1) buffer.append(chunk);
        const elapsed = performance.now() - started;
        assert.ok(Buffer.byteLength(buffer.output) <= 1024 * 1024);
        assert.ok(buffer.output.endsWith(record));
        // The previous implementation took minutes for this input.
        assert.ok(elapsed < 3000, `appending took ${Math.round(elapsed)}ms`);
    });
});

describe('BoundedDiagnosticTail', () => {
    test('keeps the newest output within the cap and never less than three quarters of it', () => {
        const maximumBytes = 1000;
        const tail = new BoundedDiagnosticTail(maximumBytes);
        let all = '';
        const next = random(7);
        for (let step = 0; step < 2000; step += 1) {
            const chunk = PIECES[Math.floor(next() * PIECES.length)] + (next() < 0.3 ? '\n' : '');
            tail.append(chunk);
            all += chunk;
            const value = tail.value;
            assert.ok(Buffer.byteLength(value) <= maximumBytes);
            assert.ok(all.endsWith(value), 'the tail is always the newest output');
            if (Buffer.byteLength(all) > maximumBytes) assert.ok(Buffer.byteLength(value) >= maximumBytes * 3 / 4 - 4);
        }
        assert.equal(tail.value, boundedProviderDiagnostic(tail.value, maximumBytes));
    });

    test('stays linear for chatty stderr', () => {
        const tail = new BoundedDiagnosticTail(1024 * 1024);
        const started = performance.now();
        for (let index = 0; index < 50_000; index += 1) tail.append('warning: something happened\n');
        assert.ok(performance.now() - started < 3000);
        assert.ok(Buffer.byteLength(tail.value) <= 1024 * 1024);
    });
});
