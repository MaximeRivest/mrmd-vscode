# mrmd-vscode Porting Plan

## Overview

Port the VS Code extension from `~/Projects/mrmd/vscode` to use the mrmd-packages ecosystem (MRP protocol, mrmd-python, mrmd-sync, mrmd-ai).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      mrmd-vscode                                 │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    UI Layer (VS Code)                       │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐  │ │
│  │  │  CodeLens    │ │ Decorations  │ │   Variable Panel   │  │ │
│  │  │  Provider    │ │  Provider    │ │   (WebView/Tree)   │  │ │
│  │  └──────────────┘ └──────────────┘ └────────────────────┘  │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐  │ │
│  │  │   Output     │ │  Folding     │ │    Status Bar      │  │ │
│  │  │   Panel      │ │  Provider    │ │    Items           │  │ │
│  │  └──────────────┘ └──────────────┘ └────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│  ┌───────────────────────────▼────────────────────────────────┐ │
│  │                   Execution Layer                           │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │              MRP Client (NEW)                         │  │ │
│  │  │  - HTTP calls to /mrp/v1/execute, /complete, etc.    │  │ │
│  │  │  - SSE streaming for output                           │  │ │
│  │  │  - Session management                                 │  │ │
│  │  └──────────────────────────────────────────────────────┘  │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │           Execution Manager (SIMPLIFIED)              │  │ │
│  │  │  - Queue management                                   │  │ │
│  │  │  - Output injection into markdown                     │  │ │
│  │  │  - Cell tracking by hash                              │  │ │
│  │  └──────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│  ┌───────────────────────────▼────────────────────────────────┐ │
│  │                 Orchestrator Client                         │ │
│  │  - Start/stop mrmd CLI (or connect to existing)            │ │
│  │  - Health checks                                            │ │
│  │  - Port discovery                                           │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│  ┌───────────────────────────▼────────────────────────────────┐ │
│  │              Collaboration Layer (FUTURE)                   │ │
│  │  - Yjs ↔ TextDocument bridge                               │ │
│  │  - Awareness (cursor positions)                             │ │
│  │  - Monitor integration                                      │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                               │
                          HTTP/SSE
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                    mrmd-packages ecosystem                       │
│  ┌────────────┐  ┌─────────────┐  ┌────────────┐  ┌──────────┐  │
│  │mrmd-python │  │ mrmd-sync   │  │  mrmd-ai   │  │   mrmd   │  │
│  │   (MRP)    │  │   (Yjs)     │  │  (DSPy)    │  │  (orch)  │  │
│  └────────────┘  └─────────────┘  └────────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phases

### Phase 1: Core Execution (MVP)

**Goal**: Run Python code in markdown files using mrmd-python via MRP.

| Task | Source | Target | Notes |
|------|--------|--------|-------|
| Create MRP client | NEW | `src/mrp-client.ts` | HTTP/SSE to mrmd-python |
| Port CodeLens provider | `codelens-provider.ts` | `src/codelens-provider.ts` | Minor tweaks |
| Port decorations | `decorations.ts` | `src/decorations.ts` | No changes |
| Create execution manager | `ipython-client.ts` | `src/execution-manager.ts` | Simplified, uses MRP |
| Create orchestrator client | `server-manager.ts` | `src/orchestrator-client.ts` | Starts `mrmd` CLI |
| Create extension entry | `extension.ts` | `src/extension.ts` | Simplified wiring |

**Deliverable**: Extension that can run Python code blocks via mrmd-python.

---

### Phase 2: Rich Features

**Goal**: Variable explorer, output panel, completions.

| Task | Source | Target | Notes |
|------|--------|--------|-------|
| Port variable panel | `variable-panel.ts` | `src/panels/variable-panel.ts` | Adapt to MRP response |
| Port variable explorer | `variable-explorer.ts` | `src/panels/variable-explorer.ts` | TreeView fallback |
| Port output panel | `output-panel.ts` | `src/panels/output-panel.ts` | Minor tweaks |
| Add completions | `completion-provider.ts` | `src/completion-provider.ts` | Via MRP /complete |
| Add hover/inspect | `ipython-client.ts` | `src/mrp-client.ts` | Via MRP /inspect |

