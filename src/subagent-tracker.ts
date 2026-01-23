import { SessionNotification, AgentSideConnection } from "@agentclientprotocol/sdk";
import { Logger } from "./acp-agent.js";
import { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/**
 * Subagent status lifecycle
 */
export type SubagentStatus =
  | "pending" // Created but not started
  | "running" // Currently executing
  | "completed" // Finished successfully
  | "failed" // Finished with error
  | "cancelled" // Interrupted by user
  | "stopped"; // Stopped by SDK (background task)

/**
 * Subagent type from Claude Code Task tool
 */
export type SubagentType =
  | "Bash"
  | "general-purpose"
  | "statusline-setup"
  | "Explore"
  | "Plan"
  | "claude-code-guide"
  | string; // Allow custom types

/**
 * Tracked subagent information
 */
export interface TrackedSubagent {
  /** Unique ID for this subagent (same as tool_use_id) */
  id: string;

  /** Parent session ID where this subagent was spawned */
  parentSessionId: string;

  /** Parent tool use ID if this is a nested subagent */
  parentToolUseId?: string;

  /** Type of subagent */
  subagentType: SubagentType;

  /** Short description of what the subagent is doing */
  description: string;

  /** Full prompt given to the subagent */
  prompt: string;

  /** Model used for this subagent (if specified) */
  model?: "sonnet" | "opus" | "haiku";

  /** Current status */
  status: SubagentStatus;

  /** Timestamp when subagent was created */
  createdAt: number;

  /** Timestamp when subagent started running */
  startedAt?: number;

  /** Timestamp when subagent completed */
  completedAt?: number;

  /** Result from the subagent (if completed) */
  result?: unknown;

  /** Error message (if failed) */
  error?: string;

  /** Whether this subagent is running in background */
  runInBackground: boolean;

  /** Maximum turns allowed */
  maxTurns?: number;

  /** Agent ID returned by Claude Code (for resume capability) */
  agentId?: string;

  // SDK 0.2.17 new fields

  /** Output file path for background tasks (from SDK task_notification) */
  outputFile?: string;

  /** Summary of task result (from SDK task_notification) */
  summary?: string;

  /** Name given to the spawned agent */
  agentName?: string;

  /** Team name if spawned as teammate */
  teamName?: string;

  /** Permission mode used for this task */
  permissionMode?: PermissionMode;

  /** Whether this task was resumed from a previous execution */
  isResumed?: boolean;

  /** Original task ID if this is a resumed task */
  originalTaskId?: string;
}

/**
 * Subagent event types for notifications
 */
export type SubagentEventType =
  | "subagent_started"
  | "subagent_progress"
  | "subagent_completed"
  | "subagent_failed"
  | "subagent_cancelled"
  | "subagent_stopped";

/**
 * Metadata for subagent-related notifications
 */
export interface SubagentUpdateMeta {
  [key: string]: unknown;
  claudeCode?: {
    subagent: {
      id: string;
      eventType: SubagentEventType;
      subagentType: SubagentType;
      description: string;
      status: SubagentStatus;
      parentSessionId: string;
      parentToolUseId?: string;
      model?: string;
      runInBackground: boolean;
      agentId?: string;
      /** Duration in milliseconds (for completed/failed events) */
      durationMs?: number;
      /** Output file for background tasks */
      outputFile?: string;
      /** Summary from SDK task notification */
      summary?: string;
    };
    /** Task notification from SDK (for background tasks) */
    taskNotification?: {
      taskId: string;
      status: "completed" | "failed" | "stopped";
      outputFile: string;
      summary: string;
    };
  };
}

/**
 * Input structure for the Task tool
 */
export interface TaskToolInput {
  description: string;
  prompt: string;
  subagent_type: SubagentType;
  model?: "sonnet" | "opus" | "haiku";
  max_turns?: number;
  run_in_background?: boolean;
  /** Agent ID to resume from (SDK 0.2.17) */
  resume?: string;
  /** Name for spawned agent (SDK 0.2.17) */
  name?: string;
  /** Team name for spawning (SDK 0.2.17) */
  team_name?: string;
  /** Permission mode for spawned teammate (SDK 0.2.17) */
  mode?: PermissionMode;
}

// Type definitions for event listeners
export type SubagentEventListener = (
  subagent: TrackedSubagent,
  data?: unknown,
) => void | Promise<void>;

export interface SubagentStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  stopped: number;
  byType: Record<string, number>;
  averageDurationMs?: number;
}

