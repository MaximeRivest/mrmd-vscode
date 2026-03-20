/**
 * Daemon Client
 *
 * Connects to the mrmd daemon over Unix socket.
 * The daemon is bundled inside the extension — auto-starts if not running.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';

// ── Socket path (must match daemon) ───────────────────────────

function getSocketPath(): string {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\mrmd-daemon';
    }
    return path.join(os.tmpdir(), `mrmd-daemon-${os.userInfo().uid}.sock`);
}

function getPidPath(): string {
    return path.join(os.homedir(), '.mrmd', 'daemon.pid');
}

function isDaemonRunning(): boolean {
    try {
        const data = JSON.parse(fs.readFileSync(getPidPath(), 'utf8'));
        process.kill(data.pid, 0);
        return true;
    } catch {
        return false;
    }
}

// ── Types ─────────────────────────────────────────────────────

export interface RuntimeInfo {
    name: string;
    language: string;
    pid: number;
    port: number;
    url: string;
    cwd: string;
    alive: boolean;
    consumers: string[];
}

export interface DaemonStatus {
    pid: number;
    uptime: number;
    runtimes: number;
    heads: number;
}

// ── Client ────────────────────────────────────────────────────

export class DaemonClient {
    private socket: net.Socket | null = null;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private buffer = '';
    private connected = false;

    /**
     * Connect to the daemon. Starts it if not running.
     */
    async connect(): Promise<void> {
        if (this.connected) return;

        if (!isDaemonRunning()) {
            await this.startDaemon();
        }

        const socketPath = getSocketPath();

        // Wait for socket file
        const start = Date.now();
        while (Date.now() - start < 5000) {
            if (fs.existsSync(socketPath)) break;
            await sleep(100);
        }

        await this.connectSocket(socketPath);
        this.connected = true;
    }

    /**
     * Start a runtime. Returns MRP URL.
     */
    async startRuntime(language: string, cwd: string, name?: string): Promise<RuntimeInfo> {
        return this.call('runtime.start', {
            name: name || `rt:${language}:${Date.now()}`,
            language,
            cwd,
        });
    }

    /**
     * Stop a runtime.
     */
    async stopRuntime(name: string): Promise<boolean> {
        return this.call('runtime.stop', { name });
    }

    /**
     * List running runtimes.
     */
    async listRuntimes(language?: string): Promise<RuntimeInfo[]> {
        return this.call('runtime.list', { language });
    }

    /**
     * Get daemon status.
     */
    async status(): Promise<DaemonStatus> {
        return this.call('daemon.status', {});
    }

    /**
     * Disconnect (daemon stays running).
     */
    disconnect(): void {
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;

        for (const [, { reject }] of this.pending) {
            reject(new Error('Disconnected'));
        }
        this.pending.clear();
    }

    // ── Internal ──────────────────────────────────────────────

    private async startDaemon(): Promise<void> {
        const script = this.findDaemonScript();
        if (!script) {
            throw new Error('mrmd daemon not found. Extension may not be installed correctly.');
        }

        const proc = cp.spawn(process.execPath, [script, 'daemon', 'start', '--foreground'], {
            stdio: 'ignore',
            detached: true,
        });
        proc.unref();

        await sleep(800);
    }

    private findDaemonScript(): string | null {
        const candidates = [
            path.resolve(__dirname, '..', 'node_modules', 'mrmd', 'bin', 'mrmd.js'),
            path.resolve(__dirname, '..', '..', 'mrmd', 'bin', 'mrmd.js'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    private connectSocket(socketPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = net.createConnection(socketPath);
            this.socket.on('connect', () => resolve());
            this.socket.once('error', reject);

            this.socket.on('data', (data) => {
                this.buffer += data.toString();
                let nl: number;
                while ((nl = this.buffer.indexOf('\n')) !== -1) {
                    const line = this.buffer.slice(0, nl).trim();
                    this.buffer = this.buffer.slice(nl + 1);
                    if (line) this.handleMessage(line);
                }
            });

            this.socket.on('close', () => {
                this.connected = false;
            });
        });
    }

    private handleMessage(raw: string): void {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }

        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);

        if (msg.error) {
            p.reject(new Error(msg.error));
        } else {
            p.resolve(msg.result);
        }
    }

    private call(method: string, params: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('Not connected to daemon'));
                return;
            }
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.socket.write(JSON.stringify({ id, method, params }) + '\n');
        });
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
