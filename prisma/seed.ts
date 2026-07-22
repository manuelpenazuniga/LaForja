/**
 * LA FORJA — seed for the "Load demo challenge" onboarding (doc §4).
 *
 * OWNER: Claude (fixture data + wiring). The first screen is NOT an empty form:
 * the visitor receives an original, deliberately defective item, tries to identify
 * or repair the flaw, and watches the passport grow. Authoring from scratch is
 * unlocked afterwards.
 *
 * SCOPE: high-school / college MATHEMATICS, worldwide. Four demo disciplines,
 * each with a BOUNDED DETERMINISTIC SOLVER (src/solver) that grounds the
 * discipline reviewer's numeric verdict — universal in any high-school or
 * introductory college curriculum, so the slice reads the same to any audience.
 * The mechanism itself is exam-agnostic (doc §12).
 *
 * THE DEMO ITEMS (team-authored originals, CC-BY-4.0) — each carries ONE
 * deliberate defect the gauntlet is meant to surface:
 *  - probability        : ambiguity (the classic two-children problem)
 *  - statistics         : ambiguity (unstated quartile convention → two IQRs)
 *  - triangle-similarity: factual_error (additive instead of multiplicative scaling)
 *  - geometry           : factual_error (diameter plugged in as the radius)
 * The probability item is the landing default and drives the on-stage flow:
 *   v1 gauntlet → accepted counterexample → repair → v2 → history re-run →
 *   written defense → passport → PUBLISHED.
 */
// Use the shared, adapter-aware client (src/db/client.ts): with TURSO_DATABASE_URL
// set it seeds the hosted Turso database, otherwise the local SQLite file. A bare
// `new PrismaClient()` would ignore the Turso adapter and always hit the file.
import { prisma } from '../src/db/client';
import type { DisciplineId } from '../src/core/types';

interface DemoSpec {
  discipline: DisciplineId;
  stem: string;
  options: string[];
  /** The key the author MARKED — deliberately the defective one. */
  correctKey: string;
  authorRationale: string;
}

// The probability ambiguity is load-bearing: "one of them is a boy" is genuinely
// open in English between "at least one of the two is a boy" (⇒ 1/3) and a
// reference to one particular child (⇒ 1/2). Do not "clarify" this stem — the
// defect IS the demo. Any edit must preserve both readings and both answers.
const PROBABILITY_STEM =
  'A family has two children. It is known that one of them is a boy. ' +
  'What is the probability that both children are boys?';

const DEMOS: DemoSpec[] = [
  {
    discipline: 'probability',
    stem: PROBABILITY_STEM,
    options: ['1/4', '1/3', '1/2', '2/3'],
    correctKey: 'B', // 1/3 — defensible only under one reading (that is the defect)
    authorRationale:
      'Under the reading "at least one of the two is a boy", the sample space reduces to {BB, BG, GB} and only BB is favourable, so P = 1/3. The distractors capture real errors: 1/4 ignores the given information, 1/2 corresponds to the reading in which one particular child is fixed, 2/3 inverts the ratio.',
  },
  {
    // Ambiguity: the interquartile range depends on an UNSTATED convention.
    // Exclusive (Moore–McCabe) gives 10; inclusive gives 7 — both are options,
    // so marking a single key without naming the convention is the defect.
    discipline: 'statistics',
    stem:
      'For the data set 3, 5, 7, 8, 12, 13, 14, 18, 21, what is the interquartile range (IQR)?',
    options: ['7', '10', '18', '6'],
    correctKey: 'B', // 10 — the exclusive-method IQR, marked as if it were the only answer
    authorRationale:
      'With n = 9 the median is 12. Using the exclusive (Moore–McCabe) method the lower half {3,5,7,8} gives Q1 = 6 and the upper half {13,14,18,21} gives Q3 = 16, so IQR = 10. The inclusive method instead gives Q1 = 7 and Q3 = 14, so IQR = 7. The distractors capture real errors: 18 is the full range (21 − 3), 6 is the exclusive Q1 mistaken for the IQR, and 7 is the inclusive-method IQR — which is exactly why marking 10 alone, with no convention stated, is ambiguous.',
  },
  {
    // Factual error: additive scaling. DE = AB + 2, so the author adds 2 to BC.
    // Similar triangles scale MULTIPLICATIVELY: k = DE/AB = 4/3, EF = BC·k = 12.
    discipline: 'triangle-similarity',
    stem:
      'Triangle DEF is similar to triangle ABC with vertex correspondence A→D, B→E, C→F. ' +
      'In triangle ABC, AB = 6, BC = 9, CA = 12. In triangle DEF, DE = 8. ' +
      'What is the length of EF?',
    options: ['11', '12', '13.5', '6.75'],
    correctKey: 'A', // 11 — the additive answer (9 + 2), the misconception
    authorRationale:
      'AB corresponds to DE, so the scale factor is k = DE/AB = 8/6 = 4/3, and EF = BC·k = 9·(4/3) = 12 (the correct answer). Marking 11 comes from additive reasoning: DE = 6 + 2, so EF = 9 + 2 = 11. The distractors capture real errors: 13.5 = 9·(12/8) uses non-corresponding sides, and 6.75 = 9·(6/8) inverts the ratio.',
  },
  {
    // Factual error: diameter used as the radius. A = π·r² with r = 7 gives ~154;
    // the marked 616 is π·14² (the diameter squared). Exercises the solver's
    // π / tolerance path (an irrational answer rounded to the nearest m²).
    discipline: 'geometry',
    stem:
      'A circular garden has a diameter of 14 meters. What is its area, to the nearest square meter? ' +
      '(Use π ≈ 3.14159.)',
    options: ['44', '49', '154', '616'],
    correctKey: 'D', // 616 — π·14², the diameter-as-radius error
    authorRationale:
      'The radius is 7 m, so the area is π·7² = π·49 ≈ 153.94, which rounds to 154 m² (the correct answer). Marking 616 comes from squaring the diameter instead of the radius: π·14² ≈ 616. The distractors capture real errors: 44 ≈ 2π·7 is the circumference (perimeter/area confusion), and 49 = 7² omits π entirely.',
  },
];

