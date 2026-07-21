# LA FORJA

**An adversarial learning studio.** OpenAI Build Week — Education track.

> Getting the right answer is not enough. Forge it, attack it, defend it.

LA FORJA is a designed workshop for **high-school and college mathematics**: students
author multiple-choice items, GPT-5.6 reviewers attack them with counterexamples, and an
item publishes only after a repair, a short written defense, and a re-run of its full
check history.

The mechanism is **exam-agnostic by design** (doc §12): it targets any multiple-choice
mathematics item, from any curriculum, in any country. It was designed against the
constraints of a real high-stakes exam — that is where the assessment expertise comes
from — and deliberately built to carry no dependency on that exam. The demo discipline
is **probability**, a universal high-school/college topic where ambiguous wording and
weak distractors are endemic.

The paragraph above describes a design. The runtime that would execute it is almost
entirely unimplemented — read the status note before anything else.

> **Role of the AI (the only authorized formulation):** the AI does not generate the
> initial item and does not hand over a canonical solution to copy. It returns
> challenges and evidence. The repair and the defense belong to the student.

---

### Read this before anything else — repository status

This repository is **scaffolding plus contracts**, not a working product yet. Every
row of the [evidence matrix](#evidence-matrix) is currently **unchecked**, so under
the project language rule (doc §2) this README describes almost everything as
**next**, not as something that works today.

Concretely, as of this commit:

- What **exists and runs today**: TypeScript types and the state/check/rubric
  vocabulary (`src/core/types.ts`), Zod evidence-contract schemas
  (`src/reviewers/schemas.ts`), the GPT-5.6 compliance guard
  (`src/config/models.ts`), prompt text and guardrail preambles, the Prisma data
  model (`prisma/schema.prisma`, `prisma/seed.ts`), eval types and all 16 authored
  smoke fixtures (`src/eval/smoke/`), small pure helpers
  (`reduceFraction`, `meetsPublishThreshold`, `toJson`/`fromJson`), and the test
  suite (285 passing, 101 skipped by design).
- What is a **stub**: every runtime behavior. The reviewers, the orchestrator, the
  separate adjudication step, the bounded solver, the deterministic item probe, the
  state machine reducer, the history re-run, the defense scorer, the passport
  builder and the eval runner are all `TODO(codex)` stubs that throw when called.
  Grep the punch-list with `grep -rn "TODO(codex)" src`.
- There is **no deployed URL, no recorded run, no eval result file and no video**
  yet.

Nothing below should be read as a claim that the gauntlet has found anything. It has
not been run.

---

## 1. Try it now

**Demo URL: `<PLACEHOLDER — no public deploy exists yet>`**

This is a placeholder, not a live link. When a deploy exists it will be pasted here
and verified in a private/incognito window before being cited anywhere.

Planned properties of that deploy (doc §10) — **next**, none of it is built:

- one isolated session per visitor, with automatic reset,
- preloaded demo data so the first screen is never an empty form,
- input size limits and per-session rate limiting,
- a read-only commons snapshot,
- no accounts, no PII.

The intended first-session flow is **"Load demo challenge"**: the visitor receives a
deliberately defective original item, repairs it, and watches the passport grow.
Creating an item from scratch unlocks afterwards. That onboarding is designed and
seeded (`prisma/seed.ts`) but the UI that renders it is **next**.

## 2. GIF

**`<PLACEHOLDER — docs/media/demo.gif, not yet recorded>`**

The slot is reserved for a single loop of the magic moment: two readings of the same
stem producing two different answers, shown as an accepted counterexample. It will be
captured from a real continuous run, not from a mock. Recording is gated by
[`RECORDING_GATE.md`](./RECORDING_GATE.md) — if any of its six links is missing, we
build instead of recording.

## 3. What it does NOT claim

This section is binding, and it stays true even after the matrix fills in.

- **No learning-outcome claim.** We do not claim La Forja improves learning. The
  prior literature (protégé effect — Chase et al. 2009; student-generated questions
  — PeerWise, n=603, correlational) makes it *plausible* that creating, criticizing
  and explaining questions deepens processing. We have not measured it. The declared
  next step is a study with humans.
- **The labeled smoke set is AUTHOR-LABELED, not gold.** The same team designed the
  defects and the labels. We call it a **labeled smoke set** everywhere; "gold" is
  reserved for independent labels. If blind review by an outside teacher is ever
  obtained, that is declared separately.
- **Adjudication is a separate step, not an independent one.** The design is a
  separate adjudication stage that validates each finding against its contract,
  deduplicates, assigns a status and abstains on what it cannot verify. Because the
  reviewer and the adjudicator are both GPT-5.6 models, **correlated error between
  them is a real and declared risk**. "The model said so" is never final evidence.
- **Semantic judgments are never an absolute guarantee.** Only deterministic checks
  carry a strict non-regression promise. Semantic judgments are re-adjudicated on
  every version and their result is shown in the passport as a judgment, not a proof.
- **We do not detect authorship.** If a student uses another AI to forge an item, we
  do not and cannot detect that. What we make observable is whether they can sustain
  concrete decisions under a written defense. The passport certifies the process of
  the item, never the person.
- **We do not claim coverage of any curriculum or exam.** The demo discipline is
  probability and nothing else. No claim is made that the check taxonomy generalizes to
  disciplines outside the bounded verifier's scope until that is measured.
- **Every item in this repository is a team-authored original.** No item bank, no
  passage and no answer key from any exam body is present, in whole or in part.
- **Everything in this repo today is unrun scaffolding**, per the status note above.

## 4. Architecture

The designed MVP pipeline (doc §7.1). Each stage below lists the real file that owns
it and whether that file executes today.

```text
Original item + author rationale
              │
              ▼
   Explicit parallel orchestration (own code)
     ├─ Responses call: ambiguity reviewer
     ├─ Responses call: discipline reviewer + bounded verifier
     └─ Responses call: distractor reviewer
              │  Promise.allSettled + per-reviewer timeout
              ▼
   Zod schema validation → deterministic item probes
              │
              ▼
       Separate adjudication step
              │
              ▼
 accepted check → repair v2 → full history re-run
              │
              ▼
 written defense → rubric → item passport → PUBLISHED
```

| Stage | File | Exported entry point | Status today |
|---|---|---|---|
| Evidence contracts (Zod) | `src/reviewers/schemas.ts` | `REVIEWER_SCHEMAS` | Written and executable |
| Untrusted-input guardrails | `src/reviewers/guardrails.ts` | `GUARDRAIL_PREAMBLE`, `DELIMITER_NOTE` | Written and executable |
| Ambiguity reviewer | `src/reviewers/ambiguity.ts` | `reviewAmbiguity` | Prompt written; call is a `TODO(codex)` stub |
| Discipline reviewer | `src/reviewers/discipline.ts` | `reviewDiscipline` | Prompt written; call is a `TODO(codex)` stub |
| Distractor reviewer | `src/reviewers/distractors.ts` | `reviewDistractors` | Prompt written; call is a `TODO(codex)` stub |
| Concurrent orchestration | `src/reviewers/orchestrator.ts` | `runGauntlet` | `TODO(codex)` stub |
| Separate adjudication step | `src/reviewers/adjudication.ts` | `adjudicate` | `TODO(codex)` stub |
| Deterministic item probe | `src/probe/itemProbe.ts` | `runItemProbe` | Thresholds published (`LENGTH_HIGH` 1.4, `LENGTH_LOW` 0.6, `OVERLAP_HIGH` 0.5); function is a `TODO(codex)` stub |
| Bounded discipline verifier | `src/solver/probability.ts` | `solveProbability` | `reduceFraction` works; solver is a `TODO(codex)` stub |
| State machine | `src/core/stateMachine.ts` | `reduce`, `canTransition` | Transition table and error type declared; reducer is a `TODO(codex)` stub |
| History re-run | `src/core/checks.ts` | `reRunCheck`, `reRunHistory` | `TODO(codex)` stub |
| Written defense + rubric | `src/defense/viva.ts` | `generateDefenseQuestions`, `scoreDefense` | `meetsPublishThreshold` works; model-backed scoring is a `TODO(codex)` stub |
| Item passport | `src/passport/passport.ts` | `buildPassport` | `TODO(codex)` stub |
| Model call wrapper | `src/openai/client.ts` | `callModel`, `delimitItem`, `promptHash` | Delimiters defined; the call is a `TODO(codex)` stub |
| Persistence | `prisma/schema.prisma`, `src/db/client.ts` | `prisma`, `toJson`, `fromJson` | Schema and helpers written |

**State machine (designed).** States: `DRAFT`, `GAUNTLET`, `CHALLENGED`, `REGRESSION`,
`DEFENSE`, `DEFENSE_INCONCLUSIVE`, `PUBLISHED`, `DISPUTED`. A repair always creates a
**new** `ItemVersion`; published versions are immutable. The approved transition table
lives in `src/core/types.ts` (`STATE_EVENTS`, `Transition`) and
`src/core/stateMachine.ts` (`TRANSITIONS`).

**Check taxonomy (doc §5)** — three classes, three different promises:

| Class | Example | Promise |
|---|---|---|
| Deterministic | schema invariants, solver recomputation, fixed-threshold heuristics | **Strict non-regression**: v2 cannot reintroduce the failure |
| Re-executable counterexample | a concrete interpretation and the answer it produces | The construction is re-executed on v2; if it still holds, the version does not publish |
| Semantic judgment | plausibility of a distractor | **Re-adjudicated** on every version; never described as an absolute guarantee; shown in the passport |

The authorized wording of the guarantee — this is the **design contract, not a
statement about running code**, because the re-run is still a stub:

> *Every repair re-runs all recorded counterexamples and checks. The system
> guarantees execution of the history and non-regression of deterministic
> invariants; semantic judgments are re-adjudicated and remain visible in the
> passport.*

**Explicitly out of scope** (roadmap only, and it may appear in the product solely as
non-interactive text, never as a live control): appeals, third-party attacks,
reputation/credits, a mutable commons, accounts, audio, PTC, the multi-agent beta
(except as a measured eval variant), rankings, `bank_probe`.

## 5. How we used GPT-5.6

The runtime is designed to use **only OpenAI gpt-5.6 models**. Defaults:
`REVIEWER_MODEL=gpt-5.6-terra`, `ADJUDICATOR_MODEL=gpt-5.6-sol`.

**Exact call sites** (all three are `TODO(codex)` stubs today — the call sites exist,
the calls do not run yet):

| Purpose | Path | Entry point |
|---|---|---|
| Three concurrent reviewer calls with per-reviewer timeout | `src/reviewers/orchestrator.ts` | `runGauntlet` |
| Separate adjudication step | `src/reviewers/adjudication.ts` | `adjudicate` |
| Adaptive written defense questions + rubric scoring | `src/defense/viva.ts` | `generateDefenseQuestions`, `scoreDefense` |
| Shared bounded call wrapper (Zod-validate, retry once, fail readable, log) | `src/openai/client.ts` | `callModel` |

**Sample run log: `<PLACEHOLDER — eval/results/sample-run.log, not yet generated>`.**
No run log exists because no model call has been made from this repo. When one
exists it will show, per call: exact model id, prompt version, prompt hash, latency
and tokens — the fields declared on `ModelCall` in `prisma/schema.prisma`.

**No model id is ever hardcoded in source.** Every id is read from env through
`src/config/models.ts`. That module is written and executable today:

- `isCompliantModel(id)` — true only when the id starts with `REQUIRED_MODEL_FAMILY`
  (`"gpt-5.6"`).
- `loadModelConfig(env)` — startup guard. On a non-compliant config it warns loudly
  and returns `compliance:false`; it does **not** throw, so local development still
  boots. The flag is persisted on every run and every model call.
- `assertEvalCompliance(cfg)` — hard gate. It **throws**, which is how the eval
  runner is required to **refuse to write any file to `eval/results/`** when the
  configured model family is not gpt-5.6. Results produced by another model family
  would be invalid submission evidence, so they must never reach disk. The refusal is
  specified at the top of `src/eval/run.ts`; wiring it into `writeResults` is part of
  the Codex punch-list.

**Untrusted input handling.** Item text is untrusted. It is delimited in every prompt
via `delimitItem` / `ITEM_OPEN` / `ITEM_CLOSE` in `src/openai/client.ts`, with the
preamble in `src/reviewers/guardrails.ts`. Reviewers get no write tools and no open
network.

## 6. How we built with Codex

**/feedback Session ID: `<PLACEHOLDER>`**

Role split, applied strictly and visible in the repo:

- **Product contracts, structure and evaluation criteria (human + Claude):** the
  evidence contracts, the check taxonomy and its three different promises, the state
  machine and its approved transitions, the schemas, the smoke-set format and
  fixtures, the compliance guard, tooling, docs and the test skeletons.
- **Codex implements the internals:** state machine reducer, reviewer calls, the
  bounded solver, the separate adjudication step, the deterministic item probe, the
  defense rubric scoring, the passport builder and the eval runner.

Every implementation point Codex owns is marked in-place with a precise
`// TODO(codex): <spec>` comment that states the intended behavior, not just the
signature. The punch-list is machine-readable:

```bash
grep -rn "TODO(codex)" src
```

The test suite is the second half of that punch-list. Tests covering already-working
code must pass; tests covering Codex-owned stubs are written out in full but marked
`describe.skip` / `it.skip`, so CI stays green and Codex's job is to delete the
`.skip`. The `tests/` directory exists and the suite runs green: **285 tests pass and
101 are skipped** — those 101 skips are exactly the Codex punch-list.

## 7. Evals

**Nothing has been evaluated yet.** This section describes the harness design and the
reporting rules it must follow; no result file exists.

- **Labeled smoke set** — never called a gold set. **16 original items are required**
  (4 clean, 4 ambiguous, 4 with a disciplinary error and a source, 4 with cue leak or
  weak distractors). **All 16 are authored today** — 8 in `dev/` and 8 in `holdout/`.
  All items are declared **author-labeled**: the same team designed both the defects
  and the labels.
- **Split** — `src/eval/smoke/dev/` is used to develop prompts and is **never
  reported as evaluation**; `src/eval/smoke/holdout/` is what gets reported.
- **Three configurations** (`EVAL_CONFIGS` in `src/eval/types.ts`):
  1. `general-reviewer` — a single general reviewer, the baseline;
  2. `gauntlet` — three specialized reviewers plus the separate adjudication step;
  3. `gauntlet-no-adjudication` — the three reviewers with adjudication skipped.
- **3 runs per configuration** (`RUNS_PER_CONFIG = 3`), with identical model,
  reasoning, context and budget, so run-to-run stability is visible.
- **We report exact counts, not percentages.** The shape is "found 13 of 16 planted
  defects in run 1, 14 in runs 2 and 3", alongside false positives on clean items,
  citation precision, schema-valid counts, p50/p95 latency and cost per item. See
  `EvalReport` in `src/eval/types.ts` — every field is a count or a raw measurement.
- **Raw artifacts are kept**: prompt hash, exact model id, timestamp and raw model
  outputs are written to `eval/results/` (`RESULTS_DIR` in `src/eval/run.ts`).
- Language is conditional on the outcome: we will say "we compared…" and show what
  happened, whether or not the gauntlet wins on every metric.

Single command (the runner is a `TODO(codex)` stub, so today it throws):

```bash
npm run eval
```

## 8. Local install

Requires Node.js >= 20.11.

```bash
npm install
cp .env.example .env.local     # then set OPENAI_API_KEY in .env.local
npm run db:generate
npm run db:push
npm run db:seed                # loads the demo challenge item
npm run typecheck
npm run test
npm run dev                    # http://localhost:3000
```

Notes, so the commands are not oversold:

- `npm run db:seed` seeds the demo challenge used by the "Load demo challenge"
  onboarding: a two-children probability item whose defect is **ambiguity** ("at
  least one is a boy" gives 1/3; "a specific child is a boy" gives 1/2 — two readings,
  two answers).
- `npm run dev` serves the root layout, the landing page and the studio shell. The
  page renders, but every action it offers is wired to a `TODO(codex)` stub, so the
  end-to-end flow is **next**. The API routes under `src/app/api/` exist as
  request/response scaffolding; their handler bodies are **next**.
- `npm run test` runs the suite: 285 pass, 101 are intentionally `describe.skip` /
  `it.skip` (the Codex punch-list). Those skipped bodies are written out in full.
- `npm run secretscan` and the pre-commit hook wiring referenced by `prepare` exist
  (`scripts/secret-scan.mjs`, `.githooks/pre-commit`).
- Never commit real secrets. `.env.example` is the only env file in git, and nothing
  secret may reach the client bundle.

## 9. Costs, limits, known failures

**Costs.** Unmeasured. Cost per item is a field in `EvalReport` and will be filled
from a real run; quoting a number before that would be invention.

**Limits, by design:**

- One discipline only in the demo: **probability**. The bounded verifier is a
  reproducible calculation, so nothing outside its scope can be verified — the
  verdict `unverified` is a legitimate, expected result and is never upgraded to
  `correct` without a sufficient source.
- A citation needs `source_id`, version/date, license, excerpt and relevance. A bare
  `source_url` is not enough. Without a sufficient source the verdict is
  `unverified`.
- Findings without evidence are labeled **hypotheses**, not defects.
- The item probe is deliberately small: alternative length and lexical overlap
  between stem and answer, with published thresholds. Grammatical congruence was cut
  (no demonstrable pure-code implementation that holds across natural languages) and
  `bank_probe` is out of the MVP entirely — answer-position distribution is a signal about a bank, not about an
  item, and no bank exists yet.
- Counterexamples may reveal the answer to the item. That is accepted by design: a
  counterexample without its answer is not reproducible.
- The defense uses 2 written questions and 3 rubric dimensions, scored 0–2 each, with
  a publication threshold of ≥4/6 and no dimension at 0. If the evaluator itself
  fails, the outcome is `DEFENSE_INCONCLUSIVE` — never an automatic rejection.

**Known failures and risks:**

- **Correlated error** between the reviewer and adjudicator models, both GPT-5.6.
  Declared, not solved.
- **False positives on clean items** are the metric we most expect to be
  uncomfortable. That is exactly why 4 clean items are in the smoke set, and their
  false-positive count is reported as an exact number.
- Reviewer calls can fail or time out. The design is `Promise.allSettled` with a
  per-reviewer timeout, so a partial failure degrades the result instead of breaking
  the session — that behavior is specified in `src/reviewers/orchestrator.ts` and is
  **not yet implemented**.
- Model output can fail schema validation. Every model call is specified to
  Zod-validate, retry once, then fail readably.
- The largest current risk is simply scope: as of this commit the slice is contracts
  and scaffolding, and the evidence matrix below is entirely unchecked.

## 10. Privacy and licenses

- **All items are team-authored originals under CC-BY, full stop.** Nothing is
  reproduced from any exam body, publisher or third-party item bank. Every smoke-set
  file carries its own `_license` and `_attribution` fields.
- **Tester contributions are private or ephemeral and are never published.** We make
  no claim about the license of any future commons — that requires terms, consent and
  a right of withdrawal, and is post-hackathon roadmap only.
- **Zero PII.** Authors are random pseudonyms. There is no school, city, name, email
  or age field in any schema, type, form or database column — including
  `prisma/schema.prisma`. There are no accounts.
- No audio and no persisted transcripts: only the rubric result and the
  counterexamples are stored.
- The passport is always at **item level**, never at student level.
- Secrets live only in `.env.example` as placeholders; a pre-commit secret scan is
  **next**.

---

## Evidence matrix

Rule (doc §2): Devpost, video and README use present tense **only** for rows marked
DONE. Everything else is presented as "next". **No box below is checked**, so nothing
in this repository may currently be narrated in the present tense.

A row without a working link is PLANNED. Some paths below are the intended location
of evidence that does not exist yet; those are marked *(not yet present)*.

| Capability | State | Required evidence (link/path, never prose) |
|---|---|---|
| End-to-end create→publish route | ☐ DONE ☐ PARTIAL ☐ PLANNED | Demo URL `<PLACEHOLDER>` + video timestamp `<PLACEHOLDER>` + `tests/e2e/createToPublish.test.ts` *(not yet present)* |
| Three reviewers with schemas | ☐ DONE ☐ PARTIAL ☐ PLANNED | `src/reviewers/orchestrator.ts` → `runGauntlet` · `src/reviewers/schemas.ts` → `REVIEWER_SCHEMAS` · `src/reviewers/{ambiguity,discipline,distractors}.ts` |
| v1→v2 history re-run | ☐ DONE ☐ PARTIAL ☐ PLANNED | `src/core/checks.ts` → `reRunHistory` + `tests/core/checks.test.ts` *(not yet present)* + real v1→v2 diff `<PLACEHOLDER>` |
| Labeled smoke eval | ☐ DONE ☐ PARTIAL ☐ PLANNED | `npm run eval` (`src/eval/run.ts`) + raw JSON in `eval/results/` *(not yet present)* + fixtures `src/eval/smoke/` (8 of 16 authored) |
| Stable isolated deploy | ☐ DONE ☐ PARTIAL ☐ PLANNED | Incognito-verified URL `<PLACEHOLDER>` |
| Bounded discipline verifier | ☐ DONE ☐ PARTIAL ☐ PLANNED | `src/solver/probability.ts` → `solveProbability` + fixture `src/eval/smoke/holdout/factual-error-002.json` |
| Defense rubric | ☐ DONE ☐ PARTIAL ☐ PLANNED | `src/reviewers/schemas.ts` → `DefenseRubricSchema` · `src/defense/viva.ts` → `scoreDefense` + a scored example `<PLACEHOLDER>` |

Recording is gated on this matrix and on [`RECORDING_GATE.md`](./RECORDING_GATE.md).

---

## Pre-existing vs built July 13–21

Separated with dated evidence, per doc §9.

**Pre-existing (before July 13, not built for this hackathon)**

- Assessment-design expertise from founding and running an edtech company in
  high-stakes exam preparation. That is **evidence of domain expertise, not the scope
  of this product**: the mechanism here was designed against the constraints of a real
  high-stakes exam and built to be exam-agnostic. No code, content, item bank or model
  asset from that prior work is present in this repository.
- Applied agent-security practice, reused here as a discipline — untrusted-input
  delimiting, no write tools for reviewers, isolation of the public demo — not as
  imported code.
- Published third-party research cited in §3 (Chase et al. 2009; the PeerWise
  study). Referenced only; nothing is reproduced.
- Off-the-shelf dependencies listed in `package.json` (Next.js, React, Prisma, Zod,
  Vitest, the OpenAI SDK).

**Built July 13–21 (everything in this repository)**

- The frozen specification: `docs/LA_FORJA_v6_final.md`.
- The domain vocabulary and state machine contract: `src/core/types.ts`,
  `src/core/stateMachine.ts`, `src/core/checks.ts`.
- The evidence contracts and reviewer prompts: `src/reviewers/`.
- The GPT-5.6 compliance guard and env contract: `src/config/models.ts`,
  `.env.example`.
- The persistence model and the seeded demo challenge: `prisma/schema.prisma`,
  `prisma/seed.ts`.
- The bounded solver, item probe, defense and passport scaffolding: `src/solver/`,
  `src/probe/`, `src/defense/`, `src/passport/`.
- The labeled smoke set format, harness types and the 8 authored fixtures:
  `src/eval/`.
- Project tooling and documentation: `package.json`, `tsconfig.json`,
  `vitest.config.ts`, `next.config.mjs`, this README and `RECORDING_GATE.md`.

Dated evidence is the commit history of this repository. Anything not listed above
is **next**.
