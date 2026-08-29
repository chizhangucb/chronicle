import { useEffect, useState } from 'react';
import { api, type HubSafetyResult, type SafetyResult, type GapView, type GatingPolicyView } from './api.js';
import { gatePropose, gateSurfaces, gateSurfaceText, type GateProposal, type GateSurfaceStatus, GateError } from './gate/gate.ts';
import { GateConfirmDialog } from './gate/GateConfirmDialog.tsx';
import { t } from './i18n.js';

// Safety ops surface (CHI-323 3d): a descriptive read of the egress gate's
// posture (config emit-allowlisted, marker phrases reduced to counts), the
// accepted-gaps register, and the confirm-first controls that edit the hub-write
// gate surfaces. Hidden from nav when the hub is absent; fails soft if reached.
const SAFETY_SURFACES = ['hub-egress-enabled', 'hub-spend-caps', 'hub-classification', 'hub-confidential-markers', 'hermes-approvals'];

export default function SafetyPage() {
  const [data, setData] = useState<HubSafetyResult | null>(null);
  const [surfaces, setSurfaces] = useState<GateSurfaceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<GateProposal | null>(null);
  const [destructive, setDestructive] = useState(false);

  async function load() {
    try {
      const [d, s] = await Promise.all([api.hubSafety(), gateSurfaces().catch(() => [])]);
      setData(d);
      setSurfaces(s.filter((x) => SAFETY_SURFACES.includes(x.id)));
    } catch (e) { setError(String((e as Error).message)); }
  }
  useEffect(() => { load(); }, []);

  async function propose(surface: string, change: unknown, reason: string, isDestructive = false) {
    setError(null);
    try {
      const p = await gatePropose(surface, change, reason);
      setDestructive(isDestructive);
      setProposal(p);
    } catch (e) {
      const msg = e instanceof GateError && e.fix ? `${e.message} — ${e.fix}` : String((e as Error).message);
      setError(msg);
    }
  }

  if (error && !data) return <div className="page center muted">{t('Could not load safety')}: {error}</div>;
  if (!data) return <div className="page center muted">{t('Loading…')}</div>;
  if ('hubPresent' in data) {
    return <div className="page center muted">{t('No hub connected. Run `chronicle hub set <path>` to unlock ops panels.')}</div>;
  }

  const surfaceById = (id: string) => surfaces.find((s) => s.id === id);

  return (
    <div className="page safety-page">
      <div className="eyebrow">{t('Safety')}</div>
      <p className="muted small safety-lede">
        {t('What the local egress gate would enforce, and the gaps you have knowingly accepted. Descriptive, never a grade.')}
      </p>
      {error && <p className="gate-error">{error}</p>}

      <Posture data={data} />

      <PushPosture gatingPolicy={data.gatingPolicy} />

      <section className="safety-section">
        <div className="safety-sec-head">{t('Gate controls')}</div>
        {surfaces.some((s) => s.available) ? (
          <>
            <p className="muted small">{t('Every change is confirm-first: a validated diff, then Confirm or Deny. Writes go through the egress gate.')}</p>
            <KillSwitch data={data} surface={surfaceById('hub-egress-enabled')} onPropose={propose} />
            <SpendCaps data={data} surface={surfaceById('hub-spend-caps')} onPropose={propose} />
            {(['hub-classification', 'hub-confidential-markers', 'hermes-approvals'] as const).map((id) => (
              <JsonSurface key={id} surface={surfaceById(id)} onPropose={propose} />
            ))}
          </>
        ) : (
          <p className="muted small">{t('Gate controls are read-only here: no writable hub is connected (or this is a demo). The posture above is still shown.')}</p>
        )}
      </section>

      <Gaps gaps={data.gaps} onReload={load} setError={setError} />

      <GateConfirmDialog proposal={proposal} destructive={destructive}
        onSettled={(confirmed) => { setProposal(null); if (confirmed) load(); }} />
    </div>
  );
}

function Posture({ data }: { data: SafetyResult }) {
  const gc = data.safetyNet.gateConfig;
  const cls = data.safetyNet.classification?.tools ?? [];
  const byClass = (k: string) => cls.filter((c) => c.class === k).length;
  return (
    <div className="safety-posture">
      <div className={`posture-tile ${data.egress.enabled ? 'on' : 'off'}`}>
        <div className="posture-label">{t('Egress gate')}</div>
        <div className="posture-value">{data.egress.enabled ? t('ENABLED') : t('OFF (fail-closed)')}</div>
        {!data.egress.gateConfigFound && <div className="muted small">{t('gate config not found — showing default')}</div>}
      </div>
      <div className="posture-tile">
        <div className="posture-label">{t('Spend caps')}</div>
        <div className="posture-value">
          {gc ? `${fmtCap(gc.spend_per_tx_cap)} / ${fmtCap(gc.spend_per_session_cap)}` : '—'}
        </div>
        <div className="muted small">{t('per-tx / per-session')}</div>
      </div>
      <div className="posture-tile">
        <div className="posture-label">{t('Tool classes')}</div>
        <div className="posture-value">{cls.length}</div>
        <div className="muted small">read {byClass('read')} · send {byClass('send')} · publish {byClass('publish')} · spend {byClass('spend')}</div>
      </div>
      <div className="posture-tile">
        <div className="posture-label">{t('Confidential markers')}</div>
        <div className="posture-value">{data.safetyNet.markers.categories.reduce((a, c) => a + c.count, 0)}</div>
        <div className="muted small">{data.safetyNet.markers.categories.map((c) => `${c.category} ${c.count}`).join(' · ') || t('none')} · {t('counts only')}</div>
      </div>
    </div>
  );
}

