# Phase 1 Testing Checklist

## Pre-Merge Validation

Complete all tests before merging `chore/improvements-phase-1` to `main`.

---

## 1. Input Validation Tests

### brain_query validation
- [ ] Invalid query (empty string) → returns validation error
- [ ] Invalid limit (> 1000) → returns validation error
- [ ] Invalid type (e.g., "badtype") → returns validation error
- [ ] Valid query with no type filter → succeeds
- [ ] Valid query with type filter → returns only matching types

### brain_write validation
- [ ] Missing required field (type, label, or content) → validation error
- [ ] Label > 500 chars → validation error
- [ ] Content > 100k chars → validation error
- [ ] Importance > 1.0 → validation error
- [ ] Importance < 0.0 → validation error
- [ ] Emotional weight > 1.0 → validation error
- [ ] Emotional weight < -1.0 → validation error
- [ ] Valid call with all fields → succeeds and returns node ID

### brain_link validation
- [ ] Missing from_id, to_id, or edge_type → validation error
- [ ] from_id equals to_id → validation error
- [ ] Invalid edge_type → validation error
- [ ] Weight > 1.0 → validation error
- [ ] Valid call → succeeds and returns edge ID

### brain_supersede validation
- [ ] Missing old_node_id or new_content → validation error
- [ ] Empty new_content → validation error
- [ ] New_label > 500 chars → validation error
- [ ] Valid call → succeeds and returns new node ID

### brain_history validation
- [ ] Missing query → validation error
- [ ] since >= until → validation error
- [ ] Limit > 1000 → validation error
- [ ] Valid query → returns episodes

### brain_expand validation
- [ ] Empty node_id → validation error
- [ ] Valid node_id → returns expanded node details

### brain_review validation
- [ ] Quality < 0 → validation error
- [ ] Quality > 5 → validation error
- [ ] Valid quality (0-5) → succeeds and updates FSRS metrics

### brain_forget validation
- [ ] Empty node_id → validation error
- [ ] Valid node_id with force=false → succeeds (or refuses if edges exist)
- [ ] Valid node_id with force=true → succeeds and cascades edges

### brain_edges validation
- [ ] Empty node_id → validation error
- [ ] Valid node_id → returns incoming/outgoing edges as JSON

---

## 2. Database Backup Tests

### Backup creation
- [ ] Backup directory created automatically in `.backups/`
- [ ] Backup file created with correct naming (backup-{timestamp}.db)
- [ ] Backup metadata stored in database meta table
- [ ] Backup path returned to caller

### Backup listing
- [ ] `listBackups()` returns array of BackupInfo
- [ ] Timestamps and reasons are correct
- [ ] Backups sorted by recency

### Backup retention
- [ ] Backups older than 7 days auto-deleted
- [ ] Only 5 most recent backups retained
- [ ] Cleanup triggered on next backup creation

### Backup restore (manual test only)
- [ ] Database closed before restore
- [ ] Current DB moved to .old
- [ ] Backup restored to original path
- [ ] Database readable after restore

### Backup storage reporting
- [ ] `getBackupStorageUsage()` returns accurate byte count
- [ ] Returns 0 if no backups exist

---

## 3. Metrics Tests

### collectMetrics() basic functionality
- [ ] Returns MetricsSnapshot with all required fields
- [ ] `total_nodes` matches SELECT COUNT(*) FROM nodes
- [ ] `total_episodes` matches SELECT COUNT(*) FROM episodes
- [ ] `total_active_edges` matches SELECT COUNT(*) FROM edges WHERE valid_until IS NULL
- [ ] `embedding_coverage_percent` calculated correctly (nodes_with_embeddings / total_nodes)

### collectMetrics() aggregations
- [ ] `nodes_by_type` groups correctly (semantic, episodic, etc.)
- [ ] `edges_by_type` groups correctly
- [ ] `avg_retrievability` matches database average
- [ ] `avg_salience` matches database average
- [ ] `nodes_faded` counts nodes where retrievability < 0.05

### Neuromodulator state
- [ ] Dopamine, serotonin, acetylcholine, norepinephrine loaded from meta table
- [ ] Defaults to 0.5 if not found
- [ ] Neuro state string matches meta value

### Prometheus format export
- [ ] `formatPrometheusMetrics()` returns valid Prometheus format
- [ ] Includes HELP and TYPE lines
- [ ] All metrics have agent label
- [ ] Numbers formatted with appropriate precision
- [ ] No syntax errors in output (can be scraped by Prometheus)

### Human-readable format export
- [ ] `formatMetricsAsText()` returns readable multi-line string
- [ ] Sections organized (Nodes, Edges, Episodes, Consolidation, Resources, Neuromodulators)
- [ ] Numbers formatted for readability (percentages, decimals)
- [ ] Byte sizes formatted (B, KB, MB, GB)

### brain_stats integration
- [ ] `brain_stats` without format parameter → human-readable text
- [ ] `brain_stats format=text` → human-readable text
- [ ] `brain_stats format=prometheus` → Prometheus format
- [ ] `brain_stats format=invalid` → falls back to text (no error)

---

## 4. Resilience Utilities Tests

### retryWithBackoff()
- [ ] Succeeds on first attempt → returns immediately
- [ ] Fails once, succeeds on retry → returns result
- [ ] All attempts fail → throws error with attempt count
- [ ] Exponential backoff applied (delays increase)
- [ ] Jitter applied to avoid thundering herd

