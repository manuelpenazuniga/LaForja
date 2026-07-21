/**
 * LA FORJA — seed for the "Load demo challenge" onboarding (doc §4).
 *
 * OWNER: Claude (fixture data + wiring). The first screen is NOT an empty form:
 * the visitor receives an original, deliberately defective item, tries to identify
 * or repair the flaw, and watches the passport grow. Authoring from scratch is
 * unlocked afterwards.
 *
 * SCOPE: high-school / college MATHEMATICS, worldwide. The demo discipline is
 * PROBABILITY ONLY — universal in any high-school or introductory college
 * curriculum, so the slice reads the same to any audience. The mechanism itself
 * is exam-agnostic (doc §12); it was designed against the constraints of a real
 * high-stakes exam, but it is not tied to one.
 *
 * THE DEMO ITEM (team-authored original, CC-BY):
 * The classic two-children problem. The author marked 1/3, reasoning "at least one
 * is a boy". But the stem does not disambiguate, so a second reading (a specific
 * child is a boy) yields 1/2. Two readings, two answers ⇒ a VALID ambiguity
 * counterexample. This is what drives the whole slice on stage:
 *   v1 gauntlet → accepted counterexample → repair → v2 → history re-run →
 *   written defense → passport → PUBLISHED.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// The ambiguity is load-bearing: "one of them is a boy" is genuinely open in
// English between "at least one of the two is a boy" (⇒ 1/3) and a reference to
// one particular child (⇒ 1/2). Do not "clarify" this stem — the defect IS the
// demo. Any edit must preserve both readings and both answers.
const DEMO_STEM_SPLIT = {
  before: 'A family has two children. It is known that ',
  ambiguous: 'one of them is a boy',
  after: '. What is the probability that both children are boys?',
} as const;

const DEMO_STEM =
  DEMO_STEM_SPLIT.before + DEMO_STEM_SPLIT.ambiguous + DEMO_STEM_SPLIT.after;

const DEMO_OPTIONS = ['1/4', '1/3', '1/2', '2/3'];

const DEMO_RATIONALE =
  'Under the reading "at least one of the two is a boy", the sample space reduces to {BB, BG, GB} and only BB is favourable, so P = 1/3. The distractors capture real errors: 1/4 ignores the given information, 1/2 corresponds to the reading in which one particular child is fixed, 2/3 inverts the ratio.';

/** Random pseudonym (doc §6.4/§9): no PII, no school, no city. */
function randomPseudonym(): string {
  const adjectives = ['Lucid', 'Quiet', 'Sharp', 'Iron', 'Amber', 'Swift'];
  const nouns = ['Anvil', 'Ember', 'Forge', 'Quarry', 'Bellows', 'Ingot'];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)] ?? 'Iron';
  const n = nouns[Math.floor(Math.random() * nouns.length)] ?? 'Anvil';
  return `${a}${n}${Math.floor(Math.random() * 900) + 100}`;
}

async function main(): Promise<void> {
  const ttlMinutes = Number(process.env.SESSION_TTL_MINUTES ?? 30);

  const session = await prisma.session.create({
    data: {
      pseudonym: randomPseudonym(),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });

  const item = await prisma.item.create({
    data: {
      sessionId: session.id,
      discipline: 'probability',
      provenance: 'LA FORJA team-authored demo item. Original work, CC-BY-4.0.',
      // Doc §9: this IS a team item, so it is the one case that carries CC-BY and
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
      stem: DEMO_STEM,
      optionsJson: JSON.stringify(DEMO_OPTIONS),
      correctKey: 'B', // 1/3 — defensible only under one reading (that is the defect)
      authorRationale: DEMO_RATIONALE,
      immutable: false,
    },
  });

  // Wired through the named `ItemCurrentVersion` relation, so the pointer can no
  // longer dangle or reference another item's version.
  await prisma.item.update({
    where: { id: item.id },
    data: { currentVersion: { connect: { id: version.id } } },
  });

  console.log(`Seeded demo challenge: item=${item.id} version=${version.id}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
