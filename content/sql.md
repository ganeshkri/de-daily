### [sql-001] Top 3 earners in each department
level: easy
tags: window functions, ranking, QUALIFY
asked: yes

#### Question
Table `employees(emp_id, name, dept_id, salary)`. Return the top 3 earners in each department. What happens when two people tie on salary?

#### Answer
```sql
SELECT emp_id, name, dept_id, salary
FROM employees
QUALIFY DENSE_RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) <= 3;
```
Portable version (no `QUALIFY`):
```sql
WITH ranked AS (
  SELECT e.*,
         DENSE_RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS rnk
  FROM employees e
)
SELECT emp_id, name, dept_id, salary FROM ranked WHERE rnk <= 3;
```
**The tie decision is the real question.** Salaries 100, 100, 90, 80:

| function | values | rows returned for "≤ 3" |
|---|---|---|
| `ROW_NUMBER` | 1,2,3,4 | exactly 3 rows — one tied person is dropped *arbitrarily* |
| `RANK` | 1,1,3,4 | 3 rows (100,100,90) — skips 2 |
| `DENSE_RANK` | 1,1,2,3 | 4 rows — top 3 *distinct salaries* |

Say which you chose and why. "Top 3 people" → `RANK`; "top 3 salary levels" → `DENSE_RANK`; "exactly 3 rows" → `ROW_NUMBER` with a tie-breaker (`ORDER BY salary DESC, emp_id`) so results are deterministic.

#### What interviewers look for
- Asking about ties before writing code
- Knowing `QUALIFY` (Snowflake, also BigQuery/Databricks/DuckDB)
- Adding a tie-breaker to `ROW_NUMBER` — non-deterministic results are a classic production bug

#### Follow-up
How would you return departments with fewer than 3 employees too, plus the department name, including departments with zero employees? (`LEFT JOIN departments`, rank in a CTE, filter `rnk <= 3 OR rnk IS NULL`.)

### [sql-002] Employees who joined in the last 6 months
level: easy
tags: dates, sargability
asked: yes

#### Question
`employees(emp_id, name, hire_date DATE)`. List employees who joined in the last 6 months.

#### Answer
```sql
SELECT emp_id, name, hire_date
FROM employees
WHERE hire_date >= DATEADD(month, -6, CURRENT_DATE)
  AND hire_date <= CURRENT_DATE;   -- excludes future-dated joiners
```
Points to say out loud:
- **Keep the column bare** (`hire_date >= <expression>`). Writing `DATEDIFF(month, hire_date, CURRENT_DATE) <= 6` wraps the column in a function, which hurts partition pruning on large tables — and `DATEDIFF(month, …)` counts *month boundaries crossed*, not elapsed months (Jan 31 → Feb 1 = 1 month).
- **"6 months" is ambiguous**: rolling 6 months from today, or the last 6 complete calendar months? Calendar version:
  `hire_date >= DATEADD(month, -6, DATE_TRUNC(month, CURRENT_DATE)) AND hire_date < DATE_TRUNC(month, CURRENT_DATE)`
- If the column is a `TIMESTAMP_TZ/LTZ`, `CURRENT_DATE` depends on the session `TIMEZONE` parameter.

#### What interviewers look for
Clarifying the definition, sargable predicates, awareness of `DATEDIFF` boundary semantics and time zones.

#### Follow-up
Count joiners per month for the last 12 months, showing 0 for months with no joiners (needs a date spine — see the date-spine problem).

### [sql-003] Running salary total per employee
level: medium
tags: window functions, frames
asked: yes

#### Question
`salary_history(emp_id, pay_date, amount)`. For each employee, show each payment and the running total of what they've been paid so far.

#### Answer
```sql
SELECT emp_id, pay_date, amount,
       SUM(amount) OVER (
         PARTITION BY emp_id
         ORDER BY pay_date
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_total
FROM salary_history
ORDER BY emp_id, pay_date;
```
**The trap: the default frame.** With `ORDER BY` and no frame clause, the default is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. `RANGE` treats rows with the *same* `pay_date` as peers, so two payments on the same date both show the total *including each other* — the running total jumps and repeats. Writing `ROWS` explicitly (and adding a tie-breaker such as `ORDER BY pay_date, payment_id`) gives a true row-by-row total.

Same pattern, other questions they ask:
- 3-payment moving average: `AVG(amount) OVER (PARTITION BY emp_id ORDER BY pay_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)`
- Year-to-date: add `DATE_TRUNC(year, pay_date)` to the `PARTITION BY`.

#### What interviewers look for
Knowing `ROWS` vs `RANGE` and the default frame — this separates people who use window functions from people who understand them.

#### Follow-up
Why might `LAST_VALUE(amount) OVER (PARTITION BY emp_id ORDER BY pay_date)` return the *current* row's value instead of the last one? (Same default frame — needs `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`.)

### [sql-004] Departments with more than 5 employees
level: easy
tags: GROUP BY, HAVING, joins
asked: yes

#### Question
`employees(emp_id, dept_id)`, `departments(dept_id, dept_name)`. Which departments have more than 5 employees? Show the name.

