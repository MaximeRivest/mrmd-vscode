/**
 * Executions Tree View
 *
 * Shows active and recent executions across all documents.
 * Updates in real-time via execution:changed daemon events.
 *
 * Actions: Cancel (inline button on running/queued items).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { MrmdClient } from '../daemon-client';

interface ExecutionInfo {
    execId: string;
    documentPath: string;
    language: string;
    status: string;
    code: string;
    cellId: string | null;
    runtimeUrl: string | null;
    requestedAt: number;
    startedAt: number | null;
    completedAt: number | null;
    error: any | null;
}

type TreeElement = ExecutionInfo;

const STATUS_ICONS: Record<string, { icon: string; color?: string }> = {
    requested: { icon: 'circle-outline' },
    claimed: { icon: 'circle-outline' },
    ready: { icon: 'circle-large-outline' },
    running: { icon: 'sync~spin', color: 'testing.iconPassed' },
    completed: { icon: 'check', color: 'testing.iconPassed' },
    error: { icon: 'error', color: 'testing.iconFailed' },
    cancelled: { icon: 'circle-slash' },
};

export class ExecutionsTreeProvider implements vscode.TreeDataProvider<TreeElement> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private client: MrmdClient | null = null;
    private executions: ExecutionInfo[] = [];
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _refreshing = false;

    setClient(client: MrmdClient): void {
        this.client = client;
        this.refresh();
    }

    clearClient(): void {
        this.client = null;
        this.executions = [];
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
        this._onDidChangeTreeData.fire();
    }

    async refresh(): Promise<void> {
        if (this._refreshing) return; // prevent re-entrant refresh
        this._refreshing = true;
        try {
            if (!this.client?.connected) {
                this.executions = [];
            } else {
                try {
                    this.executions = await this.client.executions.list({ limit: 20 });
                } catch {
                    this.executions = [];
                }
            }
            this._onDidChangeTreeData.fire();
        } finally {
            this._refreshing = false;
        }
    }

    /** Called by extension when an execution:changed event arrives. Debounced. */
    onExecutionChanged(): void {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            this.refresh();
        }, 200);
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        const exec = element;
        const docName = path.basename(exec.documentPath || '');
        const codeLine = (exec.code || '').split('\n')[0].slice(0, 40);

        const item = new vscode.TreeItem(
            `${exec.language} — ${docName}`,
            vscode.TreeItemCollapsibleState.None,
        );

        // Description: status + duration
        const parts: string[] = [exec.status];
        const duration = _formatDuration(exec);
        if (duration) parts.push(duration);
        item.description = parts.join('  ');

        // Tooltip
        item.tooltip = [
            `ID: ${exec.execId}`,
            `Document: ${exec.documentPath}`,
            `Language: ${exec.language}`,
            `Status: ${exec.status}`,
            duration ? `Duration: ${duration}` : null,
            `Code: ${codeLine}${(exec.code || '').includes('\n') ? '...' : ''}`,
            exec.error ? `Error: ${JSON.stringify(exec.error)}` : null,
        ].filter(Boolean).join('\n');

        // Icon
        const statusInfo = STATUS_ICONS[exec.status] || { icon: 'question' };
        item.iconPath = statusInfo.color
            ? new vscode.ThemeIcon(statusInfo.icon, new vscode.ThemeColor(statusInfo.color))
            : new vscode.ThemeIcon(statusInfo.icon);

        // Context: cancellable if active
        const active = ['requested', 'claimed', 'ready', 'running'].includes(exec.status);
        item.contextValue = active ? 'execution-active' : 'execution-done';

        return item;
    }

    getChildren(element?: TreeElement): TreeElement[] {
        if (element) return [];

        if (this.executions.length === 0 && this.client?.connected) {
            return [];
        }

        return this.executions;
    }
}

function _formatDuration(exec: ExecutionInfo): string {
    const start = exec.startedAt;
    if (!start) return '';
    const end = exec.completedAt || Date.now();
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}
