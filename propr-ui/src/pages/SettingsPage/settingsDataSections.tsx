import AgentExtensionsSection from './AgentExtensionsSection';
import AgentRuntimePackagesSection from './AgentRuntimePackagesSection';
import InstanceStorageSection from './InstanceStorageSection';
import VisualPreviewAuthSection from './VisualPreviewAuthSection';
import ManagedPreviewStorageSection from './ManagedPreviewStorageSection';
import MaintenanceSection from './MaintenanceSection';
import type { SettingsNavigationSection } from './SettingsNavigation';
import type { CurrentUser } from '../../api/proprTypes';
import { canManageHeldFollowups, canManageInstanceStorage } from './settingsPermissions';

/** MCP tools, skills and system packages that agents can use inside their containers. */
export function agentExtensionSections(): SettingsNavigationSection[] {
  return [
    { id: 'agent-extensions', category: 'agent-extensions', searchText: 'agent extensions library MCP skills instance admin security bundles', content: <AgentExtensionsSection /> },
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

/**
 * Operator upkeep, in order: held follow-ups, which may be blocking a pull
 * request right now, then instance data. Both are administrator-only, so a
 * viewer who can use neither gets no sections and the Maintenance category
 * drops out of the list.
 */
export function maintenanceSections(user: CurrentUser | null): SettingsNavigationSection[] {
  const sections: SettingsNavigationSection[] = [];
  if (canManageHeldFollowups(user)) {
    sections.push({
      id: 'maintenance',
      category: 'maintenance',
      searchText: 'maintenance held follow-ups follow-up hold release resume blocked pull request fork publication stuck command cancelled',
      content: <MaintenanceSection />
    });
  }
  if (canManageInstanceStorage(user)) {
    sections.push({
      id: 'instance-storage',
      category: 'maintenance',
      searchText: 'instance data database export inventory repository cache cleanup storage self hosted admin backup maintenance',
      content: <InstanceStorageSection />
    });
  }
  return sections;
}
