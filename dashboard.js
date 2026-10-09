(() => {
  "use strict";

  // First "A" day of the current A/B split. Everything before it belongs to the
  // previous program and is left out. Every two workout days, counted back from
  // the most recent one, form one complete A+B program (one data point).
  const SPLIT_START = "2026-09-16";
  const WINDOW_KEY = "gmcoach_momentum_window";
  const RECENT_WINDOW = 4; // programs used by the "Last 4" momentum view
  const FETCH_CONCURRENCY = 6;

  const { api, showView, toast, escapeHtml, isAuthError, requireNewToken, enterWorkoutsView } = window.GMCoach;

  const dash = {
    programs: [], // [{days: [older, newer]}], oldest first
    muscles: [], // [{name, exercises: [...], series: [vol|null per program]}]
    unit: "kg",
    window: readWindowPref(),
    openExercises: new Set(), // groupIds with their full chart expanded
    showValues: new Set(), // chart keys showing per-point value labels
  };

  const body = document.getElementById("progress-body");

  // ---------------- Preferences ----------------

  function readWindowPref() {
    try {
      return localStorage.getItem(WINDOW_KEY) === "recent" ? "recent" : "all";
    } catch (_) {
      return "all";
    }
  }

  function writeWindowPref(v) {
    try {
      localStorage.setItem(WINDOW_KEY, v);
    } catch (_) {
      /* storage unavailable: preference just won't persist */
    }
  }

  // ---------------- Data ----------------

  // GM Manager occasionally drops a connection, so dashboard reads (which fan
  // out to ~30 requests) retry once and run a few at a time.
  async function apiRetry(path) {
    try {
      return await api(path);
    } catch (e) {
      if (e.status !== 0) throw e;
      return api(path);
    }
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // ---------------- Local cache ----------------
  //
  // GM Manager takes 5-10s per request, and a full load is ~30 of them. Almost
  // all of it is immutable: an exercise's muscle never changes, and a finished
  // day's volume never changes. So the raw data is kept in localStorage, the
  // dashboard draws from it immediately, and a sync only fetches what's new:
  // the session list, plus volume history for exercises that have a workout
  // day the cache hasn't seen (today is always re-checked, as it may still be
  // in progress).

  const CACHE_KEY = "gmcoach_dash_cache_v1";

  function accountKey() {
    let t = "";
    try {
      t = localStorage.getItem("gmcoach_token") || "";
    } catch (_) {
      /* no storage */
    }
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    return String(h);
  }

  function emptyStore() {
    return { account: accountKey(), unit: "kg", sessions: null, muscleOf: {}, vol: {}, maxW: {}, checked: {} };
  }

  function loadStore() {
    try {
      const st = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (st && st.account === accountKey()) {
        // Caches saved before max weight was tracked: keep the muscle lookups,
        // re-fetch the histories once to pick up maxWeight.
        if (!st.maxW) {
          st.maxW = {};
          st.checked = {};
        }
        return st;
      }
    } catch (_) {
      /* unreadable cache: start over */
    }
    return emptyStore();
  }

  function saveStore(st) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(st));
    } catch (_) {
      /* storage full or blocked: next visit just loads from scratch */
    }
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Fetches whatever the store is missing and returns the updated store.
  async function sync(st, onProgress) {
    const sessionsData = await apiRetry(`/sessions?from=${SPLIT_START}&includeExercises=true`);
    st.unit = sessionsData.unit || "kg";
    st.sessions = (sessionsData.sessions || [])
      .filter((s) => s.detailType === "template" || s.detailType === "course")
      .map((s) => ({
        date: s.date,
        exercises: (s.exercises || []).filter((e) => e.groupId != null).map((e) => ({ groupId: e.groupId, name: e.name })),
      }));

    const daysOf = new Map(); // groupId -> Set of days performed
    for (const s of st.sessions) {
      for (const e of s.exercises) {
        if (!daysOf.has(e.groupId)) daysOf.set(e.groupId, new Set());
        daysOf.get(e.groupId).add(s.date);
      }
    }
    const today = todayStr();
    const todo = [...daysOf.entries()].filter(([gid, days]) => {
      const checked = new Set(st.checked[gid] || []);
      return !(gid in st.muscleOf) || [...days].some((d) => d === today || !checked.has(d));
    });

    let done = 0;
    if (onProgress) onProgress(done, todo.length);
    await mapLimit(todo, FETCH_CONCURRENCY, async ([gid, days]) => {
      if (!(gid in st.muscleOf)) {
        const c = await apiRetry(`/exercises/${gid}`);
        st.muscleOf[gid] = c.muscle || (c.muscles && c.muscles[0]) || "Other";
      }
      const checked = new Set(st.checked[gid] || []);
      if ([...days].some((d) => d === today || !checked.has(d))) {
        const hist = await apiRetry(`/exercises/${gid}/history?limit=200`);
        const vol = {};
        const maxW = {};
        for (const h of hist.history || []) {
          if (h.totalCapacity != null) vol[h.dayStr] = (vol[h.dayStr] || 0) + h.totalCapacity;
          if (h.maxWeight != null) maxW[h.dayStr] = Math.max(maxW[h.dayStr] || 0, h.maxWeight);
        }
        st.vol[gid] = vol;
        st.maxW[gid] = maxW;
        st.checked[gid] = [...days].filter((d) => d !== today);
      }
      done++;
      if (onProgress) onProgress(done, todo.length);
    });

    saveStore(st);
    return st;
  }

  // Builds programs and the muscle -> exercise -> series model from the store.
  function buildModel(st) {
    dash.unit = st.unit || "kg";
    const sessions = st.sessions || [];

    // Two sessions on one date are one workout day.
    const daysNewestFirst = [...new Set(sessions.map((s) => s.date))].sort().reverse();
    const programs = [];
    for (let i = 0; i + 1 < daysNewestFirst.length; i += 2) {
      programs.push({ days: [daysNewestFirst[i + 1], daysNewestFirst[i]] });
    }
    // An odd day left over at the start is half a program; it's dropped
    // rather than plotted as a fake dip for the muscles it didn't train.
    programs.reverse();
    const programOfDay = new Map();
    programs.forEach((p, idx) => p.days.forEach((d) => programOfDay.set(d, idx)));

    // Exercises in first-seen order (oldest session first) so muscle groups
    // and their exercises appear in the order the program runs them.
    const exercises = new Map();
    for (const s of [...sessions].sort((a, b) => (a.date < b.date ? -1 : 1))) {
      if (!programOfDay.has(s.date)) continue;
      for (const e of s.exercises) {
        if (!exercises.has(e.groupId)) {
          exercises.set(e.groupId, { groupId: e.groupId, name: e.name || `#${e.groupId}`, days: new Set() });
        }
        exercises.get(e.groupId).days.add(s.date);
      }
    }

    const list = [...exercises.values()];
    for (const ex of list) {
      ex.muscle = st.muscleOf[ex.groupId] || "Other";
      // vol holds Speediance's own per-day volume (totalCapacity) for the
      // movement, which already accounts for drop-offs and partial reps.
      const vol = st.vol[ex.groupId] || {};
      const maxW = (st.maxW && st.maxW[ex.groupId]) || {};
      ex.series = programs.map(() => null);
      ex.maxWeight = programs.map(() => null); // heaviest load in the program
      for (const d of ex.days) {
        const idx = programOfDay.get(d);
        if (vol[d] != null) ex.series[idx] = (ex.series[idx] || 0) + vol[d];
        if (maxW[d] != null) ex.maxWeight[idx] = Math.max(ex.maxWeight[idx] || 0, maxW[d]);
      }
    }

    const muscles = new Map();
    for (const ex of list) {
      if (!ex.series.some((v) => v != null)) continue;
      if (!muscles.has(ex.muscle)) muscles.set(ex.muscle, { name: ex.muscle, exercises: [] });
      muscles.get(ex.muscle).exercises.push(ex);
    }
    for (const m of muscles.values()) {
      m.series = programs.map((_, i) => {
        const vals = m.exercises.map((ex) => ex.series[i]).filter((v) => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      });
    }

    dash.programs = programs;
    dash.muscles = [...muscles.values()];
  }

  // ---------------- Metrics ----------------

  // Growth rate per program from a least-squares fit of log(volume) against
  // program index. Using the fit instead of first-vs-last keeps one off day
  // from swinging the number, and working in log space makes it a percentage,
  // so a small muscle and a big one are compared on the same footing.
  function growth(series) {
    const start = dash.window === "recent" ? Math.max(0, series.length - RECENT_WINDOW) : 0;
    const pts = [];
    for (let i = start; i < series.length; i++) if (series[i] > 0) pts.push([i, Math.log(series[i])]);
    if (pts.length < 2) return null;
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const [x, y] of pts) {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) * (x - mx);
    }
    const b = sxy / sxx;
    const a = my - b * mx;
    return {
      pct: (Math.exp(b) - 1) * 100,
      n,
      start: pts[0][0],
      end: pts[n - 1][0],
      fit: (i) => Math.exp(a + b * i),
    };
  }

  function totalSeries() {
    return dash.programs.map((_, i) => {
      const vals = dash.muscles.map((m) => m.series[i]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    });
  }

  function lastValue(series) {
    for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return { value: series[i], index: i };
    return null;
  }

  // ---------------- Formatting ----------------

  function fmtVol(v) {
    return Math.round(v).toLocaleString();
  }

  function fmtWeight(v) {
    return String(Math.round(v * 10) / 10);
  }

  function fmtPct(p) {
    const r = Math.round(p * 10) / 10;
    return (r > 0 ? "+" : "") + r.toFixed(1) + "%";
  }

  function shortDate(dayStr) {
    const [y, m, d] = dayStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function programLabel(p) {
    return `${shortDate(p.days[0])} – ${shortDate(p.days[1])}`;
  }

  function trendClass(pct) {
    if (pct == null || Math.abs(pct) < 0.5) return "flat";
    return pct > 0 ? "up" : "down";
  }

  function trendPill(g, suffix = "/program") {
    if (!g) return `<span class="trend-pill flat">—</span>`;
    const cls = trendClass(g.pct);
    const arrow = cls === "up" ? "▲" : cls === "down" ? "▼" : "◆";
    return `<span class="trend-pill ${cls}">${arrow} ${fmtPct(g.pct)}<span class="trend-pill-unit">${suffix}</span></span>`;
  }

  // ---------------- Charts ----------------

  // Line chart drawn at the container's real pixel width so text and dots
  // stay crisp. The y-axis is fitted to the data (not zero-based): a 5% gain
  // on 3,800 kg is the whole story and would vanish against a zero baseline.
  //
  // `secondary` (max weight) gets its own scale on the right-hand axis, so a
  // ~30 kg weight line and a ~1,000 kg volume line share one plot. Each axis
  // is labelled with its range and the legend names both lines.
  function lineChart({ series, key, height = 132, showTrend = true, secondary = null }) {
    const w = Math.max(240, chartWidth());
    const vals = series.filter((v) => v != null);
    if (vals.length === 0) return `<div class="chart-empty">No data</div>`;
    const sec = secondary && secondary.some((v) => v != null) ? secondary : null;
    const padL = sec ? 40 : 6;
    const padR = sec ? 34 : 6;
    const padT = 22;
    const padB = 22;
    const g = showTrend ? growth(series) : null;

    function scale(values, extra = []) {
      let lo = Math.min(...values, ...extra);
      let hi = Math.max(...values, ...extra);
      const span = hi - lo || hi * 0.1 || 1;
      lo -= span * 0.12;
      hi += span * 0.12;
      return { lo, hi, y: (v) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB) };
    }
    const fitVals = g ? Array.from({ length: g.end - g.start + 1 }, (_, k) => g.fit(g.start + k)) : [];
    const ys = scale(vals, fitVals);
    const y = ys.y;
    const ws = sec ? scale(sec.filter((v) => v != null)) : null;

    const n = series.length;
    // With a right-hand axis, points sit further in so their value labels
    // clear the axis numbers.
    const inset = sec ? 22 : 10;
    const x = (i) => (n === 1 ? (padL + w - padR) / 2 : padL + inset + (i * (w - padL - padR - 2 * inset)) / (n - 1));

    // Value labels go above their point, except where the other line's point
    // is higher: then the two labels split (upper line above, lower below) so
    // they never land on each other. Labels near an edge flip inward.
    const plotTop = padT;
    const plotBot = height - padB;
    function labelY(py, above) {
      let ly = above ? py - 9 : py + 16;
      if (ly < plotTop - 8) ly = py + 16;
      if (ly > plotBot - 2) ly = py - 9;
      return ly;
    }
    const showVals = dash.showValues.has(key);

    function pathFor(values, yf) {
      let d = "";
      let pen = false;
      values.forEach((v, i) => {
        if (v == null) {
          pen = false;
          return;
        }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${yf(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    }

    // Label positions for both lines at each point, resolved together.
    const volLabelY = [];
    const wLabelY = [];
    series.forEach((v, i) => {
      const w8 = sec ? sec[i] : null;
      if (v == null || w8 == null) {
        if (v != null) volLabelY[i] = labelY(y(v), true);
        if (w8 != null) wLabelY[i] = labelY(ws.y(w8), true);
        return;
      }
      const vy = y(v);
      const wy = ws.y(w8);
      let lv = labelY(vy, wy >= vy);
      let lw = labelY(wy, wy < vy);
      if (Math.abs(lv - lw) < 13) {
        // Points too close to separate around: stack both labels on one side.
        const topY = Math.min(vy, wy) - 9;
        if (topY - 13 >= plotTop - 8) {
          lv = topY - 13;
          lw = topY;
        } else {
          lv = Math.max(vy, wy) + 16;
          lw = lv + 13;
        }
      }
      volLabelY[i] = lv;
      wLabelY[i] = lw;
    });

    const trend = g
      ? `<line class="lc-trend" x1="${x(g.start)}" y1="${y(g.fit(g.start))}" x2="${x(g.end)}" y2="${y(g.fit(g.end))}" />`
      : "";

    // Thin the x labels so they never collide: at most ~one per 46px.
    const plotW = w - padL - padR;
    const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 46))));
    const last = lastValue(series);
    const dots = series
      .map((v, i) => {
        if (v == null) return "";
        const isLast = last && i === last.index;
        const label = showVals || isLast ? `<text class="lc-val" x="${x(i)}" y="${volLabelY[i]}">${fmtVol(v)}</text>` : "";
        const wt = sec && sec[i] != null ? ` · max ${fmtWeight(sec[i])} ${dash.unit}` : "";
        return `<g><title>${programLabel(dash.programs[i])}: ${fmtVol(v)} ${dash.unit} volume${wt}</title>
          <circle class="lc-hit" cx="${x(i)}" cy="${y(v)}" r="14" />
          <circle class="lc-dot${isLast ? " lc-dot-last" : ""}" cx="${x(i)}" cy="${y(v)}" r="${isLast ? 4.5 : 3.5}" />${label}</g>`;
      })
      .join("");

    let secLayer = "";
    let axes = "";
    let legend = "";
    if (sec) {
      const lastW = lastValue(sec);
      const secDots = sec
        .map((v, i) => {
          if (v == null) return "";
          const isLast = lastW && i === lastW.index;
          const label = showVals || isLast ? `<text class="lc-val lc-val-w" x="${x(i)}" y="${wLabelY[i]}">${fmtWeight(v)}</text>` : "";
          return `<g><title>${programLabel(dash.programs[i])}: max ${fmtWeight(v)} ${dash.unit}</title>
            <rect class="lc-dot-w" x="${x(i) - 3.5}" y="${ws.y(v) - 3.5}" width="7" height="7" rx="1.5" />${label}</g>`;
        })
        .join("");
      secLayer = `<path class="lc-line-w" d="${pathFor(sec, ws.y)}" />${secDots}`;
      const top = padT;
      const bot = height - padB;
      const vAt = (yy) => ys.lo + (1 - (yy - padT) / (height - padT - padB)) * (ys.hi - ys.lo);
      const wAt = (yy) => ws.lo + (1 - (yy - padT) / (height - padT - padB)) * (ws.hi - ws.lo);
      axes = `
        <text class="lc-axis" x="${padL - 6}" y="${top + 4}" text-anchor="end">${fmtVol(vAt(top))}</text>
        <text class="lc-axis" x="${padL - 6}" y="${bot}" text-anchor="end">${fmtVol(vAt(bot))}</text>
        <text class="lc-axis" x="${w - padR + 6}" y="${top + 4}" text-anchor="start">${fmtWeight(wAt(top))}</text>
        <text class="lc-axis" x="${w - padR + 6}" y="${bot}" text-anchor="start">${fmtWeight(wAt(bot))}</text>`;
      legend = `<div class="lc-legend">
        <span><i class="lg-vol"></i>Volume (${dash.unit}) · left</span>
        <span><i class="lg-w"></i>Max weight (${dash.unit}) · right</span>
      </div>`;
    }

    const xLabels = dash.programs
      .map((p, i) => {
        if ((n - 1 - i) % step !== 0) return "";
        return `<text class="lc-x" x="${x(i)}" y="${height - 6}">${shortDate(p.days[1])}</text>`;
      })
      .join("");

    return `${legend}<svg class="line-chart" data-key="${key}" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" role="img">
      <line class="lc-base" x1="${padL}" y1="${height - padB}" x2="${w - padR}" y2="${height - padB}" />
      ${axes}${trend}${secLayer}<path class="lc-line" d="${pathFor(series, y)}" />${dots}${xLabels}
    </svg>`;
  }

  // Inner width of a dashboard card, so charts fit the card (capped at
  // 640px wide on desktop) rather than the whole page.
  function chartWidth() {
    const card = body.querySelector(".dash-card");
    if (card) {
      const cs = getComputedStyle(card);
      return card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    }
    return Math.min(body.clientWidth - 28, 640) - 34;
  }

  // Tiny inline trend line for list rows; no axes, last point emphasised.
  function sparkline(series, { w = 72, h = 26, indexed = false } = {}) {
    const g = growth(series);
    const startAt = g ? g.start : 0;
    const pts = series.map((v, i) => (i >= startAt && v != null ? [i, v] : null)).filter(Boolean);
    if (pts.length === 0) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
    const base = pts[0][1];
    const vals = pts.map(([, v]) => (indexed ? (v / base) * 100 : v));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const n = series.length - startAt;
    const x = (i) => (n <= 1 ? w / 2 : 3 + ((i - startAt) * (w - 6)) / (n - 1));
    const y = (v) => (hi === lo ? h / 2 : 3 + (1 - (v - lo) / (hi - lo)) * (h - 6));
    const d = pts.map(([i], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(vals[k]).toFixed(1)}`).join("");
    const [li] = pts[pts.length - 1];
    const cls = trendClass(g && g.pct);
    return `<svg class="spark spark-${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <path d="${d}" /><circle cx="${x(li)}" cy="${y(vals[vals.length - 1])}" r="2.6" /></svg>`;
  }

  // ---------------- Render ----------------

  function render() {
    if (dash.programs.length === 0 || dash.muscles.length === 0) {
      body.innerHTML = `<div class="empty-state"><p>No complete A+B program since ${shortDate(SPLIT_START)} yet.</p></div>`;
      return;
    }
    const n = dash.programs.length;
    const total = totalSeries();
    const totalG = growth(total);
    const lastTotal = lastValue(total);
    const latest = dash.programs[n - 1];

    const ranked = dash.muscles
      .map((m) => ({ m, g: growth(m.series) }))
      .sort((a, b) => (b.g ? b.g.pct : -Infinity) - (a.g ? a.g.pct : -Infinity));
    const maxAbs = Math.max(5, ...ranked.filter((r) => r.g).map((r) => Math.abs(r.g.pct)));

    const momentumRows = ranked
      .map(({ m, g }) => {
        const pct = g ? g.pct : 0;
        const width = (Math.abs(pct) / maxAbs) * 50;
        const cls = trendClass(g && g.pct);
        const bar = g
          ? `<div class="mom-bar mom-${cls}" style="${pct >= 0 ? "left:50%" : `left:${50 - width}%`};width:${Math.max(width, 0.8)}%"></div>`
          : "";
        return `<button class="mom-row" data-muscle="${escapeHtml(m.name)}">
          <span class="mom-name">${escapeHtml(m.name)}</span>
          ${sparkline(m.series, { indexed: true, w: 56, h: 22 })}
          <span class="mom-track"><span class="mom-zero"></span>${bar}</span>
          <span class="mom-pct trend-${cls}">${g ? fmtPct(g.pct) : "—"}</span>
        </button>`;
      })
      .join("");

    const windowLabel = dash.window === "recent" ? `last ${Math.min(RECENT_WINDOW, n)} programs` : `all ${n} programs`;

    const sections = dash.muscles.map((m) => renderMuscle(m)).join("");

    body.innerHTML = `
      <div class="dash-summary">
        <div class="dash-kpi">
          <div class="stat-label">Latest program</div>
          <div class="dash-kpi-value">${fmtVol(lastTotal.value)}<span class="stat-latest-unit">${dash.unit}</span></div>
          <div class="stat-sub">${programLabel(latest)}</div>
        </div>
        <div class="dash-kpi">
          <div class="stat-label">Total volume trend</div>
          <div class="dash-kpi-value">${totalG ? `<span class="trend-${trendClass(totalG.pct)}">${fmtPct(totalG.pct)}</span>` : "—"}</div>
          <div class="stat-sub">per program · ${windowLabel}</div>
        </div>
      </div>

      <div class="seg" role="tablist" aria-label="Trend window">
        <button class="seg-btn${dash.window === "all" ? " active" : ""}" data-window="all">All programs</button>
        <button class="seg-btn${dash.window === "recent" ? " active" : ""}" data-window="recent">Last ${RECENT_WINDOW}</button>
      </div>

      <section class="dash-card">
        <h2 class="dash-h2">Muscle momentum</h2>
        <p class="dash-note">Volume growth per A+B program, fitted across ${windowLabel}. Line shows the trend relative to where each muscle started, so small and large muscles compare fairly.</p>
        <div class="mom-list">${momentumRows}</div>
      </section>

      ${sections}

      <p class="dash-foot">${n} programs since ${shortDate(SPLIT_START)} · volume is Speediance's own per-set calculation · tap a chart to show every value</p>
    `;
  }

  function renderMuscle(m) {
    const g = growth(m.series);
    const last = lastValue(m.series);
    const n = dash.programs.length;
    const isCurrent = (ex) => ex.series[n - 1] != null;
    const exRows = [...m.exercises.filter(isCurrent), ...m.exercises.filter((ex) => !isCurrent(ex))]
      .map((ex) => {
        const eg = growth(ex.series);
        const el = lastValue(ex.series);
        const retired = !el || el.index < n - 1;
        const open = dash.openExercises.has(ex.groupId);
        const prev = el ? lastValue(ex.series.slice(0, el.index)) : null;
        let delta = "";
        if (el && prev) {
          const d = el.value - prev.value;
          const cls = trendClass((d / prev.value) * 100);
          delta =
            Math.round(d) === 0
              ? `<span class="trend-delta trend-flat">± 0</span>`
              : `<span class="trend-delta trend-${cls}">${d > 0 ? "▲ +" : "▼ "}${fmtVol(d)}</span>`;
        }
        return `<div class="ex-row${retired ? " ex-retired" : ""}${open ? " open" : ""}">
          <button class="ex-row-head" data-ex="${ex.groupId}">
            <span class="ex-row-main">
              <span class="ex-row-name">${escapeHtml(ex.name)}</span>
              <span class="ex-row-meta">${
                retired
                  ? `Not in latest program${el ? " · last " + shortDate(dash.programs[el.index].days[1]) : ""}`
                  : `${fmtVol(el.value)} ${dash.unit} ${delta}`
              }</span>
            </span>
            ${sparkline(ex.series)}
            ${retired ? `<span class="trend-pill flat">retired</span>` : trendPill(eg, "")}
          </button>
          ${open ? `<div class="ex-row-chart">${lineChart({ series: ex.series, secondary: ex.maxWeight, key: "ex:" + ex.groupId, height: 150 })}</div>` : ""}
        </div>`;
      })
      .join("");

    return `<section class="dash-card muscle-card" id="muscle-${cssId(m.name)}">
      <div class="muscle-head">
        <div>
          <h2 class="dash-h2">${escapeHtml(m.name)}</h2>
          <div class="muscle-latest">${last ? fmtVol(last.value) : "—"}<span class="stat-latest-unit">${dash.unit} latest</span></div>
        </div>
        ${trendPill(g)}
      </div>
      ${lineChart({ series: m.series, key: "m:" + m.name })}
      <div class="ex-list">${exRows}</div>
    </section>`;
  }

  function cssId(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  // ---------------- Interaction ----------------

  body.addEventListener("click", (e) => {
    const seg = e.target.closest(".seg-btn");
    if (seg) {
      dash.window = seg.dataset.window;
      writeWindowPref(dash.window);
      render();
      return;
    }
    const mom = e.target.closest(".mom-row");
    if (mom) {
      const target = document.getElementById("muscle-" + cssId(mom.dataset.muscle));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const exHead = e.target.closest(".ex-row-head");
    if (exHead) {
      const id = Number(exHead.dataset.ex);
      if (dash.openExercises.has(id)) dash.openExercises.delete(id);
      else dash.openExercises.add(id);
      rerenderKeepingScroll();
      return;
    }
    const chart = e.target.closest(".line-chart");
    if (chart) {
      const key = chart.dataset.key;
      if (dash.showValues.has(key)) dash.showValues.delete(key);
      else dash.showValues.add(key);
      rerenderKeepingScroll();
    }
  });

  function rerenderKeepingScroll() {
    const top = body.scrollTop;
    render();
    body.scrollTop = top;
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!document.getElementById("view-progress").classList.contains("active") || !dash.programs.length) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rerenderKeepingScroll, 150);
  });

  const statusEl = document.getElementById("progress-status");
  let syncGeneration = 0;

  function setStatus(text, isError = false) {
    statusEl.hidden = !text;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", isError);
  }

  async function enterProgressView() {
    showView("progress");
    const gen = ++syncGeneration;
    const st = loadStore();
    const hasCache = !!st.sessions;

    if (hasCache) {
      buildModel(st);
      render();
      setStatus("Checking for new workouts…");
    } else {
      setStatus("");
      body.innerHTML = `<div class="loading-state"><div class="spinner"></div><p id="dash-load-msg">Loading your workouts…</p></div>`;
    }

    try {
      await sync(st, (done, total) => {
        if (gen !== syncGeneration || total === 0) return;
        const msg = `Loading ${done} / ${total} exercises…`;
        if (hasCache) setStatus(msg);
        else {
          const el = document.getElementById("dash-load-msg");
          if (el) el.textContent = msg;
        }
      });
      if (gen !== syncGeneration) return;
      buildModel(st);
      if (hasCache) rerenderKeepingScroll();
      else render();
      setStatus("");
    } catch (e) {
      if (gen !== syncGeneration) return;
      if (isAuthError(e)) {
        requireNewToken(e);
        return;
      }
      if (hasCache) {
        setStatus("Couldn't update: " + e.message + " · showing saved data", true);
      } else {
        body.innerHTML = `<div class="empty-state"><p>Couldn't load progress.</p><p class="error-text">${escapeHtml(e.message)}</p></div>`;
        toast("Failed to load progress: " + e.message, true);
      }
    }
  }

  document.getElementById("btn-progress").addEventListener("click", enterProgressView);
  document.getElementById("btn-progress-back").addEventListener("click", () => enterWorkoutsView());
  document.getElementById("btn-progress-refresh").addEventListener("click", enterProgressView);
})();
