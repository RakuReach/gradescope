// Run with: node --test tests/syllabus.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSyllabus, parseGrid, dropOf } = require("../syllabus.js");

const weights = (r) => r.items.map((i) => `${i.name} ${i.weight}`);

test("T1 plain percentages", () => {
  const r = parseSyllabus("Homework 30%\nMidterm 25%\nFinal Exam 40%\nParticipation 5%");
  assert.deepEqual(weights(r), ["Homework 30", "Midterm 25", "Final Exam 40", "Participation 5"]);
  assert.equal(r.total, 100);
});

test("T2 dot leaders and counts", () => {
  const r = parseSyllabus("Problem Sets (9) .......... 40%\nMidterm Exams (2) ...... 30%\nFinal Exam ............ 30%");
  assert.deepEqual(weights(r), ["Problem Sets 40", "Midterm Exams 30", "Final Exam 30"]);
});

test("T3 multiplication and each", () => {
  const r = parseSyllabus("Midterm Exams 2 × 15% = 30%\nQuizzes 10 x 2% each\nLabs 4 @ 5%\nFinal 30%");
  assert.deepEqual(weights(r), ["Midterm Exams 30", "Quizzes 20", "Labs 20", "Final 30"]);
});

test("T4 pasted table with header and total", () => {
  const r = parseSyllabus("Component\tWeight\nHomework\t25%\nProjects\t45%\nFinal Project\t20%\nParticipation\t10%\nTotal\t100%");
  assert.deepEqual(weights(r), ["Homework 25", "Projects 45", "Final Project 20", "Participation 10"]);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["heading", "total"]);
  assert.deepEqual(r.notes, []);
});

test("T5 PDF split lines", () => {
  const r = parseSyllabus("Homework\n30%\nExams\n50%\nLab Reports\n20%");
  assert.deepEqual(weights(r), ["Homework 30", "Exams 50", "Lab Reports 20"]);
});

test("T6 bullets, percent spelled out, drop note", () => {
  const r = parseSyllabus(
    "• Participation: 5 percent\n• Weekly quizzes – 15 percent\n- Problem sets: 40 percent (lowest dropped)\n- Exams: 40 percent"
  );
  assert.deepEqual(weights(r), ["Participation 5", "Weekly quizzes 15", "Problem sets 40", "Exams 40"]);
  assert.deepEqual(r.items[2].notes, ["lowest dropped"]);
});

test("T7 points converted", () => {
  const r = parseSyllabus("Homework 300 pts\nMidterm 200 points\nFinal 300 points\nProject 200 pts\nTotal 1000 points");
  assert.deepEqual(weights(r), ["Homework 30", "Midterm 20", "Final 30", "Project 20"]);
  assert.deepEqual(r.notes, ["Converted from points (1000 total)"]);
});

test("T8 ranges, whichever, extra credit", () => {
  const r = parseSyllabus("Midterm 20–30%\nFinal 40–50% (whichever helps you)\nHomework 30%\nExtra credit: up to 2%");
  assert.deepEqual(weights(r), ["Midterm 20", "Final 40", "Homework 30"]);
  assert.equal(r.items[0].warnings[0], "syllabus says 20–30%; using 20%");
  assert.deepEqual(r.items[1].notes, ["whichever helps you"]);
  assert.equal(r.total, 90);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["extra credit"]);
});

test("T9 abbreviations and grading scale", () => {
  const r = parseSyllabus(
    "Learning Exercises (LE) 20%\nEvaluations (EV) 30%\nMastery Checks (MX) 10%\nGroup Tasks (GT) 10%\nApplied Tasks (AT) 5%\nProblem Sets 25%\n\nGrading scale: A 90%+, B 80%+, C 70%+"
  );
  assert.deepEqual(weights(r), [
    "Learning Exercises 20",
    "Evaluations 30",
    "Mastery Checks 10",
    "Group Tasks 10",
    "Applied Tasks 5",
    "Problem Sets 25",
  ]);
  assert.deepEqual(r.items.map((i) => i.keywords.join()), ["LE", "EV", "MX", "GT", "AT", ""]);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["grading scale"]);
});