### withTimeout()
- [ ] Fast operation completes normally
- [ ] Slow operation triggers timeout
- [ ] TimeoutError thrown on timeout
- [ ] onTimeout callback called if provided

### CircuitBreaker
- [ ] Initial state is "closed"
- [ ] After recordSuccess() → state is "closed"
- [ ] After N failures → state is "open"
- [ ] When open, checkAllow() throws CircuitBreakerOpenError
- [ ] After resetTime expires → state is "half-open"
- [ ] recordSuccess() while half-open → state is "closed"

### withFallback()
- [ ] Primary succeeds → returns primary result
- [ ] Primary fails → tries fallback and returns fallback result
- [ ] onFallback callback called when fallback is used

### RateLimiter
- [ ] Tokens start at tokensPerSecond
- [ ] acquire() succeeds if token available
- [ ] acquire() waits if no tokens
- [ ] Tokens refill over time
- [ ] tryAcquire() returns false if no tokens (non-blocking)

---

## 5. Integration Tests

### Validation + Handler interaction
- [ ] Invalid args rejected before reaching handler logic
- [ ] Valid args passed to handler logic correctly typed
- [ ] Error message includes field names and constraints

### Backup + Consolidation (manual integration)
- [ ] Consolidation creates backup before starting
- [ ] Database recoverable if consolidation fails midway
- [ ] Backup path logged to stderr for debugging

### Metrics + Neuromodulator state
- [ ] Metrics reflect current neuromodulator levels
- [ ] Changes to neuro state appear in next metrics call
- [ ] Dopamine/serotonin changes detectable by alerts

---

## 6. Edge Cases & Error Handling

### Validation edge cases
- [ ] Very long strings (near 100k chars) → validated but accepted
- [ ] Numbers at boundaries (0.0, 1.0, -1.0) → accepted
- [ ] Special characters in strings → accepted if within length limits
- [ ] JSON with extra fields → ignored (not validated)
- [ ] Null/undefined fields → treated as missing

### Backup edge cases
- [ ] Disk full during backup → error thrown, non-blocking
- [ ] Backup directory doesn't exist → created automatically
- [ ] No write permissions → error thrown gracefully
- [ ] Concurrent backup calls → no race conditions (serialized by db.prepare)

### Metrics edge cases
- [ ] Empty database (0 nodes) → metrics still valid (division by zero handled)
- [ ] No backups yet → backup_storage_bytes = 0
- [ ] Missing meta entries → defaults used
- [ ] Very large metrics values → formatted without truncation

---

## 7. Performance Tests

### Validation overhead
- [ ] 1000 calls to validateBrainQuery() → completes in < 100ms
- [ ] 100 calls to validateBrainWrite() with max-length content → < 50ms

### Backup overhead
- [ ] Creating backup (1MB db) → completes in < 500ms
- [ ] Listing backups → < 10ms even with 5+ backups
- [ ] Pruning old backups → runs asynchronously, non-blocking

### Metrics collection overhead
- [ ] collectMetrics() on 10k nodes → completes in < 1s
- [ ] formatPrometheusMetrics() → < 100ms
- [ ] formatMetricsAsText() → < 100ms

---

## 8. Manual Smoke Tests

### CLI tool invocation
```bash
# Valid query
echo '{"name": "brain_query", "arguments": {"query": "test"}}' | mcp-call

# Invalid query
echo '{"name": "brain_query", "arguments": {"query": "", "limit": 2000}}' | mcp-call
# Should: Error: Invalid arguments...

# Stats as text
echo '{"name": "brain_stats", "arguments": {}}' | mcp-call
# Should: human-readable summary

# Stats as Prometheus
echo '{"name": "brain_stats", "arguments": {"format": "prometheus"}}' | mcp-call
# Should: Prometheus format with metrics
```

### Database integrity
```bash
# After various operations, verify:
sqlite3 ~/.sharpwave/brain.db "SELECT COUNT(*) FROM nodes; SELECT COUNT(*) FROM edges WHERE valid_until IS NULL;"

# Backup directory exists
ls -la ~/.sharpwave/.backups/
```

---

## 9. Regression Tests

- [ ] Existing tests in test suite still pass (if any)
- [ ] No breaking changes to tool request/response format
- [ ] Backwards compatible with existing agent databases
- [ ] No new environment variables required

---

## 10. Sign-Off Checklist

- [ ] All validation tests passing
- [ ] All backup tests passing
- [ ] All metrics tests passing
- [ ] All resilience tests passing
- [ ] All integration tests passing
- [ ] Performance acceptable (no regressions)
- [ ] Manual smoke tests successful
- [ ] Documentation complete (IMPROVEMENTS-PHASE-1.md, QUICK-REFERENCE.md)
- [ ] No console warnings or errors during normal operation
- [ ] Ready for merge to main

---

## Merge Process

1. Create PR from `chore/improvements-phase-1` to `main`
2. Complete all items in this checklist
3. Add test results as PR comment
4. Get approval from code reviewer
5. Squash and merge (or merge with commits, per preference)
6. Delete branch
7. Tag as `v0.2.0-phase1` or similar

---

**Checklist Version:** 1.0  
**Date Created:** 2026-08-21  
**Status:** Ready for testing
