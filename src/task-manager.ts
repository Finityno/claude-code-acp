import {
  TrackedSubagent,
  SubagentTracker,
  SubagentStatus,
  SerializedTrackerState,
} from "./subagent-tracker.js";
import { Logger } from "./acp-agent.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface TaskManagerOptions {
  /** Path to persistence file. Defaults to ~/.claude/acp-task-state.json */
  persistencePath?: string;
  /** Logger for output. Defaults to console */
  logger?: Logger;
  /** Enable auto-save. Defaults to true */
  autoSave?: boolean;
  /** Auto-save interval in milliseconds. Defaults to 30000 (30 seconds) */
  autoSaveIntervalMs?: number;
  /** Maximum age of tasks to keep in milliseconds. Defaults to 24 hours */
  maxTaskAgeMs?: number;
}

export interface TaskFilter {
  /** Filter by task status */
  status?: SubagentStatus[];
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by background execution */
  runInBackground?: boolean;
  /** Filter by subagent type */
  subagentType?: string;
  /** Only include tasks newer than this timestamp */
  newerThan?: number;
  /** Only include tasks older than this timestamp */
  olderThan?: number;
}

/**
 * TaskManager handles cross-session task persistence and management.
 *
 * It wraps SubagentTracker and provides:
 * - Persistence to disk for background tasks
 * - Cross-session task querying
 * - Resume capability tracking
 * - Task output file reading
 */
export class TaskManager {
  private tracker: SubagentTracker;
  private persistencePath: string;
  private logger: Logger;
  private autoSaveInterval?: NodeJS.Timeout;
  private maxTaskAgeMs: number;
  private isDirty: boolean = false;

  constructor(tracker: SubagentTracker, options?: TaskManagerOptions) {
    this.tracker = tracker;
    this.persistencePath =
      options?.persistencePath ??
      path.join(os.homedir(), ".claude", "acp-task-state.json");
    this.logger = options?.logger ?? console;
    this.maxTaskAgeMs = options?.maxTaskAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours

    // Set up event listeners to mark state as dirty
    this.setupEventListeners();

    if (options?.autoSave !== false) {
      this.startAutoSave(options?.autoSaveIntervalMs ?? 30000);
    }
  }

  /**
   * Load persisted task state from disk
   */
  async loadState(): Promise<void> {
    try {
      if (fs.existsSync(this.persistencePath)) {
        const content = await fs.promises.readFile(this.persistencePath, "utf-8");
        const state = JSON.parse(content) as SerializedTrackerState;

        // Validate state version
        if (state.version !== 1) {
          this.logger.error(
            `[TaskManager] Unknown state version: ${state.version}, skipping load`,
          );
          return;
        }

        // Filter out tasks older than maxTaskAgeMs
        const cutoff = Date.now() - this.maxTaskAgeMs;
        const filteredTasks = state.tasks.filter(
          (task) => task.createdAt > cutoff || task.status === "running",
        );

        // Import filtered state
        this.tracker.importState({
          ...state,
          tasks: filteredTasks,
        });
      }
    } catch (error) {
      this.logger.error("[TaskManager] Failed to load persisted state:", error);
    }
  }

  /**
   * Save current task state to disk
   */
  async saveState(): Promise<void> {
    if (!this.isDirty) {
      return; // No changes to save
    }

    // Clear flag before async operations - any new events will re-set it
    this.isDirty = false;

    try {
      const state = this.tracker.exportState();

      // Ensure directory exists
      const dir = path.dirname(this.persistencePath);
      await fs.promises.mkdir(dir, { recursive: true });

      // Write atomically using temp file
      const tempPath = `${this.persistencePath}.tmp`;
      await fs.promises.writeFile(tempPath, JSON.stringify(state, null, 2), "utf-8");
      await fs.promises.rename(tempPath, this.persistencePath);
    } catch (error) {
      // Restore flag on error so retry will happen
      this.isDirty = true;
      this.logger.error("[TaskManager] Failed to save state:", error);
    }
  }

  /**
   * Force save state immediately
   */
  async forceSave(): Promise<void> {
    this.isDirty = true;
    await this.saveState();
  }

