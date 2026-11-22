### [af-001] Airflow architecture — components and what each does
level: easy
tags: architecture, Airflow 3

#### Question
Name Airflow's main components and what each does. What changed in Airflow 3's architecture?

#### Answer
- **Scheduler** — decides which task instances should run (schedules, dependencies, retries) and hands them to the executor.
- **DAG processor** — parses DAG files into serialized DAGs stored in the metadata DB. In Airflow 3 it's a **separate process you must run** (`airflow dag-processor`).
- **Executor** — *how* tasks run: locally, on Celery workers, as Kubernetes pods, etc.
- **Workers** — execute task code.
- **Triggerer** — runs async triggers for **deferrable** operators/sensors (waiting without occupying a worker slot).
- **Metadata database** (Postgres/MySQL) — state of DAG runs, task instances, connections, variables, XComs.
- **API server / UI** — in Airflow 3 the web server is replaced by an **API server** that serves the UI and the REST API.

**Airflow 3 architectural change:** tasks **no longer have direct access to the metadata database**. Workers talk to the API server through the **Task Execution API** / Task SDK. This improves security and isolation and enables running tasks in remote/other environments ("edge" workers) and in other languages over time.

Other notable Airflow 3 items: DAG versioning (UI shows which version of the DAG a run used), assets (renamed from datasets), a new React UI, backfills managed by the scheduler.

#### What interviewers look for
Correct roles, especially triggerer and DAG processor, and the Airflow 3 isolation change.

#### Follow-up
What happens if the scheduler goes down mid-run? (Running tasks finish (or are adopted when it restarts); no new tasks scheduled; run multiple schedulers for HA — supported since Airflow 2.)

### [af-002] logical_date, data intervals and idempotent tasks
level: medium
tags: scheduling, logical_date, idempotency

#### Question
A daily DAG runs at 00:30 on 2026-11-22 and loads "yesterday's" data. What is the run's `logical_date` and data interval? Why should tasks use them instead of `datetime.now()`?

#### Answer
With the classic interval-based schedule, a run **covers a data interval and starts after it ends**. The run that starts on 2026-11-22 covers `data_interval_start = 2026-11-21 00:00` to `data_interval_end = 2026-11-22 00:00`, and its `logical_date` (formerly `execution_date`) is the interval start: 2026-11-21. This confuses everyone at first.

Airflow 3 nuance: a raw cron string now defaults to `CronTriggerTimetable` (`create_cron_data_intervals = False`) — runs are treated as **points in time** and `logical_date` equals the time the run is triggered, with no data interval. If your DAG logic depends on intervals, use `CronDataIntervalTimetable` explicitly or calculate the window yourself.

Use the run's dates, not the clock:
```python
@task
def load(data_interval_start=None, data_interval_end=None):
    sql = f"""
      DELETE FROM sales WHERE sale_date >= '{data_interval_start:%Y-%m-%d}'
                          AND sale_date <  '{data_interval_end:%Y-%m-%d}';
      INSERT INTO sales SELECT … WHERE … same window …;
    """
```
(Jinja templates: `{{ data_interval_start }}`, `{{ ds }}`.)

Why: **idempotency and reruns.** If you rerun last Tuesday's run, or backfill March, `now()` would load *today's* data again. With interval-based parameters, every run always processes exactly its own window, and reruns overwrite the same window — same input → same output.

#### What interviewers look for
Interval semantics, the Airflow 3 timetable default change, and idempotency.

#### Follow-up
A run for 2026-11-21 is cleared and re-run a week later. What data does it process? (Its own interval — if tasks are written properly.)

### [af-003] Catchup and backfill
level: medium
tags: catchup, backfill, Airflow 3

#### Question
You deploy a new DAG with `start_date = 2026-01-01` and a daily schedule on 2026-11-22. What happens? How do you backfill historical data safely?

#### Answer
- **`catchup=True`:** the scheduler creates runs for every missed interval since `start_date` — ~325 runs at once (bounded by `max_active_runs`).
- **`catchup=False`:** only the latest interval is scheduled.
- **Airflow 3 changed the default:** `catchup_by_default` is now **False**. In Airflow 2 the default was True, a common source of surprise backfills. Be explicit in every DAG.

