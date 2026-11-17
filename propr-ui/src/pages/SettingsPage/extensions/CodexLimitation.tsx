/** Docs section on why Codex runs that need a custom Codex config run without extensions. */
export const CODEX_LIMITATION_DOCS = 'https://docs.propr.dev/docs/features/agent-extensions#codex-configuration';

/** The Codex configuration limitation of runs with extensions, with the detail in the docs. */
export const CodexLimitation = () => (
  <>
    Codex: not used in runs that need a custom Codex config.{' '}
    <a href={CODEX_LIMITATION_DOCS} target="_blank" rel="noopener noreferrer" className="font-medium underline hover:no-underline">Details</a>
  </>
);
