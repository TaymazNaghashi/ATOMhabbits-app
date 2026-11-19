/* ATOM Habits - the app. Plain JS, no build step. Data + sync live in sync.js. */
(function () {
  "use strict";

  // Tailwind 400 shades - the habit colour palette (3 rows of 7).
  const COLORS = ["#FF453A", "#FF9F0A", "#FFD60A", "#30D158", "#63E6E2", "#40C8E0", "#64D2FF",
                  "#0A84FF", "#5E5CE6", "#BF5AF2", "#FF375F", "#AC8E68", "#8E8E93", "#FF6482",
                  "#34C759", "#00C7BE", "#32ADE6", "#007AFF", "#5856D6", "#AF52DE", "#A2845E"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DAYS2 = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const DEVICE = /iPhone|iPad|Android/i.test(navigator.userAgent) ? "phone" : "browser";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let ICONS = { habit: {}, ui: {} };
  const icon = (name, cls = "") => {
    const body = ICONS.ui[name] || ICONS.habit[name] || ICONS.habit.star || "";
    return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  };

  // ---- local (per-device) preferences ---------------------------------------------------
  const prefs = (() => {
    const defaults = { view: "cards", labels: true, chips: true };
    let p = defaults;
    try { p = Object.assign({}, defaults, JSON.parse(localStorage.getItem("hk.prefs")) || {}); } catch (e) { /* */ }
    return {
      get: (k) => p[k],
      set: (k, v) => { p[k] = v; try { localStorage.setItem("hk.prefs", JSON.stringify(p)); } catch (e) { /* */ } },
    };
  })();

  // ---- dates ------------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const dkey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  let todayOverride = null;                 // lets the stats page draw a past year's grid
  const today = () => {
    if (todayOverride) return todayOverride;
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };
  const weekStart = () => (sync.doc.settings.weekStart === 0 ? 0 : 1);
  const startOfWeek = (d) => addDays(d, -((d.getDay() - weekStart() + 7) % 7));

  // ---- data access --------------------------------------------------------------------------
  let sync;
  const habitsAll = () => Object.values(sync.doc.habits).filter((h) => h && !h.deleted);
  const habits = () => habitsAll().filter((h) => !h.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  const getHabit = (id) => { const h = sync.doc.habits[id]; return h && !h.deleted ? h : null; };
  const count = (h, k) => { const v = (sync.doc.days[h.id] || {})[k]; return v ? v[0] || 0 : 0; };
  const noteOf = (h, k) => { const v = (sync.doc.days[h.id] || {})[k]; return v && v[2] ? v[2] : ""; };
  const perDay = (h) => Math.max(1, h.perDay || 1);
  const isDone = (h, k) => count(h, k) >= perDay(h);
  const frac = (h, k) => Math.min(1, count(h, k) / perDay(h));

  function setDay(h, k, n, note) {
    const prev = (sync.doc.days[h.id] || {})[k];
    const keepNote = note === undefined ? (prev && prev[2]) || "" : note;
    sync.change((doc) => {
      doc.days[h.id] = doc.days[h.id] || {};
      const v = [Math.max(0, n), Date.now()];
      if (keepNote) v.push(keepNote);
      doc.days[h.id][k] = v;
    }, note !== undefined ? `Note ${h.name}` : `${n >= perDay(h) ? "Check" : n ? "Log" : "Uncheck"} ${h.name} ${k}`);
  }

  /* One tap: single-count habits toggle; multi-count habits count up, and wrap to 0 when full. */
  function tap(h, k) {
    const c = count(h, k), max = perDay(h);
    const n = max === 1 ? (c >= 1 ? 0 : 1) : (c >= max ? 0 : c + 1);
    setDay(h, k, n);
    if (navigator.vibrate) navigator.vibrate(n >= max ? 12 : 6);
    return n;
  }

  function saveHabit(h) {
    h.updatedAt = Date.now();
    sync.change((doc) => { doc.habits[h.id] = h; }, `${sync.doc.habits[h.id] ? "Edit" : "Add"} ${h.name}`);
  }

  // ---- streaks and stats --------------------------------------------------------------------
  function periodKey(h, d) {
    const p = h.goal && h.goal.period;
    if (p === "week") return dkey(startOfWeek(d));
    if (p === "month") return `${d.getFullYear()}-${d.getMonth()}`;
    return dkey(d);
  }
  function periodTarget(h) {
    const g = h.goal || {};
    return g.period === "week" || g.period === "month" ? Math.max(1, g.count || 1) : 1;
  }
  function firstDay(h) {
    const keys = Object.keys(sync.doc.days[h.id] || {}).filter((k) => count(h, k) > 0).sort();
    const created = new Date(h.createdAt || Date.now());
    const c = new Date(created.getFullYear(), created.getMonth(), created.getDate());
    return keys.length && parse(keys[0]) < c ? parse(keys[0]) : c;
  }
  /* Streaks count days (no goal / daily) or weeks / months that reached the goal. The current
     period never breaks a streak while it's still in progress. */
  function streaks(h) {
    const t = today(), target = periodTarget(h);
    const tally = new Map(), order = [];
    for (let d = firstDay(h); d <= t; d = addDays(d, 1)) {
      const pk = periodKey(h, d);
      if (!tally.has(pk)) { tally.set(pk, 0); order.push(pk); }
      if (isDone(h, dkey(d))) tally.set(pk, tally.get(pk) + 1);
    }
    let best = 0, run = 0;
    for (const pk of order) {
      run = tally.get(pk) >= target ? run + 1 : 0;
      best = Math.max(best, run);
    }
    let cur = 0;
    for (let i = order.length - 1; i >= 0; i--) {
      const met = tally.get(order[i]) >= target;
      if (met) cur++;
      else if (i === order.length - 1) continue;      // today / this week / this month: not over yet
      else break;
    }
    return { current: cur, best };
  }
  function goalLabel(h) {
    const g = h.goal || {};
    if (g.period === "day") return "Daily";
    if (g.period === "week") return `${g.count || 1} / Week`;
    if (g.period === "month") return `${g.count || 1} / Month`;
    return "";
  }

  // ---- heatmap ---------------------------------------------------------------------------
  /* weeks columns, today in the last one. Returns markup; labels adds months on top and
     weekday names on the left. */
  function heatmap(h, weeks, { s = 12, g = 3.5, labels = false, valueFn } = {}) {
    const t = today(), tk = dkey(t);
    const start = addDays(startOfWeek(t), -(weeks - 1) * 7);
    const val = valueFn || ((k) => frac(h, k));
    let cells = "", lastMonth = -1;
    const marks = [];                         // [week column, month, starts on the 1st?]
    for (let w = 0; w < weeks; w++) {
      const col0 = addDays(start, w * 7);
      if (labels) {
        const firstOfMonth = [...Array(7)].map((_, i) => addDays(col0, i)).find((d) => d.getDate() === 1);
        const m = firstOfMonth ? firstOfMonth.getMonth() : (w === 0 ? col0.getMonth() : -1);
        if (m >= 0 && m !== lastMonth && w < weeks - 1) {
          marks.push([w, m, !!firstOfMonth]);
          lastMonth = m;
        }
      }
      for (let i = 0; i < 7; i++) {
        const d = addDays(col0, i), k = dkey(d);
        if (d > t) { cells += `<i class="x"></i>`; continue; }
        const f = val(k);
        const cls = (f >= 1 ? "f" : f > 0 ? "p" : "") + (k === tk ? " t" : "");
        cells += f > 0 && f < 1
          ? `<i class="${cls}" style="--pct:${Math.round(25 + f * 60)}%"></i>`
          : `<i class="${cls}"></i>`;
      }
    }
    const grid = `<div class="hm" style="--s:${s}px;--g:${g}px;grid-template-rows:repeat(7,${s}px)">${cells}</div>`;
    if (!labels) return grid;
    // a partial first month gives way when the next label would sit on top of it
    if (marks.length > 1 && !marks[0][2] && marks[1][0] - marks[0][0] < 3) marks.shift();
    const months = marks.map(([w, m]) => `<span style="left:${w * (s + g)}px">${MONTHS[m]}</span>`).join("");
    const ws = weekStart();
    const names = [...Array(7)].map((_, i) => (i % 2 === 1 ? DAYS3[(ws + i) % 7] : ""));
    return `<div class="hm-labels">
      <div></div><div class="hm-months">${months}</div>
      <div class="hm-days" style="grid-template-rows:repeat(7,${s}px);row-gap:${g}px">${names.map((n) => `<span>${n}</span>`).join("")}</div>
      ${grid}</div>`;
  }

  function ring(f, color, r = 11) {
    const c = 2 * Math.PI * r;
    return `<svg class="ring" viewBox="0 0 ${2 * r + 5} ${2 * r + 5}">
      <circle cx="${r + 2.5}" cy="${r + 2.5}" r="${r}" stroke="${color}" stroke-opacity=".22"></circle>
      <circle cx="${r + 2.5}" cy="${r + 2.5}" r="${r}" stroke="${color}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - f)}"></circle></svg>`;
  }

  function checkButton(h, k, extra = "") {
    const f = frac(h, k), done = f >= 1, multi = perDay(h) > 1;
    const inner = done || !multi ? icon("check") : ring(f, h.color, 21) + icon("plus");
    return `<button class="check ${done ? "done" : ""} ${extra}" data-check="${h.id}" data-day="${k}"
      aria-label="${esc(h.name)}: ${done ? "done" : "not done"}" style="--c:${h.color}">${inner}</button>`;
  }

  // ---- home --------------------------------------------------------------------------------
  let bumpId = null;

  function renderHome() {
    const list = $("#list");
    const hs = habits();
    $$("#views button").forEach((b) => b.classList.toggle("on", b.dataset.view === prefs.get("view")));
    if (!hs.length) {
      const demo = { id: "_", color: "#8b8af8", perDay: 1 };
      const fake = (k) => (parse(k).getDate() * 7 + parse(k).getMonth() * 3) % 5 < 3 ? 1 : 0;
      list.innerHTML = `<div class="empty">${heatmap(demo, 14, { s: 13, g: 4, valueFn: fake })}
        <h2>No habits yet</h2><p>Every tile is a day. Fill them in.</p>
        <button class="btn" id="empty-add" style="max-width:280px;margin:0 auto">${icon("plus")} New habit</button></div>`;
      $("#empty-add").onclick = () => openEdit(null);
      return;
    }
    const view = prefs.get("view");
    if (view === "checklist") list.innerHTML = checklist(hs);
    else if (view === "grid") list.innerHTML = `<div class="tiles">${hs.map(tile).join("")}</div>`;
    else list.innerHTML = hs.map(card).join("");
    if (bumpId) {
      const b = $(`[data-check="${bumpId}"]`, list) || $(`[data-tc="${bumpId}"]`, list);
      if (b) b.classList.add("bump");
      bumpId = null;
    }
  }

  function cardWeeks() {
    const w = Math.min($("#list").clientWidth || window.innerWidth - 32, 608) - 34;
    const lab = prefs.get("labels") ? 34 : 0;
    return Math.max(10, Math.floor((w - lab + 3.5) / (12 + 3.5)));
  }

  function card(h) {
    const tk = dkey(today());
    const st = prefs.get("chips") ? streaks(h) : null;
    const gl = goalLabel(h);
    return `<article class="card" style="--c:${h.color}" data-open="${h.id}">
      <div class="head">
        <div class="ibox">${icon(h.icon)}</div>
        <div class="titles"><div class="name">${esc(h.name)}</div>${h.description ? `<div class="desc">${esc(h.description)}</div>` : ""}</div>
        ${checkButton(h, tk)}
      </div>
      <div class="grid-wrap">${heatmap(h, cardWeeks(), { labels: prefs.get("labels") })}</div>
      ${st ? `<div class="chips"><span class="chip">${icon("flame")}${st.current}</span>${gl ? `<span class="chip">${icon("target")}${gl}</span>` : ""}</div>` : ""}
    </article>`;
  }

  function checklist(hs) {
    // This week, first day to last (Settings → Week starts on). Rolls over on its own when the
    // new week starts, because it's worked out from today on every render.
    const t = today(), tk = dkey(t);
    const start = startOfWeek(t);
    const days = [...Array(7)].map((_, i) => addDays(start, i));
    const fmt = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    return `<div class="cl-top"><span class="pill">This week</span>
      <span class="cl-range">${fmt(days[0])} — ${fmt(days[6])}</span></div>
      <div class="table week">
        <div class="whead">
          ${days.map((d) => `<div class="dayh ${dkey(d) === tk ? "today" : ""}"><small>${DAYS2[d.getDay()]}</small><b>${d.getDate()}</b></div>`).join("")}
        </div>
        ${hs.map((h) => `<div class="wrow" style="--c:${h.color}">
          <div class="lbl" data-open="${h.id}"><div class="ibox">${icon(h.icon)}</div><span class="nm">${esc(h.name)}</span>
            <span class="wcount">${days.filter((d) => isDone(h, dkey(d))).length}/7</span></div>
          <div class="wcells">${days.map((d) => {
            const k = dkey(d), f = frac(h, k), future = d > t;
            const inner = f >= 1 || perDay(h) === 1 || future ? "" : ring(f, h.color, 8);
            return `<button class="tcell ${f >= 1 ? "done" : ""} ${future ? "future" : ""} ${k === tk ? "now" : ""}" style="--c:${h.color}"
              data-check="${h.id}" data-day="${k}" ${future ? "disabled" : ""} aria-label="${esc(h.name)} ${k}">${inner}</button>`;
          }).join("")}</div>
        </div>`).join("")}
      </div>`;
  }

  function monthCells(h, y, m, cls = "mini") {
    const t = today(), tk = dkey(t);
    const first = new Date(y, m, 1);
    const lead = (first.getDay() - weekStart() + 7) % 7;
    let out = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(y, m, 1 - lead + i), k = dkey(d);
      if (d.getMonth() !== m) { out += `<i class="x"></i>`; continue; }
      if (d > t) { out += `<i></i>`; continue; }
      const f = frac(h, k);
      const c = (f >= 1 ? "f" : f > 0 ? "p" : "") + (k === tk ? " t" : "");
      out += f > 0 && f < 1 ? `<i class="${c}" style="--pct:${Math.round(25 + f * 60)}%"></i>` : `<i class="${c}"></i>`;
    }
    return `<div class="${cls}">${out}</div>`;
  }

  function tile(h) {
    const t = today(), tk = dkey(t), f = frac(h, tk), done = f >= 1;
    const inner = done ? icon(h.icon) : perDay(h) > 1 && f > 0 ? ring(f, h.color, 17) + icon("plus") : icon("check");
    return `<div class="tile" style="--c:${h.color}" data-open="${h.id}">
      <div class="th"><button class="tc ${done ? "done" : ""}" data-check="${h.id}" data-tc="${h.id}" data-day="${tk}" aria-label="Check ${esc(h.name)}">${inner}</button>
        <div style="min-width:0"><div class="tn">${esc(h.name)}</div><div class="tm">${MONTHS[t.getMonth()]} ${t.getFullYear()}</div></div></div>
      ${monthCells(h, t.getFullYear(), t.getMonth())}
    </div>`;
  }

  // ---- detail page -----------------------------------------------------------------------
  const detail = { id: null, y: 0, m: 0 };

  function openDetail(id) {
    const t = today();
    detail.id = id; detail.y = t.getFullYear(); detail.m = t.getMonth();
    renderDetail();
    const page = $("#detail");
    page.scrollTop = 0;
    page.classList.add("open");
    page.setAttribute("aria-hidden", "false");
    $("#app").classList.add("pushed");

  }
  function closeDetail() {
    detail.id = null;
    $("#detail").classList.remove("open");
    $("#detail").setAttribute("aria-hidden", "true");
    $("#app").classList.remove("pushed");
    renderHome();
  }

  function renderDetail() {
    const h = detail.id && getHabit(detail.id);
    const page = $("#detail");
    if (!h) { if (detail.id) closeDetail(); return; }
    const keepScroll = page.scrollTop;
    const st = streaks(h), gl = goalLabel(h);
    const ws = weekStart();
    const t = today(), tk = dkey(t);
    const first = new Date(detail.y, detail.m, 1);
    const lead = (first.getDay() - ws + 7) % 7;
    let cal = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(detail.y, detail.m, 1 - lead + i), k = dkey(d);
      const f = frac(h, k);
      const cls = [d.getMonth() !== detail.m ? "out" : "", d > t ? "future" : "", f >= 1 ? "done" : f > 0 ? "part" : "",
                   k === tk ? "today" : "", noteOf(h, k) ? "note" : ""].join(" ");
      cal += `<button class="${cls}" data-day="${k}" style="--c:${h.color}">${d.getDate()}</button>`;
    }
    const notes = Object.entries(sync.doc.days[h.id] || {}).filter(([, v]) => v[2]).sort((a, b) => b[0].localeCompare(a[0]));
    page.innerHTML = `<div class="inner" style="padding:0 16px">
      <div class="d-top">
        <button class="round" id="d-back" aria-label="Back">${icon("chevron-left")}</button>
        <div class="spacer"></div>
        <button class="round" id="d-edit" aria-label="Edit">${icon("edit")}</button>
        <button class="round" id="d-more" aria-label="More">${icon("dots")}</button>
      </div>
      <div class="d-hero" style="--c:${h.color}">
        <div class="ibox">${icon(h.icon)}</div>
        <div><h1>${esc(h.name)}</h1>${h.description ? `<p>${esc(h.description)}</p>` : ""}</div>
      </div>
      <div class="panel" style="--c:${h.color}; padding:16px 14px">
        <div class="yearwrap">${heatmap(h, 53, { labels: true, s: 13, g: 4 })}</div>
      </div>
      <div class="chips" style="--c:${h.color}">
        <span class="chip">${icon("flame")}${st.current}</span>
        ${gl ? `<span class="chip">${icon("target")}${gl}</span>` : ""}
        <span class="chip" style="opacity:.75">${icon("trophy")}${st.best}</span>
      </div>
      <div class="panel">
        <div class="cal-head">${[...Array(7)].map((_, i) => `<span>${DAYS3[(ws + i) % 7]}</span>`).join("")}</div>
        <div class="cal" id="d-cal">${cal}</div>
        <div class="cal-foot">
          <button class="pill" id="cal-today">${icon("calendar")}${MONTHS[detail.m]} ${detail.y}</button>
          <div class="spacer"></div>
          <button class="round small" id="cal-prev" aria-label="Previous month">${icon("chevron-left")}</button>
          <button class="round small" id="cal-next" aria-label="Next month">${icon("chevron-right")}</button>
        </div>
        <div class="hint">Tap a day to check it · press and hold to add a note</div>
      </div>
      <div class="panel notes">
        ${notes.length ? notes.map(([k, v]) => `<div class="note-row"><div class="d">${DAYS3[parse(k).getDay()]} · ${MONTHS[parse(k).getMonth()]} ${parse(k).getDate()}, ${parse(k).getFullYear()}</div><div class="t">${esc(v[2])}</div></div>`).join("")
          : `<div class="none">No notes yet</div>`}
      </div>
    </div>`;
    page.scrollTop = keepScroll;
    toToday(page);
    $("#d-back").onclick = closeDetail;
    $("#d-edit").onclick = () => openEdit(h.id);
    $("#d-more").onclick = () => openMore(h);
    $("#cal-prev").onclick = () => { detail.m--; if (detail.m < 0) { detail.m = 11; detail.y--; } renderDetail(); };
    $("#cal-next").onclick = () => { detail.m++; if (detail.m > 11) { detail.m = 0; detail.y++; } renderDetail(); };
    $("#cal-today").onclick = () => { detail.y = t.getFullYear(); detail.m = t.getMonth(); renderDetail(); };
    longPress($("#d-cal"), "button[data-day]", (b) => openNote(h, b.dataset.day), (b) => { tap(h, b.dataset.day); renderAll(); });
  }

  function toToday(root) {                  // year grids open scrolled to the newest week
    const go = () => $$(".yearwrap", root).forEach((y) => { y.scrollLeft = y.scrollWidth; });
    go();
    requestAnimationFrame(go);
  }

  function longPress(root, sel, onLong, onTap) {
    let timer = null, target = null, fired = false, sx = 0, sy = 0;
    root.addEventListener("pointerdown", (e) => {
      target = e.target.closest(sel);
      if (!target) return;
      fired = false; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { fired = true; if (navigator.vibrate) navigator.vibrate(15); onLong(target); }, 480);
    });
    const cancel = () => { clearTimeout(timer); timer = null; };
    root.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
    root.addEventListener("pointercancel", cancel);
    root.addEventListener("pointerup", (e) => {
      const was = timer; cancel();
      if (!fired && was && target && e.target.closest(sel) === target) onTap(target);
      target = null;
    });
    root.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // ---- sheets --------------------------------------------------------------------------
  const stack = [];
  function openSheet(id, html, mount) {
    const el = $("#" + id);
    el.onclick = null;                        // drop the previous content's handler
    el.innerHTML = `<div class="grab"></div>${html}`;
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
    if (!stack.includes(id)) stack.push(id);
    $("#scrim").classList.add("on");
    $("#scrim").style.zIndex = id === "sheet2" ? 55 : 40;
    dragToClose(el, id);
    if (mount) mount(el);
    return el;
  }
  function closeSheet(id) {
    id = id || stack[stack.length - 1];
    if (!id || !stack.includes(id)) return;
    const el = $("#" + id);
    el.classList.remove("open");
    el.style.transform = "";
    el.setAttribute("aria-hidden", "true");
    stack.splice(stack.indexOf(id), 1);
    if (!stack.length) $("#scrim").classList.remove("on");
    else $("#scrim").style.zIndex = 40;
    const active = document.activeElement;
    if (active && el.contains(active)) active.blur();
  }
  function dragToClose(el, id) {
    let y0 = null, dy = 0;
    const zone = (e) => e.target.closest(".grab, .s-head, .st-tabs") && !e.target.closest("button");
    el.onpointerdown = (e) => { if (!zone(e)) return; y0 = e.clientY; dy = 0; el.style.transition = "none"; el.setPointerCapture(e.pointerId); };
    el.onpointermove = (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); el.style.transform = `translateY(${dy}px)`; };
    el.onpointerup = el.onpointercancel = () => {
      if (y0 === null) return;
      y0 = null; el.style.transition = "";
      if (dy > 110) closeSheet(id); else el.style.transform = "";
    };
  }

  function toast(text, ms = 2200) {
    const t = $("#toast");
    t.textContent = text;
    t.classList.add("on");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("on"), ms);
  }

  // ---- create / edit ----------------------------------------------------------------------
  function openEdit(id) {
    const existing = id && getHabit(id);
    const h = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: "", description: "", icon: "sparkles",
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      type: "build", goal: { period: "none", count: 1 }, perDay: 1, archived: false,
      order: habitsAll().reduce((m, x) => Math.max(m, x.order ?? 0), 0) + 1,
      createdAt: Date.now(), updatedAt: 0,
    };
    h.goal = h.goal || { period: "none", count: 1 };
    const sample = Object.keys(ICONS.habit).filter((n) => n !== h.icon).slice(0, 72);
    const html = `
      <div class="s-head"><button class="round small" data-close aria-label="Close">${icon("x")}</button>
        <h2>${existing ? "Edit Habit" : "New Habit"}</h2><span></span></div>
      <div class="s-body">
        <div class="icon-hero" style="--c:${h.color}">
          <div class="pattern">${sample.map((n) => icon(n)).join("")}</div>
          <button class="big" id="e-icon" aria-label="Choose icon">${icon(h.icon)}<span class="edit-badge">${icon("edit")}</span></button>
        </div>
        <div class="lab">Name</div>
        <input class="field" id="e-name" maxlength="60" placeholder="e.g. Read 10 pages" value="${esc(h.name)}" autocomplete="off">
        <div class="lab">Description</div>
        <input class="field" id="e-desc" maxlength="120" placeholder="Optional" value="${esc(h.description)}" autocomplete="off">
        <div class="lab">Color</div>
        <div class="colors">${COLORS.map((c) => `<button style="--sw:${c}" data-color="${c}" class="${c === h.color ? "on" : ""}" aria-label="Colour ${c}"></button>`).join("")}</div>
        <div class="lab">Habit type</div>
        <div class="seg" id="e-type"><button data-v="build">Build a habit</button><button data-v="quit">Quit a habit</button></div>
        <div class="caption" id="e-type-cap"></div>
        <button class="adv-toggle" id="e-adv-t">Advanced Options ${icon("chevron-down")}</button>
        <div class="adv" id="e-adv">
          <div class="lab">Streak goal</div>
          <div class="seg" id="e-goal"><button data-v="none">None</button><button data-v="day">Daily</button><button data-v="week">Week</button><button data-v="month">Month</button></div>
          <div id="e-goal-count" style="margin-top:10px"></div>
          <div class="caption" id="e-goal-cap"></div>
          <div class="lab">Completions per day</div>
          <div id="e-perday"></div>
          <div class="caption">Above 1, each tap adds one and the check fills up as you go.</div>
        </div>
        ${existing ? `<div class="row-btns">
          <button class="btn ghost" id="e-archive">${icon(h.archived ? "archive-off" : "archive")} ${h.archived ? "Unarchive" : "Archive"}</button>
          <button class="btn danger" id="e-delete">${icon("trash")} Delete</button></div>` : ""}
      </div>
      <div class="s-foot"><button class="btn" id="e-save">Save</button></div>`;
    openSheet("sheet", html, (el) => {
      const sync_ = () => {
        $$("#e-type button", el).forEach((b) => b.classList.toggle("on", b.dataset.v === h.type));
        $("#e-type-cap", el).textContent = h.type === "quit" ? "Mark each day you stayed away from it." : "Mark each day you complete it.";
        $$("#e-goal button", el).forEach((b) => b.classList.toggle("on", b.dataset.v === h.goal.period));
        const per = h.goal.period;
        const max = per === "week" ? 7 : 31;
        if (per === "week" || per === "month") {
          h.goal.count = Math.min(max, Math.max(1, h.goal.count || 1));
          $("#e-goal-count", el).innerHTML = stepper(`${h.goal.count} × per ${per}`, "gc");
        } else $("#e-goal-count", el).innerHTML = "";
        $("#e-goal-cap", el).textContent = per === "none" ? "Streaks count consecutive days."
          : per === "day" ? "Your streak grows every day you check it."
          : `A missed day is fine if the ${per} still adds up.`;
        $("#e-perday", el).innerHTML = stepper(`${perDay(h)} × per day`, "pd");
        $(".icon-hero", el).style.setProperty("--c", h.color);
        $("#e-icon", el).firstElementChild.outerHTML = icon(h.icon);
        $$(".colors button", el).forEach((b) => b.classList.toggle("on", b.dataset.color === h.color));
      };
      sync_();
      if (h.goal.period !== "none" || perDay(h) > 1) { $("#e-adv", el).classList.add("open"); $("#e-adv-t", el).classList.add("open"); }
      el.onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.close !== undefined) return closeSheet("sheet");
        if (b.dataset.color) { h.color = b.dataset.color; sync_(); }
        else if (b.closest("#e-type")) { h.type = b.dataset.v; sync_(); }
        else if (b.closest("#e-goal")) { h.goal.period = b.dataset.v; sync_(); }
        else if (b.dataset.step) {
          const [which, d] = b.dataset.step.split(":");
          if (which === "gc") h.goal.count = (h.goal.count || 1) + Number(d);
          else h.perDay = Math.min(99, Math.max(1, perDay(h) + Number(d)));
          sync_();
        } else if (b.id === "e-adv-t") { b.classList.toggle("open"); $("#e-adv", el).classList.toggle("open"); }
        else if (b.id === "e-icon") openIconPicker(h, () => sync_());
        else if (b.id === "e-archive") {
          h.archived = !h.archived; h.name = h.name || existing.name; saveHabit(h); closeSheet("sheet");
          toast(h.archived ? "Archived" : "Back on your list");
          if (h.archived && detail.id === h.id) closeDetail();
          renderAll();
        } else if (b.id === "e-delete") confirmDelete(h);
        else if (b.id === "e-save") {
          h.name = $("#e-name", el).value.trim();
          h.description = $("#e-desc", el).value.trim();
          if (!h.name) { $("#e-name", el).focus(); toast("Give it a name"); return; }
          saveHabit(h);
          closeSheet("sheet");
          renderAll();
        }
      };
      if (!existing) setTimeout(() => $("#e-name", el).focus(), 450);
    });
  }

  function stepper(label, key) {
    return `<div class="stepper"><span class="v">${label}</span><span class="bs">
      <button data-step="${key}:-1" aria-label="Less">${icon("minus")}</button>
      <button data-step="${key}:1" aria-label="More">${icon("plus")}</button></span></div>`;
  }

  function openIconPicker(h, done) {
    const names = Object.keys(ICONS.habit);
    openSheet("sheet2", `
      <div class="s-head"><button class="round small" data-close aria-label="Close">${icon("x")}</button><h2>Icon</h2><span></span></div>
      <div class="s-body" style="padding-bottom:calc(var(--safe-b) + 30px)">
        <div class="icon-search"><input class="field" id="ic-q" placeholder="Search icons" autocomplete="off"></div>
        <div class="icon-grid" id="ic-grid" style="--c:${h.color}"></div>
      </div>`, (el) => {
      const draw = (q) => {
        q = q.trim().toLowerCase();
        $("#ic-grid", el).innerHTML = names.filter((n) => !q || n.includes(q))
          .map((n) => `<button data-icon="${n}" class="${n === h.icon ? "on" : ""}" aria-label="${n}">${icon(n)}</button>`).join("");
      };
      draw("");
      $("#ic-q", el).oninput = (e) => draw(e.target.value);
      el.onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.close !== undefined) return closeSheet("sheet2");
        if (b.dataset.icon) { h.icon = b.dataset.icon; closeSheet("sheet2"); done(); }
      };
    });
  }

  function confirmDelete(h) {
    openSheet("sheet2", `
      <div class="s-head"><span></span><h2>Delete habit?</h2><span></span></div>
      <div class="s-body" style="padding-bottom:calc(var(--safe-b) + 24px)">
        <p class="caption" style="font-size:16px;margin:4px 8px 22px">“${esc(h.name)}” and its whole history will be removed from every device. Archive it instead to keep the history.</p>
        <button class="btn danger" id="del-yes" style="margin-bottom:10px">${icon("trash")} Delete</button>
        <button class="btn ghost" data-close>Cancel</button>
      </div>`, (el) => {
      el.onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.close !== undefined) return closeSheet("sheet2");
        if (b.id === "del-yes") {
          sync.change((doc) => {
            doc.habits[h.id] = { id: h.id, deleted: true, updatedAt: Date.now() };
            delete doc.days[h.id];
          }, `Delete ${h.name}`);
          closeSheet("sheet2"); closeSheet("sheet");
          if (detail.id === h.id) closeDetail();
          renderAll();
          toast("Deleted");
        }
      };
    });
  }

  function openMore(h) {
    openSheet("sheet2", `
      <div class="s-head"><span></span><h2>${esc(h.name)}</h2><span></span></div>
      <div class="s-body" style="padding-bottom:calc(var(--safe-b) + 24px)">
        <div class="group">
          <button class="gi" id="m-edit"><div class="ibox" style="--c:${h.color}">${icon("edit")}</div><div class="t">Edit</div></button>
          <button class="gi" id="m-stats"><div class="ibox" style="--c:${h.color}">${icon("chart-line")}</div><div class="t">Statistics</div></button>
          <button class="gi" id="m-arch"><div class="ibox" style="--c:${h.color}">${icon("archive")}</div><div class="t">Archive<small>Hide it, keep the history</small></div></button>
          <button class="gi" id="m-del"><div class="ibox" style="--c:var(--red)">${icon("trash")}</div><div class="t" style="color:var(--red)">Delete</div></button>
        </div>
      </div>`, (el) => {
      el.onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.id === "m-edit") { closeSheet("sheet2"); openEdit(h.id); }
        else if (b.id === "m-stats") { closeSheet("sheet2"); openStats(h.id); }
        else if (b.id === "m-arch") {
          closeSheet("sheet2");
          saveHabit(Object.assign({}, h, { archived: true }));
          closeDetail(); toast("Archived");
        } else if (b.id === "m-del") { closeSheet("sheet2"); confirmDelete(h); }
      };
    });
  }

  function openNote(h, k) {
    const d = parse(k);
    openSheet("sheet2", `
      <div class="s-head"><button class="round small" data-close aria-label="Close">${icon("x")}</button>
        <h2>${MONTHS[d.getMonth()]} ${d.getDate()}</h2><span></span></div>
      <div class="s-body" style="padding-bottom:calc(var(--safe-b) + 24px)">
        <textarea class="field" id="n-text" maxlength="500" placeholder="How did it go?">${esc(noteOf(h, k))}</textarea>
        <button class="btn" id="n-save" style="margin-top:14px">Save note</button>
      </div>`, (el) => {
      setTimeout(() => $("#n-text", el).focus(), 400);
      el.onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.close !== undefined) return closeSheet("sheet2");
        if (b.id === "n-save") {
          setDay(h, k, count(h, k), $("#n-text", el).value.trim());
          closeSheet("sheet2");
          renderAll();
        }
      };
    });
  }

  // ---- statistics ---------------------------------------------------------------------------
  const stats = { id: "all", year: new Date().getFullYear() };

  function openStats(id) {
    stats.id = id && getHabit(id) ? id : "all";
    stats.year = today().getFullYear();
    openSheet("sheet", `<div id="st-root" style="display:flex;flex-direction:column;min-height:0;flex:1"></div>`, () => renderStats());
  }

  function renderStats() {
    const root = $("#st-root");
    if (!root || !stack.includes("sheet")) return;
    const hs = habits();
    const one = stats.id !== "all" && getHabit(stats.id);
    const color = one ? one.color : "#5E5CE6";
    const set = one ? [one] : hs;
    const y = stats.year, t = today();
    const yStart = new Date(y, 0, 1), yEnd = new Date(y, 11, 31);
    // per-day value over the selected habits (fraction of them done)
    const dayVal = (k) => set.length ? set.reduce((s, h) => s + frac(h, k), 0) / set.length : 0;
    let completions = 0, possible = 0;
    const perMonth = Array(12).fill(0);
    for (const h of set) {
      const from = new Date(Math.max(yStart, firstDay(h)));
      for (let d = from; d <= yEnd && d <= t; d = addDays(d, 1)) {
        possible++;
        if (isDone(h, dkey(d))) { completions++; perMonth[d.getMonth()]++; }
      }
    }
    const rate = possible ? Math.round((completions / possible) * 100) : 0;
    const sk = set.map(streaks);
    const cur = one ? sk[0].current : sk.reduce((m, s) => Math.max(m, s.current), 0);
    const best = sk.reduce((m, s) => Math.max(m, s.best), 0);
    // year heatmap: weeks from the year's first week to its last (or today)
    const end = y === t.getFullYear() ? t : yEnd;
    const weeks = Math.ceil(((end - startOfWeek(yStart)) / 864e5 + 1) / 7);
    const minYear = Math.min(t.getFullYear(), ...set.map((h) => firstDay(h).getFullYear()));
    const fakeHabit = { id: "_all", perDay: 1, color };
    root.innerHTML = `
      <div class="st-tabs">
        <button class="tab all ${one ? "" : "on"}" data-tab="all">All</button>
        ${hs.map((h) => `<button class="tab ${stats.id === h.id ? "on" : ""}" style="--c:${h.color}" data-tab="${h.id}" aria-label="${esc(h.name)}">${icon(h.icon)}</button>`).join("")}
        <button class="done-btn" data-close>Done</button>
      </div>
      <div class="s-body" style="--c:${color};padding-bottom:calc(var(--safe-b) + 30px)">
        <div class="panel st-habit"><div class="ibox">${icon(one ? one.icon : "chart-line")}</div>
          <div><div class="n">${one ? esc(one.name) : "All habits"}</div><div class="dsc">${one ? esc(one.description || goalLabel(one) || "") : `${hs.length} active habit${hs.length === 1 ? "" : "s"}`}</div></div></div>
        <div class="panel yearbar" style="margin-top:12px;padding:4px 6px">
          <button id="y-prev" ${y <= minYear ? "disabled" : ""} aria-label="Previous year">${icon("chevron-left")}</button><b>${y}</b>
          <button id="y-next" ${y >= t.getFullYear() ? "disabled" : ""} aria-label="Next year">${icon("chevron-right")}</button></div>
        <div class="panel" style="margin-top:12px;padding:16px 14px;--c:${color}">
          <div class="yearwrap">${yearHeatmap(fakeHabit, y, weeks, dayVal)}</div></div>
        <div class="tiles2">
          <div class="stat" style="--c:${color}"><div class="ic">${icon("hash")}</div><div class="big">${completions}</div><div class="sm">Completions</div></div>
          <div class="stat" style="--c:${color}"><div class="ic">${icon("percentage")}</div><div class="big">${rate}</div><div class="sm">Completion Rate</div></div>
        </div>
        <div class="chart" style="--c:${color}"><div class="ic">${icon("chart-area-line")}</div><h3>Completions / Month</h3>${lineChart(perMonth, color, y)}</div>
        <div class="tiles2">
          <div class="stat" style="--c:${color}"><div class="ic">${icon("flame")}</div><div class="big">${cur}</div><div class="sm">Current Streak</div></div>
          <div class="stat" style="--c:${color}"><div class="ic">${icon("trophy")}</div><div class="big">${best}</div><div class="sm">Best Streak</div></div>
        </div>
      </div>`;
    toToday(root);
    const sheet = $("#sheet");
    sheet.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.close !== undefined) return closeSheet("sheet");
      if (b.dataset.tab) { stats.id = b.dataset.tab; renderStats(); }
      if (b.id === "y-prev") { stats.year--; renderStats(); }
      if (b.id === "y-next") { stats.year++; renderStats(); }
    };
  }

  function yearHeatmap(h, y, weeks, valueFn) {
    // heatmap() ends at today; for past years render the grid ending on Dec 31 instead
    const t = today();
    if (y === t.getFullYear()) return heatmap(h, weeks, { labels: true, s: 13, g: 4, valueFn });
    try {
      todayOverride = new Date(y, 11, 31);
      return heatmap(h, weeks, { labels: true, s: 13, g: 4, valueFn });
    } finally { todayOverride = null; }
  }

  function lineChart(vals, color, y) {
    const W = 320, H = 150, P = 6;
    const t = today();
    const last = y === t.getFullYear() ? t.getMonth() : 11;
    const pts = vals.slice(0, last + 1);
    const max = Math.max(4, ...pts);
    const x = (i) => P + (i * (W - 2 * P)) / 11;
    const yy = (v) => H - 4 - (v / max) * (H - 20);
    const xy = pts.map((v, i) => [x(i), yy(v)]);
    let d = "";
    xy.forEach(([px, py], i) => {
      if (!i) { d = `M${px},${py}`; return; }
      const [ax, ay] = xy[i - 1];
      const cx = (ax + px) / 2;
      d += ` C${cx},${ay} ${cx},${py} ${px},${py}`;
    });
    const area = xy.length ? `${d} L${xy[xy.length - 1][0]},${H} L${xy[0][0]},${H} Z` : "";
    let dots = "";
    for (let gx = 0; gx < 12; gx++) for (let gy = 0; gy < 6; gy++) dots += `<circle cx="${x(gx)}" cy="${12 + gy * ((H - 16) / 5)}" r=".9" style="fill:var(--faint)"/>`;
    const gid = "g" + color.slice(1);
    return `<svg class="plot" viewBox="0 0 ${W} ${H + 22}">
      <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".55"/><stop offset="1" stop-color="${color}" stop-opacity=".02"/></linearGradient></defs>
      ${dots}
      ${xy.length > 1 ? `<path d="${area}" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>` : ""}
      ${xy.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="3.2" fill="${color}"/>`).join("")}
      ${MONTHS.map((m, i) => `<text class="xl" x="${x(i)}" y="${H + 18}" text-anchor="middle">${m}</text>`).join("")}
    </svg>`;
  }

  // ---- settings -----------------------------------------------------------------------------
  function openSettings() {
    openSheet("sheet", `
      <div class="s-head"><button class="round small" data-close aria-label="Close">${icon("x")}</button><h2>Settings</h2><span></span></div>
      <div class="s-body" id="set-body" style="padding-bottom:calc(var(--safe-b) + 40px)"></div>`, () => renderSettings());
  }

  function renderSettings() {
    const body = $("#set-body");
    if (!body) return;
    const cfg = sync.config;
    const st = sync.status;
    const archived = habitsAll().filter((h) => h.archived);
    const last = sync.lastSync ? new Date(sync.lastSync).toLocaleString() : "never";
    body.innerHTML = `
      <div class="lab">Sync with ATOM</div>
      ${sync.connected ? `
        <div class="group">
          <div class="gi"><div class="ibox" style="--c:var(--green)">${icon(st.state === "error" ? "cloud-off" : "cloud-check")}</div>
            <div class="t">${esc(cfg.repo)}<small>${esc(st.text || "Connected")} · last sync ${esc(last)}</small></div></div>
          <button class="gi" id="s-sync"><div class="ibox" style="--c:var(--accent)">${icon("refresh")}</div><div class="t">Sync now</div></button>
          <button class="gi" id="s-disc"><div class="ibox" style="--c:var(--red)">${icon("logout")}</div><div class="t">Disconnect this device<small>Removes the token from this device. Habits stay.</small></div></button>
        </div>` : `
        <input class="field" id="s-repo" placeholder="owner/repo" value="${esc(cfg.repo)}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <input class="field" id="s-token" type="password" placeholder="GitHub token (github_pat_…)" style="margin-top:10px" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn" id="s-connect" style="margin-top:12px">${icon("key")} Connect</button>
        <div class="help">The token stays on this device only - it's never uploaded anywhere except to GitHub itself.
          <ol><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com → new fine-grained token</a></li>
          <li>Repository access: <b>Only select repositories</b> → your habits repo</li>
          <li>Permissions → Repository → <b>Contents: Read and write</b> (nothing else)</li>
          <li>Generate, copy, paste above</li></ol></div>`}
      <div class="lab">Week starts on</div>
      <div class="seg" id="s-week"><button data-v="1" class="${weekStart() === 1 ? "on" : ""}">Monday</button><button data-v="0" class="${weekStart() === 0 ? "on" : ""}">Sunday</button></div>
      <div class="lab">Cards</div>
      <div class="group">
        <button class="gi" data-pref="labels"><div class="t">Month &amp; day labels</div><span class="switch ${prefs.get("labels") ? "on" : ""}"></span></button>
        <button class="gi" data-pref="chips"><div class="t">Streak &amp; goal</div><span class="switch ${prefs.get("chips") ? "on" : ""}"></span></button>
      </div>
      <div class="lab">Habits</div>
      <div class="group">
        <button class="gi" id="s-order"><div class="ibox" style="--c:var(--accent)">${icon("grip-vertical")}</div><div class="t">Reorder</div></button>
        <button class="gi" id="s-arch"><div class="ibox" style="--c:var(--accent)">${icon("archive")}</div><div class="t">Archived</div><span class="v">${archived.length}</span></button>
      </div>
      <div class="lab">Data</div>
      <div class="group">
        <button class="gi" id="s-export"><div class="ibox" style="--c:var(--accent)">${icon("download")}</div><div class="t">Export backup</div></button>
        <button class="gi" id="s-import"><div class="ibox" style="--c:var(--accent)">${icon("upload")}</div><div class="t">Import backup<small>Merges with what's here</small></div></button>
      </div>
      <input type="file" id="s-file" accept="application/json,.json" hidden>
      <p class="help" style="text-align:center;margin-top:26px">ATOM Habits · icons by Tabler (MIT)</p>`;
    body.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.id === "s-connect") {
        const repo = $("#s-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
        const token = $("#s-token").value.trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast("Repo should look like owner/name");
        if (!token) return toast("Paste your token");
        b.disabled = true;
        try {
          await new HabitSync.GitHubStore(repo, token).load();
        } catch (err) {
          b.disabled = false;
          return toast(err.message, 4000);
        }
        sync.config = { repo, token };
        await sync.sync();
        renderAll(); renderSettings();
        toast("Connected - syncing with ATOM");
      } else if (b.id === "s-sync") { await sync.sync(); renderSettings(); toast(sync.status.text); }
      else if (b.id === "s-disc") { sync.config = { repo: cfg.repo, token: "" }; renderSettings(); updateDot(); }
      else if (b.dataset.v !== undefined && b.closest("#s-week")) {
        sync.change((doc) => { doc.settings = { weekStart: Number(b.dataset.v), updatedAt: Date.now() }; }, "Week start");
        renderAll(); renderSettings();
      } else if (b.dataset.pref) { prefs.set(b.dataset.pref, !prefs.get(b.dataset.pref)); renderAll(); renderSettings(); }
      else if (b.id === "s-order") openReorder();
      else if (b.id === "s-arch") openArchived();
      else if (b.id === "s-export") {
        const blob = new Blob([JSON.stringify(sync.doc, null, 1)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `habits-${dkey(today())}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } else if (b.id === "s-import") $("#s-file").click();
    };
    $("#s-file").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const doc = JSON.parse(await f.text());
        if (!doc.habits) throw new Error("not a habits backup");
        await sync.replaceAll(HabitSync.merge(sync.doc, doc));
        renderAll(); renderSettings(); toast("Imported");
      } catch (err) { toast("Couldn't import: " + err.message, 3500); }
    };
  }

  function openReorder() {
    const draw = (el) => {
      const hs = habits();
      $(".s-body", el).innerHTML = `<div class="group reorder">${hs.map((h, i) => `
        <div class="gi"><div class="ibox" style="--c:${h.color}">${icon(h.icon)}</div><div class="t">${esc(h.name)}</div>
          <div class="arrows"><button data-mv="${i}:-1" ${i === 0 ? "disabled" : ""} aria-label="Up">${icon("chevron-left", "up")}</button>
          <button data-mv="${i}:1" ${i === hs.length - 1 ? "disabled" : ""} aria-label="Down">${icon("chevron-right", "down")}</button></div></div>`).join("")}</div>`;
      $$(".up", el).forEach((s) => (s.style.transform = "rotate(90deg)"));
      $$(".down", el).forEach((s) => (s.style.transform = "rotate(90deg)"));
    };
    openSheet("sheet2", `<div class="s-head"><span></span><h2>Reorder</h2><button class="round small" data-close aria-label="Done">${icon("check")}</button></div>
      <div class="s-body" style="padding-bottom:calc(var(--safe-b) + 24px)"></div>`, (el) => {
      draw(el);
      el.onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.close !== undefined) return closeSheet("sheet2");
        if (b.dataset.mv) {
          const [i, d] = b.dataset.mv.split(":").map(Number);
          const hs = habits();
          const [a, c] = [hs[i], hs[i + d]];
          const now = Date.now();
          sync.change((doc) => {
            hs.forEach((h, n) => { if (h.order !== n) doc.habits[h.id] = Object.assign({}, h, { order: n, updatedAt: now }); });
            doc.habits[a.id] = Object.assign({}, doc.habits[a.id], { order: i + d, updatedAt: now });
            doc.habits[c.id] = Object.assign({}, doc.habits[c.id], { order: i, updatedAt: now });
          }, "Reorder");
          draw(el); renderHome();
        }
      };
    });
  }

  function openArchived() {
    const draw = (el) => {
      const hs = habitsAll().filter((h) => h.archived);
      $(".s-body", el).innerHTML = hs.length ? `<div class="group">${hs.map((h) => `
        <div class="gi"><div class="ibox" style="--c:${h.color}">${icon(h.icon)}</div><div class="t">${esc(h.name)}</div>
          <button class="btn ghost small" data-un="${h.id}">Restore</button></div>`).join("")}</div>`
        : `<p class="caption" style="font-size:16px">Nothing archived.</p>`;
    };
    openSheet("sheet2", `<div class="s-head"><span></span><h2>Archived</h2><button class="round small" data-close aria-label="Done">${icon("check")}</button></div>
      <div class="s-body" style="padding-bottom:calc(var(--safe-b) + 24px)"></div>`, (el) => {
      draw(el);
      el.onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.close !== undefined) { closeSheet("sheet2"); renderSettings(); return; }
        if (b.dataset.un) { saveHabit(Object.assign({}, getHabit(b.dataset.un), { archived: false })); draw(el); renderHome(); }
      };
    });
  }

  // ---- wiring -------------------------------------------------------------------------------
  function renderAll() {
    renderHome();
    if (detail.id) renderDetail();
    renderStats();
  }

  function updateDot() {
    const d = $("#sync-dot");
    d.dataset.state = sync.connected ? sync.status.state : "local";
    d.title = sync.connected ? sync.status.text : "Not synced - connect in Settings";
  }

  function loadDemo() {
    const doc = HabitSync.emptyDoc();
    const t = today();
    const demo = [
      ["Gym Day", "Every other day, no excuses.", "heart-bolt", "#34d399", { period: "week", count: 3 }, 1, 0.55],
      ["Push-Ups", "Fifty a day, in as many sets as it takes.", "run", "#fb7185", { period: "day", count: 1 }, 4, 0.7],
      ["Journal", "Three lines about the day.", "ballpen", "#2dd4bf", { period: "month", count: 20 }, 1, 0.8],
      ["Deep Work", "Four focused blocks, phone in a drawer.", "device-laptop", "#60a5fa", { period: "none", count: 1 }, 4, 0.6],
      ["Guitar", "Practice for at least 15 minutes", "music", "#fb923c", { period: "none", count: 1 }, 1, 0.5],
    ];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    demo.forEach(([name, description, ic, color, goal, per, p], i) => {
      const id = "demo" + i;
      doc.habits[id] = { id, name, description, icon: ic, color, type: "build", goal, perDay: per,
                         archived: false, order: i, createdAt: +addDays(t, -200), updatedAt: 1 };
      doc.days[id] = {};
      for (let n = 1; n < 200; n++) {
        if (rnd() < p) doc.days[id][dkey(addDays(t, -n))] = [per > 1 ? 1 + Math.floor(rnd() * per) : 1, 1];
      }
      if (i === 2 || i === 4) doc.days[id][dkey(t)] = [1, 1];
    });
    sync.doc = doc;
    sync.change = (mutate) => { mutate(sync.doc); };
    sync.sync = () => Promise.resolve();
  }

  async function boot() {
    try {
      ICONS = await (await fetch("icons.json")).json();
    } catch (e) { /* offline first run: icons appear once cached */ }
    $$("[data-ui]").forEach((b) => { b.innerHTML = icon(b.dataset.ui); });

    sync = new HabitSync.Syncer({
      storageKey: "hk",
      device: DEVICE,
      onChange: () => renderAll(),
      onStatus: (s) => {
        updateDot();
        if (s.state === "error") toast(s.text, 4000);
      },
    });

    if (/[?&]demo\b/.test(location.search)) loadDemo();   // sample data in memory only, never synced

    $("#btn-add").onclick = () => openEdit(null);
    $("#btn-settings").onclick = openSettings;
    $("#btn-stats").onclick = () => openStats(null);
    $("#scrim").onclick = () => closeSheet();
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-close]");
      if (b && b.closest(".sheet")) closeSheet(b.closest(".sheet").id);
    });
    $("#views").onclick = (e) => {
      const b = e.target.closest("button[data-view]");
      if (!b) return;
      prefs.set("view", b.dataset.view);
      renderHome();
      window.scrollTo({ top: 0 });
    };
    $("#list").addEventListener("click", (e) => {
      const c = e.target.closest("[data-check]");
      if (c) {
        e.stopPropagation();
        const h = getHabit(c.dataset.check);
        if (!h) return;
        tap(h, c.dataset.day);
        bumpId = h.id;
        renderHome();
        return;
      }
      const o = e.target.closest("[data-open]");
      if (o) openDetail(o.dataset.open);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (stack.length) closeSheet(); else if (detail.id) closeDetail();
    });

    let lastW = window.innerWidth;
    window.addEventListener("resize", () => {
      if (Math.abs(window.innerWidth - lastW) > 20) { lastW = window.innerWidth; renderHome(); }
    });

    // keep in step with ATOM and your other devices
    const pull = () => { if (document.visibilityState === "visible") sync.sync(); };
    document.addEventListener("visibilitychange", pull);
    window.addEventListener("online", pull);
    window.addEventListener("focus", pull);
    setInterval(pull, 15000);
    let lastDay = dkey(today());
    setInterval(() => { const k = dkey(today()); if (k !== lastDay) { lastDay = k; renderAll(); } }, 30000);

    renderHome();
    updateDot();
    sync.sync();
    if (/[?&]demo\b/.test(location.search)) {          // ?demo&view=grid&open=detail - for previews
      const q = new URLSearchParams(location.search);
      if (q.get("view")) { prefs.set("view", q.get("view")); renderHome(); }
      const o = q.get("open");
      if (o === "detail") openDetail("demo0");
      if (o === "edit") openEdit("demo0");
      if (o === "new") openEdit(null);
      if (o === "stats") openStats("demo2");
      if (o === "settings") openSettings();
    }
    if (!sync.connected && !localStorage.getItem("hk.seenIntro")) {
      try { localStorage.setItem("hk.seenIntro", "1"); } catch (e) { /* */ }
      setTimeout(() => toast("Connect GitHub in Settings to sync with ATOM", 3500), 800);
    }

    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  boot();
})();
