### [py-001] Dictionary of word lengths
level: easy
tags: dict comprehension, fundamentals
asked: yes

#### Question
Given `fruits = ['apple', 'orange', 'banana']`, produce `{'apple': 5, 'orange': 6, 'banana': 6}`. What if the list has duplicates or mixed case?

#### Answer
```python
fruits = ['apple', 'orange', 'banana']
fruit_lengths = {fruit: len(fruit) for fruit in fruits}
print(fruit_lengths)   # {'apple': 5, 'orange': 6, 'banana': 6}
```
Extensions interviewers add:
```python
# duplicates are harmless (same key, same value); normalise case/whitespace first
fruits = ['Apple', 'apple ', 'Banana']
lengths = {f.strip().lower(): len(f.strip()) for f in fruits}   # {'apple': 5, 'banana': 6}

# alternatives
dict(zip(fruits, map(len, fruits)))

# group words by length instead
from collections import defaultdict
by_len = defaultdict(list)
for f in ['apple', 'orange', 'banana', 'kiwi']:
    by_len[len(f)].append(f)        # {5: ['apple'], 6: ['orange', 'banana'], 4: ['kiwi']}
```
Note: dicts keep insertion order (Python 3.7+). Watch the typo in the original prompt — `['apple','orange','banana'}` mixes brackets and would be a `SyntaxError`.

#### What interviewers look for
Idiomatic comprehension, and thinking about dirty input.

#### Follow-up
Sort the result by length descending, then alphabetically: `sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))`.

### [py-002] Are two strings anagrams?
level: easy
tags: strings, Counter, complexity
asked: yes

#### Question
Write a function that returns True if two strings are anagrams ("Listen" / "Silent"), ignoring case and spaces. What's the time complexity of your approaches?

#### Answer
```python
from collections import Counter

def is_anagram(a: str, b: str) -> bool:
    clean = lambda s: [c for c in s.lower() if not c.isspace()]
    return Counter(clean(a)) == Counter(clean(b))          # O(n)

def is_anagram_sorted(a: str, b: str) -> bool:
    norm = lambda s: sorted(s.replace(" ", "").lower())
    return norm(a) == norm(b)                               # O(n log n)

def is_anagram_manual(a: str, b: str) -> bool:
    a, b = a.replace(" ", "").lower(), b.replace(" ", "").lower()
    if len(a) != len(b):
        return False                                        # quick exit
    counts = {}
    for ch in a:
        counts[ch] = counts.get(ch, 0) + 1
    for ch in b:
        if counts.get(ch, 0) == 0:
            return False
        counts[ch] -= 1
    return True                                             # O(n) time, O(k) space

assert is_anagram("Listen", "Silent")
assert is_anagram("Dormitory", "Dirty room")
assert not is_anagram("abc", "abd")
```
Mention: Unicode (accented letters — `casefold()` is better than `lower()` for case-insensitive comparison), punctuation rules, and the early length check.

#### What interviewers look for
Two approaches with complexity, input normalisation, edge cases.

#### Follow-up
Group a list of words into anagram groups (use the sorted word as a dict key — see the grouping problem).

### [py-003] Reverse a string without slicing
level: easy
tags: strings, iteration
asked: yes

#### Question
Reverse a string using iteration only — no `[::-1]`. Why is repeated string concatenation in a loop a bad idea?

#### Answer
```python
def reverse_iter(s: str) -> str:
    chars = []
    for i in range(len(s) - 1, -1, -1):
        chars.append(s[i])
    return "".join(chars)                 # O(n)

def reverse_two_pointer(s: str) -> str:
    chars = list(s)                       # strings are immutable → use a list
    left, right = 0, len(chars) - 1
    while left < right:
        chars[left], chars[right] = chars[right], chars[left]
        left += 1
        right -= 1
    return "".join(chars)

assert reverse_iter("data") == "atad"
assert reverse_two_pointer("snowflake") == "ekalfwons"
assert reverse_iter("") == ""
```
**Why not `result = ch + result` in a loop?** Strings are immutable, so each concatenation creates a new string — O(n²) in the worst case. Collect parts in a list and `"".join()` once.

Other built-ins they may accept: `"".join(reversed(s))`.

