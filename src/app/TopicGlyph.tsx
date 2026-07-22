/**
 * LA FORJA — one small stroke glyph per demo discipline.
 *
 * OWNER: Claude (presentation only). Shared by the studio's topic picker and
 * the author drawer, so it lives outside both to keep the imports acyclic.
 */
import type { DisciplineId } from '@/core/types';

export default function TopicGlyph({ discipline }: { discipline: DisciplineId }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  } as const;
  if (discipline === 'probability') {
    return (
      <svg {...common}>
        <rect x="4" y="4" width="16" height="16" rx="4" />
        <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (discipline === 'statistics') {
    return (
      <svg {...common}>
        <path d="M4 20h16" />
        <path d="M7 20v-6" />
        <path d="M12 20V9" />
        <path d="M17 20V5" />
      </svg>
    );
  }
  if (discipline === 'triangle-similarity') {
    return (
      <svg {...common}>
        <path d="M4 19h9L4 8v11z" />
        <path d="M13 19h7l-7-8.5V19z" opacity="0.55" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="10" cy="14" r="6" />
      <path d="M13 4l7 3-3 7" />
    </svg>
  );
}
