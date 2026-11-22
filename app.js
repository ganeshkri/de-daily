// DE Daily — one data-engineering interview problem a day, with spaced repetition.
// All progress is stored on this device (localStorage). Export/import lives on the Progress tab.

const CAT_COLORS = {
  SQL: "#3b82f6", Snowflake: "#06b6d4", dbt: "#f97316",
  Airflow: "#10b981", Python: "#ca8a04", Architecture: "#8b5cf6",
};
const LEVELS = ["easy", "medium", "hard"];
const INTERVALS = [1, 3, 7, 14, 30, 60, 120];   // review gaps in days, by box
const MASTERED_BOX = 4;                          // box 4+ (30+ days) counts as mastered

// ---------- storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("ded_" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ded_" + k, JSON.stringify(v)); } catch {} },
};
let progress = store.get("progress", {});          // id -> {box, due, status, reviews, last}
let starred = new Set(store.get("starred", []));
let activity = store.get("activity", {});          // "YYYY-MM-DD" -> count
let pick = store.get("pick", null);                // {date, id, rated, revealed}
let readArticles = new Set(store.get("read", []));
const save = () => {
  store.set("progress", progress); store.set("starred", [...starred]);
  store.set("activity", activity); store.set("pick", pick); store.set("read", [...readArticles]);
};

// ---------- dates ----------
const today = () => new Date().toLocaleDateString("en-CA");          // YYYY-MM-DD, local time
const addDays = (d, n) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.toLocaleDateString("en-CA"); };
const prettyDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });

// ---------- data ----------
let DATA = { problems: [], sequence: [], categories: [] };
let BYID = {};
let READING = { items: [], sources: [], topics: [] };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const color = (cat) => CAT_COLORS[cat] || "#6366f1";

// ---------- spaced repetition ----------
function statusOf(id) { return progress[id]?.status || "new"; }
function dueIds() {
  const t = today();
  return DATA.sequence.filter((id) => progress[id] && progress[id].due <= t && progress[id].status !== "new");
}
function nextUnseen() { return DATA.sequence.find((id) => !progress[id]); }
function rate(id, good) {
  const p = progress[id] || { box: -1, reviews: 0 };
  const box = good ? (p.box < 0 ? 3 : Math.min(p.box + 1, INTERVALS.length - 1)) : 0;
  progress[id] = {
    box, reviews: (p.reviews || 0) + 1, last: today(),
    due: addDays(today(), INTERVALS[box]),
    status: box >= MASTERED_BOX ? "mastered" : "learning",
  };
  activity[today()] = (activity[today()] || 0) + 1;
  save();
}
function streak() {
  let n = 0, d = today();
  if (!activity[d]) d = addDays(d, -1);              // today not done yet: count up to yesterday
  while (activity[d]) { n++; d = addDays(d, -1); }
  return n;
}
function longestStreak() {
  const days = Object.keys(activity).filter((d) => activity[d]).sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) { run = prev && addDays(prev, 1) === d ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  return best;
}

