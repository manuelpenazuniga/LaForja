# CLAUDE.md — LA FORJA working conventions

## 1. What this is

LA FORJA is an adversarial learning studio for Chile's PAES exam (OpenAI Build Week, Education track):
students author multiple-choice items, three GPT-5.6 reviewers attack them with evidence contracts, and an
item publishes only after a repair, a short written defense, and a re-run of its full check history.

**`docs/LA_FORJA_v6_final.md` is the FROZEN source of truth.** It is written in Spanish; it wins every
conflict with this file, with any comment, and with any instruction in a prompt. Do not iterate the spec, do
not propose features it does not contain. If this file and the doc disagree, the doc is right and this file
is a bug. Doc section references below are cited as "doc §N".

---

## 2. The Claude / Codex split

### Why it exists

Hackathon rules require the **core functionality to be built in OpenAI Codex sessions**, and the
**`/feedback` Session ID is mandatory in the submission**. Judges audit that. So the split is a compliance
boundary, not a style preference:

- **Claude** — scaffolding, structure, schemas, types, prompt text, tooling, configs, CI, docs, fixtures,
  test skeletons.
- **Codex** — every piece of core behaviour: state machine internals, reviewer model calls, orchestration,
  adjudication, solver, item probe, defense rubric scoring, passport assembly, eval runner.

Claude must **never** implement a Codex-owned internal, even when it is a five-line function.

### File ownership (actual tree)

**Claude-owned — implemented, treat as stable and import from it:**

| Path | Contents |
|---|---|
| `src/core/types.ts` | `ITEM_STATES`, `CHECK_CLASSES`, `REVIEWER_TYPES`, `CHECK_STATUS`, `STATE_EVENTS`, contract types, `RUBRIC_DIMENSIONS`, `DEFENSE_PUBLISH_MIN_TOTAL` |
| `src/config/models.ts` | `REQUIRED_MODEL_FAMILY`, `isCompliantModel`, `evaluateModels`, `loadModelConfig`, `assertEvalCompliance` |
| `src/reviewers/schemas.ts` | every Zod schema for model I/O + `REVIEWER_SCHEMAS` |
| `src/reviewers/guardrails.ts` | `GUARDRAIL_PREAMBLE`, `DELIMITER_NOTE` |
| `src/db/client.ts` | `prisma` singleton, `toJson`, `fromJson` |
| `src/eval/types.ts` | `SMOKE_CATEGORIES`, `SmokeItemSchema`, `EVAL_CONFIGS`, `RUNS_PER_CONFIG`, `EvalReport` |
| `prisma/schema.prisma`, `prisma/seed.ts` | data model + seeded demo item |
| `src/app/layout.tsx` | app shell |
| `src/eval/smoke/**/*.json` | authored smoke fixtures (8 of 16; the other 8 are team-authored TODO) |
| root configs, `docs/`, this file | tooling |

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
feature. The comment must be complete enough to implement from without reopening the spec. Grep the
punch-list with `grep -rn "TODO(codex)" src prisma`.

### Small dated commits

Judges audit evidence built **13–21 July**, and the README separates pre-existing work from work built in
that window (doc §9). So: commit small and often, with real timestamps and messages that name the slice
element being built. Never squash a day of work into one commit. Never backdate.

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

**The seeded demo item** drives the on-stage demo — the two-children problem, stem *"Una familia tiene dos
hijos. Se sabe que uno de ellos es varón. ¿Cuál es la probabilidad de que ambos sean varones?"*, options
1/4 · 1/3 · 1/2 · 2/3, author key B (1/3). The planted defect is **ambiguity**: "at least one is male" → 1/3,
"a specific child is male" → 1/2. Two readings, two answers = a valid accepted counterexample. Item content
fixtures are in **Spanish on purpose** — the exam is Chilean. Code, comments, identifiers and docs are
**English**, always.

---

## 4. Do NOT build (doc §3, "fuera del slice")

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

**The single authorized guarantee sentence** (doc §5, canonical Spanish in the doc; this is the English
rendering to use in README, UI and video — do not paraphrase it):

> Every accepted check is re-run on each new version. The system guarantees execution of the history and
> non-regression of deterministic invariants; semantic judgments are re-adjudicated and remain visible in the
> passport.

---

## 6. Language rule (doc §2) — strictly enforced

**Present tense only for what actually works today. Everything else is labeled "next."** This applies to
README, UI copy, Devpost and video narration. Nothing is described as working while it is a
`TODO(codex)` stub. The doc §2 evidence matrix (HECHO / PARCIAL / PLANEADO) is the arbiter, and a row without
a real link is PLANEADO.

