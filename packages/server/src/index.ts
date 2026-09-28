// Public surface of sharpwave-server (for tests and embedding).
export { BrainService } from "./service.js";
export type { ServiceOptions } from "./service.js";
export { resolveConfig, defaultConfig, loadConfigFile, DEFAULT_PORT, DEFAULT_TAILNET_IP, LOOPBACK } from "./config.js";
export type { ServiceConfig, SleepConfig, BackupConfig } from "./config.js";
export { assertBindableHost, BindPolicyError, listenWithRetry } from "./bind.js";
export { TokenStore, mintToken, revokeToken, hashToken, parseScopes, readTokenFile, SCOPES } from "./tokens.js";
export type { Scope, Principal, TokenEntry } from "./tokens.js";
export { BrainManager, SerialQueue, SHARED_BRAIN } from "./brains.js";
export { snapshotBrain, snapshotAll, rotateSnapshots, listSnapshots } from "./backup.js";
export { SERVICE_TOOLS, callTool } from "./tools.js";
export { VERSION } from "./version.js";
