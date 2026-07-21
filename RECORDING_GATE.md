# RECORDING GATE

# ⛔ IF ANY LINK IS MISSING, DO NOT RECORD — BUILD.

This file is the hard gate in front of the video (doc §13). The six questions below
are answered with **links and paths, never with prose**. An empty slot is a blocker,
not a caveat to narrate around. There is no partial pass: six filled slots, or we go
back to building.

**Positioning for every line of narration:** LA FORJA is an adversarial learning studio
for **high-school and college mathematics**, exam-agnostic and not tied to any country,
exam or examining body. The demo discipline is **probability** because it is universal at
that level. The domain expertise behind the design is real and may be stated — as
*expertise*, never as *scope*: "designed against the constraints of a real high-stakes
exam, built to be exam-agnostic." Never name a country or a single test as the product's
market, and never say anything of the form "our first proving ground is X."

---

## The six questions

### 1. Where is the state machine?

File path + tests.

- Implementation: `_______________________________________________`
- Transition table: `_______________________________________________`
- Tests (must be passing, not skipped): `_______________________________________________`
- Test run output: `_______________________________________________`

### 2. Where is each schema validated?

Path + one valid fixture and one invalid fixture, per schema.

| Schema | Validation site | Valid fixture | Invalid fixture |
|---|---|---|---|
| Ambiguity contract | `____________` | `____________` | `____________` |
| Discipline contract (incl. citation) | `____________` | `____________` | `____________` |
| Distractor contract | `____________` | `____________` | `____________` |
| Item probe result | `____________` | `____________` | `____________` |
| Defense rubric | `____________` | `____________` | `____________` |

- Test proving an invalid payload is rejected: `_______________________________________________`

### 3. Which exact check broke v1, and why does v2 pass?

Test + a real diff. Name the single check by id and class.

- Check id and class (deterministic / counterexample / semantic): `____________`
- The counterexample construction, in one line: `_______________________________________________`
- Test that reproduces the v1 failure: `_______________________________________________`
- Real v1 → v2 diff: `_______________________________________________`
- History re-run output on v2 (all classes, full history): `_______________________________________________`

### 4. Raw baseline and gauntlet results?

Raw JSON committed in the repo — not a screenshot, not a summary table.

- Baseline (`general-reviewer`) raw JSON: `_______________________________________________`
- Gauntlet raw JSON: `_______________________________________________`
- `gauntlet-no-adjudication` raw JSON: `_______________________________________________`
- All three configurations × 3 runs present? `____________`
- Holdout split only in the reported numbers (dev excluded)? `____________`
- Exact counts, not percentages, in whatever is shown on screen? `____________`

### 5. Cost and latency of that run?

The attached log for the exact run shown in the video.

- Run log: `_______________________________________________`
- Exact model ids recorded in it: `____________`
- p50 / p95 latency: `____________`
- Cost per item: `____________`
- Compliance flag `gpt-5.6` on every call in that log? `____________`

### 6. Can a judge repeat it without an account and without breaking another judge's demo?

Incognito URL + two simultaneous tabs.

- Public URL, opened in a private/incognito window: `_______________________________________________`
- Two simultaneous tabs verified independent (session isolation, no shared state): `____________`
- No account, no login, no PII field anywhere in the flow: `____________`
- Automatic session reset verified: `____________`
- Input size limit and rate limit verified: `____________`

---

## Pre-flight checklist (doc §11 video redlines)

Check every box before the first take. Any unchecked box is a re-shoot, not a
post-production fix.

- ☐ **Product on screen at least 80% of the runtime.** Slides, faces and title cards
  together stay under 20%.
- ☐ **English narration, or flawless English subtitles.** No half-translated
  voiceover, no auto-generated captions left uncorrected.
- ☐ **No copyrighted music.**
- ☐ **No third-party brands or logos on screen** — check the browser chrome, tabs,
  bookmarks and any open editor.
- ☐ **The magic moment lands inside the first 5 seconds**: the defective item and
  Start Gauntlet, opening on "Getting the right letter is not enough."
- ☐ **Only rows the README evidence matrix marks DONE are narrated in the present
  tense.** Everything else is said as "next", or not said at all.
- ☐ Eval language is conditional on the result: "We compared…", then the real counts,
  win or lose.
- ☐ Nothing forbidden is said: never "gold set" (it is a **labeled smoke set**), never
  "independent adjudicator" (it is a **separate adjudication step**), and never any
  variant of "the model does not explain".
- ☐ **The positioning is global**: high-school / college mathematics, exam-agnostic. No
  country, exam or examining body is named as the product's scope, on screen or in the
  narration. If the design origin is mentioned at all, it is framed as domain expertise —
  "designed against the constraints of a real high-stakes exam, built to be
  exam-agnostic" — and never as the market.
- ☐ **Every item shown is a team-authored original under CC-BY.** No third-party exam
  content of any kind on screen — no official item, passage, figure or answer key, and no
  official taxonomy label.
- ☐ The AI's role is stated in the authorized form: the AI does not generate the
  initial item and does not hand over a canonical solution; it returns challenges and
  evidence; the repair and the defense belong to the student.
- ☐ The non-regression promise is stated per class: strict for deterministic checks,
  re-executed for counterexamples, re-adjudicated and visible in the passport for
  semantic judgments. No blanket guarantee.
- ☐ No learning-outcome claim anywhere in the narration.
- ☐ The recording is a real continuous run. If a precomputed backup item is used at
  all, it is plan B only, and it is not presented as a live run.
- ☐ Zero PII on screen: pseudonyms only, no school, city, name, email or age.
- ☐ Roadmap items appear as non-interactive text only — no live controls for
  appeals, third-party attacks, reputation, accounts, rankings or a mutable commons.
- ☐ Runtime is 2:35.

---

**Final check before hitting record:** are all six question blocks above filled with
real links? If not — **do not record. Build.**
