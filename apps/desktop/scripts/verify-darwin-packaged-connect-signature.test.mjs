import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertDarwinSigningEvidence } from './verify-darwin-packaged-connect-signature.mjs';

const fingerprint = 'A'.repeat(40);
const requirement = `designated => identifier "dev.propr.desktop" and certificate leaf = H"${fingerprint}"`;
const validEvidence = () => ({
  expectedCertificateSha1: fingerprint,
  identities: `  1) ${fingerprint} "ProPR Packaged Connect CI"\n     1 valid identities found`,
  signatureDetails: [
    'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
    'Identifier=dev.propr.desktop',
    'Authority=ProPR Packaged Connect CI',
    'Authority=ProPR Packaged Connect CI Root',
  ].join('\n'),
  designatedRequirement: requirement,
});

describe('Darwin packaged Connect acceptance signature proof', () => {
  test('accepts one certificate identity bound into the app designated requirement', () => {
    assert.equal(assertDarwinSigningEvidence(validEvidence()), requirement);
    assert.equal(assertDarwinSigningEvidence({
      ...validEvidence(), previousDesignatedRequirement: `${requirement}\n`,
    }), requirement);
  });

  test('fails closed when the disposable identity is missing, ambiguous, or different', () => {
    for (const identities of [
      '0 valid identities found',
      `${validEvidence().identities}\n  2) ${'B'.repeat(40)} "Unexpected"`,
      `  1) ${'B'.repeat(40)} "Unexpected"\n     1 valid identities found`,
    ]) {
      assert.throws(() => assertDarwinSigningEvidence({ ...validEvidence(), identities }));
    }
  });

  test('rejects ad-hoc signatures and requirements not pinned to the generated certificate', () => {
    assert.throws(() => assertDarwinSigningEvidence({
      ...validEvidence(), signatureDetails: 'Identifier=dev.propr.desktop\nSignature=adhoc',
    }));
    assert.throws(() => assertDarwinSigningEvidence({
      ...validEvidence(),
      designatedRequirement: 'designated => identifier "dev.propr.desktop" and anchor trusted',
    }));
  });

  test('rejects any signing identity change after the pair and reprobe launches', () => {
    assert.throws(() => assertDarwinSigningEvidence({
      ...validEvidence(),
      previousDesignatedRequirement: `${requirement.replace(fingerprint, 'B'.repeat(40))}\n`,
    }));
  });
});
