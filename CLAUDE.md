# CLAUDE.md — LA FORJA working conventions

## 0. Positioning — READ THIS FIRST (supersedes the frozen spec's framing)

LA FORJA is an adversarial learning studio for **high-school and college mathematics**. It is
**exam-agnostic** and not tied to any single country, exam or examining body.

**The frozen spec `docs/LA_FORJA_v6_final.md` remains the source of truth for the MECHANISM** — the state
machine, the check taxonomy, the evidence contracts, the probe formulas, the rubric, the eval design. Its
**POSITIONING has been superseded by an owner decision**: the product was previously anchored to Chile's PAES
exam and to DEMRE. That anchoring is **removed**. The spec itself supports the change — §12 states *"The
mechanism is exam-agnostic"* — and the owner authored the spec.

Consequences a future session must not undo:

- **Do not reintroduce PAES / DEMRE / Chile-as-scope** from the frozen doc, from git history, or from an older
  README. If you find such a reference, it is a bug — remove it.
- The **credibility nuance** the owner wants kept: the domain expertise is real and worth stating, but as
  *evidence of expertise*, never as *scope*. Write "designed against the constraints of a real high-stakes
  exam, built to be exam-agnostic". Never write "our first proving ground is <country/exam>" or anything that
  implies the product serves one country or one test.
- **There is no official taxonomy in play any more.** The old convention "reference the official taxonomy by
  label with attribution" existed only because of DEMRE and has been **deleted**, not restated. The legal
  story is now simply: team-authored originals under CC-BY (see §9.5).
- The demo discipline stays **probability only** — universal in high-school/college math, and small enough to
  actually finish.

**`docs/` is git-ignored by owner decision.** The spec contains internal deadlines, draft submission copy and
jury notes that are not part of the public repo. Many comments across the tree still cite it as
`doc §N` for local work. **A fresh clone will NOT contain that file** — never assume it is on disk, never
block on reading it, and keep every stub comment self-contained enough to implement without it.

Everything else in this file (mechanism, ownership, conventions) is unchanged by the pivot.

---

## 1. What this is

Students author multiple-choice mathematics items; three concurrent GPT-5.6 reviewers attack each item under
explicit evidence contracts; an accepted counterexample forces a repair (v1 → v2); the **full** check history
is re-run on every new version; a short written defense is scored against an explicit rubric; and only then
does the item publish with an auditable passport.

Built for OpenAI Build Week, Education track. Where this file and the frozen doc disagree on **mechanism**,
the doc is right and this file is a bug. Where they disagree on **positioning**, §0 above wins.

---

## 2. The Claude / Codex split

### Why it exists

Hackathon rules require the **core functionality to be built in OpenAI Codex sessions**, and the
**`/feedback` Session ID is mandatory in the submission**. Judges audit that. So the split is a compliance
boundary, not a style preference:

- **Claude** — scaffolding, structure, schemas, types, prompt text, tooling, configs, CI, docs, fixtures,
  presentation, HTTP envelopes, test skeletons.
- **Codex** — every piece of core behaviour: state machine internals, reviewer model calls, orchestration,
  adjudication, solver, item probe, defense rubric scoring, passport assembly, eval runner.

Claude must **never** implement a Codex-owned internal, even when it is a five-line function.

### File ownership (verified against the current tree)

**Claude-owned — implemented, treat as stable and import from it:**

