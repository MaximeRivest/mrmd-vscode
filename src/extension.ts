/**
 * mrmd VS Code Extension
 *
 * Execute code blocks in markdown files using the mrmd-packages ecosystem.
 * Communicates with mrmd-python, mrmd-bash, mrmd-r, etc via MRP (MRMD Runtime Protocol).
 *
 */

import * as vscode from 'vscode';
import { MrpClient } from './mrp-client';
import { OrchestratorClient } from './orchestrator-client';
import { SetupManager } from './setup-manager';
import { MrmdCodeLensProvider, getCodeBlockAtPosition, getNextCodeBlock, getPreviousCodeBlock } from './codelens-provider';
import { OutputDecorationProvider, OutputFoldingProvider } from './decorations';
import { ExecutionManager } from './execution-manager';
import { VariablePanelProvider } from './panels/variable-panel';
import { VariableExplorerProvider } from './panels/variable-explorer';
import { OutputPanelProvider } from './panels/output-panel';
import { MrmdCompletionProvider } from './completion-provider';
import { MrmdHoverProvider } from './hover-provider';
import { YjsClient, VsCodeYjsBinding, createMonitorCoordination, MonitorCoordination } from './yjs';

// ============================================================================
// Extension State
// ============================================================================

let outputChannel: vscode.OutputChannel;
let setupManager: SetupManager;
let orchestratorClient: OrchestratorClient;
let mrpClient: MrpClient | null = null;
let codeLensProvider: MrmdCodeLensProvider;
let decorationProvider: OutputDecorationProvider;
let foldingProvider: OutputFoldingProvider;
let executionManager: ExecutionManager;
let variablePanelProvider: VariablePanelProvider;
let variableExplorerProvider: VariableExplorerProvider;
let outputPanelProvider: OutputPanelProvider;
let completionProvider: MrmdCompletionProvider;
let hoverProvider: MrmdHoverProvider;
let statusBarItem: vscode.StatusBarItem;

// Yjs/Monitor mode state
let yjsClient: YjsClient | null = null;
let yjsBinding: VsCodeYjsBinding | null = null;
let monitorCoordination: MonitorCoordination | null = null;
let boundDocument: vscode.TextDocument | null = null;

// Helper to get current MRP client
function getClient(): MrpClient | null {
    return mrpClient;
}

