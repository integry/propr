import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertDarwinSigningEvidence } from './verify-darwin-packaged-connect-signature.mjs';

const fingerprint = 'A'.repeat(40);
const requirement = `designated => identifier "dev.propr.desktop" and certificate leaf = H"${fingerprint}"`;
const validEvidence = () => ({
  expectedCertificateSha1: fingerprint,
  certificates: `SHA-256 hash: ${'C'.repeat(64)}\nSHA-1 hash: ${fingerprint}`,
  signatureDetails: [
    'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
    'Identifier=dev.propr.desktop',
    'Authority=ProPR Packaged Connect CI',
  ].join('\n'),
  designatedRequirement: requirement,
});

describe('Darwin packaged Connect acceptance signature proof', () => {
  test('accepts one imported certificate bound into the app designated requirement', () => {
    assert.equal(assertDarwinSigningEvidence(validEvidence()), requirement);
    assert.equal(assertDarwinSigningEvidence({
      ...validEvidence(), previousDesignatedRequirement: `${requirement}\n`,
    }), requirement);
  });

  test('fails closed when the disposable certificate is missing, ambiguous, or different', () => {
    for (const certificates of [
      '',
      `${validEvidence().certificates}\nSHA-1 hash: ${'B'.repeat(40)}`,
      `SHA-1 hash: ${'B'.repeat(40)}`,
    ]) {
      assert.throws(() => assertDarwinSigningEvidence({ ...validEvidence(), certificates }));
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
