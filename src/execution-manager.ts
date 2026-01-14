/**
 * Execution Manager
 *
 * Manages code execution queue, output injection into markdown,
 * and cell state tracking.
 *
 * Supports two modes:
 * - Direct mode: Call MrpClient directly (legacy, for standalone use)
 * - Monitor mode: Request via Y.Map, output via Yjs sync (collaborative)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { MrpClient, MrpStreamCallbacks, MrpExecutionResult } from './mrp-client';
import { CodeBlock, MrmdCodeLensProvider, calculateFenceLength } from './codelens-provider';
import { OutputDecorationProvider } from './decorations';
import { MonitorCoordination, EXECUTION_STATUS, ExecutionStatus } from './yjs/monitor-coordination';
import * as Y from 'yjs';

// ============================================================================
// Types
// ============================================================================

interface QueuedExecution {
    id: string;
    document: vscode.TextDocument;
    block: CodeBlock;
    blockIndex: number;
    hash: string;
}

interface ExecutionState {
    isExecuting: boolean;
    currentExecution: QueuedExecution | null;
    abortController: AbortController | null;
}

// ============================================================================
// Execution Manager
// ============================================================================

export class ExecutionManager {
    private mrpClient: MrpClient | null = null;
    private queue: QueuedExecution[] = [];
    private state: ExecutionState = {
        isExecuting: false,
        currentExecution: null,
        abortController: null,
    };
    private _onExecutionStart = new vscode.EventEmitter<QueuedExecution>();
    private _onExecutionEnd = new vscode.EventEmitter<{ execution: QueuedExecution; result: MrpExecutionResult }>();
    private _onQueueChange = new vscode.EventEmitter<QueuedExecution[]>();

    readonly onExecutionStart = this._onExecutionStart.event;
    readonly onExecutionEnd = this._onExecutionEnd.event;
    readonly onQueueChange = this._onQueueChange.event;

    // Monitor mode fields
    private _monitorMode = false;
    private _coordination: MonitorCoordination | null = null;
    private _yText: Y.Text | null = null;
    private _runtimeUrl: string | null = null;
    private _session = 'default';

    constructor(
        private codeLensProvider: MrmdCodeLensProvider,
        private decorationProvider: OutputDecorationProvider
    ) {}

    /**
     * Set the MRP client to use for execution (direct mode).
     */
    setClient(client: MrpClient): void {
        this.mrpClient = client;
    }

    /**
     * Enable monitor mode for execution.
     *
     * In monitor mode, executions are routed through mrmd-monitor via Y.Map.
     * Output is written by the monitor to Y.Text, which syncs to the document.
     */
    enableMonitorMode(options: {
        coordination: MonitorCoordination;
        yText: Y.Text;
        runtimeUrl: string;
        session?: string;
    }): void {
        this._monitorMode = true;
        this._coordination = options.coordination;
        this._yText = options.yText;
        this._runtimeUrl = options.runtimeUrl;
        this._session = options.session || 'default';
    }

    /**
     * Disable monitor mode (use direct execution).
     */
    disableMonitorMode(): void {
        this._monitorMode = false;
        this._coordination = null;
        this._yText = null;
        this._runtimeUrl = null;
    }

    /**
     * Check if monitor mode is enabled and available.
     */
    get isMonitorMode(): boolean {
        return this._monitorMode && this._coordination !== null;
    }

    /**
     * Check if currently executing.
     */
    get isExecuting(): boolean {
        return this.state.isExecuting;
    }

    /**
     * Get the current queue.
     */
    get currentQueue(): QueuedExecution[] {
        return [...this.queue];
    }

    /**
     * Queue a code block for execution.
     */
    async queueExecution(
        document: vscode.TextDocument,
        block: CodeBlock,
        blockIndex: number
    ): Promise<void> {
        const hash = this.hashCode(block.code);
        const id = `exec-${Date.now()}-${hash.slice(0, 8)}`;

        const execution: QueuedExecution = {
            id,
            document,
            block,
            blockIndex,
            hash,
        };

        this.queue.push(execution);
        this.decorationProvider.setQueued(block.fenceStart);
        this._onQueueChange.fire(this.currentQueue);

        // Update decorations
        this.updateDecorations();

        // Start processing if not already
        if (!this.state.isExecuting) {
            await this.processQueue();
        }
    }

    /**
     * Queue all executable blocks in a document.
     */
    async queueAllBlocks(document: vscode.TextDocument): Promise<void> {
        const blocks = this.codeLensProvider.getExecutableBlocks(document);

        for (let i = 0; i < blocks.length; i++) {
            await this.queueExecution(document, blocks[i], i);
        }
    }

    /**
     * Interrupt the current execution.
     */
    async interrupt(): Promise<void> {
        if (this.state.abortController) {
            this.state.abortController.abort();
        }

        if (this.mrpClient) {
            try {
                await this.mrpClient.interrupt();
            } catch {
                // Ignore errors
            }
        }

        // Clear queue
        this.queue = [];
        this.decorationProvider.clearAllStatus();
        this._onQueueChange.fire([]);
        this.updateDecorations();
    }

    /**
     * Clear the execution queue.
     */
    clearQueue(): void {
        this.queue = [];
        this.decorationProvider.clearAllStatus();
        this._onQueueChange.fire([]);
        this.updateDecorations();
    }

    /**
     * Process the execution queue.
     */
    private async processQueue(): Promise<void> {
        if (this.state.isExecuting || this.queue.length === 0) {
            return;
        }

        this.state.isExecuting = true;

        while (this.queue.length > 0) {
            const execution = this.queue.shift()!;
            this.state.currentExecution = execution;
            this.state.abortController = new AbortController();

            // Update decorations
            this.decorationProvider.clearStatus(execution.block.fenceStart);
            this.decorationProvider.setRunning(execution.block.fenceStart);
            this.updateDecorations();

            // Set context for keybindings
            vscode.commands.executeCommand('setContext', 'mrmd.isExecuting', true);

            this._onExecutionStart.fire(execution);

            try {
                const result = await this.executeBlock(execution);
                this._onExecutionEnd.fire({ execution, result });
            } catch (err) {
                console.error('Execution error:', err);
                this._onExecutionEnd.fire({
                    execution,
                    result: {
                        status: 'error',
                        error: {
                            ename: 'ExecutionError',
                            evalue: String(err),
                            traceback: [],
                        },
                    },
                });
            } finally {
                this.decorationProvider.clearStatus(execution.block.fenceStart);
            }
        }

        this.state.isExecuting = false;
        this.state.currentExecution = null;
        this.state.abortController = null;
        vscode.commands.executeCommand('setContext', 'mrmd.isExecuting', false);
        this.updateDecorations();
    }

    /**
     * Execute a single block.
     */
    private async executeBlock(execution: QueuedExecution): Promise<MrpExecutionResult> {
        // Use monitor mode if enabled
        if (this.isMonitorMode) {
            return this.executeBlockViaMonitor(execution);
        }

        // Direct mode - call MrpClient directly
        return this.executeBlockDirect(execution);
    }

    /**
     * Execute block via monitor (Y.Map coordination).
     *
     * In this mode:
     * - We create an output block placeholder in Y.Text
     * - Request execution via Y.Map('executions')
     * - Monitor picks it up, executes, streams output to Y.Text
     * - Output appears in VS Code via VsCodeYjsBinding
     */
    private async executeBlockViaMonitor(execution: QueuedExecution): Promise<MrpExecutionResult> {
        if (!this._coordination || !this._yText || !this._runtimeUrl) {
            throw new Error('Monitor mode not properly configured');
        }

        const { document, block } = execution;
        const code = this.wrapCodeIfNeeded(block);

        // Generate execution ID
        const execId = MonitorCoordination.generateExecId();

        // Create output block in Y.Text (monitor will write output here)
        // The output block needs to be tagged with execId so monitor can find it
        const outputBlockText = `\n\n\`\`\`output:${execId}\n\`\`\``;

        // Find position after code block in Y.Text
        // We need to find where this code block ends in the Yjs document
        const yContent = this._yText.toString();
        const codeBlockEnd = this.findCodeBlockEndInYjs(yContent, block);

        if (codeBlockEnd >= 0) {
            // Insert output block placeholder
            this._yText.insert(codeBlockEnd, outputBlockText);
        }

        // Create RelativePosition for output start (survives concurrent edits)
        const outputPosition = codeBlockEnd >= 0
            ? Y.createRelativePositionFromTypeIndex(this._yText, codeBlockEnd + outputBlockText.indexOf('\n```output'), -1)
            : null;

        // Request execution via monitor
        this._coordination.executions.set(execId, {
            id: execId,
            code,
            language: block.language,
            runtimeUrl: this._runtimeUrl,
            session: this._session,
            status: EXECUTION_STATUS.REQUESTED,
            requestedBy: this._coordination.clientId,
            requestedAt: Date.now(),
            claimedBy: null,
            claimedAt: null,
            outputBlockReady: true,
            outputPosition: outputPosition ? Y.encodeRelativePosition(outputPosition) : null,
            startedAt: null,
            completedAt: null,
            stdinRequest: null,
            stdinResponse: null,
            result: null,
            error: null,
            displayData: [],
        });

        // Wait for completion
        try {
            const result = await this._coordination.waitForStatus(
                execId,
                [EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.ERROR, EXECUTION_STATUS.CANCELLED],
                300000 // 5 minute timeout
            );

            if (result.status === EXECUTION_STATUS.ERROR) {
                return {
                    status: 'error',
                    error: {
                        ename: 'ExecutionError',
                        evalue: result.error || 'Unknown error',
                        traceback: [],
                    },
                };
            }

            return {
                status: result.status === EXECUTION_STATUS.COMPLETED ? 'ok' : 'error',
                result: result.result,
            };
        } catch (err) {
            // Timeout or other error
            this._coordination.cancelExecution(execId);
            throw err;
        }
    }

    /**
     * Find where a code block ends in the Yjs document content.
     */
    private findCodeBlockEndInYjs(yContent: string, block: CodeBlock): number {
        // Simple heuristic: find the code in yContent
        // This works because the code should be unique enough
        const codeStart = yContent.indexOf(block.code);
        if (codeStart < 0) return -1;

        // Find the closing fence after the code
        const afterCode = yContent.indexOf('```', codeStart + block.code.length);
        if (afterCode < 0) return -1;

        // Return position after the closing fence line
        const lineEnd = yContent.indexOf('\n', afterCode);
        return lineEnd >= 0 ? lineEnd : afterCode + 3;
    }

    /**
     * Execute block directly via MrpClient (legacy mode).
     */
    private async executeBlockDirect(execution: QueuedExecution): Promise<MrpExecutionResult> {
        if (!this.mrpClient) {
            throw new Error('MRP client not configured');
        }

        const { document, block } = execution;

        // Prepare output block
        const outputInfo = await this.prepareOutputBlock(document, block);

        // Accumulated output
        let stdout = '';
        let stderr = '';

        const callbacks: MrpStreamCallbacks = {
            onStdout: (content, accumulated) => {
                stdout = accumulated;
                this.updateOutputBlock(document, outputInfo, stdout + stderr);
            },
            onStderr: (content, accumulated) => {
                stderr = accumulated;
                this.updateOutputBlock(document, outputInfo, stdout + stderr);
            },
            onDisplay: (data) => {
                // Handle rich output (images, HTML, etc.)
                // For now, try to get text representation
                const text = data.data['text/plain'] || data.data['text/html'] || '';
                if (text) {
                    stdout += '\n' + text;
                    this.updateOutputBlock(document, outputInfo, stdout + stderr);
                }
            },
            onResult: (data) => {
                const text = data.data['text/plain'] || '';
                if (text && text !== 'None') {
                    stdout += (stdout ? '\n' : '') + text;
                    this.updateOutputBlock(document, outputInfo, stdout + stderr);
                }
            },
            onError: (ename, evalue, traceback) => {
                const errorText = traceback.length > 0
                    ? traceback.join('\n')
                    : `${ename}: ${evalue}`;
                stderr += (stderr ? '\n' : '') + errorText;
                this.updateOutputBlock(document, outputInfo, stdout + stderr);
            },
        };

        // Execute with streaming
        const code = this.wrapCodeIfNeeded(block);
        return this.mrpClient.executeStream(
            { code, storeHistory: true },
            callbacks,
            this.state.abortController?.signal
        );
    }

    /**
     * Wrap code with magic if needed (e.g., %%bash for shell blocks).
     */
    private wrapCodeIfNeeded(block: CodeBlock): string {
        const lang = block.language.toLowerCase();

        // Map languages to IPython magics
        const magicMap: Record<string, string> = {
            bash: '%%bash',
            sh: '%%bash',
            zsh: '%%bash',
            r: '%%R',
            julia: '%%julia',
            ruby: '%%ruby',
            perl: '%%perl',
            javascript: '%%javascript',
            js: '%%javascript',
            html: '%%html',
            latex: '%%latex',
            svg: '%%svg',
            sql: '%%sql',
        };

        const magic = magicMap[lang];
        if (magic && !block.code.trim().startsWith('%%')) {
            return `${magic}\n${block.code}`;
        }

        return block.code;
    }

    /**
     * Prepare or create output block after a code block.
     */
    private async prepareOutputBlock(
        document: vscode.TextDocument,
        block: CodeBlock
    ): Promise<{ start: number; end: number; fenceLength: number; fenceChar: string }> {
        // Check if output block already exists
        const existingOutput = this.codeLensProvider.findOutputBlock(document, block.fenceEnd);

        if (existingOutput) {
            // Clear existing content
            const edit = new vscode.WorkspaceEdit();
            const clearRange = new vscode.Range(
                existingOutput.start + 1, 0,
                existingOutput.end, 0
            );
            edit.replace(document.uri, clearRange, '');
            await vscode.workspace.applyEdit(edit);

            return {
                start: existingOutput.start,
                end: existingOutput.start + 1, // Will grow
                fenceLength: existingOutput.fenceLength,
                fenceChar: existingOutput.fenceChar,
            };
        }

        // Create new output block
        const fenceLength = Math.max(block.fenceLength, 3);
        const fenceChar = block.fenceChar;
        const fence = fenceChar.repeat(fenceLength);
        const outputBlock = `\n${fence}output\n${fence}\n`;

        const edit = new vscode.WorkspaceEdit();
        const insertPosition = new vscode.Position(block.fenceEnd + 1, 0);
        edit.insert(document.uri, insertPosition, outputBlock);
        await vscode.workspace.applyEdit(edit);

        return {
            start: block.fenceEnd + 1,
            end: block.fenceEnd + 3,
            fenceLength,
            fenceChar,
        };
    }

    /**
     * Update output block content.
     */
    private async updateOutputBlock(
        document: vscode.TextDocument,
        outputInfo: { start: number; end: number; fenceLength: number; fenceChar: string },
        content: string
    ): Promise<void> {
        // Calculate fence length needed for content
        const neededFenceLength = calculateFenceLength(content, outputInfo.fenceLength);
        const fence = outputInfo.fenceChar.repeat(neededFenceLength);

        // Build new output block
        const newBlock = `${fence}output\n${content}\n${fence}`;

        // Find current output block boundaries
        const text = document.getText();
        const lines = text.split('\n');

        // Find the output block starting at outputInfo.start
        let blockEnd = outputInfo.start;
        const startLine = lines[outputInfo.start];
        if (startLine?.match(/^(`{3,}|~{3,})output/)) {
            // Find closing fence
            const char = startLine[0];
            const len = startLine.match(/^(`+|~+)/)?.[0].length || 3;
            for (let i = outputInfo.start + 1; i < lines.length; i++) {
                if (new RegExp(`^${char}{${len},}$`).test(lines[i])) {
                    blockEnd = i;
                    break;
                }
            }
        }

        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(outputInfo.start, 0, blockEnd, lines[blockEnd]?.length || 0);
        edit.replace(document.uri, range, newBlock);
        await vscode.workspace.applyEdit(edit);
    }

    /**
     * Update decorations in all visible editors.
     */
    private updateDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId === 'markdown') {
                this.decorationProvider.updateDecorations(editor);
            }
        }
    }

    /**
     * Hash code content for tracking.
     */
    private hashCode(code: string): string {
        return crypto.createHash('sha256').update(code).digest('hex');
    }

    dispose(): void {
        this.clearQueue();
        this._onExecutionStart.dispose();
        this._onExecutionEnd.dispose();
        this._onQueueChange.dispose();
    }
}
