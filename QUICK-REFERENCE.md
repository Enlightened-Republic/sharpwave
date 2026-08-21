# Quick Reference: Phase 1 Improvements

## Input Validation

All tool handlers now validate inputs before processing. Validation errors are detailed and field-specific.

### Example: brain_write validation

**Valid call:**
```json
{
  "type": "semantic",
  "label": "My memory",
  "content": "This is important information",
  "importance": 0.8
}
```

**Invalid call (importance > 1.0):**
```json
{
  "type": "semantic",
  "label": "My memory",
  "content": "This is important information",
  "importance": 1.5
}
```

**Response:**
```
Error: Invalid arguments:
importance: importance must be a number between 0.0 and 1.0
```

### Validation rules by tool

| Tool | Required Fields | Constraints |
|------|-----------------|-------------|
| `brain_query` | `query` | query: non-empty, type: known type, limit: 1-1000 |
| `brain_write` | `type`, `label`, `content` | label/content: 1-500/100k chars, importance: 0-1, emotional_weight: -1 to 1 |
| `brain_link` | `from_id`, `to_id`, `edge_type` | from_id ≠ to_id, edge_type: valid, weight: 0-1 |
| `brain_supersede` | `old_node_id`, `new_content` | new_content: non-empty, new_label: 1-500 chars |
| `brain_history` | `query` | since < until, limit: 1-1000 |
| `brain_expand` | `node_id` | node_id: non-empty |
| `brain_review` | `node_id`, `quality` | quality: 0-5 |
| `brain_forget` | `node_id` | node_id: non-empty, force: boolean |
| `brain_edges` | `node_id` | node_id: non-empty |

---

## Database Backups

Backups are automatic and transparent. They're stored in `.backups/` alongside your brain database.

### Manual backup creation

While not exposed as a tool, backups are created programmatically before risky operations:

```typescript
import { createBackup, listBackups, restoreBackup } from "./db-backup.js";

// Create a backup
const backupPath = createBackup("my-agent", "before-consolidation");
console.log(`Backup created at: ${backupPath}`);

// List available backups
const backups = listBackups("my-agent");
backups.forEach((b) => {
  console.log(`${new Date(b.timestamp).toISOString()} — ${b.reason}`);
});

// Restore from a backup
restoreBackup("my-agent", backupPath);
```

### Backup cleanup

- Backups older than **7 days** are automatically deleted
- Only the **5 most recent** backups per agent are kept
- Cleanup happens when a new backup is created

---

## Metrics & Monitoring

### Human-readable stats (default)

```bash
# Call brain_stats without format parameter
{
  "tool": "brain_stats"
}
```

**Output:**
```
=== Sharpwave Metrics (2026-08-21T12:34:56.789Z) ===
Agent: default

=== Nodes ===
Total: 1,234 | Faded (R<0.05): 42
Avg Retrievability: 0.567 | Avg Salience: 0.723
By Type: semantic=650, episodic=400, pattern=184
Embeddings: 1,100/1,234 (89%)

=== Edges ===
Active: 2,891
By Type: associates=1200, supports=800, before=500, causes=391

=== Episodes ===
Total: 847 | Extracted: 756

=== Consolidation ===
Last: 2026-08-21T10:15:00.000Z

=== Resources ===
DB Size: 45.2 MB
Backup Storage: 18.5 MB

=== Neuromodulators ===
Dopamine: 0.62 | Serotonin: 0.58
Acetylcholine: 0.71 | Norepinephrine: 0.49
State: engaged
```

### Prometheus metrics (for monitoring systems)

```bash
# Call brain_stats with format=prometheus
{
  "tool": "brain_stats",
  "arguments": {
    "format": "prometheus"
  }
}
```

**Output (Prometheus format):**
```
# Generated at 2026-08-21T12:34:56.789Z
# Agent: default

# HELP sharpwave_nodes_total Total number of nodes
# TYPE sharpwave_nodes_total gauge
sharpwave_nodes_total{agent="default"} 1234

# HELP sharpwave_nodes_by_type Number of nodes by type
# TYPE sharpwave_nodes_by_type gauge
sharpwave_nodes_by_type{agent="default",type="semantic"} 650
sharpwave_nodes_by_type{agent="default",type="episodic"} 400
sharpwave_nodes_by_type{agent="default",type="pattern"} 184

# HELP sharpwave_embedding_coverage_percent Embedding coverage percentage
# TYPE sharpwave_embedding_coverage_percent gauge
sharpwave_embedding_coverage_percent{agent="default"} 89

sharpwave_avg_retrievability{agent="default"} 0.5670
sharpwave_dopamine{agent="default"} 0.6200
...
```

