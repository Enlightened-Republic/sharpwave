/**
 * Database backup and recovery utilities.
 * Provides safe checkpoint creation before destructive operations like consolidation.
 */

import { existsSync, copyFileSync, unlinkSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { getDb, getMeta, setMeta } from "./db.js";

interface BackupInfo {
  timestamp: number;
  agentId: string;
  reason: string;
  dbPath: string;
  backupPath: string;
}

const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_BACKUPS_PER_AGENT = 5;

/**
 * Get the backup directory for an agent.
 * Located alongside the main database file.
 */
export function getBackupDir(agentId: string): string {
  const db = getDb(agentId);
  const dbPath = db.name as string | undefined;
  if (!dbPath) {
    throw new Error(`Could not determine database path for agent ${agentId}`);
  }
  return join(dirname(dbPath), ".backups");
}

/**
 * Create a backup of the database before a risky operation.
 * Returns the path to the backup file on success.
 * 
 * Automatically prunes old backups (>7 days or >5 per agent).
 */
export function createBackup(agentId: string, reason: string): string {
  const db = getDb(agentId);
  
  // Flush any pending WAL data to the main database file
  try {
    db.pragma("wal_checkpoint(RESTART)");
  } catch (err) {
    console.warn(`[sharpwave] backup: wal_checkpoint failed: ${String(err)}`);
  }

  const dbPath = db.name as string | undefined;
  if (!dbPath) {
    throw new Error(`Could not determine database path for agent ${agentId}`);
  }

  if (!existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }

  const backupDir = getBackupDir(agentId);
  
  // Create backup directory if it doesn't exist
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = Date.now();
  const backupName = `backup-${timestamp}.db`;
  const backupPath = join(backupDir, backupName);

  try {
    copyFileSync(dbPath, backupPath);
  } catch (err) {
    throw new Error(`Failed to create backup at ${backupPath}: ${String(err)}`);
  }

  // Store backup metadata
  const backups = loadBackupManifest(agentId);
  backups.push({
    timestamp,
    agentId,
    reason,
    dbPath,
    backupPath,
  });

  // Prune old backups
  pruneBackups(agentId, backups);
  saveBackupManifest(agentId, backups);

  return backupPath;
}

/**
 * Restore from a backup. The current database is moved to .old and the backup
 * is restored to its original location.
 */
export function restoreBackup(agentId: string, backupPath: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  const db = getDb(agentId);
  const dbPath = db.name as string | undefined;
  if (!dbPath) {
    throw new Error(`Could not determine database path for agent ${agentId}`);
  }

  // Close the database connection before touching files
  // Note: this is a simplified approach; real implementations would need
  // proper connection lifecycle management.

  try {
    // Move current DB to .old
    if (existsSync(dbPath)) {
      const oldPath = `${dbPath}.old`;
      renameSync(dbPath, oldPath);
    }

    // Restore backup
    copyFileSync(backupPath, dbPath);
  } catch (err) {
    throw new Error(`Failed to restore backup: ${String(err)}`);
  }
}

/**
 * List all available backups for an agent.
 */
export function listBackups(agentId: string): BackupInfo[] {
  try {
    return loadBackupManifest(agentId);
  } catch {
    return [];
  }
}

/**
 * Get backup metadata (path, timestamp, reason).
 */
export function getBackupInfo(agentId: string, backupPath: string): BackupInfo | null {
  const backups = loadBackupManifest(agentId);
  return backups.find((b) => b.backupPath === backupPath) ?? null;
}

/**
 * Delete a specific backup file and remove from manifest.
 */
export function deleteBackup(agentId: string, backupPath: string): void {
  if (existsSync(backupPath)) {
    try {
      unlinkSync(backupPath);
    } catch (err) {
      console.warn(`[sharpwave] failed to delete backup ${backupPath}: ${String(err)}`);
    }
  }

  const backups = loadBackupManifest(agentId);
  const filtered = backups.filter((b) => b.backupPath !== backupPath);
  saveBackupManifest(agentId, filtered);
}

/**
 * Prune backups older than BACKUP_RETENTION_MS or beyond MAX_BACKUPS_PER_AGENT.
 */
function pruneBackups(agentId: string, backups: BackupInfo[]): void {
  const now = Date.now();
  const cutoff = now - BACKUP_RETENTION_MS;

  // Remove expired backups
  for (const backup of backups) {
    if (backup.timestamp < cutoff) {
      deleteBackup(agentId, backup.backupPath);
    }
  }

  // Keep only the newest MAX_BACKUPS_PER_AGENT backups
  const active = loadBackupManifest(agentId).sort((a, b) => b.timestamp - a.timestamp);
  if (active.length > MAX_BACKUPS_PER_AGENT) {
    for (let i = MAX_BACKUPS_PER_AGENT; i < active.length; i++) {
      deleteBackup(agentId, active[i].backupPath);
    }
  }
}

/**
 * Load backup manifest from database metadata.
 */
function loadBackupManifest(agentId: string): BackupInfo[] {
  try {
    const manifestJson = getMeta(agentId, "backup_manifest");
    if (!manifestJson) return [];
    return JSON.parse(manifestJson) as BackupInfo[];
  } catch {
    return [];
  }
}

/**
 * Save backup manifest to database metadata.
 */
function saveBackupManifest(agentId: string, backups: BackupInfo[]): void {
  setMeta(agentId, "backup_manifest", JSON.stringify(backups));
}

/**
 * Get the most recent backup for an agent.
 */
export function getLatestBackup(agentId: string): BackupInfo | null {
  const backups = loadBackupManifest(agentId).sort((a, b) => b.timestamp - a.timestamp);
  return backups[0] ?? null;
}

/**
 * Get disk size of all backups for an agent.
 */
export function getBackupStorageUsage(agentId: string): number {
  let total = 0;

  for (const backup of loadBackupManifest(agentId)) {
    try {
      if (existsSync(backup.backupPath)) {
        total += statSync(backup.backupPath).size;
      }
    } catch {
      // ignore
    }
  }

  return total;
}
