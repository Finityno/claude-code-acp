# ACP adapter for Claude Code

[![npm](https://img.shields.io/npm/v/%40finityno%2Fclaude-code-acp)](https://www.npmjs.com/package/@finityno/claude-code-acp)

> **Fork of [@zed-industries/claude-code-acp](https://github.com/zed-industries/claude-code-acp)**
>
> This fork adds support for **subagent (Task tool) tracking** and **AskUserQuestion tool** support.

Use [Claude Code](https://www.anthropic.com/claude-code) from [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev)!

## Installation

```bash
npm i @finityno/claude-code-acp
```

Or install globally:

```bash
npm i -g @finityno/claude-code-acp
```

## Features

This adapter implements an ACP agent using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview):

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers
- **Subagent tracking** (Task tool lifecycle events)
- **AskUserQuestion** (Claude can ask clarifying questions)

## Subagent Tracking

Track Task tool (subagent) lifecycle events:

```typescript
import { ClaudeAcpAgent } from "@finityno/claude-code-acp";

const agent = new ClaudeAcpAgent(client);
const tracker = agent.subagentTracker;

// Listen for subagent events
tracker.addEventListener("subagent_started", (subagent) => {
  console.log(`Started: ${subagent.description} (${subagent.subagentType})`);
});

tracker.addEventListener("subagent_completed", (subagent) => {
  console.log(`Completed: ${subagent.id}`);
});

tracker.addEventListener("subagent_failed", (subagent) => {
  console.error(`Failed: ${subagent.error}`);
});

// Query subagents
tracker.getRunningSubagents();          // Currently active
tracker.getSessionSubagents(sessionId); // By session
tracker.getStats();                     // Counts & avg duration
```

See [docs/subagent-tracking.md](docs/subagent-tracking.md) for full API documentation.

## AskUserQuestion

Claude can ask clarifying questions during execution. Questions are presented via the ACP permission request system:

```typescript
// Claude sends a question like:
{
  "question": "Which testing framework should we use?",
  "header": "Testing",
  "options": [
    { "label": "Jest", "description": "Popular JavaScript testing framework" },
    { "label": "Vitest", "description": "Vite-native, fast testing framework" }
  ],
  "multiSelect": false
}

// User selects an option, Claude receives:
{
  "answers": {
    "Which testing framework should we use?": "Vitest"
  }
}
```

Features:
- Multiple questions per request (1-4)
- 2-4 options per question with labels and descriptions
- MultiSelect support for non-mutually-exclusive choices
- "Other" option for free-text input

See [docs/ask-user-question.md](docs/ask-user-question.md) for ACP client integration details.

## Usage

### With Zed

The latest version of Zed can use this adapter out of the box. Open the Agent Panel and click "New Claude Code Thread" from the `+` button menu.

Read the docs on [External Agent](https://zed.dev/docs/ai/external-agents) support.

### Other Clients

Use with any [ACP compatible client](https://agentclientprotocol.com/overview/clients):

```bash
ANTHROPIC_API_KEY=sk-... claude-code-acp
```

## License

Apache-2.0