#### Answer
```sql
SELECT d.dept_id, d.dept_name, COUNT(e.emp_id) AS headcount
FROM departments d
JOIN employees e ON e.dept_id = d.dept_id
GROUP BY d.dept_id, d.dept_name
HAVING COUNT(e.emp_id) > 5;
```
Discussion points:
- `WHERE` filters rows *before* grouping; `HAVING` filters groups *after*. You can't use `COUNT()` in `WHERE`.
- If the table can contain the same employee twice (history table), use `COUNT(DISTINCT e.emp_id)`.
- If they then ask for "all departments with their headcount, including empty ones": `LEFT JOIN` and `COUNT(e.emp_id)` (not `COUNT(*)`, which would count the NULL row as 1).
- Subquery version they may ask for: `WHERE dept_id IN (SELECT dept_id FROM employees GROUP BY dept_id HAVING COUNT(*) > 5)`.

#### What interviewers look for
`WHERE` vs `HAVING`, `COUNT(*)` vs `COUNT(col)` with outer joins, handling duplicates.

#### Follow-up
Return the department(s) with the *highest* headcount, including ties. (`QUALIFY RANK() OVER (ORDER BY COUNT(*) DESC) = 1` after `GROUP BY` — window functions run after aggregation.)

### [sql-005] Deduplicate rows without DISTINCT
level: medium
tags: dedup, ROW_NUMBER, DML
asked: yes

#### Question
A raw table `customers_raw(customer_id, email, updated_at, …)` has duplicates. (a) Select one row per customer — the latest. (b) Actually *remove* the duplicates from the table in Snowflake, without `DISTINCT`.

#### Answer
**(a) Select latest per key:**
```sql
SELECT *
FROM customers_raw
QUALIFY ROW_NUMBER() OVER (
          PARTITION BY customer_id
          ORDER BY updated_at DESC, _loaded_at DESC   -- tie-breaker!
        ) = 1;
```
**(b) Remove duplicates in place.** Snowflake has no `ROWID`, so the classic Oracle `DELETE … WHERE rowid NOT IN (…)` doesn't work. Options:
```sql
-- Option 1: rewrite the table atomically (keeps grants, table identity)
INSERT OVERWRITE INTO customers_raw
SELECT * FROM customers_raw
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id
                           ORDER BY updated_at DESC, _loaded_at DESC) = 1;

-- Option 2: build a clean copy and swap
CREATE OR REPLACE TABLE customers_clean AS
SELECT * FROM customers_raw
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY updated_at DESC) = 1;
ALTER TABLE customers_raw SWAP WITH customers_clean;
```
For **exact** duplicates (every column identical) `ROW_NUMBER() OVER (PARTITION BY <all columns> ORDER BY NULL)` works, or `SELECT … GROUP BY <all columns>`.

Senior-level additions:
- Fix the cause, not just the symptom: why are duplicates arriving (at-least-once delivery, re-loaded files, retries)? Make the load idempotent (MERGE on key, or `delete+insert` per batch).
- Large tables: Option 1 rewrites every micro-partition — schedule it, or dedupe only recent partitions with a date filter.
- `CREATE OR REPLACE` drops Time Travel history of the original object and grants (unless `COPY GRANTS`); `INSERT OVERWRITE` keeps the object.

#### What interviewers look for
Deterministic tie-breaker, knowing Snowflake lacks ROWID, atomic rewrite, and talking about root cause/idempotency.

#### Follow-up
How do you find *which* columns differ between duplicate rows for the same key? (`COUNT(DISTINCT col)` per key for each column, or `HASH(*)`/`HASH_AGG`.)

### [sql-006] Employees earning above their department's average
level: easy
tags: window functions, correlated subquery
asked: yes

#### Question
Return employees whose salary is above the average salary of their own department.

#### Answer
```sql
-- Window version: one pass over the table
SELECT emp_id, name, dept_id, salary
FROM employees
QUALIFY salary > AVG(salary) OVER (PARTITION BY dept_id);

-- Join version (what "using joins & subqueries" expects)
SELECT e.emp_id, e.name, e.dept_id, e.salary, d.avg_sal
FROM employees e
JOIN (SELECT dept_id, AVG(salary) AS avg_sal
      FROM employees GROUP BY dept_id) d
  ON d.dept_id = e.dept_id
WHERE e.salary > d.avg_sal;
```
Notes:
- The correlated subquery (`WHERE salary > (SELECT AVG(salary) FROM employees x WHERE x.dept_id = e.dept_id)`) is also correct; modern optimisers usually decorrelate it, but the window/join versions state intent clearly.
- `AVG` ignores NULL salaries — say whether NULLs should count as 0.
- If employees can have `dept_id IS NULL`, the window version groups them together as one "department"; the join version drops them.

#### What interviewers look for
Two approaches, and awareness of NULL behaviour.

#### Follow-up
Show each employee's difference from the department median, not the average. (`MEDIAN(salary) OVER (PARTITION BY dept_id)` in Snowflake.)

### [sql-007] Turn 1,1,1,0,0,0 into 1,0,1,0,1,0
level: medium
tags: window functions, ROW_NUMBER, ordering
asked: yes

#### Question
A table has one column `col` with values `1,1,1,0,0,0`. Write a query that outputs them alternating: `1,0,1,0,1,0`.

#### Answer
A common answer is:
```sql
SELECT CASE WHEN ROW_NUMBER() OVER (ORDER BY col) % 2 = 1 THEN 1 ELSE 0 END
FROM t;
```
**That's a trap answer** — it never reads the data. It *prints* 1,0,1,0… regardless of what's in the table (try it on six 1s). Interviewers ask this to see if you reorder the *actual rows*.