**Deliverable**: Full-featured extension matching original capabilities.

---

### Phase 3: AI Integration

**Goal**: AI spells via mrmd-ai.

| Task | Source | Target | Notes |
|------|--------|--------|-------|
| Create AI client | NEW | `src/ai-client.ts` | HTTP to mrmd-ai |
| Add AI commands | NEW | `src/ai-commands.ts` | Finish, fix, etc. |
| Add juice level UI | NEW | `src/ai-commands.ts` | Status bar selector |

**Deliverable**: AI completion/fix commands in VS Code.

---

### Phase 4: Collaboration (Future)

**Goal**: Real-time collaboration via mrmd-sync.

| Task | Source | Target | Notes |
|------|--------|--------|-------|
| Yjs client | NEW | `src/sync/yjs-client.ts` | WebSocket to mrmd-sync |
| TextDocument bridge | NEW | `src/sync/document-bridge.ts` | Yjs ↔ VS Code sync |
| Awareness | NEW | `src/sync/awareness.ts` | Cursor positions |
| Monitor integration | NEW | `src/sync/monitor.ts` | Long-running execution |

**Deliverable**: Multi-user editing with persistent execution.

---

## File Structure

```
mrmd-vscode/
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
├── PORTING-PLAN.md           # This file
├── README.md                 # User documentation
├── CHANGELOG.md              # Version history
│
├── src/
│   ├── extension.ts          # Main entry point
│   │
│   ├── mrp-client.ts         # MRP protocol client (HTTP/SSE)
│   ├── orchestrator-client.ts # Start/stop mrmd services
│   ├── execution-manager.ts  # Queue, output injection
│   │
│   ├── codelens-provider.ts  # Run buttons on code blocks
│   ├── decorations.ts        # Visual styling, running indicators
│   ├── folding-provider.ts   # Fold output blocks
│   ├── completion-provider.ts # Code completion via MRP
│   │
│   ├── panels/
│   │   ├── variable-panel.ts     # WebView variable explorer
│   │   ├── variable-explorer.ts  # TreeView fallback
│   │   └── output-panel.ts       # Rich output display
│   │
│   ├── ai/                   # Phase 3
│   │   ├── ai-client.ts      # HTTP to mrmd-ai
│   │   └── ai-commands.ts    # AI spell commands
│   │
│   └── sync/                 # Phase 4 (future)
│       ├── yjs-client.ts     # WebSocket to mrmd-sync
│       ├── document-bridge.ts # Yjs ↔ TextDocument
│       └── awareness.ts      # Cursor sync
│
├── resources/
│   └── icons/                # Extension icons
│
└── test/
    └── extension.test.ts     # Basic tests
```

---

## MRP Protocol Reference

The extension communicates with mrmd-python via these endpoints:

### Execution

```
POST /mrp/v1/execute
POST /mrp/v1/execute/stream   # SSE streaming
```

Request:
```json
{
  "code": "print('hello')",
  "session": "default",
  "storeHistory": true
}
```

SSE Events:
- `stdout` - `{ "content": "hello\n", "accumulated": "hello\n" }`
- `stderr` - `{ "content": "error\n", "accumulated": "error\n" }`
- `display` - `{ "data": { "image/png": "base64..." } }`
- `result` - `{ "data": { "text/plain": "42" } }`
- `error` - `{ "ename": "NameError", "evalue": "...", "traceback": [...] }`

### Completions

```
POST /mrp/v1/complete
```

Request:
```json
{
  "code": "import nu",
  "cursor": 9,
  "session": "default"
}
```

Response:
```json
{
  "matches": ["numpy", "numbers"],
  "start": 7,
  "end": 9
}
```