/**
 * Serializable state for task persistence
 */
export interface SerializedTrackerState {
  version: number;
  tasks: SerializedTask[];
  lastUpdated: number;
}

export interface SerializedTask {
  id: string;
  parentSessionId: string;
  parentToolUseId?: string;
  subagentType: string;
  description: string;
  prompt: string;
  model?: string;
  status: SubagentStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
  runInBackground: boolean;
  maxTurns?: number;
  agentId?: string;
  outputFile?: string;
  summary?: string;
  agentName?: string;
  teamName?: string;
  permissionMode?: string;
  isResumed?: boolean;
  originalTaskId?: string;
}

/**
 * SDK Task Notification from SDKTaskNotificationMessage
 */
export interface SDKTaskNotification {
  task_id: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
}

/**
 * SubagentTracker manages the lifecycle of all subagents spawned via the Task tool
 */
export class SubagentTracker {
  /** Map of subagent ID to tracked subagent data */
  private subagents: Map<string, TrackedSubagent> = new Map();

  /** Map of session ID to subagent IDs in that session */
  private sessionSubagents: Map<string, Set<string>> = new Map();

  /** Map of agent ID to subagent ID (for resume lookups) */
  private agentIdToSubagent: Map<string, string> = new Map();

  /** Event listeners for subagent lifecycle events */
  private listeners: Map<SubagentEventType, Set<SubagentEventListener>> = new Map();

  private client: AgentSideConnection | null;
  private logger: Logger;

  constructor(client: AgentSideConnection | null = null, logger: Logger = console) {
    this.client = client;
    this.logger = logger;
  }

  /**
   * Track a new subagent when Task tool is called
   */
  trackSubagent(
    toolUseId: string,
    sessionId: string,
    input: TaskToolInput,
    parentToolUseId?: string,
  ): TrackedSubagent {
    // Check if this is a resume operation
    const isResumed = !!input.resume;
    const originalTaskId = input.resume
      ? this.agentIdToSubagent.get(input.resume)
      : undefined;

    const subagent: TrackedSubagent = {
      id: toolUseId,
      parentSessionId: sessionId,
      parentToolUseId,
      subagentType: input.subagent_type,
      description: input.description,
      prompt: input.prompt,
      model: input.model,
      status: "pending",
      createdAt: Date.now(),
      runInBackground: input.run_in_background ?? false,
      maxTurns: input.max_turns,
      // SDK 0.2.17 fields
      agentName: input.name,
      teamName: input.team_name,
      permissionMode: input.mode,
      isResumed,
      originalTaskId,
    };

    this.subagents.set(toolUseId, subagent);

    // Track by session
    if (!this.sessionSubagents.has(sessionId)) {
      this.sessionSubagents.set(sessionId, new Set());
    }
    this.sessionSubagents.get(sessionId)!.add(toolUseId);

    this.logger.log(
      `[SubagentTracker] Tracked new subagent: ${toolUseId} (${input.subagent_type}: ${input.description})${isResumed ? " [RESUMED]" : ""}`,
    );

    return subagent;
  }

  /**
   * Mark a subagent as started/running
   */
  async startSubagent(toolUseId: string): Promise<void> {
    const subagent = this.subagents.get(toolUseId);
    if (!subagent) {
      this.logger.error(`[SubagentTracker] Cannot start unknown subagent: ${toolUseId}`);
      return;
    }

    subagent.status = "running";
    subagent.startedAt = Date.now();

    await this.emitEvent("subagent_started", subagent);
    await this.sendSubagentNotification(subagent, "subagent_started");
  }

  /**
   * Mark a subagent as completed successfully
   */
  async completeSubagent(toolUseId: string, result?: unknown, agentId?: string): Promise<void> {
    const subagent = this.subagents.get(toolUseId);
    if (!subagent) {
      this.logger.error(`[SubagentTracker] Cannot complete unknown subagent: ${toolUseId}`);
      return;
    }

    subagent.status = "completed";
    subagent.completedAt = Date.now();
    subagent.result = result;
    if (agentId) {
      subagent.agentId = agentId;
      // Track agent ID for resume lookups
      this.agentIdToSubagent.set(agentId, toolUseId);
    }

    await this.emitEvent("subagent_completed", subagent);
    await this.sendSubagentNotification(subagent, "subagent_completed");

    this.logger.log(
      `[SubagentTracker] Subagent completed: ${toolUseId} (duration: ${this.getDuration(subagent)}ms)${agentId ? ` [agentId: ${agentId}]` : ""}`,
    );
  }

