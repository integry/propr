/**
 * Activity: what the plugin received and did. A placeholder until the event dispatcher records deliveries; the
 * installation's own changes are kept in the plugin's audit log.
 */
export function PluginActivity() {
  return (
    <section aria-labelledby="plugin-activity" data-testid="plugin-activity" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <h2 id="plugin-activity" className="text-base font-semibold text-slate-900">Activity</h2>
      <p className="mt-2 text-sm text-slate-500">
        No activity yet. Once plugins receive ProPR events, each delivery and its result is listed here.
      </p>
    </section>
  );
}
