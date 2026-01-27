import { mkdir, readFile, writeFile, readdir, rm, watch } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { FSWatcher } from "fs";
import { Logger } from "./acp-agent.js";

/**
 * Task status matching Claude Code's internal system
 */
export type TaskStatus = "pending" | "in_progress" | "completed";

/**
 * Task structure matching Claude Code's ~/.claude/tasks/ format
 */
export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new task
 */
export interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating a task
 */
export interface TaskUpdateInput {
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Options for TaskStore
 */
export interface TaskStoreOptions {
  /** Task list ID (UUID or custom ID) */
  taskListId: string;
  /** Base path for task storage (default: ~/.claude/tasks) */
  basePath?: string;
  /** Logger instance */
  logger?: Logger;
  /** Callback when tasks change (from file watcher) */
  onChange?: (tasks: Task[]) => void;
}

/**
 * TaskStore manages reading/writing tasks to ~/.claude/tasks/
 * Compatible with Claude Code's internal task system
 */
export class TaskStore {
  private taskListId: string;
  private basePath: string;
  private logger: Logger;
  private onChange?: (tasks: Task[]) => void;
  private watcher: FSWatcher | null = null;
  private nextId: number = 1;
  private initialized: boolean = false;

  constructor(options: TaskStoreOptions) {
    this.taskListId = options.taskListId;
    this.basePath = options.basePath ?? join(homedir(), ".claude", "tasks");
    this.logger = options.logger ?? console;
    this.onChange = options.onChange;
  }

  /**
   * Get the directory path for this task list
   */
  get taskListPath(): string {
    return join(this.basePath, this.taskListId);
  }

  /**
   * Initialize the task store (create directory, determine next ID)
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      await mkdir(this.taskListPath, { recursive: true });

      // Determine next ID from existing tasks (use internal list to avoid circular call)
      const tasks = await this.listInternal();
      if (tasks.length > 0) {
        const maxId = Math.max(...tasks.map((t) => parseInt(t.id, 10) || 0));
        this.nextId = maxId + 1;
      }

      this.initialized = true;
    } catch (err) {
      this.logger.error(`[TaskStore] Failed to initialize:`, err);
      throw err;
    }
  }

  /**
   * Create a new task
   */
  async create(input: TaskCreateInput): Promise<Task> {
    await this.init();

    const task: Task = {
      id: String(this.nextId++),
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm ?? this.generateActiveForm(input.subject),
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
    };

    await this.saveTask(task);

    return task;
  }