  /**
   * Mark a subagent as failed
   */
  async failSubagent(toolUseId: string, error: string): Promise<void> {
    const subagent = this.subagents.get(toolUseId);
    if (!subagent) {
      this.logger.error(`[SubagentTracker] Cannot fail unknown subagent: ${toolUseId}`);
      return;
    }

    subagent.status = "failed";
    subagent.completedAt = Date.now();
    subagent.error = error;

    await this.emitEvent("subagent_failed", subagent);
    await this.sendSubagentNotification(subagent, "subagent_failed");

    this.logger.error(`[SubagentTracker] Subagent failed: ${toolUseId} - ${error}`);
  }

  /**
   * Mark a subagent as cancelled
   */
  async cancelSubagent(toolUseId: string): Promise<void> {
    const subagent = this.subagents.get(toolUseId);
    if (!subagent) {
      return; // Silent fail for cancel - may not be tracked
    }

    subagent.status = "cancelled";
    subagent.completedAt = Date.now();

    await this.emitEvent("subagent_cancelled", subagent);
    await this.sendSubagentNotification(subagent, "subagent_cancelled");

    this.logger.log(`[SubagentTracker] Subagent cancelled: ${toolUseId}`);
  }

  /**
   * Handle SDKTaskNotificationMessage from the Claude Agent SDK.
   * This is called when a background task completes/fails/stops.
   */
  async handleTaskNotification(notification: SDKTaskNotification): Promise<void> {
    const subagent = this.subagents.get(notification.task_id);
    if (!subagent) {
      this.logger.error(
        `[SubagentTracker] Received task notification for unknown subagent: ${notification.task_id}`,
      );
      return;
    }

    // Update subagent with notification data
    subagent.outputFile = notification.output_file;
    subagent.summary = notification.summary;
    subagent.completedAt = Date.now();

    // Map SDK status to our status
    switch (notification.status) {
      case "completed":
        subagent.status = "completed";
        await this.emitEvent("subagent_completed", subagent);
        await this.sendSubagentNotification(subagent, "subagent_completed", notification);
        break;
      case "failed":
        subagent.status = "failed";
        await this.emitEvent("subagent_failed", subagent);
        await this.sendSubagentNotification(subagent, "subagent_failed", notification);
        break;
      case "stopped":
        subagent.status = "stopped";
        await this.emitEvent("subagent_stopped", subagent);
        await this.sendSubagentNotification(subagent, "subagent_stopped", notification);
        break;
    }

    this.logger.log(
      `[SubagentTracker] Task notification: ${notification.task_id} -> ${notification.status}`,
    );
  }

  /**
   * Send progress update for a running subagent
   */
  async updateProgress(toolUseId: string, progressData?: unknown): Promise<void> {
    const subagent = this.subagents.get(toolUseId);
    if (!subagent || subagent.status !== "running") {
      return;
    }

    await this.emitEvent("subagent_progress", subagent, progressData);
    await this.sendSubagentNotification(subagent, "subagent_progress");
  }

  /**
   * Get a tracked subagent by ID
   */
  getSubagent(toolUseId: string): TrackedSubagent | undefined {
    return this.subagents.get(toolUseId);
  }

  /**
   * Get all subagents for a session
   */
  getSessionSubagents(sessionId: string): TrackedSubagent[] {
    const ids = this.sessionSubagents.get(sessionId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.subagents.get(id))
      .filter((s): s is TrackedSubagent => s !== undefined);
  }

  /**
   * Get all currently running subagents
   */
  getRunningSubagents(): TrackedSubagent[] {
    return Array.from(this.subagents.values()).filter((s) => s.status === "running");
  }

