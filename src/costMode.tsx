// Global real/theoretical cost toggle (CHI-233 Part C). ONE UI state, provided
// at the app root and read by every surface that prices tokens — because all
// pricing funnels through src/models.ts costOf, a component only needs the mode
// value + a memo dependency on it, then passes it into its cost calls.
//
// "theoretical" (default) = list price, what a metered API caller would pay.
// "real" = what Chi actually pays: subscription-covered models (Claude tiers,
// gpt-5.6 / Codex) bill ~$0 per token, so their real cost is 0 (see models.ts).
// Default is theoretical so nothing silently changes meaning without the toggle.
import React, { createContext, useContext, useMemo, useState, type JSX, type ReactNode } from 'react';
import type { CostMode } from './models.ts';
import { t } from './i18n.js';
import InfoTip from './InfoTip.tsx';

const STORAGE_KEY = 'chronicle.costMode';

interface CostModeState {
  mode: CostMode;
  setMode: (m: CostMode) => void;
}

const CostModeContext = createContext<CostModeState>({ mode: 'theoretical', setMode: () => {} });

function initialMode(): CostMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'real' ? 'real' : 'theoretical';
  } catch {
    return 'theoretical';
  }
}

export function CostModeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<CostMode>(initialMode);
  const value = useMemo<CostModeState>(() => ({
    mode,
    setMode: (m: CostMode) => {
      setModeState(m);
      try { localStorage.setItem(STORAGE_KEY, m); } catch { /* private mode — in-memory only */ }
    },
  }), [mode]);
  return <CostModeContext.Provider value={value}>{children}</CostModeContext.Provider>;
}

export function useCostMode(): CostModeState {
  return useContext(CostModeContext);
}

// The global toggle control (topbar). State is ALWAYS visibly labeled so no
// number silently changes meaning: "List price" vs "Billed (~$0 sub)". An
// InfoTip spells out exactly what each side means.
export function CostModeToggle(): JSX.Element {
  const { mode, setMode } = useCostMode();
  return (
    <div className="cost-mode-toggle" role="group" aria-label={t('Cost basis')}>
      {/* CHI-324 cross-cutting: the COST prefix label is removed — the control
          reads just "List price | Billed". The aria-label carries the meaning. */}
      <button type="button" className={`cm-opt ${mode === 'theoretical' ? 'on' : ''}`}
        aria-pressed={mode === 'theoretical'} onClick={() => setMode('theoretical')}>
        {t('List price')}
      </button>
      <button type="button" className={`cm-opt ${mode === 'real' ? 'on' : ''}`}
        aria-pressed={mode === 'real'} onClick={() => setMode('real')}>
        {t('Billed')}
      </button>
      <InfoTip text={t('List price shows the metered list-price cost of every token (what an API caller would pay). Billed shows what you actually pay: models covered by your subscription (Claude tiers, gpt-5.6 / Codex) bill ~$0 under the plan, so their billed cost is 0.')} />
    </div>
  );
}
