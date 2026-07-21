/**
 * LA FORJA — seed for the "Load demo challenge" onboarding (doc §4).
 *
 * OWNER: Claude (fixture data + wiring). The first screen is NOT an empty form:
 * the visitor receives an original, deliberately defective item, tries to identify
 * or repair the flaw, and watches the passport grow. Authoring from scratch is
 * unlocked afterwards.
 *
 * THE DEMO ITEM (team-authored, CC-BY, zero DEMRE content):
 * The classic two-children problem. The author marked 1/3, reasoning "at least one
 * is male". But the stem does not disambiguate, so a second reading ("a specific
 * child is male") yields 1/2. Two readings, two answers ⇒ a VALID ambiguity
 * counterexample. This is what drives the whole slice on stage:
 *   v1 gauntlet → accepted counterexample → repair → v2 → history re-run →
 *   written defense → passport → PUBLISHED.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_STEM =
  'Una familia tiene dos hijos. Se sabe que uno de ellos es varón. ¿Cuál es la probabilidad de que ambos sean varones?';

const DEMO_OPTIONS = ['1/4', '1/3', '1/2', '2/3'];

const DEMO_RATIONALE =
  'Con la lectura "al menos uno es varón", el espacio se reduce a {VV, VM, MV} y solo VV es favorable, de modo que P = 1/3. Los distractores capturan errores reales: 1/4 ignora la información dada, 1/2 corresponde a la lectura en que se fija un hijo concreto, 2/3 invierte el cociente.';

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
      provenance: 'LA FORJA team-authored demo item. Original. Zero DEMRE content.',
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
