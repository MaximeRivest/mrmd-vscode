/**
 * Editor Decorations for Notebook-Style Code Cells
 *
 * Zen/minimal aesthetic:
 * - Subtle background shading on code blocks
 * - Active cell highlight (cell at cursor)
 * - Fence lines: smaller font, dimmed
 * - Output blocks: smaller font, dimmed, indented
 * - Execution status indicators
 *
 * Theme robustness:
 * - Background colors use ThemeColor with dark/light/highContrast defaults
 * - Text opacity uses ThemeColor-aware foreground where possible
 * - Font-size changes use CSS via textDecoration (works across themes)
 */

import * as vscode from 'vscode';
import { parseBlocks, CodeBlock } from './blocks';

// ── Types ─────────────────────────────────────────────────────

interface OutputRange {
    start: number;
    end: number;
}

export interface CellExecutionStatus {
    fenceStart: number;
    language: string;
    status: 'running' | 'success' | 'error' | 'idle';
}

// ── Decoration Types ──────────────────────────────────────────

let codeBlockBg: vscode.TextEditorDecorationType;
let activeCellBg: vscode.TextEditorDecorationType;
let codeFenceLine: vscode.TextEditorDecorationType;
let activeFenceLineDeco: vscode.TextEditorDecorationType;
let outputFenceLine: vscode.TextEditorDecorationType;
let outputBodyText: vscode.TextEditorDecorationType;
let statusRunning: vscode.TextEditorDecorationType;
let statusSuccess: vscode.TextEditorDecorationType;
let statusError: vscode.TextEditorDecorationType;

const allTypes: vscode.TextEditorDecorationType[] = [];

function createType(opts: vscode.DecorationRenderOptions): vscode.TextEditorDecorationType {
    const type = vscode.window.createTextEditorDecorationType(opts);
    allTypes.push(type);
    return type;
}

/**
 * Initialize all decoration types. Call once during activation.
 */
export function initDecorations(): void {
    // Code block body — visible background box (like markdown preview)
    codeBlockBg = createType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('mrmd.codeBlockBackground'),
    });

    // Active cell body — slightly stronger
    activeCellBg = createType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('mrmd.activeCellBackground'),
    });

    // Fence lines on non-active code cells — small, dimmed text,
    // same background as body so the block reads as one continuous box
    codeFenceLine = createType({
        isWholeLine: true,
        opacity: '0.35',
        backgroundColor: new vscode.ThemeColor('mrmd.codeBlockBackground'),
        textDecoration: 'none; font-size: 0.8em; line-height: 1.2',
    });

    // Fence lines on the ACTIVE cell — same idea, slightly brighter text
    activeFenceLineDeco = createType({
        isWholeLine: true,
        opacity: '0.55',
        backgroundColor: new vscode.ThemeColor('mrmd.activeCellBackground'),
        textDecoration: 'none; font-size: 0.8em; line-height: 1.2',
    });

    // Output fence lines — faded, small
    outputFenceLine = createType({
        isWholeLine: true,
        opacity: '0.25',
        backgroundColor: new vscode.ThemeColor('mrmd.outputBlockBackground'),
        textDecoration: 'none; font-size: 0.7em; line-height: 1.2',
    });

    // Output body text — smaller, dimmed
    outputBodyText = createType({
        isWholeLine: true,
        opacity: '0.6',
        textDecoration: 'none; font-size: 0.85em; line-height: 1.4',
        backgroundColor: new vscode.ThemeColor('mrmd.outputBlockBackground'),
    });

    // Execution status indicators — use ThemeColor-aware colors
    statusRunning = createType({
        before: {
            contentText: '⏳',
            margin: '0 4px 0 0',
            width: '0px',
        },
        isWholeLine: false,
    });

    statusSuccess = createType({
        before: {
            contentText: '✓',
            color: new vscode.ThemeColor('mrmd.statusSuccess'),
            fontWeight: 'bold',
            margin: '0 6px 0 0',
            width: '0px',
        },
        isWholeLine: false,
    });

    statusError = createType({
        before: {
            contentText: '✗',
            color: new vscode.ThemeColor('mrmd.statusError'),
            fontWeight: 'bold',
            margin: '0 6px 0 0',
            width: '0px',
        },
        isWholeLine: false,
    });
}

/**
 * Dispose all decoration types.
 */
export function disposeDecorations(): void {
    for (const t of allTypes) t.dispose();
    allTypes.length = 0;
}

// ── Parsing ───────────────────────────────────────────────────