#### What interviewers look for
Immutability awareness, O(n) solution, edge cases (empty string, one character).

#### Follow-up
Reverse the order of words but not the letters: `" ".join(reversed(s.split()))`.

### [py-004] First non-repeating character
level: easy
tags: strings, hashing, ordering
asked: yes

#### Question
Return the first character in a string that appears only once ("swiss" → "w"). Return None if every character repeats.

#### Answer
```python
from collections import Counter

def first_unique(s: str) -> str | None:
    counts = Counter(s)                   # pass 1: count, O(n)
    for ch in s:                          # pass 2: keep original order
        if counts[ch] == 1:
            return ch
    return None

assert first_unique("swiss") == "w"
assert first_unique("aabb") is None
assert first_unique("") is None
```
Two passes, O(n) time, O(k) space (k = distinct characters). The second pass over the *string* (not the Counter) is what guarantees "first" — though Counter also keeps insertion order in Python 3.7+, so `next((c for c, n in counts.items() if n == 1), None)` works too.

Streaming version (characters arrive one by one, answer anytime): keep counts plus an ordered dict of candidates that are still unique; remove a char when its count hits 2; the first key is the answer.

#### What interviewers look for
Two-pass O(n) solution and clean None handling.

#### Follow-up
Case-insensitive version where "S" and "s" count as the same but you return the original character.

### [py-005] Flatten a nested list
level: medium
tags: recursion, generators, data cleaning
asked: yes

#### Question
Flatten `[1, [2, [3, 4]], 5, [], [[6]]]` into `[1, 2, 3, 4, 5, 6]` for any depth. Watch out for strings.

#### Answer
```python
from collections.abc import Iterable

def flatten(items):
    """Yield leaf values from arbitrarily nested iterables; strings/bytes stay whole."""
    for item in items:
        if isinstance(item, Iterable) and not isinstance(item, (str, bytes, dict)):
            yield from flatten(item)
        else:
            yield item

assert list(flatten([1, [2, [3, 4]], 5, [], [[6]]])) == [1, 2, 3, 4, 5, 6]
assert list(flatten(["ab", ["cd", ["ef"]]])) == ["ab", "cd", "ef"]

def flatten_iterative(items):
    """No recursion limit issues for very deep nesting."""
    stack = [iter(items)]
    while stack:
        for item in stack[-1]:
            if isinstance(item, (list, tuple)):
                stack.append(iter(item))
                break
            yield item
        else:
            stack.pop()

assert list(flatten_iterative([1, [2, [3, [4, [5]]]]])) == [1, 2, 3, 4, 5]
```
Points to say:
- **Strings are iterable** — without the `str` check, `"ab"` → `"a"`, `"b"` and then infinite recursion on single characters.
- A **generator** (`yield from`) doesn't build intermediate lists — memory-friendly for big inputs.
- Python's default recursion limit (~1000) — the iterative version avoids it.
- One level only: `[x for sub in items for x in sub]` or `itertools.chain.from_iterable(items)`.

#### What interviewers look for
Handling arbitrary depth, the string trap, generator vs list, recursion limits.

#### Follow-up
Flatten a nested *dict* into dotted keys — see the JSON flattening problem.

### [py-006] Implement an LRU cache
level: medium
tags: data structures, OrderedDict, caching
asked: yes

#### Question
Implement a Least Recently Used cache with `get(key)` and `put(key, value)`, both O(1), with a fixed capacity. Where would you use one in data engineering?

#### Answer
```python
from collections import OrderedDict

class LRUCache:
    def __init__(self, capacity: int):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self._data: OrderedDict = OrderedDict()

    def get(self, key, default=None):
        if key not in self._data:
            return default
        self._data.move_to_end(key)           # mark as most recently used
        return self._data[key]

    def put(self, key, value) -> None:
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = value
        if len(self._data) > self.capacity:
            self._data.popitem(last=False)    # evict least recently used

cache = LRUCache(2)
cache.put("a", 1); cache.put("b", 2)
cache.get("a")                 # a is now most recent
cache.put("c", 3)              # evicts b
assert cache.get("b") is None and cache.get("a") == 1 and cache.get("c") == 3
```
Without `OrderedDict`, the classic implementation is a **hash map + doubly linked list** (map gives O(1) lookup; the list gives O(1) move-to-front and eviction). Be ready to sketch it.

