### [sf-001] Capture COPY INTO load errors into an error_log table
level: medium
tags: COPY INTO, VALIDATE, error handling
asked: yes

#### Question
You load CSV files from a stage with `COPY INTO`. Bad rows must not stop the load, and every rejected row must be saved to an `error_log` table for the support team. How do you do it?

#### Answer
A commonly given answer is:
```sql
-- ❌ does not work
INSERT INTO error_log
SELECT * FROM TABLE(VALIDATE(
  LOCATION => '@my_external_stage', VALIDATION_MODE => 'RETURN_ALL_ERRORS',
  TABLE_NAME => 'my_table', FILE_FORMAT => (TYPE => 'CSV')));
```
That mixes up two different features. `VALIDATE` is a table function that inspects a **past** `COPY` execution, and its only arguments are the target table and a `JOB_ID`. `VALIDATION_MODE` and `FILE_FORMAT` are options of `COPY INTO` itself.

**Pattern 1 — load, skip bad rows, then log them (most common in production):**
```sql
COPY INTO my_table
FROM @my_external_stage/orders/
FILE_FORMAT = (FORMAT_NAME = csv_fmt)
ON_ERROR = 'CONTINUE';                 -- load good rows, skip bad ones

INSERT INTO error_log (logged_at, target_table, error, file, line, column_name, rejected_record)
SELECT CURRENT_TIMESTAMP(), 'MY_TABLE', error, file, line, column_name, rejected_record
FROM TABLE(VALIDATE(my_table, JOB_ID => '_last'));
```
`'_last'` means the last `COPY` run **in the current session**. In an orchestrated job it's safer to capture the query id (`LAST_QUERY_ID()` right after the COPY, or from the orchestrator) and pass `JOB_ID => '<query_id>'`.

**Pattern 2 — dry run before loading anything:**
```sql
COPY INTO my_table FROM @my_external_stage/orders/
FILE_FORMAT = (FORMAT_NAME = csv_fmt)
VALIDATION_MODE = 'RETURN_ERRORS';      -- loads nothing, returns errors

INSERT INTO error_log
SELECT * FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
```

**Limitations to mention:**
- `VALIDATE` and `VALIDATION_MODE` don't work with COPY statements that **transform** data (`COPY INTO t FROM (SELECT $1, $2 … FROM @stage)`). Workaround: load raw into a landing table with all-VARCHAR columns, then validate with `TRY_CAST`/`TRY_TO_NUMBER` in SQL and route failures to the error table.
- For **Snowpipe**, use `VALIDATE_PIPE_LOAD` (last 14 days) and `COPY_HISTORY`.
- `ON_ERROR` options: `ABORT_STATEMENT` (COPY default), `CONTINUE`, `SKIP_FILE` (Snowpipe default), `SKIP_FILE_<n>`, `SKIP_FILE_<n>%`.

#### What interviewers look for
Knowing VALIDATE vs VALIDATION_MODE, the `_last` session caveat, transformation limits, and a robust landing-table design.

#### Follow-up
Alert when more than 1% of rows in a file are rejected. (`COPY_HISTORY` gives `ROW_COUNT` and `ERROR_COUNT` per file; a task or Airflow check compares them.)

### [sf-002] Why didn't COPY reload my file? Load metadata explained
level: medium
tags: COPY INTO, load metadata, idempotency

#### Question
A vendor re-sent `orders_2026-11-01.csv` with corrections, same file name. You run `COPY INTO` again and it reports "0 files processed". Why? How do you reload it safely?

#### Answer
Snowflake keeps **load metadata** per table: which files (by path + ETag/checksum) were loaded, for **64 days**. COPY skips files it has already loaded. This is what makes repeated COPY runs idempotent.

Here the file name is the same; whether it's skipped depends on whether its content checksum changed — if the vendor overwrote it with identical bytes, or metadata says it's loaded, it's skipped.

Options:
```sql
-- Force reload (beware: duplicates unless you delete first)
BEGIN;
DELETE FROM orders WHERE _source_file = 'orders_2026-11-01.csv';
COPY INTO orders FROM @stage/orders_2026-11-01.csv FORCE = TRUE;
COMMIT;
```
- `FORCE = TRUE` loads regardless of metadata → **duplicates** unless you remove the previous rows. Keep `METADATA$FILENAME` in a `_source_file` column (or use `INCLUDE_METADATA`) so you can delete by file.
- `LOAD_UNCERTAIN_FILES = TRUE` — for files older than 64 days whose status Snowflake can no longer determine.
- Snowpipe keeps its own metadata for **14 days** and won't reload a file with the same name; `ALTER PIPE … REFRESH` only queues files staged in the last 7 days.
- Better design: vendors send new files with new names (versioned/timestamped), and the pipeline handles corrections via MERGE on business keys.

#### What interviewers look for
Load metadata, 64 vs 14 days, FORCE causing duplicates, and file-name lineage columns.

#### Follow-up
How would you make the whole load idempotent end-to-end? (Land raw with file name + row number, dedupe on business key, MERGE into the target.)

### [sf-003] Snowflake's architecture in three layers
level: easy
tags: architecture, fundamentals

#### Question
Explain Snowflake's architecture and why separating storage and compute matters. What runs in the cloud services layer?

#### Answer
1. **Storage layer** — tables stored in the cloud provider's object storage as immutable, compressed, columnar **micro-partitions**. You pay per TB per month. Fully managed.
2. **Compute layer** — **virtual warehouses** (MPP clusters). Each warehouse is independent: its own CPU, memory and local SSD cache. They all read the same storage.
3. **Cloud services layer** — the "brain": authentication, access control, query parsing and optimisation, **metadata** (partition min/max stats, which enables pruning), transactions, result cache, infrastructure management.

Why separation matters:
- **Workload isolation:** ELT on one warehouse, BI on another — no contention.
- **Elasticity:** resize or add clusters in seconds; suspend when idle (per-second billing, 60-second minimum each time a warehouse starts).
- **Concurrency:** multi-cluster warehouses scale out for many users.
- **Zero-copy features:** cloning, Time Travel and sharing work by pointing at the same micro-partitions.

Cloud services usage is free up to 10% of daily warehouse compute; above that it's billed (watch for very high query counts, e.g. thousands of tiny queries or heavy metadata calls).

#### What interviewers look for
Accurate role of each layer, metadata-driven pruning, and the business benefits (isolation, elasticity, cost).

#### Follow-up
What does Snowflake's "hybrid of shared-disk and shared-nothing" mean? (Shared data in central storage like shared-disk; each warehouse processes in MPP shared-nothing style with local caching.)

### [sf-004] Micro-partitions and pruning — why isn't my query pruning?
level: medium
tags: micro-partitions, pruning, performance

#### Question
A 5 TB `events` table is queried with `WHERE event_date = '2026-11-01'`. The query profile shows "Partitions scanned: 41,000 of 42,000". Why so little pruning, and what can you do?

#### Answer
**Micro-partitions** are 50–500 MB (uncompressed) immutable chunks. For each one, Snowflake stores per-column metadata: min/max, distinct count, null count. Pruning = skipping partitions whose min/max range can't match the filter.

Pruning fails when:
1. **Data isn't ordered by the filter column.** If rows for every date are spread across all partitions (e.g. loaded by `customer_id`, or many late-arriving updates), every partition's min/max date range covers 2026-11-01.
2. **The filter wraps the column in a function:** `WHERE TO_DATE(event_ts) = …` or `WHERE DATE_TRUNC('day', event_ts) = …` can prune poorly; prefer a range on the raw column: `event_ts >= '2026-11-01' AND event_ts < '2026-11-02'`.
3. **Implicit casts** (comparing a VARCHAR column to a number).
4. **Join filters** that aren't pushed down — Snowflake does join-based pruning in many cases, but filtering the fact table directly is more reliable.

Fixes, cheapest first:
- Rewrite predicates to be prunable.
- Load data in natural order (by date) — most append-only event tables are naturally clustered by ingestion time.
- Add a **clustering key** on `event_date` (see clustering problem) if the table is large, filtered heavily, and rarely updated randomly.
- **Search optimization** if the access pattern is needle-in-haystack lookups on a high-cardinality column.

