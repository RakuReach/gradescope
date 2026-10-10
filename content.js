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

  // ---------- Weights ----------

  // Per-course category weights, stored apart from the fetch cache so a refetch never clears them:
  // { categories: [{ id, name, keywords, weight, average, drop }], overrides: { [assignmentKey]: categoryId | "none" } }
  // `drop` is how many of the category's lowest scores don't count; older saves have none.
  const weightsKey = (courseId) => `weights:${courseId}`;

  async function getWeights(courseId) {
    return (await chrome.storage.local.get(weightsKey(courseId)))[weightsKey(courseId)] || null;
  }

  async function setWeights(courseId, config) {
    if (config) await chrome.storage.local.set({ [weightsKey(courseId)]: config });
    else await chrome.storage.local.remove(weightsKey(courseId));
  }

  function newCategory() {
    return { id: `c${Math.random().toString(36).slice(2, 8)}`, name: "", keywords: "", weight: 0, average: false, drop: 0 };
  }

  // The assignment ID from its link, else its name.
  function assignmentKey(a) {
    const m = a.url && a.url.match(/\/assignments\/(\d+)/);
    return m ? m[1] : `name:${a.name}`;
  }

  const { singularize, parseSyllabus, dropOf } = globalThis.GradescopePlusSyllabus;

  // Synonyms used when a category's "Matches names with" is empty. Small and fixed on purpose.
  const FAMILIES = [
    ["homework", "hw", "problem set", "pset", "ps", "assignment"],
    ["quiz"],
    ["lab"],
    ["project", "final project"],
    ["midterm", "prelim"],
    ["final", "final exam"],
    ["exam", "test"],
    ["participation", "attendance", "clicker"],
  ];
  const FAMILY_WORDS = FAMILIES.flatMap((words, family) => words.map((word) => ({ word, family }))).sort(
    (x, y) => y.word.length - x.word.length
  );

  // Lowercase, singular words: "Problem Sets" -> "problem set".
  const phrase = (text) => text.toLowerCase().trim().split(/\s+/).map(singularize).join(" ");

  // Where `word` sits in `name` as whole words (a plural ending is fine: "exam" in "Exams 2"), or -1.
  // Keeps "le" out of "Problem" and "ps" out of "Psych".
  function wordIndex(name, word) {
    for (let i = name.indexOf(word); i >= 0; i = name.indexOf(word, i + 1)) {
      if (i > 0 && /[a-z]/.test(name[i - 1])) continue;
      if (/^(?:s|es|zes)?(?![a-z])/.test(name.slice(i + word.length))) return i;
    }
    return -1;
  }

  // Families named in `text`, earliest first. Longer phrases are taken first, so "Final Project" is a
  // project and not also a final.
  function familiesIn(text) {
    let rest = text.toLowerCase();
    const found = [];
    for (const { word, family } of FAMILY_WORDS) {
      const i = wordIndex(rest, word);
      if (i < 0) continue;
      if (!found.some((f) => f.family === family)) found.push({ family, i, length: word.length });
      rest = rest.slice(0, i) + " ".repeat(word.length) + rest.slice(i + word.length);
    }
    return found.sort((x, y) => x.i - y.i);
  }

  // The words a category matches: what the user typed, or else its name plus that name's synonyms.
  function matchWords(c) {
    return matchTerms(c).map((t) => t.word);
  }

  // Same, with `own` marking words the user typed or the category's own name (not synonyms).
  function matchTerms(c) {
    if (c.keywords.trim()) {
      return [...new Set(c.keywords.split(",").map(phrase).filter(Boolean))].map((word) => ({ word, own: true }));
    }
    const own = phrase(c.name);
    if (!own) return [];
    const synonyms = familiesIn(c.name).flatMap((f) => FAMILIES[f.family]).filter((w) => w !== own);
    return [{ word: own, own: true }, ...[...new Set(synonyms)].map((word) => ({ word, own: false }))];
  }

  // The category whose word starts earliest in the name, so "Final Exam" goes to "final" rather than
  // "exam". Ties go to the longer phrase ("Final Project Proposal" is a project, not a final), then to
  // a category's own words over synonyms ("Final Project" beats "Projects").
  // Returns { id, i, length } for highlighting, or null.
  function autoMatch(a, config) {
    const name = a.name.toLowerCase();
    let best = null;
    for (const c of config.categories) {
      for (const { word, own } of matchTerms(c)) {
        const i = wordIndex(name, word);
        if (i < 0) continue;
        const better =
          !best ||
          i < best.i ||
          (i === best.i && word.length > best.length) ||
          (i === best.i && word.length === best.length && own && !best.own);
        if (better) best = { id: c.id, i, length: word.length, own };
      }
    }
    return best;
  }

  function autoCategoryOf(a, config) {
    return autoMatch(a, config)?.id ?? null;
  }

  // Trailing words that number an item rather than name its kind: "Problem Set Week 3", "LE3-Attempt 2".
  const FILLER = new Set(["week", "part", "no", "attempt", "version", "#"]);

  // Names grouped by the words before their first number: "Problem Set 3", "HW2 - Auth", "LE3-Attempt 1".
  function prefixGroups(assignments, minCount) {
    const groups = new Map();
    for (const a of assignments) {
      const m = a.name.match(/^\s*([a-z][a-z\s&'#-]*?)[\s_#:-]*\d/i);
      if (!m) continue;
      const words = m[1].trim().split(/\s+/);
      while (words.length > 1 && FILLER.has(words[words.length - 1].toLowerCase())) words.pop();
      const prefix = words.join(" ");
      const key = phrase(prefix);
      if (!groups.has(key)) groups.set(key, { key, prefix, count: 0 });
      groups.get(key).count++;
    }
    return [...groups.values()].filter((g) => g.count >= minCount).sort((x, y) => y.count - x.count);
  }

  // "MIDTERM EXAM" -> "Midterm Exam", "final" -> "Final"; short codes like "HW" stay as they are.
  function displayName(text) {
    const t = text.trim();
    if (t.length > 3 && t === t.toUpperCase()) return t.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // First-run categories: shared name prefixes, then syllabus words that appear even once ("Final").
  // A prefix that is a known kind of work keeps the course's own wording and matches its synonyms too.
  function suggestCategories(assignments) {
    const suggestions = [];
    const covered = new Set();
    for (const g of prefixGroups(assignments, 2)) {
      const families = familiesIn(g.prefix);
      families.forEach((f) => covered.add(f.family));
      suggestions.push({ ...newCategory(), name: displayName(g.prefix), keywords: families.length ? "" : g.prefix });
    }
    for (const a of assignments) {
      const first = familiesIn(a.name)[0];
      if (!first || covered.has(first.family)) continue;
      covered.add(first.family);
      suggestions.push({ ...newCategory(), name: displayName(a.name.substr(first.i, first.length)), keywords: "" });
    }
    return suggestions;
  }

  // Turns parsed syllabus lines into categories, pointing each at the assignments it names:
  // "Problem Sets" <-> "Problem Set 1..9", "Learning Exercises (LE)" or its initials <-> "LE3-Attempt 1".
  // A category with the same name as an existing one keeps its id, so manual picks carry over.
  function categoriesFromSyllabus(items, assignments, existing) {
    const groups = prefixGroups(assignments, 1);
    const tokens = (text) => new Set(phrase(text.replace(/\d+/g, " ")).split(" ").filter(Boolean));
    const same = (x, y) => x.size === y.size && [...x].every((t) => y.has(t));
    const within = (x, y) => [...x].every((t) => y.has(t)) || [...y].every((t) => x.has(t));
    const claimed = new Set();
    const groupFor = (item) => {
      const mine = tokens(item.name);
      for (const test of [same, within]) {
        const g = groups.find((g) => !claimed.has(g.key) && mine.size && test(tokens(g.prefix), mine));
        if (g) return g;
      }
      return null;
    };

    return items.map((item) => {
      const reused = existing.find((c) => phrase(c.name) === phrase(item.name));
      const category = {
        ...newCategory(),
        ...(reused && { id: reused.id, keywords: reused.keywords, average: reused.average }),
        name: displayName(item.name),
        weight: item.weight,
        drop: item.drop || 0,
      };
      const words = [...item.keywords];
      const g = groupFor(item);
      if (g) {
        claimed.add(g.key);
        words.push(g.prefix);
      }
      // Course codes: "Learning Exercises" -> LE by initials, "Evaluations" -> EV by its first letters.
      const initials = item.name.split(/\s+/).map((w) => w[0]).join("").toUpperCase();
      const code = groups.find(
        (g) =>
          !claimed.has(g.key) &&
          /^[A-Z]{2,4}$/.test(g.prefix) &&
          ((initials.length >= 2 && g.prefix === initials) || item.name.toUpperCase().startsWith(g.prefix))
      );
      if (code && !item.keywords.includes(code.prefix)) {
        claimed.add(code.key);
        words.push(code.prefix);
      }

      // Only spell out words the name and its synonyms wouldn't already match.
      const implicit = matchWords({ name: item.name, keywords: "" });
      const extra = [...new Set(words)].filter((w) => !implicit.includes(phrase(w)));
      if (extra.length && !category.keywords) category.keywords = extra.join(", ");
      return category;
    });
  }

  const CATEGORY_COLORS = ["#5b2a86", "#1f77b4", "#2a9d8f", "#e76f51", "#c9a227", "#d6457a", "#4a6fa5", "#7a8b2e"];

  function categoryDot(config, id) {
    const dot = el("span", "gsnd-dot");
    const i = config.categories.findIndex((c) => c.id === id);
    if (i >= 0) dot.style.background = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
    return dot;
  }

  // A manual override wins over keyword matching. null means the assignment is not counted.
  function categoryOf(a, config) {
    const override = config.overrides[assignmentKey(a)];
    if (override === "none") return null;
    if (config.categories.some((c) => c.id === override)) return override;
    return autoCategoryOf(a, config);
  }

  function hasWeights(config) {
    return !!config && config.categories.some((c) => c.weight > 0);
  }

  // Weighted average over categories that have graded work, so an ungraded final doesn't count as 0.
  function weightedSummary(assignments, config) {
    const groups = config.categories.map((category) => ({ category, items: [] }));
    const uncounted = [];
    for (const a of gradeSummary(assignments).graded) {
      const id = categoryOf(a, config);
      const group = groups.find((g) => g.category.id === id);
      (group ? group.items : uncounted).push(a);
    }

    let total = 0;
    let weightUsed = 0;
    let weightTotal = 0;
    for (const g of groups) {
      weightTotal += g.category.weight > 0 ? g.category.weight : 0;
      // The lowest scores so far are dropped, as Canvas does, keeping at least one.
      const drop = Math.min(g.category.drop || 0, g.items.length - 1);
      g.dropped = new Set(drop > 0 ? [...g.items].sort((x, y) => x.earned / x.possible - y.earned / y.possible).slice(0, drop) : []);
      const counted = g.items.filter((a) => !g.dropped.has(a));
      g.earned = counted.reduce((s, a) => s + a.earned, 0);
      g.possible = counted.reduce((s, a) => s + a.possible, 0);
      if (!counted.length) g.percent = null;
      else if (g.category.average) g.percent = counted.reduce((s, a) => s + (a.earned / a.possible) * 100, 0) / counted.length;
      else g.percent = (g.earned / g.possible) * 100;
      if (g.percent != null && g.category.weight > 0) {
        total += g.percent * g.category.weight;
        weightUsed += g.category.weight;
      }
    }
    return { groups, uncounted, weightUsed, weightTotal, percent: weightUsed > 0 ? total / weightUsed : null };
  }

  function currentPercent({ assignments, weights }) {
    return hasWeights(weights) ? weightedSummary(assignments, weights).percent : gradeSummary(assignments).percent;
  }

  // Drops blank rows and overrides that point at removed categories or assignments.
  function cleanWeights(draft, assignments) {
    const categories = draft.categories
      .filter((c) => c.name.trim() || c.keywords.trim() || c.weight > 0)
      .map((c, i) => ({
        id: c.id,
        name: c.name.trim() || `Category ${i + 1}`,
        keywords: c.keywords.trim(),
        weight: c.weight > 0 ? c.weight : 0,
        average: !!c.average,
        drop: c.drop > 0 ? Math.floor(c.drop) : 0,
      }));
    if (!categories.length) return null;
    const ids = new Set(categories.map((c) => c.id));
    const keys = new Set(assignments.map(assignmentKey));
    const overrides = Object.fromEntries(
      Object.entries(draft.overrides).filter(([key, id]) => keys.has(key) && (id === "none" || ids.has(id)))
    );
    return { categories, overrides };
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

    const percent = currentPercent(state);
    img.src = chrome.runtime.getURL(`images/${imageForGrade(percent)}`);
    if (percent == null) img.title = "No graded assignments yet";
    else img.title = hasWeights(state.weights) ? `${formatPercent(percent)} (weighted)` : formatPercent(percent);
  }

  function button(cls, text, onClick) {
    const node = el("button", cls, text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function input(type, value, label, placeholder) {
    const node = document.createElement("input");
    node.type = type;
    node.value = value;
    node.setAttribute("aria-label", label);
    if (placeholder) node.placeholder = placeholder;
    return node;
  }

  function openGradeModal(box) {
    const courseId = courseIdOf(box);
    const state = cardState.get(courseId);

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
    const body = el("div");
    modal.append(header, body);

    let editor = null; // { leave(then) } while the weights editor is open
    const showGrade = () => {
      editor = null;
      modal.classList.remove("gsnd-modal--wide");
      modal.scrollTop = 0;
      body.replaceChildren();
      renderGradeView(body, state, showEditor);
    };
    const showEditor = () => {
      modal.classList.add("gsnd-modal--wide");
      modal.scrollTop = 0;
      body.replaceChildren();
      editor = renderWeightsEditor(body, courseId, state, showGrade);
    };
    showGrade();

    overlay.append(modal);
    document.body.append(overlay);

    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      box.querySelector(".gsnd-gradeBtn")?.focus();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        // While editing, Escape backs out to the grade view (asking first if there are unsaved changes).
        if (editor) editor.escape();
        else close();
      } else if (e.key === "Tab") {
        trapFocus(modal, e);
      }
    };
    // A stray click outside shouldn't throw away unsaved weights.
    overlay.addEventListener("click", (e) => e.target === overlay && !editor && close());
    closeBtn.addEventListener("click", () => (editor ? editor.leave(close) : close()));
    document.addEventListener("keydown", onKey);
    closeBtn.focus();
  }

  // "Total 60% · 40% left", neutral until it goes over; green at exactly 100. Returns sum - 100.
  function showTotal(node, sum) {
    const diff = Math.round((sum - 100) * 1000) / 1000;
    node.classList.toggle("gsnd-warn", diff > 0);
    node.classList.toggle("gsnd-ok", diff === 0);
    if (diff === 0) node.textContent = "Total 100% ✓";
    else if (diff > 0) node.textContent = `Total ${fmtNum(sum)}% · ${fmtNum(diff)}% over`;
    else node.textContent = `Total ${fmtNum(sum)}% · ${fmtNum(-diff)}% left`;
    return diff;
  }

  function trapFocus(container, e) {
    const focusable = [...container.querySelectorAll("a[href], button, input, select, textarea")].filter(
      (node) => !node.disabled && node.offsetParent !== null
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function renderGradeView(body, state, onEditWeights) {
    const { assignments, error, weights } = state;
    if (!assignments) {
      body.append(el("p", null, error ? `Couldn't load grades: ${error}` : "Still loading…"));
      return;
    }

    const points = gradeSummary(assignments);
    const weighted = hasWeights(weights) ? weightedSummary(assignments, weights) : null;
    const editBtn = button("gsnd-btn", weighted ? "Edit weights" : "Set category weights", onEditWeights);
    if (!points.graded.length) {
      body.append(el("p", null, "No graded assignments yet."), editBtn);
      return;
    }

    const percent = weighted ? weighted.percent : points.percent;
    let detail;
    if (!weighted) {
      detail = `${fmtNum(points.earned)} / ${fmtNum(points.possible)} points across ${points.graded.length} graded`;
    } else if (percent == null) {
      detail = "No graded work in weighted categories yet";
    } else {
      const coverage = Math.round((weighted.weightUsed / weighted.weightTotal) * 100);
      detail = coverage < 100
        ? `Weighted by your syllabus · based on categories worth ${coverage}% of the grade so far`
        : "Weighted by your syllabus";
      if (weighted.uncounted.length) detail += ` · ${weighted.uncounted.length} not counted`;
    }

    const summary = el("div", "gsnd-summary");
    const img = el("img", "gsnd-summaryImg");
    img.src = chrome.runtime.getURL(`images/${imageForGrade(percent)}`);
    img.alt = "";
    const text = el("div");
    text.append(
      el("div", "gsnd-bigPercent", percent == null ? "—" : formatPercent(percent)),
      el("div", "gsnd-muted", detail)
    );
    if (weighted) text.append(el("div", "gsnd-muted", `By total points: ${formatPercent(points.percent)}`));
    text.append(editBtn);
    summary.append(img, text);
    body.append(summary);

    const table = el("table", "gsnd-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Assignment", "Score", "%"].forEach((h) => hr.append(el("th", null, h)));
    thead.append(hr);
    const tbody = el("tbody");

    const assignmentRow = (a, nested, dropped) => {
      const tr = el("tr", dropped ? "gsnd-dropped" : null);
      const nameTd = el("td", nested ? "gsnd-nested" : null);
      if (a.url) {
        const link = el("a", null, a.name);
        link.href = a.url;
        nameTd.append(link);
      } else {
        nameTd.textContent = a.name;
      }
      if (dropped) nameTd.append(el("span", "gsnd-tag", "dropped"));
      tr.append(
        nameTd,
        el("td", "gsnd-num", `${fmtNum(a.earned)} / ${fmtNum(a.possible)}`),
        el("td", "gsnd-num", formatPercent((a.earned / a.possible) * 100))
      );
      return tr;
    };
    const groupRow = (id, label, score, pct) => {
      const tr = el("tr", "gsnd-groupRow");
      const name = el("td");
      name.append(categoryDot(weights, id), label);
      tr.append(name, el("td", "gsnd-num", score), el("td", "gsnd-num", pct));
      return tr;
    };

    if (weighted) {
      for (const g of weighted.groups) {
        if (!g.items.length && !(g.category.weight > 0)) continue;
        let score = "not graded yet";
        if (g.items.length) {
          const counted = g.items.length - g.dropped.size;
          score = g.category.average ? `each equal (${counted})` : `${fmtNum(g.earned)} / ${fmtNum(g.possible)}`;
        }
        const pct = g.percent == null ? "" : formatPercent(g.percent);
        const drops = g.category.drop > 0 ? ` · drops lowest ${g.category.drop}` : "";
        tbody.append(groupRow(g.category.id, `${g.category.name} · ${fmtNum(g.category.weight)}%${drops}`, score, pct));
        g.items.forEach((a) => tbody.append(assignmentRow(a, true, g.dropped.has(a))));
      }
      if (weighted.uncounted.length) {
        tbody.append(groupRow(null, "Not counted", "", ""));
        weighted.uncounted.forEach((a) => tbody.append(assignmentRow(a, true)));
      }
    } else {
      points.graded.forEach((a) => tbody.append(assignmentRow(a, false)));
    }
    table.append(thead, tbody);
    body.append(table);
  }

  function renderWeightsEditor(body, courseId, state, done) {
    const assignments = state.assignments;
    const draft = state.weights
      ? structuredClone(state.weights)
      : { categories: suggestCategories(assignments), overrides: {} };
    const suggested = !state.weights && draft.categories.length > 0;
    if (!draft.categories.length) draft.categories.push(newCategory());
    const initial = JSON.stringify(draft);
    const labelOf = (c) => c.name.trim() || `Category ${draft.categories.indexOf(c) + 1}`;
    const nowPercent = currentPercent(state);

    const pasteLink = button("gsnd-linkBtn", "Paste from syllabus", () => openPaste());
    const stepHead = el("div", "gsnd-stepHead");
    stepHead.append(el("h4", "gsnd-step", "1. Enter weights from your syllabus"), pasteLink);
    const callout = el("div", "gsnd-callout");
    callout.append(
      el("span", null, "Quickest way: paste the grading section of your syllabus."),
      button("gsnd-btn", "Paste from syllabus", () => openPaste())
    );
    callout.hidden = !!state.weights;
    pasteLink.hidden = !callout.hidden; // one way in at a time
    const banner = el("div", "gsnd-banner");
    banner.hidden = true;
    const step1 = el("div");
    const pastePanel = el("div", "gsnd-paste");
    pastePanel.hidden = true;
    body.append(
      el(
        "p",
        "gsnd-intro",
        "Gradescope only adds up points. If your syllabus weights categories (like Homework 40%, " +
          "Exams 60%), enter them here."
      ),
      stepHead,
      callout,
      banner,
      step1,
      pastePanel
    );

    // Step 1: categories
    const cats = el("div", "gsnd-cats");
    const catHead = el("div", "gsnd-catHead");
    ["Category", "Matches names with", "Weight", "Drop lowest", "Counts by", ""].forEach((h) => catHead.append(el("span", null, h)));
    const catRows = el("div");
    cats.append(catHead, catRows);

    const option = (value, text) => {
      const node = el("option", null, text);
      node.value = value;
      return node;
    };

    // With "Matches names with" empty, its placeholder lists exactly the words used: name plus synonyms.
    const wordsHint = (c) => matchWords({ name: c.name, keywords: "" }).join(", ") || "hw, homework";

    const categoryRow = (c) => {
      const row = el("div", "gsnd-cat");
      const keywords = input("text", c.keywords, "", wordsHint(c));
      keywords.addEventListener("input", () => {
        c.keywords = keywords.value;
        update();
      });
      const name = input("text", c.name, "", "Homework");
      const weight = input("text", c.weight ? String(c.weight) : "", "");
      weight.inputMode = "decimal";
      const drop = input("text", c.drop ? String(c.drop) : "", "", "0");
      drop.inputMode = "numeric";
      drop.className = "gsnd-dropInput";
      const countsBy = document.createElement("select");
      countsBy.append(option("points", "points"), option("equal", "each equal"));
      countsBy.value = c.average ? "equal" : "points";
      const remove = button("gsnd-iconBtn", "×", () => {
        draft.categories = draft.categories.filter((x) => x !== c);
        renderCategories();
      });

      const setLabels = () => {
        const label = labelOf(c);
        name.setAttribute("aria-label", `Name for category ${draft.categories.indexOf(c) + 1}`);
        keywords.setAttribute("aria-label", `Words that put an assignment in ${label}`);
        weight.setAttribute("aria-label", `Weight for ${label}, in percent`);
        drop.setAttribute("aria-label", `How many of the lowest ${label} scores are dropped`);
        countsBy.setAttribute("aria-label", `How ${label} counts`);
        remove.setAttribute("aria-label", `Remove ${label}`);
      };
      setLabels();

      name.addEventListener("input", () => {
        c.name = name.value;
        keywords.placeholder = wordsHint(c);
        setLabels();
        update();
      });
      weight.addEventListener("input", () => {
        c.weight = Math.max(0, parseFloat(weight.value) || 0);
        update();
      });
      drop.addEventListener("input", () => {
        c.drop = Math.max(0, Math.floor(parseFloat(drop.value) || 0));
        update();
      });
      countsBy.addEventListener("change", () => {
        c.average = countsBy.value === "equal";
        update();
      });

      const nameWrap = el("span", "gsnd-nameInput");
      nameWrap.append(categoryDot(draft, c.id), name);
      const weightWrap = el("span", "gsnd-weightInput");
      weightWrap.append(weight, el("span", null, "%"));
      row.append(nameWrap, keywords, weightWrap, drop, countsBy, remove);
      return row;
    };
    const renderCategories = () => {
      catRows.replaceChildren(...draft.categories.map(categoryRow));
      update();
    };

    const total = el("div", "gsnd-total");
    const addBtn = button("gsnd-btn", "+ Add category", () => {
      draft.categories.push(newCategory());
      renderCategories();
      catRows.lastElementChild.querySelector("input").focus();
    });
    const catFooter = el("div", "gsnd-row");
    catFooter.append(addBtn, total);
    step1.append(
      cats,
      catFooter,
      el(
        "p",
        "gsnd-hint",
        "New assignments are sorted automatically by these words; the earliest word in a name wins. " +
          "“Drop lowest” leaves out that many of the lowest scores so far, keeping at least one. " +
          "“Each equal” makes every assignment count the same, whatever its points."
      )
    );
    const sortSummary = el("p", "gsnd-muted gsnd-sortSummary");
    // Step 2 and the footer describe the categories in the table, so they step aside while a paste is
    // previewed; the paste panel shows what its categories would find and has its own buttons.
    const step2 = el("div", "gsnd-step2");
    step2.append(el("h4", "gsnd-step", "2. Check where each assignment goes"), sortSummary);
    body.append(step2);

    // Step 2: assignments, grouped live by category. "Not counted" comes first because it needs attention.
    const assignList = el("div", "gsnd-assignList");
    const live = el("div", "gsnd-srOnly");
    live.setAttribute("aria-live", "polite");
    step2.append(assignList);
    body.append(live);

    const openGroups = new Map(); // group id ("none" for Not counted) -> expanded; set when first shown
    const groupKey = (id) => id || "none";

    // Points an assignment at a category, storing an override only when it differs from name matching.
    const assign = (a, id) => {
      const key = assignmentKey(a);
      if (id === autoCategoryOf(a, draft)) delete draft.overrides[key];
      else draft.overrides[key] = id || "none";
    };
    // Moving every unsorted assignment that shares a name ("Prelab 6", "Prelab 7") into a category adds
    // that name to the category's words, so the next one is sorted too. Returns the name, or null.
    const learnName = (items, to) => {
      const c = draft.categories.find((x) => x.id === to);
      const shared = items.length >= 2 && prefixGroups(items, items.length)[0];
      if (!c || !shared || matchWords(c).includes(phrase(shared.prefix))) return null;
      c.keywords = [...matchWords(c), shared.prefix.toLowerCase()].join(", ");
      const field = catRows.children[draft.categories.indexOf(c)]?.querySelectorAll("input")[1];
      if (field) field.value = c.keywords;
      return shared.prefix;
    };
    const groupName = (id) => {
      const c = draft.categories.find((x) => x.id === id);
      return c ? labelOf(c) : "Not counted";
    };

    const nameWithMatch = (a) => {
      const span = el("span", "gsnd-assignName");
      const match = !(assignmentKey(a) in draft.overrides) && autoMatch(a, draft);
      if (match) {
        span.append(
          a.name.slice(0, match.i),
          el("strong", null, a.name.slice(match.i, match.i + match.length)),
          a.name.slice(match.i + match.length)
        );
      } else {
        span.textContent = a.name;
      }
      if (a.possible == null) span.append(el("span", "gsnd-tag", "not graded"));
      return span;
    };

    const assignmentRow = (a, id) => {
      const key = assignmentKey(a);
      const row = el("div", "gsnd-assignRow");
      row.dataset.key = key;

      const select = document.createElement("select");
      select.setAttribute("aria-label", `Category for ${a.name}`);
      select.append(...draft.categories.map((c) => option(c.id, labelOf(c))), option("none", "Not counted"));
      select.value = id || "none";
      select.addEventListener("change", () => {
        const to = select.value === "none" ? null : select.value;
        assign(a, to);
        update({ from: id, index: [...row.parentNode.children].indexOf(row), to, message: `Moved ${a.name} to ${groupName(to)}` });
      });

      const auto = button("gsnd-linkBtn", "auto", () => {
        delete draft.overrides[key];
        const to = autoCategoryOf(a, draft);
        update({ from: id, index: [...row.parentNode.children].indexOf(row), to, message: `${a.name} is sorted by name again` });
      });
      auto.title = "Sort by name again";
      auto.setAttribute("aria-label", `Sort ${a.name} by name again`);
      auto.hidden = !(key in draft.overrides);

      row.append(nameWithMatch(a), select, auto);
      return row;
    };

    const groupSection = (id, items) => {
      const c = draft.categories.find((x) => x.id === id);
      const gk = groupKey(id);
      if (!openGroups.has(gk)) {
        // Groups that were sorted by name start collapsed; anything set by hand or not counted starts open.
        openGroups.set(gk, !c || items.some((a) => assignmentKey(a) in draft.overrides));
      }
      const open = items.length > 0 && openGroups.get(gk);

      const section = el("div", "gsnd-group");
      section.dataset.group = gk;
      const head = el("div", "gsnd-groupHead");
      const toggle = el("button", "gsnd-toggle");
      toggle.type = "button";
      toggle.disabled = !items.length;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.append(
        el("span", "gsnd-chevron", items.length ? (open ? "▾" : "▸") : ""),
        categoryDot(draft, id),
        el("span", "gsnd-groupName", c ? labelOf(c) : "Not counted"),
        el("span", "gsnd-count", items.length ? String(items.length) : "none yet")
      );
      let note = "";
      if (!c) note = "pick a category, or leave them out";
      else if (c.weight > 0) note = `${fmtNum(c.weight)}%${c.drop > 0 ? ` · drops lowest ${c.drop}` : ""}`;
      else if (items.length) note = "no weight · not counted";
      if (note) toggle.append(el("span", "gsnd-muted", note));
      toggle.addEventListener("click", () => {
        openGroups.set(gk, !open);
        renderAssignments();
        assignList.querySelector(`[data-group="${gk}"] .gsnd-toggle`).focus();
      });
      head.append(toggle);

      if (items.length) {
        const moveAll = document.createElement("select");
        moveAll.className = "gsnd-moveAll";
        // Shows where the whole group is, like each row's select, in the same column; changing it moves them all.
        moveAll.setAttribute("aria-label", `Category for all ${items.length} in ${groupName(id)}`);
        moveAll.title = "Change to move all of them";
        draft.categories.forEach((x) => moveAll.append(option(x.id, labelOf(x))));
        moveAll.append(option("none", "Not counted"));
        moveAll.value = c ? c.id : "none";
        moveAll.addEventListener("change", () => {
          const to = moveAll.value === "none" ? null : moveAll.value;
          const learned = c ? null : learnName(items, to);
          items.forEach((a) => assign(a, to));
          const message = `Moved ${items.length} to ${groupName(to)}`;
          update({ to, focusGroup: true, message: learned ? `${message}. New “${learned}” assignments will go there too.` : message });
        });
        head.append(moveAll);
      }
      section.append(head);

      if (open) {
        const rows = el("div", "gsnd-groupBody");
        items.forEach((a) => rows.append(assignmentRow(a, id)));
        section.append(rows);
      }
      return section;
    };

    // `moved` keeps the user's place after a reassignment: focus stays in the group the row left.
    const renderAssignments = (moved) => {
      const groups = new Map([[null, []], ...draft.categories.map((c) => [c.id, []])]);
      for (const a of assignments) groups.get(categoryOf(a, draft)).push(a);

      let byHand = 0;
      let byName = 0;
      for (const a of assignments) {
        const override = draft.overrides[assignmentKey(a)];
        if (override === "none" || draft.categories.some((c) => c.id === override)) byHand++;
        else if (autoCategoryOf(a, draft)) byName++;
      }
      const unsorted = groups.get(null).length;
      sortSummary.textContent =
        `${byName} of ${assignments.length} sorted by name` +
        (byHand ? ` · ${byHand} set by hand` : "") +
        (unsorted ? ` · ${unsorted} not counted` : "");

      assignList.replaceChildren();
      for (const [id, items] of groups) {
        if (id === null && !items.length) continue;
        assignList.append(groupSection(id, items));
      }
      if (!moved) return;

      const sectionOf = (id) => assignList.querySelector(`[data-group="${groupKey(id)}"]`);
      const count = sectionOf(moved.to)?.querySelector(".gsnd-count");
      if (count) count.classList.add("gsnd-pulse");
      live.textContent = moved.message;

      if (moved.focusGroup) {
        sectionOf(moved.to)?.querySelector(".gsnd-toggle").focus();
        return;
      }
      const source = sectionOf(moved.from);
      const rows = source ? [...source.querySelectorAll(".gsnd-assignRow")] : [];
      const next = rows[Math.min(moved.index, rows.length - 1)];
      const sourceToggle = source?.querySelector(".gsnd-toggle:not(:disabled)");
      if (next) next.querySelector("select").focus();
      else if (sourceToggle) sourceToggle.focus();
      else assignList.querySelector(".gsnd-toggle:not(:disabled)")?.focus();
    };

    const preview = el("div", "gsnd-preview");
    const note = el("div", "gsnd-muted");
    const status = el("div", "gsnd-warn");

    function update(moved) {
      const sum = draft.categories.reduce((s, c) => s + (c.weight || 0), 0);
      const diff = showTotal(total, sum);

      renderAssignments(moved);

      const p = hasWeights(draft) ? weightedSummary(assignments, draft).percent : null;
      const now = nowPercent == null ? "—" : formatPercent(nowPercent);
      preview.textContent = p == null ? "Enter a weight to see your grade" : `Now ${now} → ${formatPercent(p)} with these weights`;
      note.textContent = sum > 0 && diff !== 0 ? "Weights that don't add up to 100% are scaled to 100%." : "";
    }

    // Paste from syllabus: replaces the category table in place while open.
    const pasteBox = document.createElement("textarea");
    pasteBox.id = `gsnd-paste-${courseId}`;
    pasteBox.className = "gsnd-pasteBox";
    pasteBox.rows = 6;
    pasteBox.placeholder = "Homework 30% (drop lowest 2)\nMidterm Exams 2 × 15% = 30%\nFinal Exam 35%\nParticipation 5%";
    const pasteLabel = el("label", "gsnd-pasteLabel", "Paste the grading section of your syllabus");
    pasteLabel.htmlFor = pasteBox.id;
    const pastePreview = el("div", "gsnd-pastePreview");
    pastePreview.setAttribute("aria-live", "polite");
    const useBtn = button("gsnd-btn gsnd-primary", "", () => applyPaste());
    const pasteActions = el("div", "gsnd-row gsnd-actions");
    pasteActions.append(button("gsnd-btn", "Cancel", () => closePaste()), useBtn);

    // For a syllabus too messy to read: a prompt the reader takes to an AI chat of their own, whose
    // reply comes back in lines this reader takes as they are. Nothing is sent from here.
    const aiPrompt = () => {
      const names = [...new Set(assignments.map((a) => a.name))].slice(0, 40);
      return [
        "Read the course syllabus I paste below and write out how the final grade is weighted.",
        "",
        "Reply with only one code block, one line per graded category, in this format:",
        "Category name: weight%",
        "If the syllabus drops the lowest N scores in a category, add (drop lowest N) after the weight. " +
          "Write “best N of M” as (drop lowest M-N).",
        "",
        "Rules:",
        "- Use only weights the syllabus states. They should add up to 100%.",
        "- If a category is split into parts with their own weights (for example Exams 50% = Midterm 20% + " +
          "Final 30%), list each part on its own line instead.",
        "- Leave out extra credit, the letter-grade scale, and policies that are not weighted categories.",
        "- If there is more than one grading scheme, use the default one.",
        ...(names.length ? [`- Where you can, name categories to match these Gradescope assignments: ${names.join(", ")}`] : []),
        "",
        "Example:",
        "Homework: 30% (drop lowest 2)",
        "Midterm Exam: 25%",
        "Final Exam: 35%",
        "Participation: 10%",
        "",
        "Syllabus:",
        "",
      ].join("\n");
    };
    const aiHint = el("p", "gsnd-hint gsnd-aiHint");
    const copyBtn = button("gsnd-linkBtn", "Copy a prompt for an AI chat", async () => {
      const prompt = aiPrompt();
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        // No clipboard access: show the prompt to copy by hand.
        const box = el("textarea", "gsnd-aiPrompt");
        box.readOnly = true;
        box.rows = 6;
        box.value = prompt;
        box.setAttribute("aria-label", "Prompt for an AI chat");
        aiHint.replaceChildren("Copy this prompt (it's selected), paste it into ChatGPT, Claude or another AI chat with your syllabus, and paste the reply below.");
        aiHint.after(box);
        box.select();
        return;
      }
      copyBtn.textContent = "Prompt copied";
      live.textContent = "Prompt copied";
      setTimeout(() => (copyBtn.textContent = "Copy a prompt for an AI chat"), 2500);
    });
    aiHint.append("Messy syllabus? ", copyBtn, ", paste it into ChatGPT, Claude or another AI chat with your syllabus, and paste the reply here.");
    pastePanel.append(
      pasteLabel,
      aiHint,
      pasteBox,
      el("p", "gsnd-hint", "Read on your computer only. Lines without a % or points are skipped."),
      pastePreview,
      pasteActions
    );

    let pasted = []; // categories the current paste would create
    let pasteTimer;
    // The clipboard's HTML copy keeps tables intact. It describes the box only while the box holds
    // exactly one paste, so typing or a partial paste drops it.
    let pastedHtml = null;
    let pastePick = null; // a table the reader chose over the best guess
    // Rows the reader ticked or unticked, and categories split into their parts, by name.
    const pasteFlip = new Set();
    const pasteSplit = new Set();
    const resetPasteEdits = () => {
      pastePick = null;
      pasteFlip.clear();
      pasteSplit.clear();
    };
    pasteBox.addEventListener("paste", (e) => {
      resetPasteEdits();
      const whole = pasteBox.selectionStart === 0 && pasteBox.selectionEnd === pasteBox.value.length;
      pastedHtml = whole ? e.clipboardData?.getData("text/html") || null : null;
    });
    pasteBox.addEventListener("input", (e) => {
      if (e.inputType !== "insertFromPaste") pastedHtml = null;
      resetPasteEdits();
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(renderPastePreview, 150);
    });

    function renderPastePreview() {
      // The course's assignment names tell the parser which words name graded work here.
      const parsed = parseSyllabus(pasteBox.value, pastedHtml, pastePick, { known: assignments.map((a) => a.name) });
      // Each row has a key that stays the same when other rows are split or ticked.
      const rows = parsed.items.flatMap((item) =>
        item.parts && pasteSplit.has(item.name)
          ? item.parts.map((p) => ({ name: p.name, weight: p.weight, keywords: [], warnings: [], notes: [], partOf: item.name, key: `${item.name}/${p.name}` }))
          : [{ ...item, key: item.name }]
      );
      // Rows next to the breakdown that may belong to it start unticked.
      rows.push(...parsed.offered.map((item) => ({ ...item, warnings: [], notes: [], offered: true, key: `+${item.name}` })));
      const kept = rows.filter((item) => !item.offered !== pasteFlip.has(item.key));
      pasted = categoriesFromSyllabus(kept, assignments, draft.categories);
      useBtn.disabled = !pasted.length;
      useBtn.textContent = !pasted.length
        ? "Nothing found yet"
        : `Use ${pasted.length === 1 ? "this category" : `these ${pasted.length} categories`}`;
      pastePreview.replaceChildren();
      if (!pasteBox.value.trim()) return;

      if (parsed.unsure.length && rows.length) {
        const reasons = parsed.unsure.join("; ");
        pastePreview.append(el("p", "gsnd-pasteCheck", `Check this against the syllabus: ${reasons}.`));
      }
      // Where the rows came from, next to the doubts and above the rows, since that choice can be wrong.
      const { source } = parsed;
      if (pasted.length && source.kind === "lines" && source.section) {
        pastePreview.append(el("p", "gsnd-muted", `Read from the lines under “${source.section}”. Everything else was ignored.`));
      }
      if (pasted.length && source.kind === "table") {
        const cols = [source.nameHeader, source.weightHeader].every(Boolean)
          ? ` (names from “${source.nameHeader}”, weights from “${source.weightHeader}”)`
          : "";
        const which = source.count > 1 ? `table ${source.index + 1} of ${source.count}` : "a table";
        pastePreview.append(el("p", "gsnd-muted", `Read from ${which}${cols}. Everything else was ignored.`));
      }
      if (rows.length) {
        const config = { categories: pasted, overrides: draft.overrides };
        const found = new Map(pasted.map((c) => [c.id, []]));
        for (const a of assignments) found.get(categoryOf(a, config))?.push(a);

        const table = el("table", "gsnd-table gsnd-pasteTable");
        const head = el("tr");
        ["Category", "Weight", "Assignments found"].forEach((h) => head.append(el("th", null, h)));
        const thead = el("thead");
        thead.append(head);
        const tbody = el("tbody");
        // "12 · HW 1, HW 2, …" on one line; the whole list on hover. null means the row is left out.
        const foundCell = (list) => {
          if (!list) return el("td", "gsnd-pasteFound gsnd-muted", "left out");
          if (!list.length) return el("td", "gsnd-pasteFound gsnd-muted", "none yet");
          const td = el("td", "gsnd-pasteFound", `${list.length} · ${list.map((a) => a.name).join(", ")}`);
          td.title = list.map((a) => a.name).join("\n");
          return td;
        };
        const noteRow = (content, cls) => {
          const tr = el("tr", `gsnd-pasteNote${cls ? ` ${cls}` : ""}`);
          const td = el("td");
          td.colSpan = 3;
          td.append(...[content].flat());
          tr.append(td);
          tbody.append(tr);
        };
        const toggle = (set, key) => {
          set.has(key) ? set.delete(key) : set.add(key);
          renderPastePreview();
        };
        rows.forEach((item) => {
          const on = kept.includes(item);
          const category = on ? pasted[kept.indexOf(item)] : null;
          const list = on ? found.get(category.id) : [];
          const name = category?.name ?? displayName(item.name);
          const box = el("input");
          box.type = "checkbox";
          box.checked = on;
          box.setAttribute("aria-label", `Use ${name}`);
          box.addEventListener("change", () => {
            toggle(pasteFlip, item.key);
            pastePreview.querySelector(`input[aria-label="Use ${CSS.escape(name)}"]`)?.focus();
          });
          const label = el("label", "gsnd-pasteName");
          label.append(box, name);
          const tr = el("tr", on ? null : "gsnd-off");
          const nameTd = el("td");
          nameTd.append(label);
          // The drop rule sits under the name, with the syllabus's words on hover.
          const dropNote = on && item.drop ? item.notes.find((n) => dropOf(n) === item.drop) : null;
          if (on && item.drop) {
            const sub = el("div", "gsnd-pasteSub", `drops ${lowest(item.drop)}`);
            if (dropNote) sub.title = `From the syllabus: “${dropNote}”`;
            nameTd.append(sub);
          }
          tr.append(nameTd, el("td", "gsnd-num", `${fmtNum(item.weight)}%`), foundCell(on ? list : null));
          tbody.append(tr);
          if (!on) return;
          for (const w of item.warnings) noteRow(`⚠ ${w}`);
          for (const n of item.notes) if (n !== dropNote) noteRow(`Not applied: ${n}`, "gsnd-pasteAside");
          if (item.parts) {
            const parts = item.parts.map((p) => `${displayName(p.name)} ${fmtNum(p.weight)}%`).join(", ");
            noteRow([`Made of ${parts}. `, button("gsnd-linkBtn", `Split into ${item.parts.length}`, () => toggle(pasteSplit, item.name))], "gsnd-pasteAside");
          }
          if (item.partOf && item.partOf !== rows[rows.indexOf(item) + 1]?.partOf) {
            noteRow([`Part of ${displayName(item.partOf)}. `, button("gsnd-linkBtn", "Combine", () => toggle(pasteSplit, item.partOf))], "gsnd-pasteAside");
          }
        });
        // What the categories would miss, so it can be fixed before or after using them.
        const missed = assignments.filter((a) => !categoryOf(a, config));
        if (pasted.length && missed.length) {
          const tr = el("tr", "gsnd-missed");
          tr.append(el("td", null, "Not in any category"), el("td"), foundCell(missed));
          tbody.append(tr);
        }
        table.append(thead, tbody);
        const sum = el("div", "gsnd-total");
        showTotal(sum, kept.reduce((s, i) => s + i.weight, 0));
        pastePreview.append(table, sum);
      }
      if (parsed.others.length) {
        const other = el("p", "gsnd-muted gsnd-otherTables", "Other tables with weights: ");
        parsed.others.forEach(({ index, names }, i) => {
          const list = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
          const use = button("gsnd-linkBtn", `table ${index + 1} (${list})`, () => {
            resetPasteEdits();
            pastePick = index;
            renderPastePreview();
            pastePreview.querySelector(".gsnd-pasteTable")?.scrollIntoView({ block: "nearest" });
          });
          other.append(...(i ? [", ", use] : [use]));
        });
        pastePreview.append(other);
      }
      for (const note of parsed.notes) pastePreview.append(el("p", "gsnd-muted", note));
      if (parsed.skipped.length) {
        const clip = (t) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);
        const n = parsed.skipped.length;
        const details = el("details", "gsnd-skipped");
        const list = el("ul");
        for (const s of parsed.skipped.slice(0, 50)) list.append(el("li", null, `“${clip(s.text)}” (${s.reason})`));
        if (n > 50) list.append(el("li", null, `and ${n - 50} more`));
        details.append(el("summary", null, `${n} ${n === 1 ? "line" : "lines"} skipped`), list);
        pastePreview.append(details);
      }
      const current = draft.categories.filter((c) => c.name.trim() || c.keywords.trim() || c.weight > 0);
      if (pasted.length && current.length && !state.weights) {
        pastePreview.append(el("p", "gsnd-muted", "Replaces the suggested categories."));
      } else if (pasted.length && current.length) {
        const kept = pasted.filter((c) => current.some((d) => d.id === c.id)).map((c) => c.name);
        pastePreview.append(
          el(
            "p",
            "gsnd-muted",
            `Replaces your ${current.length === 1 ? "category" : `${current.length} categories`}.` +
              (kept.length ? ` Words and manual picks carry over for ${kept.join(", ")}.` : "")
          )
        );
      }
    }

    const pasteOpen = () => !pastePanel.hidden;
    function openPaste() {
      step1.hidden = true;
      step2.hidden = true;
      footer.hidden = true;
      callout.hidden = true;
      pasteLink.hidden = true;
      pastePanel.hidden = false;
      renderPastePreview();
      pasteBox.focus();
    }
    function closePaste() {
      clearTimeout(pasteTimer);
      pastePanel.hidden = true;
      step1.hidden = false;
      step2.hidden = false;
      footer.hidden = false;
      pasteLink.hidden = false;
      pasteLink.focus();
    }
    function applyPaste() {
      renderPastePreview(); // the debounce may not have caught up with the last keystroke
      if (!pasted.length) return;
      const before = structuredClone({ categories: draft.categories, overrides: draft.overrides });
      draft.categories = pasted;
      openGroups.clear();
      closePaste();
      const undo = button("gsnd-linkBtn", "Undo", () => {
        Object.assign(draft, before);
        openGroups.clear();
        banner.hidden = true;
        renderCategories();
        live.textContent = "Restored your previous categories";
        catRows.querySelector("input").focus();
      });
      banner.replaceChildren(el("span", null, "Filled from your syllabus."), undo);
      banner.hidden = false;
      renderCategories();
      live.textContent = `Added ${pasted.length} categories from your syllabus`;
      catRows.querySelector(".gsnd-weightInput input").focus();
    }

    const save = async (config) => {
      try {
        await setWeights(courseId, config);
      } catch (err) {
        status.textContent = `Couldn't save: ${err.message}`;
        return;
      }
      state.weights = config;
      renderCard(courseId);
      done();
    };

    const actions = el("div", "gsnd-row gsnd-actions");
    const showActions = () => {
      actions.replaceChildren();
      if (state.weights) actions.append(button("gsnd-btn gsnd-danger", "Remove weights", () => save(null)));
      actions.append(
        button("gsnd-btn", "Cancel", () => leave(done)),
        button("gsnd-btn gsnd-primary", "Save", () => save(cleanWeights(draft, assignments)))
      );
    };
    // Leaving with unsaved changes asks first, inside the window rather than with a browser dialog.
    const leave = (then) => {
      if (JSON.stringify(draft) === initial) return then();
      actions.replaceChildren(el("span", "gsnd-confirm", "Discard your changes?"));
      const keep = button("gsnd-btn", "Keep editing", () => {
        showActions();
        actions.querySelector(".gsnd-primary").focus();
      });
      actions.append(keep, button("gsnd-btn gsnd-danger", "Discard", then));
      keep.focus();
    };
    showActions();

    // Sticky footer, so Save stays reachable below a long assignment list.
    const footer = el("div", "gsnd-editorFooter");
    footer.append(preview, note, status, actions);
    body.append(footer);

    renderCategories();
    // Suggested names are usually right, so start where the user still has work to do: the weights.
    catRows.querySelector(suggested ? ".gsnd-weightInput input" : "input").focus();
    // Escape steps back one level: out of the paste panel first, then out of the editor.
    return { leave, escape: () => (pasteOpen() ? closePaste() : leave(done)) };
  }

  const lowest = (n) => (n === 1 ? "lowest score" : `lowest ${n} scores`);

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
      cardState.set(courseId, { box, assignments: null, error: null, weights: await getWeights(courseId) });

      const cached = await getCached(courseId);
      if (cached) {
        cardState.get(courseId).assignments = cached.assignments;
      }
      renderCard(courseId);
      // Always refetch courses with a pending assignment: submitting it changes the countdown,
      // so the cached copy can be wrong right after the user returns from a submission.
      const expired = !cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS;
      if (expired || nextDue(cached.assignments)) stale.push(courseId);
    }

    setInterval(() => cardState.forEach((_, id) => renderCard(id)), 60 * 1000);

    // Weights saved from another dashboard tab.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        const courseId = key.match(/^weights:(\d+)$/)?.[1];
        const state = courseId && cardState.get(courseId);
        if (!state) continue;
        state.weights = newValue || null;
        renderCard(courseId);
      }
    });

    // Returning to the dashboard (Back button restores it from the back/forward cache, or the
    // tab regains focus) skips a fresh page load, so refresh courses with a pending assignment.
    const refreshPending = () => {
      const pending = [...cardState].filter(([, s]) => s.assignments && nextDue(s.assignments)).map(([id]) => id);
      refresh(pending);
    };
    window.addEventListener("pageshow", (e) => e.persisted && refreshPending());
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshPending());

    await refresh(stale);
  }

  let refreshing = false;

  async function refresh(courseIds) {
    if (refreshing || !courseIds.length) return;
    refreshing = true;
    try {
      await runPool(courseIds, MAX_CONCURRENT_FETCHES, async (courseId) => {
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
    } finally {
      refreshing = false;
    }
  }

  main();
})();
