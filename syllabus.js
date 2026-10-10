// Reads the grading section of a syllabus ("Homework 30%", "Midterm Exams 2 × 15% = 30%", ...) into
// categories and weights. Runs locally; loaded before content.js and also required by the Node tests.
(() => {
  "use strict";

  const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const NUM = String.raw`\d+(?:\.\d+)?`;

  // "quizzes" -> "quiz", "sets" -> "set", "exams" -> "exam"; leaves "class", "analysis", "bonus" alone.
  function singularize(word) {
    if (word.length > 4 && word.endsWith("zzes")) return word.slice(0, -3);
    if (word.endsWith("sses")) return word.slice(0, -2);
    if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    if (word.length > 3 && word.endsWith("s") && !/(ss|is|us)$/.test(word)) return word.slice(0, -1);
    return word;
  }

  // Dashes, "percent" and number words, without touching line structure.
  function normalizeInline(text) {
    let t = text.replace(/\r\n?/g, "\n").replace(/[   ]/g, " ").replace(/[‐-―−]/g, "-");
    t = t.replace(/\s*\b(?:per\s?cent|pct)\b/gi, "%");
    return t.replace(new RegExp(`\\b(${NUMBER_WORDS.join("|")})\\b`, "gi"), (w) => String(NUMBER_WORDS.indexOf(w.toLowerCase()) + 1));
  }

  function normalize(text) {
    return normalizeInline(text)
      .split("\n")
      .map((line) =>
        line
          .replace(/^\s*(?:[•·▪◦‣*●■□➢➤✓\uf0b7\uf0a7-]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/i, "") // bullets and "1." / "a)" markers
          .replace(/^o\s+(?=\S)/, "") // a Word bullet copied from a PDF: "o Final exam 35%"
          .replace(/^#{1,6}\s+|\*\*|__|`/g, "") // Markdown, as an AI chat's copy button gives it
          .replace(/\.{2,}|_{2,}|\t+|\s*\|\s*| {2,}/g, " ") // dot leaders, tabs, table pipes, wide gaps
          .trim()
      );
  }

  const hasNumber = (line) => /\d/.test(line);
  const onlyWeight = (line) => new RegExp(`^${NUM}\\s*(?:%|pts?\\b|points?\\b)\\.?$`, "i").test(line);

  // PDF copies often put a category and its weight on separate lines.
  function joinSplitLines(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] && !hasNumber(lines[i]) && i + 1 < lines.length && onlyWeight(lines[i + 1])) {
        out.push(`${lines[i]} ${lines[i + 1]}`);
        i++;
      } else {
        out.push(lines[i]);
      }
    }
    return out;
  }

  const isScale = (line) =>
    /grading scale|letter grade/i.test(line) ||
    (line.match(/\b[A-D][+-]?(?=\s*[:=]?\s*[<>≥]?\s*\d)/g) || []).length >= 2 ||
    /^[A-F][+-]?\s*[:=]?\s*[<>≥≤]?\s*\d+(?:\.\d+)?\s*%?\s*(?:(?:-|to|and)\s*[<>]?\s*\d+(?:\.\d+)?\s*%?)?\s*(?:\(.*\)|and above|or (?:above|higher|more|better)|\+)?$/.test(line);
  const isExtraCredit = (line) => /extra credit|bonus/i.test(line);
  const isTotal = (line) => /^(?:sub-?)?total\b/i.test(line);
  const isHeading = (line) => /^(?:(?:component|category|categories|item|items|assessment|assessments|assignment|assignments|weight|weights|weighting|grading|grade|breakdown|percentage|points|%)\b[\s:]*)+$/i.test(line);
  const NOTE = /\b(drop(?:ped|s)?|lowest|best|highest|whichever)\b/i;

  function noteText(line) {
    const paren = line.match(/\(([^)]*)\)/g)?.find((p) => NOTE.test(p));
    return (paren ? paren.slice(1, -1) : line).trim().replace(/[.;,]$/, "");
  }

  // How many of a category's lowest scores a note drops: "drop lowest 2", "the lowest two quiz grades
  // are dropped", "best 5 of 7", "Two dropped". null when it gives no count it is sure of.
  const COUNTS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const COUNT = `\\d+|${Object.keys(COUNTS).join("|")}`;
  const countOf = (word) => (word == null ? 1 : COUNTS[word.toLowerCase()] ?? parseInt(word, 10));
  const WORDS = "(?:[a-z-]+\\s+){0,3}";
  const WHOSE = "(?:(?:the|your|their|each|every)\\s+)?(?:student'?s\\s+)?";
  function dropOf(note) {
    const parts = note.split(/[,;]\s|\.\s/);
    if (parts.length > 1) return parts.map(dropOf).find((n) => n != null) ?? null;
    if (/\b(?:late|per day|letter|penalt|absen)/i.test(note)) return null; // "drops one letter grade per day"
    const best = note.match(new RegExp(`\\b(?:best|top|highest)\\s+(${COUNT})\\s+${WORDS}(?:of|out of)\\s+(?:the\\s+)?(${COUNT})\\b`, "i"));
    if (best) return checked(countOf(best[2]) - countOf(best[1]));
    const forms = [
      `\\bdrop(?:s|ped|ping)?\\s+${WHOSE}(?:lowest|worst|bottom)(?:\\s+(${COUNT}))?\\b`,
      `\\bdrop(?:s|ped|ping)?\\s+${WHOSE}(${COUNT})\\s+(?:lowest|worst)\\b`,
      `\\b(?:lowest|worst|low)(?:\\s+(${COUNT}))?\\s+${WORDS}(?:(?:is|are|will be|gets?)\\s+)?dropped\\b`,
      `(?<![\\d,.]\\s?)\\b(${COUNT})\\s+${WORDS}(?:(?:is|are|will be)\\s+)?dropped\\b`,
    ];
    const m = forms.map((f) => note.match(new RegExp(f, "i"))).find(Boolean);
    // "the lowest grades will be dropped" says more than one but not how many.
    if (m && !m[1] && /\b(?:grades|scores|marks)\b/i.test(m[0])) return null;
    return m ? checked(countOf(m[1])) : null;
  }
  const checked = (n) => (Number.isInteger(n) && n >= 1 && n <= 20 ? n : null);

  // A note from a category's own line or row sets its drop. One from a later sentence on the page goes
  // to the latest category whose kind of work it names, and sets nothing if it names none: "Your lowest
  // problem set will be dropped" is not about participation, nor "towards the final grade" about the final.
  const workWordsOf = (t) =>
    t
      .toLowerCase()
      .replace(/\b(?:final|course|overall)\s+(?:grade|mark|score)s?\b/g, " ")
      .split(/[^a-z]+/)
      .filter((w) => GRADED_WORK.test(w) || w === "hw")
      .map(singularize);
  function addNote(items, note, own = false) {
    const said = new Set(workWordsOf(note));
    const named = own ? items[0] : items.findLast((i) => workWordsOf(i.name).some((w) => said.has(w)));
    const item = named ?? items[items.length - 1];
    item.notes.push(note);
    const drop = dropOf(note);
    if (drop && named && !item.drop) item.drop = drop;
  }

  // Splits a sentence into one clause per category: "homework 40%, 2 midterms 15% each and final 30%",
  // or "60% - Long Exams 30% - Final Exam" where each weight leads. Clauses after ", with" in a weighted
  // sentence ("Exams 65%, with the midterm 40% and the final 25%") are parts of the category before.
  function clauses(sentence) {
    const weights = sentence.match(new RegExp(`${NUM}\\s*%`, "g")) || [];
    if (weights.length < 2) return [{ text: sentence }];
    if (new RegExp(`^${NUM}\\s*%`).test(sentence)) {
      return sentence.split(new RegExp(`(?=(?<![\\d.])${NUM}\\s*%)`)).map((c) => ({ text: c.trim() })).filter((c) => c.text);
    }
    // "Homework (15%) + Midterm (25%) + Final (60%)" lists categories; "10% (Oct) + 10% (Feb)" sums one.
    const plus = sentence.split("+");
    if (plus.length >= 2 && plus.slice(1).every((t) => /[a-z]{2}/i.test(t.replace(/\([^)]*\)/g, "").split(/\d/)[0]))) {
      return plus.map((text) => ({ text: text.trim() }));
    }
    // "Total = 10% + 10%" stays whole; "Written exam = 60%, Coursework = 40%" is a list.
    const sums = (t) => t.includes("=") && (t.match(new RegExp(`=\\s*${NUM}\\s*%`, "g")) || []).length < 2;
    const split = (t) => (sums(t) || !/[,;]|\band\b/.test(t) ? [t] : t.split(/[,;]|\band\b/)).map((c) => c.trim()).filter(Boolean);
    // A list whose bullets became dashes on one line: "Requirements - Participation (10%) - Homework (10%)".
    const dashed = sentence.split(/\s-\s/);
    if (dashed.length >= 3 && dashed.filter((d) => /%/.test(d)).length >= 2) {
      return dashed.flatMap((d) => (/%/.test(d) ? split(d) : [d.trim()])).filter(Boolean).map((text) => ({ text }));
    }
    const w = sentence.search(/,?\s+with\b/i);
    if (w > 0 && /%/.test(sentence.slice(0, w)) && /%/.test(sentence.slice(w))) {
      return [...split(sentence.slice(0, w)).map((text) => ({ text })), ...split(sentence.slice(w)).map((text) => ({ text, part: true }))];
    }
    return split(sentence).map((text) => ({ text }));
  }

  // Sentences of a long line; abbreviations such as "approx. 66" stay whole.
  const sentences = (line) => line.split(/(?<=[a-z0-9%)]{2}[.!?])\s+(?=[A-Z(])/);

  // Returns { weight, warning } for a clause, or null when it has no percentage.
  function percentOf(clause, count) {
    // "Midterms: 45% (3 midterms worth 15% each)": the weight outside the brackets.
    const outside = clause.replace(/\([^)]*\)/g, " ");
    if (outside !== clause && /%/.test(outside)) return percentOf(outside, count);
    // "Quizzes (10%): one quiz (5% each) before each exam": the first bracket holds the weight.
    const groups = clause.match(/\([^)]*%[^)]*\)/g) || [];
    if (groups.length >= 2) return percentOf(groups[0].slice(1, -1), count);
    let m = clause.match(new RegExp(`(?:=|\\btotal\\s+of)\\s*(${NUM})\\s*%`, "i"));
    if (m) return { weight: +m[1] };
    // "10% (October) + 10% (February)"
    if (new RegExp(`${NUM}\\s*%[^%]*\\+\\s*${NUM}\\s*%`).test(clause)) {
      return { weight: clause.match(new RegExp(`${NUM}(?=\\s*%)`, "g")).reduce((s, x) => s + +x, 0) };
    }
    m = clause.match(new RegExp(`(\\d+)\\s*(?:x|×|\\*|@)\\s*(${NUM})\\s*%`, "i"));
    if (m) return { weight: +m[1] * +m[2] };
    m = clause.match(new RegExp(`(${NUM})\\s*%\\s*each`, "i"));
    if (m) {
      return count ? { weight: count * +m[1] } : { weight: +m[1], warning: `"${m[0]}" but no count; using ${m[1]}%` };
    }
    m = clause.match(new RegExp(`(${NUM})\\s*%?\\s*(?:-|to)\\s*(${NUM})\\s*%`, "i"));
    if (m) return { weight: +m[1], warning: `syllabus says ${m[1]}–${m[2]}%; using ${m[1]}%` };
    m = clause.match(new RegExp(`(${NUM})\\s*%`));
    return m ? { weight: +m[1] } : null;
  }

  // Where the weight starts: "15%", "2 × 15%", "(10%)", "20-30%", "300 pts".
  const WEIGHT_START = new RegExp(
    String.raw`\(?\s*(?:\d+\s*(?:x|×|\*|@)\s*)?${NUM}\s*(?:%?\s*(?:-|to)\s*${NUM}\s*)?(?:%|pts?\b|points?\b|marks?\b)`,
    "i"
  );
  // Words that link a name to its weight in a sentence: "Homework is worth", "the final will count for".
  const TRAILING_LINK = /\s+(?:is|are|was|will|would|shall|be|being|counts?|counted|counting|for|worth|constitutes?|accounts?|make\s+up|makes\s+up|comprises?|carr(?:y|ies)|weighted|weighs?|contributes?|represents?|equals?|of|at|about|around|approximately|approx\.?|roughly|totals?|totaling|each|towards?|as|together|combined|with|and|a|an|the|gets?|receives?|earns?|determines?|decides?|provides?|yields?|forms?)$/i;
  const LEADING_PROSE = /^(?:(?:and|while|whereas|but|plus|then|so|with)\s+|there\s+(?:will\s+be|are|is|shall\s+be)\s+|we\s+will\s+have\s+|you\s+will\s+(?:have|take|write|complete|do)\s+)/i;
  const LEADING_ARTICLE = /^(?:a|an|the|your|our|each|every|all|both)\s+/i;
  const PRONOUN = /^(?:it|this|that|they|these|those|which|this one)$/i;
  // Words that label a weight rather than name a category: "Weighting: 20%", "Grade: 30% Final exam".
  const LABEL_WORDS = /^(?:(?:grading|grades?|weights?|weighting|breakdown|percentage|points|marks|value|worth|total|course|criteria|scheme|%)\b[\s:]*)+$/i;
  // Verbs that show the words before a linking word are a sentence, not part of the name.
  const VERBISH = /\b(?:is|are|will|be|based|consists?|determined|calculated|computed|made|comprised?|composed|derived|assigned|evaluated|assessed|graded)\b/i;

  function cleanName(text) {
    return text
      .replace(/\([^)]*\)?/g, " ")
      .replace(/\beach\b/gi, " ")
      .replace(/[\s:=@×*,;.-]+$/g, "")
      .replace(/^[\s:,;.\-–)]+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Name, count and abbreviation from a clause such as "2 midterms 15% each", "Learning Exercises (LE)
  // 20%", "Homework is worth 15% of your grade" or "30% problem sets". In a table cell the whole cell is
  // the name: no weight follows it, and no prose leads into it.
  function describe(clause, { cell = false } = {}) {
    let text = clause;
    let count = null;
    const lead = text.match(/^(\d+)\s+(?=[a-z])/i);
    if (lead) {
      count = +lead[1];
      text = text.slice(lead[0].length);
    }
    const paren = text.match(/\((\d+)\)/);
    if (paren) count = count || +paren[1];

    if (cell) {
      const abbr = text.match(/\(([A-Z]{2,5})\)/);
      // A per-item weight written into the name cell: "Exams (best 3 of 4) 100 pts each".
      const name = cleanName(text.replace(new RegExp(`\\s${NUM}\\s*(?:%|pts?\\b|points?\\b|marks?\\b).*$`, "i"), ""));
      return { name: name.replace(LEADING_ARTICLE, ""), count, keywords: abbr ? [abbr[1]] : [] };
    }

    const at = text.search(WEIGHT_START);
    let before = at >= 0 ? text.slice(0, at) : text;
    const weight = at >= 0 ? text.slice(at).match(WEIGHT_START)[0] : "";
    const after = at >= 0 ? text.slice(at + weight.length) : "";
    const abbr = before.match(/\(([A-Z]{2,5})\)/);

    // "Label: …": the words after the colon, or the label when those run long or are missing.
    let label = "";
    const colon = before.lastIndexOf(":");
    if (colon >= 0) {
      label = cleanName(before.slice(0, colon));
      before = before.slice(colon + 1);
    }
    let { name, guessed } = fromBefore(before);
    const sentenceName = name;
    if (!name || LABEL_WORDS.test(name) || GRADE_SUBJECT.test(name)) name = fromAfter(after) || (GRADE_SUBJECT.test(name) ? "" : name);
    if ((!name || wordCount(name) > 5) && label && wordCount(label) <= 4 && !LABEL_WORDS.test(label)) name = label;
    guessed = guessed && name === sentenceName;
    // "There will be 2 quizzes each of 20 marks": the count shows up once the prose is trimmed.
    const counted = name.match(/^(\d+)\s+(?=[a-z])/i);
    if (counted) {
      count = count || +counted[1];
      name = name.slice(counted[0].length);
    }
    const pronoun = PRONOUN.test(name);
    if (pronoun || LABEL_WORDS.test(name) || !/[a-z]{2}/i.test(name)) name = "";
    return { name, count, pronoun, label, guessed, keywords: abbr ? [abbr[1]] : [] };
  }

  // The name before the weight, with the words that lead into it trimmed. In a sentence it is the
  // subject before the verb ("Homework is due Fridays and is worth"), unless the subject is the grade
  // itself ("Grades will be based on homework"): then it is the words after the last linking word.
  function fromBefore(text) {
    // "In this course, homework is worth": the leading phrase goes. "Participation, which is based on
    // attendance, is worth": so does the relative clause.
    let name = cleanName(text.replace(LEADING_PHRASE, "").replace(/,\s*(?:which|who|that|where)\b.*$/i, ""));
    // The subject names the weight only when a linking verb leads straight into it: "Homework is worth
    // 30%", not "This course is graded on homework 30%".
    const linked = LINKED.test(cleanName(text));
    const trim = () => {
      for (let prev = null; prev !== name; ) {
        prev = name;
        name = cleanName(name.replace(TRAILING_LINK, "")).replace(LEADING_PROSE, "").replace(LEADING_ARTICLE, "");
      }
    };
    trim();
    const verb = name.search(VERBISH);
    let guessed = false;
    if (verb >= 0) {
      const subject = name.slice(0, verb).trim().replace(LEADING_ARTICLE, "");
      const words = name.split(/\s+/);
      const last = words.map((w) => w.toLowerCase()).findLastIndex((w) => PROSE_LINKS.has(w));
      const object = last >= 0 && last < words.length - 1 ? words.slice(last + 1).join(" ") : "";
      if (linked && subject && !GRADE_SUBJECT.test(subject)) name = subject;
      else {
        // "This course is graded on homework 30%" names the object; "Quizzes are graded by your TA
        // (20%)" and "Homework is submitted through Gradescope (30%)" name the subject. The one that
        // names graded work wins; when neither or both do, it is a guess.
        const bySubject = subject && !GRADE_SUBJECT.test(subject) ? subject : "";
        const [s, o] = [bySubject && GRADED_WORK.test(bySubject), object && GRADED_WORK.test(object)];
        if (s && !o) name = bySubject;
        else if (o && !s) name = object;
        else {
          name = object || bySubject;
          guessed = !!name;
        }
      }
      trim();
    }
    return { name, guessed };
  }

  const LEADING_PHRASE = /^\s*(?:in|for|throughout|during|across|within|over|at)\s+[^,]{1,40},\s*/i;
  const LINKED = /\b(?:is|are|will\s+be|counts?|worth|accounts?\s+for|makes?\s+up|constitutes?|represents?|weighted|weighs?|equals?|contributes?|carr(?:y|ies))(?:\s+(?:for|as|to|towards?|about|around|approximately|roughly|up\s+to|a|an|the|of|remaining|other|additional|final))*$/i;
  const GRADE_SUBJECT = /^(?:(?:the|your|our|final|overall|course|total)\s+)*(?:grades?|grading|marks?|evaluation|assessment|scores?)(?:\s+(?:for|in|of|on)\s+(?:the|this)\s+(?:course|class|module|subject|unit))?$/i;

  // The name after a leading weight: "30% problem sets", "10% - Assignments (best 5)", "20% of your
  // grade comes from homework".
  function fromAfter(text) {
    let t = text.replace(new RegExp(`^\\s*(?:=\\s*${NUM}\\s*%|each)`, "i"), "").replace(/^[\s\-–:.)]+/, "");
    const via = t.match(/^(?:of\s+(?:the|your)\s+(?:[a-z]+\s+)?(?:grade|mark)s?\s+)?(?:(?:comes?|will\s+come|is|are)\s+(?:from|for|based\s+on)|is|are|will\s+be|goes\s+to|from|for)\s+(.+)$/i);
    if (via) t = via[1];
    else if (/^(?:of|in|on|to|per|toward|towards|if|and|or)\b/i.test(t)) return "";
    const name = cleanName(t.split(/[(,;]|\.(?:\s|$)|\s-\s/)[0]).replace(LEADING_ARTICLE, "");
    return wordCount(name) <= 6 ? name : "";
  }

  const PROSE_LINKS = new Set(["on", "of", "is", "are", "by", "through", "via", "from", "include", "includes", "including", "follows", "while", "whereas"]);

  // A percentage that sets a condition or a penalty rather than a weight: "at least 60% to pass",
  // "late work loses 10% per day", "if you miss a midterm the final counts for 65%". Read from the words
  // before the weight and after it up to a bracket, since brackets hold notes ("Quizzes 20% (best 5;
  // no make-ups if you fail to attend)") and names may hold any word.
  const CONDITION = /\b(?:if|unless|otherwise|instead|penalt(?:y|ies)|deduct\w*|lose|loses|losing|lost|at\s+least|minimum|more\s+than|less\s+than|fewer\s+than|below|above|or\s+(?:higher|better|more|above)|to\s+pass|per\s+(?:day|hour)|each\s+day|a\s+day)\b/i;
  // Words that make a condition only in a sentence: "Late work receives 50%", but "Labs (pass/fail)
  // 10%" and "Missed-lecture reflections 10%" are names.
  const CONDITION_IN_SENTENCE = /\b(?:late|lateness|miss|missed|missing|passing|fail\w*)\b/i;
  const SENTENCE_VERB = /\b(?:receives?|gets?|earns?|will|can|may|must|should|counts?|replaces?|drops?)\b/i;
  const isSentence = (t) => VERBISH.test(t) || SENTENCE_VERB.test(t) || wordCount(t.trim()) > 5;
  function isCondition(clause) {
    const m = clause.match(WEIGHT_START);
    if (!m) return CONDITION.test(clause) || CONDITION_IN_SENTENCE.test(clause);
    // After the weight, up to a note: "Homework 30% - late work not accepted", "Quizzes 10%: no late quizzes".
    const after = clause.slice(m.index + m[0].length).split(/[(:;,]|\s[-–]\s/)[0];
    const before = clause.slice(0, m.index);
    const text = `${before} ${after}`;
    // "Late work: 10% off", "a 5% reduction".
    const reduces = /^\s*(?:off|reduction|deduction)\b/i.test(clause.slice(m.index + m[0].length));
    return reduces || CONDITION.test(text) || (isSentence(text) && CONDITION_IN_SENTENCE.test(text));
  }

  // Words that head the grading section: "Grading", "Assessment", "Course evaluation", "Weights".
  const GRADING = /\b(?:grad(?:e|es|ed|ing)|assessments?|evaluation|breakdown|weight\w*|marks?|marking|scheme)\b/i;
  // A heading is about grading when it says so ("Grading", "Graded work", "Assessment"), or when its
  // only words are weaker ones ("Evaluation", "Course weights", "Methods of evaluation"): "Weekly time
  // breakdown", "Model evaluation" and "Introduction to Scheme" are not. A rubric grades one piece of work.
  const GRADING_STRONG = /\b(?:grad(?:e|es|ed|ing)|assessments?|marking)\b/i;
  const GRADING_WEAK = /^(?:evaluations?|breakdown|weights?|weighting|marks?|scheme|course|class|module|methods?|of|and|&|the|final|overall|student|your|policy|policies|distribution|components?|criteria|summary|overview|basis|for|work|percentages?|plan|structure|system|requirements?)$/i;
  const isGradingHeading = (text) => {
    if (!text || /\brubrics?\b/i.test(text)) return false;
    // "How the final exam is graded", "Participation grading": one kind of work, not the course. "Exams
    // and grading" and "Final grade" still head the course's grading.
    const rest = text.split(":")[0].replace(GRADING_STRONG, " ").replace(/\bfinal\s+(?=(?:course\s+)?grad)/gi, " ").replace(/\bfinal\s*$/i, " ");
    if (GRADED_WORK.test(rest) && !/\band\b|&|,|\//i.test(text)) return false;
    if (GRADING_STRONG.test(text)) return true;
    const words = text.replace(/^\s*\d+(?:\.\d+)*\.?\s+/, "").toLowerCase().match(/[a-z&]+/g) || [];
    return GRADING.test(text) && words.every((w) => GRADING_WEAK.test(w));
  };

  // A short line with no number: a heading. A title, which can name a weight written below it ("Final
  // Exam" … "Weighting: 20%"), is shorter still and holds no punctuation.
  const looksLikeHeading = (line) => /[a-z]{2}/i.test(line) && !hasNumber(line.replace(/^\s*\d+(?:\.\d+)*\.?\s+/, "")) && wordCount(line) <= 8;
  const looksLikeTitle = (line) => /[a-z]/i.test(line) && !hasNumber(line) && wordCount(line) <= 4 && !/[.,;:!?@]/.test(line);

  const keyOf = (name) => name.toLowerCase().split(/\s+/).map(singularize).join(" ");

  // Line by line: one "name … weight" per line, sentence or clause. On a whole-page paste the grading
  // section is the run of consecutive weights that adds up to 100%. Points are read only when no line
  // gives a percentage weight.
  function parseLines(text, known = []) {
    const lines = joinSplitLines(normalize(text));
    const percent = scan(lines, false);
    const points = scan(lines, true);
    if (!percent.found.length && points.found.length) {
      const unsure = [...(points.found.some((i) => i.fromTitle) ? [TITLE_DOUBT] : []), ...guesses(points.found)];
      const { skipped, checkTotal } = points;
      // Points always add up to 100%, so this reading is not compared with a table's.
      return { ...finish(points.found, { skipped, pointsMode: true, checkTotal, unsure, source: { kind: "lines" } }), offered: [], regionDoubts: [], fromPoints: true };
    }
    const { items, unsure, offered, section, regionDoubts = [] } = breakdown(percent, points.found, known);
    if (items.some((i) => i.fromTitle)) unsure.push(TITLE_DOUBT);
    unsure.push(...guesses(items));
    const { skipped, checkTotal } = percent;
    return { ...finish(items, { skipped, pointsMode: false, checkTotal, unsure, source: { kind: "lines", section } }), offered, regionDoubts };
  }

  const TITLE_DOUBT = "a name was taken from the heading above its weight";
  // A sentence whose subject and object could both name the weight: "Reports are graded on clarity (20%)".
  const guesses = (items) => items.filter((i) => i.guessed).map((i) => `“${i.name}” was picked from a sentence that could name something else`);

  // Every weighted clause of the paste, in order, with the headings seen on the way.
  function scan(lines, pointsMode) {
    const found = [];
    const skipped = [];
    const conditions = []; // rows skipped as conditions, offered back when they would complete 100%
    const headings = [];
    let checkTotal = null;
    let title = null;
    const skip = (line, reason) => skipped.push({ text: line, reason });
    const noteOrSkip = (t, reason) => {
      if (NOTE.test(t) && found.length) addNote(found, noteText(t));
      else skip(t, reason);
    };

    lines.forEach((line, at) => {
      if (!line) return;
      if (isScale(line)) return skip(line, "grading scale");
      if (isExtraCredit(line)) return skip(line, "extra credit");
      if (isTotal(line)) {
        const m = line.match(new RegExp(NUM));
        if (m) checkTotal = +m[0];
        return skip(line, "total");
      }
      if (looksLikeHeading(line)) headings.push({ text: line.replace(/[:\s]+$/, ""), at });
      if (!hasNumber(line)) {
        if (isHeading(line) || GRADING.test(line)) title = null;
        else if (looksLikeTitle(line)) title = line;
        return noteOrSkip(line, isHeading(line) ? "heading" : "no weight");
      }

      const before = found.length;
      for (const sentence of sentences(line)) {
        let parent = null;
        let unweighted = null; // the clause before, when it had no weight: "participation, 5%"
        for (let { text: clause, part } of clauses(sentence)) {
          let { name, count, keywords, pronoun, label, guessed, weight } = read(clause, pointsMode);
          if (weight && !name && unweighted) {
            clause = `${unweighted} ${clause}`;
            ({ name, count, keywords, pronoun, label, guessed, weight } = read(clause, pointsMode));
          }
          unweighted = weight ? null : clause;
          if (!weight) {
            if (!part) noteOrSkip(clause, "no weight");
            continue;
          }
          if (isCondition(clause)) {
            skip(clause, "condition or penalty");
            if (name && !part && weight.weight) conditions.push({ name, keywords, weight: weight.weight });
            continue;
          }
          if (weight.weight === 0) {
            skip(clause, "0%");
            continue;
          }
          // "Weighting: 20%" or "It counts for 20%" under a "Final Exam" title.
          let fromTitle = false;
          if (!name && !part && title && (pronoun || /^\W*(?:[A-Za-z]+\s*){0,3}:?\s*\W*\d/.test(clause))) {
            [name, title, fromTitle] = [title, null, true];
          }
          if (!name) {
            if (!part) skip(clause, "no name");
            continue;
          }
          const item = { name, keywords, weight: weight.weight ?? 0, points: weight.points, warnings: [], notes: [], at, label };
          if (fromTitle) item.fromTitle = true;
          if (guessed) item.guessed = true;
          if (weight.warning) item.warnings.push(weight.warning);
          if (NOTE.test(clause)) addNote([item], noteText(clause), true);
          if (part && parent) {
            parent.parts.push({ name, weight: item.weight });
            continue;
          }
          item.parts = [];
          found.push(item);
          parent = item;
        }
      }
      if (found.length === before) title = null; // a numbered line between a title and its weight
    });
    return { found, skipped, conditions, headings, checkTotal };
  }

  function read(clause, pointsMode) {
    // "Each of the 2 midterms is worth 20%" is "2 midterms is worth 20% each".
    clause = clause.replace(new RegExp(`^\\s*each\\s+of\\s+(?:the\\s+|your\\s+)?(\\d+)\\s+(.*?${NUM}\\s*%)`, "i"), "$1 $2 each");
    // "10% for each of the 2 quizzes" is "2 quizzes 10% each".
    clause = clause.replace(new RegExp(`^\\s*(${NUM}\\s*%)\\s*(?:for\\s+|on\\s+)?each\\s+of\\s+(?:the\\s+|your\\s+)?(\\d+)\\s+(.+)$`, "i"), "$2 $3 $1 each");
    const described = describe(clause);
    let weight;
    if (pointsMode) {
      // "On a 1000 point scale" describes the grading, not a category.
      const m = clause.match(new RegExp(`(${NUM})\\s*-?\\s*(?:pts?|points?|marks?)\\b(?!\\s*(?:scale|system|basis)\\b)`, "i"));
      weight = m && { points: +m[1] * (described.count && /\beach\b/i.test(clause) ? described.count : 1) };
    } else {
      weight = percentOf(clause, described.count);
    }
    return { ...described, weight };
  }

  const isLong = (name) => name.split(/\s+/).length > 6 || /[;!?]|\.\s/.test(name);

  // Runs of consecutive weights that add up to 100%, scored like `quality`.
  function runsTo100(found) {
    const runs = [];
    for (let i = 0; i < found.length; i++) {
      let sum = 0;
      for (let j = i; j < found.length && sum <= 100.5; j++) {
        sum += found[j].weight;
        if (j > i && Math.abs(sum - 100) <= 0.5) runs.push(found.slice(i, j + 1));
      }
    }
    const score = (run) =>
      Math.min(run.length, 8) - run.filter((i) => i.warnings.length).length - 3 * run.filter((i) => isLong(i.name)).length;
    return runs.map((run) => ({ run, score: score(run) }));
  }

  // Categories whose parts follow them: "Exams 50%" then "Midterm 20%", "Final 30%" on the next lines.
  function foldParts(found) {
    const out = [];
    for (let i = 0; i < found.length; i++) {
      const item = found[i];
      out.push(item);
      let sum = 0;
      for (let j = i + 1; j < found.length && found[j].at - found[j - 1].at <= 2; j++) {
        sum += found[j].weight;
        if (sum > item.weight + 0.5) break;
        if (j > i + 1 && Math.abs(sum - item.weight) <= 0.5) {
          const parts = found.slice(i + 1, j + 1);
          out[out.length - 1] = { ...item, folded: [item, ...parts], parts: parts.map((p) => ({ name: p.name, weight: p.weight })) };
          i = j;
          break;
        }
      }
    }
    return out;
  }

  // Words that name graded work. A run of weights whose names mostly lack them ("Training 70%,
  // Validation 15%, Test 15%") may be some other list that adds up to 100%.
  const GRADED_WORK = /\b(?:home\s*works?|homework|hw\d*|problem\s*sets?|psets?|assignments?|quiz(?:zes)?|labs?|laborator(?:y|ies)|projects?|midterms?|mid-terms?|prelims?|finals?|exams?|examinations?|tests?|participation|attendance|engagement|clickers?|polls?|essays?|papers?|reports?|presentations?|discussions?|recitations?|responses?|reflections?|journals?|portfolios?|exercises?|worksheets?|tutorials?|seminars?|workshops?|coursework|assessments?|capstone|thesis|proposals?|critiques?|forums?|checkpoints?|milestones?|demos?|deliverables?|write-?ups?|case\s+stud(?:y|ies)|memos?|briefs?|blogs?|notebooks?|preparation|prep|in-class|practicals?|drafts?|debates?|abstracts?|annotations?)\b/i;
  // Words that name graded work in some courses and other things in others: "Lectures 40%" may be time.
  const WEAK_WORK = /\b(?:lectures?|readings?|problems?|questions?|work|research|sections?|modules?|reviews?|activit(?:y|ies)|tasks?|programs?|programming|challenges?|submissions?|studio|logs?|summar(?:y|ies)|surveys?|posts?|peer|contributions?)\b/i;
  const workScore = (name, known = []) =>
    GRADED_WORK.test(name) || known.some((k) => keyOf(name).split(" ").some((w) => w.length > 2 && k.includes(w))) ? 1 : WEAK_WORK.test(name) ? 0.5 : 0;
  const NOT_WORK = "the names don't look like graded work";
  const looksGraded = (run, known) => run.reduce((s, i) => s + workScore(i.name, known), 0) * 2 >= run.length;

  // Rows offered back to the reader must read like categories, not like "you may miss up to 20%".
  const offerable = (i) => i && !isLong(i.name) && !/^(?:you|we|i|students?|they)\b/i.test(i.name);
  const offer = (i) => ({ name: i.name, keywords: i.keywords, weight: i.weight });

  // The grading section of a whole-page paste: the run that adds up to 100%, read as listed or with
  // categories' parts folded in. A run under a grading heading, with no weight left out next to it,
  // wins. It is confident only when it sits under a grading heading or nothing else has weights.
  function breakdown({ found, skipped, conditions, headings }, pointRows, known) {
    // The last few headings above a line, nearest first, and whether one of them is about grading.
    const above = (at) => headings.filter((h) => h.at < at).slice(-3).reverse();
    // A grading heading counts when the run is the first weighted text under it.
    const weightedAt = [...found.map((i) => i.at), ...pointRows.map((p) => p.at)];
    const sectionOf = (run) => {
      const first = Math.min(...[...run.used].map((i) => i.at));
      const heads = above(first);
      const label = run.run[0].label;
      const grading = heads.find((h) => isGradingHeading(h.text) && !weightedAt.some((at) => at > h.at && at < first));
      if (grading) return { section: grading.text, graded: true, headAt: grading.at, strong: GRADING_STRONG.test(grading.text) };
      if (isGradingHeading(label)) return { section: label, graded: true, headAt: null, strong: GRADING_STRONG.test(label) };
      return { section: heads[0]?.text ?? null, graded: false };
    };
    const folded = foldParts(found);
    const readings = folded.length < found.length ? [found, folded] : [found];
    const runs = readings.flatMap(runsTo100).map(({ run, score }) => {
      const used = new Set(run.flatMap((i) => [i, ...(i.folded || [])]));
      const lines = [...used].map((i) => i.at);
      const [first, last] = [Math.min(...lines), Math.max(...lines)];
      // A weight on the line just before or after the run may belong to it (a bonus, a total over 100%).
      const near = found.find((i) => !used.has(i) && i.at >= first - 1 && i.at <= last + 1);
      const r = { run, used, near, first, last };
      Object.assign(r, sectionOf(r));
      r.score = score - (near ? 5 : 0) + (r.graded ? 3 : 0);
      return r;
    });
    if (!runs.length) {
      // A row skipped as a condition that would complete 100% is offered back: "Midterm 30% (curved)".
      const total = found.reduce((s, i) => s + i.weight, 0);
      const fill = found.length ? conditions.find((c) => Math.abs(total + c.weight - 100) <= 0.5 && offerable(c)) : null;
      if (!fill) return { items: found, unsure: [], offered: [], section: null };
      return { items: found, unsure: [`“${fill.name} ${fmt(fill.weight)}%” was skipped as a condition or penalty`], offered: [offer(fill)], section: null };
    }
    const best = runs.reduce((b, r) => (r.score > b.score ? r : b));
    for (const i of found) {
      if (!best.used.has(i)) skipped.push({ text: `${i.name} ${fmt(i.weight)}%`, reason: "not in the part that adds up to 100%" });
    }
    const unsure = [];
    const regionDoubts = []; // doubts about which part of the paste holds the grading, for a table too
    // Another set of lines that adds up to 100% just as well, naming other categories.
    const names = (run) => run.map((i) => keyOf(i.name)).sort().join("|");
    const apart = (r) => ![...r.used].some((i) => best.used.has(i));
    if (runs.some((r) => r.score >= best.score - 1 && apart(r) && names(r.run) !== names(best.run))) {
      regionDoubts.push("another part of the paste also adds up to 100%");
    }
    // Any list can add up to 100% ("time spent: lectures 40%, labs 35%, reading 25%"). Without a grading
    // heading above it, other weights on the page are a reason to check; under one, names that don't
    // look like graded work are.
    const outside = [...found.filter((i) => !best.used.has(i) && i !== best.near), ...pointRows.filter((p) => p.at < best.first || p.at > best.last)];
    // Two or more weights under a different grading heading ("Grading" with points, then "Course
    // breakdown" with percentages) are another candidate.
    const headOf = (at) => headings.filter((h) => h.at < at).at(-1);
    // "Assessment" above "Assessment activities", or "Marking scheme" twice, is one section.
    const wordsOf = (t) => (t || "").toLowerCase().match(/[a-z]+/g) || [];
    const same = (h) => {
      const [x, y] = [wordsOf(h.text), wordsOf(best.section)];
      return x.every((w) => y.includes(w)) || (y.length && y.every((w) => x.includes(w)));
    };
    // The same list again (under "Resit" or "Re-assessment") is not a rival.
    const runKeys = new Set(best.run.map((i) => keyOf(i.name)));
    const others = outside.filter((x) => !runKeys.has(keyOf(x.name)));
    const heads = others.map((x) => headOf(x.at)).filter((h) => h && h.at !== best.headAt && isGradingHeading(h.text) && !same(h));
    const rival = heads.find((h) => heads.filter((g) => g === h).length >= 2);
    if (rival) regionDoubts.push(`${best.section ? `read from the lines under “${best.section}”, but ` : ""}the lines under “${rival.text}” have weights too`);
    else if (!best.graded && outside.length) {
      unsure.push(best.section ? `read from the lines under “${best.section}”, but other lines have weights too` : "other lines have weights too");
    }
    // Names that don't look like graded work, unless a heading that says "grading" vouches for them.
    if (!looksGraded(best.run, known) && !(best.graded && best.strong && !rival)) regionDoubts.push(NOT_WORK);
    unsure.unshift(...regionDoubts);
    const folds = best.run.filter((i) => i.folded);
    for (const f of folds) unsure.push(`read ${f.parts.map((p) => `“${p.name}”`).join(" and ")} as parts of “${f.name}”`);
    const near = offerable(best.near) ? best.near : null;
    if (best.near) unsure.push(`“${best.near.name} ${fmt(best.near.weight)}%” was left out but sits next to the rows that add up to 100%`);
    return { items: best.run, unsure, offered: near ? [offer(near)] : [], section: best.section, regionDoubts };
  }

  const LONG_NAME = "long name; check it";

  // Points to percentages, the same category listed twice merged, and the total checked.
  function finish(items, { skipped, pointsMode, checkTotal, source, unsure: doubts = [] }) {
    const notes = [];
    if (pointsMode) {
      const sum = items.reduce((s, i) => s + i.points, 0);
      for (const i of items) i.weight = sum ? Math.round((i.points / sum) * 1000) / 10 : 0;
      if (items.length) notes.push(`Converted from points (${fmt(sum)} total)`);
      // Points always convert to 100%, so only a stated total confirms that every row was found.
      if (items.length && checkTotal == null) doubts.push("worked out from points, with no total to check against");
      else if (items.length && Math.abs(checkTotal - sum) > 0.5) {
        notes.push(`The syllabus lists a total of ${fmt(checkTotal)} points, but the lines add up to ${fmt(sum)}`);
        doubts.push("the points don't match the total");
      }
    }

    const merged = [];
    for (const item of items) {
      const prev = merged.find((m) => keyOf(m.name) === keyOf(item.name));
      if (!prev) {
        merged.push(item);
        continue;
      }
      prev.weight += item.weight;
      prev.warnings.push("listed twice; weights added");
      prev.notes.push(...item.notes);
      prev.drop ||= item.drop;
      prev.keywords.push(...item.keywords.filter((k) => !prev.keywords.includes(k)));
    }
    for (const item of merged) {
      delete item.points;
      delete item.at;
      delete item.folded;
      delete item.guessed;
      // Parts that add up to the category, so it can be split: "Exams 65%" = midterm 40% + final 25%.
      const parts = item.parts || [];
      if (parts.length >= 2 && Math.abs(parts.reduce((s, p) => s + p.weight, 0) - item.weight) <= 0.5) item.parts = parts;
      else delete item.parts;
      if (item.weight > 100) item.warnings.push("over 100%");
      if (isLong(item.name)) item.warnings.push(LONG_NAME);
      if (DATE.test(item.name)) item.warnings.push("has a date in its name");
    }

    const total = merged.reduce((s, i) => s + i.weight, 0);
    if (checkTotal != null && !pointsMode && Math.abs(checkTotal - total) > 0.01) {
      notes.push(`The syllabus lists a total of ${fmt(checkTotal)}%, but the lines add up to ${fmt(total)}%`);
    }
    // Reasons to double-check the result; empty when it looks complete.
    const unsure = [...doubts];
    if (merged.length && Math.abs(total - 100) > 0.5) unsure.push("total is not 100%");
    // One category for the whole grade is rare, and is what a stray "100 points" reads as.
    else if (merged.length === 1) unsure.push("only one category was found");
    if (merged.some((i) => i.warnings.length)) unsure.push("some rows have warnings");
    return { items: merged, skipped, notes, total, unsure, source, offered: [] };
  }

  // ---- Tables: rows of cells from a pasted HTML table or tab-separated lines ----

  // Cells are strings, or { text, copy: true } where a rowspan/colspan repeats a cell, with `lead`, the
  // first paragraph, when a cell holds a title and then a description.
  const textOf = (cell) => (typeof cell === "string" ? cell : cell?.text ?? "");
  const leadOf = (cell) => (typeof cell === "object" && cell?.lead) || textOf(cell);
  const isCopy = (cell) => typeof cell === "object" && cell !== null && !!cell.copy;

  const UNIT_HEADER = /weight|%|percent|worth|value|contribution|share|points?\b|pts|marks?\b/i;
  const POINTS_HEADER = /points?\b|pts|marks?\b/i;
  const NOTE_HEADER = /note|drop|polic|comment|detail|remark/i;

  // The weight at the start of a cell: "25%", "60% (7.5% per lab), with …", "2 × 15% = 30%", "300 pts".
  // `unit` reads a bare "25" when the column header names it ("Weight (%)", "Points").
  function cellWeight(cell, unit, count = null) {
    const head = cell.split(/[(,;]|\bwith\b/)[0].trim();
    const approx = head.match(new RegExp(`^(?:~|≈|about\\s|approx(?:imately|\\.)?\\s?)\\s*(?=\\d)`, "i"));
    const bare = head.slice(approx ? approx[0].length : 0);
    if (!new RegExp(`^${NUM}`).test(bare)) return null;
    if (unit && new RegExp(`^${NUM}$`).test(bare)) {
      const w = unit === "points" ? { points: +bare } : { weight: +bare };
      return approx ? { ...w, warning: `syllabus says "${head}"` } : w;
    }
    const pts = head.match(new RegExp(`(${NUM})\\s*(?:pts?|points?|marks?)\\b`, "i"));
    if (pts && !head.includes("%")) return { points: +pts[1] };
    return percentOf(head, count);
  }

  // The sentence of a cell that states a drop/best rule, shortened.
  function noteIn(text) {
    const sentence = text.split(/(?<=[.;])\s+/).find((t) => NOTE.test(t));
    if (!sentence) return null;
    const note = noteText(sentence);
    return note.length > 80 ? `${note.slice(0, 79)}…` : note;
  }

  // Dates and times ("Sep 12", "Fri", "10/3", "2pm", "Week 6"), which name no category.
  const DATE = /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?\b|\d{1,2}\/\d{1,2}\b|\d{1,2}(?::\d{2})?\s*[ap]\.?m\b|week\s+\d)/i;
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? 0;
  const wordCount = (t) => (t ? t.split(/\s+/).length : 0);

  // A table: the weight column is the one where most cells start with a weight (ties go to the column
  // that sums closest to 100%), the name column is the leftmost column of short, mostly distinct text.
  // Other columns are read only for drop/best notes. Returns null when no column holds weights.
  function parseGrid(rows) {
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (width < 2 || rows.length < 2) return null;
    const grid = rows.map((r) =>
      Array.from({ length: width }, (_, c) => normalizeInline(textOf(r[c])).replace(/\s+/g, " ").trim())
    );
    const raw = (r, c) => textOf(rows[r][c]).replace(/\s+/g, " ").trim(); // notes keep the syllabus's words
    const lead = rows.map((r) => Array.from({ length: width }, (_, c) => normalizeInline(leadOf(r[c])).replace(/\s+/g, " ").trim()));
    const copied = (r, c) => isCopy(rows[r][c]);
    const weightAt = (r, c, unit, count) => (copied(r, c) ? null : cellWeight(grid[r][c], unit, count));

    // Rows above the first weight are headers. Without any "%"/"pts" cell, assume one header row.
    let start = grid.findIndex((row, r) => row.some((_, c) => weightAt(r, c)));
    if (start < 0) start = 1;
    const header = (c) => grid.slice(0, start).map((row) => row[c]).filter(Boolean).join(" ");
    const unitOf = (c) => {
      const h = header(c);
      if (!UNIT_HEADER.test(h) || /^\W*\d/.test(h)) return null; // a number up top is data, not a header
      return POINTS_HEADER.test(h) && !/%|percent|weight/i.test(h) ? "points" : "weight";
    };

    const cols = [];
    for (let c = 0; c < width; c++) {
      const found = [];
      for (let r = start; r < grid.length; r++) {
        const w = weightAt(r, c, unitOf(c));
        if (w && !isTotal(grid[r].find(Boolean) || "")) found.push(w);
      }
      const sum = found.reduce((s, w) => s + (w.weight ?? 0), 0);
      cols.push({ c, n: found.length, sum, named: unitOf(c) ? 1 : 0 });
    }
    const most = Math.max(...cols.map((x) => x.n));
    if (most < 2) return null;
    const wc = cols
      .filter((x) => x.n >= Math.max(2, most * 0.6))
      .sort((x, y) => Math.abs(x.sum - 100) - Math.abs(y.sum - 100) || y.named - x.named || x.c - y.c)[0].c;
    const unit = unitOf(wc);

    const weighted = [];
    for (let r = start; r < grid.length; r++) if (weightAt(r, wc, unit)) weighted.push(r);
    // Of the short-text columns that aren't dates, the most distinct one names the rows ("Category |
    // Task | Weight" with a repeated category reads names from Task); ties go to the leftmost.
    const named = [];
    for (let c = 0; c < width; c++) {
      if (c === wc) continue;
      const texts = weighted.map((r) => lead[r][c]).filter(Boolean);
      if (texts.length < weighted.length * 0.6) continue;
      if (texts.filter((t) => /^\W*\d/.test(t) || new RegExp(`^\\W*${DATE.source}`, "i").test(t)).length > texts.length * 0.3) continue;
      if (median(texts.map(wordCount)) > 6) continue;
      const distinct = new Set(texts).size / weighted.length;
      if (distinct >= 0.6) named.push({ c, distinct });
    }
    if (!named.length) return null;
    const top = Math.max(...named.map((x) => x.distinct));
    const nc = named.find((x) => x.distinct === top).c;

    const items = [];
    const skipped = [];
    let checkTotal = null;
    const skip = (r, reason) => skipped.push({ text: grid[r].filter(Boolean).join(" · "), reason });
    for (let r = 0; r < start; r++) if (grid[r].some(Boolean)) skip(r, "heading");
    for (let r = start; r < grid.length; r++) {
      const row = grid[r];
      if (!row.some(Boolean)) continue;
      const cellName = lead[r][nc];
      if (isTotal(cellName) || (!cellName && isTotal(row.join(" ")))) {
        const w = weightAt(r, wc, unit);
        checkTotal = w?.weight ?? w?.points ?? checkTotal;
        skip(r, "total");
        continue;
      }
      if (isScale(row.join(" ")) || /^[A-F][+-]?$/.test(cellName)) {
        skip(r, "grading scale");
        continue;
      }
      if (isExtraCredit(cellName)) {
        skip(r, "extra credit");
        continue;
      }
      const { name, count, keywords } = describe(cellName, { cell: true });
      const found = weightAt(r, wc, unit, count);
      if (!found) {
        skip(r, "no weight");
        continue;
      }
      if (found.weight === 0) {
        skip(r, "0%");
        continue;
      }
      if (!name) {
        skip(r, "no name");
        continue;
      }
      const item = { name, keywords, weight: found.weight ?? 0, points: found.points, warnings: [], notes: [] };
      if (found.warning) item.warnings.push(found.warning);
      for (let c = 0; c < width; c++) {
        if (c === nc || copied(r, c)) continue;
        if (c !== wc && wordCount(row[c]) > 15 && !NOTE_HEADER.test(header(c))) continue;
        const note = noteIn(raw(r, c));
        if (note && !item.notes.includes(note)) addNote([item], note, true);
      }
      items.push(item);
    }

    // Letter grades down the name column: a grading scale or score statistics, not a breakdown.
    if (skipped.filter((s) => s.reason === "grading scale").length >= 2) return null;

    // Percent and points mixed in one column: keep the percents.
    const pointsMode = items.every((i) => i.points != null);
    const kept = pointsMode ? items : items.filter((i) => i.points == null);
    for (const i of items) if (!kept.includes(i)) skipped.push({ text: i.name, reason: "points, not %" });
    const source = { kind: "table", nameHeader: header(nc), weightHeader: header(wc) };
    return finish(kept, { skipped, pointsMode, checkTotal, source });
  }

  // Two tables side by side ("Name | % | | Name | %"): split at empty columns and stacked.
  function stackSideBySide(rows) {
    const width = Math.max(0, ...rows.map((r) => r.length));
    const empty = (c) => rows.every((r) => !textOf(r[c]).trim());
    const parts = [];
    let from = 0;
    for (let c = 0; c <= width; c++) {
      if (c < width && !empty(c)) continue;
      if (c > from) parts.push([from, c]);
      from = c + 1;
    }
    if (parts.length < 2 || parts.some(([a, b]) => b - a < 2)) return rows;
    return parts.flatMap(([a, b]) => rows.map((r) => r.slice(a, b)));
  }

  const transpose = (rows) =>
    Array.from({ length: Math.max(0, ...rows.map((r) => r.length)) }, (_, c) => rows.map((r) => r[c] ?? ""));

  // A table read as laid out, or turned sideways when its names run across the top row.
  function readTable(rows) {
    const stacked = stackSideBySide(rows);
    const readings = [parseGrid(stacked), parseGrid(transpose(rows))].filter(Boolean);
    return readings.length ? readings.reduce((best, r) => (quality(r) > quality(best) ? r : best)) : null;
  }

  // Runs of two or more lines with tabs: what Chrome puts on the clipboard for a copied table. Cells
  // holding paragraphs come out as "cell\n\n\t\n\ncell", so a tab after a line break joins its
  // neighbors ("cell\t\n" is an empty last cell), and blank lines between rows don't end the run.
  function gridsFromText(text) {
    const grids = [];
    let run = [];
    const flush = () => {
      if (run.length >= 2) grids.push(run.map((line) => line.split("\t")));
      run = [];
    };
    for (const line of text.replace(/\r\n?/g, "\n").replace(/\n+\t\n*/g, "\t").split("\n")) {
      if (line.includes("\t")) run.push(line);
      else if (line.trim()) flush();
    }
    flush();
    return grids;
  }

  // The innermost tables of an HTML clipboard copy as grids, with rowspan/colspan cells repeated as
  // copies. Parsed with DOMParser, which does not run scripts or load images.
  const BLOCKS = "p, div, li, h1, h2, h3, h4, h5, h6";

  function tablesFromHtml(html) {
    if (!html || typeof DOMParser === "undefined") return [];
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const node of doc.querySelectorAll("br, p, div, li")) node.after(" ");
    return [...doc.querySelectorAll("table")]
      .filter((t) => !t.querySelector("table"))
      .map((table) => {
        const grid = [];
        [...table.rows].forEach((tr, r) => {
          grid[r] ||= [];
          let c = 0;
          for (const cell of tr.cells) {
            while (grid[r][c] !== undefined) c++;
            const text = cell.textContent.replace(/\s+/g, " ").trim();
            const blocks = [...cell.querySelectorAll(BLOCKS)]
              .filter((b) => !b.querySelector(BLOCKS))
              .map((b) => b.textContent.replace(/\s+/g, " ").trim())
              .filter(Boolean);
            const lead = blocks.length >= 2 ? blocks[0] : null;
            const rs = Math.min(cell.rowSpan || 1, 50);
            const cs = Math.min(cell.colSpan || 1, 20);
            for (let i = 0; i < rs; i++) {
              for (let j = 0; j < cs; j++) (grid[r + i] ||= [])[c + j] = i || j ? { text, lead, copy: true } : lead ? { text, lead } : text;
            }
            c += cs;
          }
        });
        return Array.from(grid, (row) => Array.from(row || [], (x) => x ?? ""));
      });
  }

  // How much a reading looks like a grading breakdown: totals 100%, several rows, no doubtful rows.
  function quality(r) {
    if (!r.items.length) return -Infinity;
    const doubtful = r.items.filter((i) => i.warnings.length).length;
    const long = r.items.filter((i) => i.warnings.includes(LONG_NAME)).length;
    return (Math.abs(r.total - 100) <= 0.5 ? 10 : 0) + Math.min(r.items.length, 8) - doubtful - 3 * long;
  }

  // Reads a paste. Tables come first (from the clipboard's HTML copy when there is one, else from
  // tab-separated lines), then the text line by line; the reading that looks most like a grading
  // breakdown wins, and a table wins a tie. Returns { items, skipped, notes, total, unsure, source,
  // offered, others }: `offered` are rows left out that may belong, `others` other tables to pick.
  // `pick` chooses a table by its index in `source`, as offered in `others`.
  function parseSyllabus(text, html, pick = null, { known = [] } = {}) {
    const fromHtml = tablesFromHtml(html);
    const grids = fromHtml.length ? fromHtml : gridsFromText(text);
    const tables = grids.map(readTable).filter((t) => t && t.items.length);
    tables.forEach((t, index) => Object.assign(t.source, { index, count: tables.length }));
    const knownKeys = known.map((k) => keyOf(k));
    const lines = parseLines(text, knownKeys);
    let best = tables[pick] ?? [...tables, lines].reduce((b, r) => (quality(r) > quality(b) ? r : b));
    // A table whose names don't look like graded work (a report rubric) gives way to lines that add up
    // to 100% with names that do. The table stays on offer, and the doubt says so.
    const complete = (r) => r.items.length >= 2 && Math.abs(r.total - 100) <= 0.5;
    if (pick == null && best !== lines && !lines.fromPoints && complete(lines) && !looksGraded(best.items, knownKeys) && looksGraded(lines.items, knownKeys)) {
      best = lines;
    }
    // Other tables with weights, so the reader can switch; a second breakdown is a reason to check.
    best.others = tables.filter((t) => t !== best && t.items.length >= 2).map((t) => ({
      index: t.source.index,
      names: t.items.map((i) => i.name),
    }));
    if (best.others.length) best.unsure.push("other tables have weights");
    // A table chosen over the lines: the lines read the same rows with what surrounds them, or other ones.
    if (best !== lines && !lines.fromPoints && complete(lines)) {
      // Words of the names, so "Participation in module questions" and "Participation" share one.
      const words = (r) => new Set(r.items.flatMap((i) => keyOf(i.name).split(/[^a-z]+/).filter((w) => w.length > 3)));
      const [ours, theirs] = [words(best), words(lines)];
      if ([...theirs].some((w) => ours.has(w))) best.unsure.push(...lines.regionDoubts.filter((d) => !best.unsure.includes(d)));
      else best.unsure.push("the lines outside the table add up to 100% too, with other categories");
    }
    if (best !== lines && !best.unsure.includes(NOT_WORK) && !looksGraded(best.items, knownKeys)) best.unsure.push(NOT_WORK);
    delete lines.regionDoubts;
    delete lines.fromPoints;
    return best;
  }

  function fmt(n) {
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  const api = { parseSyllabus, parseGrid, singularize, dropOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.GradescopePlusSyllabus = api;
})();
