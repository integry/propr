import { createPublicKey, verify } from 'node:crypto';
import { canonical, hash, verifyProof } from './authority-verifier.mjs';
import { parseExtensionResultDelivery } from './binding-parser.mjs';
export { canonical, hash };
/** expected/native/routing/trust and both SPKIs MUST be independently retained.
 * Delivery does not authorize another dispatch. A consumed challenge can only
 * be reconciled by the caller with its already retained receipt. */
export function verifyDelivery(raw, expected, native, routing, trust, coreSPKI, recipientSPKI, nowMs, consumed) {
  try {
    if (raw instanceof Uint8Array) raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    const value = parseExtensionResultDelivery(raw, expected, native, v => hash(canonical(v)), recipient => {
      const { signature, ...signed } = recipient;
      const key = createPublicKey({ key: Buffer.from(recipientSPKI, 'base64url'), type: 'spki', format: 'der' });
      const bytes = Buffer.from(signature, 'base64url');
      if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'der' }).toString('base64url') !== recipientSPKI
        || bytes.toString('base64url') !== signature || !verify(null, Buffer.from(canonical(signed)), key, bytes)) throw Error();
      const publicBytes = Buffer.from(recipient.publicKey, 'base64url');
      if (publicBytes.length !== 65 || publicBytes[0] !== 4 || publicBytes.toString('base64url') !== recipient.publicKey) throw Error();
    });
    verifyProof(canonical(value.receipt), expected, routing, trust, coreSPKI, nowMs, consumed);
    return value;
  } catch { throw Error('extension_result_delivery_unavailable'); }
}
