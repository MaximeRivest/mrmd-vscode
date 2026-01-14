/**
 * Rich Output Panel for mrmd
 *
 * Displays rich outputs from code execution:
 * - Matplotlib plots (PNG, SVG)
 * - HTML outputs (pandas tables, widgets)
 * - LaTeX rendered math
 * - Images
 */

import * as vscode from 'vscode';
import { MrpDisplayData } from '../mrp-client';

interface OutputItem {
    id: string;
    timestamp: number;
    cellId?: string;
    displayData: MrpDisplayData;
}

export class OutputPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mrmd.outputPanel';

    private _view?: vscode.WebviewView;
    private _outputs: OutputItem[] = [];
    private _outputCounter = 0;
    private _maxOutputs = 50;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'clear':
                    this.clear();
                    break;
                case 'copy':
                    await vscode.env.clipboard.writeText(data.value);
                    vscode.window.showInformationMessage('Copied to clipboard');
                    break;
                case 'save':
                    await this._saveOutput(data.id, data.format);
                    break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._updateView();
            }
        });

        this._updateView();
    }

    public addOutput(displayData: MrpDisplayData, cellId?: string): void {
        const output: OutputItem = {
            id: `output_${++this._outputCounter}`,
            timestamp: Date.now(),
            cellId,
            displayData
        };

        this._outputs.unshift(output);

        if (this._outputs.length > this._maxOutputs) {
            this._outputs = this._outputs.slice(0, this._maxOutputs);
        }

        this._updateView();
    }

    public clear(): void {
        this._outputs = [];
        this._updateView();
    }

    public dispose(): void {}

    private _updateView(): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'update',
                outputs: this._outputs
            });
        }
    }

    private async _saveOutput(id: string, format: string): Promise<void> {
        const output = this._outputs.find(o => o.id === id);
        if (!output) return;

        const data = output.displayData.data;

        if (format === 'png' && data['image/png']) {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`output_${id}.png`),
                filters: { 'PNG Image': ['png'] }
            });
            if (uri) {
                const buffer = Buffer.from(data['image/png'], 'base64');
                await vscode.workspace.fs.writeFile(uri, buffer);
                vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
            }
        } else if (format === 'svg' && data['image/svg+xml']) {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`output_${id}.svg`),
                filters: { 'SVG Image': ['svg'] }
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(data['image/svg+xml'], 'utf-8'));
                vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
            }
        } else if (format === 'html' && data['text/html']) {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`output_${id}.html`),
                filters: { 'HTML File': ['html'] }
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(data['text/html'], 'utf-8'));
                vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
            }
        }
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Outputs</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --hover-bg: var(--vscode-list-hoverBackground);
            --header-bg: var(--vscode-sideBarSectionHeader-background);
            --accent-color: var(--vscode-focusBorder);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size, 13px);
            color: var(--fg-color);
            background: var(--bg-color);
            padding: 0;
            overflow-x: hidden;
        }

        .toolbar {
            display: flex;
            gap: 4px;
            padding: 4px 8px;
            border-bottom: 1px solid var(--border-color);
            background: var(--header-bg);
            position: sticky;
            top: 0;
            z-index: 100;
        }

        .toolbar button {
            background: transparent;
            border: none;
            color: var(--fg-color);
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
        }

        .toolbar button:hover { background: var(--hover-bg); }
        .toolbar .spacer { flex: 1; }
        .toolbar .count { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 4px 8px; }

        .outputs {
            padding: 8px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .output-item {
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }

        .output-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            background: var(--header-bg);
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .output-header .type-badge {
            padding: 2px 6px;
            border-radius: 3px;
            font-weight: 500;
            color: white;
        }

        .output-header .type-badge.png { background: #4CAF50; }
        .output-header .type-badge.svg { background: #FF9800; }
        .output-header .type-badge.html { background: #2196F3; }
        .output-header .type-badge.latex { background: #9C27B0; }
        .output-header .type-badge.text { background: #607D8B; }

        .output-header .time { flex: 1; }

        .output-header .actions button {
            background: transparent;
            border: none;
            color: var(--fg-color);
            cursor: pointer;
            padding: 2px 4px;
            opacity: 0.7;
        }

        .output-header .actions button:hover { opacity: 1; }

        .output-content {
            padding: 8px;
            background: var(--bg-color);
            overflow: auto;
            max-height: 400px;
        }

        .output-content img {
            max-width: 100%;
            height: auto;
            display: block;
        }

        .output-content table {
            border-collapse: collapse;
            font-size: 12px;
            width: 100%;
        }

        .output-content table th,
        .output-content table td {
            border: 1px solid var(--border-color);
            padding: 4px 8px;
            text-align: left;
        }

        .output-content table th { background: var(--header-bg); }

        .output-content pre {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            white-space: pre-wrap;
        }

        .output-content.html-content {
            background: white;
            color: black;
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state .icon { font-size: 32px; margin-bottom: 12px; opacity: 0.5; }
    </style>
</head>
<body>
    <div class="toolbar">
        <button onclick="clearOutputs()">🗑 Clear</button>
        <div class="spacer"></div>
        <span class="count" id="output-count">0 outputs</span>
    </div>

    <div class="outputs" id="outputs-container"></div>

    <div class="empty-state" id="empty-state">
        <div class="icon">📊</div>
        <div>No outputs yet</div>
        <div style="margin-top: 8px; font-size: 11px;">
            Run code with plots, HTML, or other rich outputs to see them here
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let outputs = [];

        function clearOutputs() { vscode.postMessage({ type: 'clear' }); }

        function saveOutput(id, format) {
            vscode.postMessage({ type: 'save', id: id, format: format });
        }

        function copyOutput(id, format) {
            const output = outputs.find(o => o.id === id);
            if (!output) return;
            const data = output.displayData.data;
            let value = data['text/plain'] || data['text/html'] || data['image/svg+xml'] || '';
            vscode.postMessage({ type: 'copy', value: value });
        }

        function getOutputType(data) {
            if (data['image/png']) return 'png';
            if (data['image/svg+xml']) return 'svg';
            if (data['text/html']) return 'html';
            if (data['text/latex']) return 'latex';
            return 'text';
        }

        function formatTime(timestamp) {
            return new Date(timestamp).toLocaleTimeString();
        }

        function escapeHtml(text) {
            if (!text) return '';
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function renderOutputContent(output) {
            const data = output.displayData.data;

            if (data['image/png']) {
                return \`<img src="data:image/png;base64,\${data['image/png']}" alt="Plot">\`;
            }
            if (data['image/svg+xml']) {
                return data['image/svg+xml'];
            }
            if (data['text/html']) {
                return \`<div class="html-content">\${data['text/html']}</div>\`;
            }
            if (data['text/latex']) {
                return \`<div class="latex">\${escapeHtml(data['text/latex'])}</div>\`;
            }
            if (data['text/plain']) {
                return \`<pre>\${escapeHtml(data['text/plain'])}</pre>\`;
            }
            return '<em>Unknown output type</em>';
        }

        function renderOutput(output) {
            const type = getOutputType(output.displayData.data);
            const time = formatTime(output.timestamp);

            let actions = '';
            if (type === 'png') {
                actions = \`<button onclick="saveOutput('\${output.id}', 'png')" title="Save PNG">💾</button>\`;
            } else if (type === 'svg') {
                actions = \`
                    <button onclick="saveOutput('\${output.id}', 'svg')" title="Save SVG">💾</button>
                    <button onclick="copyOutput('\${output.id}', 'svg')" title="Copy SVG">📋</button>
                \`;
            } else if (type === 'html') {
                actions = \`<button onclick="saveOutput('\${output.id}', 'html')" title="Save HTML">💾</button>\`;
            }

            return \`
                <div class="output-item" data-id="\${output.id}">
                    <div class="output-header">
                        <span class="type-badge \${type}">\${type.toUpperCase()}</span>
                        <span class="time">\${time}</span>
                        <div class="actions">\${actions}</div>
                    </div>
                    <div class="output-content \${type === 'html' ? 'html-content' : ''}">
                        \${renderOutputContent(output)}
                    </div>
                </div>
            \`;
        }

        function renderOutputs() {
            const container = document.getElementById('outputs-container');
            const emptyState = document.getElementById('empty-state');
            const countEl = document.getElementById('output-count');

            countEl.textContent = \`\${outputs.length} output\${outputs.length !== 1 ? 's' : ''}\`;

            if (outputs.length === 0) {
                container.innerHTML = '';
                emptyState.style.display = 'block';
                return;
            }

            emptyState.style.display = 'none';
            container.innerHTML = outputs.map(renderOutput).join('');
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                outputs = message.outputs || [];
                renderOutputs();
            }
        });

        renderOutputs();
    </script>
</body>
</html>`;
    }
}
