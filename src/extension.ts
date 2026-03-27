/**
 * mrmd VS Code Extension
 *
 * Execute code blocks in markdown files via the mrmd daemon.
 * All editing and execution flows through Yjs — the editor never
 * talks to runtimes directly.
 *
 * Features:
 * - Inline "run" hint on each code cell fence line (clickable, tooltip shows shortcuts)
 * - Ctrl+Enter / Shift+Enter to run from any cell
 * - Zen notebook-style decorations (subtle bg, dimmed fences, quiet output)
 * - Auto-reconnect when daemon restarts
 * - Auto-save after Yjs changes
 */

import * as vscode from 'vscode';
import { connect, MrmdClient } from './daemon-client';
import { DocumentManager, ExecutionEvent } from './document-manager';
import { blockAtCursor, nextBlock, parseBlocks, CodeBlock } from './blocks';
import {
    initDecorations,
    disposeDecorations,
    applyDecorations,
    CellExecutionStatus,
} from './decorations';
import { RuntimesTreeProvider } from './views/runtimes-tree';
import { EnvironmentsTreeProvider } from './views/environments-tree';
import { ExecutionsTreeProvider } from './views/executions-tree';
import { registerLanguageProviders, LanguageProviders } from './language-features';

// ── State ─────────────────────────────────────────────────────

let client: MrmdClient;
let manager: DocumentManager;
let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let inlayHintsProvider: RunInlayHintsProvider;
let runtimesTree: RuntimesTreeProvider;
let environmentsTree: EnvironmentsTreeProvider;
let executionsTree: ExecutionsTreeProvider;
let langProviders: LanguageProviders;

/** Current cursor position — used by decorations for active cell highlight */
let currentCursorLine = -1;
let currentCursorDocUri = '';

/**
 * Active executions: execId → metadata.
 */
const activeExecutions = new Map<string, {
    docPath: string;
    language: string;
    fenceStart: number;
}>();

/**
 * Per-cell execution status for decorations.
 * Key: `${docPath}:${fenceStart}`.
 */
const cellStatuses = new Map<string, CellExecutionStatus>();

function cellKey(docPath: string, fenceStart: number): string {
    return `${docPath}:${fenceStart}`;
}

function log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    output.appendLine(`[${ts}] ${msg}`);
}

