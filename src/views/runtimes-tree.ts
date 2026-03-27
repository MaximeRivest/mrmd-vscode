/**
 * Runtimes Tree View
 *
 * Shows running runtimes from the daemon. Each runtime displays
 * language, port, status, and consuming documents as children.
 *
 * Actions: Stop, Restart (inline buttons on each runtime).
 * Refreshes on: runtime events, manual refresh, daemon reconnect.
 */

import * as vscode from 'vscode';
import { MrmdClient } from '../daemon-client';

interface RuntimeInfo {
    name: string;
    language: string;
    port: number;
    pid: number;
    url: string;
    cwd: string;
    interpreter: string | null;
    environment: string | null;
    alive: boolean;
    startedAt: string;
    consumers: string[];
}

type TreeElement = RuntimeInfo | { kind: 'consumer'; path: string; runtime: string };

export class RuntimesTreeProvider implements vscode.TreeDataProvider<TreeElement> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private client: MrmdClient | null = null;
    private runtimes: RuntimeInfo[] = [];
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _refreshing = false;

    setClient(client: MrmdClient): void {
        this.client = client;
        this.refresh();
    }

    clearClient(): void {
        this.client = null;
        this.runtimes = [];
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
        this._onDidChangeTreeData.fire();
    }

    async refresh(): Promise<void> {
        if (this._refreshing) return;
        this._refreshing = true;
        try {
            if (!this.client?.connected) {
                this.runtimes = [];
            } else {
                try {
                    this.runtimes = await this.client.runtimes.list({});
                } catch {
                    this.runtimes = [];
                }
            }
            this._onDidChangeTreeData.fire();
        } finally {
            this._refreshing = false;
        }
    }

    /** Debounced refresh for event-driven updates. */
    refreshDebounced(): void {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            this.refresh();
        }, 200);
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        if ('kind' in element && element.kind === 'consumer') {
            const item = new vscode.TreeItem(element.path, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('file');
            item.description = '';
            item.contextValue = 'consumer';
            return item;
        }

        const rt = element as RuntimeInfo;
        const hasConsumers = rt.consumers && rt.consumers.length > 0;
        const state = hasConsumers
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None;

        const item = new vscode.TreeItem(rt.language, state);
        item.description = `port ${rt.port}`;
        item.tooltip = [
            `${rt.name}`,
            `PID: ${rt.pid}`,
            `URL: ${rt.url}`,
            `CWD: ${rt.cwd}`,
            rt.environment ? `Env: ${rt.environment}` : null,
            rt.interpreter ? `Interpreter: ${rt.interpreter}` : null,
            `Started: ${rt.startedAt}`,
        ].filter(Boolean).join('\n');

        item.iconPath = rt.alive
            ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
            : new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('testing.iconFailed'));

        item.contextValue = 'runtime';
        return item;
    }

    getChildren(element?: TreeElement): TreeElement[] {
        if (!element) {
            return this.runtimes;
        }

        if (!('kind' in element) && (element as RuntimeInfo).consumers) {
            const rt = element as RuntimeInfo;
            return rt.consumers.map(p => ({ kind: 'consumer' as const, path: p, runtime: rt.name }));
        }

        return [];
    }
}