// ---------- rendering helpers ----------
function pills(p) {
  const st = statusOf(p.id);
  return `<div class="pills" style="--c:${color(p.category)}">
    <span class="pill">${esc(p.category)}</span>
    <span class="pill level ${p.level}">${p.level}</span>
    ${p.asked ? '<span class="pill asked">Asked in a real interview</span>' : ""}
    ${st !== "new" ? `<span class="pill status">${st}</span>` : ""}
  </div>`;
}
function polish(root) {
  root.querySelectorAll(".content table").forEach((t) => {
    if (t.parentElement.classList.contains("table-wrap")) return;
    const w = document.createElement("div"); w.className = "table-wrap"; t.replaceWith(w); w.appendChild(t);
  });
  root.querySelectorAll(".content a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
}
function problemCard(p, { revealed, onRate, rated }) {
  const el = document.createElement("article");
  el.className = "card";
  el.style.setProperty("--c", color(p.category));
  el.innerHTML = `
    <div class="card-top">${pills(p)}
      <button class="star ${starred.has(p.id) ? "on" : ""}" type="button" aria-label="Star">${starred.has(p.id) ? "★" : "☆"}</button>
    </div>
    <h2>${esc(p.title)}</h2>
    <div class="section-title">❓ Question</div>
    <div class="content">${p.question}</div>
    <div class="answer-zone"></div>`;
  el.querySelector(".star").onclick = (e) => {
    starred.has(p.id) ? starred.delete(p.id) : starred.add(p.id); save();
    e.currentTarget.classList.toggle("on", starred.has(p.id));
    e.currentTarget.textContent = starred.has(p.id) ? "★" : "☆";
  };
  const zone = el.querySelector(".answer-zone");
  const showAnswer = () => {
    zone.innerHTML = `
      <div class="section-title">✅ Answer</div><div class="content">${p.answer}</div>
      <div class="section-title">🎯 What interviewers look for</div><div class="content">${p.lookfor}</div>
      <div class="section-title">➕ Follow-up</div><div class="content">${p.followup}</div>
      ${rated ? "" : `<div class="rate">
         <button class="again" type="button">↺ Review again</button>
         <button class="good" type="button">✓ Got it</button></div>
       <p class="rate-note">"Review again" brings it back tomorrow · "Got it" spaces it out (2 weeks, then a month…)</p>`}`;
    polish(zone);
    zone.querySelector(".again")?.addEventListener("click", () => onRate(false));
    zone.querySelector(".good")?.addEventListener("click", () => onRate(true));
  };
  if (revealed) showAnswer();
  else {
    const b = document.createElement("button");
    b.className = "reveal"; b.type = "button"; b.textContent = "Show answer";
    b.onclick = () => { showAnswer(); onReveal?.(); };
    zone.appendChild(b);
  }
  let onReveal = null;
  el.setRevealHook = (fn) => { onReveal = fn; };
  polish(el);
  return el;
}
function problemRow(p, onOpen) {
  const el = document.createElement("div");
  const st = statusOf(p.id);
  el.className = "row" + (st === "mastered" ? " done" : "");
  el.style.setProperty("--c", color(p.category));
  const due = progress[p.id]?.due;
  el.innerHTML = `<div class="main"><div class="t">${starred.has(p.id) ? "★ " : ""}${esc(p.title)}</div>
    <div class="s">${esc(p.category)} · ${p.level}${p.asked ? " · asked in interview" : ""}${st !== "new" ? ` · ${st}${due ? ` · next ${due}` : ""}` : ""}</div></div>
    <div class="go">›</div>`;
  el.onclick = () => onOpen(p.id);
  return el;
}

// ---------- Today ----------
function ensurePick() {
  const t = today();
  if (pick && pick.date === t && BYID[pick.id]) return;
  const id = nextUnseen() || dueIds()[0] || DATA.sequence[Math.floor(Math.random() * DATA.sequence.length)];
  pick = { date: t, id, rated: false, revealed: false };
  save();
}
function renderToday() {
  ensurePick();
  const v = $("view-today");
  v.innerHTML = "";
  const seen = Object.keys(progress).length;
  setHero("DE Daily", `${prettyDate(today())} · ${seen} of ${DATA.problems.length} problems done`,
    `<div class="meter"><span style="width:${(100 * seen / Math.max(1, DATA.problems.length)).toFixed(1)}%"></span></div>`);

  if (pick.rated) {
    const doneToday = activity[today()] || 0;
    v.insertAdjacentHTML("beforeend", `<div class="done-banner"><b>🎉 Today's problem done</b>
      ${doneToday} answered today · come back tomorrow, or keep going</div>`);
  }
  const p = BYID[pick.id];
  const card = problemCard(p, {
    revealed: pick.revealed, rated: pick.rated,
    onRate: (good) => { rate(p.id, good); pick.rated = true; pick.revealed = true; save(); renderToday(); window.scrollTo(0, 0); },
  });
  card.setRevealHook(() => { pick.revealed = true; save(); });
  v.appendChild(card);

  if (pick.rated) {
    const nxt = nextUnseen();
    const b = document.createElement("button");
    b.className = "next"; b.type = "button";
    b.style.setProperty("--c", "#6366f1");
    b.textContent = nxt ? "Next problem →" : "All problems seen — pick a random one →";
    b.onclick = () => {
      pick = { date: today(), id: nxt || DATA.sequence[Math.floor(Math.random() * DATA.sequence.length)], rated: false, revealed: false };
      save(); renderToday(); window.scrollTo(0, 0);
    };
    v.appendChild(b);
  }

  const due = dueIds().filter((id) => id !== pick.id);
  v.insertAdjacentHTML("beforeend", `<div class="label" style="margin-top:22px">Due for review (${due.length})</div>`);
  if (!due.length) v.insertAdjacentHTML("beforeend", `<p class="empty" style="padding:12px">Nothing due. Problems you mark "Review again" come back here.</p>`);
  due.slice(0, 30).forEach((id) => v.appendChild(problemRow(BYID[id], openSheet)));
  updateStreak();
}

// ---------- Sheet (single problem) ----------
function openSheet(id) {
  const p = BYID[id];
  const body = $("sheetBody");
  body.innerHTML = "";
  body.appendChild(problemCard(p, {
    revealed: false, rated: false,
    onRate: (good) => { rate(id, good); closeSheet(); },
  }));
  $("sheet").hidden = false;
  $("sheet").scrollTop = 0;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("sheet").hidden = true;
  document.body.style.overflow = "";
  render();
}
$("sheetBack").onclick = closeSheet;

// ---------- Library ----------
const lib = { cat: "All", level: "All", status: "All", q: "" };
function chipRow(options, current, onPick, colorFn) {
  const row = document.createElement("div");
  row.className = "chips";
  options.forEach(([key, label, n]) => {
    const b = document.createElement("button");
    b.className = "chip"; b.type = "button";
    b.style.setProperty("--c", colorFn(key));
    b.setAttribute("aria-pressed", String(key === current));
    b.innerHTML = `${esc(label)}${n !== undefined ? `<span class="n">${n}</span>` : ""}`;
    b.onclick = () => onPick(key);
    row.appendChild(b);
  });
  return row;
}
function renderLibrary() {
  if (!$("search")) {
    setHero("Library", `${DATA.problems.length} problems · ${DATA.categories.length} topics`,
      `<input id="search" type="search" placeholder="🔍  Search titles, tags, answers" autocomplete="off">`);
    $("search").value = lib.q;
    $("search").addEventListener("input", (e) => { lib.q = e.target.value; renderLibraryList(); });
  }
  renderLibraryList();
}
function renderLibraryList() {
  const v = $("view-library");
  v.innerHTML = "";
  const P = DATA.problems;
  const countBy = (fn) => P.filter(fn).length;
  v.appendChild(chipRow([["All", "All", P.length], ...DATA.categories.map((c) => [c, c, countBy((p) => p.category === c)])],
    lib.cat, (k) => { lib.cat = k; renderLibraryList(); }, (k) => k === "All" ? "#6366f1" : color(k)));
  v.appendChild(chipRow([["All", "Any level"], ...LEVELS.map((l) => [l, l[0].toUpperCase() + l.slice(1), countBy((p) => p.level === l)])],
    lib.level, (k) => { lib.level = k; renderLibraryList(); },
    (k) => ({ easy: "#16a34a", medium: "#d97706", hard: "#dc2626" }[k] || "#64748b")));
  const statuses = [["All", "Any status"], ["new", "New"], ["learning", "Learning"], ["mastered", "Mastered"], ["starred", "★ Starred"], ["asked", "Asked in interviews"]];
  v.appendChild(chipRow(statuses, lib.status, (k) => { lib.status = k; renderLibraryList(); },
    (k) => ({ new: "#64748b", learning: "#e11d48", mastered: "#16a34a", starred: "#f59e0b", asked: "#ec4899" }[k] || "#6366f1")));

  const q = lib.q.trim().toLowerCase();
  const list = DATA.sequence.map((id) => BYID[id]).filter((p) => {
    if (lib.cat !== "All" && p.category !== lib.cat) return false;
    if (lib.level !== "All" && p.level !== lib.level) return false;
    if (lib.status === "starred" && !starred.has(p.id)) return false;
    if (lib.status === "asked" && !p.asked) return false;
    if (["new", "learning", "mastered"].includes(lib.status) && statusOf(p.id) !== lib.status) return false;
    if (q && !(`${p.title} ${p.tags.join(" ")} ${p.category} ${stripTags(p.question)} ${stripTags(p.answer)}`.toLowerCase().includes(q))) return false;
    return true;
  });
  v.insertAdjacentHTML("beforeend", `<div class="label">${list.length} problem${list.length === 1 ? "" : "s"}</div>`);
  if (!list.length) v.insertAdjacentHTML("beforeend", `<p class="empty">No problems match.</p>`);
  list.forEach((p) => v.appendChild(problemRow(p, openSheet)));
}
const stripCache = {};
function stripTags(html) { return stripCache[html] ??= html.replace(/<[^>]+>/g, " "); }

// ---------- Reading ----------
const rd = { source: "All", topic: "All" };
function renderReading() {
  const v = $("view-reading");
  v.innerHTML = "";
  const upd = READING.updated ? new Date(READING.updated).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never";
  setHero("Reading", `Best of Substack, Medium & official blogs · updated ${upd}`, "");
  if (!READING.items.length) {
    v.innerHTML = `<p class="empty">No articles yet.<br>On GitHub, open the <b>Actions</b> tab → <b>Update reading list</b> → <b>Run workflow</b>.<br>After that it refreshes every morning.</p>`;
    return;
  }
  const items = READING.items;
  const srcs = [...new Set(items.map((i) => i.source))];
  const palette = ["#0ea5e9", "#6366f1", "#a855f7", "#ec4899", "#f97316", "#10b981", "#06b6d4", "#ca8a04", "#e11d48", "#14b8a6"];
  const srcColor = (s) => s === "All" ? "#6366f1" : palette[srcs.indexOf(s) % palette.length];
  v.appendChild(chipRow([["All", "All topics"], ...READING.topics.map((t) => [t, t, items.filter((i) => i.topics.includes(t)).length]).filter(([, , n]) => n)],
    rd.topic, (k) => { rd.topic = k; renderReading(); }, (k) => k === "All" ? "#6366f1" : (CAT_COLORS[k] || "#a855f7")));
  v.appendChild(chipRow([["All", "All sources"], ...srcs.map((s) => [s, s, items.filter((i) => i.source === s).length])],
    rd.source, (k) => { rd.source = k; renderReading(); }, srcColor));
  const list = items.filter((i) => (rd.source === "All" || i.source === rd.source) && (rd.topic === "All" || i.topics.includes(rd.topic)));
  list.slice(0, 150).forEach((i) => {
    const a = document.createElement("a");
    a.className = "article" + (readArticles.has(i.url) ? " read" : "");
    a.href = i.url; a.target = "_blank"; a.rel = "noopener";
    a.style.setProperty("--c", srcColor(i.source));
    const d = i.date ? new Date(i.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";
    a.innerHTML = `<div class="src">${esc(i.source)}${d ? " · " + d : ""}</div><div class="t">${esc(i.title)}</div>
      ${i.snippet ? `<div class="sn">${esc(i.snippet)}</div>` : ""}`;
    a.onclick = () => { readArticles.add(i.url); save(); setTimeout(() => a.classList.add("read"), 300); };
    v.appendChild(a);
  });
  const failed = READING.sources.filter((s) => !s.ok).map((s) => s.name);
  if (failed.length) v.insertAdjacentHTML("beforeend", `<p class="legend">Not reachable at last update: ${esc(failed.join(", "))}</p>`);
}

// ---------- Progress ----------
let confirmReset = false;
function renderProgress() {
  const v = $("view-progress");
  const P = DATA.problems;
  const seen = P.filter((p) => progress[p.id]).length;
  const mastered = P.filter((p) => statusOf(p.id) === "mastered").length;
  setHero("Progress", `${seen} seen · ${mastered} mastered · ${dueIds().length} due for review`,
    `<div class="meter"><span style="width:${(100 * seen / Math.max(1, P.length)).toFixed(1)}%"></span></div>`);
  const bars = (groups, colorFn) => groups.map(([name, items]) => {
    const m = items.filter((p) => statusOf(p.id) === "mastered").length;
    const l = items.filter((p) => statusOf(p.id) === "learning").length;
    return `<div class="bar-row" style="--c:${colorFn(name)}"><div class="bar-head"><span>${esc(name)}</span>
      <span>${m + l} / ${items.length}</span></div>
      <div class="bar"><div class="m" style="width:${100 * m / items.length}%"></div><div class="l" style="width:${100 * l / items.length}%"></div></div></div>`;
  }).join("");
  v.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><b>🔥 ${streak()}</b><span>day streak</span></div>
      <div class="stat"><b>${longestStreak()}</b><span>longest streak</span></div>
      <div class="stat"><b>${Object.values(activity).reduce((a, b) => a + b, 0)}</b><span>answers given</span></div>
    </div>
    <div class="label">By topic</div>
    ${bars(DATA.categories.map((c) => [c, P.filter((p) => p.category === c)]), color)}
    <p class="legend">Solid = mastered · light = learning</p>
    <div class="label">By level</div>
    ${bars(LEVELS.map((l) => [l[0].toUpperCase() + l.slice(1), P.filter((p) => p.level === l)]),
      (n) => ({ Easy: "#16a34a", Medium: "#d97706", Hard: "#dc2626" }[n]))}
    <div class="label" style="margin-top:16px">Backup</div>
    <div class="tools">
      <button id="exportBtn" type="button">Copy my progress (to move to another phone)</button>
      <button id="importBtn" type="button">Restore progress from a copy</button>
      <button id="resetBtn" class="danger" type="button">${confirmReset ? "Tap again to erase all progress" : "Reset all progress"}</button>
    </div>
    <div id="io"></div>`;
  $("exportBtn").onclick = async () => {
    const blob = JSON.stringify({ progress, starred: [...starred], activity, read: [...readArticles] });
    $("io").innerHTML = `<textarea class="io" readonly>${esc(blob)}</textarea><p class="legend">Copied if your browser allows — otherwise select the text above and copy it.</p>`;
    try { await navigator.clipboard.writeText(blob); } catch {}
  };
  $("importBtn").onclick = () => {
    $("io").innerHTML = `<textarea class="io" id="importText" placeholder="Paste your copied progress here"></textarea>
      <div class="tools"><button id="doImport" type="button">Restore</button></div>`;
    $("doImport").onclick = () => {
      try {
        const d = JSON.parse($("importText").value);
        progress = d.progress || {}; starred = new Set(d.starred || []); activity = d.activity || {}; readArticles = new Set(d.read || []);
        pick = null; save(); renderProgress();
      } catch { $("io").insertAdjacentHTML("beforeend", `<p class="legend">That doesn't look like a valid copy.</p>`); }
    };
  };
  $("resetBtn").onclick = () => {
    if (!confirmReset) { confirmReset = true; renderProgress(); setTimeout(() => { confirmReset = false; }, 4000); return; }
    progress = {}; starred = new Set(); activity = {}; pick = null; readArticles = new Set(); confirmReset = false;
    save(); renderProgress();
  };
  updateStreak();
}

