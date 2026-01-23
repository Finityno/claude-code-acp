import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TaskManager } from "./task-manager.js";
import { SubagentStatus, SubagentTracker } from "./subagent-tracker.js";

export interface TaskMcpToolsOptions {
  /** The SubagentTracker instance */
  tracker: SubagentTracker;
  /** Optional TaskManager for persistence features */
  taskManager?: TaskManager;
  /** Session ID for context */
  sessionId: string;
}

/**
 * Register MCP tools for task management
 */
export function registerTaskMcpTools(
  server: McpServer,
  options: TaskMcpToolsOptions,
): void {
  const { tracker, taskManager, sessionId } = options;

  // List all tasks
  server.registerTool(
    "ListTasks",
    {
      title: "List Tasks",
      description: `List all tracked tasks/subagents across sessions.
Use this to see running, completed, failed, or cancelled tasks.
Can filter by status, session, or background execution.`,
      inputSchema: {
        status: z
          .array(z.enum(["pending", "running", "completed", "failed", "cancelled", "stopped"]))
          .optional()
          .describe("Filter by task status"),
        sessionId: z.string().optional().describe("Filter by session ID"),
        backgroundOnly: z.boolean().optional().describe("Only show background tasks"),
        subagentType: z.string().optional().describe("Filter by subagent type"),
        limit: z.number().optional().default(20).describe("Maximum number of tasks to return"),
      },
      annotations: {
        title: "List tasks",
        readOnlyHint: true,
      },
    },
    async (input) => {
      const manager = taskManager ?? createTempManager(tracker);
      const tasks = manager.getAllTasks({
        status: input.status as SubagentStatus[] | undefined,
        sessionId: input.sessionId,
        runInBackground: input.backgroundOnly,
        subagentType: input.subagentType,
      });
      const limited = tasks.slice(0, input.limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: tasks.length,
            returned: limited.length,
            tasks: limited.map((t) => ({
              id: t.id,
              type: t.subagentType,
              description: t.description,
              status: t.status,
              runInBackground: t.runInBackground,
              createdAt: new Date(t.createdAt).toISOString(),
              durationMs: t.completedAt && t.startedAt ? t.completedAt - t.startedAt : undefined,
              agentId: t.agentId,
              canResume: !!(t.agentId && ["completed", "failed", "stopped"].includes(t.status)),
              summary: t.summary,
            })),
          }, null, 2),
        }],
      };
    },
  );

  // Get task status
  server.registerTool(
    "GetTaskStatus",
    {
      title: "Get Task Status",
      description: "Get detailed status and metadata for a specific task.",
      inputSchema: {
        taskId: z.string().describe("The task ID to get status for"),
      },
      annotations: {
        title: "Get task status",
        readOnlyHint: true,
      },
    },
    async (input) => {
      const task = tracker.getSubagent(input.taskId);
      if (!task) {
        return {
          isError: true,
          content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: task.id,
            type: task.subagentType,
            description: task.description,
            prompt: task.prompt,
            status: task.status,
            model: task.model,
            runInBackground: task.runInBackground,
            parentSessionId: task.parentSessionId,
            parentToolUseId: task.parentToolUseId,
            createdAt: new Date(task.createdAt).toISOString(),
            startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
            completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
            durationMs: task.completedAt && task.startedAt ? task.completedAt - task.startedAt : undefined,
            agentId: task.agentId,
            agentName: task.agentName,
            teamName: task.teamName,
            permissionMode: task.permissionMode,
            outputFile: task.outputFile,
            summary: task.summary,
            result: task.result,
            error: task.error,
            isResumed: task.isResumed,
            originalTaskId: task.originalTaskId,
            canResume: !!(task.agentId && ["completed", "failed", "stopped"].includes(task.status)),
          }, null, 2),
        }],
      };
    },
  );

  // Get task output
  server.registerTool(
    "GetTaskOutput",
    {
      title: "Get Task Output",
      description: "Read output file content for a background task.",
      inputSchema: {
        taskId: z.string().describe("The task ID to get output for"),
        tail: z.number().optional().describe("Only return last N lines"),
      },
      annotations: {
        title: "Get task output",
        readOnlyHint: true,
      },
    },
    async (input) => {
      const task = tracker.getSubagent(input.taskId);
      if (!task) {
        return {
          isError: true,
          content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
        };
      }
      if (!task.outputFile) {
        return {
          isError: true,
          content: [{ type: "text", text: `Task ${input.taskId} has no output file` }],
        };
      }
      const manager = taskManager ?? createTempManager(tracker);
      const output = input.tail
        ? await manager.getTaskOutputTail(input.taskId, input.tail)
        : await manager.getTaskOutput(input.taskId);
      if (output === null) {
        return {
          isError: true,
          content: [{ type: "text", text: `Output file not found: ${task.outputFile}` }],
        };
      }
      return { content: [{ type: "text", text: output }] };
    },
  );

  // Cancel task
  server.registerTool(
    "CancelTask",
    {
      title: "Cancel Task",
      description: "Cancel a running task/subagent.",
      inputSchema: {
        taskId: z.string().describe("The task ID to cancel"),
      },
      annotations: {
        title: "Cancel task",
        destructiveHint: true,
      },
    },
    async (input) => {
      const task = tracker.getSubagent(input.taskId);
      if (!task) {
        return {
          isError: true,
          content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
        };
      }
      if (task.status !== "running") {
        return {
          isError: true,
          content: [{ type: "text", text: `Task not running: ${task.status}` }],
        };
      }
      await tracker.cancelSubagent(input.taskId);
      return { content: [{ type: "text", text: `Task ${input.taskId} cancelled` }] };
    },
  );

  // List resumable tasks
  server.registerTool(
    "ListResumableTasks",
    {
      title: "List Resumable Tasks",
      description: "List tasks that can be resumed via Task tool's resume parameter.",
      inputSchema: {
        limit: z.number().optional().default(10).describe("Maximum number of tasks to return"),
      },
      annotations: {
        title: "List resumable tasks",
        readOnlyHint: true,
      },
    },
    async (input) => {
      const tasks = tracker.getResumableTasks().slice(0, input.limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: tasks.length,
            tasks: tasks.map((t) => ({
              id: t.id,
              agentId: t.agentId,
              type: t.subagentType,
              description: t.description,
              status: t.status,
              completedAt: t.completedAt ? new Date(t.completedAt).toISOString() : undefined,
              summary: t.summary,
              error: t.error,
            })),
          }, null, 2),
        }],
      };
    },
  );

  // Get task stats
  server.registerTool(
    "GetTaskStats",
    {
      title: "Get Task Statistics",
      description: "Get statistics about all tracked tasks.",
      inputSchema: {},
      annotations: {
        title: "Get task statistics",
        readOnlyHint: true,
      },
    },
    async () => {
      const stats = tracker.getStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    },
  );

  // Get running tasks
  server.registerTool(
    "GetRunningTasks",
    {
      title: "Get Running Tasks",
      description: "Get all currently running tasks.",
      inputSchema: {
        allSessions: z.boolean().optional().default(false).describe("Include all sessions"),
      },
      annotations: {
        title: "Get running tasks",
        readOnlyHint: true,
      },
    },
    async (input) => {
      const tasks = input.allSessions
        ? tracker.getRunningSubagents()
        : tracker.getRunningSubagentsForSession(sessionId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: tasks.length,
            tasks: tasks.map((t) => ({
              id: t.id,
              type: t.subagentType,
              description: t.description,
              runInBackground: t.runInBackground,
              startedAt: t.startedAt ? new Date(t.startedAt).toISOString() : undefined,
              elapsedMs: t.startedAt ? Date.now() - t.startedAt : undefined,
            })),
          }, null, 2),
        }],
      };
    },
  );
}

function createTempManager(tracker: SubagentTracker): TaskManager {
  return new TaskManager(tracker, { autoSave: false });
}