test("T10 one sentence, number words", () => {
  const r = parseSyllabus("Your grade: homework 40%, two midterms 15% each, final 30%.");
  assert.deepEqual(weights(r), ["homework 40", "midterms 30", "final 30"]);
});

test("duplicates merge, nothing found", () => {
  const r = parseSyllabus("Homework 20%\nHomeworks 10%");
  assert.deepEqual(weights(r), ["Homework 30"]);
  assert.deepEqual(r.items[0].warnings, ["listed twice; weights added"]);
  assert.deepEqual(parseSyllabus("").items, []);
  assert.deepEqual(parseSyllabus("Grading scale: A 93-100, A- 90-92, B+ 87-89").items, []);
});

test("prose sentence with 'and'", () => {
  const r = parseSyllabus("Grades will be based on homework (30%), two midterms (20% each) and a final exam (30%).");
  assert.deepEqual(weights(r), ["homework 30", "midterms 40", "final exam 30"]);
});

// Tables: made-up grids in the shapes real syllabi use.
test("wide table: weight and name columns found, prose columns ignored", () => {
  const r = parseGrid([
    ["Type", "Purpose", "Weight", "Notes"],
    ["Homework", "Practice problems; review and reflect on recent topics before class", "15%", "Lowest 2 dropped"],
    ["Lab prep", "Reading and pre-lab questions", "", ""],
    ["Labs", "Hands-on work", "50% (5% per lab), with each lab roughly: 30% prep/70% in class", ""],
    ["Exams", "Two midterms, 20% and 15%", "35%", ""],
  ]);
  assert.deepEqual(weights(r), ["Homework 15", "Labs 50", "Exams 35"]);
  assert.deepEqual(r.items[0].notes, ["Lowest 2 dropped"]);
  assert.deepEqual(r.source, { kind: "table", nameHeader: "Type", weightHeader: "Weight" });
  assert.deepEqual(r.skipped.map((s) => s.reason), ["heading", "no weight"]);
  assert.deepEqual(r.unsure, []);
});

test("table: per-item and total columns, the total column wins", () => {
  const r = parseGrid([
    ["Component", "Count", "Each", "Total"],
    ["Quizzes", "10", "2%", "20%"],
    ["Projects", "2", "15%", "30%"],
    ["Final", "1", "50%", "50%"],
  ]);
  assert.deepEqual(weights(r), ["Quizzes 20", "Projects 30", "Final 50"]);
});

test("table: bare numbers under a unit header, points converted", () => {
  assert.deepEqual(weights(parseGrid([["Item", "Weight (%)"], ["Homework", "30"], ["Exams", "70"]])), ["Homework 30", "Exams 70"]);
  const r = parseGrid([["Assessment", "Points"], ["Labs", "200"], ["Midterm", "100"], ["Final", "200"], ["Total", "500"]]);
  assert.deepEqual(weights(r), ["Labs 40", "Midterm 20", "Final 40"]);
  assert.deepEqual(r.notes, ["Converted from points (500 total)"]);
});

test("table: grading scales and late policies are not breakdowns", () => {
  assert.deepEqual(parseGrid([["Grade", "Range"], ["A", "93%"], ["B", "83%"], ["C", "73%"]])?.items ?? [], []);
  assert.equal(parseGrid([["Days late", "Penalty"], ["1", "10%"]]), null);
});

test("table: a weight repeated by rowspan counts once", () => {
  const r = parseGrid([
    ["Category", "Part", "Weight"],
    ["Exams", "Midterm", "60%"],
    [{ text: "Exams", copy: true }, "Final", { text: "60%", copy: true }],
    ["Homework", "Weekly", "40%"],
  ]);
  assert.deepEqual(weights(r), ["Exams 60", "Homework 40"]);
});

