import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskStore, Task } from "../task-store.js";
import { rm, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("TaskStore", () => {
  let taskStore: TaskStore;
  let testBasePath: string;
  const testTaskListId = "test-list-" + Date.now();

  beforeEach(async () => {
    // Use a temp directory for tests
    testBasePath = join(tmpdir(), "claude-code-acp-tests", "tasks");
    await mkdir(testBasePath, { recursive: true });

    taskStore = new TaskStore({
      taskListId: testTaskListId,
      basePath: testBasePath,
      logger: {
        log: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
        info: () => {},
      } as any,
    });
  });

  afterEach(async () => {
    // Clean up test directory
    taskStore.close();
    try {
      await rm(join(testBasePath, testTaskListId), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("init", () => {
    it("should initialize and create task list directory", async () => {
      await taskStore.init();

      const files = await readdir(testBasePath);
      expect(files).toContain(testTaskListId);
    });

    it("should be idempotent", async () => {
      await taskStore.init();
      await taskStore.init();
      await taskStore.init();

      // Should not throw
      const tasks = await taskStore.list();
      expect(tasks).toEqual([]);
    });
  });

  describe("create", () => {
    it("should create a task with auto-generated ID", async () => {
      const task = await taskStore.create({
        subject: "Test task",
        description: "Test description",
      });

      expect(task.id).toBe("1");
      expect(task.subject).toBe("Test task");
      expect(task.description).toBe("Test description");
      expect(task.status).toBe("pending");
      expect(task.blocks).toEqual([]);
      expect(task.blockedBy).toEqual([]);
    });

    it("should auto-generate activeForm from subject", async () => {
      const task = await taskStore.create({
        subject: "Run tests",
        description: "Run all unit tests",
      });

      expect(task.activeForm).toBe("Running tests");
    });

    it("should use provided activeForm", async () => {
      const task = await taskStore.create({
        subject: "Run tests",
        description: "Run all unit tests",
        activeForm: "Executing test suite",
      });

      expect(task.activeForm).toBe("Executing test suite");
    });

    it("should increment IDs for multiple tasks", async () => {
      const task1 = await taskStore.create({ subject: "Task 1", description: "" });
      const task2 = await taskStore.create({ subject: "Task 2", description: "" });
      const task3 = await taskStore.create({ subject: "Task 3", description: "" });

      expect(task1.id).toBe("1");
      expect(task2.id).toBe("2");
      expect(task3.id).toBe("3");
    });

    it("should persist task to disk", async () => {
      const task = await taskStore.create({
        subject: "Persistent task",
        description: "Should be saved to disk",
      });

      // Create a new store instance pointing to same location
      const newStore = new TaskStore({
        taskListId: testTaskListId,
        basePath: testBasePath,
        logger: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {}, info: () => {} } as any,
      });

      const loadedTask = await newStore.get(task.id);
      expect(loadedTask).not.toBeNull();
      expect(loadedTask?.subject).toBe("Persistent task");
      newStore.close();
    });
  });

  describe("get", () => {
    it("should return null for non-existent task", async () => {
      const task = await taskStore.get("999");
      expect(task).toBeNull();
    });

    it("should return task by ID", async () => {
      const created = await taskStore.create({
        subject: "Find me",
        description: "Test",
      });

      const found = await taskStore.get(created.id);
      expect(found).not.toBeNull();
      expect(found?.subject).toBe("Find me");
    });
  });

  describe("update", () => {
    it("should update task status", async () => {
      const task = await taskStore.create({
        subject: "Update me",
        description: "Test",
      });

      const updated = await taskStore.update(task.id, {
        status: "in_progress",
      });

      expect(updated.status).toBe("in_progress");
    });

    it("should update task subject", async () => {
      const task = await taskStore.create({
        subject: "Original",
        description: "Test",
      });

      const updated = await taskStore.update(task.id, {
        subject: "Updated subject",
      });

      expect(updated.subject).toBe("Updated subject");
    });

    it("should update task owner", async () => {
      const task = await taskStore.create({
        subject: "Assignable",
        description: "Test",
      });

      const updated = await taskStore.update(task.id, {
        owner: "agent-1",
      });

      expect(updated.owner).toBe("agent-1");
    });

    it("should add blocks", async () => {
      const task1 = await taskStore.create({ subject: "Task 1", description: "" });
      const task2 = await taskStore.create({ subject: "Task 2", description: "" });

      const updated = await taskStore.update(task1.id, {
        addBlocks: [task2.id],
      });

      expect(updated.blocks).toContain(task2.id);

      // Check that task2 now has task1 in blockedBy
      const task2Updated = await taskStore.get(task2.id);
      expect(task2Updated?.blockedBy).toContain(task1.id);
    });

    it("should add blockedBy", async () => {
      const task1 = await taskStore.create({ subject: "Task 1", description: "" });
      const task2 = await taskStore.create({ subject: "Task 2", description: "" });

      const updated = await taskStore.update(task2.id, {
        addBlockedBy: [task1.id],
      });

      expect(updated.blockedBy).toContain(task1.id);

      // Check that task1 now has task2 in blocks
      const task1Updated = await taskStore.get(task1.id);
      expect(task1Updated?.blocks).toContain(task2.id);
    });

    it("should remove from blockedBy when completing a blocking task", async () => {
      const task1 = await taskStore.create({ subject: "Blocker", description: "" });
      const task2 = await taskStore.create({ subject: "Blocked", description: "" });

      // Set up blocking relationship
      await taskStore.update(task1.id, { addBlocks: [task2.id] });

      // Verify task2 is blocked
      let task2State = await taskStore.get(task2.id);
      expect(task2State?.blockedBy).toContain(task1.id);

      // Complete task1
      await taskStore.update(task1.id, { status: "completed" });

      // Verify task2 is no longer blocked
      task2State = await taskStore.get(task2.id);
      expect(task2State?.blockedBy).not.toContain(task1.id);
    });

    it("should merge metadata", async () => {
      const task = await taskStore.create({
        subject: "With metadata",
        description: "Test",
        metadata: { key1: "value1" },
      });

      const updated = await taskStore.update(task.id, {
        metadata: { key2: "value2" },
      });

      expect(updated.metadata).toEqual({ key1: "value1", key2: "value2" });
    });

    it("should delete metadata keys set to null", async () => {
      const task = await taskStore.create({
        subject: "With metadata",
        description: "Test",
        metadata: { key1: "value1", key2: "value2" },
      });

      const updated = await taskStore.update(task.id, {
        metadata: { key1: null as any },
      });

      expect(updated.metadata).toEqual({ key2: "value2" });
    });

    it("should throw for non-existent task", async () => {
      await expect(
        taskStore.update("999", { status: "completed" })
      ).rejects.toThrow("Task not found: 999");
    });
  });

  describe("list", () => {
    it("should return empty array when no tasks", async () => {
      const tasks = await taskStore.list();
      expect(tasks).toEqual([]);
    });

    it("should return all tasks sorted by ID", async () => {
      await taskStore.create({ subject: "Task 1", description: "" });
      await taskStore.create({ subject: "Task 2", description: "" });
      await taskStore.create({ subject: "Task 3", description: "" });

      const tasks = await taskStore.list();
      expect(tasks.length).toBe(3);
      expect(tasks[0].subject).toBe("Task 1");
      expect(tasks[1].subject).toBe("Task 2");
      expect(tasks[2].subject).toBe("Task 3");
    });
  });

  describe("delete", () => {
    it("should delete a task", async () => {
      const task = await taskStore.create({
        subject: "Delete me",
        description: "Test",
      });

      const deleted = await taskStore.delete(task.id);
      expect(deleted).toBe(true);

      const found = await taskStore.get(task.id);
      expect(found).toBeNull();
    });

    it("should return false for non-existent task", async () => {
      const deleted = await taskStore.delete("999");
      expect(deleted).toBe(false);
    });

    it("should clean up blocking relationships", async () => {
      const task1 = await taskStore.create({ subject: "Blocker", description: "" });
      const task2 = await taskStore.create({ subject: "Blocked", description: "" });

      await taskStore.update(task1.id, { addBlocks: [task2.id] });

      // Delete the blocker
      await taskStore.delete(task1.id);

      // task2 should no longer be blocked
      const task2State = await taskStore.get(task2.id);
      expect(task2State?.blockedBy).not.toContain(task1.id);
    });
  });

  describe("getStats", () => {
    it("should return correct stats", async () => {
      await taskStore.create({ subject: "Pending 1", description: "" });
      await taskStore.create({ subject: "Pending 2", description: "" });

      const task3 = await taskStore.create({ subject: "In Progress", description: "" });
      await taskStore.update(task3.id, { status: "in_progress" });

      const task4 = await taskStore.create({ subject: "Completed", description: "" });
      await taskStore.update(task4.id, { status: "completed" });

      const stats = await taskStore.getStats();
      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(2);
      expect(stats.inProgress).toBe(1);
      expect(stats.completed).toBe(1);
    });
  });

  describe("ID continuity after restart", () => {
    it("should continue from highest existing ID after re-initialization", async () => {
      // Create some tasks
      await taskStore.create({ subject: "Task 1", description: "" });
      await taskStore.create({ subject: "Task 2", description: "" });
      await taskStore.create({ subject: "Task 3", description: "" });

      // Close and create new store
      taskStore.close();

      const newStore = new TaskStore({
        taskListId: testTaskListId,
        basePath: testBasePath,
        logger: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {}, info: () => {} } as any,
      });

      // New task should get ID 4
      const task4 = await newStore.create({ subject: "Task 4", description: "" });
      expect(task4.id).toBe("4");

      newStore.close();
    });
  });
});