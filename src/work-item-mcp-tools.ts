import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TaskStore, Task, TaskStatus } from "./task-store.js";

export interface WorkItemMcpToolsOptions {
  /** The TaskStore instance for managing work item tasks */
  taskStore: TaskStore;
}

/**
 * Register MCP tools for work item task management (TaskCreate, TaskGet, TaskUpdate, TaskList)
 * These match Claude Code's internal task system stored in ~/.claude/tasks/
 */
export function registerWorkItemMcpTools(
  server: McpServer,
  options: WorkItemMcpToolsOptions,
): void {
  const { taskStore } = options;

  // TaskCreate - Create a new task
  server.registerTool(
    "TaskCreate",
    {
      title: "Create Task",
      description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm**: Present continuous form shown in spinner when task is in_progress (e.g., "Fixing authentication bug")

**IMPORTANT**: Always provide activeForm when creating tasks. The subject should be imperative ("Run tests") while activeForm should be present continuous ("Running tests").`,
      inputSchema: {
        subject: z.string().describe("A brief title for the task in imperative form"),
        description: z.string().describe("A detailed description of what needs to be done"),
        activeForm: z
          .string()
          .optional()
          .describe(
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
          ),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arbitrary metadata to attach to the task"),
      },
      annotations: {
        title: "Create task",
        readOnlyHint: false,
      },
    },
    async (input) => {
      try {
        const task = await taskStore.create({
          subject: input.subject,
          description: input.description,
          activeForm: input.activeForm,
          metadata: input.metadata as Record<string, unknown> | undefined,
        });

        return {
          content: [
            {
              type: "text",
              text: `Created task ${task.id}: "${task.subject}"`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to create task: ${err}` }],
        };
      }
    },
  );

  // TaskGet - Get a task by ID
  server.registerTool(
    "TaskGet",
    {
      title: "Get Task",
      description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
      inputSchema: {
        taskId: z.string().describe("The ID of the task to retrieve"),
      },
      annotations: {
        title: "Get task",
        readOnlyHint: true,
      },
    },
    async (input) => {
      try {
        const task = await taskStore.get(input.taskId);
        if (!task) {
          return {
            isError: true,
            content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to get task: ${err}` }],
        };
      }
    },
  );

  // TaskUpdate - Update a task
  server.registerTool(
    "TaskUpdate",
    {
      title: "Update Task",
      description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status ('pending', 'in_progress', 'completed')
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown when in_progress
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
      inputSchema: {
        taskId: z.string().describe("The ID of the task to update"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .optional()
          .describe("New status for the task"),
        subject: z.string().optional().describe("New subject for the task"),
        description: z.string().optional().describe("New description for the task"),
        activeForm: z
          .string()
          .optional()
          .describe(
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
          ),
        owner: z.string().optional().describe("New owner for the task"),
        addBlocks: z
          .array(z.string())
          .optional()
          .describe("Task IDs that this task blocks"),
        addBlockedBy: z
          .array(z.string())
          .optional()
          .describe("Task IDs that block this task"),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Metadata keys to merge into the task. Set a key to null to delete it."),
      },
      annotations: {
        title: "Update task",
        readOnlyHint: false,
      },
    },
    async (input) => {
      try {
        const task = await taskStore.update(input.taskId, {
          status: input.status as TaskStatus | undefined,
          subject: input.subject,
          description: input.description,
          activeForm: input.activeForm,
          owner: input.owner,
          addBlocks: input.addBlocks,
          addBlockedBy: input.addBlockedBy,
          metadata: input.metadata as Record<string, unknown> | undefined,
        });

        let message = `Updated task ${task.id}: "${task.subject}" (${task.status})`;
        if (task.status === "completed") {
          message +=
            "\n\nTask completed. Call TaskList now to find your next available task or see if your work unblocked others.";
        }

        return {
          content: [{ type: "text", text: message }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to update task: ${err}` }],
        };
      }
    },
  );

  // TaskList - List all tasks
  server.registerTool(
    "TaskList",
    {
      title: "List Tasks",
      description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- Before assigning tasks to teammates, to see what's available
- After completing a task, to check for newly unblocked work or claim the next available task

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first

Use TaskGet with a specific task ID to view full details including description.`,
      inputSchema: {},
      annotations: {
        title: "List tasks",
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        const tasks = await taskStore.list();
        const stats = await taskStore.getStats();

        const summary = tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          owner: t.owner,
          blockedBy: t.blockedBy.filter((id) => {
            const blocker = tasks.find((task) => task.id === id);
            return blocker && blocker.status !== "completed";
          }),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  stats,
                  tasks: summary,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list tasks: ${err}` }],
        };
      }
    },
  );
}