Safe backfill:
- Airflow 3 runs backfills **through the scheduler**, triggered from the UI, API or CLI (`airflow backfill create --dag-id … --from-date … --to-date …`), with options such as max active runs and whether to reprocess existing runs.
- Limit parallelism (`max_active_runs`, pools) so you don't overload sources or Snowflake.
- Tasks must be idempotent and parameterised by the run's interval (previous problem).
- Consider whether a single bulk SQL backfill (one query for the whole year) is far cheaper than 325 daily runs — often it is.
- Warn downstream consumers; check source system rate limits.

Also: `start_date` should be a fixed date — never `datetime.now()` (dynamic start dates confuse the scheduler).

#### What interviewers look for
Knowing catchup semantics, the Airflow 3 default change, and a responsible backfill plan.

#### Follow-up
`depends_on_past=True` — what does it do during a backfill? (A task runs only if its previous run succeeded — enforces order but one failure blocks everything after it.)

### [af-004] Choosing an executor
level: medium
tags: executors, scaling

#### Question
Compare LocalExecutor, CeleryExecutor and KubernetesExecutor. Which would you choose for (a) a small team, (b) hundreds of short tasks per minute, (c) tasks with very different dependencies and resource needs?

#### Answer
| executor | how tasks run | strengths | weaknesses |
|---|---|---|---|
| **Local** | subprocesses on the scheduler machine | simple, no extra infra | limited to one machine |
| **Celery** | on a pool of long-running workers via a queue (Redis/RabbitMQ) | low latency per task, high throughput, worker queues for routing | workers must have all dependencies; idle cost; manage the broker |
| **Kubernetes** | each task in its own pod | isolation, per-task resources/images, scales to zero | pod start-up latency (seconds), K8s complexity |

Choices: **(a)** Local (or a managed service); **(b)** Celery — fast start, warm workers; **(c)** Kubernetes — per-task images and resources.

Airflow 2.10+/3 supports **multiple executors at once** (configure several and set `executor=` per task or DAG), replacing the old CeleryKubernetesExecutor hybrid. Managed options (Astronomer, MWAA, Cloud Composer) handle much of this.

Independent of executor: heavy compute should run **in the target system** (Snowflake, Spark), with Airflow orchestrating — not processing GBs in the worker.

#### What interviewers look for
Trade-offs tied to workload shape, multi-executor awareness, and "orchestrate, don't process".

#### Follow-up
Some tasks need GPUs — how do you route them? (Kubernetes pod overrides with node selectors, or a Celery queue with GPU workers.)

### [af-005] XCom — what it's for and how people misuse it
level: easy
tags: XCom, TaskFlow

#### Question
What is XCom? A teammate passes a 2 GB pandas DataFrame between tasks with XCom. What's wrong, and what should they do?

#### Answer
**XCom** ("cross-communication") lets tasks pass **small** pieces of data: IDs, file paths, row counts, a query id. With the TaskFlow API, return values become XComs automatically:
```python
@task
def extract(ds=None) -> str:          # Airflow injects the run's date
    path = f"s3://bucket/raw/orders/{ds}.parquet"
    # … write the data there …
    return path                    # small: just the location

@task
def load(path: str):
    run_sql(f"COPY INTO raw.orders FROM '{path}' …")

load(extract())
```
By default XComs are stored in the **metadata database**. Large values bloat the DB, slow the scheduler/UI, and can hit size limits.

Fix: pass **references, not data** — write the DataFrame to object storage (or a staging table) and pass the path/table name. If you really need larger XComs, configure an **object-storage XCom backend** so values are stored in S3/GCS and only a reference goes to the DB.

Even better for data pipelines: don't move data through Airflow workers at all — let Snowflake read the files (COPY) and transform in SQL.

#### What interviewers look for
"References, not data", the DB impact, and custom XCom backends.

#### Follow-up
How do you pull an XCom from a task in another DAG? (Possible via `xcom_pull(dag_id=…)`, but it couples DAGs — prefer assets or a shared table/marker.)

### [af-006] Sensors: poke, reschedule and deferrable
level: medium
tags: sensors, deferrable operators, triggerer

#### Question
You have 200 sensors waiting for files that may arrive any time within 6 hours. Workers are exhausted and other tasks can't start. Why, and how do you fix it?

