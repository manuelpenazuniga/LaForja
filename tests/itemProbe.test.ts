/**
 * LA FORJA — deterministic item probe spec (doc §7.3; deterministic check class, doc §5).
 *
 * CONVENTION (Claude/Codex split): runItemProbe() in src/probe/itemProbe.ts is
 * CODEX-owned. These suites contain the real acceptance assertions for that
 * implementation; nothing here is a placeholder.
 *
 * These tests PIN THE PUBLISHED FORMULAS AND THRESHOLDS. The thresholds are part of
 * the spec: LENGTH_HIGH = 1.4, LENGTH_LOW = 0.6, OVERLAP_HIGH = 0.5, all imported
 * from the source so a silent threshold change fails here.
 *
 *   (1) answer_length_ratio  = tokens(correct) / mean(tokens(all options))
 *       FLAG when ratio >= LENGTH_HIGH  OR  ratio <= LENGTH_LOW   (boundary INCLUSIVE)
 *   (2) lexical_overlap_score = |tokens(stem) ∩ tokens(correct)| / |tokens(correct)|
 *       FLAG when score >= OVERLAP_HIGH                            (boundary INCLUSIVE)
 *
 * TOKENIZATION CONTRACT (pinned below, in this order — it is load-bearing):
 *   a. split on whitespace after trim;
 *   b. case-fold, then REPLACE each run of non-alphanumeric characters WITHIN a token
 *      with a single neutral separator (TOKEN_SEPARATOR, "·") and drop separators at
 *      the token's edges. Punctuation is never SPLIT on, so the option "3/8" is ONE
 *      token ("3·8"), not the two tokens "3" and "8"; and it is never DELETED, so
 *      "3/8" stays distinct from the integer "38" and "1/4" from "14". Edge
 *      punctuation still effectively vanishes ("muestral," matches "muestral");
 *   c. length formula (1) counts tokens after (a) only — no stopword removal;
 *   d. overlap formula (2) removes STOPWORDS and compares SETS of unique tokens,
 *      so the denominator is the number of DISTINCT content tokens in the correct
 *      option, and an empty denominator scores 0 (never NaN).
 *
 * MVP SCOPE: length + overlap ONLY. No grammatical congruence, no position signal
 * (position is a bank signal; bank_probe is roadmap, doc §7.3).
 */
import { describe, expect, it } from 'vitest';

import {
  LENGTH_HIGH,
  LENGTH_LOW,
  OVERLAP_HIGH,
  STOPWORDS,
  runItemProbe,
} from '@/probe/itemProbe';
import type { ProbeInput } from '@/probe/itemProbe';

import clean001 from '@/eval/smoke/dev/clean-001.json';
import clean003 from '@/eval/smoke/dev/clean-003.json';
import clean002 from '@/eval/smoke/holdout/clean-002.json';
import clean004 from '@/eval/smoke/holdout/clean-004.json';
import cueLeak001 from '@/eval/smoke/dev/cue-leak-001.json';
import cueLeak003 from '@/eval/smoke/dev/cue-leak-003.json';
import cueLeak004 from '@/eval/smoke/holdout/cue-leak-004.json';

/** A stem with no content token in common with the synthetic options below. */
const NEUTRAL_STEM = 'Un enunciado neutro sin vocabulario compartido con las alternativas.';

function input(stem: string, options: string[], correctKey: string): ProbeInput {
  return { stem, options, correctKey };
}

