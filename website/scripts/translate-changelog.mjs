// Auto-translate the changelog into zh / ja for the docs site.
//
// English `CHANGELOG.md` is the single source of truth. The committed
// `docs/<lang>/changelog.md` files hold the accumulated translations. On build
// we MERGE: every version already translated keeps its committed text; any
// version present in CHANGELOG.md but missing from the locale file is translated
// on the fly via OpenRouter (free Nemotron model). If the API key is absent or the
// call fails, we fall back to the English block with a "translation pending" note —
// so the docs build NEVER breaks and the changelog is never missing a version.
//
// Zero API calls in the common case (translations already committed & current);
// the LLM only fires for a freshly-released version that hasn't been translated yet.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const LANG_NAME = { zh: 'Simplified Chinese (简体中文)', ja: 'Japanese (日本語)' };

// Split a changelog into its header (title + intro) and per-version blocks,
// keyed by the `vX.Y.Z` in each `## ` heading. Structure is identical across
// locales (only prose is translated), so version ids line up.
function splitChangelog(md) {
  const header = [];
  const blocks = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(v\d+\.\d+\.\d+)/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { id: m[1], lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      header.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return {
    header: header.join('\n').trimEnd(),
    blocks: blocks.map((b) => ({ id: b.id, text: b.lines.join('\n').trimEnd() })),
  };
}

function fallback(enBlock, lang) {
  return `${enBlock}\n\n> *(${lang} translation pending)*`;
}

async function translateBlock(enBlock, lang) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.warn(`[content] no OPENROUTER_API_KEY — ${lang} block left in English (translation pending)`);
    return fallback(enBlock, lang);
  }
  const system =
    `You are a professional technical translator. Translate the user's Markdown ` +
    `changelog entry from English to ${LANG_NAME[lang]}. Rules: translate prose, ` +
    `headings, and sentence text only. Keep VERBATIM (do not translate or alter): ` +
    `code spans and fenced code, file paths, URLs, version numbers (e.g. v0.1.11), ` +
    `dates, and product/proper names (Chronicle, "Agent Active", Vercel, Homebrew, ` +
    `Claude Code, GitHub, Anthropic). Preserve the Markdown structure exactly — the ` +
    `"## vX.Y.Z — date" heading line, list markers, and bold/italic. Output ONLY the ` +
    `translated Markdown for this one entry: no preamble, no commentary, no code fences.`;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Optional OpenRouter attribution headers (harmless if ignored).
        'HTTP-Referer': 'https://getchronicle.dev',
        'X-Title': 'Chronicle docs changelog',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: enBlock },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
    const data = await res.json();
    let txt = data?.choices?.[0]?.message?.content?.trim();
    if (!txt) throw new Error('empty completion');
    // Strip a stray ```markdown fence if the model wrapped its output.
    txt = txt.replace(/^```(?:markdown|md)?\n?/i, '').replace(/\n?```$/i, '').trim();
    if (!/^##\s+v\d/.test(txt)) throw new Error('missing version heading in output');
    console.log(`[content] translated ${enBlock.match(/v\d+\.\d+\.\d+/)?.[0] || '?'} → ${lang}`);
    return txt;
  } catch (e) {
    console.warn(`[content] ${lang} translation failed (${e.message}); English fallback`);
    return fallback(enBlock, lang);
  }
}

// Build the localized changelog markdown: committed header + per-version blocks,
// preferring the committed translation and LLM-translating only what's missing.
export async function buildLocaleChangelog(lang, enMd, committedMd) {
  const en = splitChangelog(enMd);
  const loc = committedMd ? splitChangelog(committedMd) : { header: en.header, blocks: [] };
  const have = new Map(loc.blocks.map((b) => [b.id, b.text]));
  const out = [loc.header || en.header];
  for (const b of en.blocks) {
    out.push(have.has(b.id) ? have.get(b.id) : await translateBlock(b.text, lang));
  }
  return out.join('\n\n') + '\n';
}