// ============================================================================
// Activation
// ============================================================================

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('mrmd extension activating...');

    // Create shared output channel
    outputChannel = vscode.window.createOutputChannel('mrmd');

    // Create setup manager
    setupManager = new SetupManager(outputChannel);

    // Create providers
    codeLensProvider = new MrmdCodeLensProvider();
    decorationProvider = new OutputDecorationProvider();
    foldingProvider = new OutputFoldingProvider();

    // Create orchestrator client
    orchestratorClient = new OrchestratorClient(outputChannel);

    // Create execution manager
    executionManager = new ExecutionManager(codeLensProvider, decorationProvider);

    // Create panel providers
    variablePanelProvider = new VariablePanelProvider(context.extensionUri, getClient);
    variableExplorerProvider = new VariableExplorerProvider(getClient);
    outputPanelProvider = new OutputPanelProvider(context.extensionUri);

    // Create completion and hover providers
    completionProvider = new MrmdCompletionProvider(getClient, codeLensProvider);
    hoverProvider = new MrmdHoverProvider(getClient, codeLensProvider);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(circle-outline) mrmd';
    statusBarItem.tooltip = 'mrmd: Click to start';
    statusBarItem.command = 'mrmd.showStatus';
    statusBarItem.show();

    // Register providers
    context.subscriptions.push(
        // Code lens
        vscode.languages.registerCodeLensProvider(
            { language: 'markdown' },
            codeLensProvider
        ),
        // Folding
        vscode.languages.registerFoldingRangeProvider(
            { language: 'markdown' },
            foldingProvider
        ),
        // Completions (trigger on .)
        vscode.languages.registerCompletionItemProvider(
            { language: 'markdown' },
            completionProvider,
            '.', '('
        ),
        // Hover
        vscode.languages.registerHoverProvider(
            { language: 'markdown' },
            hoverProvider
        ),
        // Variable panel (WebView)
        vscode.window.registerWebviewViewProvider(
            VariablePanelProvider.viewType,
            variablePanelProvider
        ),
        // Variable explorer (TreeView - fallback)
        vscode.window.registerTreeDataProvider(
            'mrmd.variableExplorer',
            variableExplorerProvider
        ),
        // Output panel
        vscode.window.registerWebviewViewProvider(
            OutputPanelProvider.viewType,
            outputPanelProvider
        ),
        // Disposables
        decorationProvider,
        foldingProvider,
        codeLensProvider,
        orchestratorClient,
        executionManager,
        setupManager,
        statusBarItem,
        outputChannel
    );

    // Register commands
    registerCommands(context);

    // Listen to configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('mrmd')) {
                codeLensProvider.refresh();
            }
        })
    );

    // Listen to document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'markdown') {
                decorationProvider.updateDecorations(vscode.window.activeTextEditor);
                codeLensProvider.refresh();
            }
        })
    );

    // Listen to active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            decorationProvider.updateDecorations(editor);

            // Handle document switching for monitor mode
            if (editor && editor.document.languageId === 'markdown') {
                if (boundDocument && editor.document !== boundDocument) {
                    // Document changed - need to rebind
                    await handleDocumentSwitch(editor.document);
                }
            }
        })
    );

    // Listen to orchestrator status changes
    orchestratorClient.onStatusChange(status => {
        updateStatusBar(status.running);
        if (status.running && status.urls.runtime) {
            mrpClient = new MrpClient(status.urls.runtime);
            executionManager.setClient(mrpClient);
        }
    });

    // Listen to execution events for output panel and variable refresh
    executionManager.onExecutionEnd(async ({ execution, result }) => {
        // Refresh variables after execution
        variablePanelProvider.refresh();
        variableExplorerProvider.refresh();

        // Add rich outputs to output panel
        if (result.result && result.result.data) {
            // Check if there's rich content (not just text/plain)
            const hasRichOutput = Object.keys(result.result.data).some(
                k => k !== 'text/plain'
            );
            if (hasRichOutput) {
                outputPanelProvider.addOutput(result.result);
            }
        }
    });

    // Auto-start if configured
    const config = vscode.workspace.getConfiguration('mrmd');
    if (config.get<boolean>('autoStart', true)) {
        const hasMarkdown = vscode.window.visibleTextEditors.some(
            e => e.document.languageId === 'markdown'
        );
        if (hasMarkdown) {
            startServices();
        }
    }

    // Initial decoration update
    decorationProvider.updateDecorations(vscode.window.activeTextEditor);

    console.log('mrmd extension activated');
}

export function deactivate(): void {
    console.log('mrmd extension deactivating...');
    cleanupMonitorMode();
    orchestratorClient?.stop();
}

/**
 * Handle switching to a different document.
 *
 * This disconnects from the old Yjs document and connects to the new one.
 */
async function handleDocumentSwitch(newDocument: vscode.TextDocument): Promise<void> {
    if (!orchestratorClient.syncUrl || !orchestratorClient.runtimeUrl) {
        return;
    }

    console.log(`[mrmd] Switching document binding to ${newDocument.uri.fsPath}`);

    // Clean up old binding
    cleanupMonitorMode();

    // Set up for new document
    await setupMonitorMode(orchestratorClient.syncUrl, orchestratorClient.runtimeUrl);
}

// ============================================================================
// Commands
// ============================================================================

