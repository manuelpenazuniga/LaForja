/**
 * LA FORJA — about the project.
 *
 * OWNER: Claude (presentation only — static server component).
 *
 * The long read: why the forge exists, what it does, how it was built, and the
 * exact boundary of what runs today. Adapted from the team's own written
 * account. Positioning is exam-agnostic by owner decision: the domain
 * expertise is stated as evidence, never as scope. Language rule applies
 * throughout: nothing model-backed is described as having run live.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About — LA FORJA',
  description:
    'Why we built an adversarial learning studio: flip the direction of the ' +
    'AI interaction — the student builds, the AI attacks, the reasoning survives.',
};

const RUNS_TODAY: string[] = [
  'Isolated demo sessions — random pseudonyms, auto-reset, zero PII',
  'The 12-transition item lifecycle — every state change goes through one reducer',
  'A bounded solver returning exact reduced fractions with a trace',
  'The deterministic cue probe at its published thresholds',
  'The fail-closed history re-run: inconclusive never counts as a pass',
  'Repair as a new immutable version, and the frozen, auditable passport',
];

const KEY_GATED: string[] = [
  'Live calls by the three reviewers under their evidence contracts',
  'The separate adjudication step that accepts, rejects or abstains',
  'Written-defense question generation and rubric scoring',
  'Re-adjudication of semantic judgments on each new version',
  'The reproducible smoke eval — it has produced no artifacts yet',
];

export default function AboutPage() {
  return (
    <div className="ab">
      <header className="lp-nav">
        <Link className="lp-nav__brand" href="/">
          LA FORJA
        </Link>
        <nav className="lp-nav__links" aria-label="Site">
          <Link href="/">Home</Link>
          <a href="#boundary">What runs today</a>
        </nav>
        <Link className="lp-btn lp-btn--brand lp-nav__cta" href="/studio">
          Enter the studio
        </Link>
      </header>

      <main className="ab-main">
        <p className="lp-eyebrow">About the project</p>
        <h1 className="ab-title">
          In a world full of intelligence,
          <br />
          we should be forging <em>builders</em>.
        </h1>

        {/* ------------------------------------------------------ the spark */}
        <section className="ab-section">
          <h2>The spark</h2>
          <p>
            I have spent more than ten years preparing students for a national
            university entrance exam — first as a math-olympiad kid turned tutor,
            then as an engineer building an edtech platform for that exam. That
            means I have watched, from the front row, the fastest transformation
            in how students learn that I have ever seen.
          </p>
          <p>
            When AI arrived, something wonderful happened: students stopped
            getting stuck. The question that used to block them until the next
            class now gets unblocked in thirty seconds. But something quieter
            happened too. The same shortcut that unblocks them also lets them
            step around the problems that require real intellectual effort. They
            skip the slow maturation of concepts. They avoid the uncomfortable
            stretch where abstraction is built. They reach the answer without
            ever owning the reasoning.
          </p>
          <blockquote className="ab-pull">
            If students use AI as an answer machine, they will not learn. The
            tool is not the problem. The direction of the interaction is.
          </blockquote>
          <p>
            And there is a deeper question underneath, one every student deserves
            to hear: you are not graduating into the world you were prepared for.
            You are graduating into a world where intelligence is suddenly
            everywhere. So what kind of person becomes more valuable when
            everyone has access to intelligence? A person with agency. A person
            who builds.
          </p>
          <p>
            AI can democratize teaching — that part is already happening. The
            harder task is democratizing the skills students develop <em>with</em>{' '}
            AI. Everyone should know how to build, to argue, to defend an idea
            under pressure. If we only democratize answers, we will widen the
            very gap we promised to close. LA FORJA is our answer to that. It
            flips the direction of the interaction.
          </p>
        </section>

        {/* --------------------------------------------------- what it does */}
        <section className="ab-section">
          <h2>What it does</h2>
          <p>
            LA FORJA is an adversarial learning studio for high-school and
            college mathematics. Students do not answer questions here.{' '}
            <strong>They author them.</strong>
          </p>
          <p>
            A student writes a math item: the stem, the alternatives, and a
            rationale for every wrong option. Then the AI goes on the attack.
            Three reviewers with different evidence contracts search the item for
            ambiguity, mathematical errors, and weak distractors, while a
            deterministic probe checks for superficial answer cues. Every
            accepted finding must carry evidence — two conflicting readings that
            produce different answers, a cited source with the exact passage, or
            a reproducible heuristic. Never just a confidence score.
          </p>
          <p>
            The AI does not generate the item and it does not hand over a
            canonical solution to copy. It challenges. The student owns the
            repair. When the item survives, the student defends it in a short
            written defense scored on an explicit rubric: name the misconception
            your distractor captures, explain why the correct alternative is
            unique, hold up under a variation of the problem. Only then is the
            item published with a passport — provenance, challenges, revisions
            and rubric results, all auditable.
          </p>
          <p>
            Writing a good question demands deeper understanding than answering
            one. You must master the content, anticipate how others go wrong,
            and design distractors around real misconceptions. That is builder
            thinking, applied to mathematics — the skill we want every student
            to graduate with, not just the ones who can afford elite preparation.
          </p>
        </section>

        {/* -------------------------------------------------------- the flame */}
        <section className="ab-section">
          <h2>The flame we want to relight</h2>
          <p>
            When I was training for the national mathematics olympiad, we had a
            small online forum where students posted their solutions and proofs —
            and other students questioned them, poked at the weak steps, demanded
            rigor. Defending a solution methodologically, in front of peers who
            genuinely wanted to find the flaw, remains one of the richest
            learning experiences of my life.
          </p>
          <p>
            That forum is gone. LA FORJA is our attempt to recreate that
            experience for a new generation: a place where getting the right
            answer is not enough — where you forge your reasoning, watch it get
            attacked, repair it, and stand up to defend it. The mechanism was
            designed against the constraints of a real high-stakes exam, which is
            where the assessment expertise comes from, and it is deliberately
            exam-agnostic. The conviction is universal.
          </p>
        </section>

        {/* ----------------------------------------------------- how we built */}
        <section className="ab-section">
          <h2>How we built it</h2>
          <p>
            The architecture is deliberately boring where it should be boring:
            explicit concurrent model calls with timeouts, schema validation on
            every model output, a bounded deterministic solver for the demo
            topics, and an application-level state machine where published
            versions are immutable and every repair creates a new version that
            must re-run the full history of accepted checks. Deterministic checks
            can never regress. Reasoning becomes observable under challenge.
          </p>
          <p>
            We also authored a labeled smoke set of sixteen original items with
            seeded flaws, and an evaluation harness that compares a single
            general reviewer against the specialized gauntlet across repeated
            runs, reporting exact counts — false positives, latency, cost. It
            runs the moment a key exists; no number is reported anywhere that did
            not come from a real run, and so far none has.
          </p>
          <p>
            The hardest challenges were epistemological, not technical. Our first
            drafts overclaimed — guaranteed quality, AI that never explains. We
            ran the project through rounds of adversarial review and cut every
            claim we could not defend. Which is fitting, because that is exactly
            what LA FORJA asks of students. Formalizing what &ldquo;no
            regression&rdquo; honestly means forced us to classify checks into
            deterministic invariants, re-executable counterexamples, and semantic
            judgments that must be re-adjudicated. A model saying so is never
            final evidence in our system.
          </p>
          <blockquote className="ab-pull">
            The most valuable thing AI can add to education is not speed but
            resistance. Productive struggle is the mechanism of learning — and AI
            is astonishingly good at structuring it when you point it in the
            right direction.
          </blockquote>
        </section>

        {/* --------------------------------------------------- the boundary */}
        <section className="ab-section" id="boundary">
          <h2>Stated plainly: what runs today</h2>
          <p>
            The whole pipeline is implemented and pinned by offline tests against
            a fake model transport. No runtime API key has been available to this
            build, so no model-backed stage is presented as having run live, and
            the eval directory holds no artifact. This is the exact boundary.
          </p>
          <div className="lp-status">
            <div className="lp-status__col">
              <h3 className="lp-status__title lp-status__title--today">
                Runs today
              </h3>
              <ul>
                {RUNS_TODAY.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
            <div className="lp-status__col">
              <h3 className="lp-status__title lp-status__title--next">
                Gated on a runtime API key
              </h3>
              <ul>
                {KEY_GATED.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="ab-cta">
          <p>The best way to understand the forge is to break something in it.</p>
          <Link className="lp-btn lp-btn--brand lp-btn--lg" href="/studio">
            Enter the studio
          </Link>
        </section>
      </main>

      <footer className="lp-footer">
        <span>LA FORJA</span>
        <Link href="/">Home</Link>
        <span>Built for OpenAI Build Week · Education track</span>
        <span>All items team-authored · CC-BY</span>
      </footer>
    </div>
  );
}
