'use client';

/**
 * LA FORJA — first-visit onboarding for the studio.
 *
 * OWNER: Claude (presentation only — no business logic, no API calls).
 *
 * A bottom drawer (vaul) that explains the repair-first loop in four steps and
 * hands off to the "Load demo challenge" action the studio already owns. It
 * decides nothing: the primary button simply invokes the callback the studio
 * passes in. Copy obeys the language rule — model-backed stages are "next".
 */
import { Drawer } from 'vaul';

interface OnboardingStep {
  title: string;
  copy: string;
}

const STEPS: OnboardingStep[] = [
  {
    title: 'Load a broken problem',
    copy: 'You start from a team-authored probability item with a deliberate defect — never from an empty form.',
  },
  {
    title: 'Watch it get attacked',
    copy: 'The gauntlet is built to run three AI reviewers and a deterministic probe against it, under strict evidence contracts.',
  },
  {
    title: 'Repair and defend it',
    copy: 'A valid counterexample forces a repair. The repair is a new version, the full history re-runs, and you defend your fix in writing.',
  },
  {
    title: 'Publish with proof',
    copy: 'A surviving item publishes with a passport: every attack, re-run, verdict and version, on the record.',
  },
];

export interface OnboardingDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Invoked by the primary CTA; the studio decides what loading means. */
  onStart: () => void;
  /** True once an item is already on the sheet — the CTA label adapts. */
  demoLoaded: boolean;
  modelCallsAvailable: boolean;
}

export default function OnboardingDrawer({
  open,
  onOpenChange,
  onStart,
  demoLoaded,
  modelCallsAvailable,
}: OnboardingDrawerProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="ob-overlay" />
        <Drawer.Content className="ob-content" aria-describedby={undefined}>
          <div className="ob-inner">
            <div className="ob-handle" aria-hidden="true" />
            <p className="ob-eyebrow">Welcome to the forge</p>
            <Drawer.Title className="ob-title">
              Getting the right answer is not enough.
            </Drawer.Title>
            <p className="ob-sub">
              Here you make a math problem survive an adversarial review — and the
              repair and the defense are yours, not the AI&rsquo;s.
            </p>

            <ol className="ob-steps">
              {STEPS.map((step, index) => (
                <li className="ob-step" key={step.title}>
                  <span className="ob-step__num" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div>
                    <h3 className="ob-step__title">{step.title}</h3>
                    <p className="ob-step__copy">{step.copy}</p>
                  </div>
                </li>
              ))}
            </ol>

            {!modelCallsAvailable ? (
              <p className="ob-note">
                Model-backed stages are next until a server API key is configured.
                Their panels stay visible and honestly labeled.
              </p>
            ) : null}

            <div className="ob-actions">
              <button
                type="button"
                className="btn btn--forge btn--lg"
                onClick={onStart}
              >
                {demoLoaded ? 'Back to the sheet' : 'Load the demo challenge'}
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => onOpenChange(false)}
              >
                Skip the intro
              </button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
