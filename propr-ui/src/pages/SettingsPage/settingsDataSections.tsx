import AgentExtensionsSection from './AgentExtensionsSection';
import AgentRuntimePackagesSection from './AgentRuntimePackagesSection';
import InstanceStorageSection from './InstanceStorageSection';
import VisualPreviewAuthSection from './VisualPreviewAuthSection';
import ManagedPreviewStorageSection from './ManagedPreviewStorageSection';
import MaintenanceSection from './MaintenanceSection';
import type { SettingsNavigationSection } from './SettingsNavigation';

/** MCP tools, skills and system packages that agents can use inside their containers. */
export function agentExtensionSections(): SettingsNavigationSection[] {
  return [
    { id: 'agent-extensions', category: 'agent-extensions', searchText: 'agent extensions profiles MCP skills instance admin security bundles', content: <AgentExtensionsSection /> },
    {
      id: 'agent-runtime-packages',
      category: 'agent-extensions',
      searchText: 'agent runtime packages dependencies install apt debian system tools catalog container image environment build',
      content: <AgentRuntimePackagesSection />
    },
  ];
}

export function settingsDataSections(): SettingsNavigationSection[] {
  return [
    {
      id: 'instance-storage',
      category: 'integrations',
      searchText: 'instance database export inventory repository cache cleanup storage self hosted admin backup',
      content: <InstanceStorageSection />
    },
    {
      id: 'visual-preview-uploads',
      category: 'integrations',
      searchText: 'visual preview upload screenshots videos GitHub login personal access token PAT credential authentication connect managed storage quota retention Plus originals',
      content: (
        <div className="space-y-10">
          <VisualPreviewAuthSection />
          <ManagedPreviewStorageSection />
        </div>
      )
    },
  ];
}

/** Operator maintenance: follow-up handoffs held for a decision. Renders nothing for non-administrators. */
export function maintenanceSections(): SettingsNavigationSection[] {
  return [
    {
      id: 'maintenance',
      category: 'workflow',
      searchText: 'maintenance held follow-up handoff hold release resume operator blocked pull request fork publication stuck command',
      content: <MaintenanceSection />
    },
  ];
}