function registerCommands(context: vscode.ExtensionContext): void {
    const commands: Array<[string, (...args: any[]) => any]> = [
        // Execution
        ['mrmd.runBlock', runBlock],
        ['mrmd.runBlockAdvance', runBlockAdvance],
        ['mrmd.runAllBlocks', runAllBlocks],
        ['mrmd.interrupt', interrupt],

        // Navigation
        ['mrmd.navigateUp', navigateUp],
        ['mrmd.navigateDown', navigateDown],

        // Output management
        ['mrmd.deleteOutput', deleteOutput],
        ['mrmd.deleteAllOutputs', deleteAllOutputs],
        ['mrmd.toggleCollapseOutput', toggleCollapseOutput],
        ['mrmd.collapseAllOutputs', collapseAllOutputs],
        ['mrmd.expandAllOutputs', expandAllOutputs],

        // Server management
        ['mrmd.startServer', startServices],
        ['mrmd.stopServer', stopServices],
        ['mrmd.restartRuntime', restartRuntime],
        ['mrmd.showStatus', showStatus],

        // Variables
        ['mrmd.refreshVariables', refreshVariables],
        ['mrmd.clearVariables', clearVariables],
        ['mrmd.copyVariable', copyVariable],

        // Output panel
        ['mrmd.clearOutputs', clearOutputs],

        // Setup
        ['mrmd.checkSetup', checkSetup],
    ];

    for (const [command, handler] of commands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(command, handler)
        );
    }
}

// ============================================================================
// Command Handlers
// ============================================================================

async function runBlock(
    uri?: vscode.Uri,
    blockIndex?: number,
    block?: any
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        return;
    }

    if (!mrpClient) {
        await startServices();
        if (!mrpClient) {
            vscode.window.showErrorMessage('Failed to start mrmd services');
            return;
        }
    }

    let targetBlock = block;
    let targetIndex = blockIndex ?? 0;

    if (!targetBlock) {
        targetBlock = getCodeBlockAtPosition(
            editor.document,
            editor.selection.active,
            codeLensProvider
        );
        if (!targetBlock) {
            vscode.window.showInformationMessage('No code block at cursor');
            return;
        }
        targetIndex = codeLensProvider.getExecutableBlocks(editor.document)
            .findIndex(b => b.fenceStart === targetBlock.fenceStart);
    }

    await executionManager.queueExecution(editor.document, targetBlock, targetIndex);
}

async function runBlockAdvance(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    await runBlock();

    const nextBlock = getNextCodeBlock(editor.document, editor.selection.active, codeLensProvider);
    if (nextBlock) {
        const position = new vscode.Position(nextBlock.startLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
    }
}

async function runAllBlocks(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        return;
    }

    if (!mrpClient) {
        await startServices();
        if (!mrpClient) {
            vscode.window.showErrorMessage('Failed to start mrmd services');
            return;
        }
    }

    await executionManager.queueAllBlocks(editor.document);
}

async function interrupt(): Promise<void> {
    await executionManager.interrupt();
    vscode.window.showInformationMessage('Execution interrupted');
}

