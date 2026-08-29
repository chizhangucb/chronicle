import { useEffect, useState } from 'react';
import { api, type HubJobsResult, type JobRowView, type JobLogResult } from './api.js';
import { gateSubmit, type GateProposal, GateError } from './gate/gate.ts';
import { GateConfirmDialog } from './gate/GateConfirmDialog.tsx';
import Modal from './Modal.tsx';
import { t } from './i18n.js';

// Jobs ops surface (CHI-323 3c): every scheduled thing on the machine (launchd +
// cron + hub registry + repo templates) with live state, a log tail drill-in,
// pause/resume through the gate's launchd-jobs surface. CHI-329: pause/resume
// applies without a card (the plist is never edited, so resume restores exactly
// the installed schedule); pausing a job that carries enforcement or the
// approval channel still shows the diff first.
// Chronicle's own templates ship DORMANT (install via scripts/install-jobs.mjs).
export default function JobsPage() {
  const [data, setData] = useState<HubJobsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<GateProposal | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  async function load() {
    try { setData(await api.hubJobs()); } catch (e) { setError(String((e as Error).message)); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(job: JobRowView) {
    setError(null);
    setApplied(null);
    const action = job.status === 'paused' ? 'resume' : 'pause';
    try {
      const out = await gateSubmit('launchd-jobs', { label: job.id, action }, `${action} ${job.id}`);
      if (out.applied) {
        setApplied(out.result.applied);
        load();
      } else {
        setProposal(out.proposal);
      }
    } catch (e) {
      const msg = e instanceof GateError && e.fix ? `${e.message} — ${e.fix}` : String((e as Error).message);
      setError(msg);
    }
  }

  if (error && !data) return <div className="page center muted">{t('Could not load jobs')}: {error}</div>;
  if (!data) return <div className="page center muted">{t('Loading…')}</div>;
  if ('hubPresent' in data) {
    return <div className="page center muted">{t('No hub connected. Run `chronicle hub set <path>` to unlock ops panels.')}</div>;
  }

  const s = data.sources;
  return (
    <div className="page jobs-page">
      <div className="eyebrow">{t('Jobs')} · {data.jobs.length}</div>
      <p className="muted small jobs-lede">
        {t('Every scheduled thing on this machine, in one list.')} {' '}
        launchd {s.launchd} · cron {s.cron} · {t('registry')} {s.registry} · {t('templates')} {s['repo-template']}
      </p>
      {error && <p className="gate-error">{error}</p>}
      {applied && <p className="gate-applied" role="status">{applied}</p>}

      <table className="jobs-table">
        <thead>
          <tr><th>{t('Job')}</th><th>{t('Source')}</th><th>{t('Schedule')}</th><th>{t('Status')}</th><th>{t('Last run')}</th><th></th></tr>
        </thead>
        <tbody>
          {data.jobs.map((job) => (
            <tr key={job.id} className="jobs-row">
              <td>
                <div className="jobs-name">{job.name}</div>
                {job.description && <div className="muted small">{job.description}</div>}
                {job.agent && <div className="muted small">{job.agent}{job.model ? ` · ${job.model}` : ''}</div>}
              </td>
              <td className="muted small">{job.source}</td>
              <td className="muted small">{job.schedule}</td>
              <td><span className={`job-badge ${job.status}`}>{job.status}</span></td>
              <td className="muted small">{job.lastRun ?? '—'}</td>
              <td className="jobs-actions">
                {job.logPath && <button type="button" className="btn tiny" onClick={() => setLogFor(job.id)}>{t('Log')}</button>}
                {job.source === 'launchd' && (job.status === 'running' || job.status === 'success' || job.status === 'pending' || job.status === 'paused') && (
                  <button type="button" className="btn tiny" onClick={() => toggle(job)}>
                    {job.status === 'paused' ? t('Resume') : t('Pause')}
                  </button>
                )}
                {job.status === 'not-installed' && <span className="muted small">{t('install: node scripts/install-jobs.mjs')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {logFor && <LogModal id={logFor} onClose={() => setLogFor(null)} />}
      <GateConfirmDialog proposal={proposal} onSettled={(confirmed) => { setProposal(null); if (confirmed) load(); }} />
    </div>
  );
}

function LogModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [log, setLog] = useState<JobLogResult | { hubPresent: false } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.jobLog(id).then(setLog).catch((e) => setErr(String((e as Error).message)));
  }, [id]);
  return (
    <Modal onClose={onClose} title={`${t('Log')} — ${id}`} className="jobs-log-modal">
      <div className="modal-head"><h3>{id}</h3></div>
      {err && <p className="gate-error">{err}</p>}
      {!log && !err && <p className="muted small">{t('Loading…')}</p>}
      {log && !('hubPresent' in log) && (
        <>
          {log.stdout && <LogTail label="stdout" tail={log.stdout} />}
          {log.stderr && <LogTail label="stderr" tail={log.stderr} />}
          {!log.stdout && !log.stderr && <p className="muted small">{t('This job declares no log file.')}</p>}
        </>
      )}
    </Modal>
  );
}

function LogTail({ label, tail }: { label: string; tail: NonNullable<JobLogResult['stdout']> }) {
  return (
    <div className="jobs-log">
      <div className="eyebrow">{label} · {tail.path}{tail.truncated ? ` · ${t('truncated')}` : ''}</div>
      {tail.exists ? <pre className="jobs-log-body">{tail.lines.join('\n') || t('(empty)')}</pre>
        : <p className="muted small">{t('Log file not found.')}</p>}
    </div>
  );
}
