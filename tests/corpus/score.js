// Scores syllabus.js against the corpus in headless Chrome (see scripts/score-corpus.sh).
// Each page is read the way a paste of the whole page arrives: the HTML copy plus the text Chrome
// would put on the clipboard (innerText). PDFs are read from pdftotext output.
// Held-out entries print only totals unless the page URL has #reveal.
(async () => {
  "use strict";
  const { parseSyllabus, singularize } = globalThis.GradescopePlusSyllabus;
  const out = document.getElementById("out");
  const print = (line) => (out.textContent += `${line}\n`);
  const reveal = location.hash.includes("reveal");
  const params = new URLSearchParams(location.search);
  const only = params.get("id");
  const dump = params.has("dump"); // print the text variant, for debugging one entry

  const STOP = new Set(["the", "a", "an", "of", "and", "&", "for", "in", "on", "course"]);
  const norm = (name) =>
    name
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w))
      .map(singularize);
  const subset = (x, y) => x.length && x.every((w) => y.includes(w));
  const sameName = (produced, expected) => {
    const p = norm(produced);
    return [expected.name, ...(expected.aliases || [])].some((n) => {
      const e = norm(n);
      return subset(p, e) || subset(e, p);
    });
  };

  // Expected items, and the same with each nested category split into its parts.
  function readings(expected) {
    const flat = expected.items.flatMap((i) =>
      i.components?.length
        ? i.components.map((c) => ({ name: c.name, aliases: c.aliases, weight: (i.weight * c.weight) / 100 }))
        : [i]
    );
    return flat.length === expected.items.length ? [expected.items] : [expected.items, flat];
  }

  // Every expected item found once, nothing extra. A category may also come as a finer split: several
  // rows named for it ("Participation: worksheets", "Participation: strategies") that add up to it.
  function matches(produced, items, tolerance) {
    const rest = [...produced];
    const close = (x, y) => Math.abs(x - y) <= tolerance;
    for (const e of items) {
      const i = rest.findIndex((p) => sameName(p.name, e) && close(p.weight, e.weight));
      if (i >= 0) {
        rest.splice(i, 1);
        continue;
      }
      const parts = rest.filter((p) => sameName(p.name, e));
      if (parts.length < 2 || !close(parts.reduce((s, p) => s + p.weight, 0), e.weight)) return false;
      for (const p of parts) rest.splice(rest.indexOf(p), 1);
    }
    return !rest.length;
  }

  // correct: same categories and weights. unsure: not correct, but the result admits doubt or is empty.
  // wrong: not correct and presented as if it were.
  function grade(result, expected) {
    const [nested, flat] = readings(expected);
    if (matches(result.items, nested, 0.11) || (flat && matches(result.items, flat, 0.3))) return "correct";
    if (!result.items.length || result.unsure.length) return "unsure";
    return "wrong";
  }

  async function text(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.text();
  }

  // The page as a whole-page copy: scripts, styles and remote resources removed, laid out in a
  // sandboxed frame so innerText matches what Chrome copies.
  async function pageCopy(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, link, img, iframe, video, audio, source, object, embed, noscript").forEach((n) => n.remove());
    const clean = doc.body ? doc.body.innerHTML : "";
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.style.cssText = "width:1200px;height:800px;position:absolute;left:-5000px";
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><body>${clean}</body>`;
    await new Promise((resolve) => {
      frame.onload = resolve;
      document.body.append(frame);
    });
    const copy = { html: clean, text: frame.contentDocument.body.innerText };
    frame.remove();
    return copy;
  }

  const corpus = JSON.parse(await text("corpus.json"));
  const tally = {};
  const bySyllabus = {}; // split -> worst status of each syllabus over its variants
  const count = (split, status, flagged) => {
    tally[split] ||= { correct: 0, unsure: 0, wrong: 0, flagged: 0 };
    tally[split][status]++;
    if (flagged) tally[split].flagged++;
  };
  const RANK = { correct: 0, unsure: 1, wrong: 2 };

  for (const entry of corpus) {
    if (only && entry.id !== only) continue;
    let variants;
    try {
      if (entry.kind === "pdf") {
        variants = await Promise.all(
          ["raw", "layout"].map(async (v) => ({ name: `pdf-${v}`, text: await text(`cache/${entry.id}.${v}.txt`) }))
        );
      } else {
        const copy = await pageCopy(await text(`cache/${entry.id}.html`));
        // Also the text alone, as when the source puts no HTML on the clipboard.
        variants = [{ name: "page", ...copy }, { name: "text-only", text: copy.text }];
      }
    } catch (e) {
      print(`MISSING ${entry.id} (${e.message})`);
      continue;
    }
    let worst = "correct";
    for (const v of variants) {
      if (dump) print(`--- ${v.name}\n${JSON.stringify(v.text)}`);
      const result = parseSyllabus(v.text, v.html);
      const status = grade(result, entry.expected);
      // A correct reading that still asks the reader to check it: noise, if it happens often.
      const flagged = status === "correct" && result.unsure.length > 0;
      count(entry.split, status, flagged);
      count(`${entry.split} ${entry.shape}`, status, flagged);
      count(`${entry.split} from ${entry.source}`, status, flagged);
      if (RANK[status] > RANK[worst]) worst = status;
      if (entry.split === "heldout" && !reveal) continue;
      const got = result.items.map((i) => `${i.name} ${Math.round(i.weight * 10) / 10}`).join(" | ") || "(nothing)";
      const want = entry.expected.items.map((i) => `${i.name} ${i.weight}`).join(" | ") || "(nothing)";
      const how = result.source?.kind === "table" ? `table ${result.source.index + 1}/${result.source.count}` : "lines";
      print(`${status.toUpperCase().padEnd(7)} ${entry.id} [${entry.split} ${entry.shape} ${v.name} via ${how}]`);
      if (status !== "correct") print(`        got:  ${got}${result.unsure.length ? `  (unsure: ${result.unsure.join("; ")})` : ""}\n        want: ${want}`);
      else if (flagged) print(`        flagged: ${result.unsure.join("; ")}`);
    }
    bySyllabus[entry.split] ||= { correct: 0, unsure: 0, wrong: 0 };
    bySyllabus[entry.split][worst]++;
  }

  print("");
  for (const [split, t] of Object.entries(tally).sort(([x], [y]) => x.localeCompare(y))) {
    const n = t.correct + t.unsure + t.wrong;
    print(`SUMMARY ${split}: ${t.correct}/${n} correct (${t.flagged} of them flagged to check), ${t.unsure} unsure, ${t.wrong} confidently wrong`);
  }
  // Each syllabus once, at its worst reading: the variants of one page are not independent.
  for (const [split, t] of Object.entries(bySyllabus).sort(([x], [y]) => x.localeCompare(y))) {
    const n = t.correct + t.unsure + t.wrong;
    print(`SYLLABI ${split}: ${t.correct}/${n} correct in every reading, ${t.unsure} unsure in some, ${t.wrong} confidently wrong in some`);
  }
  document.title = "DONE";
})().catch((e) => {
  document.getElementById("out").textContent += `ERROR ${e.stack}\n`;
  document.title = "DONE";
});
