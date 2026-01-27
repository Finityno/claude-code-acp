import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TaskManager } from "./task-manager.js";
import { SubagentStatus, SubagentTracker } from "./subagent-tracker.js";
import { homedir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";

export interface TaskMcpToolsOptions {
  /** The SubagentTracker instance */
  tracker: SubagentTracker;
  /** Optional TaskManager for persistence features */
  taskManager?: TaskManager;
  /** Session ID for context */
  sessionId: string;
}

/**
 * Session entry from Claude Code's sessions-index.json
 */
interface ClaudeSessionEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch?: string;
  projectPath: string;
  isSidechain: boolean;
}

/**
 * Sessions index file format
 */
interface SessionsIndex {
  version: number;
  entries: ClaudeSessionEntry[];
  originalPath: string;
}

/**
 * Get Claude Code's project path for a given working directory
 * Converts /Users/foo/project -> Users-foo-project
 * Handles both Unix and Windows paths safely
 */
function getClaudeProjectPath(workingDir: string): string {
  // Remove Windows drive letters (e.g., C:, D:)
  let sanitized = workingDir.replace(/^[A-Za-z]:/, "");
  // Replace both forward and back slashes with dashes
  sanitized = sanitized.replace(/[/\\]/g, "-");
  // Remove leading dashes and collapse multiple dashes
  sanitized = sanitized.replace(/^-+/, "").replace(/-+/g, "-");
  return sanitized;
}

/**
 * Read sessions from Claude Code's sessions-index.json
 */
async function readClaudeSessions(workingDir?: string): Promise<ClaudeSessionEntry[]> {
  const claudeDir = join(homedir(), ".claude", "projects");
  const sessions: ClaudeSessionEntry[] = [];

  try {
    // If working dir is specified, only read that project's sessions
    if (workingDir) {
      const projectPath = getClaudeProjectPath(workingDir);
      const indexPath = join(claudeDir, projectPath, "sessions-index.json");
      try {
        const content = await readFile(indexPath, "utf8");
        const index: SessionsIndex = JSON.parse(content);
        sessions.push(...index.entries);
      } catch {
        // Project might not exist
      }
    } else {
      // Read all projects' sessions
      const { readdir } = await import("fs/promises");
      const projects = await readdir(claudeDir);

      for (const project of projects) {
        const indexPath = join(claudeDir, project, "sessions-index.json");
        try {
          const content = await readFile(indexPath, "utf8");
          const index: SessionsIndex = JSON.parse(content);
          sessions.push(...index.entries);
        } catch {
          // Skip projects without sessions-index.json
        }
      }
    }

    // Sort by modified date, newest first
    sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  } catch {
    // Claude directory might not exist
  }

  return sessions;
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
        runInBackground: input.backgroundOnly === true ? true : undefined,
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
      if (taskManager) {
        await taskManager.cancelTask(input.taskId);
      } else {
        await tracker.cancelSubagent(input.taskId);
      }
      return { content: [{ type: "text", text: `Task ${input.taskId} cancelled` }] };
    },
  );

  // List resumable tasks - reads from Claude Code's sessions-index.json
  server.registerTool(
    "ListResumableTasks",
    {
      title: "List Resumable Tasks",
      description: `List previous Claude Code sessions that can be resumed via Task tool's resume parameter.
Reads from Claude Code's sessions storage (~/.claude/projects/) to find resumable sessions.
Also shows in-memory tracked subagents that haven't been persisted yet.`,
      inputSchema: {
        limit: z.number().optional().default(10).describe("Maximum number of sessions to return"),
        projectPath: z.string().optional().describe("Filter to sessions from a specific project path"),
      },
      annotations: {
        title: "List resumable tasks",
        readOnlyHint: true,
      },
    },
    async (input) => {
      // Get sessions from Claude Code's storage
      const claudeSessions = await readClaudeSessions(input.projectPath);
      const limited = claudeSessions.slice(0, input.limit);

      // Also get in-memory tracked subagents (for current session)
      const inMemoryTasks = tracker.getResumableTasks();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: limited.length,
            tasks: limited.map((s) => ({
              sessionId: s.sessionId,
              summary: s.summary,
              firstPrompt: s.firstPrompt.substring(0, 100) + (s.firstPrompt.length > 100 ? "..." : ""),
              messageCount: s.messageCount,
              created: s.created,
              modified: s.modified,
              gitBranch: s.gitBranch,
              projectPath: s.projectPath,
            })),
            // Also include in-memory subagents not yet persisted
            inMemorySubagents: inMemoryTasks.length > 0 ? inMemoryTasks.map((t) => ({
              id: t.id,
              agentId: t.agentId,
              type: t.subagentType,
              description: t.description,
              status: t.status,
              completedAt: t.completedAt ? new Date(t.completedAt).toISOString() : undefined,
              summary: t.summary,
            })) : undefined,
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