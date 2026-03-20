/**
 * mrmd VS Code Extension
 *
 * Execute code blocks in markdown files.
 * Connects to the mrmd daemon (bundled, auto-started).
 * Speaks MRP to runtime servers.
 */

import * as vscode from 'vscode';
import { DaemonClient, RuntimeInfo } from './daemon-client';
import { blockAtCursor, nextBlock, parseBlocks, CodeBlock } from './blocks';
import { executeBlock } from './execute';

// ── State ─────────────────────────────────────────────────────

let daemon: DaemonClient;
let statusBar: vscode.StatusBarItem;
let abortController: AbortController | null = null;

/** language -> RuntimeInfo for current workspace */
const runtimes = new Map<string, RuntimeInfo>();

// ── Activation ────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    daemon = new DaemonClient();

    // Status bar
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.text = '$(circle-outline) mrmd';
    statusBar.tooltip = 'mrmd: not connected';
    statusBar.show();
    context.subscriptions.push(statusBar);

    // CodeLens
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'markdown' },
            new RunCodeLensProvider(),
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
        vscode.commands.registerCommand('mrmd.runAndAdvance', () => runAtCursor(true)),
        vscode.commands.registerCommand('mrmd.interrupt', () => interruptExecution()),
    );
}

export function deactivate(): void {
    daemon?.disconnect();
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
    // Ensure daemon connection
    try {
        statusBar.text = '$(sync~spin) mrmd';
        await daemon.connect();
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to connect to mrmd daemon: ${err.message}`);
        statusBar.text = '$(circle-outline) mrmd';
        return;
    }

    // Get or start runtime for this language
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || require('path').dirname(editor.document.uri.fsPath);

    let rt = runtimes.get(block.language);
    if (!rt || !rt.alive) {
        try {
            statusBar.text = `$(sync~spin) mrmd: starting ${block.language}...`;
            rt = await daemon.startRuntime(block.language, cwd);
            runtimes.set(block.language, rt);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to start ${block.language} runtime: ${err.message}`);
            statusBar.text = '$(circle-outline) mrmd';
            return;
        }
    }

    // Execute
    statusBar.text = `$(sync~spin) mrmd: running...`;
    vscode.commands.executeCommand('setContext', 'mrmd.isExecuting', true);

    abortController = new AbortController();

    try {
        await executeBlock(editor.document, block, rt.url, abortController.signal);
    } catch (err: any) {
        if (err.message !== 'Aborted') {
            vscode.window.showErrorMessage(`Execution error: ${err.message}`);
        }
    } finally {
        abortController = null;
        vscode.commands.executeCommand('setContext', 'mrmd.isExecuting', false);
        statusBar.text = '$(circle-filled) mrmd';
        statusBar.tooltip = `mrmd: connected (${runtimes.size} runtime${runtimes.size !== 1 ? 's' : ''})`;
    }

    // Advance cursor to next block
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

function interruptExecution(): void {
    abortController?.abort();
}

// ── CodeLens ──────────────────────────────────────────────────

class RunCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const blocks = parseBlocks(document);
        return blocks.map((block, index) => {
            const range = new vscode.Range(block.fenceStart, 0, block.fenceStart, 0);
            return new vscode.CodeLens(range, {
                title: `▶ Run ${block.language}`,
                command: 'mrmd.run',
                arguments: [document.uri, block],
            });
        });
    }
}