For functions, the built-in is simplest:
```python
from functools import lru_cache

@lru_cache(maxsize=10_000)
def currency_rate(code: str, day: str) -> float:
    return call_rates_api(code, day)       # repeated lookups are served from memory
```
DE uses: caching dimension lookups or API responses inside a batch job, avoiding repeated expensive calls ("cost optimization"). Caveats: the cache is per process (not shared across workers), unbounded caches leak memory, and thread safety needs a lock for the custom class.

#### What interviewers look for
O(1) design, eviction correctness, knowing `lru_cache`, practical caveats.

#### Follow-up
Add a time-to-live so entries expire after 10 minutes (store `(value, expires_at)` and check on `get`).

### [py-007] Detect duplicates with minimal memory
level: hard
tags: memory, hashing, large files
asked: yes

#### Question
A 200 GB CSV of transactions might contain duplicate rows. Your machine has 8 GB RAM. How do you find duplicates? Start from the simple in-memory version.

#### Answer
**Small data — set of seen keys:**
```python
def find_duplicates(rows, key=lambda r: r):
    seen, dups = set(), set()
    for r in rows:
        k = key(r)
        if k in seen:
            dups.add(k)
        else:
            seen.add(k)
    return dups

assert find_duplicates([1, 2, 3, 2, 1]) == {1, 2}
```
**Reduce memory per key — store fixed-size hashes instead of full rows:**
```python
import hashlib

def row_digest(line: str) -> bytes:
    return hashlib.blake2b(line.encode(), digest_size=8).digest()   # 8 bytes per row
```
(8-byte digests have a tiny but non-zero collision chance — verify candidates against the full rows in a second pass.)

**Doesn't fit in RAM — partition by hash, then dedupe each partition (external hashing):**
```python
import hashlib, os

def partition_file(path, out_dir, buckets=256):
    files = [open(os.path.join(out_dir, f"part_{i}.csv"), "w") for i in range(buckets)]
    with open(path) as f:
        for line in f:                                  # streams; constant memory
            b = int.from_bytes(hashlib.md5(line.encode()).digest()[:2], "big") % buckets
            files[b].write(line)
    for fh in files:
        fh.close()
# identical rows always land in the same bucket; each bucket (~800 MB) fits in memory
# → run find_duplicates per bucket file
```
Other options to mention:
- **External sort** (`sort -S 4G big.csv | uniq -d` on Linux) — duplicates become adjacent.
- **Bloom filter** — very little memory, answers "definitely new" or "maybe seen" (false positives possible, so confirm).
- **Use the right tool:** load into Snowflake/DuckDB and run `GROUP BY … HAVING COUNT(*) > 1` — DuckDB spills to disk and handles this on a laptop.
- Duplicates by **business key** (e.g. `txn_id`) vs entire row — clarify first; key-based is much cheaper.

#### What interviewers look for
Progressive answer (set → hashes → partitioning/sorting → right tool), memory reasoning, collision awareness.

#### Follow-up
Keep the *first* occurrence and write a deduplicated file in a single pass with bounded memory? (Partition first, then dedupe each partition preserving order with a row number.)

### [py-008] The mutable default argument bug
level: easy
tags: gotchas, functions

#### Question
What does this print, and why?
```python
def add_record(rec, batch=[]):
    batch.append(rec)
    return batch

print(add_record(1))
print(add_record(2))
```

#### Answer
It prints `[1]` and then `[1, 2]` — not `[2]`.

Default values are evaluated **once, when the function is defined**, not on each call. The same list object is reused across calls, so it keeps growing. In a long-running process (an Airflow worker, an API), this leaks data between calls.

Fix — use `None` as the sentinel:
```python
def add_record(rec, batch=None):
    if batch is None:
        batch = []
    batch.append(rec)
    return batch

assert add_record(1) == [1]
assert add_record(2) == [2]
```
Same trap with `dict`, `set`, and `datetime.now()` as a default (frozen at definition time!).

#### What interviewers look for
Knowing *why* (definition-time evaluation) and the `None` idiom.

#### Follow-up
Where else does "evaluated once" bite you? (Class attributes that are mutable — shared by all instances.)