const FENCE_RE = /^(`{3,}|~{3,})\s*(\S*)/;
const OUTPUT_TAGS = new Set(['output', 'result']);

function parseOutputBlocks(document: vscode.TextDocument): OutputRange[] {
    const results: OutputRange[] = [];
    const lineCount = document.lineCount;
    let i = 0;

    while (i < lineCount) {
        const line = document.lineAt(i).text;
        const match = FENCE_RE.exec(line);

        if (match) {
            const fence = match[1];
            const fenceChar = fence[0];
            const fenceLength = fence.length;
            const tag = (match[2] || '').toLowerCase().replace(/:.*$/, '');

            if (OUTPUT_TAGS.has(tag)) {
                const start = i;
                i++;
                while (i < lineCount) {
                    const closeLine = document.lineAt(i).text.trim();
                    if (closeLine === fenceChar.repeat(closeLine.length) && closeLine.length >= fenceLength) {
                        break;
                    }
                    i++;
                }
                results.push({ start, end: i });
            }
        }
        i++;
    }

    return results;
}

// ── Config ────────────────────────────────────────────────────

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('mrmd.decorations');
    return {
        enabled: cfg.get<boolean>('enabled', true),
        dimFences: cfg.get<boolean>('dimFences', true),
        statusIndicators: cfg.get<boolean>('statusIndicators', true),
    };
}

// ── Apply ─────────────────────────────────────────────────────

export function applyDecorations(
    editor: vscode.TextEditor,
    cursorLine: number,
    cellStatuses: Map<number, CellExecutionStatus>,
): void {
    const document = editor.document;
    if (document.languageId !== 'markdown') return;

    const config = getConfig();

    if (!config.enabled) {
        clearDecorations(editor);
        return;
    }

    const blocks = parseBlocks(document);
    const outputBlocks = parseOutputBlocks(document);

    // Which block has the cursor?
    let activeFenceStart = -1;
    for (const block of blocks) {
        if (cursorLine >= block.fenceStart && cursorLine <= block.fenceEnd) {
            activeFenceStart = block.fenceStart;
            break;
        }
    }

    const bgRanges: vscode.DecorationOptions[] = [];
    const activeBgRanges: vscode.DecorationOptions[] = [];
    const fenceRanges: vscode.DecorationOptions[] = [];
    const activeFenceRanges: vscode.DecorationOptions[] = [];
    const runningRanges: vscode.DecorationOptions[] = [];
    const successRanges: vscode.DecorationOptions[] = [];
    const errorRanges: vscode.DecorationOptions[] = [];

    for (const block of blocks) {
        const isActive = block.fenceStart === activeFenceStart;

        // Fence lines
        if (config.dimFences) {
            const fenceOpenRange = lineRange(block.fenceStart);
            const fenceCloseRange = lineRange(block.fenceEnd);

            if (isActive) {
                activeFenceRanges.push(
                    { range: fenceOpenRange },
                    { range: fenceCloseRange },
                );
            } else {
                fenceRanges.push(
                    { range: fenceOpenRange },
                    { range: fenceCloseRange },
                );
            }
        }

        // Code body
        for (let line = block.fenceStart + 1; line < block.fenceEnd; line++) {
            const range = lineRange(line);
            if (isActive) {
                activeBgRanges.push({ range });
            } else {
                bgRanges.push({ range });
            }
        }

        // Execution status on opening fence
        if (config.statusIndicators) {
            const status = cellStatuses.get(block.fenceStart);
            if (status) {
                const range = lineRange(block.fenceStart);
                switch (status.status) {
                    case 'running': runningRanges.push({ range }); break;
                    case 'success': successRanges.push({ range }); break;
                    case 'error':   errorRanges.push({ range });   break;
                }
            }
        }
    }

    // Output blocks
    const outputFenceRanges: vscode.DecorationOptions[] = [];
    const outputBodyRanges: vscode.DecorationOptions[] = [];

    for (const output of outputBlocks) {
        outputFenceRanges.push(
            { range: lineRange(output.start) },
            { range: lineRange(output.end) },
        );
        for (let line = output.start + 1; line < output.end; line++) {
            outputBodyRanges.push({ range: lineRange(line) });
        }
    }

    // Apply all
    editor.setDecorations(codeBlockBg, bgRanges);
    editor.setDecorations(activeCellBg, activeBgRanges);
    editor.setDecorations(codeFenceLine, fenceRanges);
    editor.setDecorations(activeFenceLineDeco, activeFenceRanges);
    editor.setDecorations(outputFenceLine, outputFenceRanges);
    editor.setDecorations(outputBodyText, outputBodyRanges);
    editor.setDecorations(statusRunning, runningRanges);
    editor.setDecorations(statusSuccess, successRanges);
    editor.setDecorations(statusError, errorRanges);
}

export function clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(codeBlockBg, []);
    editor.setDecorations(activeCellBg, []);
    editor.setDecorations(codeFenceLine, []);
    editor.setDecorations(activeFenceLineDeco, []);
    editor.setDecorations(outputFenceLine, []);
    editor.setDecorations(outputBodyText, []);
    editor.setDecorations(statusRunning, []);
    editor.setDecorations(statusSuccess, []);
    editor.setDecorations(statusError, []);
}

// ── Helpers ───────────────────────────────────────────────────

function lineRange(line: number): vscode.Range {
    return new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
}
