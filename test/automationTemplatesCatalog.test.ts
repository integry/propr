import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  TEMPLATE_CATALOG_PATH,
  TEMPLATE_ORDER,
  TEMPLATE_SOURCE_DIR,
  generateAutomationTemplates,
  renderCatalog,
} from '../scripts/generate-automation-templates.js';
import {
  AUTOMATION_TEMPLATE_CATALOG,
  AUTOMATION_TEMPLATES,
  automationTemplateInput,
  getAutomationTemplate,
  validateAutomationTemplate,
  validateAutomationTemplateCatalog,
} from '../packages/shared/src/automationTemplates.js';
import { validateAutomationDefinitionInput } from '../packages/shared/src/automationDefinitions.js';

const scratch = await mkdtemp(join(tmpdir(), 'propr-automation-templates-'));
after(() => rm(scratch, { recursive: true, force: true }));

test('committed catalog matches the generator output', async () => {
  assert.equal(await readFile(TEMPLATE_CATALOG_PATH, 'utf8'), renderCatalog(await generateAutomationTemplates()));
});

test('the loaded catalog is versioned and starts with daily issue triage', () => {
  assert.equal(AUTOMATION_TEMPLATE_CATALOG.version, 1);
  assert.equal(AUTOMATION_TEMPLATES[0].id, 'daily-issue-triage');
  const triage = getAutomationTemplate('daily-issue-triage')!;
  assert.equal(triage.name, 'Daily issue triage');
  assert.equal(triage.category, 'triage');
  assert.match(triage.prompt, /duplicate/i);
  assert.match(triage.prompt, /severity/i);
  assert.match(triage.prompt, /security/i);
  assert.match(triage.prompt, /stale/i);
  assert.match(triage.prompt, /Needs a human/);
  assert.deepEqual(triage.reviewBeforeSaving.map(item => item.field), ['repositories', 'schedule', 'autonomy']);
  assert.equal(getAutomationTemplate('nope'), undefined);
});

test('every template defaults to dry_run and prefills a valid definition', () => {
  for (const template of AUTOMATION_TEMPLATES) {
    assert.equal(template.autonomy, 'dry_run', template.id);
    const input = automationTemplateInput(template);
    assert.equal(input.autonomy, 'dry_run');
    assert.deepEqual(input.repositories, []);
    assert.equal(validateAutomationDefinitionInput(input), null, template.id);
  }
});

test('validation rejects templates that break the template or definition contract', () => {
  const base = AUTOMATION_TEMPLATES[0];
  const invalid = (patch: Record<string, unknown>) => validateAutomationTemplate({ ...base, ...patch });
  assert.equal(invalid({}), null);
  assert.match(invalid({ autonomy: 'auto' })!, /autonomy must be dry_run/);
  assert.match(invalid({ schedule: '* * * * *' })!, /15 minutes|interval/i);
  assert.match(invalid({ capabilities: ['shell'] })!, /capabilities must be one of/);
  assert.match(invalid({ category: 'misc' })!, /category/);
  assert.match(invalid({ id: 'Not Kebab' })!, /kebab-case/);
  assert.match(invalid({ name: 'x'.repeat(101) })!, /name must be at most/);
  assert.match(invalid({ prompt: '' })!, /prompt is required/);
  assert.match(invalid({ previousReportCount: 9 })!, /previousReportCount/);
  assert.match(invalid({ extra: true })!, /unknown field extra/);
  assert.match(invalid({ reviewBeforeSaving: base.reviewBeforeSaving.filter(item => item.field !== 'autonomy') })!, /must include autonomy/);
  assert.match(invalid({ reviewBeforeSaving: [...base.reviewBeforeSaving, base.reviewBeforeSaving[0]] })!, /duplicate review field/);
  assert.match(validateAutomationTemplateCatalog({ version: 2, templates: [base] })!, /version/);
  assert.match(validateAutomationTemplateCatalog({ version: 1, templates: [base, base] })!, /duplicate template id/);
});

test('the generator refuses unlisted, mismatched or invalid template sources', async () => {
  const sources = join(scratch, 'sources');
  await cp(TEMPLATE_SOURCE_DIR, sources, { recursive: true });
  assert.equal((await generateAutomationTemplates(sources)).templates.length, TEMPLATE_ORDER.length);
  await assert.rejects(generateAutomationTemplates(sources, [...TEMPLATE_ORDER, 'ghost']), /without a source directory/);
  await assert.rejects(generateAutomationTemplates(sources, []), /missing from TEMPLATE_ORDER/);
  const metadataPath = join(sources, 'daily-issue-triage', 'template.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, autonomy: 'preview' }));
  await assert.rejects(generateAutomationTemplates(sources), /autonomy must be dry_run/);
  await writeFile(metadataPath, JSON.stringify({ ...metadata, id: 'other' }));
  await assert.rejects(generateAutomationTemplates(sources), /must match its directory/);
});