test("whole page text: the tab-separated table beats stray percentages", () => {
  const page = [
    "Course info",
    "Late work loses 10% per day, up to 3 days.",
    "About 40% of students take this course in their first year.",
    "Type\tPurpose\tWeight",
    "Homework\tPractice\t20%",
    "Projects\tBuild things; demo in class\t50%",
    "Exam\tIn class\t30%",
    "Grading scale: A 93%, B 83%",
  ].join("\n");
  const r = parseSyllabus(page);
  assert.deepEqual(weights(r), ["Homework 20", "Projects 50", "Exam 30"]);
  assert.equal(r.source.kind, "table");
});

// Whole pages: made-up text in the shapes real syllabi use.

test("whole page: the lines that add up to 100% are the breakdown", () => {
  const r = parseSyllabus(
    "Office hours\nLate work loses 10% per day.\nYou need at least 60% on the final to pass.\nGrading\nHomework: 20%\nQuizzes: 10%\nMidterms: 30%\nLabs: 15%\nFinal: 25%\nGrading Scale\nA+ 97% to 100%\nA 93% to 96%"
  );
  assert.deepEqual(weights(r), ["Homework 20", "Quizzes 10", "Midterms 30", "Labs 15", "Final 25"]);
  assert.deepEqual(r.unsure, []);
  assert.deepEqual(
    r.skipped.filter((s) => /condition|grading scale/.test(s.reason)).map((s) => s.reason),
    ["condition or penalty", "condition or penalty", "grading scale", "grading scale", "grading scale"]
  );
});

test("weight first: '30% homework', '10% - Final Exam', one line of several", () => {
  assert.deepEqual(weights(parseSyllabus("Course grading scheme:\n5% class participation\n30% homework (best 6 out of 7)\n30% midterm\n35% final")), [
    "class participation 5",
    "homework 30",
    "midterm 30",
    "final 35",
  ]);
  assert.deepEqual(weights(parseSyllabus("Grading System\n60% - 3 Long Exams 30% - Final Exam 10% - Quizzes, Assignments, etc.")), [
    "Long Exams 60",
    "Final Exam 30",
    "Quizzes 10",
  ]);
  assert.deepEqual(weights(parseSyllabus("Grading criteria are the following: 30% problem sets, 35 % midterm, 35% final exam.")), [
    "problem sets 30",
    "midterm 35",
    "final exam 35",
  ]);
});

test("sentences: subject before 'is worth', title for 'it', names split by commas", () => {
  const r = parseSyllabus(
    "Homework\nHomework is worth 20% of your overall grade.\nMidterm\nIt will count for 30% of your grade.\nThe final exam counts for 40%; the project, 10%."
  );
  assert.deepEqual(weights(r), ["Homework 20", "Midterm 30", "final exam 40", "project 10"]);
});

test("nested: parts after ', with' and parts on the lines below", () => {
  const r = parseSyllabus("Homework 15%\nExams are worth 75%, with the midterm worth 30% and the final worth 45%.\nProject 10%");
  assert.deepEqual(weights(r), ["Homework 15", "Exams 75", "Project 10"]);
  assert.deepEqual(r.items[1].parts, [{ name: "midterm", weight: 30 }, { name: "final", weight: 45 }]);
  const lines = parseSyllabus("Homework 30%\nExams 50%\nMidterm 20%\nFinal 30%\nParticipation 20%");
  assert.deepEqual(weights(lines), ["Homework 30", "Exams 50", "Participation 20"]);
  assert.deepEqual(lines.items[1].parts.map((p) => p.name), ["Midterm", "Final"]);
  // Parts found only because their weights add up are a guess.
  assert.deepEqual(lines.unsure, ["read “Midterm” and “Final” as parts of “Exams”"]);
});

