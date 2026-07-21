/**
 * LA FORJA — deterministic item probe (doc §7.3). MVP scope.
 *
 * OWNER: Codex (implementation). Two deterministic cue heuristics ONLY:
 *   (1) answer-length heuristic, (2) lexical overlap stem <-> correct answer.
 * NO grammatical congruence. NO position analysis (position is a BANK signal, not
 * an item signal — bank_probe is roadmap, doc §7.3). This is a `deterministic`
 * check class (doc §5): fixed thresholds, strict non-regression.
 *
 * PUBLISHED FORMULAS + THRESHOLDS (part of the spec; do not change silently):
 *
 *  (1) answer_length_ratio = len(correct_option) / mean(len(all_options))
 *      Tokenized by whitespace after trim; len = token count.
 *      FLAG (answer_length_flag = true) when ratio is an outlier:
 *          ratio >= LENGTH_HIGH  (correct option conspicuously LONGER)
 *       OR ratio <= LENGTH_LOW   (correct option conspicuously SHORTER)
 *
 *  (2) lexical_overlap_score = |tokens(stem) ∩ tokens(correct)| / |tokens(correct)|
 *      Case-folded, punctuation-stripped, stopwords removed (STOPWORDS below).
 *      FLAG (lexical_overlap_flag = true) when score >= OVERLAP_HIGH
 *      (correct answer echoes the stem — a cue leak).
 */

export const LENGTH_HIGH = 1.4; // correct option >= 1.4x mean length ⇒ flag
export const LENGTH_LOW = 0.6; // correct option <= 0.6x mean length ⇒ flag
export const OVERLAP_HIGH = 0.5; // >=50% of correct-answer tokens appear in the stem ⇒ flag

/**
 * Minimal stopword list for the lexical-overlap formula. Bilingual (English +
 * Spanish) so items authored in either language are tokenized the same way;
 * more languages are next. Published constant — tests pin its membership, so
 * extend deliberately, never silently.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'a', 'en',
  'y', 'o', 'que', 'es', 'son', 'se', 'su', 'con', 'por', 'para', 'al', 'lo',
  'si', 'no', 'the', 'a', 'an', 'of', 'is', 'are', 'to', 'in', 'and', 'or',
]);

export interface ProbeInput {
  stem: string;
  options: string[];
  correctKey: string; // e.g. "B"
}

import type { ItemProbeResult } from '../core/types';

/**
 * Computes the published length and lexical-overlap signals. Length uses raw
 * whitespace tokens, while overlap compares unique, normalized content tokens.
 * An unresolved answer key produces neutral scores instead of indexing an
 * absent option.
 */
export function runItemProbe(input: ProbeInput): ItemProbeResult {
  const normalizedKey = input.correctKey.trim().toUpperCase();
  const correctIndex =
    /^[A-Z]$/.test(normalizedKey) ? normalizedKey.charCodeAt(0) - 'A'.charCodeAt(0) : -1;
  const correctOption = input.options[correctIndex];

  if (correctOption === undefined) {
    return {
      answer_length_flag: false,
      lexical_overlap_flag: false,
      answer_length_ratio: 0,
      lexical_overlap_score: 0,
    };
  }

  const optionLengths = input.options.map((option) => whitespaceTokens(option).length);
  const meanOptionLength =
    optionLengths.reduce((total, length) => total + length, 0) / optionLengths.length;
  const correctLength = whitespaceTokens(correctOption).length;
  const answerLengthRatio = meanOptionLength === 0 ? 0 : correctLength / meanOptionLength;

  const stemTokens = contentTokenSet(input.stem);
  const correctTokens = contentTokenSet(correctOption);
  let sharedTokenCount = 0;

  for (const token of correctTokens) {
    if (stemTokens.has(token)) {
      sharedTokenCount += 1;
    }
  }

  const lexicalOverlapScore =
    correctTokens.size === 0 ? 0 : sharedTokenCount / correctTokens.size;

  return {
    answer_length_flag:
      answerLengthRatio >= LENGTH_HIGH || answerLengthRatio <= LENGTH_LOW,
    lexical_overlap_flag: lexicalOverlapScore >= OVERLAP_HIGH,
    answer_length_ratio: answerLengthRatio,
    lexical_overlap_score: lexicalOverlapScore,
  };
}

function whitespaceTokens(value: string): string[] {
  const trimmed = value.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/u);
}

function contentTokenSet(value: string): Set<string> {
  const tokens = whitespaceTokens(value)
    .map((token) => token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((token) => token !== '' && !STOPWORDS.has(token));

  return new Set(tokens);
}
