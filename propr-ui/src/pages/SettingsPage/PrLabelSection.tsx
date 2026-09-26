import React from 'react';
import { SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';

interface PrLabelSectionProps {
  prLabel: string;
  onLabelChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  className?: string;
}

const PrLabelSection: React.FC<PrLabelSectionProps> = ({
  prLabel,
  onLabelChange,
  onBlur,
  className
}) => {
  return (
    <SettingsSection
      title="PR Label"
      description="Automatically added to all ProPR PRs. Used to monitor for follow-up comments."
      className={className}
    >
      <SettingsField
        label="Label Name"
        htmlFor="pr_label"
        helperText="Applied to every pull request ProPR opens."
      >
        <input
          type="text"
          id="pr_label"
          name="pr_label"
          value={prLabel}
          onChange={onLabelChange}
          onBlur={onBlur}
          placeholder="e.g., propr"
          required
          className={SETTINGS_CONTROL}
        />
      </SettingsField>
    </SettingsSection>
  );
};

export default PrLabelSection;
