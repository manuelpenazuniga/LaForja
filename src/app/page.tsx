/**
 * LA FORJA — the landing page.
 *
 * OWNER: Claude (presentation only — static server component).
 *
 * This page tells the story and routes visitors to the studio at /studio and
 * the longer read at /about. It calls no API and holds no state. Every claim
 * obeys the language rule: present tense only for what runs today; every
 * model-backed stage is marked as gated on a runtime key. The guarantee
 * sentence is the single authorized rendering and must not be paraphrased.
 */
import Link from 'next/link';

const GUARANTEE_SENTENCE =
  'Every accepted check is re-run on each new version. The system guarantees ' +
  'execution of the history and non-regression of deterministic invariants; ' +
  'semantic judgments are re-adjudicated and remain visible in the passport.';

const AI_ROLE_SENTENCE =
  'The AI does not generate the initial item and does not hand over a canonical ' +
  'solution to copy; it returns challenges and evidence — the repair and the ' +
  'defense belong to the student.';

interface Station {
  code: string;
  title: string;
  copy: string;
  status: 'today' | 'gated';
  statusNote?: string;
}

const STATIONS: Station[] = [
  {
    code: 'FORGE',
    title: 'Start with a broken problem',
    copy: 'You load a team-authored item with a deliberate defect hidden in it. Repair-first: your first move is never an empty form.',
    status: 'today',
  },
  {
    code: 'GAUNTLET',
    title: 'Send it into the gauntlet',
    copy: 'Three AI reviewers and a deterministic probe attack the item at the same time, each bound to an evidence contract. A claim without evidence never counts.',
    status: 'gated',
    statusNote: 'the deterministic probe runs without a key',
  },
  {
    code: 'FRACTURE',
    title: 'Face the counterexample',
    copy: 'The strongest finding is not an opinion — it is two honest readings of your stem that force two different answers, shown so you can re-execute them yourself.',
    status: 'gated',
  },
  {
    code: 'HAMMER',
    title: 'Repair it — version 2',
    copy: 'You rewrite the stem so only one reading survives. A repair never overwrites: version 1 stays on record, and the full check history re-runs against version 2.',
    status: 'today',
    statusNote: 're-judging semantic checks needs the key',
  },
  {
    code: 'PROOF',
    title: 'Defend it in writing',
    copy: 'Fixing it is not enough — you show you understand why it was broken. Two written questions, scored on a three-part rubric with quoted evidence for every score.',
    status: 'gated',
  },
  {
    code: 'STAMP',
    title: 'Publish with a passport',
    copy: 'The surviving item ships with its diploma: every attack, every re-run, the verdicts, the rubric, every version. Auditable by anyone.',
    status: 'today',
  },
];

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
      <path d="M9.5 12l2 2 3.5-4" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h7l9 9-7 7-9-9V4z" />
      <circle cx="8.5" cy="8.5" r="1.5" />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" />
    </svg>
  );
}

function BracketsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 4H5v16h3" />
      <path d="M16 4h3v16h-3" />
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div className="lp">
      {/* ------------------------------------------------------------- nav */}
      <header className="lp-nav">
        <Link className="lp-nav__brand" href="/">
          LA FORJA
        </Link>
        <nav className="lp-nav__links" aria-label="Landing sections">
          <a href="#why">Why</a>
          <a href="#how">How it works</a>
          <a href="#promises">The promises</a>
          <Link href="/about">About</Link>
        </nav>
        <Link className="lp-btn lp-btn--brand lp-nav__cta" href="/studio">
          Enter the studio
        </Link>
      </header>

      {/* ------------------------------------------------------------ hero */}
      <section className="lp-hero">
        <div className="lp-hero__glow" aria-hidden="true" />
        <p className="lp-eyebrow">
          An adversarial learning studio · high-school &amp; college mathematics
        </p>
        <h1 className="lp-hero__title">
          Getting the right answer
          <br />
          is <em>not enough</em>.
        </h1>
        <p className="lp-hero__sub">
          Here you don&rsquo;t answer math problems — you build one, watch AI
          reviewers attack it with evidence, repair it, defend it in writing, and
          publish it with a passport that records the whole fight.
        </p>
        <div className="lp-hero__actions">
          <Link className="lp-btn lp-btn--brand lp-btn--lg" href="/studio">
            Enter the studio
          </Link>
          <a className="lp-btn lp-btn--ghost lp-btn--lg" href="#how">
            See how it works
          </a>
        </div>
        <p className="lp-hero__status">
          The studio, the seeded challenges, versioning and passports run today.
          Reviewer stages run live wherever a server API key is configured, and
          the studio shows that availability honestly instead of faking results.
        </p>

        {/* The signature: the real demo defect, shown as the construction it is. */}
        <figure className="lp-fork" aria-label="The demo challenge: one ambiguous stem, two readings, two different answers">
          <figcaption className="lp-fork__caption">
            The demo challenge — one stem, two defensible answers
          </figcaption>
          <p className="lp-fork__stem">
            A family has two children. It is known that{' '}
            <mark className="lp-fork__mark">one of them is a boy</mark>. What is
            the probability that both children are boys?
          </p>
          <div className="lp-fork__split" aria-hidden="true">
            <span className="lp-fork__drop" />
            <span className="lp-fork__arm lp-fork__arm--l" />
            <span className="lp-fork__arm lp-fork__arm--r" />
          </div>
          <div className="lp-fork__readings">
            <div className="lp-fork__reading">
              <span className="lp-fork__reading-label">Reading A</span>
              <p>&ldquo;At least one of the two is a boy&rdquo;</p>
              <span className="lp-fork__answer">1/3</span>
            </div>
            <span className="lp-fork__neq" aria-label="is not equal to">
              &ne;
            </span>
            <div className="lp-fork__reading">
              <span className="lp-fork__reading-label">Reading B</span>
              <p>&ldquo;One specific child is a boy&rdquo;</p>
              <span className="lp-fork__answer">1/2</span>
            </div>
          </div>
          <p className="lp-fork__verdict">
            Two readings, two answers: the item is broken. You repair it.
          </p>
        </figure>
      </section>

      {/* ------------------------------------------------------- the story */}
      <section className="lp-section" id="why">
        <div className="lp-story">
          <h2 className="lp-h2">Why a forge?</h2>
          <p className="lp-story__open">
            When AI arrived in classrooms, something wonderful happened: students
            stopped getting stuck. The question that used to block you until the
            next class now gets unblocked in thirty seconds. But something
            quieter happened too. The same shortcut that unblocks you also lets
            you step around the problems that demand real effort — the slow
            maturation of a concept, the uncomfortable stretch where abstraction
            is built. You reach the answer without ever owning the reasoning.
          </p>
          <blockquote className="lp-pull">
            If students use AI as an answer machine, they will not learn. The
            tool is not the problem. The direction of the interaction is.
          </blockquote>
          <p>
            And there is a harder question underneath, one every student deserves
            to hear: you are not graduating into the world you were prepared for.
            You are graduating into a world where intelligence is suddenly
            everywhere. So who becomes more valuable when everyone has access to
            intelligence? The person who can <strong>build</strong> — and defend
            what they built under pressure.
          </p>
          <p>
            That is why this studio is a forge and not a tutor. Here the AI never
            answers for you: <strong>you</strong> author the problem, the AI
            attacks it with evidence, and the repair and the defense are yours
            alone. Writing one good question demands deeper understanding than
            answering twenty — you must master the content, anticipate how others
            go wrong, and design every wrong option around a mistake a real
            student would make. Builder thinking, applied to mathematics.
          </p>
          <p className="lp-story__cta">
            <Link href="/about">Read the whole story →</Link>
          </p>
        </div>
      </section>

      {/* ----------------------------------------------- how it works: flow */}
      <section className="lp-section lp-section--tint" id="how">
        <div className="lp-section__head">
          <h2 className="lp-h2">One item, six stations</h2>
          <p className="lp-section__lede">
            Publication is earned, never granted. Follow one problem through the
            forge, top to bottom — each station leaves a record the passport
            keeps.
          </p>
        </div>
        <ol className="lp-flow">
          {STATIONS.map((station, index) => (
            <li className="lp-flow__step" key={station.code}>
              <div className="lp-flow__marker" aria-hidden="true">
                <span className="lp-flow__num">{index + 1}</span>
                {index < STATIONS.length - 1 ? (
                  <>
                    <span className="lp-flow__link" />
                    <span className="lp-flow__head" />
                  </>
                ) : null}
              </div>
              <div className="lp-flow__card">
                <div className="lp-flow__top">
                  <span className="lp-flow__code">{station.code}</span>
                  <span
                    className={
                      station.status === 'today'
                        ? 'lp-chip lp-chip--today'
                        : 'lp-chip lp-chip--gated'
                    }
                  >
                    {station.status === 'today' ? 'always on' : 'live with an API key'}
                  </span>
                </div>
                <h3 className="lp-flow__title">{station.title}</h3>
                <p className="lp-flow__copy">{station.copy}</p>
                {station.statusNote ? (
                  <p className="lp-flow__note">{station.statusNote}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        <p className="lp-role">{AI_ROLE_SENTENCE}</p>
      </section>

      {/* --------------------------------------------------------- promises */}
      <section className="lp-section lp-section--dark" id="promises">
        <div className="lp-section__head">
          <h2 className="lp-h2">Three kinds of checks, three different promises</h2>
          <p className="lp-section__lede">
            The studio never claims more than a check can keep. Each class carries
            its own promise, and the difference stays visible everywhere.
          </p>
        </div>
        <div className="lp-classes">
          <div className="lp-class" data-class="deterministic">
            <span className="lp-class__tag">deterministic</span>
            <h3>Cannot regress</h3>
            <p>
              Schema invariants, answer-count checks, reproducible solver runs.
              Strict non-regression: version 2 cannot reintroduce the failure.
            </p>
          </div>
          <div className="lp-class" data-class="counterexample">
            <span className="lp-class__tag">counterexample</span>
            <h3>Re-executed, and it blocks</h3>
            <p>
              A concrete construction — two readings, two answers. It is re-run on
              every new version; while it still holds, the item does not publish.
            </p>
          </div>
          <div className="lp-class" data-class="semantic">
            <span className="lp-class__tag">semantic</span>
            <h3>Re-judged, never absolute</h3>
            <p>
              Plausibility judgments are re-adjudicated on every version and shown
              in the passport. They are never described as a guarantee.
            </p>
          </div>
        </div>
        <blockquote className="lp-guarantee">
          <p>{GUARANTEE_SENTENCE}</p>
          <cite>The only guarantee this studio makes</cite>
        </blockquote>
      </section>

      {/* -------------------------------------------------- honesty, briefly */}
      <section className="lp-section" id="today">
        <div className="lp-strip">
          <div>
            <h2 className="lp-h2">Stated plainly</h2>
            <p className="lp-section__lede">
              The whole pipeline is implemented and pinned by offline tests.
              Model-backed stages run live only where a server API key is
              configured — the studio labels their availability on every surface —
              and the evaluation harness has published no artifacts yet. No number
              anywhere came from a run that did not happen.
            </p>
          </div>
          <Link className="lp-btn lp-btn--outline" href="/about#boundary">
            Read the exact boundary
          </Link>
        </div>
      </section>

      {/* --------------------------------------------- the rules of the house */}
      <section className="lp-section lp-section--tint">
        <div className="lp-rules">
          <h2 className="lp-h2">The rules of the house</h2>
          <p>
            The forge keeps a few promises it will not trade away.{' '}
            <strong><ShieldIcon /> Nobody is on file:</strong> authors appear as
            random pseudonyms, and no name, email, school, city or age field
            exists in any schema, form or column — not optional, absent.{' '}
            <strong><TagIcon /> Everything is ours to give:</strong> every item is
            a team-authored original released under CC-BY, with no third-party
            exam content of any kind.{' '}
            <strong><CompassIcon /> No exam owns the mechanism:</strong> it was
            designed against the constraints of a real high-stakes exam — that is
            where the assessment expertise comes from — and built to be
            exam-agnostic; today&rsquo;s arenas are probability, statistics and
            geometry.{' '}
            <strong><BracketsIcon /> Your text is handled like evidence:</strong>{' '}
            item text is delimited in every prompt, reviewers get no tools and no
            open network, and input is capped and rate-limited.
          </p>
        </div>
      </section>

      {/* ----------------------------------------------------- about teaser */}
      <section className="lp-section lp-about-teaser">
        <blockquote className="lp-flame">
          <p>
            &ldquo;Defending a solution in front of peers who genuinely wanted to
            find the flaw remains one of the richest learning experiences of my
            life. That forum is gone. LA FORJA is our attempt to relight that
            flame.&rdquo;
          </p>
          <cite>— from the founder&rsquo;s story</cite>
        </blockquote>
        <Link className="lp-btn lp-btn--outline" href="/about">
          About the project
        </Link>
      </section>

      {/* -------------------------------------------------------- final CTA */}
      <section className="lp-final">
        <h2 className="lp-final__title">Start with a broken problem.</h2>
        <p className="lp-final__copy">
          Onboarding is repair-first: your first move is loading a defective item
          and watching it fracture — not staring at an empty form.
        </p>
        <Link className="lp-btn lp-btn--brand lp-btn--lg" href="/studio">
          Enter the studio
        </Link>
      </section>

      <footer className="lp-footer">
        <span>LA FORJA</span>
        <Link href="/about">About</Link>
        <span>Built for OpenAI Build Week · Education track</span>
        <span>All items team-authored · CC-BY</span>
      </footer>
    </div>
  );
}
