/**
 * CodeLens Provider for mrmd
 *
 * Adds "Run" buttons above code blocks in markdown files.
 * Properly handles nested fences (e.g., 4-backtick blocks containing 3-backtick code).
 *
 * Ported from mrmd prototype to use MRP protocol.
 */

import * as vscode from 'vscode';

// ============================================================================
// Types
// ============================================================================

export interface CodeBlock {
    language: string;
    code: string;
    startLine: number;    // First line of code content
    endLine: number;      // Last line of code content
    fenceStart: number;   // Line of opening fence
    fenceEnd: number;     // Line of closing fence
    fenceLength: number;  // Number of backticks/tildes in the fence
    fenceChar: string;    // '`' or '~'
    isNested?: boolean;   // True if inside an output block
    isOutput?: boolean;   // True if this is an output block
}

// Languages that can be executed via MRP
const EXECUTABLE_LANGUAGES = [
    // Python
    'python', 'py', 'python3',
    // Shell (via IPython %%bash)
    'bash', 'sh', 'zsh',
    // IPython magic languages
    'r',           // %%R
    'julia',       // %%julia
    'ruby',        // %%ruby
    'perl',        // %%perl
    'javascript', 'js',  // %%javascript
    'html',        // %%html
    'latex',       // %%latex
    'svg',         // %%svg
    'sql',         // %%sql
];

// ============================================================================
// CodeLens Provider
// ============================================================================

