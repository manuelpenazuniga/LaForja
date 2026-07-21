/**
 * LA FORJA — the landing page.
 *
 * OWNER: Claude (presentation only — static server component).
 *
 * This page explains the project and routes visitors to the studio at /studio.
 * It calls no API and holds no state. Every claim on it obeys the language rule:
 * present tense only for what runs today; every model-backed stage is "next".
 * The guarantee sentence is the single authorized rendering and must not be
 * paraphrased.
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
    copy: 'Load the demo challenge: a team-authored probability item with a deliberate defect. Repair-first — your first move is never an empty form.',
    status: 'today',
  },
  {
    code: 'GAUNTLET',
    title: 'Send it into the gauntlet',
    copy: 'Three concurrent AI reviewers and a deterministic cue probe attack the item under explicit evidence contracts. No reviewer verdict is final on its own.',
    status: 'gated',
    statusNote: 'the deterministic probe runs without a key',
  },
  {
    code: 'FRACTURE',
    title: 'Face the counterexample',
    copy: 'An ambiguity claim counts only when two readings of your stem force two different answers. Not an opinion — a construction anyone can re-execute.',
    status: 'gated',
  },
  {
    code: 'HAMMER',
    title: 'Repair it — version 2',
    copy: 'A repair never overwrites: it creates a new version, and the full check history re-runs against it before anything else happens.',
    status: 'today',
    statusNote: 're-judging semantic checks needs the key',
  },
  {
    code: 'PROOF',
    title: 'Defend it in writing',
    copy: 'Two written questions scored against an explicit three-dimension rubric, with quoted evidence for every score. The defense is yours, not the model’s.',
    status: 'gated',
  },
  {
    code: 'STAMP',
    title: 'Publish with a passport',
    copy: 'The item ships with an auditable record: accepted attacks, re-run results by class, the discipline verdict with its citation, the rubric, every version.',
    status: 'today',
  },
];

const RUNS_TODAY: string[] = [
  'Isolated demo sessions — random pseudonyms, auto-reset, zero PII',
  'The 12-transition item lifecycle — every state change goes through one reducer',
  'A bounded probability solver returning exact reduced fractions with a trace',
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
          <a href="#how">How it works</a>
          <a href="#promises">The promises</a>
          <a href="#today">What runs today</a>
        </nav>
        <Link className="lp-btn lp-btn--ember lp-nav__cta" href="/studio">
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
          You author a multiple-choice math problem. The studio is built to attack
          it with AI reviewers, accept only evidence-backed counterexamples, force
          a repair, re-run the full history, score your written defense — and only
          then publish it with a passport that records the whole fight.
        </p>
        <div className="lp-hero__actions">
          <Link className="lp-btn lp-btn--ember lp-btn--lg" href="/studio">
            Enter the studio
          </Link>
          <a className="lp-btn lp-btn--ghost lp-btn--lg" href="#how">
            See how it works
          </a>
        </div>
        <p className="lp-hero__status">
          The studio, the seeded item, versioning and passports run today. The
          reviewer stages are implemented and verified offline; their live model
          calls are gated on a server API key, and the studio labels their
          availability instead of faking results.
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

      {/* ------------------------------------------------------- how it works */}
      <section className="lp-section" id="how">
        <div className="lp-section__head">
          <h2 className="lp-h2">Six stations, one fight</h2>
          <p className="lp-section__lede">
            Publication is earned, never granted. An item moves through the studio
            in this order, and each station leaves a record the passport keeps.
          </p>
        </div>
        <ol className="lp-stations">
          {STATIONS.map((station, index) => (
            <li className="lp-station" key={station.code}>
              <div className="lp-station__top">
                <span className="lp-station__num" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="lp-station__code">{station.code}</span>
                <span
                  className={
                    station.status === 'today'
                      ? 'lp-chip lp-chip--today'
                      : 'lp-chip lp-chip--gated'
                  }
                >
                  {station.status === 'today' ? 'runs today' : 'needs an API key'}
                </span>
              </div>
              <h3 className="lp-station__title">{station.title}</h3>
              <p className="lp-station__copy">{station.copy}</p>
              {station.statusNote ? (
                <p className="lp-station__note">{station.statusNote}</p>
              ) : null}
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

      {/* ---------------------------------------------- runs today / key-gated */}
      <section className="lp-section" id="today">
        <div className="lp-section__head">
          <h2 className="lp-h2">Stated plainly</h2>
          <p className="lp-section__lede">
            The whole pipeline is implemented and pinned by offline tests against a
            fake model transport. No runtime API key has been available to this
            build, so no model-backed stage is presented as having run live, and
            the eval directory holds no artifact. This is the exact boundary.
          </p>
        </div>
        <div className="lp-status">
          <div className="lp-status__col">
            <h3 className="lp-status__title lp-status__title--today">Runs today</h3>
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

      {/* ------------------------------------------------------- principles */}
      <section className="lp-section lp-section--tint">
        <div className="lp-section__head">
          <h2 className="lp-h2">Built on four hard rules</h2>
        </div>
        <div className="lp-principles">
          <div className="lp-principle">
            <span className="lp-principle__icon"><ShieldIcon /></span>
            <h3>Zero PII</h3>
            <p>
              Authors appear as random pseudonyms. No name, email, school, city or
              age field exists in any schema, form or column.
            </p>
          </div>
          <div className="lp-principle">
            <span className="lp-principle__icon"><TagIcon /></span>
            <h3>Team-authored, CC-BY</h3>
            <p>
              Every item is an original authored by the team and licensed CC-BY.
              No third-party exam content of any kind.
            </p>
          </div>
          <div className="lp-principle">
            <span className="lp-principle__icon"><CompassIcon /></span>
            <h3>Exam-agnostic</h3>
            <p>
              Designed against the constraints of a real high-stakes exam, built to
              be exam-agnostic. The demo discipline is probability.
            </p>
          </div>
          <div className="lp-principle">
            <span className="lp-principle__icon"><BracketsIcon /></span>
            <h3>Untrusted input</h3>
            <p>
              Item text is delimited in every prompt. Reviewers get no write tools
              and no open network; input is capped and rate-limited.
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- final CTA */}
      <section className="lp-final">
        <h2 className="lp-final__title">Start with a broken problem.</h2>
        <p className="lp-final__copy">
          Onboarding is repair-first: your first move is loading a defective item
          and watching it fracture — not staring at an empty form.
        </p>
        <Link className="lp-btn lp-btn--ember lp-btn--lg" href="/studio">
          Enter the studio
        </Link>
      </section>

      <footer className="lp-footer">
        <span>LA FORJA</span>
        <span>Built for OpenAI Build Week · Education track</span>
        <span>All items team-authored · CC-BY</span>
      </footer>
    </div>
  );
}
