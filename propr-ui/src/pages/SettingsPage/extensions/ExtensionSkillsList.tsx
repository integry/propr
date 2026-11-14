import { useState } from 'react';
import { EXTENSION_LIBRARY_LIMITS, type ExtensionLibrarySkill } from '@propr/shared';
import { ExtensionItemRow } from './ExtensionItemRow';
import { ExtensionSkillForm } from './ExtensionSkillForm';
import { itemNotes } from './extensionNotes';
import { withSkill } from './libraryEdits';
import { RUN_LIMITS, buttonClass, runLimitExcess, skillRef } from './extensionUi';
import type { ExtensionLibraryState } from './useExtensionLibrary';

/** The library's skills: one row each with its enabled switch, and the add/edit form. */
export function ExtensionSkillsList({ state }: { state: ExtensionLibraryState }) {
  /** The open form and, when editing, the saved skill it was opened on. */
  const [editing, setEditing] = useState<{ opened?: ExtensionLibrarySkill } | null>(null);
  const library = state.library!;
  const skills = library.skills;
  const bundles = [...new Map([...state.bundles, ...library.skillBundles].map(bundle => [bundle.id, bundle])).values()];
  const bundleOf = (id: string) => bundles.find(bundle => bundle.id === id);
  const nameOf = (id: string) => bundleOf(id)?.name ?? id;
  const available = bundles.filter(bundle => !skills.some(skill => skill.bundleId === bundle.id));
  const full = skills.length >= EXTENSION_LIBRARY_LIMITS.bundles;
  const excess = runLimitExcess(skills, state.choices, RUN_LIMITS.skills);
  const save = async (skill: ExtensionLibrarySkill) => {
    const opened = editing?.opened;
    const added = opened === undefined;
    await state.save(items => ({ ...items, skills: withSkill(items.skills, skill, opened) }));
    setEditing(null);
    state.setNotice(added ? `Skill ${nameOf(skill.bundleId)} added.` : `Skill ${nameOf(skill.bundleId)} saved.`);
  };
  const form = (skill?: ExtensionLibrarySkill) => (
    <ExtensionSkillForm initial={skill} bundle={skill ? bundleOf(skill.bundleId) : undefined} available={available} choices={state.choices}
      onImported={state.addBundle} onSave={save} onCancel={() => setEditing(null)} />
  );
  return (
    <section aria-labelledby="extension-skills-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="extension-skills-heading" className="text-sm font-semibold">Skills</h4>
        {editing === null && <button type="button" className={buttonClass} disabled={full} onClick={() => setEditing({})}>Add skill</button>}
      </div>
      {full && <p className="text-xs text-slate-500">The library holds at most {EXTENSION_LIBRARY_LIMITS.bundles} skills.</p>}
      {excess && (
        <p role="note" className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          {excess.count} skills can apply to {excess.repository} with {excess.agent}; only {RUN_LIMITS.skills} are used per run.
        </p>
      )}
      {editing && editing.opened === undefined && form()}
      {skills.length === 0 && !editing && <p className="text-sm text-slate-500">No skills yet.</p>}
      <ul className="space-y-2">
        {skills.map(skill => (editing?.opened?.bundleId === skill.bundleId ? <li key={skill.bundleId}>{form(editing.opened)}</li> : (
          <ExtensionItemRow key={skill.bundleId} testId="extension-skill" managedBy={skill.managedBy} name={nameOf(skill.bundleId)}
            kind={({ github: 'Skill from GitHub', plugin: 'Skill from a plugin', archive: 'Skill archive' } as const)[bundleOf(skill.bundleId)?.source.kind ?? 'archive']}
            item={skill} enabled={state.shownEnabled(skillRef(skill), skill.enabled)} pending={state.isPending(skillRef(skill))}
            busy={editing !== null} notes={itemNotes(skill, { usage: state.usage, choices: state.choices })}
            onToggle={enabled => void state.toggle(skillRef(skill), nameOf(skill.bundleId), enabled)}
            onEdit={() => setEditing({ opened: skill })}
            onRemove={() => void state.remove(skillRef(skill), nameOf(skill.bundleId))} />
        )))}
      </ul>
    </section>
  );
}
