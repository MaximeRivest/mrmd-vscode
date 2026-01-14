/**
 * Hover Provider for mrmd
 *
 * Provides hover information (docstrings, type info) for Python code
 * inside markdown code blocks using MRP protocol.
 */

import * as vscode from 'vscode';
import { MrpClient } from './mrp-client';
import { MrmdCodeLensProvider, getCodeBlockAtPosition } from './codelens-provider';

export class MrmdHoverProvider implements vscode.HoverProvider {
    constructor(
        private getClient: () => MrpClient | null,
        private codeLensProvider: MrmdCodeLensProvider
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        // Only provide hovers in markdown files
        if (document.languageId !== 'markdown') {
            return null;
        }

        // Check if we're inside a Python code block
        const block = getCodeBlockAtPosition(document, position, this.codeLensProvider);
        if (!block) {
            return null;
        }

        // Only provide hovers in Python blocks
        const lang = block.language.toLowerCase();
        if (!['python', 'py', 'python3'].includes(lang)) {
            return null;
        }

        const client = this.getClient();
        if (!client) {
            return null;
        }

        // Calculate cursor position within the code block
        const lineInBlock = position.line - block.startLine;
        const codeLines = block.code.split('\n');

        // Build code up to cursor position
        let cursorOffset = 0;
        for (let i = 0; i < lineInBlock && i < codeLines.length; i++) {
            cursorOffset += codeLines[i].length + 1;
        }
        cursorOffset += position.character;

        // Get the word at the cursor position
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }

        try {
            const response = await client.inspect({
                code: block.code,
                cursor: cursorOffset,
                detail: 1,
            });

            if (!response.found || !response.data) {
                return null;
            }

            // Build hover content
            const contents = new vscode.MarkdownString();
            contents.isTrusted = true;

            // Add text/plain content (usually the signature or type info)
            if (response.data['text/plain']) {
                contents.appendCodeblock(response.data['text/plain'], 'python');
            }

            // Add HTML content if available (rendered docstring)
            if (response.data['text/html']) {
                // Strip HTML tags for markdown display
                const text = response.data['text/html']
                    .replace(/<[^>]*>/g, '')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&')
                    .trim();

                if (text) {
                    contents.appendMarkdown('\n---\n');
                    contents.appendMarkdown(text);
                }
            }

            return new vscode.Hover(contents, wordRange);
        } catch (err) {
            console.error('Hover error:', err);
            return null;
        }
    }

    dispose(): void {}
}