### [py-009] Processing a file bigger than memory with generators
level: medium
tags: generators, streaming, memory

#### Question
Process a 50 GB newline-delimited JSON file: filter records where `status == "FAILED"`, keep 3 fields, and write them out in batches of 10,000 to load into Snowflake. Memory must stay small.

#### Answer
```python
import json
from itertools import islice

def read_records(path):
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):          # file objects are lazy iterators
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                print(f"bad json on line {line_no}")    # route to an error file in real code

def failed_only(records):
    for r in records:
        if r.get("status") == "FAILED":
            yield {"id": r["id"], "ts": r["ts"], "reason": r.get("reason")}

def batched(iterable, size):
    it = iter(iterable)
    while batch := list(islice(it, size)):
        yield batch

def run(path, sink):
    for batch in batched(failed_only(read_records(path)), 10_000):
        sink(batch)                                     # e.g. write a file part, or insert
```
- Each stage is a **generator** — only one record (and one batch) is in memory at a time; the pipeline is lazy end to end.
- Python 3.12 has `itertools.batched` built in.
- For loading into Snowflake, writing compressed batch **files** (Parquet/CSV.gz ~100–250 MB) and using `PUT` + `COPY` is much faster than row inserts.
- Faster alternatives for heavy processing: DuckDB or Polars reading the file with streaming/out-of-core execution — or just stage the raw file and do the filtering in Snowflake SQL.

#### What interviewers look for
Lazy pipelines with generators, batching, error handling, and knowing when not to use Python.

#### Follow-up
Why is `f.readlines()` a bad idea here? (Reads the whole file into a list.)

### [py-010] Retry decorator with exponential backoff and jitter
level: medium
tags: decorators, reliability, APIs

#### Question
Write a decorator that retries a function on specific exceptions, with exponential backoff and jitter, up to N attempts. Why jitter?

#### Answer
```python
import functools, random, time

def retry(exceptions=(Exception,), attempts=5, base_delay=1.0, max_delay=30.0):
    def decorator(func):
        @functools.wraps(func)                       # keeps name/docstring
        def wrapper(*args, **kwargs):
            for attempt in range(1, attempts + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as exc:
                    if attempt == attempts:
                        raise                        # give up: re-raise the last error
                    delay = min(max_delay, base_delay * 2 ** (attempt - 1))
                    delay = random.uniform(0, delay) # "full jitter"
                    print(f"{func.__name__} failed ({exc!r}); retry {attempt} in {delay:.1f}s")
                    time.sleep(delay)
        return wrapper
    return decorator

class TransientError(Exception): ...

calls = {"n": 0}
@retry(exceptions=(TransientError,), attempts=3, base_delay=0.01)
def flaky():
    calls["n"] += 1
    if calls["n"] < 3:
        raise TransientError("503")
    return "ok"

assert flaky() == "ok" and calls["n"] == 3
```
- **Only retry transient errors** (timeouts, 429, 5xx). Retrying a 400 Bad Request or an auth failure just wastes time.
- **Jitter** spreads retries randomly so many clients that failed together don't retry at the same instant ("thundering herd") and knock the service over again.
- Respect `Retry-After` headers on HTTP 429.
- The operation must be **idempotent** (safe to repeat) — e.g. use idempotency keys for POSTs.
- In production, the `tenacity` library does all this declaratively.

#### What interviewers look for
Working decorator with `functools.wraps`, selective exceptions, jitter reasoning, idempotency.

#### Follow-up
Make it work for `async` functions too (`asyncio.sleep`, check `inspect.iscoroutinefunction`).

### [py-011] Ingest a paginated API reliably
level: hard
tags: APIs, pagination, incremental loads

#### Question
Ingest orders from a REST API daily into Snowflake. The API is paginated (cursor-based), rate-limited (429s), and sometimes returns 500s. Records can be updated after creation. Design and sketch the code.

