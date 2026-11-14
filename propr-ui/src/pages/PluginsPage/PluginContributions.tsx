import { Link } from 'react-router-dom';
import type { PluginView } from '../../api/pluginsApi';
import { EXTENSION_LIBRARY_PATH } from './pluginUi';

const state = (managed: { enabled: boolean; active: boolean } | null) => {
  if (!managed) return 'Added when installed';
  if (!managed.active) return 'Inactive until the plugin is enabled';
  return managed.enabled ? 'Active' : 'Switched off in Skills & MCP servers';
};

/** What it added: a read-only list of the plugin's managed items and templates, with links. */
export function PluginContributions({ view }: { view: PluginView }) {
  const contributions = view.contributions;
  if (!contributions) return null;
  const { mcpServers, skills, automationTemplates } = contributions;
  if (!mcpServers.length && !skills.length && !automationTemplates.length) return null;
  const library = <Link to={EXTENSION_LIBRARY_PATH} className="font-medium text-teal-700 underline hover:text-teal-800">Skills & MCP servers</Link>;
  return (
    <section aria-labelledby="plugin-contributions" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <h2 id="plugin-contributions" className="text-base font-semibold text-slate-900">What it added</h2>
      <ul data-testid="plugin-contributions" className="mt-3 space-y-2 text-sm text-slate-700">
        {mcpServers.map(server => (
          <li key={`server:${server.name}`} className="break-words">
            {server.kind === 'package' ? 'Local MCP server' : 'MCP server'} <strong>{server.managed?.name ?? server.name}</strong> · {state(server.managed)}
            {server.managed && <> · managed in {library}</>}
          </li>
        ))}
        {skills.map(skill => (
          <li key={`skill:${skill.name}`} className="break-words">
            Skill <strong>{skill.name}</strong> · {state(skill.managed)}{skill.managed && <> · managed in {library}</>}
          </li>
        ))}
        {automationTemplates.map(template => (
          <li key={`template:${template.id}`} className="break-words">
            Automation template <strong>{template.catalogId}</strong> · {template.available ? <>listed in the <Link to="/automations" className="font-medium text-teal-700 underline hover:text-teal-800">automation template catalog</Link></> : 'listed once the plugin is enabled'}
          </li>
        ))}
      </ul>
    </section>
  );
}
