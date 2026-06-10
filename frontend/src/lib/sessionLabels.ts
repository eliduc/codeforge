// Улучшатели#3 P2·S — shared session-status humanizer.
// Lifted from MetricsPanel/SessionDetailPage so Dashboard, SharedSessionPage,
// MetricsPanel and SessionDetailPage all render the same human-friendly text
// for the raw status enum (`awaiting_enhancement_review`, etc.).

const LABELS: Record<string, string> = {
  created: 'Created',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  awaiting_enhancement: 'Awaiting Enhancement',
  enhancing: 'Enhancing…',
  awaiting_enhancement_review: 'Enhancement Review',
  awaiting_visual_review: 'Visual Review',  // КАО#R3-01
}

/** Humanize a raw session-status enum value. Falls back to the raw string. */
export function humanizeStatus(status: string): string {
  return LABELS[status] || status
}
