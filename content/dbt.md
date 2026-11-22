### [dbt-001] Materializations — which one, when?
level: easy
tags: materializations, fundamentals

#### Question
Explain dbt's materializations and when you'd choose each. What's a sensible default per layer?

#### Answer
| materialization | what dbt builds | use when |
|---|---|---|
| `view` | a view | light transformations, staging models, always-fresh data, low storage |
| `table` | full rebuild each run (CTAS) | marts queried often; data small enough to rebuild quickly |
| `incremental` | inserts/merges only new or changed rows | large or growing tables where full rebuilds are slow/costly |
| `ephemeral` | no object — inlined as a CTE into downstream models | tiny reusable logic (use sparingly) |
| `materialized_view` / `dynamic_table` (Snowflake) | warehouse-managed refresh | near-real-time freshness managed by the warehouse |
| `snapshot` (separate resource) | SCD Type 2 history table | tracking changes to mutable sources |

Sensible defaults:
- **staging:** views (1:1 with sources, renaming/casting).
- **intermediate:** views or ephemeral; tables if reused heavily or complex.
- **marts:** tables; incremental when large.

Decision drivers: query frequency vs build cost, data volume, freshness needs, and how many models depend on it. Many views stacked on views can make the *final* query very slow — materialise at sensible checkpoints.

#### What interviewers look for
Practical trade-offs and layer conventions, not just definitions.

#### Follow-up
A view-based staging layer makes the marts build slowly. Options? (Materialise heavy staging models as tables, or incremental; check query profile of mart builds.)

### [dbt-002] Incremental models done right
level: medium
tags: incremental, is_incremental, late-arriving data

#### Question
Write an incremental model for a large `events` table. How do you handle late-arriving events, and what does `is_incremental()` actually check?

#### Answer
```sql
{{ config(
    materialized = 'incremental',
    unique_key   = 'event_id',
    incremental_strategy = 'merge',
    on_schema_change = 'append_new_columns'
) }}

SELECT event_id, user_id, event_type, event_ts, _loaded_at
FROM {{ source('app', 'events') }}

{% if is_incremental() %}
  -- 3-day lookback catches late-arriving rows; unique_key prevents duplicates
  WHERE _loaded_at > (SELECT DATEADD(day, -3, MAX(_loaded_at)) FROM {{ this }})
{% endif %}
```
- `is_incremental()` is TRUE only when **all** hold: the model is materialized incremental, the target table already exists, and you're **not** running with `--full-refresh`.
- `{{ this }}` refers to the existing target table.
- **Filter on load time (`_loaded_at`), not event time,** when possible — event time can arrive late; load time only increases. If you must use event time, add a lookback window.
- The lookback re-processes some rows; `unique_key` + merge makes that safe (idempotent).
- Avoid `SELECT MAX(...)` on a huge target every run if it's slow — Snowflake answers `MAX` from metadata quickly on many tables, but a clustered date column helps.
- Keep a way to rebuild: `dbt build -s model --full-refresh` (and protect giant models with `full_refresh: false` config so nobody rebuilds them by accident).

#### What interviewers look for
Correct `is_incremental` semantics, load-time vs event-time filtering, lookback + unique_key idempotency.

#### Follow-up
How do you backfill one month of a huge incremental model without a full refresh? (Microbatch with `--event-time-start/--event-time-end`, or a var-driven date filter.)

### [dbt-003] Incremental strategies on Snowflake: merge, delete+insert, append, insert_overwrite, microbatch
level: hard
tags: incremental strategies, performance

#### Question
Compare dbt's incremental strategies on Snowflake. Which would you choose for (a) an append-only log, (b) a table where rows are updated by key, (c) daily partitions that are fully recomputed, (d) a 5-year fact table that needs easy backfills?

#### Answer
| strategy | SQL dbt generates | good for | watch out |
|---|---|---|---|
| `append` | `INSERT` | append-only data with no duplicates | re-runs create duplicates |
| `merge` (Snowflake default) | `MERGE` on `unique_key` | updates by key | source must be unique per key; scans target to match — slow on huge tables without predicates |
| `delete+insert` | `DELETE` matching keys, then `INSERT` | replacing **groups** of rows (e.g. a whole day) | key need not be unique in the new data |
| `insert_overwrite` | on Snowflake overwrites the **whole table** (no partitions) | rarely what you want here | very different meaning than on BigQuery/Spark |
| `microbatch` | splits work into time batches (on Snowflake runs delete+insert per batch) | large time-series facts, backfills, retrying failed batches | needs `event_time`, `batch_size`, `begin` configs |

