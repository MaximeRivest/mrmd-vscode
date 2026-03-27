/**
 * Environments Tree View
 *
 * Shows Python environments and interpreters discovered on this machine.
 * The auto-resolved environment is marked with a star.
 *
 * Actions:
 *   - "Use this environment" → prefs.setProject
 *   - "Install mrmd-python" → env.ensureBridge (with confirmation)
 *   - Refresh
 *
 * Data comes from the daemon's env.discover RPC (our Python discovery utils).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { MrmdClient } from '../daemon-client';

interface EnvironmentInfo {
    path: string;
    type: 'venv' | 'conda';
    pythonVersion: string | null;
    hasBridge: boolean;
    source: string;
}

interface InterpreterInfo {
    path: string;
    version: string;
    source: string;
    implementation: string;
}

interface ResolveResult {
    environment: string | null;
    interpreter: string | null;
    via: string;
}

interface DiscoverResult {
    interpreters: InterpreterInfo[];
    environments: EnvironmentInfo[];
    resolved: ResolveResult | null;
    resolvedInterpreter: { path: string; version: string | null; source: string } | null;
}

type TreeElement =
    | { kind: 'section'; label: string; id: string }
    | { kind: 'env'; env: EnvironmentInfo; selected: boolean }
    | { kind: 'interpreter'; interp: InterpreterInfo }
    | { kind: 'config-item'; label: string; value: string; command?: string }
    | { kind: 'empty'; message: string; fix?: string };

export class EnvironmentsTreeProvider implements vscode.TreeDataProvider<TreeElement> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private client: MrmdClient | null = null;
    private data: DiscoverResult | null = null;
    private projectRoot: string | null = null;

    setClient(client: MrmdClient): void {
        this.client = client;
        this.refresh();
    }

    clearClient(): void {
        this.client = null;
        this.data = null;
        this._onDidChangeTreeData.fire();
    }

    async refresh(): Promise<void> {
        if (!this.client?.connected) {
            this.data = null;
            this._onDidChangeTreeData.fire();
            return;
        }

        // Use the first workspace folder as cwd/projectRoot
        const folder = vscode.workspace.workspaceFolders?.[0];
        const cwd = folder?.uri.fsPath || process.cwd();
        this.projectRoot = cwd;

        try {
            this.data = await this.client._call('env.discover', {
                language: 'python',
                cwd,
                projectRoot: cwd,
            });
        } catch {
            this.data = null;
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        switch (element.kind) {
            case 'section': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
                item.contextValue = 'section';
                return item;
            }

            case 'env': {
                const { env, selected } = element;
                const label = selected ? `★ ${path.basename(env.path)}` : path.basename(env.path);
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

                const parts: string[] = [];
                if (env.pythonVersion) parts.push(env.pythonVersion);
                parts.push(env.hasBridge ? 'mrmd-python ✓' : 'mrmd-python ✗');
                item.description = parts.join('  ');

                item.tooltip = [
                    env.path,
                    `Type: ${env.type}`,
                    `Source: ${env.source}`,
                    `Python: ${env.pythonVersion || '?'}`,
                    `mrmd-python: ${env.hasBridge ? 'installed' : 'not installed'}`,
                    selected ? '(auto-selected)' : '',
                ].filter(Boolean).join('\n');

                if (env.hasBridge) {
                    item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
                } else {
                    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
                }

                item.contextValue = env.hasBridge ? 'env-ready' : 'env-needs-bridge';
                return item;
            }

            case 'interpreter': {
                const { interp } = element;
                const item = new vscode.TreeItem(
                    `python ${interp.version}`,
                    vscode.TreeItemCollapsibleState.None,
                );
                item.description = interp.source;
                item.tooltip = `${interp.path}\nSource: ${interp.source}\nImplementation: ${interp.implementation}`;
                item.iconPath = new vscode.ThemeIcon('symbol-variable');
                item.contextValue = 'interpreter';
                return item;
            }

            case 'config-item': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.description = element.value;
                item.contextValue = 'config-item';
                if (element.command) {
                    item.command = {
                        command: element.command,
                        title: element.label,
                    };
                }
                item.iconPath = new vscode.ThemeIcon('settings-gear');
                return item;
            }

            case 'empty': {
                const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
                if (element.fix) {
                    item.tooltip = element.fix;
                }
                item.contextValue = 'empty';
                return item;
            }
        }
    }

    getChildren(element?: TreeElement): TreeElement[] {
        if (!this.data) {
            if (!this.client?.connected) {
                return [{ kind: 'empty', message: 'Not connected to daemon' }];
            }
            return [{ kind: 'empty', message: 'Loading...' }];
        }

        // Root level: sections
        if (!element) {
            const sections: TreeElement[] = [];
            sections.push({ kind: 'section', label: 'Environments', id: 'envs' });
            sections.push({ kind: 'section', label: 'Interpreters', id: 'interpreters' });
            if (this.data?.resolved) {
                sections.push({ kind: 'section', label: 'Config', id: 'config' });
            }
            return sections;
        }

        // Children of sections
        if (element.kind === 'section') {
            if (element.id === 'envs') {
                if (this.data.environments.length === 0) {
                    return [{ kind: 'empty', message: 'No environments found', fix: 'Create one with: uv venv' }];
                }
                const selectedPath = this.data.resolved?.environment || null;
                return this.data.environments.map(env => ({
                    kind: 'env' as const,
                    env,
                    selected: env.path === selectedPath,
                }));
            }

            if (element.id === 'interpreters') {
                if (this.data.interpreters.length === 0) {
                    return [{ kind: 'empty', message: 'No interpreters found' }];
                }
                return this.data.interpreters.map(interp => ({
                    kind: 'interpreter' as const,
                    interp,
                }));
            }

            if (element.id === 'config' && this.data.resolved) {
                const r = this.data.resolved as any;
                return [
                    { kind: 'config-item' as const, label: 'Scope', value: r.scope || 'notebook', command: 'mrmd.pickScope' },
                    { kind: 'config-item' as const, label: 'CWD', value: r.cwd || '(project root)', command: 'mrmd.pickCwd' },
                    { kind: 'config-item' as const, label: 'Target', value: r.target || 'local', command: undefined },
                    { kind: 'config-item' as const, label: 'Runtime', value: r.name || '(auto)', command: undefined },
                ];
            }
        }

        return [];
    }

    /** Get the current project root (for commands that need it). */
    getProjectRoot(): string | null {
        return this.projectRoot;
    }

    /** Get an environment's full info by path. */
    getEnvironment(envPath: string): EnvironmentInfo | undefined {
        return this.data?.environments.find(e => e.path === envPath);
    }
}
