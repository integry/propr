Implemented provider logos for Claude, Gemini, and Codex/OpenAI in the UI.

Changes:
1.  **New Component**: Created `gitfix-ui/src/components/ui/ProviderLogo.tsx` to render SVG logos based on the provider name.
2.  **Task List**: Updated `gitfix-ui/src/components/TaskList/TaskRows.tsx` to replace the robot emoji with the `ProviderLogo` component in both parent and child task rows.
3.  **Settings**: Updated `gitfix-ui/src/pages/SettingsPage/AgentsListSection.tsx` to display the `ProviderLogo` in the agent card header.
4.  **Task Details**: Updated `gitfix-ui/src/components/TaskDetails/MetadataBar.tsx` to include the `ProviderLogo` in the model name badge.

Verified that the UI builds successfully with `npm run build` in `gitfix-ui`.