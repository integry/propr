import React from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, LayoutTemplate } from 'lucide-react';
import { AUTOMATION_TEMPLATES, type AutomationTemplate, type AutomationTemplateReviewField } from '@propr/shared';
import { AUTONOMY_LABELS, describeCron } from './agentPresentation';

const REVIEW_FIELD_LABELS: Record<AutomationTemplateReviewField, string> = {
  repositories: 'Repositories',
  schedule: 'Schedule',
  autonomy: 'Autonomy',
  agent: 'Coding agent',
  capabilities: 'Capabilities',
};

const CATEGORY_LABELS: Record<AutomationTemplate['category'], string> = {
  triage: 'Triage',
  maintenance: 'Maintenance',
  reporting: 'Reporting',
  research: 'Research',
};

/** The template's link for the new-automation screen, which opens with its form prefilled. */
const templateHref = (template: Pick<AutomationTemplate, 'id'>): string => `/automations/new?template=${encodeURIComponent(template.id)}`;

const TemplateSummary: React.FC<{ template: AutomationTemplate }> = ({ template }) => (
  <>
    <span className="flex items-center gap-2">
      <span className="text-sm font-medium text-slate-900">{template.name}</span>
      <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {CATEGORY_LABELS[template.category]}
      </span>
    </span>
    <span className="mt-1 block text-xs text-slate-600">{template.description}</span>
    <span className="mt-1.5 block text-[11px] text-slate-500">
      {describeCron(template.schedule)} · {AUTONOMY_LABELS[template.autonomy]}
    </span>
  </>
);

const CARD_CLASSES = 'block w-full rounded-md border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

interface AgentTemplatePickerProps {
  /** The template the form was last filled from. */
  selectedId: string | null;
  onSelect: (template: AutomationTemplate) => void;
  disabled: boolean;
  templates?: readonly AutomationTemplate[];
}

/** "Start from a template" on the new-automation form: choosing one fills the form and creates nothing. */
export const AgentTemplatePicker: React.FC<AgentTemplatePickerProps> = ({ selectedId, onSelect, disabled, templates = AUTOMATION_TEMPLATES }) => {
  if (templates.length === 0) return null;
  return (
    <section aria-labelledby="agent-template-picker-heading" className="border-b border-slate-100 px-4 py-4" data-testid="agent-template-picker">
      <h2 id="agent-template-picker-heading" className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
        <LayoutTemplate className="h-4 w-4 text-slate-400" aria-hidden="true" />Start from a template
      </h2>
      <p className="mt-0.5 text-xs text-slate-500">Fills in the form below. Nothing is created until you choose Create automation.</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {templates.map(template => {
          const selected = template.id === selectedId;
          return (
            <li key={template.id}>
              <button
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onSelect(template)}
                data-testid="agent-template-option"
                className={`${CARD_CLASSES} disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'border-teal-500 bg-teal-50/60' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}`}
              >
                <TemplateSummary template={template} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/** What the user must check before saving an automation started from a template. */
export const AgentTemplateReview: React.FC<{ template: AutomationTemplate }> = ({ template }) => (
  <section
    aria-labelledby="agent-template-review-heading"
    className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
    data-testid="agent-template-review"
  >
    <h2 id="agent-template-review-heading" className="flex items-center gap-1.5 text-sm font-medium">
      <ClipboardCheck className="h-4 w-4" aria-hidden="true" />Review before saving “{template.name}”
    </h2>
    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs">
      {template.reviewBeforeSaving.map(item => (
        <li key={item.field}><span className="font-medium">{REVIEW_FIELD_LABELS[item.field]}:</span> {item.note}</li>
      ))}
    </ul>
  </section>
);

/** The automations list's empty state: each template opens the new-automation form prefilled from it. */
export const AgentTemplateLinks: React.FC<{ readOnly: boolean; templates?: readonly AutomationTemplate[] }> = ({ readOnly, templates = AUTOMATION_TEMPLATES }) => {
  if (templates.length === 0) return null;
  return (
    <section aria-labelledby="agent-template-links-heading" className="mt-8 w-full max-w-md text-left" data-testid="agent-template-links">
      <h3 id="agent-template-links-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Or start from a template</h3>
      <ul className="mt-2 space-y-2">
        {templates.map(template => (
          <li key={template.id}>
            <Link
              to={templateHref(template)}
              aria-disabled={readOnly}
              onClick={event => { if (readOnly) event.preventDefault(); }}
              data-testid="agent-template-link"
              className={`${CARD_CLASSES} border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 ${readOnly ? 'pointer-events-none opacity-50' : ''}`}
            >
              <TemplateSummary template={template} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
};
