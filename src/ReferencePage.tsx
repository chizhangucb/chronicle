import { useEffect, useMemo, useState } from 'react';
import { useSearch } from 'wouter';
import { DEFINITIONS, DEF_PAGE_ORDER, DEF_PAGE_LABEL, type DefPage } from './reference/definitions.js';
import { t } from './i18n.js';

// The unified reference (CHI-325 3b, decision D3/D4). Every metric and term on
// the console, rendered from the SAME registry the small "ⓘ" tips read, so this
// page can never drift from what the surfaces say. That is the whole reason it
// exists as a registry rather than an authored document.
//
// NOT hub-conditional (D4): this is product vocabulary, not hub data, so a
// stock public install with no hub still has it.
//
// The `retired` group is deliberate. The Chronicle/Varde merge (CHI-322)
// dropped some surfaces; the decision was that the vocabulary survives even
// where the page did not, so a term someone remembers can still be looked up.

function useHashLanding(): string | null {
  // Deep links arrive as /reference#def-spend.cost-basis, either from an
  // InfoTip's "full definition" link or from a bookmark. Scroll to the entry
  // and flash it, so landing on a long page does not dump the reader at the top
  // with no idea which of forty rows they came for.
  const [hash, setHash] = useState<string | null>(() => window.location.hash.slice(1) || null);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash.slice(1) || null);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!hash) return;
    const el = document.querySelector(`[data-anchor="${CSS.escape(hash)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('def-flash');
    const timer = setTimeout(() => el.classList.remove('def-flash'), 1600);
    return () => clearTimeout(timer);
  }, [hash]);
  return hash;
}

export default function ReferencePage() {
  const search = useSearch();
  const [query, setQuery] = useState(() => new URLSearchParams(search).get('q') ?? '');
  useHashLanding();

  // Search covers title AND body, because the term you remember is often a
  // phrase from the explanation rather than the heading.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DEFINITIONS;
    return DEFINITIONS.filter((d) => {
      const hay = `${d.title} ${d.plain({})} ${d.good?.({}) ?? ''} ${d.tech?.({}) ?? ''} ${d.id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [query]);

  const groups = DEF_PAGE_ORDER
    .map((page) => ({ page, defs: filtered.filter((d) => d.page === page) }))
    .filter((g) => g.defs.length > 0);

  return (
    <div className="page reference-page">
      <div className="ref-head">
        <div>
          <div className="eyebrow">{t('Reference')}</div>
          <p className="muted small ref-intro">
            {t('What every number on this console means. Definitions render from the same registry the small ⓘ tips use, so this page cannot drift from the surfaces. Terms from surfaces Chronicle deliberately retired are kept at the end, so the vocabulary survives even where the page did not.')}
          </p>
        </div>
        <label className="ref-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search definitions')}
            aria-label={t('Search definitions')}
          />
        </label>
      </div>

      {groups.length === 0 ? (
        <p className="muted small">{t('Nothing matches')} “{query}”.</p>
      ) : groups.map(({ page, defs }) => (
        <section className="card ref-group" key={page}>
          <h3>{t(DEF_PAGE_LABEL[page as DefPage])}</h3>
          <dl className="ref-list">
            {defs.map((d) => {
              // No call site here, so no `vars`: every definition must read
              // correctly with none (see the registry's header note).
              const good = d.good?.({});
              const tech = d.tech?.({});
              return (
                <div className="ref-def" key={d.id} data-anchor={`def-${d.id}`} id={`def-${d.id}`}>
                  <dt>{t(d.title)}</dt>
                  <dd>
                    {t(d.plain({}))}
                    {good ? <span className="ref-good">{t('Good looks like')}: {t(good)}</span> : null}
                    {tech ? <span className="ref-tech">{t(tech)}</span> : null}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}