Answers:
- **(a)** `append` — or `merge` if duplicates can arrive.
- **(b)** `merge` with a deduplicated source; add `incremental_predicates` to limit the target scan: e.g. only match target rows from the last 7 days.
- **(c)** `delete+insert` with `unique_key='event_date'` — replaces whole days atomically.
- **(d)** `microbatch`:
```sql
{{ config(materialized='incremental', incremental_strategy='microbatch',
          event_time='event_ts', batch_size='day', begin='2021-01-01', lookback=2) }}
SELECT * FROM {{ ref('stg_events') }}   -- dbt auto-filters upstream refs by event_time
```
  Backfill: `dbt run -s fct_events --event-time-start 2026-01-01 --event-time-end 2026-02-01`. Failed batches can be retried individually with `dbt retry`.

Performance tip for big merges:
```sql
{{ config(incremental_strategy='merge', unique_key='order_id',
          incremental_predicates=["DBT_INTERNAL_DEST.order_date >= DATEADD(day, -7, CURRENT_DATE)"]) }}
```
— only safe if updates never touch older rows.

#### What interviewers look for
Precise semantics per strategy, knowing Snowflake's `insert_overwrite` caveat, microbatch, incremental predicates.

#### Follow-up
Why can `merge` be slower than `delete+insert` on Snowflake for large daily loads? (MERGE has to join against the target to find matches; delete+insert by date prunes by partition and inserts cheaply.)

### [dbt-004] Adding a column to an incremental model
level: medium
tags: on_schema_change, schema evolution

#### Question
You add a new column `discount_pct` to an existing incremental model. What happens on the next run? What are the `on_schema_change` options, and how do you get historical values filled?

#### Answer
Default `on_schema_change = 'ignore'`: the new column is **silently not added** to the target table — the model runs, and the column never appears. Options:

| setting | behaviour |
|---|---|
| `ignore` (default) | target schema unchanged; new columns dropped |
| `fail` | run fails when schemas differ — forces a conscious decision |
| `append_new_columns` | adds new columns; never removes |
| `sync_all_columns` | adds new and **removes** missing columns; handles type changes |

None of them **backfills** historical rows — old rows get NULL in the new column. To populate history: run `--full-refresh` (if affordable), or a targeted backfill (a one-off `UPDATE`/merge for older data, or microbatch backfill over the date range).

Production view: use `fail` or `append_new_columns` for critical models, be careful with `sync_all_columns` (dropping columns breaks consumers), and pair schema changes with **model contracts** so changes are deliberate and reviewed.

#### What interviewers look for
Knowing the silent default, the four options, and that none backfill.

#### Follow-up
Changing a column's type (e.g. INT → VARCHAR) in an incremental model — what happens? (Depends on adapter; `sync_all_columns` can alter; otherwise rebuild or migrate.)

### [dbt-005] Snapshots: timestamp vs check, hard deletes, and current rows
level: medium
tags: snapshots, SCD2

#### Question
How do dbt snapshots work? When do you use the `timestamp` vs `check` strategy? How are deleted source rows handled? What do `dbt_valid_from` / `dbt_valid_to` mean?

#### Answer
A snapshot implements **SCD Type 2**: each run compares the source to the snapshot table and, for changed rows, closes the old version and inserts a new one.
```yaml
# snapshots/customers.yml  (YAML snapshot config, dbt 1.9+)
snapshots:
  - name: customers_snapshot
    relation: source('crm', 'customers')
    config:
      schema: snapshots
      unique_key: customer_id
      strategy: timestamp
      updated_at: updated_at
      hard_deletes: invalidate        # ignore (default) | invalidate | new_record
      dbt_valid_to_current: "to_date('9999-12-31')"   # instead of NULL for current rows
```
- **timestamp** strategy: a row changed if `updated_at` is newer. Efficient and reliable — **use it when the source has a trustworthy updated_at**.
- **check** strategy: compares the listed `check_cols` (or `all`). Use when there's no reliable timestamp. More expensive, and it misses changes that revert within one interval.
- `dbt_valid_from` / `dbt_valid_to`: the period each version was current; current rows have `dbt_valid_to` NULL (or the configured far-future date). Also `dbt_scd_id`, `dbt_updated_at`.
- **Hard deletes:** default `ignore` (deleted rows stay "current" forever); `invalidate` closes them; `new_record` inserts a deletion row (with `dbt_is_deleted`).

Practical points:
- A snapshot only captures what it **sees when it runs** — changes between runs are collapsed. Run snapshots frequently enough, or snapshot from a CDC log instead.
- Snapshots hold irreplaceable history: keep them **non-transient**, protect them from full refresh, back them up.
- Snapshot sources as raw as possible (selecting from sources, not heavily transformed models).