// ---------------------------------------------------------------------------
// (1) answer_length_ratio — boundary is INCLUSIVE at LENGTH_HIGH and LENGTH_LOW.
// ---------------------------------------------------------------------------
describe('item_probe — answer_length_ratio, LENGTH_HIGH boundary (1.4)', () => {
  it('does NOT flag just below the boundary (7 / 5.25 = 1.333)', () => {
    // token counts: 5, 7 (correct), 5, 4 => sum 21, mean 5.25
    const result = runItemProbe(
      input(
        NEUTRAL_STEM,
        [
          'uno dos tres cuatro cinco',
          'alfa beta gamma delta epsilon zeta eta',
          'seis siete ocho nueve diez',
          'once doce trece catorce',
        ],
        'B',
      ),
    );

    expect(result.answer_length_ratio).toBeCloseTo(7 / 5.25, 10);
    expect(result.answer_length_ratio).toBeLessThan(LENGTH_HIGH);
    expect(result.answer_length_flag).toBe(false);
  });

  it('DOES flag exactly AT the boundary (7 / 5 = 1.4 — inclusive)', () => {
    // token counts: 4, 7 (correct), 4, 5 => sum 20, mean 5
    const result = runItemProbe(
      input(
        NEUTRAL_STEM,
        [
          'uno dos tres cuatro',
          'alfa beta gamma delta epsilon zeta eta',
          'cinco seis siete ocho',
          'nueve diez once doce trece',
        ],
        'B',
      ),
    );

    expect(result.answer_length_ratio).toBe(LENGTH_HIGH);
    expect(result.answer_length_flag).toBe(true);
  });

  it('DOES flag just above the boundary (7 / 4.75 = 1.474)', () => {
    // token counts: 4, 7 (correct), 4, 4 => sum 19, mean 4.75
    const result = runItemProbe(
      input(
        NEUTRAL_STEM,
        [
          'uno dos tres cuatro',
          'alfa beta gamma delta epsilon zeta eta',
          'cinco seis siete ocho',
          'nueve diez once doce',
        ],
        'B',
      ),
    );

    expect(result.answer_length_ratio).toBeCloseTo(7 / 4.75, 10);
    expect(result.answer_length_ratio).toBeGreaterThan(LENGTH_HIGH);
    expect(result.answer_length_flag).toBe(true);
  });
});