// ---------- shell ----------
let view = "today";
function setHero(title, sub, extraHtml) {
  $("heroTitle").textContent = title;
  $("heroSub").textContent = sub;
  if (view !== "library" || !$("search")) $("heroExtra").innerHTML = extraHtml || "";
}
function updateStreak() { $("streak").textContent = `🔥 ${streak()}`; }
function render() {
  ["today", "library", "reading", "progress"].forEach((n) => { $("view-" + n).hidden = n !== view; });
  if (view !== "library") $("heroExtra").innerHTML = "";
  ({ today: renderToday, library: renderLibrary, reading: renderReading, progress: renderProgress })[view]();
  updateStreak();
}
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    if (view === t.dataset.view) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    view = t.dataset.view;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    $("heroExtra").innerHTML = "";
    render(); window.scrollTo(0, 0);
  };
});

async function load() {
  try {
    const [p, r] = await Promise.all([
      fetch("data/problems.json", { cache: "no-cache" }).then((x) => x.json()),
      fetch("data/reading.json", { cache: "no-cache" }).then((x) => x.json()).catch(() => READING),
    ]);
    DATA = p; READING = { items: [], sources: [], topics: [], ...r };
    BYID = Object.fromEntries(DATA.problems.map((q) => [q.id, q]));
    // drop progress for problems that no longer exist
    for (const id of Object.keys(progress)) if (!BYID[id]) delete progress[id];
    render();
  } catch (e) {
    $("heroSub").textContent = "Couldn't load problems — check your connection.";
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && DATA.problems.length && $("sheet").hidden) render();   // new day → new problem
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
load();
