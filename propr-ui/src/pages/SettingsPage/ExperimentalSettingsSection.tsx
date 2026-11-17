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
      title="Opt-in features"
      description="Early features that are off by default and may change between releases."
    >
      <VoiceBriefingsToggle />
      <SettingsCheckboxField
        id="dashboard_summary_enabled"
        name="dashboard_summary_enabled"
        label="Dashboard AI summaries"
        helperText="Shows a one-line activity summary on the dashboard for everyone. Each update costs one LLM call."
        checked={dashboardSummaryEnabled}
        onChange={event => onDashboardSummaryChange(event.target.checked)}
      />
    </SettingsSection>
  );
}