/** Random pseudonym (doc §6.4/§9): no PII, no school, no city. */
function randomPseudonym(): string {
  const adjectives = ['Lucid', 'Quiet', 'Sharp', 'Iron', 'Amber', 'Swift'];
  const nouns = ['Anvil', 'Ember', 'Forge', 'Quarry', 'Bellows', 'Ingot'];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)] ?? 'Iron';
  const n = nouns[Math.floor(Math.random() * nouns.length)] ?? 'Anvil';
  return `${a}${n}${Math.floor(Math.random() * 900) + 100}`;
}

async function seedDemo(sessionId: string, spec: DemoSpec): Promise<void> {
  // Idempotent PER DISCIPLINE: a hosted database seeded once, or re-seeded after
  // adding a discipline, must not stack duplicate templates. The template is the
  // team-authored copy (isTeamAuthored: true); visitor clones never set that flag.
  const existing = await prisma.item.findFirst({
    where: { isDemo: true, isTeamAuthored: true, discipline: spec.discipline },
  });
  if (existing) {
    console.log(`Demo challenge already present (${spec.discipline}): item=${existing.id} — skipping.`);
    return;
  }

  const item = await prisma.item.create({
    data: {
      sessionId,
      discipline: spec.discipline,
      provenance: 'LA FORJA team-authored demo item. Original work, CC-BY-4.0.',
      // Doc §9: these ARE team items, so they are the case that carries CC-BY and
      // may legitimately be published. Visitor copies inherit neither (they keep
      // the schema defaults: unlicensed-ephemeral, not publication-eligible).
      license: 'CC-BY-4.0',
      isTeamAuthored: true,
      publicationEligible: true,
      isDemo: true,
      state: 'DRAFT',
    },
  });

  const version = await prisma.itemVersion.create({
    data: {
      itemId: item.id,
      versionNumber: 1,
      stem: spec.stem,
      optionsJson: JSON.stringify(spec.options),
      correctKey: spec.correctKey,
      authorRationale: spec.authorRationale,
      immutable: false,
    },
  });

  // Wired through the named `ItemCurrentVersion` relation, so the pointer can no
  // longer dangle or reference another item's version.
  await prisma.item.update({
    where: { id: item.id },
    data: { currentVersion: { connect: { id: version.id } } },
  });

  console.log(`Seeded demo challenge (${spec.discipline}): item=${item.id} version=${version.id}`);
}

async function main(): Promise<void> {
  const ttlMinutes = Number(process.env.SESSION_TTL_MINUTES ?? 30);

  // One owner session holds every team-authored template. Reused across re-seeds
  // so adding a discipline does not spawn an orphan session each run.
  const session =
    (await prisma.session.findFirst({
      where: { items: { some: { isDemo: true, isTeamAuthored: true } } },
      orderBy: { createdAt: 'asc' },
    })) ??
    (await prisma.session.create({
      data: {
        pseudonym: randomPseudonym(),
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      },
    }));

  for (const spec of DEMOS) {
    await seedDemo(session.id, spec);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