  /**
   * Get all tasks across all sessions with optional filtering
   */
  getAllTasks(filter?: TaskFilter): TrackedSubagent[] {
    let tasks = this.tracker.getAllSubagents();

    if (filter?.status) {
      tasks = tasks.filter((t) => filter.status!.includes(t.status));
    }
    if (filter?.sessionId) {
      tasks = tasks.filter((t) => t.parentSessionId === filter.sessionId);
    }
    if (filter?.runInBackground !== undefined) {
      tasks = tasks.filter((t) => t.runInBackground === filter.runInBackground);
    }
    if (filter?.subagentType) {
      tasks = tasks.filter((t) => t.subagentType === filter.subagentType);
    }
    if (filter?.newerThan !== undefined) {
      tasks = tasks.filter((t) => t.createdAt > filter.newerThan!);
    }
    if (filter?.olderThan !== undefined) {
      tasks = tasks.filter((t) => t.createdAt < filter.olderThan!);
    }

    // Sort by creation time, newest first
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get tasks that can be resumed
   */
  getResumableTasks(): TrackedSubagent[] {
    return this.tracker.getResumableTasks();
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): TrackedSubagent | undefined {
    return this.tracker.getSubagent(taskId);
  }

  /**
   * Get a task by agent ID (for resume operations)
   */
  getTaskByAgentId(agentId: string): TrackedSubagent | undefined {
    return this.tracker.findByAgentId(agentId);
  }

  /**
   * Read output file content for a background task
   */
  async getTaskOutput(taskId: string): Promise<string | null> {
    const task = this.tracker.getSubagent(taskId);
    if (!task?.outputFile) {
      return null;
    }

    try {
      return await fs.promises.readFile(task.outputFile, "utf-8");
    } catch (error) {
      this.logger.error(
        `[TaskManager] Failed to read output file for task ${taskId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Read last N lines of output file for a background task
   */
  async getTaskOutputTail(taskId: string, lines: number): Promise<string | null> {
    const content = await this.getTaskOutput(taskId);
    if (content === null) {
      return null;
    }

    const allLines = content.split("\n");
    return allLines.slice(-lines).join("\n");
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tracker.getSubagent(taskId);
    if (!task || task.status !== "running") {
      return false;
    }

    await this.tracker.cancelSubagent(taskId);
    this.isDirty = true;
    await this.saveState();
    return true;
  }

  /**
   * Get statistics about all tasks
   */
  getStats() {
    return this.tracker.getStats();
  }

  /**
   * Get the underlying tracker
   */
  getTracker(): SubagentTracker {
    return this.tracker;
  }

  /**
   * Clean up old completed tasks
   */
  async cleanup(): Promise<number> {
    const cleaned = this.tracker.cleanup(this.maxTaskAgeMs);
    if (cleaned > 0) {
      this.isDirty = true;
      await this.saveState();
    }
    return cleaned;
  }

  /**
   * Dispose of the task manager
   */
  dispose(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = undefined;
    }

    // Final save on dispose
    this.saveState().catch((error) => {
      this.logger.error("[TaskManager] Failed to save on dispose:", error);
    });
  }

  private setupEventListeners(): void {
    // Mark state as dirty when subagent events occur
    const markDirty = () => {
      this.isDirty = true;
    };

    this.tracker.addEventListener("subagent_started", markDirty);
    this.tracker.addEventListener("subagent_completed", markDirty);
    this.tracker.addEventListener("subagent_failed", markDirty);
    this.tracker.addEventListener("subagent_cancelled", markDirty);
    this.tracker.addEventListener("subagent_stopped", markDirty);
  }

  private startAutoSave(intervalMs: number): void {
    this.autoSaveInterval = setInterval(() => {
      this.saveState().catch((error) => {
        this.logger.error("[TaskManager] Auto-save failed:", error);
      });
    }, intervalMs);

    // Don't prevent process exit
    if (this.autoSaveInterval.unref) {
      this.autoSaveInterval.unref();
    }
  }
}

// Re-export types that users might need
export type { SerializedTrackerState } from "./subagent-tracker.js";