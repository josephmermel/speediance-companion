(() => {
  "use strict";

  const API_BASE = "https://manager.gmvoice.tech/api/v1";
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
  };

  // ---------------- API helpers ----------------

  async function api(path, opts = {}) {
    const res = await fetch(API_BASE + path, {
      ...opts,
      headers: {
        Authorization: "Bearer " + state.token,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      /* no body */
    }
    if (!res.ok) {
      const msg = (body && (body.message || body.error)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body;
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
    }, 2600);
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

  async function enterWorkoutsView() {
    showView("workouts");
    workoutsList.hidden = true;
    workoutsEmpty.hidden = true;
    workoutsLoading.hidden = false;
    try {
      const data = await api("/workouts");
      state.workouts = data.workouts || [];
      renderWorkouts();
    } catch (e) {
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
      card.innerHTML = `
        ${w.cover ? `<img class="workout-cover" src="${w.cover}" alt="" />` : `<div class="workout-cover"></div>`}
        <div class="workout-info">
          <p class="workout-title">${escapeHtml(w.name || "Untitled")}</p>
          <p class="workout-meta">${w.durationMinute ? w.durationMinute + " min" : ""}${
        w.estimatedCalorie ? " · " + w.estimatedCalorie + " cal" : ""
      }${w.actionNum ? " · " + w.actionNum + " exercises" : ""}</p>
        </div>
        <div class="workout-chevron">›</div>
      `;
      card.addEventListener("click", () => loadWorkout(w.code, w.name));
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

  async function loadWorkout(code, name) {
    state.workoutName = name || "Workout";
    state.exercises = [];
    state.currentIndex = 0;
    showView("exercise");
    document.getElementById("workout-name").textContent = state.workoutName;
    setExLoading(true);

    try {
      const plan = await api(`/workouts/${code}`);
      const flat = flattenPlan(plan.exercises);
      if (flat.length === 0) {
        toast("This workout has no exercises.", true);
        setExLoading(false);
        return;
      }

      state.exercises = flat.map((item) => ({
        groupId: item.groupId,
        kind: item.kind || null,
        planSets: item.sets || [],
        name: `#${item.groupId}`,
        muscle: "",
        history: null,
        historyUnit: plan.unit || state.unit,
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
    try {
      const [catalog, history] = await Promise.all([
        detailCache.has(ex.groupId)
          ? Promise.resolve(detailCache.get(ex.groupId))
          : api(`/exercises/${ex.groupId}`).then((c) => {
              detailCache.set(ex.groupId, c);
              return c;
            }),
        api(`/exercises/${ex.groupId}/history?limit=25`),
      ]);
      ex.name = catalog.name || ex.name;
      ex.muscle = catalog.muscle || "";
      ex.history = history.history || [];
      ex.historyUnit = history.unit || ex.historyUnit;
      ex.loadError = null;
    } catch (e) {
      ex.loadError = e.message;
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

  function groupSetLogBySetIndex(setLog) {
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
        const weights = [...new Set(entries.map((e) => e.weight).filter((w) => w != null))];
        return {
          reps: entries[0].reps,
          seconds: entries[0].seconds,
          weight: weights.length === 0 ? null : weights.length === 1 ? weights[0] : weights.join("/"),
        };
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
  function renderTrendStat(containerId, entriesNewestFirst, valueKey, unit) {
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

    el.innerHTML = `
      <div class="stat-latest-row">
        <span class="stat-latest-value">${latest}<span class="stat-latest-unit">${unit}</span></span>
        ${deltaHtml}
      </div>
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
          const plannedLabel = formatSetLabel(s, unit) || "—";
          const prevSet = ex.prevSets && ex.prevSets[idx];
          const prevLabel = prevSet ? formatSetLabel(prevSet, unit) : null;
          const showPrev = prevLabel && prevLabel !== plannedLabel;
          return `<span class="plan-set">Set ${idx + 1}: ${escapeHtml(plannedLabel)}${
            showPrev ? ` <span class="plan-prev">(${escapeHtml(prevLabel)})</span>` : ""
          }</span>`;
        })
        .join("");
    } else {
      planEl.innerHTML = "";
    }

    if (ex.loadError) {
      document.getElementById("stat-lastperformed").textContent = "—";
      document.getElementById("stat-lastperformed-date").textContent = "Couldn't load: " + ex.loadError;
      chipRow("stat-grades", null);
      renderTrendStat("stat-weights", [], "maxWeight", unit);
      renderTrendStat("stat-1rm", [], "oneRepMax", unit);
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

    renderTrendStat("stat-weights", history, "maxWeight", unit);
    renderTrendStat("stat-1rm", history, "oneRepMax", unit);
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