export class MrmdCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    private cachedBlocks: Map<string, { blocks: CodeBlock[]; version: number }> = new Map();

    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const config = vscode.workspace.getConfiguration('mrmd');
        if (!config.get<boolean>('showCodeLens', true)) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        const blocks = this.parseCodeBlocks(document);

        // Toolbar at top of document
        const toolbarRange = new vscode.Range(0, 0, 0, 0);
        codeLenses.push(new vscode.CodeLens(toolbarRange, {
            title: 'Run All',
            command: 'mrmd.runAllBlocks',
        }));
        codeLenses.push(new vscode.CodeLens(toolbarRange, {
            title: 'Restart',
            command: 'mrmd.restartRuntime',
        }));

        // Code block lenses
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];

            // Skip output blocks (but allow nested code blocks inside output)
            if (block.isOutput && !block.isNested) {
                continue;
            }

            // Only show run buttons for executable languages
            if (!EXECUTABLE_LANGUAGES.includes(block.language.toLowerCase())) {
                continue;
            }

            const range = new vscode.Range(block.fenceStart, 0, block.fenceStart, 0);

            // Run button
            const title = block.isNested ? 'Run (nested)' : 'Run';
            codeLenses.push(new vscode.CodeLens(range, {
                title,
                command: 'mrmd.runBlock',
                arguments: [document.uri, i, block],
            }));

            // Language indicator
            codeLenses.push(new vscode.CodeLens(range, {
                title: `[${block.language}]`,
                command: 'mrmd.showStatus',
            }));
        }

        return codeLenses;
    }

    /**
     * Parse all fenced code blocks from the document.
     * Handles nested fences by tracking fence length.
     */
    parseCodeBlocks(document: vscode.TextDocument): CodeBlock[] {
        // Check cache
        const cacheKey = document.uri.toString();
        const cached = this.cachedBlocks.get(cacheKey);
        if (cached && cached.version === document.version) {
            return cached.blocks;
        }

        const blocks: CodeBlock[] = [];
        const lines = document.getText().split('\n');

        interface FenceState {
            fenceChar: string;
            fenceLength: number;
            language: string;
            fenceStart: number;
            startLine: number;
            codeLines: string[];
            isOutputBlock: boolean;
        }

        const stack: FenceState[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Check for fence (``` or ~~~) with optional language
            const fenceMatch = line.match(/^(`{3,}|~{3,})(\w*)\s*$/);

            if (fenceMatch) {
                const fenceStr = fenceMatch[1];
                const fenceChar = fenceStr[0];
                const fenceLength = fenceStr.length;
                const language = fenceMatch[2] || 'text';

                // Check if this closes the current block
                if (stack.length > 0) {
                    const current = stack[stack.length - 1];

                    // Closes if: same char, no language specifier, length >= opening
                    if (fenceChar === current.fenceChar &&
                        fenceLength >= current.fenceLength &&
                        !fenceMatch[2]) {

                        // Close this block
                        const closed = stack.pop()!;

                        const block: CodeBlock = {
                            language: closed.language,
                            code: closed.codeLines.join('\n'),
                            startLine: closed.startLine,
                            endLine: i - 1,
                            fenceStart: closed.fenceStart,
                            fenceEnd: i,
                            fenceLength: closed.fenceLength,
                            fenceChar: closed.fenceChar,
                            isOutput: closed.isOutputBlock,
                        };

                        // Mark nested blocks
                        if (stack.length > 0 && stack[stack.length - 1].isOutputBlock) {
                            block.isNested = true;
                        }

                        blocks.push(block);
                        continue;
                    }
                }

                // Opening a new block
                const isOutputBlock = ['output', 'result'].includes(language.toLowerCase());
                stack.push({
                    fenceChar,
                    fenceLength,
                    language,
                    fenceStart: i,
                    startLine: i + 1,
                    codeLines: [],
                    isOutputBlock,
                });
            } else if (stack.length > 0) {
                // Inside a block, accumulate content
                stack[stack.length - 1].codeLines.push(line);
            }
        }

        // Sort by position
        blocks.sort((a, b) => a.fenceStart - b.fenceStart);

        // Cache
        this.cachedBlocks.set(cacheKey, { blocks, version: document.version });

        return blocks;
    }

    /**
     * Find the output block immediately following a code block.
     */
    findOutputBlock(
        document: vscode.TextDocument,
        afterLine: number
    ): { start: number; end: number; fenceChar: string; fenceLength: number } | null {
        const lines = document.getText().split('\n');

        // Skip blank lines
        let i = afterLine + 1;
        while (i < lines.length && lines[i].trim() === '') {
            i++;
        }

        // Check for output block
        const fenceMatch = lines[i]?.match(/^(`{3,}|~{3,})(output|result)\b/);
        if (!fenceMatch) {
            return null;
        }

        const fenceChar = fenceMatch[1][0];
        const fenceLength = fenceMatch[1].length;
        const start = i;
        i++;

        // Find closing fence
        const closingPattern = new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${fenceLength},}$`);
        while (i < lines.length) {
            if (closingPattern.test(lines[i])) {
                return { start, end: i, fenceChar, fenceLength };
            }
            i++;
        }

        return null;
    }

    /**
     * Get all code blocks.
     */
    getBlocks(document: vscode.TextDocument): CodeBlock[] {
        return this.parseCodeBlocks(document);
    }

    /**
     * Get executable code blocks only.
     */
    getExecutableBlocks(document: vscode.TextDocument): CodeBlock[] {
        return this.parseCodeBlocks(document).filter(
            b => !b.isOutput && EXECUTABLE_LANGUAGES.includes(b.language.toLowerCase())
        );
    }

    dispose(): void {
        this._onDidChangeCodeLenses.dispose();
        this.cachedBlocks.clear();
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the code block at a given position.
 */
export function getCodeBlockAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    provider: MrmdCodeLensProvider
): CodeBlock | null {
    const blocks = provider.parseCodeBlocks(document);

    for (const block of blocks) {
        if (position.line >= block.fenceStart && position.line <= block.fenceEnd) {
            return block;
        }
    }

    return null;
}

/**
 * Get the next code block after the current position.
 */
export function getNextCodeBlock(
    document: vscode.TextDocument,
    position: vscode.Position,
    provider: MrmdCodeLensProvider
): CodeBlock | null {
    const blocks = provider.getExecutableBlocks(document);

    for (const block of blocks) {
        if (block.fenceStart > position.line) {
            return block;
        }
    }

    return null;
}

/**
 * Get the previous code block before the current position.
 */
export function getPreviousCodeBlock(
    document: vscode.TextDocument,
    position: vscode.Position,
    provider: MrmdCodeLensProvider
): CodeBlock | null {
    const blocks = provider.getExecutableBlocks(document);

    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].fenceEnd < position.line) {
            return blocks[i];
        }
    }

    return null;
}

/**
 * Calculate the fence length needed to wrap content.
 */
export function calculateFenceLength(content: string, minLength = 3): number {
    let maxFence = minLength;

    // Find the longest fence in the content
    const fenceMatches = content.match(/^(`{3,}|~{3,})/gm);
    if (fenceMatches) {
        for (const match of fenceMatches) {
            maxFence = Math.max(maxFence, match.length + 1);
        }
    }

    return maxFence;
}
