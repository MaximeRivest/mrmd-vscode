/**
 * Rich Variable Explorer Panel for mrmd
 *
 * WebView-based variable explorer with RStudio-like columnar display.
 * Uses MRP protocol to fetch variables from mrmd-python.
 */

import * as vscode from 'vscode';
import { MrpClient, MrpVariable } from '../mrp-client';

export class VariablePanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mrmd.variablePanel';

    private _view?: vscode.WebviewView;
    private _variables: MrpVariable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private getClient: () => MrpClient | null
    ) {}

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

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refresh();
            }
        });

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'refresh':
                    await this.refresh();
                    break;
                case 'clear':
                    vscode.commands.executeCommand('mrmd.clearVariables');
                    break;
                case 'copy':
                    await vscode.env.clipboard.writeText(data.value);
                    vscode.window.showInformationMessage(`Copied: ${data.value}`);
                    break;
                case 'insert':
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        await editor.edit(editBuilder => {
                            editBuilder.insert(editor.selection.active, data.value);
                        });
                    }
                    break;
                case 'expand':
                    await this.expandVariable(data.path);
                    break;
            }
        });

        this.refresh();
    }

    public async refresh(): Promise<void> {
        const client = this.getClient();
        if (!client) {
            this._variables = [];
            this._updateView();
            return;
        }

        try {
            const response = await client.getVariables();
            this._variables = response.variables || [];
        } catch {
            this._variables = [];
        }

        this._updateView();
    }

    private async expandVariable(path: string): Promise<void> {
        const client = this.getClient();
        if (!client) return;

        try {
            const response = await client.inspectObject(path);
            this._view?.webview.postMessage({
                type: 'expanded',
                path: path,
                children: response.children || []
            });
        } catch {
            // Ignore
        }
    }

    private _updateView() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'update',
                variables: this._variables
            });
        }
    }

    public dispose() {}

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Variables</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --hover-bg: var(--vscode-list-hoverBackground);
            --header-bg: var(--vscode-sideBarSectionHeader-background);
            --type-color: var(--vscode-symbolIcon-classForeground, #4EC9B0);
            --value-color: var(--vscode-symbolIcon-stringForeground, #CE9178);
            --number-color: var(--vscode-symbolIcon-numberForeground, #B5CEA8);
            --size-color: var(--vscode-descriptionForeground);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size, 13px);
            color: var(--fg-color);
            background: var(--bg-color);
            padding: 0;
            overflow-x: auto;
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
        .toolbar .count { color: var(--size-color); font-size: 11px; padding: 4px 8px; }

        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        thead { position: sticky; top: 32px; z-index: 50; }

        th {
            background: var(--header-bg);
            padding: 6px 8px;
            text-align: left;
            font-weight: 500;
            border-bottom: 1px solid var(--border-color);
            white-space: nowrap;
        }

        td {
            padding: 4px 8px;
            border-bottom: 1px solid var(--border-color);
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        tr:hover td { background: var(--hover-bg); }

        tr.group-header td {
            background: var(--header-bg);
            font-weight: 500;
            padding: 8px;
        }

        .name-cell { display: flex; align-items: center; gap: 6px; }

        .expand-btn {
            width: 16px; height: 16px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; opacity: 0.7; flex-shrink: 0;
        }
        .expand-btn:hover { opacity: 1; }
        .expand-btn.expanded { transform: rotate(90deg); }
        .expand-btn.placeholder { visibility: hidden; }

        .color-dot {
            width: 8px; height: 8px; border-radius: 50%;
            display: inline-block; margin-right: 6px;
        }
        .color-dot.data { background: #4FC3F7; }
        .color-dot.collection { background: #FFB74D; }
        .color-dot.primitive { background: #81C784; }
        .color-dot.object { background: #BA68C8; }
        .color-dot.callable { background: #64B5F6; }

        .var-name { font-weight: 500; cursor: pointer; }
        .var-name:hover { text-decoration: underline; }
        .type-cell { color: var(--type-color); font-family: var(--vscode-editor-font-family); }
        .shape-cell { color: var(--number-color); font-family: var(--vscode-editor-font-family); }
        .size-cell { color: var(--size-color); text-align: right; font-size: 11px; }
        .value-cell { color: var(--value-color); font-family: var(--vscode-editor-font-family); max-width: 250px; }

        .action-btn {
            background: transparent; border: none; color: var(--fg-color);
            cursor: pointer; padding: 2px 4px; opacity: 0;
        }
        tr:hover .action-btn { opacity: 0.7; }
        .action-btn:hover { opacity: 1 !important; }

        .nested.nested-1 .name-cell { padding-left: 20px; }
        .nested.nested-2 .name-cell { padding-left: 40px; }
        .nested.nested-3 .name-cell { padding-left: 60px; }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--size-color);
        }
        .empty-state .icon { font-size: 32px; margin-bottom: 12px; opacity: 0.5; }
    </style>
</head>
<body>
    <div class="toolbar">
        <button onclick="refresh()">↻ Refresh</button>
        <button onclick="clearVars()">🗑 Clear</button>
        <div class="spacer"></div>
        <span class="count" id="var-count">0 variables</span>
    </div>

    <table id="var-table">
        <thead>
            <tr>
                <th style="width: 30px;"></th>
                <th>Name</th>
                <th>Type</th>
                <th>Shape</th>
                <th>Size</th>
                <th>Value</th>
                <th style="width: 40px;"></th>
            </tr>
        </thead>
        <tbody id="var-body"></tbody>
    </table>

    <div class="empty-state" id="empty-state" style="display: none;">
        <div class="icon">📊</div>
        <div>No variables yet</div>
        <div style="margin-top: 8px; font-size: 11px;">Run some Python code to see variables here</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let variables = [];
        let expandedPaths = new Set();
        const expandedChildren = new Map();

        function refresh() { vscode.postMessage({ type: 'refresh' }); }
        function clearVars() { vscode.postMessage({ type: 'clear' }); }
        function copyVar(name) { vscode.postMessage({ type: 'copy', value: name }); }
        function insertVar(name) { vscode.postMessage({ type: 'insert', value: name }); }

        function toggleExpand(path, btn) {
            if (expandedPaths.has(path)) {
                expandedPaths.delete(path);
                expandedChildren.delete(path);
                btn.classList.remove('expanded');
                removeChildRows(path);
            } else {
                expandedPaths.add(path);
                btn.classList.add('expanded');
                vscode.postMessage({ type: 'expand', path: path });
            }
        }

        function removeChildRows(parentPath) {
            document.querySelectorAll(\`tr[data-parent="\${parentPath}"]\`).forEach(row => {
                const childPath = row.getAttribute('data-path');
                if (childPath) {
                    removeChildRows(childPath);
                    expandedPaths.delete(childPath);
                    expandedChildren.delete(childPath);
                }
                row.remove();
            });
        }

        function getDepthFromPath(path) {
            const matches = path.match(/[\\.[]/g);
            return matches ? matches.length : 0;
        }

        function formatSize(bytes) {
            if (bytes === undefined || bytes === null) return '';
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        }

        function escapeHtml(text) {
            if (!text) return '';
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function renderVariableRow(v, depth = 0, parentPath = '') {
            if (!v) return '';
            const path = v.path || v.name || '';
            const isExpanded = expandedPaths.has(path);
            const shapeOrLen = v.shape || (v.length !== undefined ? v.length : '');
            const nestClass = depth > 0 ? \`nested nested-\${Math.min(depth, 3)}\` : '';
            const kind = v.kind || 'object';
            const name = v.name || path.split(/[\\.[]/g).pop()?.replace(']', '') || path;
            const valueDisplay = v.preview || '';
            const parentAttr = parentPath ? \`data-parent="\${escapeHtml(parentPath)}"\` : '';

            return \`
                <tr data-path="\${escapeHtml(path)}" data-kind="\${kind}" \${parentAttr}>
                    <td>
                        \${v.expandable
                            ? \`<span class="expand-btn \${isExpanded ? 'expanded' : ''}" onclick="toggleExpand('\${escapeHtml(path)}', this)">▶</span>\`
                            : '<span class="expand-btn placeholder"></span>'
                        }
                    </td>
                    <td>
                        <div class="name-cell \${nestClass}">
                            <span class="color-dot \${kind}"></span>
                            <span class="var-name" onclick="copyVar('\${escapeHtml(path)}')" title="Click to copy">\${escapeHtml(name)}</span>
                        </div>
                    </td>
                    <td class="type-cell">\${escapeHtml(v.type)}</td>
                    <td class="shape-cell">\${escapeHtml(String(shapeOrLen))}</td>
                    <td class="size-cell">\${formatSize(v.memory_size)}</td>
                    <td class="value-cell" title="\${escapeHtml(valueDisplay)}">\${escapeHtml(valueDisplay)}</td>
                    <td><button class="action-btn" onclick="insertVar('\${escapeHtml(path)}')" title="Insert">⎘</button></td>
                </tr>
            \`;
        }

        function renderVariables() {
            const tbody = document.getElementById('var-body');
            const emptyState = document.getElementById('empty-state');
            const varCount = document.getElementById('var-count');

            if (variables.length === 0) {
                tbody.innerHTML = '';
                emptyState.style.display = 'block';
                varCount.textContent = '0 variables';
                return;
            }

            emptyState.style.display = 'none';
            varCount.textContent = \`\${variables.length} variable\${variables.length !== 1 ? 's' : ''}\`;

            const groups = {
                data: { label: 'Data', items: [] },
                collection: { label: 'Collections', items: [] },
                primitive: { label: 'Values', items: [] },
                object: { label: 'Objects', items: [] },
                callable: { label: 'Functions', items: [] }
            };

            for (const v of variables) {
                const kind = v.kind || 'object';
                if (groups[kind]) groups[kind].items.push(v);
                else groups['object'].items.push(v);
            }

            let html = '';
            for (const kind of ['data', 'collection', 'primitive', 'object', 'callable']) {
                const group = groups[kind];
                if (group.items.length > 0) {
                    html += \`<tr class="group-header"><td colspan="7"><span class="color-dot \${kind}"></span>\${group.label} (\${group.items.length})</td></tr>\`;
                    for (const v of group.items) html += renderVariableRow(v);
                }
            }

            tbody.innerHTML = html;
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'update':
                    variables = message.variables || [];
                    renderVariables();
                    break;
                case 'expanded':
                    const parentRow = document.querySelector(\`tr[data-path="\${message.path}"]\`);
                    if (parentRow && message.children?.length > 0) {
                        expandedChildren.set(message.path, message.children);
                        const depth = getDepthFromPath(message.path) + 1;
                        let childHtml = '';
                        for (const child of message.children) {
                            if (!child.path) child.path = child.name;
                            childHtml += renderVariableRow(child, depth, message.path);
                        }
                        parentRow.insertAdjacentHTML('afterend', childHtml);
                    }
                    break;
            }
        });

        renderVariables();
    </script>
</body>
</html>`;
    }
}