| Path | Contents |
|---|---|
| `src/core/types.ts` | `ITEM_STATES`, `CHECK_CLASSES`, `REVIEWER_TYPES`, `CHECK_STATUS`, `STATE_EVENTS`, contract types, `RUBRIC_DIMENSIONS`, `DEFENSE_PUBLISH_MIN_TOTAL` |
| `src/config/models.ts` | `ALLOWED_MODEL_IDS`, `isCompliantModel`, `evaluateModels`, `loadModelConfig`, `assertRuntimeCompliance`, `assertEvalCompliance` |
| `src/reviewers/schemas.ts` | every Zod schema for model I/O + `REVIEWER_SCHEMAS` |
| `src/reviewers/guardrails.ts` | `GUARDRAIL_PREAMBLE`, `DELIMITER_NOTE` |
| `src/db/client.ts` | `prisma` singleton, `toJson`, `fromJson` |
| `src/demo/isolation.ts` | session cookie + auto-reset, input size caps, rate limiter, pseudonyms, API error helpers |
| `src/eval/types.ts` | `SMOKE_CATEGORIES`, `SmokeItemSchema`, `EVAL_CONFIGS`, `RUNS_PER_CONFIG`, `EvalReport` |
| `src/app/layout.tsx`, `src/app/globals.css` | app shell |
| `src/app/page.tsx` | server component: reads model config, hands the demo challenge to the studio |
| `src/app/StudioClient.tsx` | the whole studio UI — presentation and local state shapes only, **no business logic** |
| `src/app/api/session/route.ts` | fully implemented end to end (touches no Codex internal) |
| `prisma/schema.prisma`, `prisma/seed.ts` | data model + seeded demo item |
| `src/eval/smoke/**/*.json` | 16 authored smoke fixtures (8 dev + 8 holdout) |
| `scripts/secret-scan.mjs`, `.githooks/pre-commit`, `.github/workflows/ci.yml` | tooling + CI |
| `tests/**`, root configs, `docs/`, this file | tests and tooling |

**Mixed files — Claude wrote the envelope, Codex fills the marked function:**

| Path | Claude (done) | Codex fills |
|---|---|---|
| `src/app/api/gauntlet/route.ts` | session, rate limit, size caps, Zod, ownership check, typed errors, compliance record, NDJSON streaming scaffolding | `runGauntletPipeline` |
| `src/app/api/repair/route.ts` | session, rate limit, Zod, immutability guard, by-class response grouping | `applyRepair` |
| `src/app/api/defense/route.ts` | session, rate limit, Zod, two-phase response contract | `issueDefenseQuestions`, `scoreDefenseAnswers` |
| `src/app/api/passport/[itemId]/route.ts` | session, rate limit, param validation, existence check | calls `buildPassport` |

**Codex-owned — function bodies currently `throw new Error('TODO(codex): …')`:**

| Path | Codex implements |
|---|---|
| `src/core/stateMachine.ts` | `TRANSITIONS` table, `reduce`, `canTransition` |
| `src/core/checks.ts` | `reRunCheck`, `reRunHistory` |
| `src/openai/client.ts` | `callModel` (Responses API, Zod-validate, retry once, telemetry) |
| `src/reviewers/ambiguity.ts` · `discipline.ts` · `distractors.ts` | the three reviewer calls |
| `src/reviewers/orchestrator.ts` | `runGauntlet` — concurrent calls, per-reviewer timeout |
| `src/reviewers/adjudication.ts` | `adjudicate` |
| `src/solver/probability.ts` | `reduceFraction`, `solveProbability` |
| `src/probe/itemProbe.ts` | `runItemProbe` |
| `src/defense/viva.ts` | `generateDefenseQuestions`, `scoreDefense` (`meetsPublishThreshold` is already Claude-provided and pure) |
| `src/passport/passport.ts` | `buildPassport` |
| `src/eval/run.ts` | `runConfig`, `writeResults`, `main` (`RESULTS_DIR` is fixed) |

In Codex-owned files, exported **types, signatures, constants and prompt text are Claude-owned and already
written**. Codex fills bodies; it should not need to redesign signatures.

### The stub convention

Every implementation point carries a precise, self-contained spec comment:

```ts
/**
 * TODO(codex): <what to implement, inputs, invariants, failure behaviour>
 * Reference: doc §N.
 */
export async function thing(...): Promise<T> {
  throw new Error('TODO(codex): implement …');
}
```

Rules: the stub **throws**, never returns a fake value — a silent placeholder can be mistaken for a working
feature. Because `docs/` is git-ignored (§0), the comment must be complete enough to implement from **without
the spec on disk**. Grep the punch-list with `grep -rn "TODO(codex)" src prisma`.

