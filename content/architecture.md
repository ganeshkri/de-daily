### [arch-001] Ingest 300 OLTP tables with CDC into Snowflake
level: hard
tags: CDC, ingestion, design

#### Question
A company runs its core application on PostgreSQL and SQL Server — 300 tables, some with 2 billion rows, heavy updates and deletes. The business wants analytics in Snowflake with < 15 minutes latency. Design the ingestion.

#### Answer
**1. Clarify:** latency SLA per table (not all need 15 min), volume and change rate, delete handling, history needed (current state vs full change history), source DB load limits, security/network constraints, budget, team skills.

**2. Capture changes with log-based CDC** (reads the database's transaction log — WAL / CDC tables), not query-based polling: catches deletes, low impact on the source, ordered changes.

**3. Options:**
| option | notes |
|---|---|
| Managed SaaS connector (Fivetran, etc.) | fastest to deliver, priced by volume — check cost at 2B rows |
| Snowflake Openflow / native connectors | stays inside Snowflake's ecosystem; check connector maturity for your sources |
| Debezium → Kafka → Snowflake Kafka connector (Snowpipe Streaming) | most control, lowest latency, you operate Kafka |

**4. Landing design (whatever the tool):**
- Raw **append-only change tables** per source table: all columns + `op` (I/U/D), source commit timestamp/LSN, ingestion time. Never update raw — it's your replayable history.
- **Current-state tables** built by MERGE (or dbt incremental / dynamic tables) choosing the latest change per key ordered by LSN, applying deletes (hard delete or `is_deleted` flag).
- Optional SCD2/history models from the change log.

**5. Initial load:** snapshot (bulk export → COPY) + CDC from a recorded log position, so there's no gap or overlap; reconcile counts.

**6. Operations:** schema change handling (new columns → schema evolution; alert on breaking changes), monitoring lag per table, row-count reconciliation against source daily, replay procedure, PII masking at landing, cost tracking per pipeline.

**7. Tiering:** 15-minute tables on continuous pipelines; slow-moving reference tables hourly/daily — saves a lot of money.

#### What interviewers look for
Requirements first, log-based CDC, raw change log + current state, initial load consistency, operations and cost tiering.

#### Follow-up
How do you handle a source table with no primary key? (Use a unique index if any; otherwise row hashing is fragile — push the source team to add a key, or treat it as full-refresh snapshots.)

### [arch-002] Layered architecture: raw, staging, core, marts
level: medium
tags: medallion, layers, modelling

#### Question
Describe the layers you'd set up in Snowflake + dbt (bronze/silver/gold or raw/staging/core/marts). What belongs in each, and who can access what?

#### Answer
| layer | contents | rules | access |
|---|---|---|---|
| **Raw / landing (bronze)** | data exactly as received (files, CDC logs, API JSON) + load metadata | append-only, never edited, long retention | loaders write; engineers read |
| **Staging (silver-ish)** | 1:1 cleaned views/tables: renamed, typed, deduped, standardised | no business logic, no joins across sources | engineers |
| **Core / integrated (silver)** | conformed entities across sources: customers, orders, products; history (SCD2) | business keys, surrogate keys, tested | engineers, advanced analysts |
| **Marts (gold)** | facts/dimensions or wide tables per domain/use case; metrics | contracted, documented, owned | analysts, BI, ML, apps |

Plus: a **sandbox** per user/team (cheap, auto-expiring), and **semantic layer** definitions over gold.

Separation by **database or schema per layer**, with RBAC: BI roles see only gold; PII masked from silver upward unless authorised.

Why layers: reproducibility (rebuild everything from raw), clear ownership, testing at boundaries, controlled exposure. Don't over-engineer: small teams can merge staging and core; the principle that matters is *raw is immutable, consumers only see curated, tested data*.

#### What interviewers look for
Clear contract per layer, immutability of raw, access design, pragmatism.

#### Follow-up
Where do data quality checks go? (Light checks at raw/staging entry; business rules at core/marts; freshness at sources and marts.)

### [arch-003] Cut Snowflake spend by 40%
level: hard
tags: cost optimization, FinOps

#### Question
Leadership says: "Snowflake costs went from $40k to $90k/month in a year. Cut 40% without hurting the business." How do you approach it in the first 30 days?

#### Answer
**Week 1 — Measure where the money goes.**
- Split by compute (per warehouse), serverless features (clustering, Snowpipe, search optimization, dynamic tables, tasks, AI functions), storage (active vs Time Travel vs Fail-safe), cloud services, data transfer.
- Top 50 queries by cost (`QUERY_ATTRIBUTION_HISTORY`), top warehouses by idle time, top dbt models by credits (query tags).
- Usually a few items dominate (Pareto).

**Weeks 2–3 — Quick wins (often 20–30%):**
- **Auto-suspend** 60 s on ETL warehouses; review warehouses that never suspend (BI tools keeping them awake with polling queries).
- **Right-size** warehouses: many run XL where M is enough; downsize and compare.
- Kill **zombie workloads**: dashboards nobody opens, duplicate pipelines, dev jobs on schedules.
- Reduce refresh frequency: hourly → daily where the business agrees; dynamic tables with too-small target lag.
- Full rebuilds → **incremental** for big dbt models.
- Storage: drop unused tables/clones, reduce Time Travel on high-churn staging tables, transient for rebuildable data.
- Serverless review: clustering on tables that don't need it, search optimization unused.

**Week 4 — Structural changes and guard rails:**
- Workload isolation + per-team warehouses for accountability; resource monitors and budgets.
- Statement timeouts; restrict warehouse creation/resizing.
- Query tagging standard; monthly cost review with teams; cost visible in CI for new models.
- Commercial: capacity commitment negotiation once usage is predictable.

**Communicate:** savings per change, risk, and owner. Avoid cuts that silently degrade freshness or reliability — agree on SLAs first.

#### What interviewers look for
Measure-first approach, concrete levers by category, governance to keep costs down, business alignment.

#### Follow-up
A BI tool runs 200,000 small queries a day and cloud services costs are high. Fix? (Caching/extracts in BI, consolidate queries, result cache-friendly SQL, pre-aggregated tables.)

### [arch-004] CI/CD for Snowflake, dbt and Airflow
level: hard
tags: CI/CD, DevOps, environments

#### Question
Design CI/CD and environment strategy for a platform using Snowflake, dbt and Airflow with 25 engineers.

#### Answer
**Environments:** dev (per-developer schemas, cloned or sampled data), CI (ephemeral per PR), prod (and optionally staging/UAT for big releases). Separate Snowflake databases or accounts per environment; separate roles and service users.

**What lives in git:**
- **Infrastructure** (warehouses, databases, roles, grants, integrations, resource monitors) → Terraform (or similar declarative tool), reviewed and applied by pipeline.
- **Object DDL outside dbt** (raw tables, stages, pipes, tasks) → migration tool (schemachange / Flyway-style versioned scripts) or Snowflake's declarative DCM-style features.
- **Transformations** → dbt.
- **Orchestration** → Airflow DAGs repo (or monorepo with clear folders).

**CI on every PR:**
1. Lint: SQLFluff, ruff (Python + Airflow rules), YAML checks, pre-commit.
2. dbt: `parse`, unit tests, **slim CI** build (`state:modified+ --defer`, or zero-copy clone of prod into a PR schema), data tests, contract/breaking-change checks, data diff vs prod for key models.
3. Airflow: DAG integrity tests, unit tests for operators/helpers.
4. Terraform `plan` posted to the PR.
5. Cleanup: drop PR schemas when the PR closes.

**CD:**
- Merge to main → deploy: Terraform apply → migrations → dbt artifacts → Airflow DAG sync (image build or git-sync).
- Production dbt runs use the prod manifest for state; keep artifacts for slim CI and observability.
- Feature flags / `enabled` configs for staged rollouts; blue/green for big model changes (build new schema, swap).
- Rollback: revert commit and redeploy; Time Travel/clones for data rollback.

**Governance:** branch protection, required reviews (CODEOWNERS per domain), secrets in a vault, service users with key-pair auth.

#### What interviewers look for
Separation of infra/DDL/transform/orchestration, PR-level ephemeral environments with clones, concrete CI steps, rollback.

#### Follow-up
How do you release a breaking change to a mart used by 30 dashboards? (Model versions, parallel run, communicate deprecation, monitor usage via access history, then remove.)

### [arch-005] A dashboard that must be < 1 minute fresh
level: hard
tags: real-time, streaming, latency

#### Question
Operations wants a live dashboard of orders and delivery status, max 1 minute delay, 500 concurrent users. Sources: an orders database and a Kafka topic of delivery events. Design it — and push back where needed.

#### Answer
**Push back first:** what decisions does 1-minute freshness change vs 5 or 15 minutes? Real-time costs much more (always-on compute). Often only a few KPIs need it. Agree on SLAs per metric.

**Design (if 1 minute is truly needed):**
- **Ingestion:** Kafka delivery events → **Snowpipe Streaming** (seconds). Orders DB → log-based CDC into Kafka (Debezium) → same path, or a CDC connector with streaming.
- **Transformation:** **dynamic tables** with `TARGET_LAG = '1 minute'` for the small set of real-time aggregates (current orders by status, late deliveries), built from append-only raw tables. Keep these models simple and incremental-friendly. Everything else stays on hourly/daily dbt.
- **Serving:** a dedicated **multi-cluster warehouse** for the dashboard (scales with 500 users); dashboard queries hit small pre-aggregated tables (fast, cache-friendly); BI tool refresh interval aligned to 1 minute; consider **interactive tables/warehouses** or an operational store if sub-second app-style latency is required.
- **Alternative:** if it's operational monitoring rather than analytics, a streaming engine (Flink) or an operational database/search tool might fit better, with Snowflake for history.

**Reliability:** monitor end-to-end lag (event time → dashboard), late/out-of-order events (watermarks, upserts by key), dead-letter handling for bad events, and a status banner on the dashboard when data is stale.

**Cost controls:** small warehouses for the 1-minute pipelines, resource monitors, review real usage after launch.

#### What interviewers look for
Challenging the requirement, right tools per latency tier, serving concurrency, and end-to-end lag monitoring.

#### Follow-up
How do you measure end-to-end latency continuously? (Carry the source event timestamp through; compute `now() - max(event_ts)` per table; alert.)

### [arch-006] Migrate a legacy warehouse to Snowflake
level: hard
tags: migration, Teradata, Oracle, planning

#### Question
You're leading the migration of a 15-year-old on-prem warehouse (Oracle/Teradata, 600 ETL jobs, 40 TB, 2,000 reports) to Snowflake + dbt + Airflow. Outline your plan and the biggest risks.

#### Answer
**Phase 0 — Discovery (most important):** inventory objects, ETL jobs, schedules, dependencies, reports and *actual usage* (query logs). Typically 30–50% of objects/reports are unused → **don't migrate them**. Classify by complexity and business criticality.

**Phase 1 — Foundation:** Snowflake account structure, RBAC, networking/SSO, environments, CI/CD, dbt project standards, Airflow, monitoring, cost guard rails.

**Phase 2 — Data movement:**
- Historical bulk load: export to files (Parquet/CSV), transfer (network or physical appliance for large volumes), `COPY` into raw.
- Ongoing sync during parallel run: CDC or incremental extracts.

**Phase 3 — Code conversion:**
- Translate SQL dialect (procedures, `MERGE` differences, date functions, Teradata `QUALIFY`/`SET` tables, Oracle PL/SQL) — automated tools (SnowConvert and others) do a large share; humans fix the rest.
- **Re-platform, don't just lift-and-shift:** procedural row-by-row ETL → set-based dbt models; replace cron/legacy schedulers with Airflow.

**Phase 4 — Validation:** row counts, column-level checksums/aggregates, `audit_helper`-style comparisons between old and new for every migrated table, plus business sign-off on key reports for several periods (month-end!).

**Phase 5 — Cutover by domain (waves),** parallel run, then decommission old jobs/reports with a firm date.

**Biggest risks:** hidden dependencies (spreadsheets, downstream extracts), undocumented business logic in old code, data type/precision/collation differences, performance assumptions (indexes vs pruning), skills gap, scope creep, and running two platforms too long (double cost).

#### What interviewers look for
Discovery and decommission thinking, wave-based delivery, rigorous validation, realistic risks.

#### Follow-up
How do you handle Oracle sequences/identity columns and case-sensitivity differences? (Snowflake sequences/IDENTITY; identifier quoting rules; collation settings.)

### [arch-007] A data quality framework end to end
level: medium
tags: data quality, observability, testing

#### Question
Executives found wrong numbers in a board report. Design a data quality framework so this doesn't happen again.

#### Answer
**Dimensions to cover:** freshness, volume, schema, validity (types/ranges/allowed values), uniqueness, referential integrity, consistency/reconciliation with source systems, and business-rule correctness.

**Where checks run:**
1. **At the source boundary:** schema checks, freshness, volumes vs expected (anomaly detection on row counts), contracts with producing teams.
2. **In transformations:** dbt data tests (keys, relationships, accepted values), unit tests for logic, model contracts.
3. **On outputs:** reconciliation tests for critical metrics (revenue in mart = revenue in finance system ± tolerance), metric anomaly detection.
4. **Continuous monitoring:** Snowflake **data metric functions** (freshness, null count, duplicate count…) scheduled on tables, or an observability tool.

**Process:**
- **Severity tiers:** block the pipeline (critical) vs warn (investigate next day). `dbt build` stops downstream models on failed tests.
- **Ownership:** every critical dataset has an owner and an on-call rotation; alerts route to them with context.
- **Circuit breakers:** don't publish to dashboards when critical checks fail; show "data delayed" rather than wrong numbers.
- **Incident process:** root-cause analysis, add a test for every incident.
- **Certified datasets:** mark gold tables as certified; reports for executives use only those.
- Track a data-quality scorecard over time.

#### What interviewers look for
Comprehensive dimensions, checks at multiple layers, blocking vs warning, ownership and incident learning.

#### Follow-up
How do you avoid alert fatigue? (Fewer, meaningful tests; dynamic thresholds; grouping; tiering by dataset criticality.)

### [arch-008] Multi-tenant analytics for a SaaS product
level: hard
tags: multi-tenancy, security, design

#### Question
Your SaaS company (2,000 customers) wants to offer each customer analytics on their own data inside your product, plus data sharing for large customers. Design the Snowflake architecture.

#### Answer
**Tenancy models:**
| model | how | pros | cons |
|---|---|---|---|
| **Shared tables + tenant_id** | one set of tables; row access policies filter by tenant | simplest, cheapest, easy schema changes | isolation by policy only; noisy neighbours |
| **Schema/database per tenant** | separate objects per tenant | stronger isolation, per-tenant retention/deletion | thousands of objects to manage; schema changes ×2,000 |
| **Account per tenant** | separate Snowflake accounts | strongest isolation, per-tenant cost/billing | heavy operations |

Recommended for 2,000 tenants: **shared tables with `tenant_id`** (clustered by tenant where helpful) + **row access policies** mapping the application's tenant context, with a hybrid option (dedicated database/account) for large or regulated customers.

**In-app analytics:** the app queries Snowflake through a service layer using a service role and sets the tenant context (session variable/secure function) used by the row access policy — never build tenant filters by string concatenation in app code alone. Use a dedicated multi-cluster warehouse; pre-aggregate per tenant for speed; cache in the app.

**Sharing for big customers:** secure views filtered by `CURRENT_ACCOUNT()` mapped to tenant, shared via listings/direct shares; reader accounts for non-Snowflake customers.

**Also:** per-tenant cost attribution (query tags with tenant id), tenant data deletion on contract end, tests that prove isolation (automated "can tenant A see tenant B?" checks), and noisy-neighbour protections (timeouts, query limits).

#### What interviewers look for
Comparing tenancy models, policy-based isolation done correctly, sharing, isolation testing.

#### Follow-up
A tenant requires their data stored in the EU only? (Separate EU account/region for that tenant group; route ingestion accordingly.)

### [arch-009] Backfilling 3 years without breaking production
level: hard
tags: backfill, reprocessing, operations

#### Question
A bug in currency conversion affected 3 years of the `fct_revenue` table (4 billion rows). Fix it and backfill without disrupting daily loads or dashboards.

#### Answer
1. **Fix + test:** correct the logic, add a unit test reproducing the bug and a reconciliation test against finance totals.
2. **Build in parallel, not in place:** create `fct_revenue_v2` (or a separate schema) alongside the live table — production keeps serving the old version.
3. **Backfill in chunks** (month by month): microbatch with `--event-time-start/--event-time-end`, or a loop of idempotent date-range runs. Benefits: restartable, parallelisable within limits, progress visible.
4. **Compute isolation:** run on a separate (larger) warehouse so daily loads and BI aren't slowed; schedule heavy chunks off-peak.
5. **Keep the daily pipeline writing to both** (or replay the daily increment into v2 before cutover) so v2 is current at cutover time.
6. **Validate:** compare old vs new per month (differences should match the expected bug impact), and get finance sign-off.
7. **Atomic cutover:** `ALTER TABLE … SWAP WITH` or repoint a view; keep the old table (clone) for rollback for a while.
8. **Communicate:** historical numbers will change — notify stakeholders, annotate dashboards, document the change.

Cost check: rebuilding 4B rows once is fine; avoid doing it repeatedly because of failed attempts — test on one month first.

#### What interviewers look for
Parallel build + swap, chunked idempotent backfill, compute isolation, validation and communication.

#### Follow-up
What if downstream models (20 of them) also depend on `fct_revenue`? (Rebuild them in the parallel environment too, using `+` selection, before swapping all at once.)

### [arch-010] Handling schema changes from source systems
level: medium
tags: schema evolution, data contracts

#### Question
Source teams add, rename and drop columns without warning, breaking pipelines a few times a month. How do you make the platform resilient?

#### Answer
**Technical resilience:**
- **Land raw flexibly:** VARIANT/JSON or `ENABLE_SCHEMA_EVOLUTION` + `MATCH_BY_COLUMN_NAME` so new columns don't break loads.
- **Staging selects explicit columns** — new columns are ignored until you choose to use them; dropped/renamed columns fail loudly at staging, not deep in marts.
- **Schema change detection:** compare current vs previous schema of each raw table daily (information schema snapshots) → alert with details.
- dbt `on_schema_change` set deliberately (`append_new_columns` or `fail`).

**Organisational fix — data contracts:**
- Agree with producers on a contract: schema, semantics, SLAs, change process (versioning, notice period).
- Enforce it in CI on the producer side where possible (schema checks before deploy), or at ingestion.
- Prefer consuming **events/APIs designed for analytics** (an outbox/CDC topic with a versioned schema in a schema registry) rather than raw internal tables.
- Make breakages visible to the producing team (ownership, alerts routed to them).

#### What interviewers look for
Both technical and organisational solutions; fail-fast at the right layer.

#### Follow-up
A column is renamed — how do you keep history continuous? (Coalesce old and new names in staging during transition: `COALESCE(new_col, old_col)`.)

### [arch-011] Designing PII governance for the platform
level: medium
tags: governance, PII, compliance

#### Question
Design how PII is discovered, protected and audited across a Snowflake platform with 5,000 tables and 300 users.

#### Answer
1. **Discover & classify:** Snowflake automatic **data classification** (suggests semantic categories like email, phone, name) + manual review → apply **tags** (`pii_type`, `sensitivity`). Classify new tables automatically as part of ingestion.
2. **Protect by policy, attached to tags:** **tag-based masking policies** (mask/hash/partial-mask by role), **row access policies** where needed (region, business unit). New PII columns are protected as soon as they're tagged.
3. **Minimise:** don't ingest PII you don't need; tokenise/hash identifiers early; separate PII into restricted tables keyed by surrogate ids.
4. **Access model:** functional roles; PII-reader roles granted through an approval workflow with expiry; break-glass procedures.
5. **Audit:** `ACCESS_HISTORY` (who read which columns, including via views), login history, policy references; regular access reviews; alerts on unusual access.
6. **Lifecycle:** retention rules, deletion processes (GDPR/DPDP), short Time Travel on PII tables, masked data in non-prod (clones carry policies).
7. **Documentation:** catalog shows classification and owners; lineage shows where PII flows.

#### What interviewers look for
Tag-driven, scalable approach covering discover → protect → audit → lifecycle.

#### Follow-up
India's DPDP Act or GDPR: what changes in your design? (Consent tracking, purpose limitation, data subject requests, breach notification, data residency questions.)

### [arch-012] Defining a DR strategy with the business
level: hard
tags: disaster recovery, RTO, RPO

#### Question
How do you decide what disaster recovery the data platform actually needs, and what would you implement at different budget levels?

#### Answer
Start with the **business impact**, per data product: what happens if it's unavailable for 1 hour / 1 day / 1 week? That gives **RTO** (how fast to recover) and **RPO** (how much data loss is acceptable).

| tier | example | RTO / RPO | implementation |
|---|---|---|---|
| Tier 1 | customer-facing analytics, regulatory reporting | < 1–4 h / < 15 min | cross-region replication + failover groups + client redirect (Business Critical), pipelines deployable in DR region, drills |
| Tier 2 | internal daily reporting | 1 day / 1 day | replicate key databases on a daily schedule; rebuild the rest from raw |
| Tier 3 | sandboxes, exploratory | best effort | none — rebuild |

Separate **disaster** (region outage) from **mistakes** (bad deletes, bugs): mistakes are handled by Time Travel, clones, UNDROP, immutable raw data and backups (Snowflake also offers backup features with retention locks for ransomware protection). Most real incidents are mistakes, not region outages.

Remember everything around Snowflake: orchestrator, dbt, secrets, networking, ingestion sources, BI tools.

Test it: run DR drills twice a year and measure real RTO/RPO; keep runbooks current.

#### What interviewers look for
Business-driven tiers, RTO/RPO, distinguishing mistakes from disasters, testing.

#### Follow-up
How do you justify the cost of Tier 1 DR? (Cost of downtime per hour × probability vs replication + standby costs; regulatory obligations.)

### [arch-013] Kimball, One Big Table or Data Vault?
level: medium
tags: data modelling, Kimball, Data Vault

#### Question
For a new Snowflake warehouse, the team argues between Kimball star schemas, wide "one big table" (OBT) marts, and Data Vault. What's your view?

#### Answer
| approach | strengths | weaknesses | fits |
|---|---|---|---|
| **Kimball star schema** (facts + conformed dimensions) | understandable, reusable dimensions, works with every BI tool, consistent metrics | modelling effort; joins at query time | most analytics teams; the default core/marts design |
| **One Big Table** (denormalised wide tables) | very simple for users, fast in columnar engines, great for BI/ML features | duplication; consistency across tables; rebuild cost; dimension changes ripple | final marts built *from* a star schema; specific use cases |
| **Data Vault 2.0** (hubs, links, satellites) | auditability, history of everything, parallel loading, absorbs many changing sources | complex, many tables, needs a presentation layer on top, more engineering | large enterprises with many sources, strict audit/regulatory needs |

My usual answer: **Kimball-style core with conformed dimensions, and wide marts on top where they help consumers.** Use Data Vault only when the audit/integration problem justifies its overhead (often in banking/insurance) — and still serve users star schemas or wide tables.

Snowflake-era considerations: storage is cheap and columnar scans are fast, so denormalisation is less painful than on old platforms; but **consistency** of definitions matters more than ever → semantic layer + conformed dimensions.

#### What interviewers look for
Balanced comparison, a clear default with reasoning, and context-driven exceptions.

#### Follow-up
How do you handle a many-to-many relationship (e.g. accounts with multiple owners) in a star schema? (Bridge table with weighting factors.)

### [arch-014] Iceberg lakehouse with Snowflake and Spark
level: hard
tags: Iceberg, lakehouse, interoperability

#### Question
The ML team uses Spark on Databricks/EMR; analytics uses Snowflake. Data is duplicated in both, numbers don't match and storage costs are doubled. Design a shared architecture.

#### Answer
**Goal:** one copy of key datasets in an open table format, readable and writable by both engines, with clear ownership.

- **Format:** Apache Iceberg on object storage (your bucket).
- **Catalog:** choose one authoritative catalog — Snowflake as the Iceberg catalog (others read via its Iceberg REST interface), or an external REST catalog such as Snowflake Open Catalog (Apache Polaris), AWS Glue, or Unity Catalog, which both engines connect to.
- **Single writer per table:** e.g. Snowflake/dbt writes curated tables; Spark writes ML feature/output tables; each engine reads the other's tables. Avoid two engines writing the same table concurrently.
- **Governance:** permissions in the catalog + engine-level policies; be aware that Snowflake masking policies don't follow data read directly by Spark — sensitive tables may stay native or be exposed only via governed paths.
- **Table maintenance:** compaction, snapshot expiry, orphan file cleanup — decide which engine/service owns it.
- **Performance:** Snowflake on Iceberg is close to native for most queries; keep heavy-use analytics marts native where every feature matters.
- **Migration:** start with the most duplicated datasets; switch consumers one by one; delete the copies.

Result: one source of truth, lower storage cost, engine choice per workload.

#### What interviewers look for
Catalog decision, single-writer ownership, governance gaps across engines, maintenance responsibilities.

#### Follow-up
How do you keep metrics consistent across Spark and Snowflake users? (Shared semantic definitions, certified tables, the same transformation code path — e.g. dbt — for metric-bearing tables.)

### [arch-015] Making the data platform "AI-ready"
level: medium
tags: AI, RAG, semantic layer, strategy

#### Question
The CEO wants "AI on our data" — a chatbot for business questions and document Q&A. As the data architect, what do you put in place first?

#### Answer
**1. Pick concrete use cases** with measurable value (e.g. "sales managers ask pipeline questions in natural language", "support finds answers in 20,000 policy PDFs").

**2. Structured questions (text-to-SQL):** accuracy depends on context, not the model alone.
- A **semantic layer** — semantic views (for Cortex Analyst) or dbt metrics: certified metrics, dimensions, relationships, synonyms, verified example queries.
- Clean, documented, tested marts (column descriptions matter — the AI reads them).
- An **evaluation set**: 100+ real questions with correct answers, run on every change.

**3. Unstructured documents (RAG):** ingest documents (parsing PDFs, chunking), index with **Cortex Search** (or a vector store), keep source permissions, cite sources in answers, refresh pipelines when documents change.

**4. Governance:** the AI uses the **user's role** (RBAC, masking, row policies apply), logging of prompts/answers, PII handling, approved models only.

**5. Operations & cost:** token/credit budgets, caching, monitoring answer quality and user feedback, a human review loop for high-stakes answers.

**6. Start small:** one domain, one team, iterate weekly; expand when evaluation scores are stable.

The architect's key message: **AI quality = data quality + semantic clarity + governance.** The model is the easiest part to change.

#### What interviewers look for
Use-case first, semantic layer + evaluation for structured data, RAG basics, governance and cost.

#### Follow-up
How do you measure whether the chatbot is "good enough"? (Accuracy on the evaluation set, user feedback, % of answers needing correction, adoption.)

### [arch-016] "Tell me about a design decision you got wrong"
level: medium
tags: behavioural, leadership, STAR

#### Question
Architect interviews always include behavioural questions: "Describe a major design trade-off", "Tell me about an incident you led", "A decision you got wrong". How do you prepare strong answers?

#### Answer
Use **STAR** — Situation, Task, Action, Result — plus **what you learned**. Keep each story 2–3 minutes. Prepare 6–8 stories from your own 17 years that cover: a big design trade-off, a production incident, a cost-saving initiative, a migration, influencing stakeholders without authority, mentoring/growing a team, a disagreement you resolved, and a mistake.

Example structure (fill in with your real details):
- **Situation:** "Our nightly Teradata-to-Snowflake loads were missing the 6 am SLA twice a week, affecting the finance close."
- **Task:** "As lead architect, I had to fix reliability within one quarter without increasing cost."
- **Action:** "I measured the critical path from run artifacts, found three full-rebuild models taking 60% of runtime, moved them to incremental with a 3-day lookback, isolated the heavy models on a separate warehouse, and added freshness alerts so finance knew early if something slipped."
- **Result:** "SLA met 99% of days over six months; runtime down from 4 h to 1.5 h; compute cost down 22%."
- **Learning:** "I now design for incremental processing from day one and add SLA monitoring before go-live, not after."

For "a decision you got wrong": choose a real but recoverable mistake, own it without blaming others, show how you detected it, fixed it, and what you changed in your process. Interviewers test **self-awareness** and **learning**, not perfection.

Use numbers (time, cost, data volume, users) — they make stories credible.

#### What interviewers look for
Structured, specific, quantified stories showing ownership, judgement and learning.

#### Follow-up
"Why did you make that trade-off rather than the alternative?" — always prepare the alternatives you rejected and why.
