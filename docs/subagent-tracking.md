# Subagent Tracking

Track Task tool (subagent) lifecycle in Claude Code ACP.

## Quick Start

```typescript
import { ClaudeAcpAgent } from "@finityno/claude-code-acp";

const agent = new ClaudeAcpAgent(client);
const tracker = agent.subagentTracker;

// Listen for events
tracker.addEventListener("subagent_started", (subagent) => {
  console.log(`Started: ${subagent.description} (${subagent.subagentType})`);
});

tracker.addEventListener("subagent_completed", (subagent) => {
  console.log(`Completed: ${subagent.id} in ${subagent.completedAt - subagent.startedAt}ms`);
});

tracker.addEventListener("subagent_failed", (subagent) => {
  console.error(`Failed: ${subagent.id} - ${subagent.error}`);
});
```

## Events

| Event | When |
|-------|------|
| `subagent_started` | Task tool begins execution |
| `subagent_completed` | Task finishes successfully |
| `subagent_failed` | Task errors out |
| `subagent_cancelled` | Task interrupted by user |
| `subagent_progress` | Progress update (manual) |

## API

```typescript
// Get subagents
tracker.getSubagent(id)              // Single by ID
tracker.getRunningSubagents()        // All currently running
tracker.getSessionSubagents(sessionId) // All in a session
tracker.getAllSubagents()            // Everything

// Check status
tracker.isSubagent(toolUseId)        // Is this a Task tool?

// Stats
tracker.getStats()
// Returns: { total, pending, running, completed, failed, cancelled, byType, averageDurationMs }

// Cleanup old entries (default: 1 hour)
tracker.cleanup(maxAgeMs)
```

## Subagent Object

```typescript
interface TrackedSubagent {
  id: string;                    // Tool use ID
  parentSessionId: string;       // Session that spawned it
  subagentType: string;          // "Explore" | "Plan" | "Bash" | etc.
  description: string;           // Short description
  prompt: string;                // Full prompt
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  model?: "sonnet" | "opus" | "haiku";
  runInBackground: boolean;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;              // Response data (if completed)
  error?: string;                // Error message (if failed)
  agentId?: string;              // For resume capability
}
```

## ACP Notifications

Task tools automatically include subagent metadata in `tool_call` notifications:

```typescript
{
  sessionUpdate: "tool_call",
  toolCallId: "toolu_123",
  _meta: {
    claudeCode: {
      toolName: "Task",
      subagent: {
        id: "toolu_123",
        eventType: "subagent_started",
        subagentType: "Explore",
        description: "Search codebase",
        status: "running",
        runInBackground: false
      }
    }
  }
}
```

## Standalone Usage

Use without ACP client for custom integrations:

```typescript
import { SubagentTracker, TaskToolInput } from "@finityno/claude-code-acp";

const tracker = new SubagentTracker(null, console);

// TaskToolInput uses snake_case (matches Claude's JSON format)
const input: TaskToolInput = {
  description: "My task",
  prompt: "Do something",
  subagent_type: "custom"
};

tracker.trackSubagent("id", "session", input);

await tracker.startSubagent("id");
await tracker.completeSubagent("id", { result: "done" });

// TrackedSubagent uses camelCase
const subagent = tracker.getSubagent("id");
console.log(subagent.subagentType); // "custom"
```
