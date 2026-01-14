/**
 * Yjs integration for VS Code
 *
 * Provides:
 * - YjsClient: WebSocket connection to mrmd-sync
 * - VsCodeYjsBinding: Y.Text <-> TextDocument sync
 * - MonitorCoordination: Execution protocol via Y.Map
 */

export { YjsClient, type YjsClientOptions, type YjsClientStatus } from './client';
export { VsCodeYjsBinding, createVsCodeBinding } from './vscode-binding';
export { MonitorCoordination, EXECUTION_STATUS, createMonitorCoordination } from './monitor-coordination';