  /**
   * Get running subagents for a specific session, sorted by start time (most recent first)
   */
  getRunningSubagentsForSession(sessionId: string): TrackedSubagent[] {
    const sessionIds = this.sessionSubagents.get(sessionId);
    if (!sessionIds) return [];

    return Array.from(sessionIds)
      .map((id) => this.subagents.get(id))
      .filter((s): s is TrackedSubagent => s !== undefined && s.status === "running")
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)); // Most recent first
  }

  /**
   * Get the most recently started running subagent for a session.
   * This is used to associate tool calls with their parent subagent.
   * Returns undefined if no subagent is currently running.
   */
  getActiveSubagent(sessionId: string): TrackedSubagent | undefined {
    const running = this.getRunningSubagentsForSession(sessionId);
    return running.length > 0 ? running[0] : undefined;
  }

  /**
   * Get all subagents (for debugging/monitoring)
   */
  getAllSubagents(): TrackedSubagent[] {
    return Array.from(this.subagents.values());
  }

  /**
   * Find a subagent by its agent ID (for resume operations)
   */
  findByAgentId(agentId: string): TrackedSubagent | undefined {
    const subagentId = this.agentIdToSubagent.get(agentId);
    if (!subagentId) return undefined;
    return this.subagents.get(subagentId);
  }

  /**
   * Get tasks that can be resumed (have agentId and are completed/failed/stopped)
   */
  getResumableTasks(): TrackedSubagent[] {
    return Array.from(this.subagents.values()).filter(
      (s) =>
        s.agentId &&
        (s.status === "completed" || s.status === "failed" || s.status === "stopped"),
    );
  }

  /**
   * Check if a tool use ID is a Task tool (subagent)
   */
  isSubagent(toolUseId: string): boolean {
    return this.subagents.has(toolUseId);
  }

  /**
   * Add event listener for subagent lifecycle events
   */
  addEventListener(event: SubagentEventType, listener: SubagentEventListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(event: SubagentEventType, listener: SubagentEventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  /**
   * Clean up completed subagents older than given age (in ms)
   */
  cleanup(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [id, subagent] of this.subagents) {
      if (
        (subagent.status === "completed" ||
          subagent.status === "failed" ||
          subagent.status === "cancelled" ||
          subagent.status === "stopped") &&
        subagent.completedAt &&
        now - subagent.completedAt > maxAgeMs
      ) {
        this.subagents.delete(id);
        this.sessionSubagents.get(subagent.parentSessionId)?.delete(id);
        if (subagent.agentId) {
          this.agentIdToSubagent.delete(subagent.agentId);
        }
        cleanedCount++;
      }
    }

    return cleanedCount;
  }

  /**
   * Export current state for persistence
   */
  exportState(): SerializedTrackerState {
    const tasks: SerializedTask[] = Array.from(this.subagents.values()).map((s) => ({
      id: s.id,
      parentSessionId: s.parentSessionId,
      parentToolUseId: s.parentToolUseId,
      subagentType: s.subagentType,
      description: s.description,
      prompt: s.prompt,
      model: s.model,
      status: s.status,
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      result: s.result,
      error: s.error,
      runInBackground: s.runInBackground,
      maxTurns: s.maxTurns,
      agentId: s.agentId,
      outputFile: s.outputFile,
      summary: s.summary,
      agentName: s.agentName,
      teamName: s.teamName,
      permissionMode: s.permissionMode,
      isResumed: s.isResumed,
      originalTaskId: s.originalTaskId,
    }));

    return {
      version: 1,
      tasks,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Import state from persistence
   */
  importState(state: SerializedTrackerState): void {
    if (state.version !== 1) {
      this.logger.error(`[SubagentTracker] Unknown state version: ${state.version}`);
      return;
    }

    for (const task of state.tasks) {
      const subagent: TrackedSubagent = {
        id: task.id,
        parentSessionId: task.parentSessionId,
        parentToolUseId: task.parentToolUseId,
        subagentType: task.subagentType as SubagentType,
        description: task.description,
        prompt: task.prompt,
        model: task.model as TrackedSubagent["model"],
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        result: task.result,
        error: task.error,
        runInBackground: task.runInBackground,
        maxTurns: task.maxTurns,
        agentId: task.agentId,
        outputFile: task.outputFile,
        summary: task.summary,
        agentName: task.agentName,
        teamName: task.teamName,
        permissionMode: task.permissionMode as PermissionMode | undefined,
        isResumed: task.isResumed,
        originalTaskId: task.originalTaskId,
      };

      this.subagents.set(task.id, subagent);

      // Rebuild session index
      if (!this.sessionSubagents.has(task.parentSessionId)) {
        this.sessionSubagents.set(task.parentSessionId, new Set());
      }
      this.sessionSubagents.get(task.parentSessionId)!.add(task.id);

      // Rebuild agent ID index
      if (task.agentId) {
        this.agentIdToSubagent.set(task.agentId, task.id);
      }
    }

    this.logger.log(`[SubagentTracker] Imported ${state.tasks.length} tasks from persistence`);
  }

  /**
   * Get statistics about subagents
   */
  getStats(): SubagentStats {
    const subagents = Array.from(this.subagents.values());
    return {
      total: subagents.length,
      pending: subagents.filter((s) => s.status === "pending").length,
      running: subagents.filter((s) => s.status === "running").length,
      completed: subagents.filter((s) => s.status === "completed").length,
      failed: subagents.filter((s) => s.status === "failed").length,
      cancelled: subagents.filter((s) => s.status === "cancelled").length,
      stopped: subagents.filter((s) => s.status === "stopped").length,
      byType: this.countByType(subagents),
      averageDurationMs: this.calculateAverageDuration(subagents),
    };
  }

  /**
   * Clear all tracked subagents (useful for testing)
   */
  clear(): void {
    this.subagents.clear();
    this.sessionSubagents.clear();
    this.agentIdToSubagent.clear();
  }

  // Private helper methods

  private async emitEvent(
    event: SubagentEventType,
    subagent: TrackedSubagent,
    data?: unknown,
  ): Promise<void> {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    for (const listener of listeners) {
      try {
        await listener(subagent, data);
      } catch (err) {
        this.logger.error(`[SubagentTracker] Error in event listener:`, err);
      }
    }
  }

  private async sendSubagentNotification(
    subagent: TrackedSubagent,
    eventType: SubagentEventType,
    taskNotification?: SDKTaskNotification,
  ): Promise<void> {
    if (!this.client) return;

    const meta: SubagentUpdateMeta = {
      claudeCode: {
        subagent: {
          id: subagent.id,
          eventType,
          subagentType: subagent.subagentType,
          description: subagent.description,
          status: subagent.status,
          parentSessionId: subagent.parentSessionId,
          parentToolUseId: subagent.parentToolUseId,
          model: subagent.model,
          runInBackground: subagent.runInBackground,
          agentId: subagent.agentId,
          durationMs: this.getDuration(subagent),
          outputFile: subagent.outputFile,
          summary: subagent.summary,
        },
      },
    };

    // Include task notification data if available
    if (taskNotification) {
      meta.claudeCode!.taskNotification = {
        taskId: taskNotification.task_id,
        status: taskNotification.status,
        outputFile: taskNotification.output_file,
        summary: taskNotification.summary,
      };
    }

    const notification: SessionNotification = {
      sessionId: subagent.parentSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: subagent.id,
        _meta: meta,
      },
    };

    await this.client.sessionUpdate(notification);
  }

  private getDuration(subagent: TrackedSubagent): number | undefined {
    if (!subagent.startedAt) return undefined;
    const endTime = subagent.completedAt ?? Date.now();
    return endTime - subagent.startedAt;
  }

  private countByType(subagents: TrackedSubagent[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of subagents) {
      counts[s.subagentType] = (counts[s.subagentType] || 0) + 1;
    }
    return counts;
  }

  private calculateAverageDuration(subagents: TrackedSubagent[]): number | undefined {
    const completed = subagents.filter(
      (s) =>
        (s.status === "completed" || s.status === "failed" || s.status === "stopped") &&
        s.startedAt &&
        s.completedAt,
    );
    if (completed.length === 0) return undefined;

    const totalDuration = completed.reduce((sum, s) => sum + (s.completedAt! - s.startedAt!), 0);
    return Math.round(totalDuration / completed.length);
  }
}

/**
 * Utility to check if a tool input is for the Task tool
 */
export function isTaskToolInput(input: unknown): input is TaskToolInput {
  return (
    typeof input === "object" &&
    input !== null &&
    "prompt" in input &&
    "subagent_type" in input &&
    "description" in input
  );
}

/**
 * Extract subagent metadata from Task tool input
 */
export function extractSubagentMeta(input: TaskToolInput): {
  description: string;
  subagentType: string;
  model?: string;
  runInBackground: boolean;
  maxTurns?: number;
} {
  return {
    description: input.description,
    subagentType: input.subagent_type,
    model: input.model,
    runInBackground: input.run_in_background ?? false,
    maxTurns: input.max_turns,
  };
}