### Inspection

```
POST /mrp/v1/inspect
```

Request:
```json
{
  "code": "print",
  "cursor": 5,
  "session": "default"
}
```

Response:
```json
{
  "found": true,
  "data": {
    "text/plain": "print(value, ..., sep=' ', end='\\n', ...)"
  }
}
```

### Variables

```
POST /mrp/v1/variables
```

Request:
```json
{
  "session": "default"
}
```

Response:
```json
{
  "variables": [
    {
      "name": "df",
      "type": "DataFrame",
      "kind": "data",
      "shape": "(100, 5)",
      "preview": "   A  B  C..."
    }
  ]
}
```

---

## Key Differences from Original

| Aspect | Original | New |
|--------|----------|-----|
| Protocol | Custom IPython API | Standard MRP |
| Server | Built-in Python server | External mrmd CLI |
| Sessions | Custom session logic | MRP sessions |
| Streaming | Custom SSE format | MRP SSE format |
| AI | None in extension | mrmd-ai integration |
| Collaboration | None | Future mrmd-sync |

---

## Migration Notes

### What to Keep

- **CodeLens provider logic** - Code block detection, nested fence handling
- **Decoration styling** - Output dimming, running indicators
- **Variable panel HTML/CSS** - WebView UI
- **Output panel HTML/CSS** - Rich output display
- **Keyboard shortcuts** - Shift+Enter, Ctrl+Enter, etc.
- **Commands structure** - Run, navigate, manage outputs

### What to Simplify

- **Server management** - Just shell out to `mrmd` CLI
- **Session logic** - MRP handles sessions
- **Execution queue** - Can be simpler with MRP

### What to Remove

- **brepl/legacy execution** - Not needed with MRP
- **Custom IPython protocol** - Replaced by MRP
- **Setup wizard for uv/Python** - mrmd CLI handles this

---

## Commands

Phase 1 commands:

| Command | Description |
|---------|-------------|
| `mrmd.runBlock` | Run code block at cursor |
| `mrmd.runBlockAdvance` | Run and advance to next |
| `mrmd.runAllBlocks` | Run all code blocks |
| `mrmd.interrupt` | Cancel running execution |
| `mrmd.restartRuntime` | Restart Python session |
| `mrmd.deleteOutput` | Delete output block |
| `mrmd.toggleCollapseOutput` | Fold/unfold output |
| `mrmd.navigateUp` | Jump to previous block |
| `mrmd.navigateDown` | Jump to next block |
| `mrmd.startServer` | Start mrmd services |
| `mrmd.stopServer` | Stop mrmd services |

---

## Configuration

```json
{
  "mrmd.autoStart": {
    "type": "boolean",
    "default": true,
    "description": "Auto-start mrmd services when opening markdown"
  },
  "mrmd.orchestratorUrl": {
    "type": "string",
    "default": "http://localhost:41580",
    "description": "URL of running mrmd orchestrator (if not auto-starting)"
  },
  "mrmd.runtimeUrl": {
    "type": "string",
    "default": "",
    "description": "Direct URL to mrmd-python (bypasses orchestrator)"
  },
  "mrmd.showCodeLens": {
    "type": "boolean",
    "default": true,
    "description": "Show Run buttons above code blocks"
  },
  "mrmd.juiceLevel": {
    "type": "number",
    "default": 0,
    "description": "Default AI juice level (0-4)"
  }
}
```

---

## Testing Strategy

1. **Unit tests** - MRP client, code block parsing
2. **Integration tests** - Extension activation, command execution
3. **Manual testing** - Run against mrmd-python

---

## Timeline Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1 (Core) | 2-3 days | None |
| Phase 2 (Rich) | 2-3 days | Phase 1 |
| Phase 3 (AI) | 1-2 days | Phase 2 |
| Phase 4 (Collab) | 1-2 weeks | Phase 1 |

**MVP (Phase 1)**: Ready for basic use in ~2-3 days of focused work.