#### What interviewers look for
Strategy trade-offs, hard deletes, irreplaceability of snapshot data.

#### Follow-up
Point-in-time join: what was the customer's tier at order time? (Join on `customer_id` and `order_ts >= dbt_valid_from AND order_ts < COALESCE(dbt_valid_to, '9999-12-31')`.)

### [dbt-006] Testing strategy in dbt
level: medium
tags: data tests, severity, store_failures

#### Question
Describe the types of tests in dbt and a sensible testing strategy for a large project. How do you stop noisy tests from blocking production?

#### Answer
**Types:**
- **Generic data tests** in YAML: `unique`, `not_null`, `accepted_values`, `relationships` — plus package tests (`dbt_utils`, `dbt-expectations`) and your own custom generic tests (a Jinja macro with `{% test %}`).
- **Singular data tests:** a `.sql` file in `tests/` that returns failing rows.
- **Unit tests** (dbt 1.8+): test model *logic* with mocked inputs (see unit tests problem).
- **Source freshness:** `loaded_at_field` + `warn_after` / `error_after`.
- **Model contracts:** enforce column names/types at build time.

```yaml
models:
  - name: fct_orders
    columns:
      - name: order_id
        data_tests: [unique, not_null]
      - name: status
        data_tests:
          - accepted_values:
              arguments:
                values: ['placed', 'shipped', 'returned']
              config: {severity: warn}
      - name: customer_id
        data_tests:
          - relationships:
              arguments: {to: ref('dim_customers'), field: customer_id}
              config:
                where: "order_date >= dateadd(day, -30, current_date)"
                error_if: ">100"
                warn_if: ">0"
                store_failures: true
```
(Older projects write `tests:` and put arguments directly under the test — both styles appear in interviews.)