#### Answer
```python
import json, time, requests
from datetime import datetime, timezone

BASE = "https://api.example.com/v1/orders"

def fetch_pages(session, updated_since: str, page_size=500):
    params = {"updated_since": updated_since, "limit": page_size}
    cursor = None
    while True:
        if cursor:
            params["cursor"] = cursor
        resp = session.get(BASE, params=params, timeout=30)
        if resp.status_code == 429:
            time.sleep(int(resp.headers.get("Retry-After", "5")))
            continue                                   # retry same page
        resp.raise_for_status()                        # 5xx → let a retry wrapper handle it
        body = resp.json()
        yield body["data"]
        cursor = body.get("next_cursor")
        if not cursor:
            break

def run(watermark: str, run_id: str, write_file):
    session = requests.Session()
    session.headers["Authorization"] = "Bearer <token from secrets manager>"
    extracted_at = datetime.now(timezone.utc).isoformat()
    for page_no, records in enumerate(fetch_pages(session, watermark)):
        lines = "\n".join(json.dumps({**r, "_extracted_at": extracted_at,
                                      "_run_id": run_id}) for r in records)
        write_file(f"raw/orders/run={run_id}/page_{page_no:05d}.json", lines)
    # then: COPY INTO raw.orders_json; MERGE into staging on order_id by latest updated_at;
    # only after success: advance the watermark
```
Design points (this is what makes it "hard"):
- **Incremental by `updated_at` watermark**, with an **overlap** (e.g. watermark minus 1 hour) to catch records updated during the previous run or with clock skew; duplicates are fine because the load MERGEs on `order_id` keeping the latest `updated_at`.
- **Advance the watermark only after the load commits** — store it in a control table (or derive it from `MAX(updated_at)` in the target).
- **Land raw first** (JSON files in a stage/bucket) → `COPY` into a VARIANT table → transform in SQL/dbt. Raw files allow replays without calling the API again.
- **Cursor pagination** is stable; offset pagination can skip or repeat records when data changes during paging — sort by a stable key and dedupe if you must use offsets.
- **Rate limits & errors:** respect `Retry-After`, exponential backoff for 5xx, timeouts on every request, circuit-breaker logic (stop after N consecutive failures).
- **Deletes:** the API may not expose deletes → periodic full key reconciliation or a deleted-records endpoint.
- **Observability:** log pages, record counts, and run id; compare counts with the API's total if provided.
- Consider managed connectors (Fivetran, Airbyte, Snowflake Openflow) before writing custom code — custom only when they don't support the source.

#### What interviewers look for
Watermark + overlap + MERGE idempotency, raw landing, correct pagination, and operational thinking.

#### Follow-up
The API backfill for 3 years would take 40 hours at the rate limit. Options? (Parallelise by date ranges within limits, request a bulk export from the vendor, run the backfill over several nights.)

### [py-012] Flatten nested JSON into columns
level: medium
tags: JSON, recursion, dicts

#### Question
Convert `{"id": 1, "customer": {"name": "Asha", "address": {"city": "Chennai"}}, "tags": ["new", "vip"]}` into `{"id": 1, "customer.name": "Asha", "customer.address.city": "Chennai", "tags": ["new", "vip"]}`. Lists stay as values.

#### Answer
```python
def flatten_dict(d: dict, parent: str = "", sep: str = ".") -> dict:
    out = {}
    for key, value in d.items():
        name = f"{parent}{sep}{key}" if parent else key
        if isinstance(value, dict) and value:          # recurse into non-empty dicts
            out.update(flatten_dict(value, name, sep))
        else:
            out[name] = value                          # lists, scalars, empty dicts stay
    return out

src = {"id": 1, "customer": {"name": "Asha", "address": {"city": "Chennai"}},
       "tags": ["new", "vip"]}
assert flatten_dict(src) == {"id": 1, "customer.name": "Asha",
                             "customer.address.city": "Chennai", "tags": ["new", "vip"]}
```
Discussion:
- **Key collisions:** `{"a.b": 1, "a": {"b": 2}}` both flatten to `a.b` — choose a separator unlikely in keys (`__`), or detect collisions.
- **Lists of dicts:** either keep as JSON, explode into child rows (one row per element), or index them (`items.0.sku`). Exploding is usually right for analytics — like `FLATTEN` in Snowflake.
- **Schema drift:** new keys appear over time → in pipelines, it's often better to land raw JSON in Snowflake as VARIANT and flatten in SQL, where schema changes don't break the load.
- Library option: `pandas.json_normalize(records, record_path="items", meta=["id"])`.

