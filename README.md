# mrmd-vscode

VS Code extension for **mrmd** - execute code blocks in markdown files.

Part of the [mrmd-packages](https://github.com/anthropics/mrmd-packages) ecosystem.

## Features

- **Run code blocks** directly in markdown files
- **Streaming output** - see results as they happen
- **Multiple languages** via IPython magics (Python, Bash, R, SQL, etc.)
- **Variable explorer** - inspect your data
- **Jupyter-like keybindings** - Shift+Enter, Ctrl+Enter

## Installation

### Prerequisites

1. Install the mrmd Python package:
   ```bash
   uv pip install mrmd
   # or
   pip install mrmd
   ```

2. Install the extension from VSIX or marketplace.

### From Source

```bash
cd mrmd-vscode
npm install
npm run build
# Then install the .vsix from VS Code
```

## Usage

1. Open a markdown file with code blocks:

   ~~~markdown
   # My Analysis

   ```python
   import pandas as pd
   df = pd.DataFrame({'x': [1, 2, 3], 'y': [4, 5, 6]})
   df.describe()
   ```
   ~~~

2. Click **Run** above the code block, or press `Shift+Enter`

3. Output appears below the code block:

   ~~~markdown
   ```python
   df.describe()
   ```

   ```output
              x    y
   count  3.0  3.0
   mean   2.0  5.0
   ...
   ```
   ~~~

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Shift+Enter` | Run block and advance |
| `Ctrl+Enter` | Run block |
| `Ctrl+Shift+Enter` | Run all blocks |
| `Escape` | Interrupt execution |
| `Alt+PageUp` | Navigate to previous block |
| `Alt+PageDown` | Navigate to next block |
| `Ctrl+Shift+D` | Delete output |
| `Ctrl+Shift+\` | Toggle collapse output |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `mrmd.autoStart` | `true` | Auto-start services when opening markdown |
| `mrmd.orchestratorUrl` | `http://localhost:41580` | URL of mrmd orchestrator |
| `mrmd.runtimeUrl` | (empty) | Direct URL to mrmd-python (bypasses orchestrator) |
| `mrmd.showCodeLens` | `true` | Show Run buttons above code blocks |
| `mrmd.defaultSession` | `shared` | Session mode: `shared` or `dedicated` |
| `mrmd.juiceLevel` | `0` | AI juice level (0-4) |

## Supported Languages

Python is executed directly. Other languages use IPython magics:

| Language | Magic | Notes |
|----------|-------|-------|
| Python | (native) | Default |
| Bash/Shell | `%%bash` | Shell commands |
| R | `%%R` | Requires rpy2 |
| SQL | `%%sql` | Requires ipython-sql |
| JavaScript | `%%javascript` | Browser context |
| HTML | `%%html` | Rendered in output |
| LaTeX | `%%latex` | Math rendering |

## Architecture

```
┌─────────────────────────────────────────┐
│           mrmd-vscode                    │
│  (CodeLens, decorations, panels)        │
└────────────────┬────────────────────────┘
                 │ HTTP/SSE (MRP)
                 │
┌────────────────▼────────────────────────┐
│           mrmd-python                    │
│  (IPython runtime, MRP server)          │
└─────────────────────────────────────────┘
```

The extension communicates with `mrmd-python` via the **MRP (MRMD Runtime Protocol)** - a simple HTTP/SSE API for code execution.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch

# Package
npx vsce package
```

## Related Packages

- `mrmd` - Main orchestrator CLI
- `mrmd-python` - Python runtime (MRP server)
- `mrmd-sync` - Real-time collaboration server
- `mrmd-editor` - Web-based editor
- `mrmd-ai` - AI completion/fix server

## License

MIT
