import { t } from './i18n.ts';

// Pure, framework-free — shared by the passive sync-status indicator (5d-0)
// and reused nowhere else; Home's per-row ledger "When" column has its own
// day-grouped logic and does NOT use this (see the 5d-1 task).
export function formatRelativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return t('never');
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return t('never');
  const diffMs = now - ts;
  if (diffMs < 0) return t('just now');
  const s = Math.floor(diffMs / 1000);
  if (s < 10) return t('just now');
  if (s < 60) return `${s}${t('s ago')}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${t('m ago')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${t('h ago')}`;
  const d = Math.floor(h / 24);
  return `${d}${t('d ago')}`;
}
