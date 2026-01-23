// Export the main agent class and utilities for library usage
export {
  ClaudeAcpAgent,
  runAcp,
  toAcpNotifications,
  streamEventToAcpNotifications,
  type ToolUpdateMeta,
  type NewSessionMeta,
} from "./acp-agent.js";
export {
  loadManagedSettings,
  applyEnvironmentSettings,
  nodeToWebReadable,
  nodeToWebWritable,
  Pushable,
  unreachable,
} from "./utils.js";
export { createMcpServer } from "./mcp-server.js";
export {
  toolInfoFromToolUse,
  planEntries,
  toolUpdateFromToolResult,
  createPreToolUseHook,
  acpToolNames as toolNames,
  normalizeToolName,
  getCanonicalToolName,
} from "./tools.js";
export {
  SettingsManager,
  type ClaudeCodeSettings,
  type PermissionSettings,
  type PermissionDecision,
  type PermissionCheckResult,
  type SettingsManagerOptions,
} from "./settings.js";

// Export subagent tracking
export {
  SubagentTracker,
  isTaskToolInput,
  extractSubagentMeta,
  type TrackedSubagent,
  type SubagentStatus,
  type SubagentType,
  type SubagentEventType,
  type SubagentUpdateMeta,
  type SubagentEventListener,
  type SubagentStats,
  type TaskToolInput,
  type SerializedTrackerState,
  type SerializedTask,
  type SDKTaskNotification,
} from "./subagent-tracker.js";

// Export task management
export {
  TaskManager,
  type TaskManagerOptions,
  type TaskFilter,
} from "./task-manager.js";

// Export subagent MCP tools registration (tracks Task tool spawning)
export { registerTaskMcpTools, type TaskMcpToolsOptions } from "./task-mcp-tools.js";

// Export work item task store and tools (TaskCreate, TaskGet, TaskUpdate, TaskList)
export {
  TaskStore,
  type Task,
  type TaskStatus,
  type TaskCreateInput,
  type TaskUpdateInput,
  type TaskStoreOptions,
} from "./task-store.js";

export {
  registerWorkItemMcpTools,
  type WorkItemMcpToolsOptions,
} from "./work-item-mcp-tools.js";

// Export types
export type { ClaudePlanEntry } from "./tools.js";