**Strategy:**
- Every model: primary key `unique` + `not_null` (catches fan-out and duplicates — the #1 bug).
- Sources: freshness + key tests at the entry point — catch problems before they spread.
- Marts: business rules (accepted values, relationships, reconciliation totals against source).
- Use **`severity`, `warn_if`, `error_if`** to separate "page someone" from "look at it tomorrow".
- `where` configs to test only recent data on huge tables.
- `store_failures` to save failing rows for debugging.
- `dbt build` runs tests right after each model, so downstream models **don't build on bad data**.

#### What interviewers look for
Breadth of test types, a prioritised strategy, severity thresholds, and `dbt build` ordering.

#### Follow-up
Tests run fine but data is still "wrong" for the business. What's missing? (Reconciliation tests vs source systems, anomaly detection on volumes/metrics, contracts with producers.)

### [dbt-007] Unit tests: testing logic, not data
level: medium
tags: unit tests, TDD

#### Question
What are dbt unit tests and how are they different from data tests? Write one for a model that flags orders over ₹10,000 as `is_large`.

#### Answer
**Data tests** check the *data* after it's built (is it unique, not null…). **Unit tests** (dbt 1.8+) check the model's *SQL logic* with small, hand-written inputs and expected outputs — before touching real data. They catch logic bugs (wrong boundary, wrong join) regardless of what production data happens to contain.
```yaml
unit_tests:
  - name: test_is_large_order_boundary
    model: fct_orders
    given:
      - input: ref('stg_orders')
        rows:
          - {order_id: 1, amount: 9999}
          - {order_id: 2, amount: 10000}
          - {order_id: 3, amount: 10001}
          - {order_id: 4, amount: null}
    expect:
      rows:
        - {order_id: 1, is_large: false}
        - {order_id: 2, is_large: false}   # "over" 10,000 → strictly greater
        - {order_id: 3, is_large: true}
        - {order_id: 4, is_large: false}
```
- Only the columns you list matter; inputs can be given as dict rows, CSV or SQL.
- For incremental models, you can test the incremental path with `overrides: macros: is_incremental: true` and provide `this` as an input.
- Run them in **CI/dev**, not on every production run (they don't depend on prod data): `dbt test --select test_type:unit`.
- Best for complex logic: regex parsing, date edge cases (month ends, time zones), CASE ladders, window logic.

#### What interviewers look for
Clear distinction, boundary/NULL cases in the example, and where unit tests run.

#### Follow-up
How do you unit test a model that uses `current_date`? (Override the macro/var that provides the date, or pass the date as a var.)

### [dbt-008] Contracts, versions, access — governing models at scale
level: hard
tags: contracts, model versions, dbt Mesh, governance

#### Question
Your marts are consumed by BI, ML and other teams' dbt projects. A column rename last month broke three dashboards. How do model contracts, versions, access and groups prevent this?

#### Answer
- **Model contract** — a promise about the shape of the output. With `contract: {enforced: true}`, dbt checks column names and data types at build time (and applies supported constraints such as `not_null`); the build fails if the SQL doesn't match.
```yaml
models:
  - name: dim_customers
    config:
      contract: {enforced: true}
      access: public
      group: customer_domain
    columns:
      - name: customer_id
        data_type: number
        constraints: [{type: not_null}]
      - name: full_name
        data_type: varchar
```
- **Model versions** — make breaking changes safely: publish `v2` alongside `v1`, give consumers a deprecation date, then remove `v1`.
```yaml
    latest_version: 2
    versions:
      - v: 1
        deprecation_date: 2027-01-31
      - v: 2
        columns:
          - include: all
            exclude: [full_name]
          - name: first_name
            data_type: varchar
```
  Consumers pin with `ref('dim_customers', v=1)`.

- **Access** — `private` (only within its group), `protected` (within the project; default), `public` (other projects can ref it).
- **Groups** — ownership: which team owns a set of models, with contact info.
- **dbt Mesh** — multiple projects referencing each other's public models (cross-project `ref`), each team owning its domain (available on the dbt platform's enterprise plans).

Architect view: treat public models as **APIs**: contract + version + owner + deprecation policy + changelog; CI checks that detect breaking changes (dbt flags contract changes on modified public models); exposures to know which dashboards depend on what.

#### What interviewers look for
Data-products thinking: contracts as APIs, versioned change management, ownership.

#### Follow-up
How would you find every dashboard affected by a column change? (Exposures in dbt, BI-tool lineage, or warehouse access history.)

### [dbt-009] Slim CI: build only what changed
level: hard
tags: CI/CD, state, defer, clone

#### Question
Your dbt project has 1,500 models; CI builds everything and takes 90 minutes. Design a fast CI process.

#### Answer
**Slim CI = build and test only modified models and their downstream dependents, reading unchanged parents from production.**
```bash
# 1. Get production's manifest (artifact from the last prod run)
#    e.g. download to ./prod-artifacts/manifest.json

# 2. Build only changed models + children, in a PR-specific schema
dbt build \
  --select state:modified+ \
  --defer --state ./prod-artifacts \
  --target ci                        # schema like ci_pr_1234
```
- `state:modified` compares the current project to the prod manifest (SQL, configs, macros it uses…). The `+` adds downstream models.
- `--defer` means: when a selected model refers to an **unbuilt** parent, use the **production** relation instead of failing.
- Alternatively `dbt clone --select state:modified+ --state …` creates zero-copy clones of prod tables into the CI schema first — on Snowflake that's instant and lets incremental models run their incremental path in CI.
- Include `state:modified.body`, `.configs`, `.contract` selectors as needed; `--empty` (dbt 1.8+) for a quick schema-only dry run with no data.
- Clean up the CI schema when the PR closes.

Also in CI: SQL linting (SQLFluff), `dbt parse`/compile errors, unit tests, contract/breaking-change checks, and data diffing on key models (compare row counts/values between PR build and prod, e.g. `audit_helper`).

Result: typical PRs touch a few models → CI runs in minutes, with lower warehouse cost.

#### What interviewers look for
`state:modified+`, `--defer`, prod manifest handling, clones, and extra CI checks.

#### Follow-up
What does `state:modified` miss? (Changes in upstream *data* rather than code; env-var-driven logic; some macro changes in older versions — hence also run a scheduled full build/test.)

### [dbt-010] Node selection syntax
level: easy
tags: CLI, selectors

#### Question
Write commands to: (1) run `fct_orders` and everything upstream; (2) everything downstream of `stg_customers`; (3) a model, its parents, and all parents of its children; (4) all models tagged `finance` except those in the `legacy` folder; (5) only the parents two levels up.

#### Answer
```bash
dbt run --select +fct_orders                        # 1  upstream + model
dbt run --select stg_customers+                     # 2  model + downstream
dbt build --select @dim_customers                   # 3  "at" operator: model, descendants, and
                                                    #    all ancestors of those descendants
dbt run --select tag:finance --exclude path:models/legacy   # 4
dbt run --select 2+fct_orders                       # 5  up to 2 generations of parents
```
More selectors: `path:models/marts`, `config.materialized:incremental`, `source:crm+`, `resource_type:snapshot`, `test_type:unit`, `state:modified+`, `result:error+` (with `--state` from a previous run). Intersection uses commas: `--select tag:finance,config.materialized:table`. Union uses spaces.

Reusable named selections go in **`selectors.yml`** (e.g. a `nightly_finance` selector) so jobs don't copy long CLI strings.

`@` is the one people forget: it's what you need when building a model in a fresh environment so its children's *other* parents exist too.

#### What interviewers look for
Fluency, the `@` operator, union vs intersection, selectors.yml.

#### Follow-up
Re-run only models that failed (or were skipped) in the last run? (`dbt retry`.)

### [dbt-011] ref, source and why hard-coded table names hurt
level: easy
tags: ref, source, lineage

#### Question
Why use `{{ ref() }}` and `{{ source() }}` instead of writing `analytics.marts.orders`? What are sources for besides naming?

#### Answer
`ref()`:
- Builds the **DAG** — dbt knows dependencies and runs models in the right order.
- Resolves to the **right environment**: dev schema in dev, prod in prod, CI schema in CI — the same code works everywhere.
- Enables lineage graphs, docs, `--defer`, selection with `+`, and impact analysis.

`source()`:
- Declares raw tables once in YAML (database/schema/identifier can vary by environment).
- **Freshness checks:** `loaded_at_field` with `warn_after`/`error_after` → `dbt source freshness`.
- Tests on raw data at the entry point.
- Lineage starts at sources; `source:crm+` selects everything built from a system.

Hard-coding breaks environment isolation (dev queries hitting prod), hides dependencies (wrong build order, models silently stale), and makes renames painful.

Rule: models reference other models only with `ref`, raw data only with `source`, and staging models are the **only** layer that reads sources directly.

#### What interviewers look for
DAG + environment resolution + freshness, and the staging-only-reads-sources rule.

#### Follow-up
How do you reference a table owned by another team's dbt project? (Cross-project `ref` with dbt Mesh, or declare it as a source.)

### [dbt-012] The custom schema surprise: generate_schema_name
level: medium
tags: macros, environments, Jinja

#### Question
You set `+schema: marts` on your marts folder. In production the tables land in `analytics_marts` instead of `marts`. Why? How do you make prod use `marts` exactly while dev stays isolated?

#### Answer
dbt's default `generate_schema_name` macro **concatenates** target schema + custom schema: `<target.schema>_<custom_schema>`. With `target.schema = analytics`, `+schema: marts` → `analytics_marts`. This is by design: in dev (`target.schema = dbt_alice`) you get `dbt_alice_marts`, so developers never overwrite each other or prod.

Override the macro to behave differently per environment:
```sql
-- macros/generate_schema_name.sql
{% macro generate_schema_name(custom_schema_name, node) -%}
    {%- if target.name == 'prod' and custom_schema_name is not none -%}
        {{ custom_schema_name | trim }}                 {# prod: exactly "marts" #}
    {%- elif custom_schema_name is none -%}
        {{ target.schema }}
    {%- else -%}
        {{ target.schema }}_{{ custom_schema_name | trim }}   {# dev/CI: dbt_alice_marts #}
    {%- endif -%}
{%- endmacro %}
```
dbt also ships `generate_schema_name_for_env` which implements this pattern. The same idea applies to `generate_database_name` and `generate_alias_name`.

#### What interviewers look for
Knowing the concatenation default, why it exists, and the override.

#### Follow-up
Two models in different folders want the same table name in different schemas — how? (`alias` config.)

### [dbt-013] Hooks, grants and query tags
level: medium
tags: hooks, grants, operations

#### Question
After each model builds you must grant SELECT to the BI role, tag queries for cost tracking, and once per run log the run to an audit table. How do you do each in dbt?

#### Answer
```yaml
# dbt_project.yml
models:
  my_project:
    +query_tag: "dbt_{{ target.name }}"          # Snowflake query tag on every query
    marts:
      +grants:
        select: ['BI_READER']                    # declarative grants (dbt 1.2+)
      +post-hook:
        - "ALTER TABLE {{ this }} SET COMMENT = 'Built by dbt run {{ invocation_id }}'"

on-run-start:
  - "CREATE TABLE IF NOT EXISTS audit.dbt_runs (invocation_id STRING, started_at TIMESTAMP, target STRING)"
on-run-end:
  - "INSERT INTO audit.dbt_runs VALUES ('{{ invocation_id }}', CURRENT_TIMESTAMP(), '{{ target.name }}')"
  - "{{ log_results(results) }}"                 # a macro that writes each model's status/timing
```
- **`grants` config** is better than post-hook GRANT statements: dbt applies only the needed changes and re-applies them after table rebuilds. On Snowflake also consider `copy_grants: true`, or rely on future grants.
- **pre/post-hooks** run before/after each model — for things like `ALTER SESSION`, clustering, comments, row access policies.
- **on-run-start / on-run-end** run once per invocation; `on-run-end` receives `results` (status, timing, rows affected) — great for run logging/observability.
- **query_tag** (Snowflake) for cost attribution per model/project/env.
- Hooks are SQL strings rendered with Jinja; keep them idempotent.

#### What interviewers look for
Using `grants` instead of hooks for permissions, `on-run-end` results for observability, cost tagging.

#### Follow-up
Run each heavy model on a bigger warehouse? (`snowflake_warehouse` config per model/folder.)

### [dbt-014] Ephemeral models — useful or harmful?
level: medium
tags: ephemeral, design

#### Question
A teammate made 40 intermediate models `ephemeral` "to save storage". Builds got slower and debugging got harder. Explain why and when ephemeral is appropriate.

#### Answer
Ephemeral models aren't built in the warehouse; dbt **inlines their SQL as CTEs** into every downstream model.

Problems at scale:
- **Repeated computation:** an ephemeral model used by 5 downstream models is computed 5 times.
- **Giant compiled SQL:** chains of ephemeral models produce very long queries that are hard to read and optimise.
- **Hard to debug:** you can't `SELECT * FROM` an ephemeral model to inspect its output.
- Can't be queried by other tools; limited support in some operations (e.g. can't be the target of some macros, tricky with `dbt show`).