describe('item_probe — answer_length_ratio, LENGTH_LOW boundary (0.6)', () => {
  it('does NOT flag just above the boundary (3 / 4.75 = 0.632)', () => {
    // token counts: 5, 3 (correct), 5, 6 => sum 19, mean 4.75
    const result = runItemProbe(
      input(
        NEUTRAL_STEM,
        [
          'uno dos tres cuatro cinco',
          'alfa beta gamma',
          'seis siete ocho nueve diez',
          'once doce trece catorce quince dieciseis',
        ],
        'B',
      ),
    );

    expect(result.answer_length_ratio).toBeCloseTo(3 / 4.75, 10);
    expect(result.answer_length_ratio).toBeGreaterThan(LENGTH_LOW);
    expect(result.answer_length_flag).toBe(false);
  });

  it('DOES flag exactly AT the boundary (3 / 5 = 0.6 — inclusive)', () => {
    // token counts: 5, 3 (correct), 6, 6 => sum 20, mean 5
    const result = runItemProbe(
      input(
        NEUTRAL_STEM,
        [
          'uno dos tres cuatro cinco',
          'alfa beta gamma',
          'seis siete ocho nueve diez once',
          'doce trece catorce quince dieciseis diecisiete',
        ],
        'B',
      ),
    );

    expect(result.answer_length_ratio).toBe(LENGTH_LOW);
    expect(result.answer_length_flag).toBe(true);
  });

  it('DOES flag just below the boundary (3 / 5.25 = 0.571)', () => {
    // token counts: 6, 3 (correct), 6, 6 => sum 21, mean 5.25
    const result = runItemProbe(
      input(
        NEUTRAL_STEM,
        [
          'uno dos tres cuatro cinco seis',
          'alfa beta gamma',
          'siete ocho nueve diez once doce',
          'trece catorce quince dieciseis diecisiete dieciocho',
        ],
        'B',
      ),
    );

    expect(result.answer_length_ratio).toBeCloseTo(3 / 5.25, 10);
    expect(result.answer_length_ratio).toBeLessThan(LENGTH_LOW);
    expect(result.answer_length_flag).toBe(true);
  });

  it('scores a ratio of exactly 1 when every option has the same token count', () => {
    const result = runItemProbe(
      input(
        NEUTRAL_STEM,
        ['uno dos tres', 'alfa beta gamma', 'cuatro cinco seis', 'siete ocho nueve'],
        'B',
      ),
    );

    expect(result.answer_length_ratio).toBe(1);
    expect(result.answer_length_flag).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (2) lexical_overlap_score — boundary is INCLUSIVE at OVERLAP_HIGH.
// ---------------------------------------------------------------------------
describe('item_probe — lexical_overlap_score, OVERLAP_HIGH boundary (0.5)', () => {
  // Every fixture below keeps all four options at the same token count, so the
  // length flag stays false and the overlap assertion is isolated.
  it('does NOT flag below the boundary (2 of 5 correct-answer tokens echo the stem = 0.4)', () => {
    const result = runItemProbe(
      input(
        'Considere alfa y beta en el modelo descrito.',
        [
          'uno dos tres cuatro cinco',
          'alfa beta gamma delta epsilon',
          'seis siete ocho nueve diez',
          'once doce trece catorce quince',
        ],
        'B',
      ),
    );

    expect(result.lexical_overlap_score).toBeCloseTo(2 / 5, 10);
    expect(result.lexical_overlap_score).toBeLessThan(OVERLAP_HIGH);
    expect(result.lexical_overlap_flag).toBe(false);
    expect(result.answer_length_flag).toBe(false);
  });

  it('DOES flag exactly AT the boundary (2 of 4 = 0.5 — inclusive)', () => {
    const result = runItemProbe(
      input(
        'Considere alfa y beta en el modelo descrito.',
        [
          'uno dos tres cuatro',
          'alfa beta gamma delta',
          'cinco seis siete ocho',
          'nueve diez once doce',
        ],
        'B',
      ),
    );

    expect(result.lexical_overlap_score).toBe(OVERLAP_HIGH);
    expect(result.lexical_overlap_flag).toBe(true);
    expect(result.answer_length_flag).toBe(false);
  });

  it('DOES flag above the boundary (3 of 4 = 0.75)', () => {
    const result = runItemProbe(
      input(
        'Considere alfa, beta y gamma en el modelo descrito.',
        [
          'uno dos tres cuatro',
          'alfa beta gamma delta',
          'cinco seis siete ocho',
          'nueve diez once doce',
        ],
        'B',
      ),
    );

    expect(result.lexical_overlap_score).toBeCloseTo(3 / 4, 10);
    expect(result.lexical_overlap_flag).toBe(true);
  });

  it('is case-folded and punctuation-stripped before matching', () => {
    // "Espacio;" / "MUESTRAL," must match "ESPACIO" / "muestral," in the stem.
    const result = runItemProbe(
      input(
        '¿Cuál es el ESPACIO muestral, equiprobable de este experimento?',
        [
          'uno dos tres cuatro',
          'Espacio; MUESTRAL, equiprobable delta',
          'cinco seis siete ocho',
          'nueve diez once doce',
        ],
        'B',
      ),
    );

    expect(result.lexical_overlap_score).toBeCloseTo(3 / 4, 10);
    expect(result.lexical_overlap_flag).toBe(true);
  });

  it('removes STOPWORDS from the denominator, not just from the intersection', () => {
    // Correct option "el de la alfa beta": 5 whitespace tokens for the LENGTH
    // formula, but only 2 content tokens (alfa, beta) for the OVERLAP formula.
    // The stem echoes 1 of them => 1/2 = 0.5 (flag). Had stopwords been counted in
    // the denominator the score would be 1/5 = 0.2 and the cue leak would be missed.
    expect(STOPWORDS.has('el')).toBe(true);
    expect(STOPWORDS.has('de')).toBe(true);
    expect(STOPWORDS.has('la')).toBe(true);
    expect(STOPWORDS.has('alfa')).toBe(false);

    const result = runItemProbe(
      input(
        'Considere alfa en el modelo indicado.',
        [
          'uno dos tres cuatro cinco',
          'el de la alfa beta',
          'seis siete ocho nueve diez',
          'once doce trece catorce quince',
        ],
        'B',
      ),
    );

    expect(result.lexical_overlap_score).toBe(OVERLAP_HIGH);
    expect(result.lexical_overlap_flag).toBe(true);
  });

  it('scores 0 (never NaN) when the correct option has no content tokens at all', () => {
    const result = runItemProbe(
      input(
        'Considere alfa en el modelo indicado.',
        ['uno dos tres', 'el de la', 'cuatro cinco seis', 'siete ocho nueve'],
        'B',
      ),
    );

    expect(Number.isNaN(result.lexical_overlap_score)).toBe(false);
    expect(result.lexical_overlap_score).toBe(0);
    expect(result.lexical_overlap_flag).toBe(false);
  });

  it('treats a fraction option as ONE token: punctuation is normalized, never split', () => {
    // "3/8" must not become the tokens "3" and "8", or the stem's "3" would create
    // a phantom overlap on a perfectly clean numeric item.
    const result = runItemProbe(
      input('Una urna contiene 3 bolas rojas y 5 bolas azules.', ['3/8', '5/8', '3/5', '1/2'], 'A'),
    );

    expect(result.lexical_overlap_score).toBe(0);
    expect(result.lexical_overlap_flag).toBe(false);
    expect(result.answer_length_ratio).toBe(1);
    expect(result.answer_length_flag).toBe(false);
  });

  // -------------------------------------------------------------------------
  // REGRESSION (audit D2): the separator inside a token must be REPLACED, not
  // DELETED. Deleting it collapsed "1/4" to "14" and "3/8" to "38", so a stem
  // that merely mentioned the integer 14 scored an overlap of 1.0 against a
  // correct option of 1/4 and raised the cue-leak flag on a clean item. In a
  // mathematics product that is a live false-positive generator, and false
  // positives on clean items are exactly what the eval measures.
  // -------------------------------------------------------------------------
  it('does NOT collide the fraction "1/4" with the integer "14" in the stem', () => {
    const result = runItemProbe(
      input(
        'A spinner is divided into 14 sectors of equal area. What is the probability of landing on any one sector?',
        ['1/4', '1/7', '1/2', '1/3'],
        'A',
      ),
    );

    // Correct option has exactly one content token ("1·4"); the stem contains
    // "14" but not "1·4", so nothing is shared.
    expect(result.lexical_overlap_score).toBe(0);
    expect(result.lexical_overlap_flag).toBe(false);
  });

  it('does NOT collide the fraction "3/8" with the integer "38" in the stem', () => {
    const result = runItemProbe(
      input('A bag holds 38 counters of equal size.', ['3/8', '5/8', '1/8', '7/8'], 'A'),
    );

    expect(result.lexical_overlap_score).toBe(0);
    expect(result.lexical_overlap_flag).toBe(false);
  });

  it('still MATCHES a fraction against the same fraction in the stem (no echo is lost)', () => {
    // The other direction of the same defect: normalization must stay lossless
    // enough that a genuine echo is still detected.
    const result = runItemProbe(
      input('The probability of the first draw is 3/8. What is it for the second?', [
        '3/8',
        '5/8',
        '1/8',
        '7/8',
      ], 'A'),
    );

    expect(result.lexical_overlap_score).toBe(1);
    expect(result.lexical_overlap_flag).toBe(true);
  });

  it('keeps distinct punctuated tokens distinct while remaining ONE token each', () => {
    // "P(A)" and "PA" must not be the same content token, and neither may split.
    const collidesUnderDeletion = runItemProbe(
      input('Consider the quantity PA in the diagram.', [
        'uno dos tres cuatro',
        'P(A) beta gamma delta',
        'cinco seis siete ocho',
        'nueve diez once doce',
      ], 'B'),
    );

    expect(collidesUnderDeletion.lexical_overlap_score).toBe(0);
    expect(collidesUnderDeletion.lexical_overlap_flag).toBe(false);
    expect(collidesUnderDeletion.answer_length_ratio).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Real labeled-smoke-set fixtures (doc §8, author-labeled).
// ---------------------------------------------------------------------------
describe('item_probe — real smoke-set fixtures', () => {
  it('cue-leak-001 raises the deterministic length flag', () => {
    // Token counts: 4, 26 (correct, option B), 5, 6 => sum 41, mean 10.25.
    // ratio = 26 / 10.25 = 2.537 >= LENGTH_HIGH.
    const result = runItemProbe(
      input(cueLeak001.stem, cueLeak001.options, cueLeak001.correct_key),
    );

    expect(result.answer_length_ratio).toBeCloseTo(26 / 10.25, 10);
    expect(result.answer_length_flag).toBe(true);
  });

  it('cue-leak-001 scores its lexical overlap at 8/13 under the published formula', () => {
    // Derivation (content tokens = unique, case-folded, stopwords removed):
    //   correct (option B) => {it, number, cases, favorable, event, divided, by,
    //                          total, equiprobable, sample, space, random,
    //                          experiment} = 13
    //   stem               => {random, experiment, with, equiprobable, sample,
    //                          space, how, probability, event, defined, terms,
    //                          favorable, cases}
    //   intersection       => {cases, favorable, event, equiprobable, sample,
    //                          space, random, experiment} = 8
    //   score = 8 / 13 = 0.615 >= OVERLAP_HIGH (0.5)
    //
    // HISTORY, worth keeping: while this fixture was still in Spanish it scored
    // 4/11 = 0.364 and raised the LENGTH flag only, which contradicted its own
    // intended_defect claim of BOTH flags. That conflict was pinned here rather
    // than papered over, with a note that resolving it had to be a FIXTURE edit
    // and never a threshold or formula change. Translating the item to English
    // resolved it honestly: the reworded option echoes more of the stem, so the
    // overlap now clears the threshold on its own. Neither OVERLAP_HIGH nor the
    // formula moved — verify that before touching these numbers again.
    const result = runItemProbe(
      input(cueLeak001.stem, cueLeak001.options, cueLeak001.correct_key),
    );

    expect(result.lexical_overlap_score).toBeCloseTo(8 / 13, 10);
    expect(result.lexical_overlap_flag).toBe(true);
  });

  it('cue-leak-003 raises BOTH flags (ratio 20/8.75, overlap 9/13)', () => {
    // Token counts: 5, 20 (correct, option B), 6, 4 => sum 35, mean 8.75.
    //   ratio   = 20 / 8.75 = 2.286 >= LENGTH_HIGH.
    // Content tokens of option B (unique, stopwords removed) = {that, two, events,
    //   independent, so, probability, event, b, does, not, change, when, occurs} = 13.
    //   Note "that" is NOT a stopword in the published list; "are/the/of/a" are.
    // Echoed by the stem: {that, two, events, probability, event, b, does, when,
    //   occurs} = 9  =>  9 / 13 = 0.692 >= OVERLAP_HIGH.
    const result = runItemProbe(
      input(cueLeak003.stem, cueLeak003.options, cueLeak003.correct_key),
    );

    expect(result.answer_length_ratio).toBeCloseTo(20 / 8.75, 10);
    expect(result.answer_length_flag).toBe(true);
    expect(result.lexical_overlap_score).toBeCloseTo(9 / 13, 10);
    expect(result.lexical_overlap_flag).toBe(true);
  });

  it('cue-leak-004 raises BOTH flags (ratio 25/8, overlap 10/15)', () => {
    // Token counts: 3, 25 (correct, option B), 2, 2 => sum 32, mean 8.
    //   ratio   = 25 / 8 = 3.125 >= LENGTH_HIGH.
    // Content tokens of option B = {set, all, possible, outcomes, experiment, that,
    //   faces, 1, 2, 3, 4, 5, 6, fair, die} = 15. The digit tokens arrive as "1,",
    //   "2," ... in both stem and option; edge punctuation is dropped, so they
    //   normalize to bare "1", "2" ... and still match.
    // Echoed by the stem: {experiment, faces, 1, 2, 3, 4, 5, 6, fair, die} = 10
    //   => 10 / 15 = 0.667 >= OVERLAP_HIGH.
    const result = runItemProbe(
      input(cueLeak004.stem, cueLeak004.options, cueLeak004.correct_key),
    );

    expect(result.answer_length_ratio).toBeCloseTo(25 / 8, 10);
    expect(result.answer_length_flag).toBe(true);
    expect(result.lexical_overlap_score).toBeCloseTo(10 / 15, 10);
    expect(result.lexical_overlap_flag).toBe(true);
  });

  // The false-positive guard. Every clean fixture answers with a single-token
  // fraction, which is precisely the shape the D2 collision attacked: under the
  // old "delete the separator" normalization, clean-003's correct answer "1/3"
  // became "13" and would have collided with any stem mentioning 13 (its stem
  // mentions 12), and clean-004's "4/13" became "413". None of these may flag.
  it.each([
    ['clean-001', clean001],
    ['clean-002', clean002],
    ['clean-003', clean003],
    ['clean-004', clean004],
  ])('%s raises NEITHER flag (ratio 1.000, overlap 0.000)', (_id, fixture) => {
    const result = runItemProbe(input(fixture.stem, fixture.options, fixture.correct_key));

    // All four options are single-token fractions => ratio exactly 1.
    expect(result.answer_length_ratio).toBe(1);
    expect(result.answer_length_flag).toBe(false);
    expect(result.lexical_overlap_score).toBe(0);
    expect(result.lexical_overlap_flag).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism + MVP scope (no position, no grammatical congruence).
// ---------------------------------------------------------------------------
describe('item_probe — determinism and MVP scope', () => {
  const probeInput = input(cueLeak001.stem, cueLeak001.options, cueLeak001.correct_key);

  it('returns an identical result for the same input probed twice', () => {
    expect(runItemProbe(probeInput)).toEqual(runItemProbe(probeInput));
  });

  it('returns exactly the four ItemProbeResult keys — no extra signal is computed', () => {
    const result = runItemProbe(probeInput);

    expect(Object.keys(result).sort()).toEqual([
      'answer_length_flag',
      'answer_length_ratio',
      'lexical_overlap_flag',
      'lexical_overlap_score',
    ]);
  });

  it('computes NO position signal: moving the correct option changes nothing', () => {
    // Position of the correct answer is a BANK signal, not an item signal
    // (bank_probe is roadmap, doc §7.3). The same option set with the correct
    // answer in a different slot must produce an identical result.
    const options = [
      'uno dos tres cuatro',
      'alfa beta gamma delta epsilon zeta eta',
      'cinco seis siete ocho',
      'nueve diez once doce trece',
    ];
    const reordered = [
      'alfa beta gamma delta epsilon zeta eta',
      'uno dos tres cuatro',
      'cinco seis siete ocho',
      'nueve diez once doce trece',
    ];

    const atB = runItemProbe(input(NEUTRAL_STEM, options, 'B'));
    const atA = runItemProbe(input(NEUTRAL_STEM, reordered, 'A'));

    expect(atA).toEqual(atB);
  });

  it('computes NO grammatical-congruence signal: only length and overlap move the flags', () => {
    // Two options identical in token count and in stem overlap, differing only in
    // grammatical agreement with the stem, must score identically.
    const congruent = runItemProbe(
      input('Los eventos descritos son:', ['unos casos posibles', 'alfa beta gamma'], 'B'),
    );
    const incongruent = runItemProbe(
      input('Los eventos descritos son:', ['unos casos posibles', 'alfa beta gamma'], 'A'),
    );

    expect(congruent.answer_length_ratio).toBe(incongruent.answer_length_ratio);
    expect(Object.keys(congruent).sort()).toEqual(Object.keys(incongruent).sort());
  });
});