test("brackets and plus signs: per-item weights inside, lists of categories", () => {
  assert.deepEqual(weights(parseSyllabus("Midterms: 45% (3 midterms worth 15% each)\nFinal exam: 55%")), ["Midterms 45", "Final exam 55"]);
  assert.deepEqual(weights(parseSyllabus("Scheme: Homework (15%) + Midterm Exam (25%) + Final Exam (60%)")), ["Homework 15", "Midterm Exam 25", "Final Exam 60"]);
  assert.deepEqual(weights(parseSyllabus("Homework 50%\nMidterm exams: 20% (October) + 30% (February)")), ["Homework 50", "Midterm exams 50"]);
  assert.deepEqual(weights(parseSyllabus("1,000-word Essay (40%)\n3,000 word Essay on a topic of your choice (60%)")), [
    "1,000-word Essay 40",
    "3,000 word Essay on a topic of your choice 60",
  ]);
});

test("whole page: doubts when a weight sits next to the breakdown or two parts add up to 100%", () => {
  const near = parseSyllabus("Exams 50%\nLabs 30%\nHomework 20%\nClickers 3%");
  assert.deepEqual(weights(near), ["Exams 50", "Labs 30", "Homework 20"]);
  assert.deepEqual(near.unsure, ["“Clickers 3%” was left out but sits next to the rows that add up to 100%"]);
  assert.deepEqual(near.offered, [{ name: "Clickers", keywords: [], weight: 3 }]);
  const two = parseSyllabus("Course A\nEssays 40%\nExam 60%\n\nSome text here.\nMore text.\nCourse B\nLabs 70%\nQuizzes 30%");
  assert.equal(two.unsure[0], "another part of the paste also adds up to 100%");
});

// Review repros: lists that add up to 100% but aren't grading, stale titles, notes in brackets.

test("a list that adds up to 100% is only trusted under a grading heading", () => {
  const r = parseSyllabus("Expected workload\nLectures 30%\nReading 30%\nProblem sets 40%\n\nGrading\nHomework 30%\nQuizzes 5% each\nMidterm 20%\nFinal 30%");
  assert.deepEqual(r.unsure, ["read from the lines under “Expected workload”, but the lines under “Grading” have weights too"]);
  const topics = parseSyllabus("Grading\nHomework 400 points\nMidterm 250 points\nFinal 350 points\n\nFinal exam coverage\nSorting 40%\nGraphs 35%\nDynamic programming 25%");
  assert.deepEqual(topics.unsure, ["read from the lines under “Final exam coverage”, but the lines under “Grading” have weights too", "the names don't look like graded work"]);
  const graded = parseSyllabus("Time in this course\nLectures 40%\nLabs 35%\nReading 25%\n\nGrading\nHomework 30%\nMidterm 30% (curved)\nFinal 40%");
  assert.deepEqual(weights(graded), ["Homework 30", "Midterm 30", "Final 40"]);
  assert.deepEqual([graded.unsure, graded.source.section], [[], "Grading"]);
});

test("titles name a weight only right above it, and say so", () => {
  const r = parseSyllabus("Course Staff\nProfessor Smith, smith@school.edu\nGrading\nProject 1\nIt is worth 25%.\nHomework 35%\nFinal 40%");
  assert.deepEqual(weights(r), ["Homework 35", "Final 40"]);
  const titled = parseSyllabus("Midterm\nWeight: 30%\nHomework 30%\nFinal 40%");
  assert.deepEqual(weights(titled), ["Midterm 30", "Homework 30", "Final 40"]);
  assert.deepEqual(titled.unsure, ["a name was taken from the heading above its weight"]);
});

