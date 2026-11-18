import React from 'react';
import { DateInput, formatDateTime, formatRelativeTime, toDateTimeAttribute } from '../../utils/dateFormat';

interface RelativeTimeProps {
  value: DateInput;
  className?: string;
  /** Text before the full date and time in the tooltip, e.g. `Started`. */
  titlePrefix?: string;
  /** Text before the relative age, e.g. `Updated`. */
  prefix?: string;
  'data-testid'?: string;
}

/**
 * A timestamp as the shared relative age (`5m ago`, `Nov 2, 2026`) with the full local date and time in
 * the tooltip. Renders nothing for a missing or unparseable timestamp.
 */
export const RelativeTime: React.FC<RelativeTimeProps> = ({ value, className, titlePrefix, prefix, 'data-testid': testId }) => {
  const label = formatRelativeTime(value);
  if (!label) return null;
  const full = formatDateTime(value);
  return (
    <time dateTime={toDateTimeAttribute(value)} title={titlePrefix ? `${titlePrefix} ${full}` : full} className={className} data-testid={testId}>
      {prefix ? `${prefix} ${label}` : label}
    </time>
  );
};
