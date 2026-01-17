# AskUserQuestion Tool

Allow Claude to ask users clarifying questions during execution, presenting multiple-choice options and collecting responses.

## Overview

The `AskUserQuestion` tool enables Claude to pause and ask the user for input when it needs clarification or preferences. Questions are presented via the ACP permission request system, allowing ACP clients to display them in their UI.

## How It Works

1. Claude invokes the `AskUserQuestion` tool with one or more questions
2. The ACP adapter converts each question to a permission request
3. The ACP client displays the question with selectable options
4. User selections are collected and returned to Claude as answers
5. Claude continues execution with the user's preferences

## Question Format

Each question includes:

| Field | Description |
|-------|-------------|
| `question` | The full question text |
| `header` | Short label (max 12 chars) displayed as a chip/tag |
| `options` | 2-4 choices, each with `label` and `description` |
| `multiSelect` | Whether multiple options can be selected |

## ACP Client Integration

Questions are sent via `requestPermission()` with this structure:

```typescript
{
  options: [
    { kind: "allow_once", name: "Option Label - Description", optionId: "Option Label" },
    // ... more options
    { kind: "allow_once", name: "Other (type custom answer)", optionId: "__other__" }
  ],
  sessionId: "...",
  toolCall: {
    toolCallId: "...",
    rawInput: { question: "...", header: "..." },
    title: "Header Text"
  },
  _meta: {
    claudeCode: {
      questionType: "askUserQuestion",
      multiSelect: false
    }
  }
}
```

### Handling Responses

The adapter expects a standard permission response:

```typescript
{
  outcome: {
    outcome: "selected",
    optionId: "Selected Option Label"  // or "__other__" for custom input
  }
}
```

For the "Other" option, clients can provide custom text via `_meta`:

```typescript
{
  outcome: {
    outcome: "selected",
    optionId: "__other__",
    _meta: { customText: "User's custom answer" }
  }
}
```

### MultiSelect Handling

When `multiSelect` is `true`, the client should allow selecting multiple options. Currently, multiple selections are comma-separated in the answer string.

## Tool Info Display

The `toolInfoFromToolUse` function formats questions for display:

```typescript
{
  title: "Framework",  // First question's header
  kind: "think",
  content: [{
    type: "content",
    content: {
      type: "text",
      text: "Which framework do you prefer?\n  - React: Popular UI library\n  - Vue: Progressive framework"
    }
  }]
}
```

## Example Flow

1. **Claude sends AskUserQuestion:**
```json
{
  "name": "AskUserQuestion",
  "input": {
    "questions": [{
      "question": "Which testing framework should we use?",
      "header": "Testing",
      "options": [
        { "label": "Jest", "description": "Popular JavaScript testing framework" },
        { "label": "Vitest", "description": "Vite-native, fast testing framework" }
      ],
      "multiSelect": false
    }]
  }
}
```

2. **User sees permission request with options:**
   - Jest - Popular JavaScript testing framework
   - Vitest - Vite-native, fast testing framework
   - Other (type custom answer)

3. **User selects "Vitest"**

4. **Claude receives:**
```json
{
  "questions": [...],
  "answers": {
    "Which testing framework should we use?": "Vitest"
  }
}
```

5. **Claude continues** with the knowledge that the user prefers Vitest.

## Cancellation

If the user cancels (closes the dialog or clicks cancel), the tool returns:

```typescript
{
  behavior: "deny",
  message: "User cancelled the question",
  interrupt: true
}
```

Claude will acknowledge the cancellation and may ask differently or proceed with defaults.
