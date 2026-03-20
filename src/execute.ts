/**
 * Execution
 *
 * Sends code to an MRP runtime via HTTP, streams output,
 * and writes the result into the markdown document as an output block.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import { CodeBlock, findOutputBlock } from './blocks';

/**
 * Execute a code block and write output to the document.
 */
export async function executeBlock(
    document: vscode.TextDocument,
    block: CodeBlock,
    mrpUrl: string,
    signal?: AbortSignal,
): Promise<void> {
    const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
    if (!editor) return;

    // Prepare or reuse output block
    const outputRange = await ensureOutputBlock(editor, block);

    // Stream execution
    let stdout = '';
    let stderr = '';
    let lastUpdate = 0;

    const updateOutput = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastUpdate < 50) return; // throttle
        lastUpdate = now;

        const content = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
        await writeOutputContent(editor, block, content);
    };

    try {
        await streamExecute(mrpUrl, block.code, {
            onStdout(chunk, accumulated) {
                stdout = accumulated;
                updateOutput();
            },
            onStderr(chunk, accumulated) {
                stderr = accumulated;
                updateOutput();
            },
            onError(type, message, traceback) {
                const errorText = traceback.length > 0
                    ? traceback.join('\n')
                    : `${type}: ${message}`;
                stderr = stderr ? stderr + '\n' + errorText : errorText;
                updateOutput();
            },
        }, signal);
    } catch (err: any) {
        if (err.message !== 'Aborted') {
            stderr = stderr ? stderr + '\n' + err.message : err.message;
        }
    }

    // Final update
    await updateOutput(true);
}

/**
 * Ensure an output block exists after the code block.
 * Creates one if missing, clears content if existing.
 */
async function ensureOutputBlock(
    editor: vscode.TextEditor,
    block: CodeBlock,
): Promise<void> {
    const existing = findOutputBlock(editor.document, block.fenceEnd);

    if (existing) {
        // Clear existing content
        if (existing.end > existing.start + 1) {
            await editor.edit(edit => {
                const range = new vscode.Range(existing.start + 1, 0, existing.end, 0);
                edit.replace(range, '');
            });
        }
        return;
    }

    // Create new output block
    const fence = block.fenceChar.repeat(block.fenceLength);
    const text = `\n${fence}output\n${fence}\n`;

    await editor.edit(edit => {
        edit.insert(new vscode.Position(block.fenceEnd + 1, 0), text);
    });
}

/**
 * Write content into the output block.
 */
async function writeOutputContent(
    editor: vscode.TextEditor,
    block: CodeBlock,
    content: string,
): Promise<void> {
    const output = findOutputBlock(editor.document, block.fenceEnd);
    if (!output) return;

    const fence = output.fenceChar.repeat(output.fenceLength);
    const newBlock = `${fence}output\n${content}\n${fence}`;

    await editor.edit(edit => {
        const range = new vscode.Range(
            output.start, 0,
            output.end, editor.document.lineAt(output.end).text.length,
        );
        edit.replace(range, newBlock);
    }, { undoStopBefore: false, undoStopAfter: false });
}

// ── MRP HTTP/SSE streaming ────────────────────────────────────

interface StreamCallbacks {
    onStdout?: (chunk: string, accumulated: string) => void;
    onStderr?: (chunk: string, accumulated: string) => void;
    onError?: (type: string, message: string, traceback: string[]) => void;
}

function streamExecute(
    mrpUrl: string,
    code: string,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
): Promise<void> {
    const url = new URL(`${mrpUrl}/execute/stream`);
    const body = JSON.stringify({ code, storeHistory: true });

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`MRP returned ${res.statusCode}`));
                    return;
                }

                let buffer = '';
                let currentEvent: string | null = null;

                res.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            currentEvent = line.slice(7).trim();
                        } else if (line.startsWith('data: ') && currentEvent) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                switch (currentEvent) {
                                    case 'stdout':
                                        callbacks.onStdout?.(data.content, data.accumulated);
                                        break;
                                    case 'stderr':
                                        callbacks.onStderr?.(data.content, data.accumulated);
                                        break;
                                    case 'error':
                                        callbacks.onError?.(
                                            data.type || 'Error',
                                            data.message || '',
                                            data.traceback || [],
                                        );
                                        break;
                                }
                            } catch {}
                            currentEvent = null;
                        }
                    }
                });

                res.on('end', () => resolve());
                res.on('error', reject);
            },
        );

        req.on('error', reject);

        if (signal) {
            signal.addEventListener('abort', () => {
                req.destroy();
                reject(new Error('Aborted'));
            });
        }

        req.write(body);
        req.end();
    });
}
