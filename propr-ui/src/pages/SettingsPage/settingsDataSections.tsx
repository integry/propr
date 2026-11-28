import AgentExtensionsSection from './AgentExtensionsSection';
import AgentRuntimePackagesSection from './AgentRuntimePackagesSection';
import InstanceStorageSection from './InstanceStorageSection';
import VisualPreviewAuthSection from './VisualPreviewAuthSection';
import ManagedPreviewStorageSection from './ManagedPreviewStorageSection';
import MaintenanceSection from './MaintenanceSection';
import IdleShutdownSection from './IdleShutdownSection';
import InstanceSpritesSection from './InstanceSpritesSection';
import type { SettingsNavigationSection } from './SettingsNavigation';
import type { CurrentUser } from '../../api/proprTypes';
import { canManageAgentRuntime, canManageHeldFollowups, canManageInstanceStorage } from './settingsPermissions';

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

/** Opt-in control-plane idle shutdown; administrators who manage instance settings. */
export function idleShutdownSections(user: CurrentUser | null): SettingsNavigationSection[] {
  if (!canManageInstanceStorage(user)) return [];
  return [{
    id: 'idle-shutdown',
    category: 'maintenance',
    searchText: 'idle shutdown stop sleep wake auto stop start fly machine systemd cost metered host scale to zero PROPR_IDLE_SHUTDOWN',
    content: <IdleShutdownSection />
  }];
}

/** The instance's Sprites, removed before the deployment is deleted; runtime administrators. */
export function agentRuntimeSections(user: CurrentUser | null): SettingsNavigationSection[] {
  if (!canManageAgentRuntime(user)) return [];
  return [{
    id: 'agent-runtime',
    category: 'maintenance',
    searchText: 'agent runtime sprites remove delete cleanup uninstall remove propr delete fly app free plan sprite slots limit leftover orphan',
    content: <InstanceSpritesSection />
  }];
}
