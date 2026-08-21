/**
 * Metrics and observability utilities.
 * Exports Prometheus-compatible metrics and structured logging helpers.
 */

import { getDb } from "./db.js";
import type { BrainConfig } from "./types.js";

export interface MetricsSnapshot {
  timestamp: number;
  agent_id: string;
  
  // Node metrics
  total_nodes: number;
  nodes_by_type: Record<string, number>;
  nodes_with_embeddings: number;
  embedding_coverage_percent: number;
  
  // Retrieval metrics
  avg_retrievability: number;
  avg_salience: number;
  nodes_faded: number; // R < 0.05
  
  // Edge metrics
  total_active_edges: number;
  edges_by_type: Record<string, number>;
  
  // Episode metrics
  total_episodes: number;
  episodes_extracted: number;
  
  // Consolidation metrics
  last_consolidation: string | null;
  consolidation_duration_ms?: number;
  
  // Resource metrics
  db_size_bytes: number;
  backup_storage_bytes: number;
  
  // Neuromodulator state
  dopamine: number;
  serotonin: number;
  acetylcholine: number;
  norepinephrine: number;
  neuro_state: string;
}

/**
 * Collect comprehensive metrics snapshot for an agent.
 */
export function collectMetrics(agentId: string, config: BrainConfig): MetricsSnapshot {
  const db = getDb(agentId);
  const now = Date.now();

  // Basic counts
  const totalNodes = (db.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
  const totalEpisodes = (db.prepare("SELECT COUNT(*) as n FROM episodes").get() as { n: number }).n;
  const totalEdges = (db.prepare("SELECT COUNT(*) as n FROM edges WHERE valid_until IS NULL").get() as { n: number }).n;
  
  // Nodes by type
  const nodesByType = db.prepare("SELECT type, COUNT(*) as n FROM nodes GROUP BY type ORDER BY n DESC").all() as Array<{ type: string; n: number }>;
  const nodesByTypeMap: Record<string, number> = {};
  for (const row of nodesByType) {
    nodesByTypeMap[row.type] = row.n;
  }

  // Embedding coverage
  const withEmbeddings = (db.prepare("SELECT COUNT(*) as n FROM nodes WHERE embedding IS NOT NULL").get() as { n: number }).n;
  const embeddingCoverage = totalNodes > 0 ? Math.round((withEmbeddings / totalNodes) * 100) : 0;

  // Retrievability and salience
  const avgMetrics = (db.prepare("SELECT AVG(retrievability) as avg_r, AVG(salience) as avg_s FROM nodes").get() as { avg_r: number | null; avg_s: number | null });
  const avgRetrievability = avgMetrics.avg_r ?? 0;
  const avgSalience = avgMetrics.avg_s ?? 0;

  // Faded nodes
  const nodesFaded = (db.prepare("SELECT COUNT(*) as n FROM nodes WHERE retrievability < 0.05").get() as { n: number }).n;

  // Edges by type
  const edgesByType = db.prepare("SELECT type, COUNT(*) as n FROM edges WHERE valid_until IS NULL GROUP BY type ORDER BY n DESC").all() as Array<{ type: string; n: number }>;
  const edgesByTypeMap: Record<string, number> = {};
  for (const row of edgesByType) {
    edgesByTypeMap[row.type] = row.n;
  }

  // Episodes extracted
  const episodesExtracted = (db.prepare("SELECT COUNT(*) as n FROM episodes WHERE llm_extracted = 1").get() as { n: number }).n;

  // Consolidation status
  const lastConsolidationMs = parseInt((db.prepare("SELECT value FROM meta WHERE key = 'last_consolidation'").get() as { value?: string } | undefined)?.value ?? "0", 10);
  const lastConsolidation = lastConsolidationMs > 0 ? new Date(lastConsolidationMs).toISOString() : null;

  // Database size
  let dbSizeBytes = 0;
  try {
    const dbPath = db.exec("PRAGMA database_list")[0]?.file as string | undefined;
    if (dbPath) {
      const { statSync } = require("node:fs");
      dbSizeBytes = statSync(dbPath).size;
    }
  } catch {
    // ignore
  }

  // Backup storage
  let backupStorageBytes = 0;
  try {
    const { getBackupStorageUsage } = await import("./db-backup.js");
    backupStorageBytes = getBackupStorageUsage(agentId);
  } catch {
    // ignore
  }

  // Neuromodulator state
  const neuroRow = db.prepare(`
    SELECT
      MAX(CASE WHEN key = 'neuro_dopamine' THEN value END) as dopamine,
      MAX(CASE WHEN key = 'neuro_serotonin' THEN value END) as serotonin,
      MAX(CASE WHEN key = 'neuro_acetylcholine' THEN value END) as acetylcholine,
      MAX(CASE WHEN key = 'neuro_norepinephrine' THEN value END) as norepinephrine,
      MAX(CASE WHEN key = 'neuro_state' THEN value END) as state
    FROM meta
  `).get() as any;

  const dopamine = parseFloat(neuroRow?.dopamine ?? "0.5");
  const serotonin = parseFloat(neuroRow?.serotonin ?? "0.5");
  const acetylcholine = parseFloat(neuroRow?.acetylcholine ?? "0.5");
  const norepinephrine = parseFloat(neuroRow?.norepinephrine ?? "0.5");
  const neuroState = neuroRow?.state ?? "baseline";

  return {
    timestamp: now,
    agent_id: agentId,
    total_nodes: totalNodes,
    nodes_by_type: nodesByTypeMap,
    nodes_with_embeddings: withEmbeddings,
    embedding_coverage_percent: embeddingCoverage,
    avg_retrievability: avgRetrievability,
    avg_salience: avgSalience,
    nodes_faded,
    total_active_edges: totalEdges,
    edges_by_type: edgesByTypeMap,
    total_episodes: totalEpisodes,
    episodes_extracted: episodesExtracted,
    last_consolidation: lastConsolidation,
    db_size_bytes: dbSizeBytes,
    backup_storage_bytes: backupStorageBytes,
    dopamine,
    serotonin,
    acetylcholine,
    norepinephrine,
    neuro_state: neuroState,
  };
}

/**
 * Format metrics as Prometheus text format (exposition format).
 * Can be scraped by Prometheus or viewed as human-readable stats.
 */
export function formatPrometheusMetrics(metrics: MetricsSnapshot): string {
  const lines: string[] = [];

  // Timestamp header
  lines.push(`# Generated at ${new Date(metrics.timestamp).toISOString()}`);
  lines.push(`# Agent: ${metrics.agent_id}`);
  lines.push("");

  // Node metrics
  lines.push("# HELP sharpwave_nodes_total Total number of nodes");
  lines.push("# TYPE sharpwave_nodes_total gauge");
  lines.push(`sharpwave_nodes_total{agent="${metrics.agent_id}"} ${metrics.total_nodes}`);
  lines.push("");

  lines.push("# HELP sharpwave_nodes_by_type Number of nodes by type");
  lines.push("# TYPE sharpwave_nodes_by_type gauge");
  for (const [type, count] of Object.entries(metrics.nodes_by_type)) {
    lines.push(`sharpwave_nodes_by_type{agent="${metrics.agent_id}",type="${type}"} ${count}`);
  }
  lines.push("");

  lines.push("# HELP sharpwave_nodes_with_embeddings Number of nodes with embeddings");
  lines.push("# TYPE sharpwave_nodes_with_embeddings gauge");
  lines.push(`sharpwave_nodes_with_embeddings{agent="${metrics.agent_id}"} ${metrics.nodes_with_embeddings}`);
  lines.push("");

  lines.push("# HELP sharpwave_embedding_coverage_percent Embedding coverage percentage");
  lines.push("# TYPE sharpwave_embedding_coverage_percent gauge");
  lines.push(`sharpwave_embedding_coverage_percent{agent="${metrics.agent_id}"} ${metrics.embedding_coverage_percent}`);
  lines.push("");

  // Retrievability metrics
  lines.push("# HELP sharpwave_avg_retrievability Average retrievability");
  lines.push("# TYPE sharpwave_avg_retrievability gauge");
  lines.push(`sharpwave_avg_retrievability{agent="${metrics.agent_id}"} ${metrics.avg_retrievability.toFixed(4)}`);
  lines.push("");

  lines.push("# HELP sharpwave_avg_salience Average salience");
  lines.push("# TYPE sharpwave_avg_salience gauge");
  lines.push(`sharpwave_avg_salience{agent="${metrics.agent_id}"} ${metrics.avg_salience.toFixed(4)}`);
  lines.push("");

  lines.push("# HELP sharpwave_nodes_faded Number of faded nodes (R < 0.05)");
  lines.push("# TYPE sharpwave_nodes_faded gauge");
  lines.push(`sharpwave_nodes_faded{agent="${metrics.agent_id}"} ${metrics.nodes_faded}`);
  lines.push("");

  // Edge metrics
  lines.push("# HELP sharpwave_edges_total Total number of active edges");
  lines.push("# TYPE sharpwave_edges_total gauge");
  lines.push(`sharpwave_edges_total{agent="${metrics.agent_id}"} ${metrics.total_active_edges}`);
  lines.push("");

  lines.push("# HELP sharpwave_edges_by_type Number of edges by type");
  lines.push("# TYPE sharpwave_edges_by_type gauge");
  for (const [type, count] of Object.entries(metrics.edges_by_type)) {
    lines.push(`sharpwave_edges_by_type{agent="${metrics.agent_id}",type="${type}"} ${count}`);
  }
  lines.push("");

  // Episode metrics
  lines.push("# HELP sharpwave_episodes_total Total number of episodes");
  lines.push("# TYPE sharpwave_episodes_total gauge");
  lines.push(`sharpwave_episodes_total{agent="${metrics.agent_id}"} ${metrics.total_episodes}`);
  lines.push("");

  lines.push("# HELP sharpwave_episodes_extracted Number of extracted episodes");
  lines.push("# TYPE sharpwave_episodes_extracted gauge");
  lines.push(`sharpwave_episodes_extracted{agent="${metrics.agent_id}"} ${metrics.episodes_extracted}`);
  lines.push("");

  // Resource metrics
  lines.push("# HELP sharpwave_db_size_bytes Database file size in bytes");
  lines.push("# TYPE sharpwave_db_size_bytes gauge");
  lines.push(`sharpwave_db_size_bytes{agent="${metrics.agent_id}"} ${metrics.db_size_bytes}`);
  lines.push("");

  lines.push("# HELP sharpwave_backup_storage_bytes Total backup storage in bytes");
  lines.push("# TYPE sharpwave_backup_storage_bytes gauge");
  lines.push(`sharpwave_backup_storage_bytes{agent="${metrics.agent_id}"} ${metrics.backup_storage_bytes}`);
  lines.push("");

  // Neuromodulator metrics
  lines.push("# HELP sharpwave_dopamine Dopamine level (0.0-1.0)");
  lines.push("# TYPE sharpwave_dopamine gauge");
  lines.push(`sharpwave_dopamine{agent="${metrics.agent_id}"} ${metrics.dopamine.toFixed(4)}`);
  lines.push("");

  lines.push("# HELP sharpwave_serotonin Serotonin level (0.0-1.0)");
  lines.push("# TYPE sharpwave_serotonin gauge");
  lines.push(`sharpwave_serotonin{agent="${metrics.agent_id}"} ${metrics.serotonin.toFixed(4)}`);
  lines.push("");

  lines.push("# HELP sharpwave_acetylcholine Acetylcholine level (0.0-1.0)");
  lines.push("# TYPE sharpwave_acetylcholine gauge");
  lines.push(`sharpwave_acetylcholine{agent="${metrics.agent_id}"} ${metrics.acetylcholine.toFixed(4)}`);
  lines.push("");

  lines.push("# HELP sharpwave_norepinephrine Norepinephrine level (0.0-1.0)");
  lines.push("# TYPE sharpwave_norepinephrine gauge");
  lines.push(`sharpwave_norepinephrine{agent="${metrics.agent_id}"} ${metrics.norepinephrine.toFixed(4)}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Format metrics as human-readable text.
 */
export function formatMetricsAsText(metrics: MetricsSnapshot): string {
  const lines: string[] = [];

  lines.push(`=== Sharpwave Metrics (${new Date(metrics.timestamp).toISOString()}) ===`);
  lines.push(`Agent: ${metrics.agent_id}`);
  lines.push("");

  lines.push("=== Nodes ===");
  lines.push(`Total: ${metrics.total_nodes} | Faded (R<0.05): ${metrics.nodes_faded}`);
  lines.push(`Avg Retrievability: ${metrics.avg_retrievability.toFixed(3)} | Avg Salience: ${metrics.avg_salience.toFixed(3)}`);
  lines.push(`By Type: ${Object.entries(metrics.nodes_by_type).map(([t, n]) => `${t}=${n}`).join(", ")}`);
  lines.push(`Embeddings: ${metrics.nodes_with_embeddings}/${metrics.total_nodes} (${metrics.embedding_coverage_percent}%)`);
  lines.push("");

  lines.push("=== Edges ===");
  lines.push(`Active: ${metrics.total_active_edges}`);
  lines.push(`By Type: ${Object.entries(metrics.edges_by_type).map(([t, n]) => `${t}=${n}`).join(", ")}`);
  lines.push("");

  lines.push("=== Episodes ===");
  lines.push(`Total: ${metrics.total_episodes} | Extracted: ${metrics.episodes_extracted}`);
  lines.push("");

  lines.push("=== Consolidation ===");
  lines.push(`Last: ${metrics.last_consolidation ?? "never"}`);
  lines.push("");

  lines.push("=== Resources ===");
  lines.push(`DB Size: ${formatBytes(metrics.db_size_bytes)}`);
  lines.push(`Backup Storage: ${formatBytes(metrics.backup_storage_bytes)}`);
  lines.push("");

  lines.push("=== Neuromodulators ===");
  lines.push(`Dopamine: ${metrics.dopamine.toFixed(2)} | Serotonin: ${metrics.serotonin.toFixed(2)}`);
  lines.push(`Acetylcholine: ${metrics.acetylcholine.toFixed(2)} | Norepinephrine: ${metrics.norepinephrine.toFixed(2)}`);
  lines.push(`State: ${metrics.neuro_state}`);
  lines.push("");

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}
