import React, { useCallback, useRef, useState, type JSX } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Link } from 'wouter';
import { getDefinition, type DefVars } from './reference/definitions.js';
import { t } from './i18n.js';

export interface InfoTipProps {
  /**
   * Registry id. The PREFERRED form: the tip's wording lives in
   * src/reference/definitions.ts, which /reference renders from the same
   * source, so the page and the console cannot drift apart. The bubble also
   * grows a "full definition" link to the term's own anchor.
   */
  def?: string;
  /** Live values for a definition that quotes one (see DefContext). */
  vars?: DefVars;
  /**
   * Raw text. The NARROW escape hatch, for tooltips whose content is runtime
   * DATA rather than a definition and so can never be a registry entry: the
   * Content tab's server-supplied per-characteristic wording. Everything else
   * must use
   * `def` (test/reference-registry.test.mjs enforces the allowlist).
   */
  text?: string;
}

// Shared "ⓘ" stat-explainer affordance (Radix Popover), opened on hover or
// keyboard focus.
//
// Collision policy — VALIDATED against the Radix Popover.Content props
// table (https://www.radix-ui.com/primitives/docs/components/popover):
// `avoidCollisions` (default true) is a SINGLE switch for both axes. Its
// `side` row is explicit: "The preferred side of the anchor to render
// against when open. Will be reversed when collisions occur" — so turning
// avoidCollisions on does not just shift horizontally, it can flip
// side="bottom" to "top". `collisionPadding`/`sticky` only tune the ALIGN
// axis (sticky: "The sticky behavior on the align axis"); neither the docs
// nor the props table expose a way to allow align-axis shift while locking
// the side axis to "bottom". So `avoidCollisions={true}` would reintroduce
// the historical bug (see CLAUDE.md): flipping upward inside `.page`
// (`overflow-y:auto`, clips both axes) and getting cut off at the viewport
// top. We keep `avoidCollisions={false}` (Radix never repositions us —
// side stays "bottom", always) and do the "stay inside the viewport" shift
// OURSELVES, horizontally only, on an INNER wrapper — never on the outer
// Popover.Content node Radix itself positions, so we don't fight its own
// layout effect.
//
// Timing note #1: Radix mounts Popover.Content via its Presence machinery,
// which does NOT land in the same commit as the `open` state flip — a
// `useLayoutEffect` keyed on `open` reliably sees `bubbleRef.current` as
// still null (verified empirically). A CALLBACK ref sidesteps this: it
// fires exactly when the DOM node attaches/detaches, in whatever commit
// that actually happens, so the clamp always runs against a real node.
//
// Timing note #2 (why the clamp lives on its own WRAPPER div, not on
// `.info-bubble` itself): `.info-bubble`'s CSS entrance animation
// (`animation: overlay-in …`, styles.css) also animates `transform`. CSS
// Animations sit in a higher cascade origin than a plain inline style, so
// while that animation is playing it overrides ANY inline `transform` we'd
// set directly on that element — our horizontal clamp would get silently
// clobbered for the animation's whole duration (verified empirically: the
// inline `transform` was present in the DOM the entire time, but
// `getBoundingClientRect()` still reported the pre-clamp position). Putting
// the clamp's `transform` on an unanimated OUTER wrapper and leaving
// `.info-bubble`'s own animated `transform` on the INNER element means the
// two transforms compose on separate nodes instead of fighting over the
// same property.
export default function InfoTip({ def, vars, text }: InfoTipProps): JSX.Element {
  // A `def` resolves from the registry and wins; `text` is the escape hatch.
  // An unknown id renders nothing rather than the raw id: a missing definition
  // is a build-time mistake the registry test catches, not something a reader
  // should ever be shown.
  const definition = def ? getDefinition(def) : undefined;
  const body = definition
    ? [t(definition.plain({ vars })), definition.good ? `${t('Good looks like')}: ${t(definition.good({ vars }))}` : null]
        .filter(Boolean).join(' ')
    : (text ?? '');
  const [open, setOpen] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const clampRef = useCallback((el: HTMLDivElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!el) return;

    const PAD = 8;
    const clamp = (): void => {
      el.style.transform = '';
      const rect = el.getBoundingClientRect();
      let shift = 0;
      if (rect.right > window.innerWidth - PAD) shift = window.innerWidth - PAD - rect.right;
      else if (rect.left < PAD) shift = PAD - rect.left;
      if (shift !== 0) el.style.transform = `translateX(${shift}px)`;
    };
    clamp();

    // Re-clamp on window resize, and whenever Radix rewrites the outer
    // popper wrapper's inline position (top/left/transform) — e.g. on
    // scroll, via its own `autoUpdate` — two levels up: `el.parentElement`
    // is the Popover.Content node itself (only carries the
    // `--radix-popover-content-*` custom-property vars), and
    // `el.parentElement.parentElement` is the actual
    // `[data-radix-popper-content-wrapper]` div that floating-ui positions.
    const wrapper = el.parentElement?.parentElement ?? null;
    let observer: MutationObserver | undefined;
    if (wrapper) {
      observer = new MutationObserver(clamp);
      observer.observe(wrapper, { attributes: true, attributeFilter: ['style'] });
    }
    window.addEventListener('resize', clamp);
    cleanupRef.current = () => {
      window.removeEventListener('resize', clamp);
      observer?.disconnect();
    };
  }, []);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button" className="info-tip" aria-label={body}
          onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        >ⓘ</button>
      </Popover.Trigger>
      <Popover.Portal>
        {/* onOpenAutoFocus: don't steal focus into the bubble on open (it's
            informational, not interactive). onCloseAutoFocus: don't return
            focus to the trigger on close either — Radix's default DOES
            that, which re-fires our own `onFocus` handler below and
            reopens the tip right after Escape/outside-dismiss closes it
            (a real "mixed open-state" trap: two independent triggers,
            hover/focus vs Radix's internal focus management, fighting over
            the same `open` state). */}
        {/* The bubble keeps itself open while the pointer is INSIDE it. Without
            this the trigger's own onMouseLeave fires the moment the pointer
            crosses into the bubble, so the "full definition" link added in
            3b could never be clicked. Closing on the bubble's own
            mouseleave preserves the stuck-open invariant that
            test/e2e/infotip.spec.ts pins. */}
        <Popover.Content side="bottom" sideOffset={7} align="center"
          avoidCollisions={false}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}>
          <div ref={clampRef}>
            <div className="info-bubble">
              {body}
              {definition ? (
                <Link className="info-more" href={`/reference#def-${definition.id}`}>{t('full definition')} →</Link>
              ) : null}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
