import React, { type KeyboardEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

export interface ModalProps {
  onClose: () => void;
  className?: string;
  children: ReactNode;
  // Accessible name (Radix requires a Dialog.Title for a11y); every caller
  // here already renders its own visible `.modal-head h3`, so this stays
  // screen-reader-only rather than duplicating that text on screen.
  title: string;
  // ImportWizard step 3: no Escape / outside-click close mid-import.
  preventClose?: boolean;
  onKeyDown?: (e: KeyboardEvent) => void;
}

// Shared Radix Dialog wrapper for every modal in the app (SearchModal,
// ImportWizard, SecurityCheck, SettingsModal) — gives them a real focus
// trap, Escape-to-close, and portal-out-of-DOM-order for free, replacing
// each one's hand-rolled backdrop + stopPropagation. Visual output is
// unchanged: `.modal-backdrop`/`.modal` keep their existing styles.css rules.
export default function Modal({ onClose, className, children, title, preventClose, onKeyDown }: ModalProps) {
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className={`modal ${className ?? ''}`}
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          onPointerDownOutside={(e) => { if (preventClose) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (preventClose) e.preventDefault(); }}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