### Small dated commits

Judges audit evidence built **13–21 July**, and the README separates pre-existing work from work built in
that window. So: commit small and often, with real timestamps and messages that name the slice element being
built. Never squash a day of work into one commit. Never backdate.

---

## 3. The winning slice (doc §3) — this is the entire scope

1. One preloaded original item + editable form.
2. Three concurrent reviewers with schemas.
3. One accepted counterexample, visible.
4. One repair v1 → v2.
5. Re-run of a prior check.
6. One written defense question with a rubric.
7. A final passport.
8. Reproducible smoke eval.
9. One stable, isolated link.

Onboarding is repair-first: the first screen is **"Load demo challenge"**, not an empty form; authoring from
scratch unlocks afterwards (doc §4). Recorded metric: time to the first useful counterexample. No rankings.

**The seeded demo item** (`prisma/seed.ts`, mirrored as a render fallback in `src/app/page.tsx`) drives the
on-stage demo — the classic **two-children problem**, options 1/4 · 1/3 · 1/2 · 2/3, author key **B (1/3)**.
The planted defect is **ambiguity**: "at least one is a boy" → 1/3, "a specific child is a boy" → 1/2. Two
readings, two answers = a valid accepted counterexample.

**Language.** Code, comments, identifiers, docs, UI copy and narration are **English, always**. Item *content*
(stems, options, rationales) is a separate axis: it is authored text and carries no positioning claim — the
mechanism is language-agnostic. Check the fixtures for the language they are actually in rather than assuming;
do not attach a country or exam rationale to that choice.

---

## 4. Do NOT build (doc §3, out of slice)

appeals · third-party attacks · credits/reputation · mutable commons · accounts · audio · automated dual
hosting · PTC · multi-agent beta (permitted **only** as a measured eval variant flag) · rankings ·
`bank_probe` (doc §7.3 — needs a bank that does not exist).

These may appear **only as non-interactive roadmap text**. Never a live control, never a disabled button that
implies it nearly works, never a route. If it renders, it is prose.

---

## 5. Check taxonomy (doc §5) — three classes, three different promises

| Class | Examples | What is guaranteed |
|---|---|---|
| `deterministic` | schema invariants, count of correct answers, reproducible solver calculation, fixed-threshold heuristics | **Strict non-regression**: v2 cannot reintroduce the failure |
| `counterexample` | a concrete interpretation and the answer it yields | The construction is **re-executed** on v2; if it still holds, the version does not publish |
| `semantic` | plausibility of a distractor | **Re-adjudicated** every version; never described as an absolute guarantee; result visible in the passport |

Every new version re-runs the **full** history before publishing.

**The single authorized guarantee sentence** (doc §5 — use this rendering in README, UI and video; do not
paraphrase it):

> Every accepted check is re-run on each new version. The system guarantees execution of the history and
> non-regression of deterministic invariants; semantic judgments are re-adjudicated and remain visible in the
> passport.

---

## 6. Language rule (doc §2) — strictly enforced

**Present tense only for what actually works today. Everything else is labeled "next."** This applies to
README, UI copy, submission text and video narration. Nothing is described as working while it is a
`TODO(codex)` stub — and today **most of the runtime is a stub**, so most of it must be labeled "next". The
repositioning in §0 changes the framing only; it must not smuggle in a single new claim.

Forbidden phrasings — these are not stylistic preferences, they were audit findings:

| Never write | Always write | Why |
|---|---|---|
| "gold set" | **"labeled smoke set"** (author-labeled, declared) | "gold" implies independent labels; the same team designed the defects and the labels (doc §8) |
| "independent adjudicator" | **"separate adjudication step"**, with the correlated-error risk (Terra/Sol) declared | it is not independent (doc §6.2) |
| "the model does not explain" (in any language or variant) | the counterexamples, sources and verdicts do teach — say so | it is simply false (doc §0) |