#### What interviewers look for
Correct recursion, edge cases (empty dicts, collisions, lists), and the "land raw, flatten in SQL" design view.

#### Follow-up
Reverse it — unflatten dotted keys back into nested dicts.

### [py-013] Group anagrams and top-K frequent items
level: medium
tags: hashing, heapq, Counter

#### Question
(a) Group `["eat","tea","tan","ate","nat","bat"]` into anagram groups. (b) Return the 2 most frequent words in a large list efficiently.

#### Answer
```python
from collections import defaultdict, Counter
import heapq

def group_anagrams(words):
    groups = defaultdict(list)
    for w in words:
        groups["".join(sorted(w))].append(w)     # sorted letters = signature
    return list(groups.values())

result = group_anagrams(["eat", "tea", "tan", "ate", "nat", "bat"])
assert sorted(map(sorted, result)) == [["ate", "eat", "tea"], ["bat"], ["nat", "tan"]]

def top_k(words, k):
    counts = Counter(words)                       # O(n)
    return [w for w, _ in counts.most_common(k)]  # uses a heap internally: O(m log k)

def top_k_heap(words, k):
    counts = Counter(words)
    return heapq.nlargest(k, counts, key=counts.get)

words = ["a", "b", "a", "c", "b", "a"]
assert top_k(words, 2) == ["a", "b"]
assert top_k_heap(words, 2) == ["a", "b"]
```
Complexities: grouping is O(n · L log L) (L = word length); a 26-letter count tuple as the key makes it O(n · L). Top-k with a heap is O(m log k) after counting — better than sorting all m distinct items when k is small.

At data-warehouse scale this is just `GROUP BY word ORDER BY COUNT(*) DESC LIMIT 2` — or `APPROX_TOP_K` in Snowflake for streaming-scale data.

#### What interviewers look for
Signature-key idea, Counter/heap usage, complexity, and the SQL equivalent.

#### Follow-up
Top-k over an infinite stream with bounded memory? (Count-Min Sketch + heap, or Space-Saving algorithm.)

### [py-014] Merge overlapping intervals
level: medium
tags: sorting, intervals

#### Question
Merge `[(1,3), (2,6), (8,10), (9,12), (15,18)]` into non-overlapping intervals. Then explain how you'd do the same for millions of booking records.

#### Answer
```python
def merge_intervals(intervals):
    if not intervals:
        return []
    intervals = sorted(intervals)                 # sort by start: O(n log n)
    merged = [list(intervals[0])]
    for start, end in intervals[1:]:
        last = merged[-1]
        if start <= last[1]:                      # overlap (use < to keep touching ones apart)
            last[1] = max(last[1], end)           # max! a short interval may sit inside a long one
        else:
            merged.append([start, end])
    return [tuple(i) for i in merged]

assert merge_intervals([(1, 3), (2, 6), (8, 10), (9, 12), (15, 18)]) == [(1, 6), (8, 12), (15, 18)]
assert merge_intervals([(1, 10), (2, 3), (4, 5)]) == [(1, 10)]
```
The `max()` handles nested intervals — a common bug is `last[1] = end`.

Millions of records: do it in SQL with the running-MAX + running-SUM pattern (see the SQL "merge overlapping date ranges" problem), partitioned by room/customer — the warehouse sorts and parallelises for you.

#### What interviewers look for
Sorting first, `max` for containment, touching-interval decision, scaling via SQL.

#### Follow-up
Total time covered by the intervals (sum of merged lengths), or the maximum number of overlapping intervals at any moment (sweep line: +1 at start, −1 at end).

### [py-015] Threads, processes or asyncio?
level: medium
tags: concurrency, GIL, performance

#### Question
You need to (a) call 2,000 API endpoints, (b) parse 200 large compressed files with heavy CPU work. Threads, multiprocessing or asyncio for each? Explain the GIL.

#### Answer
The **GIL (Global Interpreter Lock)** in CPython lets only one thread execute Python bytecode at a time. Threads still help for **I/O-bound** work because the GIL is released while waiting on network/disk. For **CPU-bound** Python code, threads don't run in parallel — use processes. (Free-threaded CPython builds, available as an option from 3.13, remove the GIL but aren't yet the default everywhere.)

