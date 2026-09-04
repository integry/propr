import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import axeCore from 'axe-core';

const require = createRequire(import.meta.url);
const axePackage = require('axe-core/package.json');

export const PACKAGED_AXE_VERSION = '4.10.3';
export const PACKAGED_AXE_SOURCE_SHA256 = '5248a3ce82beae19e2bbd73dc209055747cda599e59a02f3272045206904254f';
export const PACKAGED_AXE_FRAME_POLICY = 'reject-all-child-frames';
export const PACKAGED_AXE_CLEANUP_TIMEOUT_MS = 5_000;

const axeSource = axeCore?.source;
const axeSourceSha256 = typeof axeSource === 'string'
  ? createHash('sha256').update(axeSource).digest('hex')
  : '';

if (axePackage?.name !== 'axe-core' || axePackage?.version !== PACKAGED_AXE_VERSION
  || axeCore?.version !== PACKAGED_AXE_VERSION || typeof axeSource !== 'string'
  || axeSource.length === 0 || axeSourceSha256 !== PACKAGED_AXE_SOURCE_SHA256) {
  throw new Error('Packaged accessibility axe-core source identity or version is invalid');
}

const validateProjectedViolations = violations => {
  if (!Array.isArray(violations)) {
    throw new Error('Packaged accessibility result schema is invalid');
  }
  for (const violation of violations) {
    if (!violation || typeof violation !== 'object'
      || Object.keys(violation).length !== 3
      || typeof violation.id !== 'string' || violation.id.length === 0
      || (violation.impact !== 'serious' && violation.impact !== 'critical')
      || !Number.isInteger(violation.nodes) || violation.nodes < 1) {
      throw new Error('Packaged accessibility result schema is invalid');
    }
  }
  return violations;
};

/**
 * Run the pinned axe-core engine in the already-authenticated renderer target.
 *
 * The acceptance UI is intentionally single-frame. Child frames are rejected
 * instead of being silently skipped or aggregated in a new page. Within that
 * document, axe.run(document) performs axe-core's native composed-tree walk,
 * including all open shadow roots supported by the engine.
 */
export const analyzeExistingElectronRenderer = async page => {
  if (!page || typeof page.evaluate !== 'function' || typeof page.frames !== 'function'
    || typeof page.mainFrame !== 'function') {
    throw new Error('Packaged accessibility renderer target is invalid');
  }

  const frames = page.frames();
  if (PACKAGED_AXE_FRAME_POLICY !== 'reject-all-child-frames'
    || frames.length !== 1 || frames[0] !== page.mainFrame()) {
    throw new Error('Packaged accessibility does not permit child frames');
  }

  let injected = false;
  let primaryError;
  try {
    const injectionBoundary = await page.evaluate(() => ({
      childFrames: window.frames.length,
      existingAxe: typeof globalThis.axe !== 'undefined',
    }));
    if (!injectionBoundary || injectionBoundary.childFrames !== 0 || injectionBoundary.existingAxe !== false) {
      throw new Error('Packaged accessibility injection boundary is invalid');
    }

    try {
      injected = true;
      await page.evaluate(axeSource);
    } catch (error) {
      throw new Error('Packaged accessibility axe-core injection failed', { cause: error });
    }

    const identity = await page.evaluate(() => ({
      version: globalThis.axe?.version,
      run: typeof globalThis.axe?.run,
      cleanup: typeof globalThis.axe?.cleanup,
    }));
    if (!identity || identity.version !== PACKAGED_AXE_VERSION
      || identity.run !== 'function' || identity.cleanup !== 'function') {
      throw new Error('Packaged accessibility injected engine identity or version is invalid');
    }

    let violations;
    try {
      violations = await page.evaluate(async expectedVersion => {
        const engine = globalThis.axe;
        const results = await engine.run(document, { resultTypes: ['violations'] });
        const validImpact = new Set([null, 'minor', 'moderate', 'serious', 'critical']);
        if (!results || typeof results !== 'object'
          || results.testEngine?.name !== 'axe-core' || results.testEngine?.version !== expectedVersion
          || !Array.isArray(results.violations)) {
          throw new Error('axe-core returned an invalid result envelope');
        }
        const projected = [];
        for (const violation of results.violations) {
          if (!violation || typeof violation !== 'object'
            || typeof violation.id !== 'string' || violation.id.length === 0
            || !validImpact.has(violation.impact) || !Array.isArray(violation.nodes)
            || violation.nodes.some(node => !node || typeof node !== 'object')) {
            throw new Error('axe-core returned an invalid violation');
          }
          if (violation.impact === 'serious' || violation.impact === 'critical') {
            projected.push({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length });
          }
        }
        return projected;
      }, PACKAGED_AXE_VERSION);
    } catch (error) {
      throw new Error('Packaged accessibility axe-core execution or result validation failed', { cause: error });
    }
    return validateProjectedViolations(violations);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (injected) {
      let cleaned = false;
      let cleanupError;
      try {
        cleaned = await page.evaluate(async cleanupTimeoutMs => {
          const engine = globalThis.axe;
          if (!engine || typeof engine.cleanup !== 'function') {
            throw new Error('axe-core cleanup is unavailable');
          }
          // axe-core 4.10.3 cleanup completes through these callbacks after
          // its plugin/frame queue drains; its direct return value is not completion.
          await new Promise((resolve, reject) => {
            let settled = false;
            let timeout;
            const settle = callback => value => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              callback(value);
            };
            const resolveCleanup = settle(resolve);
            const rejectCleanup = settle(reject);
            timeout = setTimeout(
              () => rejectCleanup(new Error(`axe-core cleanup timed out after ${cleanupTimeoutMs}ms`)),
              cleanupTimeoutMs,
            );
            try {
              engine.cleanup(resolveCleanup, rejectCleanup);
            } catch (error) {
              rejectCleanup(error);
            }
          });
          return Reflect.deleteProperty(globalThis, 'axe') && typeof globalThis.axe === 'undefined';
        }, PACKAGED_AXE_CLEANUP_TIMEOUT_MS);
      } catch (error) {
        cleanupError = new Error('Packaged accessibility axe-core cleanup failed', { cause: error });
      }
      if (!cleaned && !cleanupError) {
        cleanupError = new Error('Packaged accessibility axe-core cleanup failed');
      }
      if (cleanupError) {
        if (!primaryError) throw cleanupError;
        throw new AggregateError(
          [primaryError, cleanupError],
          primaryError instanceof Error ? primaryError.message : String(primaryError),
          { cause: primaryError },
        );
      }
    }
  }
};

