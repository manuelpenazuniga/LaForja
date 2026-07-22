'use client';

/**
 * LA FORJA — the "author your own item" drawer.
 *
 * OWNER: Claude (presentation + local form state only — no API calls).
 *
 * Unlocked after the demo cycle reaches PUBLISHED (repair-first onboarding,
 * doc §4). The form collects exactly what POST /api/item validates — stem,
 * four options, the key, a rationale, a discipline — and hands the payload to
 * the studio via onSubmit; the studio owns the request and the state change.
 * A visitor original is private to the session and ephemeral: it is never
 * published and never inherits CC-BY, and the copy says so.
 */
import { useMemo, useState } from 'react';
import { Drawer } from 'vaul';

import type { DisciplineId } from '@/core/types';
import { disciplineLabel } from '@/core/disciplines';
import TopicGlyph from './TopicGlyph';

const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

export interface AuthorDraft {
  discipline: DisciplineId;
  stem: string;
  options: string[];
  correctKey: string;
  authorRationale: string;
}

export interface AuthorDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disciplines: DisciplineId[];
  /** True while the studio is talking to the server; the form locks. */
  busy: boolean;
  onSubmit: (draft: AuthorDraft) => void;
}

export default function AuthorDrawer({
  open,
  onOpenChange,
  disciplines,
  busy,
  onSubmit,
}: AuthorDrawerProps) {
  const [discipline, setDiscipline] = useState<DisciplineId>(
    disciplines[0] ?? 'probability',
  );
  const [stem, setStem] = useState('');
  const [options, setOptions] = useState<string[]>(['', '', '', '']);
  const [correctKey, setCorrectKey] = useState<string>('A');
  const [rationale, setRationale] = useState('');

  const complete = useMemo(
    () =>
      stem.trim().length > 0 &&
      options.every((option) => option.trim().length > 0) &&
      rationale.trim().length > 0,
    [stem, options, rationale],
  );

  const setOption = (index: number, value: string) => {
    setOptions((prev) => prev.map((option, i) => (i === index ? value : option)));
  };

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="ob-overlay" />
        <Drawer.Content className="ob-content" aria-describedby={undefined}>
          <div className="ob-inner">
            <div className="ob-handle" aria-hidden="true" />
            <p className="ob-eyebrow">The second door</p>
            <Drawer.Title className="ob-title">Author your own item</Drawer.Title>
            <p className="ob-sub">
              Now that you have carried one item through the whole fight, build
              your own and send it in. It stays private to this session, is never
              published, and expires with your pseudonym.
            </p>

            <div className="topic-picker">
              <span className="field__label">
                <span>Topic</span>
              </span>
              <div className="topic-picker__row" role="radiogroup" aria-label="Item topic">
                {disciplines.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    role="radio"
                    aria-checked={discipline === entry}
                    className="topic"
                    data-active={discipline === entry ? 'true' : 'false'}
                    disabled={busy}
                    onClick={() => setDiscipline(entry)}
                  >
                    <TopicGlyph discipline={entry} />
                    <span className="topic__name">{disciplineLabel(entry)}</span>
                  </button>
                ))}
              </div>
            </div>

            <label className="field" style={{ marginTop: 'var(--s5)' }}>
              <span className="field__label">
                <span>Stem</span>
                <span>the question itself</span>
              </span>
              <textarea
                className="textarea"
                style={{ minHeight: '96px' }}
                value={stem}
                disabled={busy}
                placeholder="Write the problem statement…"
                onChange={(event) => setStem(event.target.value)}
              />
            </label>

            <div className="field" style={{ marginTop: 'var(--s5)' }}>
              <span className="field__label">
                <span>Options</span>
                <span>select the key you will defend</span>
              </span>
              <div className="options">
                {OPTION_KEYS.map((key, index) => (
                  <div
                    className="option"
                    key={key}
                    data-correct={correctKey === key ? 'true' : 'false'}
                    data-defensible="false"
                  >
                    <input
                      type="radio"
                      name="authorCorrectKey"
                      value={key}
                      checked={correctKey === key}
                      disabled={busy}
                      onChange={() => setCorrectKey(key)}
                      aria-label={`Mark option ${key} as the correct answer`}
                    />
                    <span className="option__key">{key}</span>
                    <input
                      className="input"
                      value={options[index] ?? ''}
                      disabled={busy}
                      placeholder={`Option ${key}`}
                      onChange={(event) => setOption(index, event.target.value)}
                      aria-label={`Option ${key}`}
                    />
                    {correctKey === key ? <span className="option__tag">KEY</span> : null}
                  </div>
                ))}
              </div>
            </div>

            <label className="field" style={{ marginTop: 'var(--s5)' }}>
              <span className="field__label">
                <span>Author rationale</span>
                <span>why this key, why these distractors</span>
              </span>
              <textarea
                className="textarea"
                style={{ minHeight: '96px' }}
                value={rationale}
                disabled={busy}
                placeholder="Which misconception does each wrong option capture?"
                onChange={(event) => setRationale(event.target.value)}
              />
            </label>

            <div className="ob-actions">
              <button
                type="button"
                className="btn btn--forge btn--lg"
                disabled={busy || !complete}
                onClick={() =>
                  onSubmit({
                    discipline,
                    stem: stem.trim(),
                    options: options.map((option) => option.trim()),
                    correctKey,
                    authorRationale: rationale.trim(),
                  })
                }
              >
                {busy ? 'Placing it on the bench…' : 'Send it to the bench'}
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Not yet
              </button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