// Push posture (CHI-379): the machine's conditioned-auto push pins, read-only.
// scrub_whitelist is a list of identity regexes and is never rendered — only
// its count, matching the confidential-markers posture above.
function PushPosture({ gatingPolicy }: { gatingPolicy: GatingPolicyView }) {
  if (!gatingPolicy.found) return null;
  return (
    <section className="safety-section">
      <div className="safety-sec-head">{t('Push posture')}</div>
      <p className="muted small">{t('Repos where a git push auto-approves without a confirm. Descriptive, not a control.')}</p>
      <div className="safety-pushpins">
        {gatingPolicy.pushPins.map((p) => (
          <div key={p.repo} className={`pushpin-card ${p.anyBranch ? 'any-branch' : ''}`}>
            <div className="pushpin-head">
              <span className="pushpin-repo">{p.repo}</span>
              {p.visibility && <span className="muted small">{p.visibility}</span>}
            </div>
            <div className="muted small">
              {p.anyBranch
                ? t('ANY branch auto-pushes') + (p.confidentialOk ? ` · ${t('confidentiality floor scoped off')}` : '')
                : p.featurePushOk
                  ? `${t('feature branches auto-push')} · ${t('protected')}: ${p.prProtectedBranches.join(', ') || '—'}`
                  : `${t('branches')}: ${p.branches.join(', ') || '—'}`}
            </div>
            {p.leakScrub && <div className="muted small">{t('leak-scrubbed')} · {t('whitelist')}: {p.scrubWhitelistCount}</div>}
          </div>
        ))}
        {gatingPolicy.pushPinDefaults && (
          <div className="pushpin-card owner-rule">
            <div className="pushpin-head"><span className="pushpin-repo">{t('Owner rule (unbounded)')}</span></div>
            <div className="muted small">{t('Any unpinned repo matching')} <code>{gatingPolicy.pushPinDefaults.ownerUrlPattern}</code></div>
            <div className="muted small">
              {gatingPolicy.pushPinDefaults.featurePushOk
                ? `${t('feature branches auto-push')} · ${t('protected')}: ${gatingPolicy.pushPinDefaults.prProtectedBranches.join(', ') || '—'}`
                : t('no auto-push')}
              {gatingPolicy.pushPinDefaults.leakScrub && ` · ${t('leak-scrubbed')} · ${t('whitelist')}: ${gatingPolicy.pushPinDefaults.scrubWhitelistCount}`}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const fmtCap = (v: number | null) => (v == null ? t('none') : `$${v}`);

function Unavailable({ surface }: { surface?: GateSurfaceStatus }) {
  return <div className="safety-control disabled"><span className="muted small">{surface?.title ?? '—'}: {surface?.unavailableReason ?? t('unavailable')}</span></div>;
}

function KillSwitch({ data, surface, onPropose }: { data: SafetyResult; surface?: GateSurfaceStatus; onPropose: (s: string, c: unknown, r: string, d?: boolean) => void }) {
  if (!surface?.available) return <Unavailable surface={surface} />;
  const on = data.egress.enabled;
  return (
    <div className="safety-control">
      <div>
        <div className="control-title">{t('Egress kill switch')}</div>
        <div className="muted small">{on ? t('Gate is ON. Turning OFF fail-closed denies every gated outward send.') : t('Gate is OFF — all gated sends are denied.')}</div>
      </div>
      <button type="button" className={`btn ${on ? 'danger' : 'primary'}`}
        onClick={() => onPropose('hub-egress-enabled', { enabled: !on }, on ? 'Turn egress gate OFF' : 'Turn egress gate ON', true)}>
        {on ? t('Turn OFF') : t('Turn ON')}
      </button>
    </div>
  );
}

function SpendCaps({ data, surface, onPropose }: { data: SafetyResult; surface?: GateSurfaceStatus; onPropose: (s: string, c: unknown, r: string) => void }) {
  const gc = data.safetyNet.gateConfig;
  const [tx, setTx] = useState('');
  const [sess, setSess] = useState('');
  if (!surface?.available) return <Unavailable surface={surface} />;
  const submit = () => {
    const change: Record<string, number | null> = {};
    if (tx.trim() !== '') change.spend_per_tx_cap = tx.trim().toLowerCase() === 'none' ? null : Number(tx);
    if (sess.trim() !== '') change.spend_per_session_cap = sess.trim().toLowerCase() === 'none' ? null : Number(sess);
    if (Object.keys(change).length === 0) return;
    onPropose('hub-spend-caps', change, 'Update spend caps');
    setTx(''); setSess('');
  };
  return (
    <div className="safety-control">
      <div>
        <div className="control-title">{t('Spend caps')}</div>
        <div className="muted small">{t('Current')}: {fmtCap(gc?.spend_per_tx_cap ?? null)} / {fmtCap(gc?.spend_per_session_cap ?? null)}. {t('Enter a number, or "none" to unset.')}</div>
      </div>
      <div className="control-inputs">
        <input className="gate-code-input wide" placeholder={t('per-tx')} value={tx} onChange={(e) => setTx(e.target.value)} />
        <input className="gate-code-input wide" placeholder={t('per-session')} value={sess} onChange={(e) => setSess(e.target.value)} />
        <button type="button" className="btn" onClick={submit}>{t('Propose')}</button>
      </div>
    </div>
  );
}

function JsonSurface({ surface, onPropose }: { surface?: GateSurfaceStatus; onPropose: (s: string, c: unknown, r: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  if (!surface?.available) return <Unavailable surface={surface} />;
  const openEditor = async () => {
    setOpen(true); setLoadErr(null);
    try { setText((await gateSurfaceText(surface.id)) ?? '{}'); }
    catch (e) { setLoadErr(String((e as Error).message)); }
  };
  const submit = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { setLoadErr(t('Not valid JSON')); return; }
    onPropose(surface.id, parsed, `Edit ${surface.title}`);
    setOpen(false);
  };
  return (
    <div className="safety-control column">
      <div className="safety-control-row">
        <div>
          <div className="control-title">{surface.title}{surface.tier === 2 ? ` · ${t('Tier 2')}` : ''}</div>
          {surface.description && <div className="muted small">{surface.description}</div>}
        </div>
        <button type="button" className="btn" onClick={open ? () => setOpen(false) : openEditor}>{open ? t('Cancel') : t('Edit JSON')}</button>
      </div>
      {open && (
        <div className="json-editor">
          {loadErr && <p className="gate-error">{loadErr}</p>}
          <textarea className="json-textarea" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
          <button type="button" className="btn primary" onClick={submit}>{t('Propose change')}</button>
        </div>
      )}
    </div>
  );
}

function Gaps({ gaps, onReload, setError }: { gaps: SafetyResult['gaps']; onReload: () => void; setError: (s: string | null) => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const launch = async (gap: GapView) => {
    setError(null);
    try {
      const r = await api.launchGap(gap.id);
      if (!r.launched && r.copyPrompt) {
        try { await navigator.clipboard.writeText(r.copyPrompt); setCopied(gap.id); setTimeout(() => setCopied(null), 2000); } catch { setError(r.reason ?? 'launch unavailable'); }
      }
      onReload();
    } catch (e) { setError(String((e as Error).message)); }
  };
  const card = (gap: GapView) => (
    <div key={gap.id} className={`gap-card ${gap.kind}`}>
      <div className="gap-head"><span className={`gap-kind ${gap.kind}`}>{gap.kind}</span><span className="gap-title">{gap.title}</span></div>
      {gap.exposure && <p className="muted small">{gap.exposure}</p>}
      <div className="gap-meta muted small">
        {gap.blastRadius && <span>{t('Blast radius')}: {gap.blastRadius}</span>}
        {gap.acceptedWhy && <span>{t('Accepted')} {gap.acceptedDate || ''}: {gap.acceptedWhy}</span>}
        {gap.revisitTrigger && <span>{t('Revisit when')}: {gap.revisitTrigger}</span>}
      </div>
      <div className="gap-actions">
        {gap.closingEdit && <span className="muted small">{t('Closing edit')}: {gap.closingEdit.label}</span>}
        <button type="button" className="btn tiny" onClick={() => launch(gap)}>{copied === gap.id ? t('Copied') : t('Work on this')}</button>
      </div>
    </div>
  );
  if (!gaps.actionable.length && !gaps.watch.length) return null;
  return (
    <section className="safety-section">
      <div className="safety-sec-head">{t('Accepted gaps')}</div>
      {gaps.header && <p className="muted small">{gaps.header}</p>}
      {gaps.actionable.length > 0 && <><div className="eyebrow gap-group">{t('Actionable')}</div>{gaps.actionable.map(card)}</>}
      {gaps.watch.length > 0 && <><div className="eyebrow gap-group">{t('Watch')}</div>{gaps.watch.map(card)}</>}
    </section>
  );
}