function navigateUp(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const block = getPreviousCodeBlock(editor.document, editor.selection.active, codeLensProvider);
    if (block) {
        const position = new vscode.Position(block.startLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
    }
}

function navigateDown(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const block = getNextCodeBlock(editor.document, editor.selection.active, codeLensProvider);
    if (block) {
        const position = new vscode.Position(block.startLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
    }
}

async function deleteOutput(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const block = getCodeBlockAtPosition(
        editor.document,
        editor.selection.active,
        codeLensProvider
    );

    if (!block) return;

    const output = codeLensProvider.findOutputBlock(editor.document, block.fenceEnd);
    if (output) {
        const edit = new vscode.WorkspaceEdit();
        const startLine = output.start > 0 &&
            editor.document.lineAt(output.start - 1).text.trim() === ''
            ? output.start - 1
            : output.start;
        const range = new vscode.Range(startLine, 0, output.end + 1, 0);
        edit.delete(editor.document.uri, range);
        await vscode.workspace.applyEdit(edit);
    }
}

async function deleteAllOutputs(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const text = editor.document.getText();
    const newText = text.replace(/\n*```(output|result)[\s\S]*?```\n?/g, '\n');

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, editor.document.lineCount, 0);
    edit.replace(editor.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
}

function toggleCollapseOutput(): void {
    vscode.commands.executeCommand('editor.toggleFold');
}

function collapseAllOutputs(): void {
    vscode.commands.executeCommand('editor.foldAllBlockComments');
}

function expandAllOutputs(): void {
    vscode.commands.executeCommand('editor.unfoldAll');
}

async function startServices(): Promise<void> {
    try {
        // Ensure mrmd-python is installed
        updateStatusBar(false, 'Checking setup...');
        const ready = await setupManager.ensureSetup();
        if (!ready) {
            updateStatusBar(false);
            return;
        }

        updateStatusBar(false, 'Starting...');
        const urls = await orchestratorClient.start({
            workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        });

        // Set up MRP client for direct mode fallback
        mrpClient = new MrpClient(urls.runtime);
        executionManager.setClient(mrpClient);

        // Set up monitor mode if sync URL is available
        if (urls.sync) {
            await setupMonitorMode(urls.sync, urls.runtime);
        }

        updateStatusBar(true);
        vscode.window.showInformationMessage('mrmd services started');
    } catch (err) {
        updateStatusBar(false, 'Error');
        outputChannel.appendLine(`[startup] Failed to start mrmd: ${err}`);
        outputChannel.show();
        vscode.window.showErrorMessage(`Failed to start mrmd: ${err}`);
    }
}

/**
 * Set up monitor mode with Yjs connection.
 *
 * This connects to mrmd-sync, binds the active document to Y.Text,
 * and enables monitor mode in ExecutionManager.
 */
async function setupMonitorMode(syncUrl: string, runtimeUrl: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        console.log('[mrmd] No active markdown editor, skipping monitor mode setup');
        return;
    }

    const document = editor.document;

    // Generate document name for Yjs (use relative path from workspace)
    const docName = getDocumentName(document);

    console.log(`[mrmd] Setting up monitor mode for ${docName}`);

    try {
        // 1. Create and connect Yjs client
        yjsClient = new YjsClient();
        await yjsClient.connect({ syncUrl, docName });
        console.log('[mrmd] Connected to mrmd-sync');

        // 2. Create document binding
        yjsBinding = new VsCodeYjsBinding({
            yText: yjsClient.yText,
            document,
        });
        await yjsBinding.initialize();
        boundDocument = document;
        console.log('[mrmd] Document binding established');

        // 3. Create monitor coordination
        monitorCoordination = createMonitorCoordination(yjsClient.ydoc);

        // 4. Set awareness state (identify as VS Code)
        yjsClient.setAwarenessState({
            name: 'VS Code',
            color: '#007ACC',
        });

        // 5. Create session with orchestrator (ensures monitor is watching)
        try {
            await orchestratorClient.createSession(docName);
            console.log('[mrmd] Session created with orchestrator');
        } catch (err) {
            console.warn('[mrmd] Failed to create session (monitor may not be watching):', err);
        }

        // 6. Enable monitor mode in execution manager
        executionManager.enableMonitorMode({
            coordination: monitorCoordination,
            yText: yjsClient.yText,
            runtimeUrl,
        });

        console.log('[mrmd] Monitor mode enabled');
    } catch (err) {
        console.error('[mrmd] Failed to set up monitor mode:', err);
        // Fall back to direct mode (already set up above)
        cleanupMonitorMode();
    }
}

/**
 * Clean up monitor mode resources.
 */
function cleanupMonitorMode(): void {
    if (monitorCoordination) {
        monitorCoordination.destroy();
        monitorCoordination = null;
    }
    if (yjsBinding) {
        yjsBinding.dispose();
        yjsBinding = null;
    }
    if (yjsClient) {
        yjsClient.dispose();
        yjsClient = null;
    }
    boundDocument = null;
    executionManager.disableMonitorMode();
}

/**
 * Get document name for Yjs (relative path from workspace).
 */
function getDocumentName(document: vscode.TextDocument): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        const relativePath = vscode.workspace.asRelativePath(document.uri, false);
        return relativePath;
    }
    // Fallback: use full path with slashes replaced
    return document.uri.fsPath.replace(/\//g, '__').replace(/\\/g, '__');
}

