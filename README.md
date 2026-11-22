# DE Daily

One data-engineering interview problem a day — SQL, Snowflake, dbt, Airflow, Python and Architecture —
with answers, "what interviewers look for", follow-ups, spaced repetition, and a daily reading list
from the best data-engineering newsletters and blogs.

- **129 original problems** (26 easy · 73 medium · 30 hard), including 15 questions from real interviews.
- **Today tab:** one problem a day. Read it, think, tap **Show answer**, then **Got it** or **Review again**.
  "Review again" brings it back tomorrow; "Got it" spaces it out (2 weeks → 1 month → 2 months…).
- **Library:** browse and search everything by topic, level and status (new / learning / mastered / starred / asked in interviews).
- **Reading:** new articles every morning from SeattleDataGuy, Data Engineering Weekly, DataExpert.io,
  Data Engineer Things, Snowflake Builders Blog, dbt Developer Blog, Apache Airflow Blog, Astronomer,
  Start Data Engineering and Joe Reis. Tapping opens the original article.
- **Progress:** streaks, topic-wise progress, and backup/restore of your progress.

Your progress is stored on your phone only.

---

## One-time setup (same steps as Web Reader)

### 1. Create the repository
github.com → **+** → **New repository** → name `de-daily` → **Public** → **Create repository**.

### 2. Upload the files
1. Click **uploading an existing file**.
2. Unzip `de-daily.zip`, open the `de-daily` folder, select everything **except** `.github`
   (`app.js`, `code.css`, `index.html`, `manifest.webmanifest`, `README.md`, `styles.css`, `sw.js`
   and the folders `content`, `data`, `icons`, `scripts`) and drag them into the upload box.
3. **Commit changes.**

### 3. Create the two workflow files by hand
GitHub's upload page won't take the `.github` folder, so create each file:
**Add file → Create new file**, type the name, paste the contents, **Commit changes** (twice).

- Name: `.github/workflows/update-reading.yml` — contents: open that file from the zip in Notepad, copy all, paste.
- Name: `.github/workflows/build-problems.yml` — same way.

### 4. Settings
- **Settings → Actions → General → Workflow permissions → Read and write permissions → Save.**
- **Settings → Pages → Deploy from a branch → `main` / `(root)` → Save.**
  Your app will be at `https://<your-username>.github.io/de-daily/`

### 5. Load the reading list the first time
**Actions → Update reading list → Run workflow.** After that it runs every morning (~6:13 am IST).
The problems are already built — nothing to run for them.

### 6. Install on your iPhone
Open the link in **Safari → Share → Add to Home Screen → Add.**

---

## Adding your own interview questions

Open a file in `content/` on GitHub (e.g. `content/snowflake.md`), click the ✏️ pencil, and add a problem
at the end in the same format:

```
### [sf-032] Your question title
level: medium
tags: streams, CDC
asked: yes

#### Question
...
#### Answer
...
#### What interviewers look for
...
#### Follow-up
...
```

Commit. The **Build problems** workflow rebuilds `data/problems.json` automatically within a minute,
and the new problem appears in the app. Keep ids unique.

## Adding or removing reading sources
Edit the `FEEDS` list at the top of `scripts/fetch_feeds.py`. A source that fails on a given day keeps
its previous articles; the Reading tab lists any source that couldn't be reached.

## Moving to a new phone
Progress tab → **Copy my progress** → paste it into a note → on the new phone, Progress → **Restore progress**.