#### Answer
In **`poke`** mode, a sensor occupies a worker slot for its whole wait — 200 sensors = 200 slots doing nothing but sleeping.

Options:
- **`mode="reschedule"`** — the sensor checks, then releases its slot and is rescheduled for the next check. Good for long waits with infrequent checks (minutes).
- **Deferrable sensors/operators** (`deferrable=True` on many provider sensors, or `*Async` variants) — the task hands its wait to the **triggerer**, an async process that can watch thousands of conditions cheaply. The task resumes on a worker only when the condition is met. Best option for many long waits — requires the triggerer to be running.
- **Event-driven instead of polling:** let the file arrival *trigger* the pipeline (cloud event → Airflow REST API / asset event, or Snowpipe auto-ingest and then an asset-triggered DAG).

Always set `timeout` (fail after N hours), a sensible `poke_interval`, and `soft_fail` if a missing file should skip rather than fail. Use pools to cap the number of concurrent sensors.

#### What interviewers look for
Explaining slot usage, the triggerer, and preferring event-driven design.

#### Follow-up
How does a deferrable operator survive a triggerer restart? (Trigger state is stored; triggers are re-created on another triggerer.)

### [af-007] Dynamic task mapping
level: medium
tags: dynamic task mapping, TaskFlow

#### Question
Each day, an unknown number of files (0 to 500) arrive. You want one task per file, retried independently. How do you do this without generating DAG code dynamically?

#### Answer
**Dynamic task mapping** creates task instances at **runtime** from a list:
```python
from airflow.sdk import dag, task      # Airflow 3 import path (Airflow 2: from airflow.decorators import dag, task)
import pendulum

@dag(schedule="@daily", start_date=pendulum.datetime(2026, 1, 1, tz="UTC"), catchup=False)
def load_files():

    @task
    def list_files(ds=None) -> list[str]:
        return list_s3_keys(prefix=f"raw/orders/{ds}/")   # 0..500 keys

    @task(retries=3, max_active_tis_per_dag=20)           # limit parallel copies
    def load_one(key: str, target: str):
        copy_into_snowflake(key, target)

    load_one.partial(target="RAW.ORDERS").expand(key=list_files())

load_files()
```
- `.expand()` maps over the list; `.partial()` fixes the constant arguments.
- Each mapped instance has its own index, logs, retries and state.
- **Zero files** → the mapped task is skipped (not failed) — handle downstream with trigger rules if needed.
- Map over pairs with `expand_kwargs`, or chain mapped tasks (map → map).
- Limits: `max_map_length` config; control concurrency with `max_active_tis_per_dag` or pools.

Alternative design question: is one task per file right? For 500 small files, a single `COPY INTO … PATTERN` is far faster and cheaper — use mapping when per-item work is genuinely independent and heavy (API calls per customer, per-tenant pipelines).

#### What interviewers look for
Correct API, concurrency control, zero-length behaviour, and judging when not to map.

#### Follow-up
Reduce after mapping — sum row counts from all mapped tasks? (A downstream task receiving the mapped output list: `summarize(load_one.expand(...))`.)

### [af-008] Trigger rules and the branching skip trap
level: medium
tags: trigger rules, branching

#### Question
A DAG branches: `check_day` → either `full_load` or `incremental_load` → `notify`. On every run `notify` is **skipped**. Why? Fix it, and list the important trigger rules.

#### Answer
The branch task skips the path not taken. `notify` has the default trigger rule **`all_success`**, which requires *all* upstream tasks to succeed. One upstream is skipped → `notify` is skipped too (skips propagate).

Fix:
```python
@task.branch
def check_day(logical_date=None):
    return "full_load" if logical_date.weekday() == 6 else "incremental_load"

@task(trigger_rule="none_failed_min_one_success")
def notify(): ...

check_day() >> [full_load, incremental_load] >> notify()
```
Trigger rules to know:
| rule | runs when |
|---|---|
| `all_success` (default) | all parents succeeded |
| `all_failed` | all parents failed |
| `all_done` | all parents finished, any state — cleanup tasks |
| `one_success` / `one_failed` | as soon as one parent succeeds / fails |
| `none_failed` | no parent failed (skips OK) |
| `none_failed_min_one_success` | no failures and at least one success — **the join-after-branch rule** |
| `none_skipped` | no parent skipped |
| `always` | regardless |