Appropriate: very small, light logic (a few columns renamed/derived) used by one or two models, early in the DAG.

Better alternatives: **views** (cheap — no storage, inspectable, one definition) or **tables** for heavy, reused intermediate steps. Storage on Snowflake is cheap relative to compute; computing the same thing many times costs more.

#### What interviewers look for
Understanding inlining, compute vs storage trade-off, debuggability.

#### Follow-up
How do you find models that are expensive *and* heavily reused? (Model timing from `run_results.json` + number of children in the manifest.)

### [dbt-015] Project structure: staging, intermediate, marts
level: easy
tags: project structure, conventions

#### Question
Describe how you structure a dbt project and the naming conventions. What belongs in each layer?

#### Answer
```
models/
  staging/            one folder per source system
    stripe/
      _stripe__sources.yml
      _stripe__models.yml
      stg_stripe__payments.sql
  intermediate/       business logic building blocks, by domain
    finance/
      int_payments_pivoted_to_orders.sql
  marts/              business-facing, by domain/consumer
    finance/
      fct_orders.sql
      dim_customers.sql
```
- **Staging** (`stg_<source>__<entity>`): 1:1 with source tables; rename, cast, light cleanup (e.g. cents → currency), dedupe. No joins, no business logic. Usually views. The **only** layer that uses `source()`.
- **Intermediate** (`int_…`): joins, aggregations, re-graining — reusable steps toward marts. Not exposed to end users.
- **Marts** (`fct_`, `dim_`, or wide entity tables): the products for BI/ML — documented, tested, contracted.