### Setting up Prometheus scraping

Add to your `prometheus.yml`:
```yaml
scrape_configs:
  - job_name: 'sharpwave'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['localhost:3000']
```

Then periodically call `brain_stats format=prometheus` and expose the output.

### Alert thresholds

Set up alerts for:
- **Embedding coverage drops below 70%** — likely embedding queue failures
- **Faded nodes > 20% of total** — indicates stale memory not being refreshed
- **DB size > 500 MB** — consolidation may be needed
- **Avg retrievability < 0.3** — nodes are being forgotten too quickly
- **Serotonin < 0.2** — agent may be in distress state

---

## Error Handling & Resilience

Resilience utilities are used internally but can be leveraged by integrators:

### Retry with backoff

```typescript
import { retryWithBackoff } from "./resilience.js";

const result = await retryWithBackoff(
  async () => {
    return await hybridRetrieve(agentId, query, sessionId, config);
  },
  { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 5000 }
);
```

### Timeout enforcement

```typescript
import { withTimeout, TimeoutError } from "./resilience.js";

try {
  const result = await withTimeout(
    () => slowOperation(),
    2000 // 2 second timeout
  );
} catch (err) {
  if (err instanceof TimeoutError) {
    console.error("Operation took too long");
  }
}
```

### Graceful degradation

```typescript
import { withFallback } from "./resilience.js";

const results = await withFallback(
  () => vectorSearch(query),    // Try vector search first
  () => fullTextSearch(query),  // Fall back to FTS if vector fails
  (err) => console.warn(`Vector search failed, using FTS: ${err.message}`)
);
```

### Circuit breaker (prevent cascade failures)

```typescript
import { CircuitBreaker } from "./resilience.js";

const breaker = new CircuitBreaker(5, 60000); // 5 failures, 60s reset

try {
  breaker.checkAllow();
  const result = await callEmbeddingAPI();
  breaker.recordSuccess();
  return result;
} catch (err) {
  breaker.recordFailure();
  throw err;
}
```

---

## Testing Validation

Each validation function returns a `ValidationResult<T>`:

```typescript
interface ValidationResult<T> {
  ok: boolean;
  data?: T;           // Success case
  errors?: Array<{    // Failure case
    field: string;
    message: string;
  }>;
}

// Usage:
const validation = validateBrainWrite({
  type: "semantic",
  label: "Test",
  content: "Hello",
  importance: 2.0  // Invalid!
});

if (!validation.ok) {
  console.error(formatValidationErrors(validation.errors!));
  // Output: "importance: importance must be a number between 0.0 and 1.0"
} else {
  const args = validation.data!;
  // args is now typed correctly
}
```

---

## Integration Checklist for Future Phases

- [ ] **Phase 2:** Add `createBackup()` call to `consolidation.ts` before `runConsolidation()`
- [ ] **Phase 2:** Add `createBackup()` call to `nodes.ts` before `runDeepPhase()`
- [ ] **Phase 2:** Wrap embedding queue with `CircuitBreaker` and `retryWithBackoff`
- [ ] **Phase 3:** Replace hardcoded `~/.sharpwave/` paths with centralized `getDataDir()`
- [ ] **Phase 3:** Add stale embedding detection (timestamp-based invalidation)
- [ ] **Phase 3:** Implement entity-resolution hash baseline in `consolidation.ts`

---

## Troubleshooting

### "Validation error: query cannot be empty"
**Cause:** Empty or whitespace-only query string  
**Fix:** Provide a non-empty search query

### "Validation error: importance must be between 0.0 and 1.0"
**Cause:** Importance value outside [0, 1] range  
**Fix:** Clamp to 0.0–1.0, e.g., `Math.max(0, Math.min(1, value))`

### Backup directory not found
**Cause:** Disk permissions or path issues  
**Fix:** Ensure sharpwave process has write access to parent directory of `brain.db`

### Metrics show 0% embedding coverage
**Cause:** Embedding queue is stalled  
**Fix:** Check `drainEmbeddingQueue()` in `embeddings.ts` — likely API key or network issue

### Faded nodes spike suddenly
**Cause:** Consolidation didn't run recently, or forgetting is too aggressive  
**Fix:** Check `last_consolidation` timestamp; adjust `FSRS_MIN_STABILITY_THRESHOLD` in `types.ts`

---

**Last updated:** 2026-08-21  
**Version:** Phase 1  
**Status:** Ready for production integration
