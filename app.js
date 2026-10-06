(() => {
  "use strict";

  const API_BASE = "https://www.gm-manager.com/api/v1";
  const TOKEN_KEY = "gmcoach_token";
  const UNIT_KEY = "gmcoach_unit";

  // Speediance's `actionRating` is an undocumented integer (observed range ~1-5+).
  // This maps it to the A/B/C/D/F grade shown on the machine. If real-world
  // grades don't line up with what the app shows, adjust the thresholds here.
  function gradeLetter(rating) {
    if (rating === null || rating === undefined) return null;
    if (rating >= 5) return "A";
    if (rating === 4) return "B";
    if (rating === 3) return "C";
    if (rating === 2) return "D";
    return "F";
  }

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    unit: localStorage.getItem(UNIT_KEY) || "kg",
    workouts: [],
    workoutName: "",
    exercises: [], // [{groupId, name, muscle, planSets, kind, history, statsReady}]
    currentIndex: 0,
    // Whether each chart block shows numeric value labels on its bars. A UI
    // preference, not per-exercise data, so it persists as you navigate.
    chartExpanded: { weights: false, oneRM: false, volume: false },
  };

  // ---------------- API helpers ----------------

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(API_BASE + path, {
        ...opts,
        headers: {
          Authorization: "Bearer " + state.token,
          "Content-Type": "application/json",
          ...(opts.headers || {}),
        },
      });
    } catch (_) {
      // fetch() only rejects when no HTTP response came back at all: offline,
      // DNS failure, or the browser blocking the response (CORS).
      const err = new Error(`Can't reach ${API_BASE} (offline, server down, or blocked by CORS)`);
      err.status = 0;
      throw err;
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      /* no body */
    }
    if (!res.ok) {
      const detail = body && (body.message || body.error);
      const err = new Error(`HTTP ${res.status} on ${path}` + (detail ? `: ${detail}` : ""));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // A rejected token sends the user back to the token screen with the reason,
  // instead of leaving them on an empty list behind a brief toast.
  function isAuthError(e) {
    return e && (e.status === 401 || e.status === 403);
  }

  function requireNewToken(e) {
    localStorage.removeItem(TOKEN_KEY);
    state.token = "";
    tokenError.textContent = "Your API token was rejected (" + e.message + "). Paste a new one from GM Manager.";
    tokenError.hidden = false;
    showView("token");
  }

  // ---------------- View management ----------------

  const views = {
    token: document.getElementById("view-token"),
    workouts: document.getElementById("view-workouts"),
    exercise: document.getElementById("view-exercise"),
  };

  function showView(name) {
    Object.values(views).forEach((v) => v.classList.remove("active"));
    views[name].classList.add("active");
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.hidden = false;
    el.classList.toggle("error", isError);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, isError ? 8000 : 2600);
  }

  // ---------------- Token screen ----------------

  const tokenInput = document.getElementById("token-input");
  const tokenError = document.getElementById("token-error");

  document.getElementById("btn-save-token").addEventListener("click", async () => {
    const val = tokenInput.value.trim();
    tokenError.hidden = true;
    if (!val) return;
    const btn = document.getElementById("btn-save-token");
    btn.textContent = "Connecting…";
    btn.disabled = true;
    try {
      const prevToken = state.token;
      state.token = val;
      const me = await api("/me");
      localStorage.setItem(TOKEN_KEY, val);
      state.unit = me.unit || "kg";
      localStorage.setItem(UNIT_KEY, state.unit);
      tokenInput.value = "";
      await enterWorkoutsView();
    } catch (e) {
      tokenError.textContent = "Couldn't connect: " + e.message;
      tokenError.hidden = false;
      state.token = "";
    } finally {
      btn.textContent = "Connect";
      btn.disabled = false;
    }
  });

  document.getElementById("btn-settings").addEventListener("click", () => {
    if (confirm("Disconnect this account and clear the saved token?")) {
      localStorage.removeItem(TOKEN_KEY);
      state.token = "";
      state.workouts = [];
      showView("token");
    }
  });

  // ---------------- Workouts screen ----------------

  const workoutsList = document.getElementById("workouts-list");
  const workoutsEmpty = document.getElementById("workouts-empty");
  const workoutsLoading = document.getElementById("workouts-loading");

  // The workout list is driven by recent session history, not the raw
  // /workouts catalog — that way it naturally includes built-in courses (which
  // have no template endpoint of their own) and excludes anything never
  // actually performed (nothing to show progress on anyway). Custom workouts
  // that match a session by name still get live-fetched via /workouts/{code}
  // when opened, so their plan reflects any edits since that last run.
  const WORKOUT_HISTORY_DAYS = 90;

  async function enterWorkoutsView() {
    showView("workouts");
    workoutsList.hidden = true;
    workoutsEmpty.hidden = true;
    workoutsLoading.hidden = false;
    try {
      const from = new Date();
      from.setDate(from.getDate() - WORKOUT_HISTORY_DAYS);
      const fromStr = from.toISOString().slice(0, 10);

      const [customData, sessionsData] = await Promise.all([
        api("/workouts"),
        api(`/sessions?from=${fromStr}&includeExercises=true`),
      ]);

      const customByName = new Map();
      for (const w of customData.workouts || []) customByName.set(w.name, w);

      const tiles = new Map(); // key -> tile; sessions are newest-first, so first-seen wins
      for (const s of sessionsData.sessions || []) {
        if (s.detailType !== "template" && s.detailType !== "course") continue;
        const key = s.detailType + ":" + s.name;
        if (tiles.has(key)) continue;

        const matchedCustom = s.detailType === "template" ? customByName.get(s.name) : null;
        const exercises = (s.exercises || []).filter((e) => e.groupId != null);

        tiles.set(key, {
          name: s.name,
          badge: s.detailType === "template" ? "Custom" : "Built-in",
          lastPerformedDate: s.date,
          cover: matchedCustom ? matchedCustom.cover : null,
          durationMinute: matchedCustom ? matchedCustom.durationMinute : Math.round((s.seconds || 0) / 60),
          estimatedCalorie: matchedCustom ? matchedCustom.estimatedCalorie : s.calories,
          exerciseCount: matchedCustom ? matchedCustom.actionNum : exercises.length,
          source: matchedCustom ? { type: "custom", code: matchedCustom.code } : { type: "snapshot", exercises },
        });
      }

      state.workouts = [...tiles.values()].sort((a, b) => (a.lastPerformedDate < b.lastPerformedDate ? 1 : -1));
      renderWorkouts();
    } catch (e) {
      if (isAuthError(e)) {
        requireNewToken(e);
        return;
      }
      toast("Failed to load workouts: " + e.message, true);
    } finally {
      workoutsLoading.hidden = true;
    }
  }

  function renderWorkouts() {
    workoutsList.innerHTML = "";
    if (state.workouts.length === 0) {
      workoutsEmpty.hidden = false;
      workoutsList.hidden = true;
      return;
    }
    workoutsEmpty.hidden = true;
    workoutsList.hidden = false;
    for (const w of state.workouts) {
      const card = document.createElement("div");
      card.className = "workout-card";
      const d = daysSince(w.lastPerformedDate);
      const lastText = d === 0 ? "Today" : d === 1 ? "1 day ago" : `${d} days ago`;
      card.innerHTML = `
        ${w.cover ? `<img class="workout-cover" src="${w.cover}" alt="" />` : `<div class="workout-cover"></div>`}
        <div class="workout-info">
          <div class="workout-title-row">
            <p class="workout-title">${escapeHtml(w.name || "Untitled")}</p>
            <span class="workout-badge">${w.badge}</span>
          </div>
          <p class="workout-meta">${w.durationMinute ? w.durationMinute + " min" : ""}${
        w.estimatedCalorie ? " · " + Math.round(w.estimatedCalorie) + " cal" : ""
      }${w.exerciseCount ? " · " + w.exerciseCount + " exercises" : ""} · ${lastText}</p>
        </div>
        <div class="workout-chevron">›</div>
      `;
      card.addEventListener("click", () => loadWorkout(w));
      workoutsList.appendChild(card);
    }
  }

  document.getElementById("btn-home").addEventListener("click", () => {
    enterWorkoutsView();
  });

  // ---------------- Exercise loading ----------------

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function flattenPlan(rawExercises) {
    const out = [];
    for (const item of rawExercises || []) {
      if (item && item.groupId) {
        out.push(item);
      } else if (item && Array.isArray(item.superset)) {
        for (const sub of item.superset) out.push(sub);
      }
    }
    return out;
  }

  async function loadWorkout(tile) {
    state.workoutName = tile.name || "Workout";
    state.exercises = [];
    state.currentIndex = 0;
    showView("exercise");
    document.getElementById("workout-name").textContent = state.workoutName;
    setExLoading(true);

    try {
      let flat;
      let unit = state.unit;

      if (tile.source.type === "custom") {
        const plan = await api(`/workouts/${tile.source.code}`);
        unit = plan.unit || state.unit;
        flat = flattenPlan(plan.exercises).map((item) => ({
          groupId: item.groupId,
          kind: item.kind || null,
          planSets: item.sets || [],
        }));
      } else {
        // Built-in course (or a renamed/deleted custom template): no template
        // endpoint exists for these, so the plan is reconstructed from the
        // most recent session's targetReps per set.
        flat = tile.source.exercises.map((e) => ({
          groupId: e.groupId,
          kind: null,
          name: e.name || null,
          planSets: groupSetLogBySetIndex(e.setLog, { repsField: "targetReps", includeWeight: false }) || [],
        }));
      }

      if (flat.length === 0) {
        toast("This workout has no exercises.", true);
        setExLoading(false);
        return;
      }

      state.exercises = flat.map((item) => ({
        groupId: item.groupId,
        kind: item.kind,
        planSets: item.planSets,
        name: item.name || `#${item.groupId}`,
        muscle: "",
        history: null,
        historyUnit: unit,
        prevSets: null,
        loadError: null,
      }));

      render();
      await Promise.all(state.exercises.map((ex, i) => fetchExerciseDetail(i)));
      await fetchPrevSetsForExercises(state.exercises.map((_, i) => i));
      render();
    } catch (e) {
      toast("Failed to load workout: " + e.message, true);
    } finally {
      setExLoading(false);
    }
  }

  const detailCache = new Map(); // groupId -> {name, muscle}

  async function fetchExerciseDetail(index) {
    const ex = state.exercises[index];
    if (!ex) return;

    // Fetched independently: a handful of built-in-course-only movements
    // (mobility drills mostly) aren't in the shared /exercises catalog, but
    // their /history still works — a catalog 404 shouldn't hide history data
    // that loaded fine. Only missing history blocks the whole stats display.
    const [catalogResult, historyResult] = await Promise.allSettled([
      detailCache.has(ex.groupId)
        ? Promise.resolve(detailCache.get(ex.groupId))
        : api(`/exercises/${ex.groupId}`).then((c) => {
            detailCache.set(ex.groupId, c);
            return c;
          }),
      api(`/exercises/${ex.groupId}/history?limit=25`),
    ]);

    if (catalogResult.status === "fulfilled") {
      ex.name = catalogResult.value.name || ex.name;
      ex.muscle = catalogResult.value.muscle || "";
    }

    if (historyResult.status === "fulfilled") {
      ex.history = historyResult.value.history || [];
      ex.historyUnit = historyResult.value.unit || ex.historyUnit;
      ex.loadError = null;
    } else {
      ex.loadError = historyResult.reason && historyResult.reason.message;
    }

    if (index === state.currentIndex) render();
    else renderDotsAndTitleOnly();
  }

  // Per-set actuals aren't in the day-level /history feed, so the previous
  // session's reps/weight per set come from /sessions on the exercise's last
  // known day. Cached and batched by date so a repeated workout (the common
  // case — every exercise last performed the same day) costs one extra call
  // total, not one per exercise.
  const sessionsByDateCache = new Map(); // dayStr -> sessions[]

  // repsField lets the same grouping serve two purposes: default ("reps") pulls
  // what was actually performed (previous-session actuals); {repsField:
  // "targetReps", includeWeight: false} pulls the machine's prescribed reps
  // instead — used to build a pseudo-plan for built-in courses, which have no
  // separate template endpoint the way custom workouts do.
  function groupSetLogBySetIndex(setLog, { repsField = "reps", includeWeight = true } = {}) {
    if (!Array.isArray(setLog) || setLog.length === 0) return null;
    const bySetIndex = new Map();
    for (const entry of setLog) {
      if (!bySetIndex.has(entry.setIndex)) bySetIndex.set(entry.setIndex, []);
      bySetIndex.get(entry.setIndex).push(entry);
    }
    return [...bySetIndex.keys()]
      .sort((a, b) => a - b)
      .map((idx) => {
        const entries = bySetIndex.get(idx);
        let weight = null;
        if (includeWeight) {
          const weights = [...new Set(entries.map((e) => e.weight).filter((w) => w != null))];
          weight = weights.length === 0 ? null : weights.length === 1 ? weights[0] : weights.join("/");
        }
        return { reps: entries[0][repsField], seconds: entries[0].seconds, weight };
      });
  }

  async function fetchSessionsForDate(dayStr) {
    if (sessionsByDateCache.has(dayStr)) return sessionsByDateCache.get(dayStr);
    let sessions = [];
    try {
      const resp = await api(`/sessions?from=${dayStr}&to=${dayStr}&includeExercises=true`);
      sessions = resp.sessions || [];
    } catch (_) {
      /* leave empty; previous-set display just won't show for this date */
    }
    sessionsByDateCache.set(dayStr, sessions);
    return sessions;
  }

  async function fetchPrevSetsForExercises(indices) {
    const byDate = new Map();
    for (const i of indices) {
      const ex = state.exercises[i];
      if (ex.history && ex.history.length > 0) {
        const d = ex.history[0].dayStr;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(i);
      } else {
        ex.prevSets = null;
      }
    }
    await Promise.all(
      [...byDate.entries()].map(async ([dayStr, idxs]) => {
        const sessions = await fetchSessionsForDate(dayStr);
        for (const i of idxs) {
          const ex = state.exercises[i];
          let match = null;
          for (const s of sessions) {
            match = (s.exercises || []).find((e) => e.groupId === ex.groupId);
            if (match) break;
          }
          ex.prevSets = groupSetLogBySetIndex(match && match.setLog);
        }
      })
    );
  }

  async function refreshCurrent() {
    const i = state.currentIndex;
    const ex = state.exercises[i];
    if (!ex) return;
    setExLoading(true);
    detailCache.delete(ex.groupId);
    await fetchExerciseDetail(i);
    if (ex.history && ex.history.length > 0) sessionsByDateCache.delete(ex.history[0].dayStr);
    await fetchPrevSetsForExercises([i]);
    render();
    setExLoading(false);
    toast("Refreshed");
  }

  function setExLoading(on) {
    document.getElementById("ex-loading").hidden = !on;
  }

  // ---------------- Rendering ----------------

  function formatSetLabel(s, unit) {
    if (!s) return null;
    if (s.weight != null) return `${s.reps ?? "?"}×${s.weight}${unit}`;
    if (s.reps != null && s.reps > 0) return `${s.reps} reps`;
    if (s.seconds != null) return `${s.seconds}s`;
    return null;
  }

  // Compares the planned weight for a set against what was actually lifted
  // last time — the badge answers "should this set feel heavier, lighter, or
  // the same as last time?" Skipped for L/R-joined weights (e.g. "8.5/10")
  // since a single delta wouldn't be meaningful.
  function formatWeightDelta(planned, prev, unit) {
    if (!planned || !prev) return null;
    if (typeof planned.weight !== "number" || typeof prev.weight !== "number") return null;
    const delta = Math.round((planned.weight - prev.weight) * 100) / 100;
    if (delta > 0) return { cls: "delta-up", label: `▲ +${delta}${unit}` };
    if (delta < 0) return { cls: "delta-down", label: `▼ ${delta}${unit}` };
    return { cls: "delta-flat", label: "→ steady" };
  }

  function daysSince(dayStr) {
    const [y, m, d] = dayStr.split("-").map(Number);
    const then = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - then) / 86400000);
  }

  function formatDayStr(dayStr) {
    const [y, m, d] = dayStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatDayStrShort(dayStr) {
    const [, m, d] = dayStr.split("-").map(Number);
    return `${m}/${d}`;
  }

  function syncChartToggle(key) {
    const el = document.querySelector(`.stat-block-chart[data-chart="${key}"]`);
    if (!el) return;
    const expanded = state.chartExpanded[key];
    el.classList.toggle("expanded", expanded);
    const hint = el.querySelector(".expand-hint");
    if (hint) hint.textContent = expanded ? "⌃" : "⌄";
  }

  function chipRow(containerId, items, renderFn) {
    const el = document.getElementById(containerId);
    if (!items || items.length === 0) {
      el.innerHTML = `<span class="chip-empty">No data yet</span>`;
      return;
    }
    el.innerHTML = items.map(renderFn).join("");
  }

  // Renders a "latest value + trend delta" callout above a small bar chart
  // of up to the last 5 data points (oldest → newest, left to right).
  // `expanded` adds a row of numeric labels above the bars, toggled by
  // tapping the stat block (see the click handler wired in render()).
  function renderTrendStat(containerId, entriesNewestFirst, valueKey, unit, expanded) {
    const el = document.getElementById(containerId);
    const points = entriesNewestFirst.filter((h) => h[valueKey] != null).slice(0, 5);

    if (points.length === 0) {
      el.innerHTML = `<span class="chip-empty">No data yet</span>`;
      return;
    }

    const latest = points[0][valueKey];
    const prev = points.length > 1 ? points[1][valueKey] : null;
    let deltaHtml = "";
    if (prev != null) {
      const delta = Math.round((latest - prev) * 100) / 100;
      if (delta > 0) deltaHtml = `<span class="trend-delta trend-up">▲ +${delta}${unit}</span>`;
      else if (delta < 0) deltaHtml = `<span class="trend-delta trend-down">▼ ${delta}${unit}</span>`;
      else deltaHtml = `<span class="trend-delta trend-flat">± 0</span>`;
    }

    const chrono = [...points].reverse(); // oldest -> newest, for left-to-right bars
    const values = chrono.map((h) => h[valueKey]);
    const min = Math.min(...values);
    const max = Math.max(...values);

    const bars = chrono
      .map((h, idx) => {
        const v = h[valueKey];
        const pct = max === min ? 60 : 22 + ((v - min) / (max - min)) * 78;
        const isLatest = idx === chrono.length - 1;
        return `<div class="bar-col"><div class="bar${isLatest ? " bar-latest" : ""}" style="height:${pct}%"></div></div>`;
      })
      .join("");

    const dates = chrono.map((h) => `<div class="bar-date">${formatDayStrShort(h.dayStr)}</div>`).join("");
    const valuesRow = expanded
      ? `<div class="bar-values">${chrono.map((h) => `<div class="bar-value">${h[valueKey]}</div>`).join("")}</div>`
      : "";

    el.innerHTML = `
      <div class="stat-latest-row">
        <span class="stat-latest-value">${latest}<span class="stat-latest-unit">${unit}</span></span>
        ${deltaHtml}
      </div>
      ${valuesRow}
      <div class="bar-chart">${bars}</div>
      <div class="bar-dates">${dates}</div>
    `;
  }

  function render() {
    const total = state.exercises.length;
    const i = state.currentIndex;
    const ex = state.exercises[i];

    document.getElementById("workout-name").textContent = state.workoutName;
    document.getElementById("progress-fill").style.width = total ? `${((i + 1) / total) * 100}%` : "0%";
    document.getElementById("ex-index").textContent = total ? `${i + 1} / ${total}` : "";

    renderDots();

    document.getElementById("btn-prev").disabled = i <= 0;
    document.getElementById("btn-next").disabled = i >= total - 1;

    if (!ex) return;

    document.getElementById("ex-name").textContent = ex.name;
    document.getElementById("ex-muscle").textContent = ex.muscle || "";

    const unit = ex.historyUnit || state.unit;

    const planEl = document.getElementById("ex-plan");
    if (ex.planSets && ex.planSets.length) {
      planEl.innerHTML = ex.planSets
        .map((s, idx) => {
          // What you actually did last time is the headline; the planned
          // target only shows up as a "how much heavier/lighter" delta badge.
          // With no history yet, fall back to showing the plan itself.
          const prevSet = ex.prevSets && ex.prevSets[idx];
          const label = (prevSet && formatSetLabel(prevSet, unit)) || formatSetLabel(s, unit) || "—";
          const delta = prevSet ? formatWeightDelta(s, prevSet, unit) : null;
          return `<div class="plan-set-group${delta ? " has-delta" : ""}">
            <span class="plan-set">Set ${idx + 1}: ${escapeHtml(label)}</span>
            ${delta ? `<span class="delta-badge ${delta.cls}">${delta.label}</span>` : ""}
          </div>`;
        })
        .join("");
    } else {
      planEl.innerHTML = "";
    }

    if (ex.loadError) {
      document.getElementById("stat-lastperformed").textContent = "—";
      document.getElementById("stat-lastperformed-date").textContent = "Couldn't load: " + ex.loadError;
      chipRow("stat-grades", null);
      renderTrendStat("stat-weights", [], "maxWeight", unit, state.chartExpanded.weights);
      renderTrendStat("stat-1rm", [], "oneRepMax", unit, state.chartExpanded.oneRM);
      renderTrendStat("stat-volume", [], "totalCapacity", unit, state.chartExpanded.volume);
      syncChartToggle("weights");
      syncChartToggle("oneRM");
      syncChartToggle("volume");
      return;
    }

    const history = ex.history || [];
    // history is day-level, newest first
    const last5 = history.slice(0, 5);

    if (history.length === 0) {
      document.getElementById("stat-lastperformed").textContent = "NEW";
      document.getElementById("stat-lastperformed-date").textContent = "Never performed";
    } else {
      const d = daysSince(history[0].dayStr);
      document.getElementById("stat-lastperformed").textContent = d === 0 ? "Today" : d === 1 ? "1 day ago" : `${d} days ago`;
      document.getElementById("stat-lastperformed-date").textContent = formatDayStr(history[0].dayStr);
    }

    chipRow("stat-grades", last5, (h) => {
      const letter = gradeLetter(h.actionRating);
      if (!letter) return `<span class="chip-empty">—</span>`;
      return `<span class="chip grade-chip grade-${letter}">${letter}</span>`;
    });

    renderTrendStat("stat-weights", history, "maxWeight", unit, state.chartExpanded.weights);
    renderTrendStat("stat-1rm", history, "oneRepMax", unit, state.chartExpanded.oneRM);
    renderTrendStat("stat-volume", history, "totalCapacity", unit, state.chartExpanded.volume);
    syncChartToggle("weights");
    syncChartToggle("oneRM");
    syncChartToggle("volume");
  }

  function renderDotsAndTitleOnly() {
    renderDots();
  }

  function renderDots() {
    const dots = document.getElementById("dots");
    const total = state.exercises.length;
    if (total <= 1 || total > 24) {
      dots.innerHTML = "";
      return;
    }
    dots.innerHTML = state.exercises
      .map((_, idx) => `<span class="dot${idx === state.currentIndex ? " active" : ""}"></span>`)
      .join("");
  }

  // ---------------- Navigation ----------------

  function goTo(index) {
    const total = state.exercises.length;
    if (index < 0 || index >= total) return;
    state.currentIndex = index;
    render();
    const ex = state.exercises[index];
    if (ex && ex.history === null && !ex.loadError) fetchExerciseDetail(index);
  }

  document.getElementById("btn-prev").addEventListener("click", () => goTo(state.currentIndex - 1));
  document.getElementById("btn-next").addEventListener("click", () => goTo(state.currentIndex + 1));

  document.querySelectorAll(".stat-block-chart").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.chart;
      state.chartExpanded[key] = !state.chartExpanded[key];
      render();
    });
  });
  document.getElementById("btn-refresh").addEventListener("click", refreshCurrent);

  // Swipe handling (Pointer Events cover touch, mouse drag, and pen in one API)
  const stage = document.getElementById("exercise-stage");
  let startX = 0,
    startY = 0,
    tracking = false;

  stage.addEventListener("pointerdown", (e) => {
    tracking = true;
    startX = e.clientX;
    startY = e.clientY;
  });

  stage.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 70) {
      if (dx < 0) goTo(state.currentIndex + 1);
      else goTo(state.currentIndex - 1);
    }
  });

  stage.addEventListener("pointercancel", () => {
    tracking = false;
  });

  // Keyboard arrows (handy when testing on desktop)
  document.addEventListener("keydown", (e) => {
    if (!views.exercise.classList.contains("active")) return;
    if (e.key === "ArrowRight") goTo(state.currentIndex + 1);
    if (e.key === "ArrowLeft") goTo(state.currentIndex - 1);
  });

  // ---------------- Boot ----------------

  async function boot() {
    if (!state.token) {
      showView("token");
      return;
    }
    try {
      await enterWorkoutsView();
    } catch (e) {
      showView("token");
    }
  }

  boot();
})();
