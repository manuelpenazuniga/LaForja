# Labeled smoke set

**Name rule (mandatory):** this is a **labeled smoke set**, never a "gold set".
"Gold" is reserved for independent labels. These items are **author-labeled** —
the same team designed the defects *and* the labels. If a blind review by an
outside teacher is ever obtained, that is declared separately.

## Scope

The items are **high-school / college mathematics**, written in English. The demo
discipline is **probability only**, because probability is taught under the same
definitions everywhere and needs no local curriculum to be read.

The defect taxonomy these items exercise was designed against the constraints of a
real high-stakes exam — that is where the domain expertise comes from — but the
mechanism is **exam-agnostic** (doc §12). Nothing here is tied to one country, one
curriculum or one test, and no official taxonomy is referenced.

## Composition (doc §8)

16 original items, all team-authored, all CC-BY:

| Category | Count | What it measures |
|---|---|---|
| `clean` | 4 | **False positives** — a finding here is a false alarm |
| `ambiguous` | 4 | Two readings ⇒ two different answers |
| `factual_error` | 4 | The marked answer is wrong; a licensed source is attached |
| `cue_leak` | 4 | Length/lexical cue or weak (implausible) distractors |

## Split

- `dev/` — used to develop prompts. **Never reported as evaluation.**
- `holdout/` — the reported evaluation.

## Status

☑ All 16 items authored — 4 per category, split 2 `dev` + 2 `holdout` each
(8 dev / 8 holdout). `tests/smokeSet.test.ts` enforces that composition.

☐ **Math not yet independently verified.** Every answer was derived and cross-checked
at authoring time, but a second human pass over the arithmetic is required before any
of these numbers appear in a recording or in the submission. Until that happens the
evidence matrix row "Labeled smoke eval" stays **PARTIAL**, not DONE.

☐ The eval runner itself (`src/eval/run.ts`) is still a `TODO(codex)` stub, so no
results exist yet. The fixtures are ready; the harness is next.

## Measurable properties the fixtures must keep

Three items exist to trip `item_probe` (doc §7.3) deterministically. Their wording is
load-bearing, not decorative — an edit that reads better but drops a repeated term can
silently delete the defect the eval is supposed to catch:

- `cue-leak-001`, `cue-leak-003`, `cue-leak-004` — the correct option is conspicuously
  longer than the mean option length (`answer_length_ratio` ≥ `LENGTH_HIGH`) **and**
  echoes the stem's vocabulary (`lexical_overlap_score` ≥ `OVERLAP_HIGH`).
- `cue-leak-002` carries `intended_defect.type: "weak_distractor"` instead: its defect
  is that all three distractors are impossible probability values, so it is **not**
  expected to trip either probe flag.
- The `clean` items must trip **neither** flag. That is the false-positive floor.

Rewording any of these means recomputing both probe values by hand against the
published formulas and thresholds in `src/probe/itemProbe.ts`. Never adjust a
threshold or the stopword list to make a fixture pass.

## Licensing (doc §9)

Every file carries `_license` and `_attribution`. All 16 items are **originals
authored by the team**, published under CC-BY. No third-party item text is
reproduced and no external taxonomy is republished.

## Format

See `src/eval/types.ts` (`SmokeItemSchema`). Key fields:

- `correct_key` — the key the **author marked**. For `factual_error` items this is
  deliberately **wrong**; `intended_defect.true_answer` holds the real answer that
  the bounded solver must produce.
- `intended_defect` — `null` for `clean`; otherwise what the gauntlet is expected
  to find. Scoring counts a defect as found only when the finding matches the
  expected type **and** carries a valid evidence contract.
- `source` — required for `factual_error` (full citation object).
