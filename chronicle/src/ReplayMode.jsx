import React, { useEffect, useRef, useState } from 'react';
import { diffLines } from 'diff';

async function j(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const STEP_ICON = { write: '📄', edit: '✏️', command: '＄' };
const SPEEDS = { 1: 1200, 2: 600, 5: 240 };

// Replay Mode (FR-RP): step through the AI's operations in a sandbox.
export default function ReplayMode({ sessionId }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [current, setCurrent] = useState(0);          // index into plan.steps
  const [preview, setPreview] = useState(null);
  const [results, setResults] = useState({});          // seq -> {ok, result|error}
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const playRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    j(`/api/sessions/${encodeURIComponent(sessionId)}/replay-plan`)
      .then(setPlan).catch((e) => setError(String(e.message)));
    return () => clearTimeout(playRef.current);
  }, [sessionId]);

  const started = plan?.started;
  const step = plan?.steps[current];

  useEffect(() => {
    if (!started || !step) { setPreview(null); return; }
    let stale = false;
    j(`/api/replay/preview?sessionId=${encodeURIComponent(sessionId)}&seq=${step.seq}`)
      .then((p) => { if (!stale) setPreview(p); })
      .catch(() => setPreview(null));
    listRef.current?.querySelector(`[data-idx="${current}"]`)?.scrollIntoView({ block: 'nearest' });
    return () => { stale = true; };
  }, [started, current, sessionId, results]);

  async function start() {
    try {
      const r = await post('/api/replay/start', { sessionId });
      setPlan({ ...plan, started: true, workspace: r.workspace, seededFrom: r.seededFrom });
      setCurrent(0); setResults({});
    } catch (e) { setError(String(e.message)); }
  }

  async function execute(confirmCommand = false, thenAdvance = true) {
    if (!step) return;
    try {
      const r = await post('/api/replay/step', { sessionId, seq: step.seq, confirmCommand });
      setResults((cur) => ({ ...cur, [step.seq]: r }));
      if (r.needsConfirmation) { setPlaying(false); return r; }
      if (!r.ok) { setPlaying(false); return r; } // FR-RP-6: pause on failure
      if (thenAdvance) advance();
      return r;
    } catch (e) { setError(String(e.message)); setPlaying(false); }
  }

  function advance() {
    setCurrent((c) => Math.min(plan.steps.length - 1, c + 1));
  }

  // Auto-play (FR-RP-5): advances until a command, error, or the end.
  useEffect(() => {
    if (!playing || !started || !step) return;
    if (step.type === 'command') { setPlaying(false); return; } // commands always need a human
    if (results[step.seq]?.ok) { advance(); return; }
    playRef.current = setTimeout(() => execute(false, true), SPEEDS[speed]);
    return () => clearTimeout(playRef.current);
  }, [playing, current, started, results]);

  if (error) return <div className="page center error-banner">{error}</div>;
  if (!plan) return <div className="page center muted">Building replay plan…</div>;
  if (!plan.steps.length) {
    return <div className="page center empty-state">
      <div className="empty-icon">⟳</div>
      <h3>Nothing to replay</h3>
      <p className="muted small">This session contains no Write / Edit / Bash operations.</p>
    </div>;
  }

  const done = Object.values(results).filter((r) => r.ok).length;

  return (
    <div className="refine">
      <div className="refine-toolbar">
        <span className="muted small">
          Sandbox: <code>{plan.workspace}</code>
          {plan.seededFrom && <span className="pill git-pill" style={{ marginLeft: 6 }}>seeded @ {plan.seededFrom.hash?.slice(0, 7)}</span>}
        </span>
        <span className="token-stats">{done}/{plan.steps.length} steps executed</span>
        <span style={{ display: 'flex', gap: 6 }}>
          {!started && <button className="btn primary small" onClick={start}>⟳ Start replay (sandbox)</button>}
          {started && <>
            <button className={`btn small ${playing ? 'primary' : ''}`} onClick={() => setPlaying(!playing)}>
              {playing ? '⏸ Pause' : '▶ Auto-play'}
            </button>
            {[1, 2, 5].map((s) => (
              <button key={s} className={`btn tiny ${speed === s ? 'primary' : ''}`} onClick={() => setSpeed(s)}>{s}x</button>
            ))}
            <button className="btn small" onClick={() => post('/api/replay/open', { sessionId })}>Open in Finder</button>
          </>}
        </span>
      </div>
      <div className="refine-panes">
        <div className="refine-left" ref={listRef}>
          {plan.steps.map((s, i) => {
            const r = results[s.seq];
            return (
              <div key={s.seq} data-idx={i}
                className={`refine-item ${i === current ? 'selected' : ''} ${r?.ok ? 'step-done' : ''} ${r && !r.ok && !r.needsConfirmation ? 'step-failed' : ''}`}
                onClick={() => setCurrent(i)}>
                <div className="refine-item-head">
                  <span className="msg-kind small">{STEP_ICON[s.type]} {s.type} {r?.ok && '✓'}{r && !r.ok && !r.needsConfirmation && ' ✕'}</span>
                  <span className="muted small">#{i + 1}</span>
                </div>
                <div className="refine-item-body">{s.file || s.command}</div>
              </div>
            );
          })}
        </div>
        <div className="refine-right">
          {!started && (
            <div className="empty-state center" style={{ paddingTop: 60 }}>
              <div className="empty-icon">⟳</div>
              <h3>Cognitive Replay</h3>
              <p className="muted small">Re-execute this session's {plan.steps.length} operations step-by-step in an
                isolated sandbox at <code>{plan.workspace}</code>.<br />
                Your real project is never touched. No LLM calls — pure deterministic replay.</p>
              <button className="btn primary lg" onClick={start}>Create sandbox & start</button>
            </div>
          )}
          {started && step && (
            <>
              {step.reasoning && (
                <div className="card" style={{ marginBottom: 10 }}>
                  <div className="muted small">AI reasoning before this step</div>
                  <div className="small" style={{ fontStyle: 'italic' }}>{step.reasoning}</div>
                </div>
              )}
              <div className="card">
                <div className="refine-item-head">
                  <strong>{STEP_ICON[step.type]} Step {current + 1}: {step.type} {step.file || ''}</strong>
                  <span style={{ display: 'flex', gap: 6 }}>
                    {step.type !== 'command' && <button className="btn primary small" onClick={() => execute(false, false)}>Execute This Step</button>}
                    {step.type === 'command' && <button className="btn small warn" onClick={() => execute(true, false)}>⚠ Execute command</button>}
                    <button className="btn small" onClick={advance}>Skip</button>
                    <button className="btn small" onClick={() => setCurrent(Math.max(0, current - 1))}>Look Back</button>
                  </span>
                </div>
                {step.type === 'command' && (
                  <pre className="sec-text" style={{ marginTop: 8 }}>$ {preview?.command || step.command}</pre>
                )}
                {preview && preview.type !== 'command' && (
                  <StepDiff preview={preview} />
                )}
                {preview?.type === 'edit' && !preview.applies && (
                  <div className="error-banner small">old_string not found in sandbox file — the file state differs (a prior step may have been skipped). You can Skip or Retry after executing earlier steps.</div>
                )}
                {results[step.seq] && (
                  <div className={results[step.seq].ok ? 'card' : 'error-banner'} style={{ marginTop: 8 }}>
                    <div className="small muted">{results[step.seq].ok ? 'Result' : 'Failed'}</div>
                    <pre className="sec-text">{results[step.seq].result || results[step.seq].error || (results[step.seq].needsConfirmation ? 'Command requires explicit confirmation — click "⚠ Execute command".' : '')}</pre>
                    {!results[step.seq].ok && !results[step.seq].needsConfirmation && (
                      <button className="btn small" onClick={() => execute(step.type === 'command', false)}>Retry</button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {started && current === plan.steps.length - 1 && results[step?.seq]?.ok && (
            <div className="card center" style={{ marginTop: 10 }}>
              <strong>Replay complete 🎉</strong>
              <button className="btn primary small" style={{ marginTop: 6 }} onClick={() => post('/api/replay/open', { sessionId })}>Open workspace in Finder</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepDiff({ preview }) {
  const from = preview.current ?? '';
  const to = preview.next ?? preview.current ?? '';
  const parts = diffLines(from, to);
  const changed = parts.some((p) => p.added || p.removed);
  return (
    <pre className="code-content diff" style={{ maxHeight: 380, overflow: 'auto', marginTop: 8 }}>
      {!changed && <span className="diff-ctx">{preview.current == null ? '(new file)\n' : ''}{(to || '').slice(0, 3000)}</span>}
      {changed && parts.map((p, i) => (
        <span key={i} className={p.added ? 'diff-add' : p.removed ? 'diff-del' : 'diff-ctx'}>
          {p.value.split('\n').length > 8 && !p.added && !p.removed
            ? p.value.split('\n').slice(0, 3).join('\n') + `\n··· ${p.value.split('\n').length - 3} lines ···\n`
            : p.value}
        </span>
      ))}
    </pre>
  );
}