test("conditions are read outside brackets; the subject of a sentence names it", () => {
  assert.deepEqual(weights(parseSyllabus("Quizzes 20% (best 5 of 6; no make-ups if you fail to attend)\nLabs 30% (at least 50% to pass)\nFinal 50%")), [
    "Quizzes 20",
    "Labs 30",
    "Final 50",
  ]);
  assert.deepEqual(weights(parseSyllabus("Homework is due on Fridays and is worth 30%.\nThe midterm is worth 30%.\nThe final is worth 40%.")), [
    "Homework 30",
    "midterm 30",
    "final 40",
  ]);
  const offered = parseSyllabus("Homework 40%\nLate penalty for the midterm 30%\nFinal 30%");
  assert.deepEqual(offered.offered.map((o) => o.weight), [30]);
});

test("points with stray percentages, and dates are not names", () => {
  const r = parseSyllabus("Homework 300 points\nMidterm 300 points\nFinal 400 points\nTotal 1000 points\nLate work: 10% off per day.");
  assert.deepEqual(weights(r), ["Homework 30", "Midterm 30", "Final 40"]);
  assert.deepEqual(r.unsure, []);
  const t = parseSyllabus("Type\tDue\tWeight\nQuiz\tSep 12\t10%\nQuiz\tOct 3\t10%\nMidterm\tOct 20\t30%\nFinal\tDec 15\t50%");
  assert.deepEqual(weights(t), ["Quiz 20", "Midterm 30", "Final 50"]);
});

test("a heading counts as grading by what it is about, not by any word in it", () => {
  for (const heading of ["Weekly time breakdown", "Model evaluation", "Introduction to Scheme", "Lab report grading rubric"]) {
    const r = parseSyllabus(`Grading\nHomework 400 points\nMidterm 250 points\nFinal 350 points\n\n${heading}\nLectures 30%\nReading 30%\nProblem sets 40%`);
    assert.notDeepEqual(r.unsure, [], heading);
  }
  for (const heading of ["Grading", "Evaluation", "Methods of evaluation", "Course weights", "Marking scheme", "Graded work"]) {
    const r = parseSyllabus(`Office hours\nMonday 3 pm\n${heading}\nHomework 30%\nMidterm 30%\nFinal 40%\n\nLate work\nLate homework loses 10% per day`);
    assert.deepEqual([r.unsure, r.source.section], [[], heading], heading);
  }
  // The heading above counts only when it is about grading, even when it is the nearest one.
  const topics = parseSyllabus("Grading\nHomework 300 points\nMidterm 300 points\nFinal 400 points\nFinal exam topics: sorting 40%, graphs 35%, dynamic programming 25%.");
  assert.notDeepEqual(topics.unsure, []);
  const odd = parseSyllabus("Evaluation\nTraining 70%\nValidation 15%\nTest 15%");
  assert.deepEqual(odd.unsure, ["the names don't look like graded work"]);
  // A heading that says "grading" vouches for unusual names, unless another grading section has weights.
  assert.deepEqual(parseSyllabus("Grading\nJuries 30%\nRecitals 20%\nLessons 50%").unsure, []);
  const two = parseSyllabus("Grading\nHomework 20-30%\nExams 60-70%\nParticipation 10%\n\nCourse breakdown\nLectures 40%\nLabs 40%\nProjects 20%");
  assert.deepEqual(two.unsure, ["read from the lines under “Course breakdown”, but the lines under “Grading” have weights too"]);
  // A heading about one kind of work is not the course's grading.
  const exam = parseSyllabus("Grading\nHomework 300 points\nMidterm 300 points\nFinal 400 points\n\nHow the final exam is graded\nProblems 40%\nShort-answer questions 35%\nEssay 25%");
  assert.notDeepEqual(exam.unsure, []);
  const known = parseSyllabus("Grading\nKoans 60%\nKata 40%", null, null, { known: ["Koan 1", "Kata 3"] });
  assert.deepEqual(known.unsure, []);
});

