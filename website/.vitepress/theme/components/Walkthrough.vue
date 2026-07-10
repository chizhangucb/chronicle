<script setup>
import { useData } from 'vitepress';
import { computed } from 'vue';

// Captions localize with the active locale. Keep in sync across en/zh/ja.
const CAPTIONS = {
  en: [
    'Click any message in your session',
    'Chronicle rewinds your code to that exact moment',
    'Toggle the diff to see what changed',
    'Scrub the timeline like a video',
  ],
  zh: [
    '点击会话中的任意一条消息',
    'Chronicle 把代码回退到那一刻的真实状态',
    '切换 Diff，查看这一步改动了什么',
    '像拖动视频进度条一样拖动时间线',
  ],
  ja: [
    'セッション内の任意のメッセージをクリック',
    'その瞬間の正確なコード状態に巻き戻します',
    '差分に切り替えて変更点を確認',
    '動画のようにタイムラインをスクラブ',
  ],
};

const { lang } = useData();
const caps = computed(() => CAPTIONS[String(lang.value).slice(0, 2)] || CAPTIONS.en);
</script>

<template>
  <div class="wt" role="img" aria-label="Chronicle walkthrough: click a message, time-travel the code, view the diff, scrub the timeline">
    <div class="wt-frame">
      <div class="wt-chrome">
        <span class="wt-dot r" /><span class="wt-dot y" /><span class="wt-dot g" />
        <span class="wt-title">Chronicle — Playback</span>
        <span class="wt-live">● LIVE</span>
      </div>

      <div class="wt-body">
        <!-- Conversation -->
        <div class="wt-conv">
          <div class="wt-msg m1"><i class="rd user" />User</div>
          <div class="wt-msg m2"><i class="rd asst" />Assistant</div>
          <div class="wt-msg m3"><i class="rd tool" />Tool Call</div>
          <div class="wt-msg m4"><i class="rd user" />User</div>
          <div class="wt-msg m5"><i class="rd asst" />Assistant</div>
          <div class="wt-cursor" />
        </div>

        <!-- Code snapshot -->
        <div class="wt-code">
          <div class="wt-tab">server/git.js</div>
          <div class="wt-lines">
            <div class="wt-line"><span class="ln">1</span><span class="c-k">export function</span> <span class="c-f">commitAt</span>(dir, ts) {</div>
            <div class="wt-line del"><span class="ln">2</span>  <span class="c-c">// TODO: pick a commit</span></div>
            <div class="wt-line add"><span class="ln">2</span>  <span class="c-k">const</span> hash = git(dir, [<span class="c-s">'rev-list'</span>, <span class="c-s">'-1'</span>]);</div>
            <div class="wt-line"><span class="ln">3</span>  <span class="c-k">return</span> describeCommit(dir, hash);</div>
            <div class="wt-line"><span class="ln">4</span>}</div>
            <div class="wt-line dim"><span class="ln">5</span>&nbsp;</div>
            <div class="wt-line dim"><span class="ln">6</span><span class="c-k">function</span> <span class="c-f">treeAt</span>(dir, commit) {</div>
          </div>
        </div>
      </div>

      <!-- Timeline -->
      <div class="wt-timeline">
        <span class="tk blue" /><span class="tk" /><span class="tk green" /><span class="tk" />
        <span class="tk blue" /><span class="tk" /><span class="tk green" /><span class="tk" /><span class="tk" />
        <span class="wt-playhead" />
      </div>
    </div>

    <div class="wt-caption">
      <span class="cap c1">{{ caps[0] }}</span>
      <span class="cap c2">{{ caps[1] }}</span>
      <span class="cap c3">{{ caps[2] }}</span>
      <span class="cap c4">{{ caps[3] }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Self-contained, looping ~24s product walkthrough. Pure CSS animation, dark,
   on Chronicle's palette. Respects prefers-reduced-motion. */
.wt { --a: #4f8ef7; --a2: #34c98e; --bg: #0e1116; --bg2: #151a21; --bg3: #1c232d;
  --bd: #2a3340; --tx: #dce3ec; --mut: #8b98a9;
  margin: 20px 0 8px; }
.wt-frame { background: var(--bg); border: 1px solid var(--bd); border-radius: 12px;
  overflow: hidden; box-shadow: 0 20px 50px -30px rgba(0,0,0,.8); }
.wt-chrome { display: flex; align-items: center; gap: 7px; padding: 9px 12px;
  background: var(--bg2); border-bottom: 1px solid var(--bd); }
.wt-dot { width: 10px; height: 10px; border-radius: 50%; }
.wt-dot.r { background: #e5684b } .wt-dot.y { background: #e5a54b } .wt-dot.g { background: #34c98e }
.wt-title { margin-left: 8px; color: var(--mut); font-size: 12px; font-weight: 600; }
.wt-live { margin-left: auto; color: var(--a2); font-size: 10px; font-weight: 700; letter-spacing: .04em; }

.wt-body { display: grid; grid-template-columns: 38% 62%; min-height: 208px; }

/* Conversation */
.wt-conv { position: relative; padding: 12px 10px; border-right: 1px solid var(--bd);
  display: flex; flex-direction: column; gap: 8px; }
.wt-msg { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--tx);
  padding: 7px 9px; border-radius: 7px; background: var(--bg2); border: 1px solid transparent; }
.rd { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.rd.user { background: var(--a) } .rd.asst { background: var(--a2) } .rd.tool { background: var(--mut) }
.wt-cursor { position: absolute; right: 16px; width: 14px; height: 14px;
  border-left: 2px solid #fff; border-bottom: 2px solid #fff; transform: rotate(-45deg);
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); opacity: .9; }

/* Code */
.wt-code { padding: 10px 12px; background: var(--bg); }
.wt-tab { display: inline-block; font-family: ui-monospace, Menlo, monospace; font-size: 11px;
  color: var(--mut); background: var(--bg3); padding: 3px 9px; border-radius: 6px; margin-bottom: 8px; }
.wt-lines { font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.7; color: var(--tx); }
.wt-line { display: block; white-space: pre; padding: 0 6px; border-radius: 3px; }
.wt-line .ln { display: inline-block; width: 18px; color: #4a5666; margin-right: 10px; user-select: none; }
.wt-line.dim { opacity: .4 }
.c-k { color: #c98efb } .c-f { color: var(--a) } .c-s { color: var(--a2) } .c-c { color: var(--mut); font-style: italic }

/* Timeline */
.wt-timeline { position: relative; display: flex; align-items: center; gap: 7px;
  padding: 12px 16px; background: var(--bg2); border-top: 1px solid var(--bd); }
.tk { width: 9px; height: 9px; border-radius: 2px; background: #3a4757; }
.tk.blue { border-radius: 50%; background: var(--a) } .tk.green { background: var(--a2) }
.wt-playhead { position: absolute; top: 6px; bottom: 6px; width: 2px; background: #fff;
  border-radius: 2px; left: 16px; box-shadow: 0 0 8px rgba(255,255,255,.6); }

/* Caption */
.wt-caption { position: relative; height: 22px; margin-top: 12px; text-align: center; }
.cap { position: absolute; inset: 0; font-size: 13px; font-weight: 600; color: var(--a);
  opacity: 0; }

/* ---- Animations: one 24s loop, four 6s scenes ---- */
.wt-cursor { animation: cursorMove 24s ease-in-out infinite; }
.m1 { animation: hi1 24s ease-in-out infinite; }
.wt-line.del { animation: showDel 24s ease-in-out infinite; }
.wt-line.add { animation: showAdd 24s ease-in-out infinite; }
.wt-playhead { animation: play 24s ease-in-out infinite; }
.c1 { animation: cap 24s ease-in-out infinite; }
.c2 { animation: cap 24s ease-in-out infinite -6s; }
.c3 { animation: cap 24s ease-in-out infinite -12s; }
.c4 { animation: cap 24s ease-in-out infinite -18s; }

@keyframes cursorMove {
  0%, 8% { top: 108px; opacity: .9 }
  20%, 100% { top: 40px; opacity: 0 }
}
@keyframes hi1 { /* highlight the selected message (row 1) */
  0%, 6% { background: var(--bg2); border-color: transparent }
  10%, 100% { background: rgba(79,142,247,.14); border-color: var(--a) }
}
@keyframes showDel { /* diff removed line — only during scene 3 */
  0%, 48% { max-height: 0; opacity: 0; background: transparent }
  52%, 74% { max-height: 24px; opacity: 1; background: rgba(229,104,75,.16) }
  80%, 100% { max-height: 24px; opacity: 0; background: transparent }
}
@keyframes showAdd {
  0%, 24% { background: transparent }
  30%, 46% { background: rgba(52,201,142,.14) } /* scene 2: the new code arrives */
  52%, 74% { background: rgba(52,201,142,.22) } /* scene 3: highlighted as added */
  80%, 100% { background: transparent }
}
@keyframes play {
  0%, 20% { left: 16px }
  40% { left: 40% }
  60% { left: 62% }
  75%, 100% { left: calc(100% - 20px) }
}
@keyframes cap {
  0% { opacity: 0 } 3%, 22% { opacity: 1 } 25%, 100% { opacity: 0 }
}

@media (prefers-reduced-motion: reduce) {
  .wt-cursor, .m1, .wt-line.del, .wt-line.add, .wt-playhead, .cap { animation: none; }
  .m1 { background: rgba(79,142,247,.14); border-color: var(--a); }
  .c1 { opacity: 1; }
  .wt-line.del { display: none; }
}
</style>
