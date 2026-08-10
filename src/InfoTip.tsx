import React, { useState, type JSX } from 'react';
import * as Popover from '@radix-ui/react-popover';

export interface InfoTipProps {
  text: string;
}

// Shared "ⓘ" stat-explainer affordance (Radix Popover), opened on hover or
// keyboard focus. `side="bottom"` + `avoidCollisions={false}` is deliberate:
// this renders inside `.page` (`overflow-y:auto`), so Radix's automatic
// collision-flip would otherwise clip it upward at the viewport top — every
// InfoTip must open downward (see CLAUDE.md, bit us once).
export default function InfoTip({ text }: InfoTipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open}>
      <Popover.Trigger asChild>
        <button
          type="button" className="info-tip" aria-label={text}
          onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        >ⓘ</button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="info-bubble" side="bottom" sideOffset={7} align="center"
          avoidCollisions={false} onOpenAutoFocus={(e) => e.preventDefault()}>
          {text}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