// ── Activation ────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    output = vscode.window.createOutputChannel('mrmd');
    context.subscriptions.push(output);
    log('Extension activating...');

    initDecorations();

    // Status bar
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.text = '$(circle-outline) mrmd';
    statusBar.tooltip = 'mrmd: not connected';
    statusBar.show();
    context.subscriptions.push(statusBar);

    // Inline run hints on fence lines
    inlayHintsProvider = new RunInlayHintsProvider();
    context.subscriptions.push(
        vscode.languages.registerInlayHintsProvider(
            { language: 'markdown' },
            inlayHintsProvider,
        ),
    );

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('mrmd.run', (uri?: vscode.Uri, block?: CodeBlock) => {
            if (block) {
                const editor = vscode.window.activeTextEditor;
                if (editor) runBlock(editor, block);
            } else {
                runAtCursor();
            }
        }),
        vscode.commands.registerCommand('mrmd.runAndAdvance', (uri?: vscode.Uri, block?: CodeBlock) => {
            if (block) {
                const editor = vscode.window.activeTextEditor;
                if (editor) runBlock(editor, block, true);
            } else {
                runAtCursor(true);
            }
        }),
        vscode.commands.registerCommand('mrmd.interrupt', (uri?: vscode.Uri, block?: CodeBlock) => {
            if (block) {
                stopLanguage(block.language);
            } else {
                stopAll();
            }
        }),
    );

    // ── Sidebar tree views ──────────────────────────────────

    runtimesTree = new RuntimesTreeProvider();
    environmentsTree = new EnvironmentsTreeProvider();
    executionsTree = new ExecutionsTreeProvider();
    langProviders = registerLanguageProviders(context);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('mrmd.runtimes', runtimesTree),
        vscode.window.registerTreeDataProvider('mrmd.environments', environmentsTree),
        vscode.window.registerTreeDataProvider('mrmd.executions', executionsTree),
    );

    // Sidebar commands
    context.subscriptions.push(
        vscode.commands.registerCommand('mrmd.refreshRuntimes', () => runtimesTree.refresh()),
        vscode.commands.registerCommand('mrmd.refreshEnvironments', () => environmentsTree.refresh()),
        vscode.commands.registerCommand('mrmd.refreshExecutions', () => executionsTree.refresh()),

        vscode.commands.registerCommand('mrmd.stopRuntime', async (item: any) => {
            if (!client || !item?.name) return;
            try {
                await client.runtimes.stop({ name: item.name });
                log(`Stopped runtime: ${item.name}`);
                runtimesTree.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to stop runtime: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('mrmd.restartRuntime', async (item: any) => {
            if (!client || !item?.name) return;
            try {
                await client.runtimes.restart({ name: item.name });
                log(`Restarted runtime: ${item.name}`);
                runtimesTree.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to restart runtime: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('mrmd.useEnvironment', async (item: any) => {
            if (!client) return;
            const envPath = item?.env?.path;
            const projectRoot = environmentsTree.getProjectRoot();
            if (!envPath || !projectRoot) return;

            try {
                await client.preferences.setProject({
                    projectRoot,
                    language: 'python',
                    environment: envPath,
                });
                log(`Set Python environment to: ${envPath}`);
                environmentsTree.refresh();
                vscode.window.showInformationMessage(`Python environment set to ${envPath}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set environment: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('mrmd.installBridge', async (item: any) => {
            if (!client) {
                vscode.window.showErrorMessage('mrmd daemon not connected');
                return;
            }
            const envPath = item?.env?.path;
            if (!envPath) {
                log(`installBridge: no env path in item: ${JSON.stringify(item)}`);
                return;
            }

            log(`Installing mrmd-python into ${envPath}...`);

            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Installing mrmd-python into ${require('path').basename(envPath)}...`,
                        cancellable: false,
                    },
                    async () => {
                        const result = await client._call('env.ensureBridge', {
                            language: 'python',
                            environment: envPath,
                        });
                        if (result.installed) {
                            log(`Installed mrmd-python ${result.version || ''} via ${result.method}`);
                            vscode.window.showInformationMessage(
                                `✓ mrmd-python ${result.version || ''} installed`,
                            );
                        } else {
                            log(`Install failed: ${result.error}`);
                            vscode.window.showErrorMessage(
                                `Failed to install mrmd-python: ${result.error}`,
                            );
                        }
                    },
                );
                environmentsTree.refresh();
            } catch (err: any) {
                log(`Install error: ${err.message}`);
                vscode.window.showErrorMessage(`Failed to install mrmd-python: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('mrmd.cancelExecution', async (item: any) => {
            if (!client) return;
            const execId = item?.execId;
            const docPath = item?.documentPath;
            if (!execId || !docPath) return;

            try {
                await client.executions.cancel({ documentPath: docPath, execId });
                log(`Cancelled execution: ${execId}`);
                executionsTree.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to cancel execution: ${err.message}`);
            }
        }),

        // ── Interactive pickers ───────────────────────────────

        vscode.commands.registerCommand('mrmd.pickEnvironment', async () => {
            if (!client) return;
            const projectRoot = environmentsTree.getProjectRoot();
            if (!projectRoot) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }

            let data: any;
            try {
                data = await client._call('env.discover', {
                    language: 'python',
                    cwd: projectRoot,
                    projectRoot,
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Discovery failed: ${err.message}`);
                return;
            }

            const items: vscode.QuickPickItem[] = [];

            // Environments
            for (const env of (data.environments || [])) {
                const selected = data.resolved?.environment === env.path;
                const bridge = env.hasBridge ? '✓' : '✗ needs install';
                items.push({
                    label: `$(folder) ${env.path}`,
                    description: `${env.type}  python ${env.pythonVersion || '?'}  mrmd-python ${bridge}`,
                    detail: selected ? '★ currently selected' : `source: ${env.source}`,
                    picked: selected,
                    // @ts-ignore — stash env path for use after selection
                    _envPath: env.path,
                    _kind: 'env',
                });
            }

            // Separator
            if (items.length > 0 && (data.interpreters || []).length > 0) {
                items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            }

            // Bare interpreters (no-venv mode)
            for (const interp of (data.interpreters || [])) {
                items.push({
                    label: `$(symbol-variable) python ${interp.version}`,
                    description: `${interp.source}  ${interp.path}`,
                    detail: 'Use without virtual environment',
                    // @ts-ignore
                    _interpreterPath: interp.path,
                    _kind: 'interpreter',
                });
            }

            if (items.length === 0) {
                vscode.window.showWarningMessage('No Python environments or interpreters found. Run: uv venv');
                return;
            }

            const picked = await vscode.window.showQuickPick(items, {
                title: 'Select Python Environment',
                placeHolder: 'Search environments and interpreters...',
                matchOnDescription: true,
                matchOnDetail: true,
            });

            if (!picked) return;

            try {
                const p = picked as any;
                if (p._kind === 'env') {
                    await client.preferences.setProject({
                        projectRoot,
                        language: 'python',
                        environment: p._envPath,
                    });
                    log(`Set environment: ${p._envPath}`);
                    vscode.window.showInformationMessage(`Python environment: ${p._envPath}`);
                } else if (p._kind === 'interpreter') {
                    await client.preferences.setProject({
                        projectRoot,
                        language: 'python',
                        environment: null,  // clear env — use bare interpreter
                        interpreter: p._interpreterPath,
                    });
                    log(`Set interpreter: ${p._interpreterPath} (no venv)`);
                    vscode.window.showInformationMessage(`Python interpreter: ${p._interpreterPath} (no venv)`);
                }
                environmentsTree.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set environment: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('mrmd.pickScope', async () => {
            if (!client) return;
            const projectRoot = environmentsTree.getProjectRoot();
            if (!projectRoot) return;

            const items: vscode.QuickPickItem[] = [
                {
                    label: '$(file) Notebook',
                    description: 'Each document gets its own runtime',
                    detail: 'Separate Python processes per notebook. Full isolation.',
                    // @ts-ignore
                    _scope: 'notebook',
                },
                {
                    label: '$(root-folder) Project',
                    description: 'All documents in this project share one runtime',
                    detail: 'Variables and imports persist across notebooks. Faster startup.',
                    // @ts-ignore
                    _scope: 'project',
                },
                {
                    label: '$(globe) Global',
                    description: 'One runtime per language across all projects',
                    detail: 'Maximum sharing. State persists across projects.',
                    // @ts-ignore
                    _scope: 'global',
                },
            ];

            const picked = await vscode.window.showQuickPick(items, {
                title: 'Runtime Scope',
                placeHolder: 'How should runtimes be shared?',
            });

            if (!picked) return;

            try {
                await client.preferences.setProject({
                    projectRoot,
                    language: 'python',
                    scope: (picked as any)._scope,
                });
                log(`Set scope: ${(picked as any)._scope}`);
                environmentsTree.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set scope: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('mrmd.pickCwd', async () => {
            if (!client) return;
            const projectRoot = environmentsTree.getProjectRoot();
            if (!projectRoot) return;

            const items: vscode.QuickPickItem[] = [
                {
                    label: '$(root-folder) Project Root',
                    description: projectRoot,
                    detail: 'Runtime working directory is the project root (default)',
                    // @ts-ignore
                    _cwd: 'project',
                },
                {
                    label: '$(file-directory) Document Directory',
                    description: 'Changes per notebook',
                    detail: 'Runtime cwd is the directory containing the .md file',
                    // @ts-ignore
                    _cwd: 'document',
                },
                {
                    label: '$(folder-opened) Custom Path...',
                    description: '',
                    detail: 'Enter an absolute path for the runtime working directory',
                    // @ts-ignore
                    _cwd: 'custom',
                },
            ];

            const picked = await vscode.window.showQuickPick(items, {
                title: 'Working Directory',
                placeHolder: 'Where should the runtime run?',
            });

            if (!picked) return;

            let cwdValue = (picked as any)._cwd;

            if (cwdValue === 'custom') {
                const input = await vscode.window.showInputBox({
                    title: 'Custom Working Directory',
                    prompt: 'Enter absolute path for runtime working directory',
                    value: projectRoot,
                    validateInput: (v) => {
                        if (!v.startsWith('/') && !v.match(/^[A-Z]:\\/i)) {
                            return 'Must be an absolute path';
                        }
                        return null;
                    },
                });
                if (!input) return;
                cwdValue = input;
            }

            try {
                await client.preferences.setProject({
                    projectRoot,
                    language: 'python',
                    cwd: cwdValue,
                });
                log(`Set cwd: ${cwdValue}`);
                environmentsTree.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set cwd: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('mrmd.startRuntime', async () => {
            if (!client) return;
            const projectRoot = environmentsTree.getProjectRoot();
            if (!projectRoot) return;

            const languages = ['python', 'bash', 'r', 'julia'];
            const picked = await vscode.window.showQuickPick(
                languages.map(l => ({ label: l })),
                { title: 'Start Runtime', placeHolder: 'Select language' },
            );
            if (!picked) return;

            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Starting ${picked.label} runtime...` },
                    async () => {
                        const rt = await client.runtimes.start({
                            language: picked.label,
                            cwd: projectRoot,
                        });
                        log(`Started runtime: ${rt.name} on port ${rt.port}`);
                        vscode.window.showInformationMessage(`${picked.label} runtime started on port ${rt.port}`);
                    },
                );
                runtimesTree.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to start runtime: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('mrmd.showPreferences', async () => {
            if (!client) return;
            const projectRoot = environmentsTree.getProjectRoot();
            if (!projectRoot) return;

            try {
                const doc = vscode.window.activeTextEditor?.document;
                const docPath = doc?.languageId === 'markdown' ? doc.uri.fsPath : projectRoot;

                const config = await client.preferences.resolve({
                    documentPath: docPath,
                    language: 'python',
                });

                const items: vscode.QuickPickItem[] = [
                    { label: '$(folder) Environment', description: config.environment || '(auto-detected)', detail: `via: ${config.via}` },
                    { label: '$(symbol-variable) Interpreter', description: config.interpreter || '(none)' },
                    { label: '$(layers) Scope', description: config.scope || 'notebook' },
                    { label: '$(folder-opened) Working Directory', description: config.cwd || projectRoot },
                    { label: '$(server) Target', description: config.target || 'local' },
                    { label: '$(tag) Runtime Name', description: config.name || '(auto)' },
                    { label: '', kind: vscode.QuickPickItemKind.Separator },
                    { label: '$(pencil) Change Environment...', description: '', detail: 'Pick a different Python environment' },
                    { label: '$(pencil) Change Scope...', description: '', detail: 'Notebook / Project / Global' },
                    { label: '$(pencil) Change Working Directory...', description: '', detail: 'Project root / Document dir / Custom' },
                ];

                const picked = await vscode.window.showQuickPick(items, {
                    title: `Python Config — ${require('path').basename(projectRoot)}`,
                    placeHolder: 'View current config or change a setting',
                });

                if (!picked) return;

                if (picked.label.includes('Change Environment')) {
                    vscode.commands.executeCommand('mrmd.pickEnvironment');
                } else if (picked.label.includes('Change Scope')) {
                    vscode.commands.executeCommand('mrmd.pickScope');
                } else if (picked.label.includes('Change Working Directory')) {
                    vscode.commands.executeCommand('mrmd.pickCwd');
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to load config: ${err.message}`);
            }
        }),
    );

    // Auto-open Yjs sync for .md files
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.languageId === 'markdown' && manager) {
                ensureDocumentOpen(doc);
            }
        }),
    );

    // ── Cursor / decoration triggers ──────────────────────

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor.document.languageId !== 'markdown') return;
            currentCursorLine = e.textEditor.selection.active.line;
            currentCursorDocUri = e.textEditor.document.uri.toString();
            refreshDecorations(e.textEditor);
        }),
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === 'markdown') {
                currentCursorLine = editor.selection.active.line;
                currentCursorDocUri = editor.document.uri.toString();
                refreshDecorations(editor);
            }
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId !== 'markdown') return;
            const editor = vscode.window.visibleTextEditors.find(
                (ed) => ed.document === e.document,
            );
            if (editor) refreshDecorationsDebounced(editor);
        }),
    );

    // Apply to already-open editors
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.languageId === 'markdown') {
            currentCursorLine = editor.selection.active.line;
            currentCursorDocUri = editor.document.uri.toString();
            refreshDecorations(editor);
        }
    }

    connectToDaemon();
}

export function deactivate(): void {
    manager?.dispose();
    client?.disconnect();
    disposeDecorations();
}

// ── Daemon connection ────────────────────────────────────────

async function connectToDaemon(): Promise<void> {
    try {
        log('Connecting to daemon...');
        statusBar.text = '$(sync~spin) mrmd';
        statusBar.tooltip = 'mrmd: connecting...';

        client = await connect();
        manager = new DocumentManager(client);

        manager.onExecutionDone = (event: ExecutionEvent) => {
            log(`Execution ${event.execId} → ${event.status}`);

            const meta = activeExecutions.get(event.execId);
            activeExecutions.delete(event.execId);

            if (meta) {
                const key = cellKey(meta.docPath, meta.fenceStart);
                const newStatus: CellExecutionStatus['status'] =
                    event.status === 'completed' ? 'success' :
                    event.status === 'error' ? 'error' : 'idle';

                cellStatuses.set(key, {
                    fenceStart: meta.fenceStart,
                    language: meta.language,
                    status: newStatus,
                });

                if (newStatus !== 'idle') {
                    setTimeout(() => {
                        const current = cellStatuses.get(key);
                        if (current && current.status === newStatus) {
                            cellStatuses.delete(key);
                            refreshAllVisibleEditors();
                        }
                    }, 5000);
                }
            }

            updateStatusBar();
            inlayHintsProvider.refresh();
            refreshAllVisibleEditors();
        };

        statusBar.text = '$(circle-filled) mrmd';
        statusBar.tooltip = 'mrmd: connected';
        log('Connected to daemon');

        // ── Wire sidebar tree views + language features to daemon ─────
        runtimesTree.setClient(client);
        environmentsTree.setClient(client);
        executionsTree.setClient(client);
        langProviders.setClient(client);

        // Real-time updates from daemon events
        client.on('execution:changed', () => {
            executionsTree.onExecutionChanged();
            runtimesTree.refreshDebounced();
        });

        client.on('prefs:changed', () => {
            environmentsTree.refresh();
        });

        client.on('disconnected', () => {
            log('Daemon disconnected — will auto-reconnect');
            statusBar.text = '$(circle-outline) mrmd: reconnecting…';
            statusBar.tooltip = 'mrmd: daemon disconnected, reconnecting…';
            activeExecutions.clear();
            cellStatuses.clear();
            inlayHintsProvider.refresh();
            refreshAllVisibleEditors();
            runtimesTree.clearClient();
            environmentsTree.clearClient();
            executionsTree.clearClient();
            langProviders.setClient(null);
        });

        client.on('reconnecting', () => {
            log('Reconnecting to daemon...');
            statusBar.text = '$(sync~spin) mrmd';
        });

        client.on('reconnected', async () => {
            log('Reconnected to daemon');
            statusBar.text = '$(circle-filled) mrmd';
            statusBar.tooltip = 'mrmd: connected';

            runtimesTree.setClient(client);
            environmentsTree.setClient(client);
            executionsTree.setClient(client);
            langProviders.setClient(client);

            if (manager) {
                try {
                    const failed = await manager.reconnect();
                    if (failed.length > 0) {
                        log(`Failed to re-open ${failed.length} document(s): ${failed.join(', ')}`);
                    } else {
                        log('All documents re-synced after reconnect');
                    }
                } catch (err: any) {
                    log(`Error during document reconnect: ${err.message}`);
                }
            }
        });

        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'markdown') {
                ensureDocumentOpen(doc);
            }
        }
    } catch (err: any) {
        log(`Failed to connect to daemon: ${err.message}`);
        statusBar.text = '$(error) mrmd';
        statusBar.tooltip = `mrmd: failed to connect — ${err.message}`;
    }
}

async function ensureDocumentOpen(doc: vscode.TextDocument): Promise<void> {
    if (!manager || manager.isTracked(doc.uri.fsPath)) return;
    try {
        log(`Opening document: ${doc.uri.fsPath}`);
        await manager.open(doc);
        log(`Document opened: ${doc.uri.fsPath}`);
    } catch (err: any) {
        log(`Failed to open document: ${doc.uri.fsPath} — ${err.message}`);
    }
}

// ── Run ───────────────────────────────────────────────────────

async function runAtCursor(advance = false): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') return;

    const block = blockAtCursor(editor.document, editor.selection.active);
    if (!block) {
        vscode.window.showInformationMessage('No code block at cursor');
        return;
    }

    await runBlock(editor, block, advance);
}

async function runBlock(editor: vscode.TextEditor, block: CodeBlock, advance = false): Promise<void> {
    if (!client || !manager) {
        vscode.window.showErrorMessage('mrmd daemon not connected');
        return;
    }

    const docPath = editor.document.uri.fsPath;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || require('path').dirname(docPath);

    await ensureDocumentOpen(editor.document);

    try {
        const { execId } = await client.run(docPath, block.code, block.language, { cwd });
        log(`Running ${block.language}: ${execId}`);

        activeExecutions.set(execId, {
            docPath,
            language: block.language,
            fenceStart: block.fenceStart,
        });

        const key = cellKey(docPath, block.fenceStart);
        cellStatuses.set(key, {
            fenceStart: block.fenceStart,
            language: block.language,
            status: 'running',
        });

        updateStatusBar();
        inlayHintsProvider.refresh();
        refreshAllVisibleEditors();
    } catch (err: any) {
        log(`Run failed: ${err.message}`);
        vscode.window.showErrorMessage(`${block.language}: ${err.message}`);
    }

    if (advance) {
        const next = nextBlock(editor.document, editor.selection.active);
        if (next) {
            const pos = new vscode.Position(next.fenceStart + 1, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos));
        }
    }
}

// ── Interrupt ─────────────────────────────────────────────────

async function stopLanguage(language: string): Promise<void> {
    if (!client) return;

    const toStop: Array<{ execId: string; docPath: string; fenceStart: number }> = [];
    for (const [execId, meta] of activeExecutions) {
        if (meta.language === language) {
            toStop.push({ execId, docPath: meta.docPath, fenceStart: meta.fenceStart });
        }
    }

    if (toStop.length === 0) return;
    log(`Stopping ${language}: ${toStop.map(c => c.execId).join(', ')}`);

    for (const { execId, docPath, fenceStart } of toStop) {
        activeExecutions.delete(execId);
        cellStatuses.delete(cellKey(docPath, fenceStart));
    }
    updateStatusBar();
    inlayHintsProvider.refresh();
    refreshAllVisibleEditors();

    for (const { execId, docPath } of toStop) {
        try {
            await client.stop(docPath, execId);
        } catch (err: any) {
            log(`Stop error: ${err.message}`);
        }
    }
}

async function stopAll(): Promise<void> {
    if (!client) return;
    const entries = [...activeExecutions.entries()];
    if (entries.length === 0) return;

    log(`Stopping all (${entries.length})`);

    for (const [, meta] of entries) {
        cellStatuses.delete(cellKey(meta.docPath, meta.fenceStart));
    }
    activeExecutions.clear();
    updateStatusBar();
    inlayHintsProvider.refresh();
    refreshAllVisibleEditors();

    for (const [execId, meta] of entries) {
        try {
            await client.stop(meta.docPath, execId);
        } catch (err: any) {
            log(`Stop error: ${err.message}`);
        }
    }
}

// ── Status bar ────────────────────────────────────────────────

function updateStatusBar(): void {
    const isExecuting = activeExecutions.size > 0;
    vscode.commands.executeCommand('setContext', 'mrmd.isExecuting', isExecuting);

    if (isExecuting) {
        const langs = [...new Set([...activeExecutions.values()].map(m => m.language))];
        statusBar.text = `$(sync~spin) mrmd: ${langs.join(', ')}`;
        statusBar.tooltip = `mrmd: ${activeExecutions.size} execution(s) running`;
    } else {
        statusBar.text = '$(circle-filled) mrmd';
        statusBar.tooltip = 'mrmd: connected';
    }
}

// ── Decorations ───────────────────────────────────────────────

let decorationTimer: ReturnType<typeof setTimeout> | null = null;

function refreshDecorations(editor: vscode.TextEditor): void {
    const docPath = editor.document.uri.fsPath;
    const cursorLine = editor.selection.active.line;

    const docStatuses = new Map<number, CellExecutionStatus>();
    for (const [key, status] of cellStatuses) {
        if (key.startsWith(docPath + ':')) {
            docStatuses.set(status.fenceStart, status);
        }
    }

    applyDecorations(editor, cursorLine, docStatuses);
}

function refreshDecorationsDebounced(editor: vscode.TextEditor): void {
    if (decorationTimer) clearTimeout(decorationTimer);
    decorationTimer = setTimeout(() => {
        decorationTimer = null;
        refreshDecorations(editor);
    }, 50);
}

function refreshAllVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.languageId === 'markdown') {
            refreshDecorations(editor);
        }
    }
}

// ── Inline Run Hints ──────────────────────────────────────────

function isLanguageExecuting(docPath: string, language: string): boolean {
    for (const meta of activeExecutions.values()) {
        if (meta.docPath === docPath && meta.language === language) {
            return true;
        }
    }
    return false;
}

const IS_MAC = process.platform === 'darwin';
const RUN_KEY = IS_MAC ? '⌘↵' : 'Ctrl+Enter';
const RUN_ADV_KEY = IS_MAC ? '⇧↵' : 'Shift+Enter';
const CLICK_MOD = IS_MAC ? '⌘' : 'Ctrl';

/**
 * Inlay hints provider — places a small clickable "run" badge
 * at the end of each opening fence line (```python  run).
 *
 * - Click runs the cell
 * - Hover tooltip shows keyboard shortcuts
 * - When executing: shows "stop" instead
 * - Configurable via `mrmd.runButton.enabled`
 */
class RunInlayHintsProvider implements vscode.InlayHintsProvider {
    private _onDidChangeInlayHints = new vscode.EventEmitter<void>();
    readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;

    refresh(): void {
        this._onDidChangeInlayHints.fire();
    }

    provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
    ): vscode.InlayHint[] {
        const enabled = vscode.workspace
            .getConfiguration('mrmd.runButton')
            .get<boolean>('enabled', true);
        if (!enabled) return [];

        const blocks = parseBlocks(document);
        const docPath = document.uri.fsPath;

        const hints: vscode.InlayHint[] = [];

        for (const block of blocks) {
            // Only process blocks whose fence line is in the requested range
            if (block.fenceStart < range.start.line || block.fenceStart > range.end.line) {
                continue;
            }

            const fenceLine = document.lineAt(block.fenceStart);
            const position = new vscode.Position(
                block.fenceStart,
                fenceLine.text.length,
            );

            const running = isLanguageExecuting(docPath, block.language);

            if (running) {
                const part = new vscode.InlayHintLabelPart('stop');
                part.tooltip = new vscode.MarkdownString(
                    `${CLICK_MOD}+click to stop\u2003\u2003**Escape** stop`,
                );
                part.command = {
                    title: 'Stop',
                    command: 'mrmd.interrupt',
                    arguments: [document.uri, block],
                };

                const hint = new vscode.InlayHint(position, [part]);
                hint.paddingLeft = true;
                hints.push(hint);
            } else {
                const part = new vscode.InlayHintLabelPart('run');
                part.tooltip = new vscode.MarkdownString(
                    `${CLICK_MOD}+click to run\u2003\u2003**${RUN_KEY}** run\u2003\u2003**${RUN_ADV_KEY}** run & advance`,
                );
                part.command = {
                    title: 'Run',
                    command: 'mrmd.run',
                    arguments: [document.uri, block],
                };

                const hint = new vscode.InlayHint(position, [part]);
                hint.paddingLeft = true;
                hints.push(hint);
            }
        }

        return hints;
    }
}