Check: `SELECT SYSTEM$CLUSTERING_INFORMATION('events', '(event_date)');` → look at `average_depth` (lower is better) and overlap histogram.

#### What interviewers look for
Correct micro-partition facts, reading "partitions scanned vs total", and ordered remedies.

#### Follow-up
Why does a big `UPDATE` touching random rows hurt clustering? (Micro-partitions are immutable — updated rows are rewritten into new partitions, scattering ranges.)

### [sf-005] Choosing a clustering key
level: hard
tags: clustering, automatic clustering, cost

#### Question
When would you add a clustering key, how do you choose the columns, and what does it cost? When would you *not* do it?

#### Answer
**Add one when all are true:**
- Table is large (multi-TB; small tables don't benefit).
- Queries filter (or join) on the same columns most of the time.
- Pruning is poor today (`SYSTEM$CLUSTERING_INFORMATION` shows high average depth).
- The table isn't constantly updated randomly — reclustering churn costs money.

**Choosing columns:**
- Start with the most common filter — usually a **date**.
- Order multi-column keys **from lowest to highest cardinality** (e.g. `(event_date, region)`).
- Avoid very high-cardinality columns (timestamps, UUIDs) directly — use an expression: `CLUSTER BY (TO_DATE(event_ts))` or `(event_date, SUBSTR(customer_id, 1, 2))`.
- Keep it to 3–4 columns max.

```sql
ALTER TABLE events CLUSTER BY (event_date, region);
SELECT SYSTEM$CLUSTERING_INFORMATION('events');
-- cost tracking
SELECT * FROM SNOWFLAKE.ACCOUNT_USAGE.AUTOMATIC_CLUSTERING_HISTORY
WHERE table_name = 'EVENTS' ORDER BY start_time DESC;
```
**Cost:** Automatic Clustering runs serverless in the background, billed in credits, plus extra storage from rewritten partitions (old ones are kept for Time Travel/Fail-safe). The initial clustering of a big table can be expensive; estimate first with `SYSTEM$ESTIMATE_AUTOMATIC_CLUSTERING_COSTS` and suspend with `ALTER TABLE … SUSPEND RECLUSTER` if needed.

**Don't cluster when:** the table is small; queries filter on many different columns (consider search optimization, or materialised/dynamic tables with different sort orders); heavy random DML; or natural load order already gives good pruning.

#### What interviewers look for
Data-driven decision (measure before/after), cardinality ordering, cost awareness, alternatives.

#### Follow-up
How would you prove the clustering paid off? (Compare partitions scanned, query time and credits for the top queries before vs after, vs the clustering credits spent.)

### [sf-006] The three caches — and when the result cache is NOT used
level: medium
tags: caching, performance

#### Question
Explain Snowflake's caches. A dashboard runs the same query every 5 minutes but never hits the result cache. List the reasons.

#### Answer
| cache | where | lifetime | notes |
|---|---|---|---|
| **Result cache** | cloud services | 24 h, extended on each reuse (up to 31 days) | returns stored results; no warehouse needed |
| **Warehouse (local disk) cache** | warehouse SSD | until the warehouse suspends | caches micro-partition data read from storage; "Percentage scanned from cache" in the profile |
| **Metadata cache** | cloud services | always | answers `COUNT(*)`, `MIN/MAX` on columns, etc. without a warehouse |

The result cache is **not** used when:
- Query text differs (even whitespace/case of literals, different parameter values).
- Underlying data changed (any DML on the tables, even unrelated rows).
- The query uses non-deterministic functions: `CURRENT_TIMESTAMP()`, `RANDOM()`, `UUID_STRING()` — very common in dashboards ("last 7 days from now").
- It references external tables, or certain functions (UDFs that aren't deterministic, some system functions).
- `USE_CACHED_RESULT = FALSE` in the session.
- Role lacks privileges on the objects (each role must be authorised).
- Result older than its retention.

Fix for the dashboard: compute the date boundary as `CURRENT_DATE` truncated (deterministic within a day isn't guaranteed either — better: let the BI tool pass a fixed date literal), or serve it from a pre-aggregated table refreshed on a schedule.

Auto-suspend trade-off: a short suspend (60 s) saves credits but drops the warehouse cache; BI warehouses often use 5–10 minutes.

#### What interviewers look for
All three caches, the full list of result-cache blockers, and the auto-suspend trade-off.

#### Follow-up
Does the result cache cost anything? (No warehouse credits; just cloud services, which is usually within the free 10%.)

### [sf-007] Time Travel, Fail-safe and table types — including the dbt surprise
level: medium
tags: Time Travel, Fail-safe, transient tables, dbt

#### Question
Explain Time Travel and Fail-safe, and the difference between permanent, transient and temporary tables. Then: a teammate dropped a dbt-built table in production — "no problem, Fail-safe has it". Are they right?

#### Answer
- **Time Travel:** query or restore data as of a past time: `SELECT … AT(OFFSET => -3600)`, `BEFORE(STATEMENT => '<query_id>')`, `UNDROP TABLE`, `CREATE TABLE … CLONE … AT(…)`. Retention set by `DATA_RETENTION_TIME_IN_DAYS`: 0–1 day on Standard edition; up to **90 days** for permanent objects on Enterprise and above.
- **Fail-safe:** a further **7 days** after Time Travel ends, for permanent tables only. **Not user-accessible** — recovery is via Snowflake Support, best-effort, for disasters.

| type | Time Travel | Fail-safe | lives |
|---|---|---|---|
| permanent | 0–90 days (edition-dependent) | 7 days | until dropped |
| transient | 0–1 day | none | until dropped |
| temporary | 0–1 day | none | the session only |

**The dbt surprise:** **dbt-snowflake creates tables as *transient* by default** (`transient: true`) to save storage cost. So the dropped table has at most 1 day of Time Travel and **no Fail-safe**. If more than a day passed, it's gone — rebuild it with dbt (fine for derived models, a disaster for anything that holds history, like snapshots or incremental models fed by sources that no longer have the data).

Good practice: set `+transient: false` for incremental models, snapshots and anything not fully rebuildable; and use longer retention on critical raw/landing tables.

Storage note: Time Travel and Fail-safe both store changed/deleted micro-partitions — high-churn tables with long retention can cost more in "time travel bytes" than in active bytes (`TABLE_STORAGE_METRICS`).

#### What interviewers look for
Precise numbers, the support-only nature of Fail-safe, and the dbt transient default — a strong practical signal.

#### Follow-up
How do you restore a table to how it was before a bad `UPDATE` at 10:15? (`CREATE TABLE t_restored CLONE t BEFORE(STATEMENT => '<bad_query_id>')`, verify, then `ALTER TABLE … SWAP WITH`.)

### [sf-008] Zero-copy cloning: how it works and what to watch for
level: medium
tags: cloning, environments, CI

#### Question
How does zero-copy cloning work, what does it cost, and how would you use it for dev/test environments? Any gotchas?

#### Answer
A clone copies **metadata only** — the new object points to the same micro-partitions. No data is copied, so it's near-instant and costs nothing extra at creation. Storage is charged only for partitions that change **after** cloning (each side diverges independently).
```sql
CREATE DATABASE analytics_dev CLONE analytics_prod;
CREATE TABLE orders_backup CLONE orders AT(TIMESTAMP => '2026-11-20 09:00'::TIMESTAMP_LTZ);
CREATE SCHEMA ci_pr_1234 CLONE analytics_prod.marts;
```
Uses:
- Dev/test environments with production-like data in seconds.
- **CI for dbt:** clone prod, build only changed models into the clone (see slim CI problem).
- Backups before risky migrations; point-in-time restore combined with Time Travel.

Gotchas:
- **Grants:** a cloned *table* doesn't keep the source table's grants unless you use `COPY GRANTS`; when cloning a database/schema, child objects keep their grants but the container itself doesn't.
- **Tasks** in a cloned database/schema are **suspended** — good, otherwise your dev clone would start writing data.
- **Pipes and stages** have special rules (e.g. pipes pointing at internal stages aren't cloned) — check before relying on them.
- **PII:** a prod clone in dev exposes production data. Apply masking policies (they travel with the objects) or build a masked copy.
- Long-lived clones diverge and accumulate their own storage — schedule cleanup.
- Clones are separate objects: later changes to prod don't flow into the clone.

#### What interviewers look for
Metadata-pointer explanation, cost model, CI use, grants/tasks/PII gotchas.

#### Follow-up
How is cloning different from data sharing? (Clone = new independent object in your account; share = read-only live access for another account, no copy.)

### [sf-009] Streams: how CDC works inside Snowflake
level: medium
tags: streams, CDC, change tracking

#### Question
How does a Snowflake stream work? What are the stream types? What makes a stream "stale", and how do two different pipelines consume the same table's changes?

#### Answer
A stream is an **offset** (a bookmark in the table's version history) plus change-tracking metadata. Querying it returns rows changed since the offset, with extra columns:
- `METADATA$ACTION` — `INSERT` or `DELETE`
- `METADATA$ISUPDATE` — TRUE when the insert/delete pair represents an update
- `METADATA$ROW_ID` — stable row identifier

```sql
CREATE STREAM orders_stream ON TABLE raw.orders;   -- standard (delta) stream

MERGE INTO core.orders t
USING (SELECT * FROM orders_stream WHERE METADATA$ACTION = 'INSERT') s
ON t.order_id = s.order_id
WHEN MATCHED THEN UPDATE SET …
WHEN NOT MATCHED THEN INSERT …;     -- offset advances when this DML commits
```
Types:
- **Standard:** inserts, updates, deletes (net changes).
- **Append-only:** inserts only — cheaper, ideal for append-only raw tables.
- **Insert-only:** for external tables / some Iceberg tables.

Key behaviours:
- The offset **advances only when the stream is consumed in a DML statement that commits.** A plain `SELECT` doesn't advance it. Wrap multi-statement consumption in an explicit transaction so all statements see the same changes.
- **Net changes:** a row inserted then deleted between consumptions doesn't appear.
- **Staleness:** a stream relies on the table's Time Travel history. If it isn't consumed within the retention period, Snowflake extends retention for the stream up to `MAX_DATA_EXTENSION_TIME_IN_DAYS` (default 14 days); beyond that the stream becomes **stale** and must be recreated (with a full reload). Monitor `STALE_AFTER` in `SHOW STREAMS`.
- **Multiple consumers:** create **one stream per consumer**. If two pipelines read one stream, the first to commit advances the offset and the second misses the changes.
- `SYSTEM$STREAM_HAS_DATA('orders_stream')` — used in task `WHEN` clauses to skip empty runs.

#### What interviewers look for
Offset semantics, when the offset moves, staleness, one stream per consumer.

#### Follow-up
Stream vs dynamic table for the same job? (Streams + tasks = full control, procedural; dynamic tables = declarative, Snowflake manages refresh — see that problem.)

### [sf-010] Tasks and task graphs
level: medium
tags: tasks, scheduling, orchestration

#### Question
Design a Snowflake-native pipeline: every 5 minutes, process new rows from a stream through three dependent steps, skip runs when there's no data, and alert on failure. How do tasks work?

#### Answer
```sql
CREATE OR REPLACE TASK t_root
  WAREHOUSE = etl_wh                 -- or omit for serverless tasks
  SCHEDULE  = '5 MINUTE'
  WHEN SYSTEM$STREAM_HAS_DATA('raw_orders_stream')
AS
  CALL load_staging();

CREATE OR REPLACE TASK t_transform
  WAREHOUSE = etl_wh
  AFTER t_root
AS
  CALL build_core();

CREATE OR REPLACE TASK t_publish
  WAREHOUSE = etl_wh
  AFTER t_transform
AS
  CALL refresh_marts();

-- tasks are created SUSPENDED; resume children first, root last
ALTER TASK t_publish RESUME;
ALTER TASK t_transform RESUME;
ALTER TASK t_root RESUME;
-- or: SELECT SYSTEM$TASK_DEPENDENTS_ENABLE('t_root');
```
Points:
- **Task graph (DAG):** only the **root** has a schedule; children use `AFTER`. A task can have multiple predecessors.
- **`WHEN SYSTEM$STREAM_HAS_DATA`** is evaluated in cloud services — if false, the run is skipped and no warehouse starts.
- **Serverless vs warehouse:** serverless tasks size themselves and are billed per use — good for small frequent jobs; a shared warehouse can be cheaper for heavy batches.
- **Finalizer task** (`FINALIZE = t_root`) runs after the graph completes, success or failure — for cleanup and notifications.
- **Failure handling:** `SUSPEND_TASK_AFTER_NUM_FAILURES`, `TASK_AUTO_RETRY_ATTEMPTS`, `ERROR_INTEGRATION` to push failure notifications to SNS/Event Grid/Pub/Sub, and monitoring via `TASK_HISTORY()`.
- **Overlap:** by default a graph run won't start while the previous one is running (`ALLOW_OVERLAPPING_EXECUTION = FALSE`).
- Tasks run as the **task owner role** — design grants accordingly.

When to use Airflow instead: cross-system dependencies (APIs, files, other platforms), complex retries/branching, SLAs across tools, one place to observe everything.

#### What interviewers look for
Root-only schedule, resume order, stream-gated runs, failure notifications, and a clear "tasks vs Airflow" view.

#### Follow-up
Tasks vs dynamic tables vs Airflow for a 10-step transformation? (Often: dynamic tables or dbt for the transformations, Airflow for cross-system orchestration, tasks for small in-Snowflake jobs.)

### [sf-011] Dynamic tables vs streams + tasks vs materialized views
level: hard
tags: dynamic tables, materialized views, pipeline design

#### Question
You need a continuously updated `customer_360` table joining orders, payments and support tickets, fresh within 10 minutes. Compare dynamic tables, streams + tasks, and materialized views. Which do you pick?

#### Answer
| | Dynamic table | Streams + tasks | Materialized view |
|---|---|---|---|
| style | declarative (a SELECT) | procedural (you write MERGE logic) | declarative |
| joins / aggregations | yes | anything you code | **single table only, no joins**, limited functions |
| freshness | `TARGET_LAG` (e.g. `'10 minutes'` or `DOWNSTREAM`) | your schedule | always current (maintained in background) |
| incremental | automatic where possible (`REFRESH_MODE = AUTO/INCREMENTAL/FULL`) | you implement it | automatic |
| compute | your warehouse | warehouse or serverless | serverless |
| control | less (can't DML into it) | total | little |

```sql
CREATE OR REPLACE DYNAMIC TABLE customer_360
  TARGET_LAG = '10 minutes'
  WAREHOUSE  = transform_wh
  REFRESH_MODE = AUTO
AS
SELECT c.customer_id, c.name,
       COUNT(DISTINCT o.order_id) AS orders,
       SUM(p.amount)              AS paid,
       COUNT(DISTINCT t.ticket_id) AS tickets
FROM customers c
LEFT JOIN orders   o ON o.customer_id = c.customer_id
LEFT JOIN payments p ON p.order_id    = o.order_id
LEFT JOIN tickets  t ON t.customer_id = c.customer_id
GROUP BY 1, 2;
```
(Note the fan-out risk in this exact query — payments and tickets both multiply rows; pre-aggregate each child in its own dynamic table first.)

**My choice here: dynamic tables** — joins + aggregation, a freshness SLA, minimal code, built-in lineage and refresh history. Chain them (`TARGET_LAG = DOWNSTREAM` for intermediate tables).

Watch-outs for dynamic tables:
- Some constructs force **full refresh** (non-deterministic functions, certain window/outer-join patterns) — check `REFRESH_MODE` and `refresh_mode_reason` after creating.
- Base tables need change tracking (enabled automatically if you own them).
- `CREATE OR REPLACE` on an upstream base table breaks incremental refresh (new object) — use `INSERT OVERWRITE` or MERGE upstream.
- Cost is driven by the target lag: 1 minute lag on a large join can burn a warehouse continuously.

Pick **streams + tasks** for complex procedural logic (SCD2 with custom rules, deletes propagation, calling external functions), and **materialized views** for simple single-table aggregates/projections that need to be always current, e.g. a re-clustered projection of a huge table.

dbt supports `materialized='dynamic_table'` on Snowflake.

#### What interviewers look for
Accurate MV limits, TARGET_LAG/refresh mode knowledge, cost thinking, and catching the fan-out.

#### Follow-up
How do you monitor dynamic table freshness? (`DYNAMIC_TABLE_REFRESH_HISTORY`, lag metrics in Snowsight, alert if actual lag exceeds target.)

### [sf-012] COPY vs Snowpipe vs Snowpipe Streaming
level: medium
tags: ingestion, Snowpipe, streaming

#### Question
Files land in S3 continuously, and a Kafka topic produces events. Which ingestion method for each? Explain the costs and file-size guidance.

#### Answer
| | COPY INTO (batch) | Snowpipe | Snowpipe Streaming |
|---|---|---|---|
| unit | files | files | rows (no files) |
| trigger | you/orchestrator | cloud event notification (auto-ingest) or REST | client SDK / Kafka connector |
| latency | minutes–hours | ~1 minute typical | seconds |
| compute | your warehouse | serverless | serverless |
| load metadata | 64 days | 14 days | n/a (offset tokens) |

- **S3 files continuously → Snowpipe** with `AUTO_INGEST = TRUE` (S3 event → SQS → pipe). No warehouse to manage.
- **Kafka → Snowpipe Streaming** (Kafka connector in streaming mode), landing rows directly with low latency. Exactly-once is handled via channels and offset tokens.
- **Large daily/hourly batches → COPY** on a warehouse you size for the job.

File sizing (for COPY and Snowpipe): aim for roughly **100–250 MB compressed** per file. Thousands of tiny files add per-file overhead (ingestion cost and latency) and slow listing; a single 50 GB file can't be parallelised well — split it.

Other points: Snowpipe has no guaranteed order across files; dedupe downstream. Pipes can be paused (`ALTER PIPE … SET PIPE_EXECUTION_PAUSED = TRUE`) for maintenance. Monitor with `COPY_HISTORY`, `PIPE_USAGE_HISTORY`, `SYSTEM$PIPE_STATUS`.

Also worth knowing: **Openflow** (Snowflake's managed integration service based on Apache NiFi) for connector-based ingestion from databases and SaaS sources.

#### What interviewers look for
Matching the method to latency and format, file sizing, and monitoring.

#### Follow-up
How do you handle schema changes in Snowpipe loads? (Land as VARIANT or with `MATCH_BY_COLUMN_NAME`; table schema evolution with `ENABLE_SCHEMA_EVOLUTION = TRUE`.)

### [sf-013] Warehouse sizing: scale up or scale out?
level: medium
tags: warehouses, multi-cluster, concurrency

#### Question
Two complaints: (1) the nightly transformation job is slow; (2) at 9 am, BI dashboards are slow because queries queue. What do you do for each?

#### Answer
- **Scale UP (bigger size) for complex/large queries** — more CPU, memory and local disk per query. Each size up doubles credits per hour and *roughly* halves run time for well-parallelised queries, so cost can stay similar while time drops. Clear signal: **spilling** to local/remote storage in the query profile.
- **Scale OUT (multi-cluster) for concurrency** — more clusters of the same size when many queries run at once. Signal: **queued time** (`QUEUED_OVERLOAD_TIME` in query history). Requires Enterprise edition.

So: (1) nightly job → bigger warehouse for that job (or split into parallel steps); (2) BI → multi-cluster warehouse:
```sql
ALTER WAREHOUSE bi_wh SET
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 4
  SCALING_POLICY    = 'STANDARD'   -- start clusters quickly; 'ECONOMY' waits for sustained load
  AUTO_SUSPEND      = 300
  AUTO_RESUME       = TRUE;
```
More levers:
- **Separate warehouses per workload** (ELT, BI, data science, ad hoc) for isolation and cost attribution.
- `STATEMENT_TIMEOUT_IN_SECONDS` and `STATEMENT_QUEUED_TIMEOUT_IN_SECONDS` as guard rails.
- `MAX_CONCURRENCY_LEVEL` controls how many queries a cluster runs at once.
- **Snowpark-optimized** warehouses for memory-heavy Python/ML work.
- **Query Acceleration Service** for occasional scan-heavy outliers rather than upsizing for everyone.
- Billing: per second with a **60-second minimum** each time a warehouse resumes — very frequent suspend/resume of tiny jobs wastes credits.

#### What interviewers look for
Correct diagnosis signals (spill vs queue), multi-cluster settings, workload isolation.

#### Follow-up
How would you right-size every warehouse in the account? (Query history: execution time, spill, queue, utilisation per warehouse; try one size down/up and compare cost × time.)

### [sf-014] Diagnose a slow query with the Query Profile
level: hard
tags: performance, query profile, tuning

#### Question
A query that used to take 2 minutes now takes 40. Walk through how you'd diagnose it in Snowflake and the most common root causes with fixes.

#### Answer
**Step 1 — Is it the query or the environment?** Query history: compare `QUEUED_OVERLOAD_TIME`, `QUEUED_PROVISIONING_TIME`, `COMPILATION_TIME`, `EXECUTION_TIME`, warehouse size, and bytes scanned vs the fast runs. Queuing = concurrency problem, not query problem.

**Step 2 — Query Profile.** Look at "Most expensive nodes" and the statistics panel:

| symptom in profile | likely cause | fix |
|---|---|---|
| Partitions scanned ≈ total | no pruning | prunable predicates, clustering, filter earlier |
| Bytes spilled to local/remote storage | not enough memory | bigger warehouse, reduce data earlier, avoid huge sorts/`DISTINCT` |
| Join output rows ≫ input rows | **exploding join** (duplicate keys, missing join condition) | fix join keys, dedupe, check grain |
| Big "Aggregate" or "Sort" | huge GROUP BY / ORDER BY | pre-aggregate, remove unnecessary ORDER BY |
| Large "TableScan" of a view repeated | complex view used multiple times | materialise intermediate results |
| `UNION` instead of `UNION ALL` | unnecessary dedup sort | use `UNION ALL` |
| High remote disk I/O, low cache % | cold warehouse cache | expected after resume; consider auto-suspend settings |

**Step 3 — What changed?** Data volume growth, a new join, stats of skew (one key with millions of rows), a view definition change, clustering degraded after a backfill, warehouse resized, a changed dbt model.

**Common rewrites:** filter before joining; select only needed columns (columnar storage — `SELECT *` reads everything); replace correlated logic with window functions; `QUALIFY` instead of self-joins; avoid functions on join keys; break mega-queries into staged temp tables.

Tooling: `GET_QUERY_OPERATOR_STATS(<query_id>)` returns profile stats as rows — useful to automate regression checks.

#### What interviewers look for
A structured method (environment → profile → change), reading spill/pruning/explosion correctly.

#### Follow-up
How would you catch performance regressions before production? (Run key queries in CI against a clone, compare `bytes_scanned`/time, alert on >X% increase.)

### [sf-015] Controlling and attributing Snowflake cost
level: medium
tags: cost management, resource monitors, FinOps

#### Question
Finance asks: "What does each team spend on Snowflake, and how do we stop surprise bills?" Design the cost controls.

#### Answer
**Visibility (attribution):**
- Separate warehouses per team/workload → `WAREHOUSE_METERING_HISTORY` gives credits per warehouse.
- Shared warehouses → `QUERY_TAG` set per job/team (`ALTER SESSION SET QUERY_TAG = 'team=finance;job=daily_pnl'`, dbt `query_tag` config) and **`QUERY_ATTRIBUTION_HISTORY`** for per-query compute cost.
- Object **tags** (`cost_center`) on warehouses/databases for chargeback reports.
- Don't forget non-warehouse costs: storage (`TABLE_STORAGE_METRICS`), serverless features (Snowpipe, clustering, search optimization, tasks, dynamic tables), cloud services above 10%, data transfer, AI functions. `METERING_DAILY_HISTORY` covers them.

**Controls:**
- **Resource monitors** on warehouses: credit quota per day/month with `NOTIFY` at 75%, `SUSPEND` at 100%, `SUSPEND_IMMEDIATE` at 110%. Limitation: they only cover **warehouse** credits, not serverless features.
- **Budgets** cover serverless features and custom groups of objects with alerts.
- Auto-suspend on every warehouse (60–300 s), auto-resume on.
- `STATEMENT_TIMEOUT_IN_SECONDS` per warehouse to kill runaway queries.
- Restrict who can create or resize warehouses (only via Terraform/platform team).
```sql
CREATE RESOURCE MONITOR finance_rm WITH CREDIT_QUOTA = 500
  FREQUENCY = MONTHLY START_TIMESTAMP = IMMEDIATELY
  TRIGGERS ON 75 PERCENT DO NOTIFY
           ON 100 PERCENT DO SUSPEND
           ON 110 PERCENT DO SUSPEND_IMMEDIATE;
ALTER WAREHOUSE finance_wh SET RESOURCE_MONITOR = finance_rm;
```
**Culture:** a weekly cost report by team, top 20 most expensive queries with owners, and a cost check in code review for new dbt models.

#### What interviewers look for
Attribution and control as separate topics, knowing resource monitors don't cover serverless, query tags.

#### Follow-up
Top 10 most expensive queries last week, with user and warehouse — write the query on `QUERY_ATTRIBUTION_HISTORY` joined to `QUERY_HISTORY`.

### [sf-016] Search Optimization vs clustering vs Query Acceleration
level: hard
tags: search optimization, QAS, performance features

#### Question
Three workloads: (a) support agents look up a single customer by email in a 3 billion-row table; (b) analysts filter by date range on the same table; (c) a few ad-hoc queries occasionally scan huge amounts of data. Which feature for each?

#### Answer
- **(a) Search Optimization Service (SOS)** — builds a persistent search access path for **highly selective point lookups**: equality / `IN` on high-cardinality columns, substring and regex (`LIKE '%x%'`), fields inside VARIANT, geospatial. Clustering can't help a needle-in-a-haystack email lookup.
```sql
ALTER TABLE customers_events ADD SEARCH OPTIMIZATION ON EQUALITY(email), SUBSTRING(email);
SELECT SYSTEM$ESTIMATE_SEARCH_OPTIMIZATION_COSTS('customers_events', 'EQUALITY(email)');
```
- **(b) Clustering key** on the date — range filters on a low/medium-cardinality column, many rows returned.
- **(c) Query Acceleration Service (QAS)** — offloads portions of eligible large scans/filters to shared serverless compute, so an outlier query doesn't force you to upsize the whole warehouse.
```sql
ALTER WAREHOUSE adhoc_wh SET ENABLE_QUERY_ACCELERATION = TRUE
                            QUERY_ACCELERATION_MAX_SCALE_FACTOR = 8;
SELECT SYSTEM$ESTIMATE_QUERY_ACCELERATION('<query_id>');
```
Costs: SOS = serverless build/maintenance credits + extra storage (more on high-churn tables); clustering = serverless reclustering; QAS = serverless credits per accelerated query. All are Enterprise-edition features.

Rule of thumb: **SOS for "find these few rows", clustering for "scan this slice", QAS for "occasional huge scan", bigger warehouse for "complex compute/spill".**

#### What interviewers look for
Matching access pattern to feature, and cost awareness.

#### Follow-up
How do you check if a query actually used search optimization? (Query profile shows "Search Optimization Access" and partitions pruned by it.)

### [sf-017] Querying nested JSON with VARIANT and FLATTEN
level: medium
tags: semi-structured, VARIANT, FLATTEN

#### Question
`raw_orders(payload VARIANT)` holds JSON like:
`{"order_id": 7, "customer": {"id": 42, "tier": "gold"}, "items": [{"sku": "A1", "qty": 2}, {"sku": "B9", "qty": 1}]}`
Produce one row per item with order_id, customer id, sku and qty. Orders with an empty `items` array must still appear.

#### Answer
```sql
SELECT
  r.payload:order_id::NUMBER          AS order_id,
  r.payload:customer.id::NUMBER       AS customer_id,
  r.payload:customer.tier::STRING     AS tier,
  i.value:sku::STRING                 AS sku,
  i.value:qty::NUMBER                 AS qty,
  i.index                             AS item_position
FROM raw_orders r,
     LATERAL FLATTEN(INPUT => r.payload:items, OUTER => TRUE) i;
```
Key points:
- `:` navigates JSON, `.` goes deeper, `[0]` indexes arrays; **always cast** (`::STRING`) — otherwise you get VARIANT values with quotes.
- JSON keys are **case-sensitive**.
- `FLATTEN` returns `SEQ, KEY, PATH, INDEX, VALUE, THIS`. `OUTER => TRUE` keeps rows whose array is empty/missing (like a LEFT JOIN) — the requirement here.
- Nested arrays: chain FLATTENs (`… , LATERAL FLATTEN(i.value:discounts) d`). `RECURSIVE => TRUE` walks every level (useful for exploring unknown schemas).
- Missing key → NULL; JSON `null` → VARIANT null (`IS_NULL_VALUE()` distinguishes them).
- Performance: Snowflake extracts common JSON paths into columnar sub-columns automatically, so frequently used fields prune and scan efficiently. For heavily queried fields, still materialise typed columns in a staging model.
- Loading: `STRIP_OUTER_ARRAY = TRUE` when a file contains one big JSON array.

#### What interviewers look for
Correct path syntax, casting, `OUTER => TRUE`, and the staging-model recommendation.

#### Follow-up
Build JSON back from rows: `OBJECT_CONSTRUCT('sku', sku, 'qty', qty)` and `ARRAY_AGG(...) WITHIN GROUP (ORDER BY …)`.

### [sf-018] Masking policies, row access policies and tag-based masking
level: medium
tags: governance, security, PII

#### Question
HR data: everyone may query `employees`, but only HR sees full salaries and national IDs; managers see only their own region's rows. How do you implement this in Snowflake without creating separate views per role?

#### Answer
**Column masking (dynamic data masking):**
```sql
CREATE MASKING POLICY pii_mask AS (val STRING) RETURNS STRING ->
  CASE WHEN IS_ROLE_IN_SESSION('HR_PII_READER') THEN val
       ELSE '***MASKED***' END;

ALTER TABLE employees MODIFY COLUMN national_id SET MASKING POLICY pii_mask;
```
**Row-level security (row access policy) with a mapping table:**
```sql
CREATE ROW ACCESS POLICY region_rap AS (region STRING) RETURNS BOOLEAN ->
  IS_ROLE_IN_SESSION('HR_ADMIN')
  OR EXISTS (SELECT 1 FROM security.region_access m
             WHERE m.role_name = CURRENT_ROLE() AND m.region = region);

ALTER TABLE employees ADD ROW ACCESS POLICY region_rap ON (region);
```
**Tag-based masking — scales to hundreds of tables:**
```sql
CREATE TAG governance.pii_type ALLOWED_VALUES 'national_id','email','phone';
ALTER TAG governance.pii_type SET MASKING POLICY pii_mask;
ALTER TABLE employees MODIFY COLUMN national_id SET TAG governance.pii_type = 'national_id';
-- any column with this tag is masked automatically
```
Design points:
- Use `IS_ROLE_IN_SESSION()` rather than `CURRENT_ROLE() = …` so role hierarchy and secondary roles work.
- Policies are applied at query time, wherever the column is used (views, clones, shares) — one place to govern.
- Policy mapping tables should be owned by a security role and kept small/fast.
- Automatic **data classification** can suggest PII tags.
- Audit with `ACCESS_HISTORY` (who read which columns) and `POLICY_REFERENCES`.
- These features require **Enterprise edition** or higher.
- Masking can break joins on masked columns — tokenise deterministically (e.g. `SHA2(val)`) if analysts must join on PII.

#### What interviewers look for
Both policy types, tag-based scaling, `IS_ROLE_IN_SESSION`, auditing.

#### Follow-up
How do you let analysts count distinct customers by email without seeing emails? (Mask to a deterministic hash.)

### [sf-019] Designing roles (RBAC) for a data platform
level: hard
tags: RBAC, security, roles

#### Question
Design the role model for a Snowflake account with raw, staging and mart layers, used by data engineers, analysts, a BI tool and dbt service accounts, across dev and prod.

#### Answer
**Principles:** least privilege; grant privileges to roles, roles to users; never to users directly; separate **access roles** (what objects) from **functional roles** (who you are).

```
System roles:   ORGADMIN · ACCOUNTADMIN (break-glass, MFA, ≤3 people)
                SECURITYADMIN (grants) · USERADMIN (users/roles) · SYSADMIN (object owner tree)

Access roles (often database roles):
  PROD_RAW_R, PROD_RAW_RW, PROD_MARTS_R, PROD_MARTS_RW, DEV_ALL_RW …

Functional roles (granted to users/service accounts):
  DATA_ENGINEER   → PROD_RAW_R, PROD_MARTS_R, DEV_ALL_RW
  ANALYST         → PROD_MARTS_R
  BI_SERVICE      → PROD_MARTS_R
  DBT_PROD        → PROD_RAW_R, PROD_MARTS_RW  (owns mart objects)
  LOADER          → PROD_RAW_RW

All custom roles roll up to SYSADMIN so admins can manage objects.
```
Key mechanisms:
- **Future grants** so new tables are readable automatically:
  `GRANT SELECT ON FUTURE TABLES IN SCHEMA prod.marts TO ROLE prod_marts_r;`
- **Managed access schemas** — only the schema owner (or a role with MANAGE GRANTS) can grant on objects, preventing object owners from sharing ad hoc.
- **Database roles** — access roles scoped inside a database; they travel with clones/replication and can be shared.
- Warehouses: separate `USAGE` grants per functional role.
- Service users: key-pair or OAuth authentication, `TYPE = SERVICE`, no passwords; network policies.
- Ownership: the dbt prod role owns objects it creates; use `COPY GRANTS` / dbt `grants` config to keep grants stable across rebuilds.
- Everything defined as code (Terraform or a permissions tool) and reviewed.

#### What interviewers look for
Access vs functional roles, future grants, managed access, service-account security, IaC.

#### Follow-up
A user has role A and B. How can they query objects from both in one query? (Secondary roles: `USE SECONDARY ROLES ALL`.)

### [sf-020] Secure Data Sharing
level: medium
tags: data sharing, collaboration

#### Question
A partner company wants daily access to a subset of your sales data. They also use Snowflake, but in a different cloud region. Another partner doesn't use Snowflake at all. How do you share with both?

#### Answer
**How sharing works:** a *share* grants another account read-only access to your objects. **No data is copied** — the consumer queries your micro-partitions live, using *their* compute. Updates are visible immediately.
```sql
CREATE SHARE partner_sales;
GRANT USAGE ON DATABASE sales TO SHARE partner_sales;
GRANT USAGE ON SCHEMA sales.shared TO SHARE partner_sales;
GRANT SELECT ON VIEW sales.shared.v_partner_sales TO SHARE partner_sales;  -- must be a SECURE view
ALTER SHARE partner_sales ADD ACCOUNTS = partnerorg.partneraccount;
-- consumer: CREATE DATABASE partner_data FROM SHARE provider_acct.partner_sales;
```
- Share **secure views** (definition hidden, optimiser won't leak data) that filter to the partner's rows — e.g. using `CURRENT_ACCOUNT()` with a mapping table for multi-tenant shares.
- **Different region/cloud:** direct shares work within a region. Across regions, replicate the database to an account in the partner's region, or publish a **listing** (private or Marketplace) with cross-cloud auto-fulfilment, which handles replication.
- **Non-Snowflake partner:** a **reader account** — a Snowflake account you create and manage for them; *you* pay their compute. Control it with a resource monitor.
- Governance: masking/row policies apply; consumers can't re-share; track usage with listing analytics.
- Other options: data clean rooms when neither party should see raw rows; or unload files if they need extracts.

#### What interviewers look for
No-copy architecture, secure views, region limits, reader accounts and who pays.

#### Follow-up
How would you version a share so you can change table structures without breaking partners? (Share stable views as a contract; add `v2` views; deprecate with notice.)

### [sf-021] MERGE fails with "Duplicate row detected"
level: medium
tags: MERGE, data quality, determinism

#### Question
A MERGE into `customers` fails with "Duplicate row detected during DML action". What happened, and why is it dangerous to just switch the error off?

#### Answer
The **source** has more than one row for the same join key, so one target row matches several source rows. Which source row should win is undefined → Snowflake raises an error because `ERROR_ON_NONDETERMINISTIC_MERGE` is TRUE by default (same idea for UPDATE with joins: `ERROR_ON_NONDETERMINISTIC_UPDATE`).

Setting it to FALSE makes Snowflake pick an arbitrary row — results can differ between runs: a silent data-quality bug.

Fix: **deduplicate the source to the merge key with a deterministic rule.**
```sql
MERGE INTO customers t
USING (
  SELECT *
  FROM stg_customers
  QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id
                             ORDER BY updated_at DESC, _loaded_at DESC) = 1
) s
ON t.customer_id = s.customer_id
WHEN MATCHED AND s.updated_at > t.updated_at THEN UPDATE SET …   -- ignore older updates
WHEN NOT MATCHED THEN INSERT …;
```
Also: `WHEN MATCHED AND s.updated_at > t.updated_at` protects against **out-of-order** batches overwriting newer data. And handle deletes with `WHEN MATCHED AND s.is_deleted THEN DELETE`.

#### What interviewers look for
Root cause, refusing to disable the check, deterministic dedup and ordering guards.

#### Follow-up
In dbt with `incremental_strategy='merge'`, where do you put this dedup? (In the model's SELECT, ideally with `QUALIFY` on the incremental slice.)

### [sf-022] Transactions, DDL and idempotent loads
level: medium
tags: transactions, idempotency, ELT patterns

#### Question
A load job runs: `DELETE` today's rows, `CREATE TABLE tmp …`, `INSERT` new rows. It sometimes fails halfway and leaves the table empty. Why, and how do you make it safe?

#### Answer
In Snowflake **DDL statements (`CREATE`, `ALTER`, `DROP`…) commit implicitly** — they end the current transaction. So `BEGIN; DELETE …; CREATE TABLE …` commits the DELETE immediately; if the INSERT then fails, the deleted data is gone.

Safe patterns:
```sql
-- 1. Keep DDL outside the transaction
CREATE OR REPLACE TEMPORARY TABLE tmp_orders AS SELECT … ;   -- before BEGIN
BEGIN;
  DELETE FROM orders WHERE order_date = '2026-11-21';
  INSERT INTO orders SELECT * FROM tmp_orders;
COMMIT;

-- 2. Single atomic statement
MERGE INTO orders …;                       -- one statement = atomic
INSERT OVERWRITE INTO daily_summary SELECT …; -- replace contents atomically

-- 3. Build-and-swap
CREATE OR REPLACE TABLE orders_new AS SELECT …;
ALTER TABLE orders SWAP WITH orders_new;    -- atomic metadata swap
```
**Idempotency** — running the job twice for the same date gives the same result:
- Delete + insert scoped to the batch (date/partition), or MERGE on business keys.
- Parameterise by logical date (from the orchestrator), never "now".
- Record the batch id/run id in the rows.

Other facts: autocommit is on by default (each statement is its own transaction); a failed statement inside an explicit transaction doesn't automatically roll back the transaction; stored procedures can control transactions; Snowflake isolation is READ COMMITTED for tables.

#### What interviewers look for
Implicit DDL commit, atomic alternatives, and idempotency defined clearly.

#### Follow-up
How do you backfill 90 days safely with this pattern? (Loop over dates, each one idempotent; or `INSERT OVERWRITE` per partition range; run in parallel with limits.)

### [sf-023] ACCOUNT_USAGE vs INFORMATION_SCHEMA
level: easy
tags: metadata, monitoring

#### Question
You need query history for a monitoring dashboard. Should you use `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` or `INFORMATION_SCHEMA.QUERY_HISTORY()`? What's the difference?

#### Answer
| | `SNOWFLAKE.ACCOUNT_USAGE` | `INFORMATION_SCHEMA` |
|---|---|---|
| scope | whole account | one database (plus table functions with limited scope) |
| latency | delayed — roughly 45 minutes to 3 hours depending on view | near real-time |
| retention | 365 days | short — e.g. 7 days of query history, 14 days of load/copy history |
| dropped objects | included (with `DELETED` timestamps) | not included |
| access | needs `IMPORTED PRIVILEGES` on the SNOWFLAKE db (or specific database roles) | your role's visible objects |

For a **monitoring dashboard with trends** → ACCOUNT_USAGE (long history, account-wide). For **real-time alerting** ("is the job running now?", "did the last COPY fail?") → INFORMATION_SCHEMA table functions (`QUERY_HISTORY()`, `COPY_HISTORY()`, `TASK_HISTORY()`).

Also: `ORGANIZATION_USAGE` for multi-account orgs; `READER_ACCOUNT_USAGE` for reader accounts.

#### What interviewers look for
Latency vs retention trade-off and choosing per use case.

#### Follow-up
Build a daily snapshot of ACCOUNT_USAGE into your own tables — why? (Keep beyond 365 days, join with your own metadata, avoid repeated heavy scans.)

### [sf-024] Replication, failover and disaster recovery
level: hard
tags: replication, DR, business continuity

#### Question
The business needs the analytics platform back within 1 hour if a cloud region fails, losing at most 15 minutes of data. Design it in Snowflake.

#### Answer
Requirements: **RTO 1 h, RPO 15 min.**

- **Secondary account** in another region (or cloud), same organisation.
- **Failover group** containing databases *and* account objects — users, roles, grants, warehouses, resource monitors, integrations, network policies — so the secondary is usable without manual rebuild:
```sql
CREATE FAILOVER GROUP prod_fg
  OBJECT_TYPES = DATABASES, USERS, ROLES, WAREHOUSES, INTEGRATIONS, NETWORK POLICIES
  ALLOWED_DATABASES = raw, analytics
  ALLOWED_ACCOUNTS = myorg.prod_dr
  REPLICATION_SCHEDULE = '10 MINUTE';          -- inside the 15-min RPO
-- in the DR account:
CREATE FAILOVER GROUP prod_fg AS REPLICA OF myorg.prod_primary.prod_fg;
-- during an outage, in DR:
ALTER FAILOVER GROUP prod_fg PRIMARY;
```
- **Client Redirect** (connection object) so BI tools and apps use one URL that you repoint to the DR account — no reconfiguring clients.
- Failover groups and client redirect require **Business Critical** edition (replication alone is available more broadly).

Beyond Snowflake — the parts people forget:
- **Pipelines:** Airflow, dbt jobs, Snowpipe/stages and cloud storage notifications must also run in the DR region (or be repointable). Replicated pipes/stages need DR-side storage.
- **Data sources:** if ingestion depends on the failed region, the DR side may have nothing new to load.
- **Runbook + quarterly DR drills**; measure actual RTO/RPO.
- **Cost:** replication transfer + compute + secondary storage — replicate only what the business needs within the RTO (raw history can often be rebuilt later).

Time Travel/Fail-safe is **not** DR — it protects against mistakes, not region loss.

#### What interviewers look for
RTO/RPO framing, failover groups with account objects, client redirect, edition, and non-Snowflake components.

#### Follow-up
How do you fail back after the primary recovers? (Replicate changes made in DR back to the original region, then promote again.)

### [sf-025] External tables vs Iceberg tables vs native tables
level: hard
tags: Iceberg, lakehouse, external tables

#### Question
Your company stores large datasets in S3 used by Spark, and wants Snowflake to query them. Compare external tables, Apache Iceberg tables and native tables. What would you recommend?

#### Answer
| | Native table | External table | Iceberg table |
|---|---|---|---|
| data location | Snowflake-managed storage | your bucket (Parquet/CSV/JSON…) | your bucket (Parquet + Iceberg metadata) |
| writes from Snowflake | full DML | read-only | full DML when Snowflake is the catalog |
| performance | best (micro-partition metadata) | slower (limited metadata, file listing) | close to native for most queries |
| open to other engines | no (unless shared/exported) | yes (files) | **yes — Spark, Trino, Flink… via the Iceberg catalog** |
| features (Time Travel, clustering…) | all | few | most |

**Iceberg catalog options:**
- **Snowflake-managed (Snowflake is the catalog):** Snowflake writes; other engines read through Snowflake's Iceberg REST catalog interface.
- **Externally managed:** catalog is AWS Glue, Snowflake Open Catalog (managed Apache Polaris), or another REST catalog; Snowflake reads (and, with catalog-linked databases, can write) via a catalog integration.
Storage is configured with an **external volume**.

Recommendation: for data shared with Spark, use **Iceberg tables** — one copy of data, open format, multiple engines. Decide which system is the **writer/owner** of each table (single-writer per table avoids conflicts). Keep native tables for Snowflake-only marts where you want every feature and maximum performance. External tables are now mostly a legacy option for querying raw files in place.

Watch-outs: small-file problems and compaction from other writers, catalog permissions across engines, cost of cloud storage requests, and egress if engines are in different regions.

#### What interviewers look for
Clear comparison, understanding catalogs and single-writer ownership, pragmatic recommendation.

#### Follow-up
How would you migrate a native table to Iceberg with minimal downtime? (`CREATE ICEBERG TABLE … AS SELECT`, dual-write or cut over during a quiet window, repoint views.)

### [sf-026] Snowpark, UDFs and stored procedures
level: medium
tags: Snowpark, Python, UDF

#### Question
What is Snowpark? When would you use a Python UDF, a vectorized UDF, a UDTF, or a stored procedure? How does Snowpark differ from pulling data into pandas?

#### Answer
**Snowpark** = DataFrame APIs (Python, Java, Scala) that build SQL lazily and **push execution down into Snowflake** warehouses. Data never leaves Snowflake; you get Python ergonomics with Snowflake scale and governance.
```python
from snowflake.snowpark import Session
from snowflake.snowpark.functions import col, sum as sum_

df = (session.table("orders")
        .filter(col("status") == "SHIPPED")
        .group_by("customer_id")
        .agg(sum_("amount").alias("revenue")))
df.write.save_as_table("customer_revenue", mode="overwrite")   # runs as SQL in Snowflake
```
vs pandas: `session.table("orders").to_pandas()` pulls everything to the client — fine for small results, terrible for 500 M rows.

| object | use when |
|---|---|
| scalar **UDF** | row-by-row logic not expressible in SQL (custom parsing, a Python library) |
| **vectorized UDF** | same, but processes pandas batches — much faster for numeric/ML scoring |
| **UDTF** | one input row → many output rows, or per-partition logic (e.g. sessionise per user with state) |
| **stored procedure** | control flow: loops, DDL, calling multiple SQL statements, admin automation |

Notes: third-party packages come from the Snowflake Anaconda channel (or an artifact repository / stage imports); memory-heavy work → Snowpark-optimized warehouses; prefer plain SQL when possible — the optimiser can't see inside UDFs.

Beyond that: **Snowpark Container Services** run containers (APIs, models, apps) next to the data.

#### What interviewers look for
Pushdown concept, choosing UDF types correctly, and "SQL first".

#### Follow-up
How do you unit-test Snowpark code? (Local testing framework / mock session for DataFrame logic; integration tests against a dev schema.)

### [sf-027] GDPR "right to be forgotten" in Snowflake
level: hard
tags: GDPR, privacy, Time Travel, architecture

#### Question
A customer requests deletion of all their personal data. You run `DELETE` in every table. Is the data actually gone? Design a compliant approach.

#### Answer
Not immediately. Deleted rows remain:
- in **Time Travel** (up to the table's retention, up to 90 days),
- then in **Fail-safe** (7 days for permanent tables),
- in **clones** created earlier (they reference old micro-partitions),
- in **replicas**, **shares**/consumer copies, unloaded files, BI extracts, and backups outside Snowflake.

Compliant design:
1. **Isolate PII.** Keep personal attributes in a small set of PII tables keyed by a surrogate `person_key`; facts reference only the key. Deletion then touches few tables.
2. **Short retention on PII tables:** `DATA_RETENTION_TIME_IN_DAYS = 1` (or 0) and transient where acceptable, so Time Travel doesn't keep data long. Document the total maximum persistence (retention + Fail-safe) in your privacy notice/DPA — regulators generally accept a defined, short backup window.
3. **Crypto-shredding / tokenisation:** store PII encrypted or tokenised with a per-person key held outside; deleting the key makes all copies unreadable immediately, including history.
4. **Deletion pipeline:** a request table → an automated job deletes/anonymises across all registered PII tables (driven by tags/classification), logs evidence, and propagates to downstream systems.
5. **Inventory:** tags + `ACCESS_HISTORY`/lineage to find every place the data flows, including clones and replicas.
6. Anonymise instead of delete where analytics must keep aggregates (remove the identifying link, keep the anonymous facts).

#### What interviewers look for
Knowing deleted ≠ gone, and a design answer (isolation, retention, crypto-shredding, automation, inventory).

#### Follow-up
How would you prove to an auditor that a deletion was completed? (Deletion log with request id, tables touched, row counts, timestamps; queries showing zero rows; retention configuration evidence.)

### [sf-028] Primary keys that aren't enforced
level: medium
tags: constraints, data quality, optimizer

#### Question
A table has `PRIMARY KEY (order_id)`, yet it contains duplicate order_ids. How is that possible? What's the point of declaring constraints in Snowflake then?

#### Answer
Snowflake **does not enforce** PRIMARY KEY, UNIQUE or FOREIGN KEY constraints on standard tables — only **NOT NULL** is enforced. (Hybrid tables are the exception: they enforce primary keys.) So duplicates are entirely possible.

Why declare them anyway:
- **Documentation** and metadata for BI/ERD/catalog tools (they read constraints to infer joins).
- **Optimizer:** with the `RELY` property, Snowflake can use constraints for **join elimination** — e.g. drop an unnecessary join to a dimension when no columns from it are selected.
```sql
ALTER TABLE dim_customer ADD CONSTRAINT pk_cust PRIMARY KEY (customer_id) RELY;
```
  Only set `RELY` when you're sure the data satisfies it — otherwise query results can be wrong.

Enforcement must happen in the pipeline: dedup in loads, MERGE on keys, dbt `unique` + `not_null` + `relationships` tests (or contracts), and data-quality monitors (Snowflake data metric functions such as `DUPLICATE_COUNT`).

#### What interviewers look for
Knowing only NOT NULL is enforced, RELY/join elimination, and where enforcement really happens.

#### Follow-up
Write a query to find duplicate keys and how many extra rows they create (`GROUP BY key HAVING COUNT(*) > 1`, sum of `COUNT(*) - 1`).

### [sf-029] Loading messy files: schema detection and options
level: medium
tags: COPY options, INFER_SCHEMA, file formats

#### Question
A new source sends Parquet files whose columns sometimes get added or reordered, plus CSVs with headers, quotes and occasional bad dates. Which COPY/file-format features do you use?

#### Answer
**Parquet with changing columns:**
```sql
-- create the table from the files' schema
CREATE TABLE raw.events USING TEMPLATE (
  SELECT ARRAY_AGG(OBJECT_CONSTRUCT(*))
  FROM TABLE(INFER_SCHEMA(LOCATION => '@stg/events/', FILE_FORMAT => 'parquet_fmt')));

ALTER TABLE raw.events SET ENABLE_SCHEMA_EVOLUTION = TRUE;  -- new columns added automatically

COPY INTO raw.events FROM @stg/events/
FILE_FORMAT = (FORMAT_NAME = parquet_fmt)
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE         -- order no longer matters
INCLUDE_METADATA = (source_file = METADATA$FILENAME,
                    file_row = METADATA$FILE_ROW_NUMBER);
```
**CSV with quirks:**
```sql
CREATE FILE FORMAT csv_fmt TYPE = CSV
  PARSE_HEADER = TRUE                     -- enables MATCH_BY_COLUMN_NAME for CSV
  FIELD_OPTIONALLY_ENCLOSED_BY = '"'
  NULL_IF = ('', 'NULL', 'N/A')
  EMPTY_FIELD_AS_NULL = TRUE
  DATE_FORMAT = 'AUTO'
  ERROR_ON_COLUMN_COUNT_MISMATCH = FALSE
  ENCODING = 'UTF8';
```
Robust pattern for bad values: land raw columns as **VARCHAR**, then convert in staging with `TRY_TO_DATE`, `TRY_TO_NUMBER` and route failures to a quarantine table — loads never fail, and bad data is visible.

Also: `ON_ERROR` choice, `PURGE = TRUE` to delete loaded files (or lifecycle rules on the bucket), `PATTERN = '.*orders_.*[.]csv'`, and file sizing (~100–250 MB compressed).

#### What interviewers look for
Schema detection/evolution, metadata columns for lineage, and the land-as-string-then-TRY_ pattern.

#### Follow-up
How do you load only files modified in the last day from a huge bucket? (Partitioned paths `/date=YYYY-MM-DD/`, `PATTERN`, or event-driven Snowpipe instead of listing.)

### [sf-030] AI inside Snowflake: Cortex functions, Cortex Search, Cortex Analyst
level: medium
tags: Cortex, AI, semantic views

#### Question
Leadership asks: "How can we use AI on our Snowflake data without sending it outside?" Explain the main Snowflake AI building blocks and a sensible first use case.

#### Answer
- **AI SQL functions** — LLM operations as SQL functions, running inside Snowflake's security boundary: e.g. `AI_COMPLETE` (prompt an LLM), `AI_CLASSIFY`, `AI_FILTER` (natural-language WHERE condition), `AI_AGG` (summarise across rows), `AI_SENTIMENT`, translation and extraction functions. (Older equivalents live under `SNOWFLAKE.CORTEX.*`, e.g. `COMPLETE`.)
```sql
SELECT ticket_id,
       AI_CLASSIFY(body, ['billing', 'bug', 'feature request', 'other']) AS category,
       AI_SENTIMENT(body) AS sentiment
FROM support_tickets
WHERE created_at >= DATEADD(day, -7, CURRENT_DATE);
```
- **Cortex Search** — managed hybrid (vector + keyword) search over text, for RAG chatbots on documents, tickets and wikis.
- **Cortex Analyst** — natural-language questions → SQL, grounded in **semantic views** (business definitions of tables, relationships, metrics). Accuracy depends heavily on a good semantic layer.
- **Agents** that combine Analyst (structured) and Search (unstructured) to answer questions; Snowflake's coding agent (CoCo) helps build pipelines.

Sensible first use case: **classify and summarise support tickets or call notes** with AI functions in a dbt model — easy to measure, no new infrastructure, and immediately useful.

Architect concerns: **cost** (token-based credits — test on samples, filter rows first, cache results in tables instead of calling on every query), **governance** (masking and RBAC still apply), **quality** (evaluate outputs on a labelled sample), and **semantic layer ownership** (who maintains metric definitions).

#### What interviewers look for
Concrete building blocks, a pragmatic first use case, and cost/quality/governance thinking rather than hype.

#### Follow-up
How do you avoid re-running an LLM function on the same rows every day? (Incremental model: only new rows get classified; store results.)

### [sf-031] Editions: which features need what
level: easy
tags: editions, licensing

#### Question
Your client is on Standard edition and wants 30-day Time Travel, multi-cluster warehouses, masking policies, private connectivity and failover. What do they need?

#### Answer
| feature | minimum edition |
|---|---|
| Time Travel beyond 1 day (up to 90) | Enterprise |
| Multi-cluster warehouses | Enterprise |
| Column masking, row access policies, tag-based masking | Enterprise |
| Materialized views, search optimization, query acceleration | Enterprise |
| Access history | Enterprise |
| Private connectivity (PrivateLink etc.), Tri-Secret Secure, HIPAA/PCI-ready setups | Business Critical |
| Failover/failback groups and Client Redirect | Business Critical |
| Dedicated, isolated environment | Virtual Private Snowflake (VPS) |

So this client needs **Business Critical**. Credit prices rise with edition, so architects often justify the upgrade with specific requirements (compliance, DR) — or keep non-critical workloads in a separate lower-edition account.

#### What interviewers look for
Knowing the big boundaries (Enterprise vs Business Critical) and framing cost vs requirement.

#### Follow-up
Can different accounts in one organisation have different editions? (Yes — a common pattern to keep costs down.)
