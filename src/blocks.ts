/**
 * Code block detection in markdown documents.
 *
 * Finds fenced code blocks (``` or ~~~), their language, content,
 * and any existing output blocks that follow them.
 */

import * as vscode from 'vscode';

export interface CodeBlock {
    language: string;
    code: string;
    /** Line number of the opening fence (```python) */
    fenceStart: number;
    /** Line number of the closing fence (```) */
    fenceEnd: number;
    /** Character used for fence (` or ~) */
    fenceChar: string;
    /** Length of fence (3 or more) */
    fenceLength: number;
}

export interface OutputBlock {
    /** Line number of the opening fence (```output) */
    start: number;
    /** Line number of the closing fence (```) */
    end: number;
    fenceChar: string;
    fenceLength: number;
}

const EXECUTABLE_LANGUAGES = new Set([
    'python', 'py', 'python3',
    'r', 'rlang',
    'julia', 'jl',
    'javascript', 'js', 'node',
    'typescript', 'ts',
    'bash', 'sh', 'shell', 'zsh',
    'ruby', 'rb',
    'lua',
]);

const FENCE_RE = /^(`{3,}|~{3,})\s*(\S*)/;

/**
 * Parse all code blocks from a document.
 */
export function parseBlocks(document: vscode.TextDocument): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const lineCount = document.lineCount;
    let i = 0;

    while (i < lineCount) {
        const line = document.lineAt(i).text;
        const match = FENCE_RE.exec(line);

        if (match) {
            const fence = match[1];
            const fenceChar = fence[0];
            const fenceLength = fence.length;
            const language = (match[2] || '').toLowerCase().replace(/:.*$/, ''); // strip :execId etc.

            // Skip non-code blocks (output, etc.)
            if (language === 'output' || language === 'result') {
                // Skip to closing fence
                i++;
                while (i < lineCount) {
                    const closeLine = document.lineAt(i).text;
                    if (isClosingFence(closeLine, fenceChar, fenceLength)) break;
                    i++;
                }
                i++;
                continue;
            }

            // Find closing fence
            const fenceStart = i;
            i++;
            const codeLines: string[] = [];

            while (i < lineCount) {
                const closeLine = document.lineAt(i).text;
                if (isClosingFence(closeLine, fenceChar, fenceLength)) break;
                codeLines.push(document.lineAt(i).text);
                i++;
            }

            const fenceEnd = i;

            if (language && EXECUTABLE_LANGUAGES.has(language)) {
                blocks.push({
                    language: normalizeLanguage(language),
                    code: codeLines.join('\n'),
                    fenceStart,
                    fenceEnd,
                    fenceChar,
                    fenceLength,
                });
            }
        }

        i++;
    }

    return blocks;
}

/**
 * Find the code block at or containing the cursor position.
 */
export function blockAtCursor(document: vscode.TextDocument, position: vscode.Position): CodeBlock | null {
    const blocks = parseBlocks(document);
    const line = position.line;

    for (const block of blocks) {
        if (line >= block.fenceStart && line <= block.fenceEnd) {
            return block;
        }
    }

    return null;
}

/**
 * Find the next code block after the cursor.
 */
export function nextBlock(document: vscode.TextDocument, position: vscode.Position): CodeBlock | null {
    const blocks = parseBlocks(document);
    for (const block of blocks) {
        if (block.fenceStart > position.line) {
            return block;
        }
    }
    return null;
}

/**
 * Find existing output block immediately following a code block.
 */
export function findOutputBlock(document: vscode.TextDocument, afterLine: number): OutputBlock | null {
    let i = afterLine + 1;

    // Skip blank lines
    while (i < document.lineCount && document.lineAt(i).text.trim() === '') {
        i++;
    }

    if (i >= document.lineCount) return null;

    const line = document.lineAt(i).text;
    const match = FENCE_RE.exec(line);
    if (!match) return null;

    const fence = match[1];
    const fenceChar = fence[0];
    const fenceLength = fence.length;
    const tag = (match[2] || '').toLowerCase();

    if (!tag.startsWith('output')) return null;

    const start = i;
    i++;

    while (i < document.lineCount) {
        if (isClosingFence(document.lineAt(i).text, fenceChar, fenceLength)) {
            return { start, end: i, fenceChar, fenceLength };
        }
        i++;
    }

    return null;
}

function isClosingFence(line: string, char: string, minLength: number): boolean {
    const trimmed = line.trim();
    if (trimmed.length < minLength) return false;
    return trimmed === char.repeat(trimmed.length) && trimmed.length >= minLength;
}

function normalizeLanguage(lang: string): string {
    const map: Record<string, string> = {
        py: 'python', python3: 'python',
        js: 'javascript', node: 'javascript', ts: 'typescript',
        sh: 'bash', shell: 'bash', zsh: 'bash',
        jl: 'julia',
        rb: 'ruby',
        rlang: 'r',
    };
    return map[lang] || lang;
}