**Correct approach: number each value within its own group, then interleave.**
```sql
SELECT col AS alternating_values
FROM (
  SELECT col,
         ROW_NUMBER() OVER (PARTITION BY col ORDER BY col) AS rn
  FROM t
)
ORDER BY rn, col DESC;
```
How it works: the 1s get rn = 1,2,3 and the 0s get rn = 1,2,3. Sorting by `rn` puts pairs together (1st 1, 1st 0, 2nd 1, 2nd 0…), and `col DESC` puts the 1 before the 0 in each pair.

If counts are unequal (four 1s, two 0s), this gives `1,0,1,0,1,1` — the extras land at the end, which is the sensible behaviour. Mention it.

#### What interviewers look for
Recognising that the output must come from the data, `PARTITION BY` inside `ROW_NUMBER`, and that **SQL tables are unordered — only `ORDER BY` in the final query guarantees order.**

#### Follow-up
Interleave three categories A, B, C in round-robin order. (Same idea: `ROW_NUMBER() OVER (PARTITION BY category …)`, then `ORDER BY rn, category`.)

### [sql-008] Nth highest salary, with ties and missing values
level: medium
tags: ranking, edge cases

#### Question
Return the 2nd highest *distinct* salary in the company. If there isn't one, return NULL (not an empty result).

