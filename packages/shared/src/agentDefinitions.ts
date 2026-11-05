/** @deprecated Import automation definitions from automationDefinitions instead. */
export * from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_CAPABILITIES. */
export { AUTOMATION_CAPABILITIES as AGENT_CAPABILITIES } from './automationDefinitions.js';
/** @deprecated Use AutomationCapability. */
export type { AutomationCapability as AgentCapability } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_AUTONOMY_MODES. */
export { AUTOMATION_AUTONOMY_MODES as AGENT_AUTONOMY_MODES } from './automationDefinitions.js';
/** @deprecated Use AutomationAutonomyMode. */
export type { AutomationAutonomyMode as AgentAutonomyMode } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_RUN_TRIGGERS. */
export { AUTOMATION_RUN_TRIGGERS as AGENT_RUN_TRIGGERS } from './automationDefinitions.js';
/** @deprecated Use AutomationRunTrigger. */
export type { AutomationRunTrigger as AgentRunTrigger } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_RUN_STATES. */
export { AUTOMATION_RUN_STATES as AGENT_RUN_STATES } from './automationDefinitions.js';
/** @deprecated Use AutomationRunState. */
export type { AutomationRunState as AgentRunState } from './automationDefinitions.js';
/** @deprecated Use TERMINAL_AUTOMATION_RUN_STATES. */
export { TERMINAL_AUTOMATION_RUN_STATES as TERMINAL_AGENT_RUN_STATES } from './automationDefinitions.js';
/** @deprecated Use TerminalAutomationRunState. */
export type { TerminalAutomationRunState as TerminalAgentRunState } from './automationDefinitions.js';
/** @deprecated Use DEFAULT_AUTOMATION_CAPABILITIES. */
export { DEFAULT_AUTOMATION_CAPABILITIES as DEFAULT_AGENT_CAPABILITIES } from './automationDefinitions.js';
/** @deprecated Use DEFAULT_AUTOMATION_AUTONOMY_MODE. */
export { DEFAULT_AUTOMATION_AUTONOMY_MODE as DEFAULT_AGENT_AUTONOMY_MODE } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_NAME_MAX_LENGTH. */
export { AUTOMATION_NAME_MAX_LENGTH as AGENT_NAME_MAX_LENGTH } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_DESCRIPTION_MAX_LENGTH. */
export { AUTOMATION_DESCRIPTION_MAX_LENGTH as AGENT_DESCRIPTION_MAX_LENGTH } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_PROMPT_MAX_LENGTH. */
export { AUTOMATION_PROMPT_MAX_LENGTH as AGENT_PROMPT_MAX_LENGTH } from './automationDefinitions.js';
/** @deprecated Use MAX_AUTOMATION_REPOSITORIES. */
export { MAX_AUTOMATION_REPOSITORIES as MAX_AGENT_REPOSITORIES } from './automationDefinitions.js';
/** @deprecated Use MAX_AUTOMATION_ATTACHMENTS. */
export { MAX_AUTOMATION_ATTACHMENTS as MAX_AGENT_ATTACHMENTS } from './automationDefinitions.js';
/** @deprecated Use MAX_AUTOMATION_PREVIOUS_REPORTS. */
export { MAX_AUTOMATION_PREVIOUS_REPORTS as MAX_AGENT_PREVIOUS_REPORTS } from './automationDefinitions.js';
/** @deprecated Use DEFAULT_AUTOMATION_PREVIOUS_REPORTS. */
export { DEFAULT_AUTOMATION_PREVIOUS_REPORTS as DEFAULT_AGENT_PREVIOUS_REPORTS } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_PREVIOUS_REPORTS_MAX_CHARACTERS. */
export { AUTOMATION_PREVIOUS_REPORTS_MAX_CHARACTERS as AGENT_PREVIOUS_REPORTS_MAX_CHARACTERS } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_PREVIOUS_REPORT_MAX_CHARS. */
export { AUTOMATION_PREVIOUS_REPORT_MAX_CHARS as AGENT_PREVIOUS_REPORT_MAX_CHARS } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_REPORT_PROMPT_MAX_CHARS. */
export { AUTOMATION_REPORT_PROMPT_MAX_CHARS as AGENT_REPORT_PROMPT_MAX_CHARS } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_REPORT_MAX_CHARS. */
export { AUTOMATION_REPORT_MAX_CHARS as AGENT_REPORT_MAX_CHARS } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_ACTION_OPERATOR_NOTE_MAX_CHARS. */
export { AUTOMATION_ACTION_OPERATOR_NOTE_MAX_CHARS as AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS } from './automationDefinitions.js';
/** @deprecated Use AUTOMATION_ACTION_SUMMARY_MAX_CHARS. */
export { AUTOMATION_ACTION_SUMMARY_MAX_CHARS as AGENT_ACTION_SUMMARY_MAX_CHARS } from './automationDefinitions.js';
/** @deprecated Use AutomationDefinitionInput. */
export type { AutomationDefinitionInput as AgentDefinitionInput } from './automationDefinitions.js';
/** @deprecated Use AutomationDefinition. */
export type { AutomationDefinition as AgentDefinition } from './automationDefinitions.js';
/** @deprecated Use AutomationRunAttachment. */
export type { AutomationRunAttachment as AgentRunAttachment } from './automationDefinitions.js';
/** @deprecated Use AutomationRun. */
export type AgentRun = Omit<import('./automationDefinitions.js').AutomationRun, 'automationDefinitionId'> & { agentDefinitionId: string };
/** @deprecated Use AUTOMATION_DEFINITION_CONTRACT. */
export { AUTOMATION_DEFINITION_CONTRACT as AGENT_DEFINITION_CONTRACT } from './automationDefinitions.js';
/** @deprecated Use isAutomationCapability. */
export { isAutomationCapability as isAgentCapability } from './automationDefinitions.js';
/** @deprecated Use isAutomationAutonomyMode. */
export { isAutomationAutonomyMode as isAgentAutonomyMode } from './automationDefinitions.js';
/** @deprecated Use isAutomationRunTrigger. */
export { isAutomationRunTrigger as isAgentRunTrigger } from './automationDefinitions.js';
/** @deprecated Use isAutomationRunState. */
export { isAutomationRunState as isAgentRunState } from './automationDefinitions.js';
/** @deprecated Use isTerminalAutomationRunState. */
export { isTerminalAutomationRunState as isTerminalAgentRunState } from './automationDefinitions.js';
/** @deprecated Use validateAutomationDefinitionInput. */
export { validateAutomationDefinitionInput as validateAgentDefinitionInput } from './automationDefinitions.js';