- **(a) 2,000 API calls → I/O-bound:** `asyncio` + `httpx`/`aiohttp` (thousands of concurrent requests with little overhead), or a `ThreadPoolExecutor` (simpler, fine for hundreds). Always cap concurrency to respect rate limits.
- **(b) CPU-heavy parsing → `ProcessPoolExecutor`/multiprocessing** across cores (or a library that releases the GIL in C — Polars, DuckDB, NumPy — or push the work into Snowflake/Spark).

```python
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed

def fetch(url): ...          # I/O bound
def parse(path): ...         # CPU bound

with ThreadPoolExecutor(max_workers=32) as pool:
    futures = [pool.submit(fetch, u) for u in urls]
    for f in as_completed(futures):
        handle(f.result())

with ProcessPoolExecutor() as pool:             # default: one worker per CPU
    results = list(pool.map(parse, paths, chunksize=4))
```
```python
import asyncio, httpx

async def fetch_all(urls, limit=50):
    sem = asyncio.Semaphore(limit)               # concurrency cap
    async with httpx.AsyncClient(timeout=30) as client:
        async def one(u):
            async with sem:
                r = await client.get(u)
                r.raise_for_status()
                return r.json()
        return await asyncio.gather(*(one(u) for u in urls), return_exceptions=True)
```

#### What interviewers look for
Correct I/O vs CPU mapping, GIL explanation, concurrency caps, and pushing heavy work to engines.

#### Follow-up
Why can `ProcessPoolExecutor` be slower than expected? (Pickling large arguments/results between processes; process start-up cost.)

### [py-016] Context managers
level: easy
tags: context managers, resources

#### Question
What does `with` do? Write a context manager that opens a Snowflake connection, commits on success, rolls back on error, and always closes the connection.

#### Answer
`with` guarantees setup and cleanup: `__enter__` runs at the start, `__exit__` runs at the end — **even if an exception occurs**. It replaces fragile try/finally blocks.
```python
from contextlib import contextmanager

@contextmanager
def snowflake_txn(connect):
    conn = connect()                     # e.g. snowflake.connector.connect(**params)
    try:
        yield conn
        conn.commit()                    # only reached if the block didn't raise
    except Exception:
        conn.rollback()
        raise                            # never swallow the error
    finally:
        conn.close()

# usage
# with snowflake_txn(lambda: snowflake.connector.connect(**cfg)) as conn:
#     cur = conn.cursor()
#     cur.execute("BEGIN")
#     cur.execute("DELETE FROM t WHERE d = %s", (day,))
#     cur.execute("INSERT INTO t SELECT …")
```
Class version: implement `__enter__` (return the resource) and `__exit__(self, exc_type, exc, tb)` (return True only if you intend to suppress the exception — rarely).

Note for Snowflake: the connector autocommits by default; for multi-statement atomicity, disable autocommit or issue `BEGIN`, and remember DDL commits implicitly.

#### What interviewers look for
Understanding guaranteed cleanup, re-raising errors, and the transaction semantics.

#### Follow-up
Time a block of code with a context manager (`time.perf_counter()` in enter/exit).

### [py-017] Copies, identity and equality
level: easy
tags: fundamentals, references

#### Question
```python
a = {"cfg": [1, 2]}
b = a
c = a.copy()
import copy
d = copy.deepcopy(a)
a["cfg"].append(3)
```
What are `b`, `c`, `d` now? And what's the difference between `==` and `is`?

#### Answer
- `b` is the **same object** as `a` → `{"cfg": [1, 2, 3]}`.
- `c` is a **shallow copy**: a new dict, but its values are the same objects → the inner list is shared → `{"cfg": [1, 2, 3]}`.
- `d` is a **deep copy**: nested objects copied too → `{"cfg": [1, 2]}`.

`==` compares **values**; `is` compares **identity** (same object in memory). `a == c` is True; `a is c` is False; `a is b` is True. Use `is` only for singletons like `None` (`if x is None`).

Why it matters in pipelines: passing a config dict into several functions that each "modify a copy" — shallow copies of nested configs leak changes between jobs.

#### What interviewers look for
Reference semantics, shallow vs deep, `is` vs `==`.

