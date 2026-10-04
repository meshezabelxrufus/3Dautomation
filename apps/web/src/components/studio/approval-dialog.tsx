"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DesignImage } from "@/components/ui/design-image";

type ApprovalDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** Optional image preview of what is being approved. */
  previewImage?: string | null;
  previewAlt?: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  /** Extra content (e.g. a list of what happens next). */
  children?: ReactNode;
};

// Critically damped spring: settles without overshoot (apple-design default).
const spring = { type: "spring", bounce: 0, duration: 0.35 } as const;

/**
 * Confirmation for consequential, hard-to-undo steps only (finalizing a design,
 * delivering to Drive). Modal task, so the background is dimmed. Enters and exits
 * along the same path, and stays interruptible.
 */
export function ApprovalDialog({
  open,
  onOpenChange,
  title,
  description,
  previewImage,
  previewAlt = "",
  confirmLabel,
  onConfirm,
  pending,
  children,
}: ApprovalDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (!pending ? onOpenChange(next) : undefined)}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            {/* The overlay doubles as the positioning container: bottom sheet on phones, centered on larger screens. */}
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-scrim p-3 sm:items-center sm:p-6"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <Dialog.Content asChild forceMount>
                  <motion.div
                    className="flex w-full max-w-lg flex-col gap-5 rounded-[1.5rem] border border-hairline bg-surface p-5 shadow-float outline-none sm:p-7"
                    initial={{ opacity: 0, y: 24, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 24, scale: 0.98 }}
                    transition={spring}
                  >
                    {previewImage !== undefined ? (
                      <DesignImage src={previewImage} alt={previewAlt} aspect="aspect-[4/3]" sizes="(min-width: 640px) 32rem, 100vw" />
                    ) : null}
                    <div className="flex flex-col gap-2">
                      <Dialog.Title className="text-title text-ink">{title}</Dialog.Title>
                      <Dialog.Description asChild>
                        <div className="text-callout text-ink-2">{description}</div>
                      </Dialog.Description>
                    </div>
                    {children}
                    <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                      <Dialog.Close asChild>
                        <Button variant="secondary" size="lg" disabled={pending}>
                          Not yet
                        </Button>
                      </Dialog.Close>
                      <Button size="lg" onClick={onConfirm} loading={pending}>
                        {confirmLabel}
                      </Button>
                    </div>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