The only permitted formulation of the AI's role (doc §0): *the AI does not generate the initial item and does
not hand over a canonical solution to copy; it returns challenges and evidence — the repair and the defense
belong to the student.*

---

## 7. GPT-5.6 compliance (non-negotiable) — verified against `src/config/models.ts`

- The runtime uses **only OpenAI gpt-5.6 models**. No non-OpenAI model anywhere in the runtime path — not as
  a fallback, not "just for local dev".
- **Never hardcode a model id in source.** Ids come from env through `src/config/models.ts`. Defaults:
  `REVIEWER_MODEL=gpt-5.6-terra`, `ADJUDICATOR_MODEL=gpt-5.6-sol`.
- **The guard is a fail-closed ALLOWLIST, not a prefix test.** `ALLOWED_MODEL_IDS = ['gpt-5.6',
  'gpt-5.6-terra', 'gpt-5.6-sol']`, and `isCompliantModel` is **exact membership** in that set. A prefix test
  such as `startsWith('gpt-5.6')` is unsafe — an arbitrary suffix smuggles a different model past the guard
  (`gpt-5.6-evil-actually-something-else` would report compliant). Adding a model means editing the allowlist,
  deliberately.
- **Four gates, deliberately different in strictness:**
  - `evaluateModels(env)` — pure; returns `{reviewerModel, adjudicatorModel, compliance, offending}`.
  - `loadModelConfig(env = process.env)` — startup. **Warns loudly, does not throw**, so a local checkout
    with a stale `.env` still boots. The `compliance` flag is persisted on `GauntletRun.compliance` and
    `ModelCall.modelFamilyOk`.
  - `assertRuntimeCompliance(modelId)` — **throws** at the model-call boundary. Call it with the exact id
    about to be dispatched, immediately before dispatch — not with a config object read earlier. This is the
    gate that makes "the runtime uses only gpt-5.6" true rather than aspirational.
  - `assertEvalCompliance(cfg)` — **throws**, so the eval runner cannot write any artifact produced by a
    non-gpt-5.6 model. It **recomputes** compliance from the model ids and never trusts the `compliance`
    field it was handed (a forged or stale config could carry `compliance:true` alongside foreign ids).
- **Every run log and eval artifact records the exact model id** — plus latency, tokens, prompt version and
  prompt hash (`ModelCall`).
- Multi-agent beta is an eval variant flag only (`MULTI_AGENT_VARIANT`, default false), never the primary
  path. The primary path is three concurrent Responses calls orchestrated in our own code (doc §7.4).

---

## 8. Repo conventions

**Stack.** Next.js 14 App Router · strict TypeScript · Prisma + SQLite · Zod · Vitest.

**Imports.** `moduleResolution: "Bundler"` → imports carry **no file extension**. Path alias `@/*` → `./src/*`
(configured in both `tsconfig.json` and `vitest.config.ts`).

**`noUncheckedIndexedAccess` is ON.** Any array/object index access yields `T | undefined`. Handle it with a
guard or a `??` fallback. Code that fails typecheck is not done.

**JSON columns.** Stored as **stringified `String`** with a `Json` suffix (`optionsJson`, `contractJson`,
`rubricJson`, `snapshotJson`, `diffJson`, `detailsJson`, `questionsJson`, `answersJson`, `rawJson`). Prisma's
SQLite JSON support is version-fragile; `String` keeps it portable. **Always cross the boundary with
`toJson` / `fromJson` from `src/db/client.ts`** so serialization is consistent and greppable.

**Enums.** There are no Prisma enums. State, check class, reviewer type and status are `String` columns backed
by the `as const` arrays in `src/core/types.ts` — the single source of truth — and validated with Zod.

**Zod validates ALL model I/O and ALL API request bodies.** No exceptions, no `as` casts across a trust
boundary.

**State machine.** States: `DRAFT`, `GAUNTLET`, `CHALLENGED`, `REGRESSION`, `DEFENSE`, `DEFENSE_INCONCLUSIVE`,
`PUBLISHED`, `DISPUTED`. Approved transitions (no others exist):

