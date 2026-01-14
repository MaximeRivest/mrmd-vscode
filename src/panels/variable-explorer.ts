/**
 * Variable Explorer for mrmd
 *
 * TreeView-based variable explorer that works in all VS Code forks.
 * Fallback for environments where WebViews have issues.
 * Uses MRP protocol to fetch variables.
 */

import * as vscode from 'vscode';
import { MrpClient, MrpVariable } from '../mrp-client';

type TreeNode = VariableItem | GroupHeader;

export class VariableExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private variables: MrpVariable[] = [];

    constructor(private getClient: () => MrpClient | null) {}

    async refresh(): Promise<void> {
        const client = this.getClient();
        if (!client) {
            this.variables = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const response = await client.getVariables();
            this.variables = response.variables || [];
        } catch {
            this.variables = [];
        }

        this._onDidChangeTreeData.fire();
    }

    clear(): void {
        this.variables = [];
        this._onDidChangeTreeData.fire();
    }

    private async inspectObject(path: string): Promise<MrpVariable[]> {
        const client = this.getClient();
        if (!client) return [];

        try {
            const response = await client.inspectObject(path);
            return response.children || [];
        } catch {
            return [];
        }
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            return this.getRootItems();
        }

        if (element instanceof GroupHeader) {
            return element.items.map(v => new VariableItem(v, v.path || v.name, 0));
        }

        if (element instanceof VariableItem && element.variable.expandable && element.path) {
            const children = await this.inspectObject(element.path);
            return children.map(child =>
                new VariableItem(child, child.path || child.name, element.depth + 1)
            );
        }

        return [];
    }

    private getRootItems(): TreeNode[] {
        const groups: Record<string, { icon: string; label: string; color: string; items: MrpVariable[] }> = {
            data: { icon: 'table', label: 'Data', color: 'charts.blue', items: [] },
            collection: { icon: 'symbol-array', label: 'Collections', color: 'charts.orange', items: [] },
            primitive: { icon: 'symbol-variable', label: 'Values', color: 'charts.green', items: [] },
            object: { icon: 'symbol-class', label: 'Objects', color: 'charts.purple', items: [] },
            callable: { icon: 'symbol-method', label: 'Functions', color: 'charts.yellow', items: [] },
        };

        for (const v of this.variables) {
            const kind = v.kind || 'object';
            if (groups[kind]) {
                groups[kind].items.push(v);
            } else {
                groups['object'].items.push(v);
            }
        }

        const items: TreeNode[] = [];
        const order = ['data', 'collection', 'primitive', 'object', 'callable'];

        for (const kind of order) {
            const group = groups[kind];
            if (group.items.length > 0) {
                items.push(new GroupHeader(group.label, group.icon, group.color, group.items));
            }
        }

        if (items.length === 0) {
            const emptyItem = new vscode.TreeItem('No variables yet');
            emptyItem.description = 'Run some code to see variables';
            emptyItem.iconPath = new vscode.ThemeIcon('info');
            return [emptyItem as TreeNode];
        }

        return items;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

class GroupHeader extends vscode.TreeItem {
    constructor(
        label: string,
        icon: string,
        color: string,
        public readonly items: MrpVariable[]
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'group';
        this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
        this.description = `${items.length}`;

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${label}** (${items.length} items)\n\n`);
        if (items.length > 0) {
            const preview = items.slice(0, 5).map(v => `- \`${v.name}\`: ${v.type}`).join('\n');
            md.appendMarkdown(preview);
            if (items.length > 5) {
                md.appendMarkdown(`\n- *...and ${items.length - 5} more*`);
            }
        }
        this.tooltip = md;
    }
}

class VariableItem extends vscode.TreeItem {
    constructor(
        public readonly variable: MrpVariable,
        public readonly path: string,
        public readonly depth: number = 0
    ) {
        const collapsible = variable.expandable
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        super(variable.name, collapsible);

        this.resourceUri = vscode.Uri.parse(`mrmd-var:///${path}`);
        this.description = this.buildDescription();
        this.tooltip = this.buildTooltip();
        this.iconPath = this.getIcon();
        this.contextValue = variable.kind;

        if (!variable.expandable && variable.kind === 'primitive') {
            this.command = {
                command: 'mrmd.copyVariable',
                title: 'Copy Variable Name',
                arguments: [this.path]
            };
        }
    }