Forbidden phrasings — these are not stylistic preferences, they were audit findings:

| Never write | Always write | Why |
|---|---|---|
| "gold set" | **"labeled smoke set"** (author-labeled, declared) | "gold" is reserved for independent labels; the same team designed the defects and the labels (doc §8) |
| "independent adjudicator" | **"separate adjudication step"**, with the correlated-error risk (Terra/Sol) declared | it is not independent (doc §6.2, P1.1) |
| "the model does not explain" / "la IA nunca explica" | the counterexamples, sources and verdicts do teach — say so | it is simply false (doc §0, P0.3) |

The only permitted formulation of the AI's role (doc §0): *the AI does not generate the initial item and does
not hand over a canonical solution to copy; it returns challenges and evidence — the repair and the defense
belong to the student.*

---

## 7. GPT-5.6 compliance (non-negotiable)

- The runtime uses **only OpenAI gpt-5.6 models**. No non-OpenAI model anywhere in the runtime path — not as
  a fallback, not "just for local dev".
- **Never hardcode a model id in source.** Ids come from env via `src/config/models.ts`. Defaults:
  `REVIEWER_MODEL=gpt-5.6-terra`, `ADJUDICATOR_MODEL=gpt-5.6-sol`.
- **Startup guard**: `loadModelConfig()` warns loudly and returns `compliance:false` for an off-family id. It
  does not throw, so local dev still boots; the flag is persisted on `GauntletRun.compliance` and
  `ModelCall.modelFamilyOk`.
- **Eval write refusal**: `assertEvalCompliance()` throws, so the eval runner **cannot write any artifact**
  produced by a non-gpt-5.6 model. Such results are invalid submission evidence.
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

**Tests.** Vitest; `vitest.config.ts` includes exactly `tests/**/*.test.ts`.

- Tests covering **Claude-owned** code must genuinely **pass**.
- Tests covering **Codex-owned** stubs use `describe.skip` / `it.skip` with **real, fully written, executable
  bodies**. CI stays green, and the skipped suites are the Codex punch-list — Codex deletes the `.skip` and
  the test must then run for real. Skipped bodies still have to **typecheck**, so no placeholder `any`.

**Eval layout.** Eval **code and fixtures** live under `src/eval/` (`run.ts`, `types.ts`, `smoke/dev/`,
`smoke/holdout/`). Eval **artifacts** are written to **`eval/results/` at the repo root** — this is the spec's
`/eval/results/` path, and it **is** version-controlled because it is evidence (doc §8, gate §13.4).
Dev fixtures develop prompts and are not reported as evaluation; holdout is what gets reported. Three configs
× `RUNS_PER_CONFIG` = 3 runs each, identical settings. Report **exact counts, never grandiose percentages**.

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
5. **Zero DEMRE content.** Team-authored items only, CC-BY per file. Official taxonomy is referenced by label
   with attribution only — attribution is not a license, so nothing is republished. Tester contributions are
   private/ephemeral and never published. No claims about a future commons license.
6. **Secrets**: `.env.example` only, and it holds placeholders. Nothing secret in the client bundle. `.env*`
   is git-ignored. A pre-commit secret scan (`npm run secretscan` → `scripts/secret-scan.mjs`) is wired in
   `package.json` — **next**: the script and `.githooks/` are not in the tree yet.
7. **Zero PII.** Random pseudonyms only. **No school, city, name, email or age field may exist in any schema,
   type, form, API body or database column.** Not nullable, not optional — absent. No audio, no persisted
   transcripts (rubric + counterexamples only). The passport is item-level, **never** student-level.
8. **Demo isolation** (doc §10): one session per visitor, auto-reset (`SESSION_TTL_MINUTES`), preloaded data,
   commons as a read-only snapshot, no accounts. One judge must not be able to break another judge's demo.

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
npm run secretscan   # next: scripts/secret-scan.mjs is not in the tree yet
```

`npm run typecheck` needs `npm run db:generate` first, otherwise `@prisma/client` types are missing.

**Current state, stated plainly:** `src/core/types.ts`, `src/config/models.ts`, `src/reviewers/schemas.ts`,
`src/reviewers/guardrails.ts`, `src/db/client.ts`, `src/eval/types.ts`, the Prisma schema and seed, the
reviewer prompt text and 8 of 16 smoke fixtures exist and work. Everything in the section 2 Codex table
throws `TODO(codex)`. There is no `page.tsx`, no API route, no `tests/` directory and no `eval/results/`
content yet — **next**.