Related: `ShortCircuitOperator` / `@task.short_circuit` skips everything downstream when a condition is false (e.g. "no new data today").

#### What interviewers look for
Skip propagation explained, the right rule, and knowing the table.

#### Follow-up
A cleanup task must run even if the load fails, but the DAG run should still show as failed. How? (`trigger_rule="all_done"` on cleanup; the run state is determined by leaf tasks — add a final check task, or rely on the failed task being a leaf.)

### [af-009] Pools, concurrency and priority
level: medium
tags: pools, concurrency, resource management

#### Question
Many DAGs call the same vendor API, which allows only 5 concurrent requests. Also, critical finance DAGs must run before ad-hoc ones when resources are tight. How do you configure Airflow?

#### Answer
- **Pools** cap concurrency for a shared resource across **all** DAGs:
```python
# create pool "vendor_api" with 5 slots (UI/CLI: airflow pools set vendor_api 5 "vendor limit")
@task(pool="vendor_api", pool_slots=1, priority_weight=10)
def call_vendor(): ...
```
- **`priority_weight`** decides which queued tasks get slots first; `weight_rule` (`downstream` default, `upstream`, `absolute`) controls how weights are summed.
- **DAG-level limits:** `max_active_runs` (concurrent runs of a DAG), `max_active_tasks` (concurrent tasks in a DAG).
- **Task-level:** `max_active_tis_per_dag` (instances of one task across runs).
- **Global:** `parallelism` (max running tasks for the whole installation per scheduler config), executor capacity, worker concurrency.

For Snowflake-heavy tasks, also consider a pool sized to what your warehouse can handle without queuing (or use multi-cluster warehouses).

#### What interviewers look for
Pools for shared resources, priority weights, and the levels of concurrency limits.

#### Follow-up
A task needs 3 "units" of a resource? (`pool_slots=3`.)

### [af-010] DAG parsing performance and top-level code
level: medium
tags: best practices, performance

#### Question
The Airflow UI is slow, DAGs take minutes to appear, and the database is under load. A DAG file starts with `rows = snowflake.query("SELECT …")` and `Variable.get(...)` at the top. What's wrong?

#### Answer
DAG files are **parsed repeatedly** (by default every ~30 seconds per file) by the DAG processor. **Top-level code** — anything outside task functions — runs on *every parse*, not when tasks run. So:
- Database/API calls at the top level hit Snowflake/the API constantly and slow parsing.
- `Variable.get()` at the top level queries the metadata DB on every parse.
- Heavy imports (pandas, ML libraries) slow parsing too.

Fixes:
- Move logic into tasks; fetch values at runtime.
- Use Jinja templates for Variables/connections: `"{{ var.value.my_setting }}"` — resolved at run time.
- Import heavy libraries inside the task function.
- Generate dynamic structures with **dynamic task mapping** at runtime instead of querying at parse time.
- Tune `min_file_process_interval`, use `.airflowignore` for non-DAG files.
- Check parse times: `airflow dags report` / DAG processor stats in the UI.

#### What interviewers look for
Understanding parse vs run time — the most common Airflow anti-pattern.

#### Follow-up
You must generate 50 similar DAGs from a config file — acceptable? (Yes, from a *static* local YAML/JSON file read quickly at parse time; not from a database call.)

### [af-011] Data-aware scheduling with assets
level: medium
tags: assets, datasets, event-driven

#### Question
The marketing DAG runs at 7 am "because ingestion usually finishes by 6:30". Some days ingestion is late and marketing reports use stale data. How do assets solve this?

#### Answer
**Assets** (called **datasets** in Airflow 2) let DAGs be scheduled by **data updates** instead of time. A producer task declares it updates an asset; consumer DAGs run when the asset is updated.
```python
from airflow.sdk import Asset, dag, task

orders_asset = Asset("snowflake://analytics/raw/orders")

@dag(schedule="@daily", ...)
def ingest():
    @task(outlets=[orders_asset])          # marks the asset as updated on success
    def load_orders(): ...
    load_orders()

@dag(schedule=[orders_asset], ...)         # runs whenever orders_asset is updated
def marketing():
    ...
```
- Multiple assets: `schedule=(asset_a & asset_b)` or `(asset_a | asset_b)` (conditional expressions).
- Combine time + data: `AssetOrTimeSchedule`.
- External systems can create asset events via the REST API (e.g. "file landed").
- Assets appear in the UI as lineage between DAGs.
- Airflow 3.x adds more (asset partitions, watchers that react to external events such as messages in a queue).

