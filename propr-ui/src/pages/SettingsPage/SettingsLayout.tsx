import React, { useId } from 'react';
import {
  SETTINGS_CHECKBOX,
  SETTINGS_FIELD,
  SETTINGS_HELPER,
  SETTINGS_LABEL,
  SETTINGS_SECTION_DIVIDER,
  SETTINGS_SECTION_TITLE
} from './settingsStyles';

/**
 * The structural loop every Settings view follows:
 *
 *   SettingsSection  – Utility Header + 1px divider, no card, no rounded box.
 *   SettingsField    – label on top, control below, helper text last.
 *   SettingsCheckboxField – checkbox left, label and helper stacked right.
 *   SettingsStatus   – a quiet dot plus neutral slate text, never bright green.
 */

interface SettingsSectionProps {
  title: string;
  description?: React.ReactNode;
  /** Rendered at the right edge of the Utility Header, on the header baseline. */
  status?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  status,
  icon,
  children,
  className
}) => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={className}>
      <div className={`mb-4 flex items-center justify-between gap-3 ${SETTINGS_SECTION_DIVIDER}`}>
        <h4 id={headingId} className={`flex items-center gap-2 ${SETTINGS_SECTION_TITLE}`}>
          {icon}
          {title}
        </h4>
        {status}
      </div>
      {description && (
        <p className="mb-5 max-w-2xl text-[12px] leading-5 text-slate-500">{description}</p>
      )}
      {children}
    </section>
  );
};

interface SettingsFieldProps {
  label: string;
  htmlFor: string;
  helperText?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const SettingsField: React.FC<SettingsFieldProps> = ({
  label,
  htmlFor,
  helperText,
  children,
  className
}) => (
  <div className={`${SETTINGS_FIELD} ${className || ''}`}>
    <label className={SETTINGS_LABEL} htmlFor={htmlFor}>{label}</label>
    <div className="mt-1.5">{children}</div>
    {helperText && <p className={SETTINGS_HELPER}>{helperText}</p>}
  </div>
);

interface SettingsCheckboxFieldProps {
  id: string;
  name?: string;
  label: string;
  helperText?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  /** Extra content rendered under the helper text, inside the label column. */
  children?: React.ReactNode;
  className?: string;
}

export const SettingsCheckboxField: React.FC<SettingsCheckboxFieldProps> = ({
  id,
  name,
  label,
  helperText,
  checked,
  disabled,
  onChange,
  onBlur,
  children,
  className
}) => (
  <div className={`mb-6 flex max-w-2xl items-start gap-3 ${className || ''}`}>
    <input
      type="checkbox"
      id={id}
      name={name}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      onBlur={onBlur}
      className={SETTINGS_CHECKBOX}
    />
    <div className="min-w-0">
      <label className={`${SETTINGS_LABEL} cursor-pointer`} htmlFor={id}>{label}</label>
      {helperText && <p className="mt-1 text-[12px] leading-5 text-slate-500">{helperText}</p>}
      {children}
    </div>
  </div>
);

export type SettingsStatusTone = 'ok' | 'pending' | 'warn' | 'error';

const STATUS_DOT: Record<SettingsStatusTone, string> = {
  ok: 'bg-teal-500',
  pending: 'bg-slate-300',
  warn: 'bg-amber-500',
  error: 'bg-red-500'
};

interface SettingsStatusProps {
  tone: SettingsStatusTone;
  children: React.ReactNode;
  role?: string;
  className?: string;
}

/**
 * Success is quiet: a connected service reads as a small teal dot next to
 * neutral slate text, never as bright green copy floating in the layout.
 */
export const SettingsStatus: React.FC<SettingsStatusProps> = ({ tone, children, role, className }) => (
  <span
    role={role}
    className={`inline-flex items-center gap-2 whitespace-nowrap text-[12px] ${
      tone === 'error' ? 'text-red-600' : 'text-slate-500'
    } ${className || ''}`}
  >
    <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[tone]}`} />
    {children}
  </span>
);