Conventions that matter: consistent names, a primary key on every model, YAML docs per folder, a `_<dir>__models.yml` pattern, macros in `macros/`, seeds only for small static lookup data, and tests concentrated at sources and marts.

#### What interviewers look for
Clear layer responsibilities and consistency.

#### Follow-up
Where would you put a model used by both finance and marketing marts? (Intermediate or a shared mart; avoid marts depending on other domains' marts when possible.)

### [dbt-016] dbt on Snowflake: transient, clustering, warehouses, copy_grants
level: medium
tags: dbt-snowflake, configs

#### Question
List the Snowflake-specific dbt configs you'd consider for a 3 TB incremental fact table and its marts.

#### Answer
```sql
{{ config(
    materialized = 'incremental',
    unique_key   = 'order_line_id',
    incremental_strategy = 'merge',
    transient    = false,              -- dbt-snowflake default is TRANSIENT (no Fail-safe)
    cluster_by   = ['order_date'],     -- adds a clustering key
    snowflake_warehouse = 'TRANSFORM_L_WH',   -- bigger warehouse just for this model
    copy_grants  = true,               -- keep grants when the table is recreated
    query_tag    = 'dbt_fct_order_lines'
) }}
```
- **transient:** default `true` in dbt-snowflake → no Fail-safe and ≤1 day Time Travel. Set `false` for anything hard to rebuild (incremental history, snapshots).
- **cluster_by / automatic_clustering:** for large tables with consistent filters; dbt orders data by the key on full builds.
- **snowflake_warehouse:** right-size per model instead of one big warehouse for everything.
- **copy_grants:** preserve grants on `CREATE OR REPLACE`.
- **secure:** create secure views (for sharing).
- **query_tag:** cost attribution.
- **Dynamic tables:** `materialized='dynamic_table'` with `target_lag` and `snowflake_warehouse`.
- Python models run via Snowpark on Snowflake.

#### What interviewers look for
Knowing the transient default and practical per-model tuning.

#### Follow-up
Why might `cluster_by` on a small table be harmful? (Reclustering cost with no pruning benefit.)

### [dbt-017] A dbt run that takes 4 hours
level: hard
tags: performance, threads, optimization

#### Question
The nightly `dbt build` takes 4 hours and keeps growing. How do you analyse and speed it up?

#### Answer
**1. Measure, don't guess.**
- `run_results.json` → execution time per model; the critical path in the DAG (dbt docs / artifacts tools / orchestrator Gantt view).
- Snowflake query history by `query_tag` → which models consume the most credits, spill, or scan the most.

**2. Fix the biggest offenders:**
- Convert large full-rebuild tables to **incremental** (or microbatch).
- Add `incremental_predicates` to big merges; switch to `delete+insert` by date where appropriate.
- Stop rebuilding unchanged history (full refresh weekly at most, not nightly).
- Rewrite slow SQL: filter early, avoid fan-out joins, avoid views-on-views chains for heavy logic.

**3. Parallelism:**
- Increase `threads` (Snowflake handles many concurrent queries; pair with a multi-cluster warehouse if queuing appears).
- Break long serial chains in the DAG; a single slow model on the critical path dominates total time.

**4. Right-size compute:** larger warehouse for the few heavy models (`snowflake_warehouse` config), small for the rest.

**5. Run less:**
- Not everything needs to run nightly: tag models by schedule (hourly/daily/weekly).
- Source freshness-driven runs: `--select source_status:fresher+` builds only models whose sources got new data.
- Make tests cheaper: `where` configs on huge tables, fewer redundant tests.

**6. Platform:** newer dbt engines (dbt v2 / Fusion) parse and compile faster on huge projects, but SQL execution time is usually the real bottleneck.

#### What interviewers look for
Data-driven approach, critical path thinking, incremental/parallelism/compute levers, and "run less".

#### Follow-up
How would you set and monitor an SLA "marts ready by 6 am"? (Orchestrator SLA alert, model timing trends, freshness checks on marts.)

### [dbt-018] Debugging a failing dbt model
level: easy
tags: debugging, compiled SQL

#### Question
A model fails in production with a SQL error you can't reproduce locally. How do you debug?

#### Answer
1. **Read the compiled SQL:** `target/compiled/<project>/models/...sql` (Jinja rendered) and `target/run/...` (the actual DDL/DML executed, e.g. the MERGE). Paste into Snowflake and run it.
2. **Compare environments:** the difference is usually `target` (prod vars, `target.name` branches in macros), different data (NULLs, new values, duplicates), different permissions, or an incremental run in prod vs full build locally.
3. Reproduce the **incremental path** locally: build once, then run again (or use `--defer` to prod).
4. `dbt debug` (connection/profile), `dbt compile -s model`, `dbt show -s model --limit 10` (preview results), `dbt ls -s +model` (what would run).
5. Logs: `logs/dbt.log`, `--debug` flag; Snowflake query history with the dbt `query_tag` to see the exact failing statement and error.
6. `--empty` builds models with zero rows to validate SQL and schemas cheaply.
7. After fixing: `dbt retry` to resume from the failure point.

Typical root causes: schema drift in a source, duplicate keys in a merge source (non-deterministic merge error), data type overflow, a reserved word as a column, permissions after an object was recreated.

#### What interviewers look for
Going to compiled/run SQL first, environment differences, the incremental-path trap.

#### Follow-up
How do you stop the same class of bug next time? (Add a test, contract, or source freshness/schema check that would have caught it.)

### [dbt-019] Packages worth knowing
level: medium
tags: packages, dbt_utils, audit_helper

#### Question
Which dbt packages do you use regularly and for what? How would you validate a migration from a legacy SQL pipeline to dbt?

#### Answer
- **dbt_utils:** `generate_surrogate_key`, `date_spine`, `star` (select all columns except…), `union_relations`, `pivot`, `deduplicate`, tests like `equal_rowcount`, `expression_is_true`, `unique_combination_of_columns`, `accepted_range`.
- **dbt-expectations:** Great-Expectations-style tests (value ranges, regex, row counts between, recency).
- **audit_helper:** compare two relations or queries row-by-row — **the migration tool**: `compare_relations`, `compare_queries`, `compare_column_values`.
- **codegen:** generate source YAML and base models from existing tables.
- **dbt_project_evaluator:** checks the project against best-practice rules (naming, direct source references in marts, missing tests/docs).
- Observability packages (e.g. ones that upload run artifacts into tables).

**Migration validation with audit_helper:**
```sql
{% set old_query %} SELECT * FROM legacy.reporting.orders_summary {% endset %}
{% set new_query %} SELECT * FROM {{ ref('fct_orders_summary') }} {% endset %}
{{ audit_helper.compare_queries(a_query=old_query, b_query=new_query,
                                primary_key='order_id', summarize=true) }}
```
Output: % of rows in both, only in A, only in B. Then drill into mismatching columns. Run it for several periods, and reconcile totals (revenue, counts) with business owners before switching consumers.

Pin package versions in `packages.yml` and upgrade deliberately.

#### What interviewers look for
Concrete usage, especially the migration-validation workflow.

#### Follow-up
What's a surrogate key and why hash it? (`generate_surrogate_key` → deterministic MD5 of natural key columns; stable across rebuilds, handles composite keys.)

### [dbt-020] Orchestrating dbt with Airflow
level: medium
tags: Airflow, Cosmos, orchestration

#### Question
How would you run dbt from Airflow? Compare running `dbt build` as one task, rendering each model as a task (Cosmos), and triggering dbt platform jobs.

#### Answer
| approach | pros | cons |
|---|---|---|
| **One task: `dbt build`** (BashOperator/KubernetesPodOperator) | simple; dbt handles ordering and parallelism | a failure means re-running from Airflow is coarse (use `dbt retry`); no per-model visibility in Airflow |
| **Cosmos** (`astronomer-cosmos`): each model/test becomes an Airflow task or task group | model-level retries, visibility, mix dbt with non-dbt tasks precisely | huge DAGs for big projects; parsing overhead; Airflow scheduling overhead per model |
| **Trigger a dbt platform (Cloud) job** via the provider operator | dbt platform handles environments, docs, CI; Airflow just coordinates | two systems to monitor; licence cost |

Good practice regardless of approach:
- Run dbt in an **isolated environment** (container/venv) so dbt dependencies don't conflict with Airflow's.
- Pass the **logical date** as a var for date-partitioned models — not "today".
- Trigger dbt when data lands (Airflow assets/sensors) instead of a fixed time.
- Split by domain/schedule (`--select tag:hourly`), not one monolithic run.
- Persist `run_results.json`/`manifest.json` for observability and slim runs.

For most teams: start with **one task per domain selection**, move to Cosmos when model-level control in Airflow is really needed.

#### What interviewers look for
Trade-offs, isolation, logical dates, event-driven triggering.

#### Follow-up
Airflow retries a failed dbt task — how do you avoid re-running 400 successful models? (`dbt retry` using the previous run's artifacts, or Cosmos task-level retries.)

### [dbt-021] Semantic layer and metrics
level: medium
tags: semantic layer, MetricFlow, metrics

#### Question
Why do companies add a semantic layer (dbt Semantic Layer / MetricFlow) on top of marts? How does it relate to AI analytics?

#### Answer
Problem: "revenue" is calculated differently in five dashboards (gross vs net, with/without refunds, by order date vs ship date). Metrics live in BI tools, spreadsheets and ad-hoc SQL.

A **semantic layer** defines entities, dimensions, measures and metrics **once**, in code, and generates the SQL for any requested slice:
```yaml
semantic_models:
  - name: orders
    model: ref('fct_orders')
    defaults: {agg_time_dimension: order_date}
    entities:
      - {name: order_id, type: primary}
      - {name: customer, type: foreign, expr: customer_id}
    dimensions:
      - {name: order_date, type: time, type_params: {time_granularity: day}}
      - {name: channel, type: categorical}
    measures:
      - {name: net_revenue, agg: sum, expr: amount - refunds}

metrics:
  - name: net_revenue
    label: Net revenue
    type: simple
    type_params: {measure: net_revenue}
```
Benefits: consistent numbers everywhere, metrics reviewed in git, joins handled automatically (MetricFlow knows the entity graph), and BI tools/notebooks/APIs query metrics by name.

**AI link:** text-to-SQL over raw tables guesses joins and definitions. Grounding AI on a semantic layer (dbt Semantic Layer, or Snowflake semantic views for Cortex Analyst) gives much more accurate, governed answers — the AI chooses *metrics and dimensions*, and the layer writes correct SQL.

#### What interviewers look for
The business problem, the core concepts, and the AI-grounding argument.

#### Follow-up
Semantic layer in dbt vs in the BI tool vs in Snowflake semantic views — how to choose? (Where most consumers are; avoid defining metrics twice; check integrations with your BI and AI tools.)