    private buildDescription(): string {
        const v = this.variable;
        const parts: string[] = [];

        let typeStr = v.type;
        if (v.shape) {
            typeStr += v.shape;
        } else if (v.length !== undefined) {
            typeStr += `[${v.length}]`;
        }
        parts.push(typeStr);

        parts.push('→');

        if (v.preview) {
            let preview = v.preview.replace(/\n/g, ' ').replace(/\s+/g, ' ');
            if (preview.length > 35) {
                preview = preview.slice(0, 34) + '…';
            }
            parts.push(preview);
        } else if (v.columns && v.columns.length > 0) {
            const cols = v.columns.slice(0, 3).join(', ');
            parts.push(`[${cols}${v.columns.length > 3 ? '…' : ''}]`);
        } else if (v.keys && v.keys.length > 0) {
            const keys = v.keys.slice(0, 3).join(', ');
            parts.push(`{${keys}${v.keys.length > 3 ? '…' : ''}}`);
        } else {
            parts.push('•');
        }

        return parts.join(' ');
    }

    private buildTooltip(): vscode.MarkdownString {
        const v = this.variable;
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        md.appendMarkdown(`## \`${v.name}\`\n\n`);
        md.appendMarkdown(`| | |\n|:--|:--|\n`);
        md.appendMarkdown(`| **Type** | \`${v.type}\` |\n`);

        if (v.shape) {
            md.appendMarkdown(`| **Shape** | \`${v.shape}\` |\n`);
        }
        if (v.dtype) {
            md.appendMarkdown(`| **Dtype** | \`${v.dtype}\` |\n`);
        }
        if (v.length !== undefined) {
            md.appendMarkdown(`| **Length** | ${v.length} |\n`);
        }
        if (v.memory_size !== undefined) {
            md.appendMarkdown(`| **Memory** | ${this.formatBytes(v.memory_size)} |\n`);
        }

        if (v.columns && v.columns.length > 0) {
            md.appendMarkdown(`\n**Columns** (${v.columns.length}):\n`);
            md.appendCodeblock(v.columns.slice(0, 20).join(', ') + (v.columns.length > 20 ? ', ...' : ''), 'text');
        }

        if (v.keys && v.keys.length > 0) {
            md.appendMarkdown(`\n**Keys** (${v.keys.length}):\n`);
            md.appendCodeblock(v.keys.slice(0, 10).join(', ') + (v.keys.length > 10 ? ', ...' : ''), 'text');
        }

        if (v.preview) {
            md.appendMarkdown(`\n**Value:**\n`);
            md.appendCodeblock(v.preview.slice(0, 500), 'python');
        }

        return md;
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    private getIcon(): vscode.ThemeIcon {
        const v = this.variable;

        const kindColors: Record<string, string> = {
            'data': 'charts.blue',
            'collection': 'charts.orange',
            'primitive': 'charts.green',
            'object': 'charts.purple',
            'callable': 'charts.yellow',
        };

        const color = new vscode.ThemeColor(kindColors[v.kind] || 'foreground');

        switch (v.kind) {
            case 'data':
                if (v.type === 'DataFrame') return new vscode.ThemeIcon('table', color);
                if (v.type === 'Series') return new vscode.ThemeIcon('graph-line', color);
                if (v.type === 'ndarray') return new vscode.ThemeIcon('symbol-array', color);
                return new vscode.ThemeIcon('database', color);

            case 'collection':
                if (v.type === 'dict') return new vscode.ThemeIcon('json', color);
                if (v.type === 'list') return new vscode.ThemeIcon('list-ordered', color);
                if (v.type === 'tuple') return new vscode.ThemeIcon('symbol-array', color);
                return new vscode.ThemeIcon('symbol-array', color);

            case 'primitive':
                if (v.type === 'str') return new vscode.ThemeIcon('symbol-string', color);
                if (['int', 'float', 'complex'].includes(v.type)) return new vscode.ThemeIcon('symbol-number', color);
                if (v.type === 'bool') return new vscode.ThemeIcon('symbol-boolean', color);
                if (v.type === 'NoneType') return new vscode.ThemeIcon('circle-slash', color);
                return new vscode.ThemeIcon('symbol-variable', color);

            case 'callable':
                return new vscode.ThemeIcon('symbol-function', color);

            case 'object':
            default:
                return new vscode.ThemeIcon('symbol-class', color);
        }
    }
}