The asset URI is just an identifier — Airflow doesn't check the data itself. Pair with data-quality checks before emitting the update.

#### What interviewers look for
Moving from time-based guessing to data-driven triggering, syntax, and the "identifier only" caveat.

#### Follow-up
Asset vs `ExternalTaskSensor` vs `TriggerDagRunOperator`? (Next problem.)

### [af-012] Retries, alerts and failure handling
level: easy
tags: retries, callbacks, reliability

#### Question
How do you configure a task that calls a flaky API so that transient failures retry automatically, but real failures alert the on-call engineer quickly?

#### Answer
```python
from datetime import timedelta

default_args = {
    "retries": 3,
    "retry_delay": timedelta(minutes=2),
    "retry_exponential_backoff": True,        # 2, 4, 8 … minutes
    "max_retry_delay": timedelta(minutes=30),
    "execution_timeout": timedelta(minutes=20),  # kill hung tasks
    "on_failure_callback": alert_on_call,     # fires after final failure
    "on_retry_callback": log_retry,
}
```
- **Distinguish transient from permanent errors:** for permanent errors (bad credentials, schema mismatch), raise `AirflowFailException` to fail immediately without retries.
- `execution_timeout` prevents hung tasks; DAG-level `dagrun_timeout` limits whole runs.
- Alerts: callbacks to Slack/PagerDuty/email (provider notifiers); include DAG, task, logical date, log URL, and a runbook link.
- **Retries require idempotent tasks** — a retry must not double-load data.
- Missed deadlines: SLA misses were removed in Airflow 3; newer versions add **deadline alerts** to notify when a run hasn't finished by a time.

#### What interviewers look for
Backoff, timeouts, failing fast on permanent errors, and idempotency.

#### Follow-up
Retry an API call within one task several times before failing the task? (Use a retry library (tenacity) inside the task for fast transient retries; Airflow retries for longer outages.)

### [af-013] Cross-DAG dependencies
level: medium
tags: dependencies, ExternalTaskSensor, TriggerDagRunOperator

#### Question
DAG B must run after DAG A finishes. Compare ExternalTaskSensor, TriggerDagRunOperator and assets. Which do you prefer?

#### Answer
| approach | how | pros | cons |
|---|---|---|---|
| **ExternalTaskSensor** (in B) | B waits for a task/DAG in A with the **same logical date** (or an offset) | B keeps its own schedule | schedules must align; misaligned dates → waits forever; occupies slots unless deferrable |
| **TriggerDagRunOperator** (in A) | A triggers B at the end | explicit, immediate | A must know about B (tight coupling); B has no schedule of its own |
| **Assets** | A updates an asset; B is scheduled on it | loose coupling; many consumers; lineage in UI | event-based only; logical dates differ between DAGs |

