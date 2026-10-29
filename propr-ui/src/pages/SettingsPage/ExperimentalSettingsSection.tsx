import { SettingsCheckboxField, SettingsSection } from './SettingsLayout';
import { VoiceBriefingsToggle } from './VoiceSettingsSection';

/**
 * Early features that are off until someone opts in. Voice briefings are a
 * per-account, per-device preference; dashboard AI summaries apply to the
 * whole instance.
 */
export default function ExperimentalSettingsSection({ dashboardSummaryEnabled, onDashboardSummaryChange }: {
  dashboardSummaryEnabled: boolean;
  onDashboardSummaryChange: (enabled: boolean) => void;
}) {
  return (
    <SettingsSection
      title="Experimental"
      description="Early features that are off by default and may change between releases."
    >
      <VoiceBriefingsToggle />
      <SettingsCheckboxField
        id="dashboard_summary_enabled"
        name="dashboard_summary_enabled"
        label="Dashboard AI summaries"
        helperText="Shows a one-line summary of current activity at the top of the dashboard for everyone on this instance. Uses the summarization model under AI Models & Reasoning, so each update costs an LLM call."
        checked={dashboardSummaryEnabled}
        onChange={event => onDashboardSummaryChange(event.target.checked)}
      />
    </SettingsSection>
  );
}