```
DRAFT      --SUBMIT_TO_GAUNTLET--> GAUNTLET
GAUNTLET   --CHECKS_ACCEPTED-----> CHALLENGED
GAUNTLET   --GAUNTLET_CLEAN------> DEFENSE
CHALLENGED --SUBMIT_REPAIR-------> REGRESSION          (creates a NEW ItemVersion)
REGRESSION --HISTORY_REGRESSED---> CHALLENGED
REGRESSION --HISTORY_CLEAN-------> DEFENSE
DEFENSE    --DEFENSE_PASSED------> PUBLISHED
DEFENSE    --DEFENSE_FAILED------> CHALLENGED
DEFENSE    --DEFENSE_EVALUATOR_FAILED--> DEFENSE_INCONCLUSIVE
DEFENSE_INCONCLUSIVE --DEFENSE_RETRY--> DEFENSE
PUBLISHED  --NEW_DISPUTE---------> DISPUTED
DISPUTED   --DISPUTE_REPAIR------> REGRESSION          (the "v2" path)
```

Published versions are **immutable** (`ItemVersion.immutable`). A repair is always a **new version**, never a
mutation.

**Defense rubric.** 3 dimensions × 0–2 with textual evidence each (`identifies_error`,
`explains_uniqueness`, `answers_variation`). Publish threshold: total ≥ `DEFENSE_PUBLISH_MIN_TOTAL` (4) **and**
no dimension at 0. An evaluator failure is `inconclusive` → `DEFENSE_INCONCLUSIVE`, returned as HTTP 200,
never a 500 and **never an auto-reject**.

**Tests.** Vitest; `vitest.config.ts` includes exactly `tests/**/*.test.ts`.

- Tests covering **Claude-owned** code must genuinely **pass**.
- Tests covering **Codex-owned** stubs use `describe.skip` / `it.skip` with **real, fully written, executable
  bodies**. CI stays green, and the skipped suites are the Codex punch-list — Codex deletes the `.skip` and
  the test must then run for real. Skipped bodies still have to **typecheck**, so no placeholder `any`.
- **Never unskip a Codex suite and never weaken a test to make it pass.**

**Eval layout.** Eval **code and fixtures** live under `src/eval/` (`run.ts`, `types.ts`, `smoke/dev/`,
`smoke/holdout/`). Eval **artifacts** are written to **`eval/results/` at the repo root** — this is the spec's
`/eval/results/` path, and it **is** version-controlled because it is evidence (doc §8, gate §13.4).
Dev fixtures develop prompts and are not reported as evaluation; holdout is what gets reported. Three configs
(`general-reviewer`, `gauntlet`, `gauntlet-no-adjudication`) × `RUNS_PER_CONFIG` = 3 runs each, identical
settings. Smoke categories: `clean` (measures false positives), `ambiguous`, `factual_error`, `cue_leak` —
4 items each. Report **exact counts, never grandiose percentages**.

---

## 9. Hard constraints

1. **Item text is untrusted input.** It is delimited in every prompt (`delimitItem`, `ITEM_OPEN`/`ITEM_CLOSE`
   from `src/openai/client.ts`, plus `GUARDRAIL_PREAMBLE`/`DELIMITER_NOTE`). Reviewers get **no write tools
   and no open network**. Input size is capped (`MAX_INPUT_CHARS`) and rate-limited per session.
2. **The AI never authors the initial item and never emits a canonical solution to copy.** It returns
   challenges and evidence. Counterexamples **may reveal the answer** — that is accepted by the spec, it is
   the point of a reproducible counterexample. Do not "fix" it.
3. **Every model call**: Zod-validate the output, **retry once**, then fail readably. Log model id, latency,
   tokens, prompt version and prompt hash per run (`ModelCall`). Partial reviewer failure must not break the
   experience (`Promise.allSettled` + per-reviewer timeout, doc §7.1).
