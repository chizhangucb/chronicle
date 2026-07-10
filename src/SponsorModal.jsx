import React, { useState } from 'react';
import { t } from './i18n.js';
import { openExternal } from './shell.js';
import { SPONSOR } from './sponsor.js';

// Support Chronicle: a link-out panel. Each provider opens its hosted checkout in
// the user's real browser (openExternal) — Chronicle takes no payments itself and
// never sees card details. Mirrors the FeedbackModal shell in App.jsx.
export default function SponsorModal({ onClose }) {
  const [mode, setMode] = useState('oneTime'); // oneTime | monthly

  const rows = [
    {
      key: 'lemonSqueezy',
      title: t('Cards, PayPal & Venmo'),
      sub: mode === 'monthly'
        ? t('Monthly card subscription via Lemon Squeezy')
        : t('One-time via Lemon Squeezy — cards, PayPal, Alipay & WeChat'),
      url: SPONSOR.lemonSqueezy[mode],
    },
    {
      key: 'afdian',
      title: t('Alipay / WeChat (支付宝 / 微信)'),
      sub: mode === 'monthly'
        ? t('Monthly (包月) via 爱发电 Afdian')
        : t('One-time (投喂) via 爱发电 Afdian'),
      url: SPONSOR.afdian[mode],
    },
    {
      key: 'github',
      title: t('GitHub Sponsors'),
      sub: t('Cards — one-time or monthly, chosen on GitHub'),
      url: SPONSOR.github,
    },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sponsor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t('Support Chronicle')}</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <p className="muted small">
          {t('Chronicle is free and open-source. If it saves you time, consider sponsoring its development.')}
        </p>

        <div className="sponsor-toggle" role="group" aria-label={t('Support Chronicle')}>
          <button className={`seg ${mode === 'oneTime' ? 'on' : ''}`}
            onClick={() => setMode('oneTime')}>{t('One-time')}</button>
          <button className={`seg ${mode === 'monthly' ? 'on' : ''}`}
            onClick={() => setMode('monthly')}>{t('Monthly')}</button>
        </div>

        <div className="sponsor-rows">
          {rows.map((r) => (
            <div className="sponsor-row" key={r.key}>
              <div className="sponsor-row-info">
                <div className="sponsor-row-title">{r.title}</div>
                <div className="muted small">{r.sub}</div>
              </div>
              <button className="btn primary" onClick={() => openExternal(r.url)}>
                {t('Support')} →
              </button>
            </div>
          ))}
        </div>

        <p className="muted small sponsor-trust">
          {t('Payments are handled by each provider — Chronicle never sees your card details.')}
        </p>
      </div>
    </div>
  );
}
