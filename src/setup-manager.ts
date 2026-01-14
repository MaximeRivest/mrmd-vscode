/**
 * Setup Manager for mrmd
 *
 * Handles first-run setup:
 * - Checks if mrmd-python is installed
 * - Offers to install via uv/pip
 * - Detects Python environment
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';

interface SetupStatus {
    uvAvailable: boolean;
    pipAvailable: boolean;
    pythonPath: string | null;
    mrmdPythonInstalled: boolean;
    mrmdPythonVersion: string | null;
}

export class SetupManager {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('mrmd Setup');
    }

    /**
     * Check current setup status.
     */
    async checkStatus(): Promise<SetupStatus> {
        const [uvAvailable, pipAvailable, pythonPath] = await Promise.all([
            this.commandExists('uv --version'),
            this.commandExists('pip --version'),
            this.findPython(),
        ]);

        let mrmdPythonInstalled = false;
        let mrmdPythonVersion: string | null = null;

        // Check if mrmd-python is installed
        if (uvAvailable) {
            const result = await this.runCommand('uvx mrmd-python --version');
            if (result.success) {
                mrmdPythonInstalled = true;
                mrmdPythonVersion = result.stdout.trim();
            }
        }

        if (!mrmdPythonInstalled && pythonPath) {
            const result = await this.runCommand(`${pythonPath} -m mrmd_python --version`);
            if (result.success) {
                mrmdPythonInstalled = true;
                mrmdPythonVersion = result.stdout.trim();
            }
        }

        return {
            uvAvailable,
            pipAvailable,
            pythonPath,
            mrmdPythonInstalled,
            mrmdPythonVersion,
        };
    }

    /**
     * Run setup if needed, showing prompts to the user.
     * Returns true if setup is complete and ready to use.
     */
    async ensureSetup(): Promise<boolean> {
        const status = await this.checkStatus();

        // Already installed
        if (status.mrmdPythonInstalled) {
            return true;
        }

        // Need to install
        const installMethod = status.uvAvailable ? 'uv' : (status.pipAvailable ? 'pip' : null);

        if (!installMethod) {
            // No package manager available
            const action = await vscode.window.showErrorMessage(
                'mrmd requires Python and a package manager (uv or pip). Would you like to install uv?',
                'Install uv',
                'Cancel'
            );

            if (action === 'Install uv') {
                await this.installUv();
                return this.ensureSetup(); // Retry
            }
            return false;
        }

        // Offer to install mrmd-python
        const action = await vscode.window.showInformationMessage(
            'mrmd-python is not installed. Install it now?',
            'Install with ' + installMethod,
            'Cancel'
        );

        if (action?.startsWith('Install')) {
            const success = await this.installMrmdPython(installMethod as 'uv' | 'pip');
            if (success) {
                vscode.window.showInformationMessage('mrmd-python installed successfully!');
                return true;
            } else {
                vscode.window.showErrorMessage('Failed to install mrmd-python. Check the output panel for details.');
                this.outputChannel.show();
                return false;
            }
        }

        return false;
    }

    /**
     * Install mrmd-python package.
     */
    async installMrmdPython(method: 'uv' | 'pip'): Promise<boolean> {
        this.outputChannel.show();
        this.outputChannel.appendLine(`Installing mrmd-python via ${method}...`);

        let command: string;
        if (method === 'uv') {
            command = 'uv pip install mrmd-python';
        } else {
            command = 'pip install mrmd-python';
        }

        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing mrmd-python...',
                cancellable: false,
            },
            async () => {
                const result = await this.runCommand(command, { showOutput: true });
                return result.success;
            }
        );
    }

    /**
     * Install uv package manager.
     */
    async installUv(): Promise<boolean> {
        this.outputChannel.show();
        this.outputChannel.appendLine('Installing uv...');

        // Platform-specific install
        const isWindows = process.platform === 'win32';
        const command = isWindows
            ? 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
            : 'curl -LsSf https://astral.sh/uv/install.sh | sh';

        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing uv...',
                cancellable: false,
            },
            async () => {
                const result = await this.runCommand(command, { showOutput: true, shell: true });
                if (result.success) {
                    vscode.window.showInformationMessage(
                        'uv installed! You may need to restart VS Code or open a new terminal.'
                    );
                }
                return result.success;
            }
        );
    }

    /**
     * Find Python executable.
     */
    private async findPython(): Promise<string | null> {
        const candidates = ['python3', 'python'];

        for (const cmd of candidates) {
            const result = await this.runCommand(`${cmd} --version`);
            if (result.success) {
                return cmd;
            }
        }

        return null;
    }

    /**
     * Check if a command exists.
     */
    private async commandExists(command: string): Promise<boolean> {
        const result = await this.runCommand(command);
        return result.success;
    }

    /**
     * Run a shell command.
     */
    private runCommand(
        command: string,
        options: { showOutput?: boolean; shell?: boolean } = {}
    ): Promise<{ success: boolean; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            // Ensure ~/.local/bin is in PATH for uvx
            const env = { ...process.env };
            const home = process.env.HOME || '';
            const localBin = `${home}/.local/bin`;
            const cargobin = `${home}/.cargo/bin`;
            env.PATH = `${localBin}:${cargobin}:${env.PATH || ''}`;

            const opts: cp.ExecOptions = {
                timeout: 60000,
                shell: options.shell ?? true,
                env,
            };

            cp.exec(command, opts, (error, stdout, stderr) => {
                if (options.showOutput) {
                    if (stdout) this.outputChannel.append(stdout);
                    if (stderr) this.outputChannel.append(stderr);
                }

                resolve({
                    success: !error,
                    stdout: stdout?.toString() || '',
                    stderr: stderr?.toString() || '',
                });
            });
        });
    }

    dispose(): void {
        this.outputChannel.dispose();
    }
}
