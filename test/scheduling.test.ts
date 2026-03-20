import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
    parseResetTimeFromMessage,
    calculateNextRoundHourPlus2Minutes,
    formatRetryTime,
    hoursUntil
} from '../packages/core/src/utils/scheduling.js';

describe('scheduling utilities', () => {
    describe('parseResetTimeFromMessage', () => {
        it('should parse "resets 1am (UTC)" format', () => {
            const result = parseResetTimeFromMessage('Limit reached · resets 1am (UTC) · /upgrade to Max 20x or add funds');
            assert.ok(result !== null, 'Should return a timestamp');
            const date = new Date(result * 1000);
            assert.strictEqual(date.getUTCHours(), 1);
            assert.strictEqual(date.getUTCMinutes(), 0);
        });

        it('should parse "resets 12pm (UTC)" format (noon)', () => {
            const result = parseResetTimeFromMessage('resets 12pm (UTC)');
            assert.ok(result !== null, 'Should return a timestamp');
            const date = new Date(result * 1000);
            assert.strictEqual(date.getUTCHours(), 12);
            assert.strictEqual(date.getUTCMinutes(), 0);
        });

        it('should parse "resets 12am (UTC)" format (midnight)', () => {
            const result = parseResetTimeFromMessage('resets 12am (UTC)');
            assert.ok(result !== null, 'Should return a timestamp');
            const date = new Date(result * 1000);
            assert.strictEqual(date.getUTCHours(), 0);
            assert.strictEqual(date.getUTCMinutes(), 0);
        });

        it('should parse "resets 3:30pm (UTC)" format with minutes', () => {
            const result = parseResetTimeFromMessage('resets 3:30pm (UTC)');
            assert.ok(result !== null, 'Should return a timestamp');
            const date = new Date(result * 1000);
            assert.strictEqual(date.getUTCHours(), 15);
            assert.strictEqual(date.getUTCMinutes(), 30);
        });

        it('should return null for unparseable message', () => {
            const result = parseResetTimeFromMessage('unknown message format');
            assert.strictEqual(result, null);
        });

        it('should return null for empty message', () => {
            const result = parseResetTimeFromMessage('');
            assert.strictEqual(result, null);
        });

        it('should handle case insensitivity', () => {
            const result = parseResetTimeFromMessage('RESETS 5AM (UTC)');
            assert.ok(result !== null, 'Should return a timestamp');
            const date = new Date(result * 1000);
            assert.strictEqual(date.getUTCHours(), 5);
        });

        it('should return future time (tomorrow if past)', () => {
            // This test verifies the reset time is always in the future
            const result = parseResetTimeFromMessage('resets 1am (UTC)');
            assert.ok(result !== null, 'Should return a timestamp');
            const resultMs = result * 1000;
            const nowMs = Date.now();
            assert.ok(resultMs > nowMs, 'Result should be in the future');
        });
    });

    describe('calculateNextRoundHourPlus2Minutes', () => {
        it('should return a timestamp with minutes = 2', () => {
            const result = calculateNextRoundHourPlus2Minutes();
            const date = new Date(result * 1000);
            assert.strictEqual(date.getUTCMinutes(), 2);
            assert.strictEqual(date.getUTCSeconds(), 0);
        });

        it('should return a time in the future', () => {
            const result = calculateNextRoundHourPlus2Minutes();
            const resultMs = result * 1000;
            const nowMs = Date.now();
            assert.ok(resultMs > nowMs, 'Result should be in the future');
        });
    });

    describe('formatRetryTime', () => {
        it('should format timestamp as readable time', () => {
            // Create a specific timestamp: 2024-01-15 01:02:00 UTC
            const date = new Date(Date.UTC(2024, 0, 15, 1, 2, 0));
            const timestamp = Math.floor(date.getTime() / 1000);
            const result = formatRetryTime(timestamp);
            assert.ok(result.includes('1:02'), `Expected "1:02" in "${result}"`);
            assert.ok(result.includes('AM'), `Expected "AM" in "${result}"`);
            assert.ok(result.includes('UTC'), `Expected "UTC" in "${result}"`);
        });

        it('should handle PM times', () => {
            const date = new Date(Date.UTC(2024, 0, 15, 14, 30, 0));
            const timestamp = Math.floor(date.getTime() / 1000);
            const result = formatRetryTime(timestamp);
            assert.ok(result.includes('2:30'), `Expected "2:30" in "${result}"`);
            assert.ok(result.includes('PM'), `Expected "PM" in "${result}"`);
        });
    });

    describe('hoursUntil', () => {
        it('should return positive hours for future timestamp', () => {
            const futureTimestamp = Math.floor(Date.now() / 1000) + 3600 * 2; // 2 hours from now
            const result = hoursUntil(futureTimestamp);
            assert.ok(result > 1.9 && result < 2.1, `Expected ~2 hours, got ${result}`);
        });

        it('should return 0 for past timestamp', () => {
            const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
            const result = hoursUntil(pastTimestamp);
            assert.strictEqual(result, 0);
        });

        it('should handle fractional hours', () => {
            const futureTimestamp = Math.floor(Date.now() / 1000) + 1800; // 30 minutes from now
            const result = hoursUntil(futureTimestamp);
            assert.ok(result > 0.4 && result < 0.6, `Expected ~0.5 hours, got ${result}`);
        });
    });
});