  /**
   * Get a task by ID
   */
  async get(taskId: string): Promise<Task | null> {
    await this.init();

    const filePath = this.getTaskFilePath(taskId);
    try {
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as Task;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Update a task
   */
  async update(taskId: string, input: TaskUpdateInput): Promise<Task> {
    await this.init();

    const task = await this.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Apply updates
    if (input.status !== undefined) task.status = input.status;
    if (input.subject !== undefined) task.subject = input.subject;
    if (input.description !== undefined) task.description = input.description;
    if (input.activeForm !== undefined) task.activeForm = input.activeForm;
    if (input.owner !== undefined) task.owner = input.owner;

    // Handle blocks/blockedBy additions
    if (input.addBlocks) {
      for (const blockId of input.addBlocks) {
        if (!task.blocks.includes(blockId)) {
          task.blocks.push(blockId);
        }
        // Also update the blocked task's blockedBy
        const blockedTask = await this.get(blockId);
        if (blockedTask && !blockedTask.blockedBy.includes(taskId)) {
          blockedTask.blockedBy.push(taskId);
          await this.saveTask(blockedTask);
        }
      }
    }

    if (input.addBlockedBy) {
      for (const blockerId of input.addBlockedBy) {
        if (!task.blockedBy.includes(blockerId)) {
          task.blockedBy.push(blockerId);
        }
        // Also update the blocking task's blocks
        const blockerTask = await this.get(blockerId);
        if (blockerTask && !blockerTask.blocks.includes(taskId)) {
          blockerTask.blocks.push(taskId);
          await this.saveTask(blockerTask);
        }
      }
    }

    // Merge metadata
    if (input.metadata) {
      task.metadata = { ...task.metadata, ...input.metadata };
      // Remove null values (deletion)
      for (const [key, value] of Object.entries(input.metadata)) {
        if (value === null && task.metadata) {
          delete task.metadata[key];
        }
      }
    }

    // When completing a task, update blockedBy for tasks it blocks
    if (input.status === "completed") {
      for (const blockedId of task.blocks) {
        const blockedTask = await this.get(blockedId);
        if (blockedTask) {
          blockedTask.blockedBy = blockedTask.blockedBy.filter((id) => id !== taskId);
          await this.saveTask(blockedTask);
        }
      }
    }

    await this.saveTask(task);

    return task;
  }

  /**
   * List all tasks (internal, doesn't call init to avoid circular dependency)
   */
  private async listInternal(): Promise<Task[]> {
    try {
      const files = await readdir(this.taskListPath);
      const tasks: Task[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const taskId = file.replace(".json", "");
        const filePath = this.getTaskFilePath(taskId);
        try {
          const content = await readFile(filePath, "utf8");
          tasks.push(JSON.parse(content) as Task);
        } catch {
          // Skip invalid files
        }
      }

      // Sort by ID (numeric)
      return tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  /**
   * List all tasks
   */
  async list(): Promise<Task[]> {
    await this.init();
    return this.listInternal();
  }

  /**
   * Delete a task
   */
  async delete(taskId: string): Promise<boolean> {
    await this.init();

    const task = await this.get(taskId);
    if (!task) return false;

    // Remove from blocks/blockedBy of other tasks
    for (const blockedId of task.blocks) {
      const blockedTask = await this.get(blockedId);
      if (blockedTask) {
        blockedTask.blockedBy = blockedTask.blockedBy.filter((id) => id !== taskId);
        await this.saveTask(blockedTask);
      }
    }

    for (const blockerId of task.blockedBy) {
      const blockerTask = await this.get(blockerId);
      if (blockerTask) {
        blockerTask.blocks = blockerTask.blocks.filter((id) => id !== taskId);
        await this.saveTask(blockerTask);
      }
    }

    try {
      await rm(this.getTaskFilePath(taskId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start watching for changes from other sessions
   */
  async watch(): Promise<void> {
    if (this.watcher) return;
    await this.init();

    try {
      const fsWatch = await import("fs");
      this.watcher = fsWatch.watch(this.taskListPath, async (eventType, filename) => {
        if (!filename?.endsWith(".json")) return;

        if (this.onChange) {
          try {
            const tasks = await this.list();
            this.onChange(tasks);
          } catch (err) {
            this.logger.error(`[TaskStore] Error refreshing tasks:`, err);
          }
        }
      });
    } catch (err) {
      this.logger.error(`[TaskStore] Failed to start watcher:`, err);
    }
  }

  /**
   * Stop watching for changes
   */
  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Get task statistics
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
  }> {
    const tasks = await this.list();
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      inProgress: tasks.filter((t) => t.status === "in_progress").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      blocked: tasks.filter((t) => t.blockedBy.length > 0 && t.status !== "completed").length,
    };
  }

  // Private helpers

  private getTaskFilePath(taskId: string): string {
    return join(this.taskListPath, `${taskId}.json`);
  }

  private async saveTask(task: Task): Promise<void> {
    const filePath = this.getTaskFilePath(task.id);
    await writeFile(filePath, JSON.stringify(task, null, 2), "utf8");
  }

  /**
   * Generate activeForm from subject (convert to present participle)
   * "Fix bug" -> "Fixing bug"
   * "Add feature" -> "Adding feature"
   */
  private generateActiveForm(subject: string): string {
    const words = subject.split(" ");
    if (words.length === 0) return subject;

    const verb = words[0].toLowerCase();
    let participle: string;

    // Handle common verb endings
    if (verb.endsWith("e")) {
      participle = verb.slice(0, -1) + "ing";
    } else if (verb.match(/[aeiou][bcdfghjklmnpqrstvz]$/)) {
      // Double consonant for short vowel + consonant (excluding w, x, y)
      participle = verb + verb.slice(-1) + "ing";
    } else {
      participle = verb + "ing";
    }

    // Capitalize first letter
    participle = participle.charAt(0).toUpperCase() + participle.slice(1);

    return [participle, ...words.slice(1)].join(" ");
  }
}