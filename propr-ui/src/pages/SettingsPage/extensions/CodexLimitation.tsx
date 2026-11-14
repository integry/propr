/** The Codex configuration limitation of runs with extensions. */
export const CodexLimitation = () => (
  <>
    Applies to Codex: Codex runs with extensions use <code>--ignore-user-config</code>, so custom{' '}
    <code>model_provider</code> settings in <code>CODEX_HOME/config.toml</code> are unavailable, and repositories
    containing <code>.codex/config.toml</code> are refused. Automatic items are left out of a Codex run that needs
    either; items an automation adds keep this behaviour.
  </>
);
