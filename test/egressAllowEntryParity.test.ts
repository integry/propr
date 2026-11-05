import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEgressAllowEntry } from '../packages/core/src/network/egressAllowlist.ts';
import { egressAllowEntryError } from '../propr-ui/src/pages/SettingsPage/egressAllowEntry.ts';

// The settings UI checks allowlist entries before committing them; it must accept exactly what the API accepts.
const entries = [
    'registry.npmjs.org', '*.example.com', 'example.com.', 'Registry.Example.COM', 'example.com:8080', '*.example.com:443', 'xn--bcher-kva.example',
    '127.0.0.1', '10.0.0.5:6379', '[::1]', '[fd00::1]:8080', 'fd00::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'fe80::1%eth0', '[2001:db8::1]:443',
    '', '  ', '*', 'example', '*.com', 'a.*.example.com', '**.example.com', 'example.com:0', 'example.com:70000', 'exa mple.com', '-bad.example.com',
    'bad-.example.com', `${'a'.repeat(64)}.example.com`, `${'a.'.repeat(127)}com`, '256.1.1.1', '01.2.3.4', '1.2.3', '[example.com]', '[::1]:99999',
    'http://example.com', 'example.com/path', ':::1', '1::2::3', 'fe80::1%', 'user@example.com', '_dmarc.example.com',
];

test('the settings UI rejects exactly the allowlist entries the API rejects', () => {
    for (const entry of entries) {
        const api = parseEgressAllowEntry(entry);
        assert.equal(egressAllowEntryError(entry), typeof api === 'string' ? api : undefined, JSON.stringify(entry));
    }
});
