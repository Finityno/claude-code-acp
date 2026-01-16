import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SubagentTracker,
  TaskToolInput,
  TrackedSubagent,
  SubagentEventType,
  SubagentEventListener,
  isTaskToolInput,
  extractSubagentMeta,
} from "../subagent-tracker.js";
import { toAcpNotifications } from "../acp-agent.js";

// Mock logger
const mockLogger = {
  log: vi.fn(),
  error: vi.fn(),
};

// Mock ACP client
const createMockClient = () => ({
  sessionUpdate: vi.fn().mockResolvedValue(undefined),
});

describe("SubagentTracker", () => {
  let tracker: SubagentTracker;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    tracker = new SubagentTracker(mockClient as any, mockLogger);
    vi.clearAllMocks();
  });

  afterEach(() => {
    tracker.clear();
  });

  describe("trackSubagent", () => {
    it("should track a new subagent", () => {
      const input: TaskToolInput = {
        description: "Search codebase",
        prompt: "Find all TypeScript files",
        subagent_type: "Explore",
      };

      const subagent = tracker.trackSubagent("tool-123", "session-456", input);

      expect(subagent).toBeDefined();
      expect(subagent.id).toBe("tool-123");
      expect(subagent.parentSessionId).toBe("session-456");
      expect(subagent.subagentType).toBe("Explore");
      expect(subagent.description).toBe("Search codebase");
      expect(subagent.prompt).toBe("Find all TypeScript files");
      expect(subagent.status).toBe("pending");
      expect(subagent.runInBackground).toBe(false);
      expect(subagent.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it("should track subagent with all optional fields", () => {
      const input: TaskToolInput = {
        description: "Complex task",
        prompt: "Do complex things",
        subagent_type: "general-purpose",
        model: "opus",
        max_turns: 10,
        run_in_background: true,
      };

      const subagent = tracker.trackSubagent("tool-789", "session-abc", input, "parent-tool-id");

      expect(subagent.model).toBe("opus");
      expect(subagent.maxTurns).toBe(10);
      expect(subagent.runInBackground).toBe(true);
      expect(subagent.parentToolUseId).toBe("parent-tool-id");
    });

    it("should be retrievable after tracking", () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Bash",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      const retrieved = tracker.getSubagent("tool-id");

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("tool-id");
    });

    it("should track multiple subagents for same session", () => {
      const input1: TaskToolInput = {
        description: "Task 1",
        prompt: "Prompt 1",
        subagent_type: "Explore",
      };
      const input2: TaskToolInput = {
        description: "Task 2",
        prompt: "Prompt 2",
        subagent_type: "Plan",
      };

      tracker.trackSubagent("tool-1", "session-1", input1);
      tracker.trackSubagent("tool-2", "session-1", input2);

      const sessionSubagents = tracker.getSessionSubagents("session-1");
      expect(sessionSubagents).toHaveLength(2);
    });
  });

  describe("startSubagent", () => {
    it("should mark subagent as running", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");

      const subagent = tracker.getSubagent("tool-id");
      expect(subagent?.status).toBe("running");
      expect(subagent?.startedAt).toBeDefined();
      expect(subagent?.startedAt).toBeLessThanOrEqual(Date.now());
    });

    it("should send notification to client", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");

      expect(mockClient.sessionUpdate).toHaveBeenCalled();
      const call = mockClient.sessionUpdate.mock.calls[0][0];
      expect(call.sessionId).toBe("session-id");
      expect(call.update.sessionUpdate).toBe("tool_call_update");
      expect(call.update._meta?.claudeCode?.subagent?.eventType).toBe("subagent_started");
    });

    it("should emit event to listeners", async () => {
      const listener = vi.fn();
      tracker.addEventListener("subagent_started", listener);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ id: "tool-id", status: "running" }),
        undefined,
      );
    });

    it("should log error for unknown subagent", async () => {
      await tracker.startSubagent("unknown-id");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("completeSubagent", () => {
    it("should mark subagent as completed", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");
      await tracker.completeSubagent("tool-id", { result: "success" }, "agent-123");

      const subagent = tracker.getSubagent("tool-id");
      expect(subagent?.status).toBe("completed");
      expect(subagent?.completedAt).toBeDefined();
      expect(subagent?.result).toEqual({ result: "success" });
      expect(subagent?.agentId).toBe("agent-123");
    });

    it("should calculate duration correctly", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50));

      await tracker.completeSubagent("tool-id");

      const subagent = tracker.getSubagent("tool-id");
      const duration = subagent!.completedAt! - subagent!.startedAt!;
      expect(duration).toBeGreaterThanOrEqual(50);
    });

    it("should emit completion event", async () => {
      const listener = vi.fn();
      tracker.addEventListener("subagent_completed", listener);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");
      await tracker.completeSubagent("tool-id", { data: "test" });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ id: "tool-id", status: "completed" }),
        undefined,
      );
    });
  });

  describe("failSubagent", () => {
    it("should mark subagent as failed with error", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");
      await tracker.failSubagent("tool-id", "Something went wrong");

      const subagent = tracker.getSubagent("tool-id");
      expect(subagent?.status).toBe("failed");
      expect(subagent?.error).toBe("Something went wrong");
      expect(subagent?.completedAt).toBeDefined();
    });

    it("should emit failure event", async () => {
      const listener = vi.fn();
      tracker.addEventListener("subagent_failed", listener);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");
      await tracker.failSubagent("tool-id", "Error occurred");

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ id: "tool-id", status: "failed", error: "Error occurred" }),
        undefined,
      );
    });
  });

  describe("cancelSubagent", () => {
    it("should mark subagent as cancelled", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");
      await tracker.cancelSubagent("tool-id");

      const subagent = tracker.getSubagent("tool-id");
      expect(subagent?.status).toBe("cancelled");
      expect(subagent?.completedAt).toBeDefined();
    });

    it("should emit cancellation event", async () => {
      const listener = vi.fn();
      tracker.addEventListener("subagent_cancelled", listener);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");
      await tracker.cancelSubagent("tool-id");

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ id: "tool-id", status: "cancelled" }),
        undefined,
      );
    });

    it("should silently handle unknown subagent", async () => {
      await tracker.cancelSubagent("unknown-id");
      // Should not throw
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe("updateProgress", () => {
    it("should emit progress event for running subagent", async () => {
      const listener = vi.fn();
      tracker.addEventListener("subagent_progress", listener);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");
      await tracker.updateProgress("tool-id", { progress: 50 });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ id: "tool-id", status: "running" }),
        { progress: 50 },
      );
    });

    it("should not emit for non-running subagent", async () => {
      const listener = vi.fn();
      tracker.addEventListener("subagent_progress", listener);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      // Not started yet - still pending
      await tracker.updateProgress("tool-id", { progress: 50 });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("getRunningSubagents", () => {
    it("should return only running subagents", async () => {
      const input1: TaskToolInput = {
        description: "Task 1",
        prompt: "Prompt 1",
        subagent_type: "Explore",
      };
      const input2: TaskToolInput = {
        description: "Task 2",
        prompt: "Prompt 2",
        subagent_type: "Plan",
      };
      const input3: TaskToolInput = {
        description: "Task 3",
        prompt: "Prompt 3",
        subagent_type: "Bash",
      };

      tracker.trackSubagent("tool-1", "session-1", input1);
      tracker.trackSubagent("tool-2", "session-1", input2);
      tracker.trackSubagent("tool-3", "session-1", input3);

      await tracker.startSubagent("tool-1");
      await tracker.startSubagent("tool-2");
      await tracker.completeSubagent("tool-1");
      // tool-3 is still pending

      const running = tracker.getRunningSubagents();
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe("tool-2");
    });
  });

  describe("getSessionSubagents", () => {
    it("should return subagents for specific session", async () => {
      const input: TaskToolInput = {
        description: "Task",
        prompt: "Prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-1", "session-1", input);
      tracker.trackSubagent("tool-2", "session-1", input);
      tracker.trackSubagent("tool-3", "session-2", input);

      const session1Subagents = tracker.getSessionSubagents("session-1");
      expect(session1Subagents).toHaveLength(2);

      const session2Subagents = tracker.getSessionSubagents("session-2");
      expect(session2Subagents).toHaveLength(1);
    });

    it("should return empty array for unknown session", () => {
      const subagents = tracker.getSessionSubagents("unknown-session");
      expect(subagents).toEqual([]);
    });
  });

  describe("isSubagent", () => {
    it("should return true for tracked subagent", () => {
      const input: TaskToolInput = {
        description: "Task",
        prompt: "Prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      expect(tracker.isSubagent("tool-id")).toBe(true);
    });

    it("should return false for unknown ID", () => {
      expect(tracker.isSubagent("unknown-id")).toBe(false);
    });
  });

  describe("event listeners", () => {
    it("should support multiple listeners for same event", async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      tracker.addEventListener("subagent_started", listener1);
      tracker.addEventListener("subagent_started", listener2);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it("should remove listener correctly", async () => {
      const listener = vi.fn();
      tracker.addEventListener("subagent_started", listener);
      tracker.removeEventListener("subagent_started", listener);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");

      expect(listener).not.toHaveBeenCalled();
    });

    it("should handle listener errors gracefully", async () => {
      const failingListener = vi.fn().mockRejectedValue(new Error("Listener error"));
      const goodListener = vi.fn();

      tracker.addEventListener("subagent_started", failingListener);
      tracker.addEventListener("subagent_started", goodListener);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");

      // Should not throw, and good listener should still be called
      expect(goodListener).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("should remove old completed subagents", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-1", "session-1", input);
      tracker.trackSubagent("tool-2", "session-1", input);

      await tracker.startSubagent("tool-1");
      await tracker.startSubagent("tool-2");
      await tracker.completeSubagent("tool-1");

      // Manually set completion time to be old
      const subagent1 = tracker.getSubagent("tool-1");
      if (subagent1) {
        subagent1.completedAt = Date.now() - 100000; // 100 seconds ago
      }

      const cleanedCount = tracker.cleanup(50000); // Clean up anything older than 50 seconds

      expect(cleanedCount).toBe(1);
      expect(tracker.getSubagent("tool-1")).toBeUndefined();
      expect(tracker.getSubagent("tool-2")).toBeDefined();
    });

    it("should not remove running subagents", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-id", "session-id", input);
      await tracker.startSubagent("tool-id");

      const cleanedCount = tracker.cleanup(0); // Clean up everything

      expect(cleanedCount).toBe(0);
      expect(tracker.getSubagent("tool-id")).toBeDefined();
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };
      const input2: TaskToolInput = {
        description: "Test 2",
        prompt: "Test prompt 2",
        subagent_type: "Plan",
      };

      tracker.trackSubagent("tool-1", "session-1", input);
      tracker.trackSubagent("tool-2", "session-1", input2);
      tracker.trackSubagent("tool-3", "session-1", input);
      tracker.trackSubagent("tool-4", "session-1", input2);

      await tracker.startSubagent("tool-1");
      await tracker.startSubagent("tool-2");
      await tracker.completeSubagent("tool-1");
      await tracker.failSubagent("tool-2", "Error");

      const stats = tracker.getStats();

      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(2);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.cancelled).toBe(0);
      expect(stats.byType["Explore"]).toBe(2);
      expect(stats.byType["Plan"]).toBe(2);
    });

    it("should calculate average duration", async () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-1", "session-1", input);
      tracker.trackSubagent("tool-2", "session-1", input);

      await tracker.startSubagent("tool-1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await tracker.completeSubagent("tool-1");

      await tracker.startSubagent("tool-2");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await tracker.completeSubagent("tool-2");

      const stats = tracker.getStats();

      expect(stats.averageDurationMs).toBeDefined();
      expect(stats.averageDurationMs).toBeGreaterThanOrEqual(50);
    });

    it("should return undefined averageDuration when no completed subagents", () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-1", "session-1", input);

      const stats = tracker.getStats();
      expect(stats.averageDurationMs).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("should remove all subagents", () => {
      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      tracker.trackSubagent("tool-1", "session-1", input);
      tracker.trackSubagent("tool-2", "session-2", input);

      tracker.clear();

      expect(tracker.getAllSubagents()).toHaveLength(0);
      expect(tracker.getSessionSubagents("session-1")).toHaveLength(0);
    });
  });

  describe("without client", () => {
    it("should work without ACP client for standalone usage", async () => {
      const standaloneTracker = new SubagentTracker(null, mockLogger);

      const input: TaskToolInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      standaloneTracker.trackSubagent("tool-id", "session-id", input);
      await standaloneTracker.startSubagent("tool-id");
      await standaloneTracker.completeSubagent("tool-id");

      const subagent = standaloneTracker.getSubagent("tool-id");
      expect(subagent?.status).toBe("completed");
      // No client.sessionUpdate calls since client is null
    });
  });
});

describe("isTaskToolInput", () => {
  it("should return true for valid Task tool input", () => {
    const input = {
      description: "Test",
      prompt: "Test prompt",
      subagent_type: "Explore",
    };
    expect(isTaskToolInput(input)).toBe(true);
  });

  it("should return true for Task input with optional fields", () => {
    const input = {
      description: "Test",
      prompt: "Test prompt",
      subagent_type: "Explore",
      model: "opus",
      max_turns: 5,
      run_in_background: true,
    };
    expect(isTaskToolInput(input)).toBe(true);
  });

  it("should return false for missing required fields", () => {
    expect(isTaskToolInput({ description: "Test", prompt: "Test" })).toBe(false);
    expect(isTaskToolInput({ description: "Test", subagent_type: "Explore" })).toBe(false);
    expect(isTaskToolInput({ prompt: "Test", subagent_type: "Explore" })).toBe(false);
  });

  it("should return false for non-object inputs", () => {
    expect(isTaskToolInput(null)).toBe(false);
    expect(isTaskToolInput(undefined)).toBe(false);
    expect(isTaskToolInput("string")).toBe(false);
    expect(isTaskToolInput(123)).toBe(false);
    expect(isTaskToolInput([])).toBe(false);
  });
});

describe("extractSubagentMeta", () => {
  it("should extract metadata from Task input", () => {
    const input: TaskToolInput = {
      description: "Search files",
      prompt: "Find TypeScript files",
      subagent_type: "Explore",
      model: "haiku",
      max_turns: 3,
      run_in_background: true,
    };

    const meta = extractSubagentMeta(input);

    expect(meta.description).toBe("Search files");
    expect(meta.subagentType).toBe("Explore");
    expect(meta.model).toBe("haiku");
    expect(meta.maxTurns).toBe(3);
    expect(meta.runInBackground).toBe(true);
  });

  it("should handle missing optional fields", () => {
    const input: TaskToolInput = {
      description: "Test",
      prompt: "Test prompt",
      subagent_type: "Bash",
    };

    const meta = extractSubagentMeta(input);

    expect(meta.description).toBe("Test");
    expect(meta.subagentType).toBe("Bash");
    expect(meta.model).toBeUndefined();
    expect(meta.maxTurns).toBeUndefined();
    expect(meta.runInBackground).toBe(false);
  });
});

describe("Integration: toAcpNotifications with SubagentTracker", () => {
  it("should track Task tool through toAcpNotifications", () => {
    const mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = new SubagentTracker(mockClient as any, mockLogger);

    const taskToolUse = {
      type: "tool_use" as const,
      id: "toolu_task_123",
      name: "Task",
      input: {
        description: "Explore codebase",
        prompt: "Find all test files in the project",
        subagent_type: "Explore",
        model: "haiku",
      },
    };

    // Process the Task tool use through toAcpNotifications
    const notifications = toAcpNotifications(
      [taskToolUse],
      "assistant",
      "session-456",
      { [taskToolUse.id]: taskToolUse },
      mockClient as any,
      mockLogger,
      tracker,
    );

    // Verify notification was created
    expect(notifications).toHaveLength(1);
    expect(notifications[0].update.sessionUpdate).toBe("tool_call");

    // Verify subagent was tracked
    const subagent = tracker.getSubagent("toolu_task_123");
    expect(subagent).toBeDefined();
    expect(subagent?.subagentType).toBe("Explore");
    expect(subagent?.description).toBe("Explore codebase");
    expect(subagent?.status).toBe("running"); // Started immediately

    // Verify notification contains subagent metadata
    const meta = notifications[0].update._meta as any;
    expect(meta?.claudeCode?.toolName).toBe("Task");
    expect(meta?.claudeCode?.subagent?.eventType).toBe("subagent_started");
    expect(meta?.claudeCode?.subagent?.subagentType).toBe("Explore");
  });

  it("should not track non-Task tools as subagents", () => {
    const mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = new SubagentTracker(mockClient as any, mockLogger);

    const bashToolUse = {
      type: "tool_use" as const,
      id: "toolu_bash_456",
      name: "Bash",
      input: {
        command: "ls -la",
        description: "List files",
      },
    };

    toAcpNotifications(
      [bashToolUse],
      "assistant",
      "session-789",
      { [bashToolUse.id]: bashToolUse },
      mockClient as any,
      mockLogger,
      tracker,
    );

    // Verify subagent was NOT tracked
    expect(tracker.getSubagent("toolu_bash_456")).toBeUndefined();
    expect(tracker.getAllSubagents()).toHaveLength(0);
  });

  it("should handle multiple Task tools in sequence", () => {
    const mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = new SubagentTracker(mockClient as any, mockLogger);

    const taskToolUse1 = {
      type: "tool_use" as const,
      id: "toolu_task_1",
      name: "Task",
      input: {
        description: "First task",
        prompt: "Do first thing",
        subagent_type: "Explore",
      },
    };

    const taskToolUse2 = {
      type: "tool_use" as const,
      id: "toolu_task_2",
      name: "Task",
      input: {
        description: "Second task",
        prompt: "Do second thing",
        subagent_type: "Plan",
        run_in_background: true,
      },
    };

    // Process first task
    toAcpNotifications(
      [taskToolUse1],
      "assistant",
      "session-abc",
      { [taskToolUse1.id]: taskToolUse1 },
      mockClient as any,
      mockLogger,
      tracker,
    );

    // Process second task
    toAcpNotifications(
      [taskToolUse2],
      "assistant",
      "session-abc",
      { [taskToolUse2.id]: taskToolUse2 },
      mockClient as any,
      mockLogger,
      tracker,
    );

    // Verify both are tracked
    expect(tracker.getAllSubagents()).toHaveLength(2);

    const subagent1 = tracker.getSubagent("toolu_task_1");
    const subagent2 = tracker.getSubagent("toolu_task_2");

    expect(subagent1?.subagentType).toBe("Explore");
    expect(subagent1?.runInBackground).toBe(false);

    expect(subagent2?.subagentType).toBe("Plan");
    expect(subagent2?.runInBackground).toBe(true);

    // Verify session tracking
    const sessionSubagents = tracker.getSessionSubagents("session-abc");
    expect(sessionSubagents).toHaveLength(2);
  });

  it("should work without tracker (backward compatibility)", () => {
    const mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const taskToolUse = {
      type: "tool_use" as const,
      id: "toolu_task_notracker",
      name: "Task",
      input: {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Bash",
      },
    };

    // This should not throw when tracker is undefined
    const notifications = toAcpNotifications(
      [taskToolUse],
      "assistant",
      "session-xyz",
      { [taskToolUse.id]: taskToolUse },
      mockClient as any,
      mockLogger,
      undefined, // No tracker
    );

    // Should still create notification (just without subagent tracking)
    expect(notifications).toHaveLength(1);
  });
});