Preference: **assets** for most data dependencies (producer doesn't need to know consumers). TriggerDagRun for a controller/"pipeline of pipelines" pattern where A deliberately orchestrates B with parameters (`conf`). ExternalTaskSensor mostly in legacy setups or when date alignment matters strongly.

#### What interviewers look for
Coupling and date-alignment trade-offs.

#### Follow-up
B depends on A *and* C, which run at different times? (Assets with `schedule=(asset_a & asset_c)`.)

### [af-014] Connections, variables and secrets
level: easy
tags: security, secrets backend

#### Question
How should DAGs store credentials for Snowflake and APIs? Where do Variables fit? How do you keep secrets out of logs and git?

#### Answer
- **Connections** hold credentials and endpoints, referenced by `conn_id` in hooks/operators: `SnowflakeHook(snowflake_conn_id="snowflake_prod")`. Never hard-code credentials in DAG files.
- **Secrets backend** (production standard): store connections/variables in AWS Secrets Manager, GCP Secret Manager, Azure Key Vault or HashiCorp Vault; Airflow reads them at runtime. Rotation happens in one place.
- Environment variables `AIRFLOW_CONN_<ID>` / `AIRFLOW_VAR_<NAME>` for local dev and containers.
- **Variables** for small non-secret config (feature flags, thresholds). Read them in templates or inside tasks — not at the top level.
- Airflow **masks** values of connection passwords and variables whose names contain words like `password`, `secret`, `api_key` in logs and the UI; don't print secrets yourself.
- Snowflake: use **key-pair authentication** (or OAuth) for service users, with least-privilege roles.

#### What interviewers look for
Secrets backend, no hard-coding, masking, and service-account auth.

#### Follow-up
Different credentials per environment with the same DAG code? (Same `conn_id`, different secrets per environment's backend path.)

### [af-015] Testing Airflow DAGs
level: medium
tags: testing, CI

#### Question
How do you test Airflow DAGs before they reach production?

#### Answer
1. **DAG integrity test** (run in CI) — every DAG imports without errors, has no cycles, follows rules:
```python
from airflow.models import DagBag

def test_dags_load():
    bag = DagBag(dag_folder="dags/", include_examples=False)
    assert not bag.import_errors, bag.import_errors

def test_rules():
    bag = DagBag(dag_folder="dags/", include_examples=False)
    for dag_id, dag in bag.dags.items():
        assert dag.tags, f"{dag_id} needs tags"
        assert dag.default_args.get("retries", 0) >= 1, f"{dag_id} needs retries"
```
2. **Unit tests** for business logic — keep logic in plain Python functions/modules, tested with pytest, mocking hooks/APIs. Thin DAG files = easy testing.
3. **`dag.test()`** — runs a whole DAG in one process locally for debugging (no scheduler needed).
4. **Lint:** ruff with Airflow rules (`AIR` rules flag deprecated/removed Airflow 3 APIs).
5. **Integration tests** in a staging environment against dev Snowflake schemas.
6. Containerised local env (e.g. Astro CLI or docker-compose) identical to production images.

#### What interviewers look for
Layered testing, thin DAGs with logic in modules, CI automation.

#### Follow-up
How do you test a task that uses `data_interval_start`? (Call the function directly with a fixed datetime, or `dag.test(logical_date=…)`.)

### [af-016] Upgrading from Airflow 2 to Airflow 3
level: hard
tags: Airflow 3, migration, architecture

#### Question
You own 400 DAGs on Airflow 2.x. Plan the upgrade to Airflow 3. What breaks, and how do you de-risk it?

#### Answer
**Main breaking changes to check:**
- **No direct metadata DB access from tasks.** Code using `settings.Session`, querying `DagRun`/`TaskInstance` models directly, or custom operators that touch the DB must move to the REST API / Task SDK.
- **SubDAGs removed** → TaskGroups or assets.
- **Scheduling defaults:** `catchup` defaults to False; `schedule_interval` and `timetable` args removed (use `schedule`); raw cron strings now use `CronTriggerTimetable` (no data intervals by default) — DAGs relying on `data_interval_*` behaviour need review.
- **`execution_date` and some context keys removed** — use `logical_date` / data interval values.
- **Imports moved:** many `airflow.operators.*` / `airflow.sensors.*` moved to the standard provider; authoring via `airflow.sdk`.
- **Auth/UI:** new React UI; Simple Auth manager by default — FAB-based auth needs the FAB provider.
- The **DAG processor** runs as a separate component; webserver replaced by **API server**.
- SLA misses removed.

**Plan:**
1. Upgrade to the latest 2.x first; fix all deprecation warnings.
2. Run **ruff Airflow rules** (`AIR30x` mandatory, `AIR31x` recommended) across the repo; fix automatically where possible. Run the config upgrade checker.
3. Inventory risky DAGs: DB access, SubDAGs, custom plugins/operators, interval-dependent logic.
4. Stand up Airflow 3 in parallel (new environment); migrate DAGs in waves by domain; compare outputs.
5. DAG integrity tests and `dag.test()` in CI against Airflow 3 images.
6. Cutover plan with pause/unpause, run-state handover, and rollback path.

#### What interviewers look for
Concrete breaking changes (not generic "test everything"), tooling, and a phased plan.

#### Follow-up
What do you gain from Airflow 3 to justify the effort? (Security isolation, DAG versioning, scheduler-managed backfills, assets/event-driven scheduling, new UI, remote/edge execution.)