4. **Evidence contracts** (doc §6.2): ambiguity is valid only if `answer_a !== answer_b`; a discipline verdict
   of `correct` requires a full citation (`source_id`, version/date, license, excerpt, relevance) — a bare
   `source_url` is not enough, and insufficient sourcing means `unverified`, never `correct`; distractor
   findings without evidence are labeled **hypothesis**. The separate adjudication step validates the
   contract, deduplicates, assigns status, and **abstains** on the unverifiable. "The model said so" is never
   final evidence.
5. **Licensing and provenance — simple, post-pivot.** Every item in this repo is a **team-authored original**,
   carrying **CC-BY** per file. No third-party exam content of any kind: no official item, passage, figure or
   answer key from any examining body. There is no official taxonomy to reference, so nothing is referenced
   under attribution. Tester contributions are private/ephemeral and **never published**. No claims about a
   future commons license.
6. **Secrets**: `.env.example` only, and it holds placeholders. Nothing secret in the client bundle. `.env*`
   is git-ignored. The pre-commit secret scan is wired and working: `scripts/secret-scan.mjs` runs on staged
   files via `.githooks/pre-commit` (pointed at by the `prepare` script) and over the whole tracked tree in
   CI with `--all`.
7. **Zero PII.** Random pseudonyms only. **No school, city, name, email or age field may exist in any schema,
   type, form, API body or database column.** Not nullable, not optional — absent. No audio, no persisted
   transcripts (rubric + counterexamples only). The passport is item-level, **never** student-level.
8. **Demo isolation** (doc §10, `src/demo/isolation.ts`): one session per visitor in an httpOnly SameSite=Lax
   cookie, auto-reset (`SESSION_TTL_MINUTES` — an expired session is **replaced**, never resurrected),
   preloaded data, commons as a read-only snapshot, no accounts. One judge must not be able to break another
   judge's demo. The rate limiter is an **in-memory, per-instance** map, sized for the single-instance public
   demo; a multi-instance deployment would need a shared store and is out of slice.

---

## 10. Commands

```bash
npm run dev          # next dev
npm run build        # next build
npm run start        # next start
npm run typecheck    # tsc --noEmit   (run db:generate first — @prisma/client is generated)
npm run test         # vitest run
npm run test:watch   # vitest
npm run db:generate  # prisma generate
npm run db:push      # prisma db push
npm run db:seed      # tsx prisma/seed.ts  — seeds the two-children demo item
npm run eval         # tsx src/eval/run.ts — writes to eval/results/ (refuses on non-gpt-5.6)
npm run secretscan   # node scripts/secret-scan.mjs   (add -- --all for the whole tree)
```

`npm run typecheck` needs `npm run db:generate` first, otherwise `@prisma/client` types are missing.

---

## 11. Current state, stated plainly

**Green baseline — keep it that way.** `tsc --noEmit` is clean. `npm test` reports **207 passed, 101 skipped**
across 9 test files (7 passing files, 2 fully skipped). The 101 skips are `describe.skip`/`it.skip` with real
executable bodies — they are the Codex punch-list, not dead code.

**Works today:** `src/core/types.ts`, `src/config/models.ts` (all four compliance gates),
`src/reviewers/schemas.ts`, `src/reviewers/guardrails.ts`, `src/db/client.ts`, `src/demo/isolation.ts`,
`src/eval/types.ts`, the Prisma schema and seed, the reviewer prompt text, all 16 smoke fixtures, the app
shell + `page.tsx` + `StudioClient.tsx` as presentation, `POST /api/session` end to end, the HTTP envelopes
of the other four routes, the secret scanner, the git hook and CI.

**Next (stub or absent), and must be described as "next" everywhere:** everything in the section 2 Codex
table throws `TODO(codex)` — the state machine, history re-run, the OpenAI client, all three reviewers,
orchestration, adjudication, the solver, the item probe, defense generation and scoring, passport assembly,
the eval runner. The gauntlet / repair / defense / passport routes return their stub error from the Codex
function inside them. There is **no `/api/rerun` route yet** although `StudioClient.tsx` declares the call
site. `eval/results/` contains only `.gitkeep` and a README — **no eval artifact has been produced**.