test("a sentence names a weight by its subject only when a linking verb leads to the weight", () => {
  const cases = {
    "This course is graded on homework 30%, two midterms 20% each, and a final 30%.": ["homework 30", "midterms 40", "final 30"],
    "Student performance will be evaluated by homework (30%), quizzes (20%) and a final exam (50%).": ["homework 30", "quizzes 20", "final exam 50"],
    "Your final grade is 40% homework, 60% exams.": ["homework 40", "exams 60"],
    "In this course, homework is worth 30%.\nThe midterm is worth 30%.\nThe final is worth 40%.": ["homework 30", "midterm 30", "final 40"],
    "Participation, which is based on attendance, is worth 10%.\nHomework is worth 40%.\nThe final is worth 50%.": ["Participation 10", "Homework 40", "final 50"],
    "Important: 10% of your grade is participation.\nHomework 40%\nFinal 50%": ["participation 10", "Homework 40", "Final 50"],
    "Homework gets 30%.\nQuizzes determine 20%.\nThe final exam decides 50%.": ["Homework 30", "Quizzes 20", "final exam 50"],
    "Homework is worth 60%. Each of the two midterms is worth 20%.": ["Homework 60", "midterms 40"],
    "10% for each of the 2 quizzes, 30% for the midterm, 50% for the final": ["quizzes 20", "midterm 30", "final 50"],
    "Reading responses are graded on completion (10%).\nProblem sets are worth 40%.\nThe final exam is worth 50%.": ["Reading responses 10", "Problem sets 40", "final exam 50"],
    "Quizzes are given in lecture and graded by your TA (20%).\nHomework is worth 30%.\nThe final is worth 50%.": ["Quizzes 20", "Homework 30", "final 50"],
    "Homework is submitted through Gradescope (30%).\nThe midterm is worth 30%.\nThe final is worth 40%.": ["Homework 30", "midterm 30", "final 40"],
  };
  for (const [text, want] of Object.entries(cases)) {
    const r = parseSyllabus(text);
    assert.deepEqual([weights(r), r.unsure], [want, []], text);
  }
  // Neither the subject nor the object names graded work: a guess, and it says so.
  const guess = parseSyllabus("Your mark is set by the instructor (20%).\nHomework is worth 30%.\nThe final is worth 50%.");
  assert.ok(guess.unsure.some((u) => u.includes("picked from a sentence")), guess.unsure.join("; "));
});

test("condition words in a name, or in a note after the weight, do not make a condition", () => {
  const rows = ["Labs (pass/fail) 10%", "Missed-lecture reflections 10%", "Quizzes 10%: lowest two dropped, no late quizzes"];
  for (const row of rows) {
    const r = parseSyllabus(`Grading\nHomework 30%\n${row}\nMidterm 20%\nFinal 40%\n\nLab report grading rubric\nCorrectness 50%\nAnalysis 30%\nWriting 20%`);
    assert.equal(r.items.length, 4, row);
    assert.equal(r.source.section, "Grading", row);
  }
  assert.deepEqual(weights(parseSyllabus("Homework 30% - late work not accepted\nMidterm 30%\nFinal 40%")), ["Homework 30", "Midterm 30", "Final 40"]);
  assert.deepEqual(weights(parseSyllabus("Homework 40%\nFinal 60%\nLate work receives 50%.")), ["Homework 40", "Final 60"]);
  assert.deepEqual(weights(parseSyllabus("Homework 40%\nExams 60%\nLate work: 10% off")), ["Homework 40", "Exams 60"]);
});