#### Follow-up
Why is `[[0] * 3] * 3` a bug for a 3×3 grid? (All three rows are the same list object.)

### [py-018] Loading a pandas DataFrame into Snowflake efficiently
level: medium
tags: Snowflake connector, write_pandas, Snowpark

#### Question
A Python job builds a 5-million-row DataFrame that must be loaded into Snowflake. A teammate uses `executemany` INSERTs and it takes an hour. What's better?

#### Answer
Row-by-row INSERTs are slow (many round trips, tiny micro-partitions). Load in **bulk** via files and COPY:
```python
import snowflake.connector
from snowflake.connector.pandas_tools import write_pandas

conn = snowflake.connector.connect(**cfg)          # key-pair auth from a secrets manager
success, n_chunks, n_rows, _ = write_pandas(
    conn, df, table_name="CUSTOMER_SCORES", schema="ANALYTICS",
    auto_create_table=True, overwrite=False,
    chunk_size=500_000,
    use_logical_type=True,                          # correct timestamp handling
)
```
`write_pandas` writes Parquet files, `PUT`s them to a temporary stage and runs `COPY INTO` — minutes, not hours.

Other options:
- **Snowpark:** `session.write_pandas(df, "CUSTOMER_SCORES", auto_create_table=True)` or, better, do the transformation in Snowpark so data never leaves Snowflake.
- **Files + COPY yourself** for very large data: write partitioned Parquet to S3 → external stage → `COPY INTO`.
- Upserts: load into a staging table, then `MERGE` into the target in SQL.

Gotchas: column name case (pandas lowercase vs Snowflake uppercase — quoted identifiers), timezone-aware timestamps, NaN vs NULL, and memory (the DataFrame itself must fit in RAM — maybe the job should be SQL/Snowpark instead).

#### What interviewers look for
Bulk loading via stage + COPY, write_pandas, MERGE pattern, and type gotchas.

#### Follow-up
How do you read a 50 M-row query result into Python efficiently? (`cursor.fetch_pandas_batches()` — Arrow-based, in chunks.)

### [py-019] Testing pipeline code with pytest
level: medium
tags: pytest, mocking, testing

#### Question
You have a function that fetches exchange rates from an API and converts order amounts. How do you unit test it without calling the real API?

#### Answer
Design for testability: keep **pure transformation logic** separate from I/O, and inject dependencies.
```python
# pipeline.py
def convert(orders, rates):
    """Pure function: easy to test."""
    out = []
    for o in orders:
        rate = rates.get(o["currency"])
        if rate is None:
            raise ValueError(f"no rate for {o['currency']}")
        out.append({**o, "amount_inr": round(o["amount"] * rate, 2)})
    return out

def run(fetch_rates, orders):
    return convert(orders, fetch_rates())        # I/O injected as a function
```
```python
# test_pipeline.py
import pytest
from pipeline import convert, run

@pytest.mark.parametrize("amount,rate,expected", [(10, 83.0, 830.0), (0, 83.0, 0.0), (1.005, 100, 100.5)])
def test_convert_amounts(amount, rate, expected):
    assert convert([{"amount": amount, "currency": "USD"}], {"USD": rate})[0]["amount_inr"] == expected

def test_missing_rate_raises():
    with pytest.raises(ValueError, match="no rate for EUR"):
        convert([{"amount": 1, "currency": "EUR"}], {"USD": 83.0})

def test_run_uses_injected_fetcher():
    fake_fetch = lambda: {"USD": 80.0}          # no network
    assert run(fake_fetch, [{"amount": 2, "currency": "USD"}])[0]["amount_inr"] == 160.0
```
When code calls `requests` directly, patch it: `monkeypatch.setattr("pipeline.requests.get", fake_get)` or `unittest.mock.patch`. Libraries like `responses`/`respx` mock HTTP cleanly.

Test pyramid for data work: many fast unit tests on logic; a few integration tests against a dev schema; data tests (dbt) on real data in production.

#### What interviewers look for
Separating pure logic from I/O, parametrised tests, edge cases, mocking.

#### Follow-up
Why might `round(1.005 * 100, 2)` surprise you? (Floating point — use `decimal.Decimal` for money.)