async function stopServices(): Promise<void> {
    cleanupMonitorMode();
    await orchestratorClient.stop();
    mrpClient = null;
    updateStatusBar(false);
    vscode.window.showInformationMessage('mrmd services stopped');
}

async function restartRuntime(): Promise<void> {
    try {
        if (!mrpClient) {
            vscode.window.showWarningMessage('mrmd not running');
            return;
        }
        await orchestratorClient.restartRuntime();
        variablePanelProvider.refresh();
        variableExplorerProvider.refresh();
        vscode.window.showInformationMessage('Python runtime restarted');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to restart: ${err}`);
    }
}

async function showStatus(): Promise<void> {
    const status = await orchestratorClient.getStatus();

    if (!status.running) {
        const action = await vscode.window.showInformationMessage(
            'mrmd services are not running',
            'Start'
        );
        if (action === 'Start') {
            await startServices();
        }
        return;
    }

    const urls = orchestratorClient.urls;
    const items = [
        `Runtime: ${urls?.runtime || 'unknown'}`,
        `Sessions: ${status.sessions.join(', ') || 'none'}`,
    ];

    if (urls?.sync) {
        items.push(`Sync: ${urls.sync}`);
    }
    if (urls?.ai) {
        items.push(`AI: ${urls.ai}`);
    }

    const action = await vscode.window.showInformationMessage(
        items.join(' | '),
        'Restart Runtime',
        'Stop'
    );

    if (action === 'Restart Runtime') {
        await restartRuntime();
    } else if (action === 'Stop') {
        await stopServices();
    }
}

async function refreshVariables(): Promise<void> {
    if (!mrpClient) {
        vscode.window.showWarningMessage('mrmd not running');
        return;
    }

    variablePanelProvider.refresh();
    variableExplorerProvider.refresh();
}

async function clearVariables(): Promise<void> {
    if (!mrpClient) {
        vscode.window.showWarningMessage('mrmd not running');
        return;
    }

    try {
        await mrpClient.execute({ code: '%reset -f' });
        variablePanelProvider.refresh();
        variableExplorerProvider.refresh();
        vscode.window.showInformationMessage('Variables cleared');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to clear variables: ${err}`);
    }
}

async function copyVariable(path: string): Promise<void> {
    await vscode.env.clipboard.writeText(path);
    vscode.window.showInformationMessage(`Copied: ${path}`);
}

function clearOutputs(): void {
    outputPanelProvider.clear();
}

async function checkSetup(): Promise<void> {
    const status = await setupManager.checkStatus();

    const items = [
        `uv: ${status.uvAvailable ? '✓' : '✗'}`,
        `pip: ${status.pipAvailable ? '✓' : '✗'}`,
        `Python: ${status.pythonPath || '✗'}`,
        `mrmd-python: ${status.mrmdPythonInstalled ? status.mrmdPythonVersion || '✓' : '✗'}`,
    ];

    if (!status.mrmdPythonInstalled) {
        const action = await vscode.window.showWarningMessage(
            items.join(' | '),
            'Install mrmd-python'
        );
        if (action) {
            await setupManager.ensureSetup();
        }
    } else {
        vscode.window.showInformationMessage(items.join(' | '));
    }
}

// ============================================================================
// UI Helpers
// ============================================================================

function updateStatusBar(running: boolean, text?: string): void {
    if (text) {
        statusBarItem.text = `$(sync~spin) mrmd: ${text}`;
        return;
    }

    if (running) {
        statusBarItem.text = '$(circle-filled) mrmd';
        statusBarItem.tooltip = 'mrmd: Running (click for status)';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(circle-outline) mrmd';
        statusBarItem.tooltip = 'mrmd: Stopped (click to start)';
        statusBarItem.backgroundColor = undefined;
    }
}
