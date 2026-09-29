(() => {
  "use strict";

  const CACHE_TTL_MS = 10 * 60 * 1000;
  const MAX_CONCURRENT_FETCHES = 4;

  // Grade percentage floor -> meme tier image. Checked top to bottom.
  const GRADE_TIERS = [
    [99, "tier1.png"],
    [97, "tier2.png"],
    [95, "tier3.png"],
    [93, "tier4.png"],
    [90, "tier5.png"],
    [85, "tier6.png"],
    [80, "tier7.png"],
    [75, "tier8.png"],
    [70, "tier9.png"],
    [65, "tier10.png"],
    [60, "tier11.png"],
    [50, "tier12.png"],
    [-Infinity, "tier13.png"],
  ];
  const NO_GRADE_IMAGE = "tier4.png";

  // ---------- Parsing ----------

  // Gradescope format: "2026-09-21 20:00:00 -0400"
  function parseGsDate(str) {
    const m = str && str.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
    if (!m) return null;
    const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    return Number.isNaN(t) ? null : t;
  }

  function parseCoursePage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const table = doc.querySelector("#assignments-student-table");
    if (!table) return null;

    return [...table.querySelectorAll("tbody tr")].map((row) => {
      const nameCell = row.querySelector("th");
      const link = nameCell && nameCell.querySelector("a[href]");
      const statusText = (row.querySelector(".submissionStatus--text")?.textContent || "").trim();
      const scoreText = (row.querySelector(".submissionStatus--score")?.textContent || "").trim();
      const score = scoreText.match(/^([\d.]+)\s*\/\s*([\d.]+)$/);

      // The first dueDate <time> is the regular deadline; a second one is the late deadline.
      const dueTime = [...row.querySelectorAll("time.submissionTimeChart--dueDate")]
        .find((t) => !/late due date/i.test(t.textContent));

      return {
        name: (nameCell?.textContent || "").trim(),
        url: link ? link.getAttribute("href") : null,
        submitted: !/no submission/i.test(statusText),
        due: dueTime ? parseGsDate(dueTime.getAttribute("datetime")) : null,
        earned: score ? parseFloat(score[1]) : null,
        possible: score ? parseFloat(score[2]) : null,
      };
    });
  }

  // ---------- Data ----------

  async function fetchCourse(courseId) {
    const res = await fetch(`/courses/${courseId}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const assignments = parseCoursePage(await res.text());
    if (!assignments) throw new Error("No student assignment table");
    return assignments;
  }

  async function getCached(courseId) {
    const key = `course:${courseId}`;
    const stored = (await chrome.storage.local.get(key))[key];
    return stored || null;
  }

  async function setCached(courseId, assignments) {
    await chrome.storage.local.set({ [`course:${courseId}`]: { fetchedAt: Date.now(), assignments } });
  }

  function nextDue(assignments, now = Date.now()) {
    let best = null;
    for (const a of assignments) {
      if (a.submitted || a.due == null || a.due <= now) continue;
      if (!best || a.due < best.due) best = a;
    }
    return best;
  }

  function gradeSummary(assignments) {
    const graded = assignments.filter((a) => a.possible != null && a.possible > 0);
    const earned = graded.reduce((s, a) => s + a.earned, 0);
    const possible = graded.reduce((s, a) => s + a.possible, 0);
    return { graded, earned, possible, percent: possible > 0 ? (earned / possible) * 100 : null };
  }

  function imageForGrade(percent) {
    if (percent == null) return NO_GRADE_IMAGE;
    return GRADE_TIERS.find(([floor]) => percent >= floor)[1];
  }

  // ---------- Formatting ----------

  const UNITS = [
    ["week", 7 * 24 * 3600e3],
    ["day", 24 * 3600e3],
    ["hour", 3600e3],
    ["minute", 60e3],
  ];

  // Two largest non-zero units, e.g. "2 days 12 hours", "1 week 1 hour".
  function formatCountdown(ms) {
    const parts = [];
    let rest = ms;
    for (const [name, size] of UNITS) {
      const n = Math.floor(rest / size);
      rest -= n * size;
      if (n > 0) parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      if (parts.length === 2) break;
    }
    return parts.length ? parts.join(" ") : "less than a minute";
  }

  function formatPercent(p) {
    return `${p.toFixed(1)}%`;
  }

  // ---------- Rendering ----------

  const cardState = new Map(); // courseId -> { box, assignments }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function ensureCardElements(box) {
    if (box.querySelector(".gsnd-info")) return;
    box.classList.add("gsnd-card");

    const info = el("div", "gsnd-info");
    info.append(el("div", "gsnd-label", "Next assignment:"), el("mark", "gsnd-countdown", "Loading…"));
    box.append(info);

    const img = el("img", "gsnd-meme");
    img.alt = "";
    box.append(img);

    const bar = box.querySelector(".courseBox--assignments");
    if (bar) {
      const btn = el("button", "gsnd-gradeBtn", "See Grade");
      btn.type = "button";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openGradeModal(box);
      });
      bar.append(btn);
    }
  }

  function renderCard(courseId) {
    const state = cardState.get(courseId);
    if (!state) return;
    const { box, assignments, error } = state;
    const countdown = box.querySelector(".gsnd-countdown");
    const label = box.querySelector(".gsnd-label");
    const img = box.querySelector(".gsnd-meme");

    if (!assignments) {
      countdown.textContent = error ? "Couldn't load" : "Loading…";
      countdown.title = error || "";
      return;
    }

    const next = nextDue(assignments);
    if (next) {
      label.hidden = false;
      countdown.textContent = formatCountdown(next.due - Date.now());
      countdown.classList.remove("gsnd-none");
      countdown.title = `${next.name}\nDue ${new Date(next.due).toLocaleString()}`;
    } else {
      label.hidden = true;
      countdown.textContent = "No upcoming assignments";
      countdown.classList.add("gsnd-none");
      countdown.title = "";
    }

    const { percent } = gradeSummary(assignments);
    img.src = chrome.runtime.getURL(`images/${imageForGrade(percent)}`);
    img.title = percent == null ? "No graded assignments yet" : formatPercent(percent);
  }

  function openGradeModal(box) {
    const courseId = courseIdOf(box);
    const state = cardState.get(courseId);
    const assignments = state?.assignments;

    const overlay = el("div", "gsnd-overlay");
    const modal = el("div", "gsnd-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const title = box.querySelector(".courseBox--shortname")?.textContent.trim() || "Course";
    const header = el("div", "gsnd-modalHeader");
    header.append(el("h3", null, title));
    const closeBtn = el("button", "gsnd-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    header.append(closeBtn);
    modal.append(header);

    if (!assignments) {
      modal.append(el("p", null, state?.error ? `Couldn't load grades: ${state.error}` : "Still loading…"));
    } else {
      const { graded, earned, possible, percent } = gradeSummary(assignments);
      if (percent == null) {
        modal.append(el("p", null, "No graded assignments yet."));
      } else {
        const summary = el("div", "gsnd-summary");
        const img = el("img", "gsnd-summaryImg");
        img.src = chrome.runtime.getURL(`images/${imageForGrade(percent)}`);
        img.alt = "";
        const text = el("div");
        text.append(
          el("div", "gsnd-bigPercent", formatPercent(percent)),
          el("div", "gsnd-muted", `${fmtNum(earned)} / ${fmtNum(possible)} points across ${graded.length} graded`)
        );
        summary.append(img, text);
        modal.append(summary);

        const table = el("table", "gsnd-table");
        const thead = el("thead");
        const hr = el("tr");
        ["Assignment", "Score", "%"].forEach((h) => hr.append(el("th", null, h)));
        thead.append(hr);
        const tbody = el("tbody");
        for (const a of graded) {
          const tr = el("tr");
          const nameTd = el("td");
          if (a.url) {
            const link = el("a", null, a.name);
            link.href = a.url;
            nameTd.append(link);
          } else {
            nameTd.textContent = a.name;
          }
          tr.append(
            nameTd,
            el("td", "gsnd-num", `${fmtNum(a.earned)} / ${fmtNum(a.possible)}`),
            el("td", "gsnd-num", formatPercent((a.earned / a.possible) * 100))
          );
          tbody.append(tr);
        }
        table.append(thead, tbody);
        modal.append(table);
      }
    }

    overlay.append(modal);
    document.body.append(overlay);

    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => e.key === "Escape" && close();
    overlay.addEventListener("click", (e) => e.target === overlay && close());
    closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    closeBtn.focus();
  }

  function fmtNum(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  // ---------- Main ----------

  function courseIdOf(box) {
    const m = (box.getAttribute("href") || "").match(/^\/courses\/(\d+)/);
    return m ? m[1] : null;
  }

  function studentCourseBoxes() {
    const headings = [...document.querySelectorAll("h2.pageHeading")];
    const studentHeading = headings.find((h) => h.textContent.trim() === "Student Courses");
    let lists;
    if (studentHeading) {
      const list = studentHeading.nextElementSibling;
      lists = list && list.classList.contains("courseList") ? [list] : [];
    } else if (!headings.some((h) => h.textContent.trim() === "Instructor Courses")) {
      // Student-only accounts may not have section headings.
      lists = [...document.querySelectorAll(".courseList")];
    } else {
      lists = [];
    }
    return lists.flatMap((l) => [...l.querySelectorAll("a.courseBox[href^='/courses/']")]);
  }

  async function runPool(items, limit, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await worker(queue.shift());
    });
    await Promise.all(runners);
  }

  async function main() {
    const boxes = studentCourseBoxes();
    const stale = [];

    for (const box of boxes) {
      const courseId = courseIdOf(box);
      if (!courseId) continue;
      ensureCardElements(box);
      cardState.set(courseId, { box, assignments: null, error: null });

      const cached = await getCached(courseId);
      if (cached) {
        cardState.get(courseId).assignments = cached.assignments;
      }
      renderCard(courseId);
      if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) stale.push(courseId);
    }

    setInterval(() => cardState.forEach((_, id) => renderCard(id)), 60 * 1000);

    await runPool(stale, MAX_CONCURRENT_FETCHES, async (courseId) => {
      const state = cardState.get(courseId);
      try {
        const assignments = await fetchCourse(courseId);
        state.assignments = assignments;
        state.error = null;
        await setCached(courseId, assignments);
      } catch (err) {
        state.error = err.message;
        console.warn(`[Gradescope+] course ${courseId}:`, err);
      }
      renderCard(courseId);
    });
  }

  main();
})();