test("a table is checked against the lines around it", () => {
  const rubric = parseSyllabus("Grading\nHomework 30%\nMidterm 30%\nFinal 40%\n\nProject rubric\nCriterion\tWeight\nProblem statement\t20%\nDesign\t20%\nImplementation\t30%\nTesting\t15%\nWrite-up\t15%");
  // The rubric's names don't look like graded work, so the lines win; the table stays on offer.
  assert.deepEqual([weights(rubric), rubric.source.kind, rubric.others.length], [["Homework 30", "Midterm 30", "Final 40"], "lines", 1]);
  assert.ok(rubric.unsure.includes("other tables have weights"), rubric.unsure.join("; "));
  const time = parseSyllabus("Grading\nHomework 300 points\nMidterm 300 points\nFinal 400 points\n\nWhere your time goes\nActivity\tShare\nLectures\t30%\nReading\t30%\nProblem sets\t40%");
  assert.equal(time.source.kind, "table");
  assert.ok(time.unsure.some((u) => u.includes("the lines under “Grading” have weights too")), time.unsure.join("; "));
  const plain = parseSyllabus("Grading\nCategory\tWeight\nHomework\t30%\nMidterm\t30%\nFinal\t40%");
  assert.deepEqual([plain.source.kind, plain.unsure], ["table", []]);
});

test("list shapes: \"A = 60%, B = 40%\", dashes for bullets, Word bullets, weights in brackets", () => {
  assert.deepEqual(weights(parseSyllabus("Written Examination = 60%, Coursework = 40%")), ["Written Examination 60", "Coursework 40"]);
  const dashed = parseSyllabus("Requirements - Participation (10%) - Homework (10%) - Quizzes (10%): one quiz (5% each) before each exam - Midterm (30%) and Final (40%) Exams: 4/18 and 6/6.");
  assert.deepEqual([weights(dashed), dashed.unsure], [["Participation 10", "Homework 10", "Quizzes 10", "Midterm 30", "Final 40"], []]);
  assert.deepEqual(weights(parseSyllabus("o Midterms 45%\no Final exam 35%\no Paper 20%")), ["Midterms 45", "Final exam 35", "Paper 20"]);
});

test("one category, or a point scale, is never read with confidence", () => {
  const r = parseSyllabus("Grading: On a 1000 point scale, this is the grading system:\nHomework (15 weeks) 180 1000 - 901 A\nLabs 180 900 - 801 B\nTotal points 1000");
  assert.ok(!r.items.length || r.unsure.length, weights(r).join(", "));
  assert.ok(parseSyllabus("Final exam 100%").unsure.includes("only one category was found"));
});

test("drop lowest: counts read from notes", () => {
  const cases = {
    "drop lowest 2": 2, "lowest dropped": 1, "Two dropped": 2, "best 5 of 7": 2, "best 10 out of 12 quizzes": 2,
    "the lowest two quiz grades will be dropped": 2, "I will drop your lowest 2 HW scores when compiling final grades": 2,
    "10 pts each - low score dropped": 1, "lowest two dropped, no late quizzes": 2,
    // Not a countable drop of scores.
    "drops one letter grade per day late": null, "you may drop the course": null, "No exam scores will be dropped": null,
    "Add in your 10 best quiz scores": null, "lowest experiment report grades will be dropped": null,
    "In-Class Assignment 3 4,6 grade is dropped": null, "Your lowest midterm will be replaced by the final": null,
  };
  for (const [note, n] of Object.entries(cases)) assert.equal(dropOf(note), n, note);
});

test("drop lowest: a note sets the drop of its own row, or of the category a later sentence names", () => {
  const drops = (r) => r.items.map((i) => `${i.name} ${i.drop ?? 0}`);
  assert.deepEqual(drops(parseSyllabus("Homework: 30% (drop lowest 2)\nQuizzes: 20%\nFinal Exam: 50%")), ["Homework 2", "Quizzes 0", "Final Exam 0"]);
  const page = parseSyllabus("Homework 30%\nFinal 40%\nParticipation 30%\nThe lowest homework score will be dropped and will not count towards the final grade.\nYour lowest problem set will be dropped.");
  assert.deepEqual(drops(page), ["Homework 1", "Final 0", "Participation 0"]);
  assert.deepEqual(drops(parseSyllabus("```\n- **Homework**: 30% (drop lowest 2)\n- **Final Exam**: 70%\n```")), ["Homework 2", "Final Exam 0"]);
});