#### Answer
```sql
SELECT MAX(salary) AS second_highest      -- MAX over 0 rows returns NULL, not 0 rows
FROM (
  SELECT salary,
         DENSE_RANK() OVER (ORDER BY salary DESC) AS rnk
  FROM employees
  WHERE salary IS NOT NULL
)
WHERE rnk = 2;
```
Why each part:
- `DENSE_RANK` so that 100,100,90 gives 90 as 2nd (with `ROW_NUMBER` you'd get 100).
- Wrapping in `MAX()` turns "no row" into one NULL row — the requirement.
- Classic alternatives: `SELECT MAX(salary) FROM employees WHERE salary < (SELECT MAX(salary) FROM employees)` (only works for N=2), or `SELECT DISTINCT salary … ORDER BY salary DESC LIMIT 1 OFFSET 1` (returns 0 rows if missing).

#### What interviewers look for
Distinct vs positional ranking, the empty-result requirement, generalising to N.

#### Follow-up
Nth highest per department, as a reusable query where N is a parameter (`SET n = 3;` then `rnk = $n`).

### [sql-009] NOT IN and the NULL trap
level: medium
tags: NULL semantics, anti-join

#### Question
```sql
SELECT customer_id FROM customers
WHERE customer_id NOT IN (SELECT customer_id FROM orders);
```
This returns **zero rows**, although many customers have never ordered. Why? Fix it.

#### Answer
`orders.customer_id` contains at least one NULL. `x NOT IN (1, 2, NULL)` expands to `x <> 1 AND x <> 2 AND x <> NULL`. `x <> NULL` is UNKNOWN, so the whole condition is never TRUE → no rows.

Fixes:
```sql
-- NOT EXISTS: NULL-safe and usually the best anti-join
SELECT c.customer_id
FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id);

-- LEFT JOIN anti-join
SELECT c.customer_id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.customer_id
WHERE o.customer_id IS NULL;

-- or filter NULLs inside NOT IN
WHERE customer_id NOT IN (SELECT customer_id FROM orders WHERE customer_id IS NOT NULL)
```
Related NULL facts worth saying: `NULL = NULL` is not TRUE (use `IS NOT DISTINCT FROM` or `EQUAL_NULL` in Snowflake for NULL-safe equality); `IN (…, NULL)` is fine for *positive* matches.

#### What interviewers look for
Three-valued logic explained clearly, and a default habit of `NOT EXISTS`.

#### Follow-up
What does `COUNT(*) WHERE col <> 'X'` miss? (Rows where `col` is NULL.)

### [sql-010] LEFT JOIN that silently became an INNER JOIN
level: medium
tags: joins, outer join filters

#### Question
"List all customers and their 2026 orders (customers with no 2026 orders should still appear)."
```sql
SELECT c.customer_id, o.order_id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.customer_id
WHERE o.order_date >= '2026-01-01';
```
Customers without 2026 orders are missing. Why?

#### Answer
For customers with no matching order, `o.order_date` is NULL. The `WHERE` clause runs *after* the join and `NULL >= '2026-01-01'` is not TRUE, so those rows are removed — it behaves like an inner join.

Put conditions on the **right-hand table** in the `ON` clause:
```sql
SELECT c.customer_id, o.order_id
FROM customers c
LEFT JOIN orders o
  ON o.customer_id = c.customer_id
 AND o.order_date >= '2026-01-01';
```
Rule of thumb: filters on the *preserved* (left) table go in `WHERE`; filters on the *optional* (right) table go in `ON`. The exception is the deliberate anti-join, `WHERE o.customer_id IS NULL`.

#### What interviewers look for
Order of evaluation (FROM/JOIN → WHERE → GROUP BY → HAVING → window → QUALIFY → SELECT → ORDER BY) and the ON-vs-WHERE rule.

#### Follow-up
Same customers, but show the *count* of 2026 orders, 0 for none. (`COUNT(o.order_id)` with the filter in `ON`.)

### [sql-011] COUNT(*), COUNT(col), COUNT(DISTINCT) and AVG with NULLs
level: easy
tags: aggregates, NULL semantics

#### Question
Column `bonus` has values: `100, NULL, 100, 200, NULL` (5 rows). What do `COUNT(*)`, `COUNT(bonus)`, `COUNT(DISTINCT bonus)`, `SUM(bonus)`, `AVG(bonus)` return? What's the "average bonus per employee"?

#### Answer
| expression | result | why |
|---|---|---|
| `COUNT(*)` | 5 | counts rows |
| `COUNT(bonus)` | 3 | ignores NULLs |
| `COUNT(DISTINCT bonus)` | 2 | 100, 200 |
| `SUM(bonus)` | 400 | ignores NULLs |
| `AVG(bonus)` | 133.33 | 400 / 3 — NULLs excluded from the denominator |

"Average bonus per employee" probably means 400 / 5 = 80, i.e. `AVG(COALESCE(bonus, 0))` or `SUM(bonus) / COUNT(*)`. Ask whether NULL means "no bonus" (= 0) or "unknown" (exclude). That's a business question, not a SQL one.

Also: `SUM` over zero rows (or all NULLs) returns NULL, not 0 — wrap in `COALESCE(SUM(x), 0)` for reports. `COUNT` never returns NULL.

#### What interviewers look for
Precise NULL behaviour and turning it into a business clarification.

#### Follow-up
`COUNT(DISTINCT a, b)` in Snowflake — does it count rows where `a` or `b` is NULL? (No: rows with any NULL in the listed columns are excluded.)

### [sql-012] Longest streak of consecutive login days (gaps and islands)
level: hard
tags: gaps and islands, window functions

#### Question
`logins(user_id, login_ts TIMESTAMP)` — users may log in several times a day. For each user, find their longest streak of consecutive days with at least one login, with its start and end dates.

#### Answer
```sql
WITH days AS (                      -- 1. one row per user per day
  SELECT DISTINCT user_id, login_ts::DATE AS d
  FROM logins
),
grp AS (                            -- 2. island key: date minus its row number
  SELECT user_id, d,
         DATEADD(day,
                 -ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY d),
                 d) AS island
  FROM days
),
streaks AS (                        -- 3. one row per island
  SELECT user_id, island,
         MIN(d) AS start_date, MAX(d) AS end_date, COUNT(*) AS days
  FROM grp
  GROUP BY user_id, island
)
SELECT user_id, start_date, end_date, days
FROM streaks
QUALIFY ROW_NUMBER() OVER (PARTITION BY user_id
                           ORDER BY days DESC, start_date DESC) = 1;
```
**Why step 2 works:** for consecutive dates, the date and its row number both go up by 1, so `date − row_number` stays constant. A gap breaks the constant, starting a new island.

| d | rn | d − rn |
|---|---|---|
| Mar 1 | 1 | Feb 28 |
| Mar 2 | 2 | Feb 28 |
| Mar 3 | 3 | Feb 28 |
| Mar 6 | 4 | Mar 2 ← new island |

Alternative: `LAG(d)` to flag `d − prev_d > 1` as a new-island start, then a running `SUM` of flags as the island id. Same result, works when the "gap" rule is more complex (e.g. "gap > 2 days").

The `DISTINCT` in step 1 is essential — duplicate days would break the arithmetic.

#### What interviewers look for
Naming the pattern ("gaps and islands"), explaining *why* the subtraction works, deduping first.

#### Follow-up
Current streak only (islands ending today or yesterday)? Streaks allowing one missed day? (Use the LAG + running-sum version with `gap > 2`.)

### [sql-013] Sessionize clickstream with a 30-minute inactivity rule
level: hard
tags: sessionization, LAG, running sum

#### Question
`events(user_id, event_ts, page)`. A new session starts when a user has been inactive for more than 30 minutes. Assign a `session_id` to every event and report session start, end, duration and event count.

#### Answer
```sql
WITH flagged AS (
  SELECT e.*,
         CASE
           WHEN LAG(event_ts) OVER (PARTITION BY user_id ORDER BY event_ts) IS NULL
             OR DATEDIFF(second,
                         LAG(event_ts) OVER (PARTITION BY user_id ORDER BY event_ts),
                         event_ts) > 30*60
           THEN 1 ELSE 0
         END AS is_new_session
  FROM events e
),
numbered AS (
  SELECT f.*,
         SUM(is_new_session) OVER (PARTITION BY user_id ORDER BY event_ts
                                   ROWS UNBOUNDED PRECEDING) AS session_seq
  FROM flagged f
)
SELECT user_id,
       user_id || '-' || session_seq                AS session_id,
       MIN(event_ts)                                 AS session_start,
       MAX(event_ts)                                 AS session_end,
       DATEDIFF(second, MIN(event_ts), MAX(event_ts)) AS duration_sec,
       COUNT(*)                                      AS events
FROM numbered
GROUP BY user_id, session_seq;
```
The pattern — **flag the start of each group with LAG, then a running SUM of flags gives a group number** — solves many problems: sessions, "status changed" runs, consecutive failures, etc.

Production notes for a data architect answer:
- In an incremental pipeline, sessions can span batch boundaries. Reprocess a lookback window (e.g. events from the last open session per user), or keep "open session" state.
- Use `ROWS UNBOUNDED PRECEDING` explicitly, and add a tie-breaker (`event_id`) if timestamps can collide.

#### What interviewers look for
The flag + running-sum pattern, and spotting the incremental/batch-boundary issue.

#### Follow-up
Average session length per user per day, and the % of sessions with only one event (bounce rate).

### [sql-014] Month-over-month revenue growth
level: medium
tags: LAG, date functions, division by zero

#### Question
`orders(order_id, order_ts, amount)`. Show monthly revenue and month-over-month growth %.

#### Answer
```sql
WITH monthly AS (
  SELECT DATE_TRUNC(month, order_ts)::DATE AS month,
         SUM(amount) AS revenue
  FROM orders
  GROUP BY 1
)
SELECT month,
       revenue,
       LAG(revenue) OVER (ORDER BY month) AS prev_revenue,
       ROUND(100 * (revenue - LAG(revenue) OVER (ORDER BY month))
             / NULLIF(LAG(revenue) OVER (ORDER BY month), 0), 2) AS mom_growth_pct
FROM monthly
ORDER BY month;
```
Traps to call out:
- **Missing months.** If March had no orders, `LAG` compares April to February. Join to a month spine first (see the date-spine problem) and `COALESCE(revenue, 0)`.
- **Division by zero:** `NULLIF(prev, 0)` (or Snowflake's `DIV0`/`DIV0NULL`).
- **Integer division** in some databases (`7/2 = 3`) — not in Snowflake, but mention casting.
- Year-over-year: `LAG(revenue, 12)` only works if the spine guarantees one row per month.

#### What interviewers look for
Handling gaps, safe division, and knowing `LAG(x, n)`.

#### Follow-up
Rolling 3-month revenue and its growth vs the previous 3 months.

### [sql-015] Fill in missing dates with a date spine
level: medium
tags: date spine, GENERATOR, recursive CTE

#### Question
Daily sales exist only for days with sales. Produce one row for every day of 2026 with 0 for days without sales.

#### Answer
```sql
-- Snowflake: GENERATOR (fast, no recursion)
WITH spine AS (
  SELECT DATEADD(day, SEQ4(), '2026-01-01'::DATE) AS d
  FROM TABLE(GENERATOR(ROWCOUNT => 366))
  QUALIFY d < '2027-01-01'
)
SELECT s.d, COALESCE(SUM(x.amount), 0) AS sales
FROM spine s
LEFT JOIN sales x ON x.sale_date = s.d
GROUP BY s.d
ORDER BY s.d;
```
Gotcha: `SEQ4()` *can have gaps* in edge cases. For a guaranteed gap-free sequence use `ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1`.

Portable recursive version:
```sql
WITH RECURSIVE spine(d) AS (
  SELECT '2026-01-01'::DATE
  UNION ALL
  SELECT DATEADD(day, 1, d) FROM spine WHERE d < '2026-12-31'
)
SELECT … FROM spine LEFT JOIN …
```
In a dbt project, the answer is usually "we have a `dim_date` model" (or `dbt_utils.date_spine`). Mention that a reusable calendar dimension also carries fiscal periods, holidays, week numbers.

#### What interviewers look for
Knowing a spine is needed, `LEFT JOIN` *from* the spine, and the dimension-table answer.

#### Follow-up
Every (store, day) combination with 0 for missing — `CROSS JOIN` stores to the spine first.

### [sql-016] Median and percentiles
level: medium
tags: aggregates, percentiles

#### Question
Find the median order value per country, and the 90th percentile. What's the difference between `PERCENTILE_CONT` and `PERCENTILE_DISC`? What would you use on 10 billion rows?

#### Answer
```sql
SELECT country,
       MEDIAN(amount)                                          AS median_amt,
       PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY amount)     AS p90_interpolated,
       PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY amount)     AS p90_actual_value
FROM orders
GROUP BY country;
```
- `PERCENTILE_CONT` **interpolates** between values (median of 10, 20 = 15).
- `PERCENTILE_DISC` returns an **actual value from the data** (10 or 20).
- `MEDIAN(x)` = `PERCENTILE_CONT(0.5)`.
- At very large scale: `APPROX_PERCENTILE(amount, 0.9)` (t-digest) — small memory, mergeable, tiny error. Same idea as `APPROX_COUNT_DISTINCT` (HyperLogLog) vs `COUNT(DISTINCT)`.

Without a median function (classic interview): rank rows ascending and descending; the median rows are where `ABS(asc_rn - desc_rn) <= 1`, then average them.

#### What interviewers look for
CONT vs DISC, approximate functions for scale, and the manual technique if asked.

#### Follow-up
Median per country as a window function next to each order (`MEDIAN(amount) OVER (PARTITION BY country)`).

### [sql-017] Customers who bought product A but never product B
level: easy
tags: anti-join, EXISTS, set operations

#### Question
`purchases(customer_id, product)`. Find customers who bought 'A' but never 'B'.

#### Answer
```sql
-- 1. Conditional aggregation: one scan, easy to extend
SELECT customer_id
FROM purchases
GROUP BY customer_id
HAVING COUNT_IF(product = 'A') > 0
   AND COUNT_IF(product = 'B') = 0;

-- 2. EXISTS / NOT EXISTS
SELECT DISTINCT p.customer_id
FROM purchases p
WHERE p.product = 'A'
  AND NOT EXISTS (SELECT 1 FROM purchases q
                  WHERE q.customer_id = p.customer_id AND q.product = 'B');

-- 3. Set operation
SELECT customer_id FROM purchases WHERE product = 'A'
EXCEPT            -- MINUS in Snowflake/Oracle
SELECT customer_id FROM purchases WHERE product = 'B';
```
`COUNT_IF` is Snowflake; portable is `SUM(CASE WHEN product='A' THEN 1 ELSE 0 END)`. Version 1 is the most flexible ("bought A and C but not B" = one more line).

#### What interviewers look for
Multiple approaches, and knowing `EXCEPT` removes duplicates.

#### Follow-up
Customers who bought *every* product in a `products` table (relational division: `HAVING COUNT(DISTINCT product) = (SELECT COUNT(*) FROM products)`).

### [sql-018] Full management chain with a recursive CTE
level: hard
tags: recursive CTE, hierarchies

#### Question
`employees(emp_id, name, manager_id)`. For every employee, list their full chain up to the CEO as a path string and their depth. What if the data contains a cycle?

#### Answer
```sql
WITH RECURSIVE chain AS (
  -- anchor: the top (no manager)
  SELECT emp_id, name, manager_id,
         1 AS depth,
         name::VARCHAR AS path
  FROM employees
  WHERE manager_id IS NULL

  UNION ALL

  -- recursive step: attach direct reports
  SELECT e.emp_id, e.name, e.manager_id,
         c.depth + 1,
         c.path || ' > ' || e.name
  FROM employees e
  JOIN chain c ON e.manager_id = c.emp_id
  WHERE c.depth < 20                      -- guard rail
)
SELECT * FROM chain ORDER BY path;
```
- **Cycles** (A manages B, B manages A) would recurse until the engine errors out. Guards: a depth limit as above, or carry an array of visited ids and stop when `ARRAY_CONTAINS(e.emp_id::VARIANT, visited)`.
- Employees whose chain never reaches a top-level manager (orphans) won't appear — run an anti-join check as a data-quality test.
- Snowflake also has `CONNECT BY` with `SYS_CONNECT_BY_PATH` and `LEVEL` (Oracle-style).
- For BI, flatten to a **bridge/closure table** (`ancestor_id, descendant_id, depth`) once in dbt so analysts don't write recursion.

#### What interviewers look for
Anchor + recursive member, `UNION ALL`, cycle protection, and the modelling answer (closure table).

#### Follow-up
Total salary cost of each manager's entire organisation (sum over the closure table by ancestor).

### [sql-019] Pivot and unpivot
level: medium
tags: PIVOT, conditional aggregation

#### Question
`sales(region, quarter, amount)` with quarters Q1–Q4. Produce one row per region with columns Q1..Q4. Then reverse it.

#### Answer
```sql
-- Conditional aggregation: portable, handles NULL/0 explicitly
SELECT region,
       SUM(IFF(quarter = 'Q1', amount, 0)) AS q1,
       SUM(IFF(quarter = 'Q2', amount, 0)) AS q2,
       SUM(IFF(quarter = 'Q3', amount, 0)) AS q3,
       SUM(IFF(quarter = 'Q4', amount, 0)) AS q4
FROM sales
GROUP BY region;

-- Snowflake PIVOT
SELECT *
FROM (SELECT region, quarter, amount FROM sales)
PIVOT (SUM(amount) FOR quarter IN ('Q1','Q2','Q3','Q4')) AS p;
-- Snowflake also supports dynamic: FOR quarter IN (ANY ORDER BY quarter)

-- UNPIVOT back to rows
SELECT region, quarter, amount
FROM wide_sales
UNPIVOT (amount FOR quarter IN (q1, q2, q3, q4));
```
Notes: `PIVOT` returns NULL (not 0) for missing combinations; `UNPIVOT` **drops NULLs** by default (Snowflake has `INCLUDE NULLS`). Pivot only the columns you need in the inner query — extra columns become implicit grouping columns.

#### What interviewers look for
Both techniques, NULL behaviour, and the implicit-grouping gotcha.

#### Follow-up
Pivot when the list of values isn't known in advance (dynamic `ANY`, or generate SQL with a dbt macro such as `dbt_utils.pivot`).

### [sql-020] SCD Type 2 with MERGE
level: hard
tags: SCD2, MERGE, dimensional modelling

#### Question
`dim_customer(customer_sk, customer_id, city, valid_from, valid_to, is_current)`. A daily staging table `stg_customer(customer_id, city, updated_at)` arrives. Implement SCD Type 2: close the old version when `city` changes and insert the new version — in SQL, without dbt snapshots.

#### Answer
The difficulty: one `MERGE` can only do **one action per target row**, but a change needs *two* actions (update the old row and insert the new one). The standard trick is to feed changed keys into the merge twice.
```sql
MERGE INTO dim_customer t
USING (
  -- rows whose key matches: used to CLOSE the current version
  SELECT s.customer_id AS merge_key, s.*
  FROM stg_customer s
  UNION ALL
  -- changed rows again with a NULL key: forces an INSERT of the new version
  SELECT NULL AS merge_key, s.*
  FROM stg_customer s
  JOIN dim_customer d
    ON d.customer_id = s.customer_id AND d.is_current
  WHERE d.city IS DISTINCT FROM s.city
) src
ON t.customer_id = src.merge_key AND t.is_current
WHEN MATCHED AND t.city IS DISTINCT FROM src.city THEN
  UPDATE SET valid_to = src.updated_at, is_current = FALSE
WHEN NOT MATCHED THEN
  INSERT (customer_id, city, valid_from, valid_to, is_current)
  VALUES (src.customer_id, src.city, src.updated_at, NULL, TRUE);
```
- Brand-new customers: their `merge_key` doesn't match → inserted by the first branch of the UNION.
- Changed customers: first branch closes the old row; second branch (NULL key, never matches) inserts the new one.
- Unchanged: matched but the `AND` condition fails → nothing.

Must-mention production points:
- **Dedupe staging first** (one row per key per batch), or the MERGE is non-deterministic.
- Use `IS DISTINCT FROM` (NULL-safe), or compare a hash of all tracked columns.
- `valid_to = NULL` vs `'9999-12-31'`: the far-future date makes `BETWEEN` joins simpler.
- Late-arriving / out-of-order updates break simple SCD2 — need re-sequencing.
- In dbt, this is `snapshot` (timestamp or check strategy).

#### What interviewers look for
The two-actions-per-row problem and the union trick (or a two-statement transaction: UPDATE then INSERT), dedup, NULL-safe comparison.

#### Follow-up
How do you handle hard deletes in the source? (Compare full source key set; close rows for missing keys; dbt snapshots have `hard_deletes: invalidate | new_record`.)

### [sql-021] Merge overlapping date ranges
level: hard
tags: intervals, gaps and islands

#### Question
`bookings(room_id, start_date, end_date)`. Bookings may overlap. Merge overlapping or touching ranges per room into continuous occupied periods.

#### Answer
```sql
WITH ordered AS (
  SELECT room_id, start_date, end_date,
         MAX(end_date) OVER (PARTITION BY room_id ORDER BY start_date, end_date
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
           AS max_prev_end
  FROM bookings
),
flagged AS (
  SELECT *,
         CASE WHEN max_prev_end IS NULL
                OR start_date > DATEADD(day, 1, max_prev_end)   -- gap → new period
              THEN 1 ELSE 0 END AS is_new
  FROM ordered
),
grouped AS (
  SELECT *, SUM(is_new) OVER (PARTITION BY room_id ORDER BY start_date, end_date
                              ROWS UNBOUNDED PRECEDING) AS grp
  FROM flagged
)
SELECT room_id, MIN(start_date) AS period_start, MAX(end_date) AS period_end
FROM grouped
GROUP BY room_id, grp
ORDER BY room_id, period_start;
```
**Key insight:** compare each start with the **maximum end so far**, not just the previous row's end. Example: [1–10], [2–3], [5–6] — row 3 starts after row 2 ends but is still inside row 1's range. Using `LAG(end_date)` gets this wrong.

"Touching" (end Mar 3, start Mar 4) counts as continuous here because of the `+1 day`; drop it if touching ranges should stay separate.

#### What interviewers look for
Running MAX instead of LAG, and clarifying touching vs overlapping.

#### Follow-up
Find double-bookings (pairs that overlap): self-join on `a.start < b.end AND b.start < a.end AND a.id < b.id`.

### [sql-022] Monthly cohort retention table
level: hard
tags: cohorts, analytics engineering

#### Question
`activity(user_id, activity_date)`. Build a retention table: for each signup-month cohort, the % of users active in month 0, 1, 2, … after their first month.

#### Answer
```sql
WITH firsts AS (
  SELECT user_id, DATE_TRUNC(month, MIN(activity_date)) AS cohort_month
  FROM activity GROUP BY user_id
),
active AS (
  SELECT DISTINCT a.user_id, f.cohort_month,
         DATEDIFF(month, f.cohort_month, DATE_TRUNC(month, a.activity_date)) AS month_n
  FROM activity a JOIN firsts f USING (user_id)
),
sizes AS (
  SELECT cohort_month, COUNT(*) AS cohort_size FROM firsts GROUP BY 1
)
SELECT a.cohort_month, s.cohort_size, a.month_n,
       COUNT(DISTINCT a.user_id)                              AS active_users,
       ROUND(100 * COUNT(DISTINCT a.user_id) / s.cohort_size, 1) AS retention_pct
FROM active a JOIN sizes s USING (cohort_month)
GROUP BY a.cohort_month, s.cohort_size, a.month_n
ORDER BY a.cohort_month, a.month_n;
```
Then pivot `month_n` into columns for the classic triangle (or let the BI tool do it).

Discussion: here `DATEDIFF(month, …)` on two month-truncated dates is exactly right (boundary counting is what we want). Define "active" with the business; recent cohorts have fewer observable months (the triangle shape) — don't average across cohorts naively. In dbt, materialise `firsts` as a user dimension.

#### What interviewers look for
Correct cohort definition, denominators from the cohort (not from active users), awareness of the right-censoring triangle.

#### Follow-up
Revenue retention instead of user retention (sum revenue per cohort per month ÷ month-0 revenue).

### [sql-023] Latest record per key — and the LAST_VALUE trap
level: medium
tags: window functions, MAX_BY, frames

#### Question
`prices(product_id, price, effective_ts)`. Return the current price per product. Show three ways and explain why `LAST_VALUE(price) OVER (PARTITION BY product_id ORDER BY effective_ts)` returns wrong results.

#### Answer
```sql
-- 1. QUALIFY + ROW_NUMBER (most common)
SELECT product_id, price, effective_ts
FROM prices
QUALIFY ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY effective_ts DESC) = 1;

-- 2. MAX_BY (Snowflake): concise, single aggregate
SELECT product_id, MAX_BY(price, effective_ts) AS current_price
FROM prices GROUP BY product_id;

-- 3. FIRST_VALUE with DESC order (no frame trap for FIRST_VALUE)
SELECT DISTINCT product_id,
       FIRST_VALUE(price) OVER (PARTITION BY product_id ORDER BY effective_ts DESC) AS current_price
FROM prices;
```
**Why LAST_VALUE "fails":** with `ORDER BY` and no frame, the frame ends at the **current row**, so the "last value" is the current row's own price. Fix: `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`.

Price "as of" a date (point-in-time join), very common in finance:
```sql
SELECT o.order_id, p.price
FROM orders o
ASOF JOIN prices p
  MATCH_CONDITION (o.order_ts >= p.effective_ts)
  ON o.product_id = p.product_id;
```
(`ASOF JOIN` exists in Snowflake; otherwise use a range join on valid_from/valid_to.)

#### What interviewers look for
Knowing frames, `MAX_BY`/`MIN_BY`, and point-in-time correctness.

#### Follow-up
Products whose price changed more than 3 times in 30 days (`COUNT(*)` with a range filter, or `LAG` + change flag).

### [sql-024] Percent of total and cumulative share
level: easy
tags: window aggregates, RATIO_TO_REPORT

#### Question
For each product show revenue, its % of total revenue, and the cumulative % when sorted from highest revenue (Pareto/80-20 analysis).

#### Answer
```sql
WITH rev AS (
  SELECT product_id, SUM(amount) AS revenue
  FROM orders GROUP BY product_id
)
SELECT product_id, revenue,
       ROUND(100 * RATIO_TO_REPORT(revenue) OVER (), 2)              AS pct_of_total,
       ROUND(100 * SUM(revenue) OVER (ORDER BY revenue DESC, product_id
                                      ROWS UNBOUNDED PRECEDING)
                 / SUM(revenue) OVER (), 2)                           AS cumulative_pct
FROM rev
ORDER BY revenue DESC;
```
`SUM(x) OVER ()` — an empty `OVER()` — is the grand total on every row. `RATIO_TO_REPORT` is Snowflake shorthand for `x / SUM(x) OVER ()`. Products with `cumulative_pct <= 80` are your "top 80%" set.

#### What interviewers look for
Empty `OVER()`, aggregating before windowing, deterministic ordering for the cumulative sum.

#### Follow-up
% of total *within each category* (`OVER (PARTITION BY category)`).

### [sql-025] Subtotals with GROUPING SETS / ROLLUP
level: medium
tags: GROUPING SETS, ROLLUP, CUBE

#### Question
Produce revenue by (region, country), plus a subtotal per region and a grand total — in one query. How do you tell a subtotal row from a row where country is genuinely NULL?

#### Answer
```sql
SELECT region,
       country,
       SUM(amount) AS revenue,
       GROUPING(country) AS is_country_subtotal,   -- 1 = this row aggregates all countries
       GROUPING(region)  AS is_grand_total
FROM sales
GROUP BY ROLLUP (region, country)
ORDER BY region NULLS LAST, country NULLS LAST;
```
- `ROLLUP(a, b)` = grouping sets `(a,b), (a), ()` — hierarchical subtotals.
- `CUBE(a, b)` = all combinations: `(a,b), (a), (b), ()`.
- `GROUPING SETS ((a,b), (b))` = exactly the ones you list.
- `GROUPING(col)` returns 1 when the NULL is a *subtotal placeholder*, 0 when it's real data — that's the answer to the second question. Label rows with `IFF(GROUPING(country)=1, 'All countries', country)`.

#### What interviewers look for
Knowing all three, and `GROUPING()` to distinguish placeholder NULLs.

#### Follow-up
Why might a BI tool prefer you *not* to precompute subtotals in the warehouse? (Non-additive measures like distinct counts or averages can't be re-aggregated from subtotals.)

### [sql-026] Revenue doubled after a join (fan-out)
level: medium
tags: joins, grain, fan-out

#### Question
`orders(order_id, customer_id, amount)`, `order_items(order_id, sku)`, `payments(order_id, paid_amount)`. An analyst writes:
```sql
SELECT o.customer_id, SUM(o.amount) AS revenue, SUM(p.paid_amount) AS paid
FROM orders o
JOIN order_items i ON i.order_id = o.order_id
JOIN payments p   ON p.order_id = o.order_id
GROUP BY o.customer_id;
```
Revenue is 3–6× too high. Explain and fix.

#### Answer
**Fan-out.** An order with 3 items and 2 payments produces 3 × 2 = 6 joined rows, so `o.amount` is summed 6 times and each payment 3 times. Joining two independent one-to-many children to the same parent multiplies rows (a "chasm trap").

Fix: **aggregate each child to the parent's grain before joining.**
```sql
WITH items AS (
  SELECT order_id, COUNT(*) AS item_count FROM order_items GROUP BY order_id
),
pay AS (
  SELECT order_id, SUM(paid_amount) AS paid FROM payments GROUP BY order_id
)
SELECT o.customer_id,
       SUM(o.amount)              AS revenue,
       SUM(COALESCE(p.paid, 0))   AS paid,
       SUM(COALESCE(i.item_count, 0)) AS items
FROM orders o
LEFT JOIN items i ON i.order_id = o.order_id
LEFT JOIN pay   p ON p.order_id = o.order_id
GROUP BY o.customer_id;
```
`SUM(DISTINCT o.amount)` is **not** a fix — two different orders with the same amount would be collapsed.

Prevention as an architect: document the **grain** of every model, add a `unique` test on the grain key in dbt, and add row-count reconciliation tests between layers.

#### What interviewers look for
Naming the grain problem, pre-aggregation, rejecting `SUM(DISTINCT)`, and prevention through tests.

#### Follow-up
How would you detect fan-out automatically in a dbt project? (Unique tests on primary keys; `dbt_utils.equal_rowcount`/`fewer_rows_than`; compare `COUNT(*)` before and after joins in an audit query.)
