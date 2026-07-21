# `/eval/results/` — eval artifacts (submission evidence)

This directory holds the **raw artifacts** produced by the labeled smoke eval. It is
versioned **deliberately**: doc §8 requires the raw outputs to live in the repo, and
gate question §13.4 ("What is the raw result of the baseline and of the gauntlet?")
is answered with a link to a file in here, not with prose.

Nothing in this directory is generated at build time. Files land here only when the
runner is executed, and they are committed as evidence.

## Where the code lives

- Artifacts (this directory): `eval/results/` at the repo root — the spec's `/eval/results/`.
- Runner and fixtures: `src/eval/` (`src/eval/run.ts`, `src/eval/types.ts`,
  `src/eval/smoke/dev/`, `src/eval/smoke/holdout/`).

The split is intentional: `src/` is application code that the TypeScript build owns,
this directory is evidence that a judge reads directly.

## What every artifact records

One JSON file per configuration run (three configurations × three runs each), each
carrying the full `EvalReport` shape from `src/eval/types.ts`:

- **exact model id** — the literal string used for the calls, e.g. the value of
  `REVIEWER_MODEL` / `ADJUDICATOR_MODEL`, never a family name or a paraphrase;
- **prompt hash** — identifies the exact prompt text of the run;
- **timestamp** — ISO-8601, when the run happened;
- **exact counts** — items evaluated, defects planted, defects found, false positives
  on `clean` items, citations checked and citation precision, schema-valid over
  schema-total. Counts, never grandiose percentages (doc §8);
- **latency p50 / p95** — in milliseconds;
- **cost per item** — in USD;
- **raw model outputs** — kept verbatim, so a reader can re-derive every count above;
- **split** — `dev` or `holdout`. Items used to develop prompts are `dev` and are
  **not reported as evaluation**.

The set is a **labeled smoke set**, and it is **author-labeled**: the same team designed
the defects and the labels. That is declared in every fixture and must stay declared in
every report. It is never called a "gold set".

## Compliance rule (non-negotiable)

The runner **refuses to write anything into this directory when the model family is not
`gpt-5.6`**. `writeResults()` calls `assertEvalCompliance()` before touching the
filesystem and propagates the failure. Results produced by any other model family are
invalid evidence for this submission, so no artifact is written at all rather than
written and disclaimed.

Because the exact model id is recorded inside each artifact, the compliance claim is
checkable from the files in here alone.

## Reading an artifact

Filenames are `<timestamp>-<config>-run<N>.json`, where `<config>` is one of
`general-reviewer`, `gauntlet`, `gauntlet-no-adjudication`. Compare the same run index
across configurations to reproduce the baseline-versus-gauntlet comparison.

## Status

The directory is empty apart from this README and `.gitkeep`. Populating it is the
**next** step: `npm run eval` writes the artifacts here, and the exact counts from those
files — whatever they turn out to be — are what gets reported.
