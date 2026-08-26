import { useEffect, useState } from 'react';
import { api, type ModulesResult, type ModuleRowView } from './api.js';
import { t } from './i18n.js';

// Modules ops surface (CHI-323 3a): the hub's `## Modules` registry + a
// read-only snapshot of each module's product-contract.md. Hidden from nav when
// the hub is absent; this page still fails soft if reached directly.
export default function ModulesPage() {
  const [data, setData] = useState<ModulesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.hubModules()
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(String((e as Error).message)); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="page center muted">{t('Could not load modules')}: {error}</div>;
  if (!data) return <div className="page center muted">{t('Loading…')}</div>;
  if ('hubPresent' in data) {
    return <div className="page center muted">{t('No hub connected. Run `chronicle hub set <path>` to unlock ops panels.')}</div>;
  }
  if (!data.found) {
    return <div className="page center muted">{t('No module registry found in this hub (operations.md has no ## Modules table).')}</div>;
  }

  const rows = data.rows;
  const active = rows.find((r) => r.name === selected) ?? null;

  return (
    <div className="page modules-page">
      <div className="eyebrow">{t('Modules')} · {rows.length}</div>
      <p className="muted small modules-lede">
        {t('Every module in the hub registry, with its product contract snapshotted read-only.')}
      </p>

      <div className="modules-layout">
        <table className="modules-table">
          <thead>
            <tr>
              <th>{t('Module')}</th><th>{t('Tier')}</th><th>{t('Purpose')}</th>
              <th>{t('Project')}</th><th>{t('Contract')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className={`modules-row ${active?.name === r.name ? 'on' : ''}`}
                onClick={() => setSelected(r.name)}>
                <td className="modules-name">{r.name}</td>
                <td className="muted small">{r.tier || '—'}</td>
                <td className="modules-purpose">{r.purpose || '—'}</td>
                <td className="muted small">{r.project || '—'}</td>
                <td><ContractBadge row={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        {active && (
          <aside className="modules-detail">
            <div className="modules-detail-head">
              <span className="modules-name">{active.name}</span>
              <ContractBadge row={active} />
            </div>
            {active.contract.available && active.contract.markdown ? (
              <pre className="modules-contract">{active.contract.markdown}</pre>
            ) : (
              <p className="muted small">
                {active.contract.status === 'pending'
                  ? `${t('Contract pending')} (${active.contract.pendingTicket ?? '—'})`
                  : t('Contract not readable (missing, out of policy, or not a product-contract.md).')}
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function ContractBadge({ row }: { row: ModuleRowView }) {
  const c = row.contract;
  const cls = c.available ? 'ok' : c.status === 'pending' ? 'pending' : 'off';
  const label = c.available
    ? (c.status === 'grandfathered' ? t('grandfathered') : t('full'))
    : c.status === 'pending' ? t('pending') : t('n/a');
  return <span className={`modules-badge ${cls}`}>{label}</span>;
}
