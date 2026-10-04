"use client";

import { Check, CloudUpload, RotateCcw } from "lucide-react";
import type { FinalViewDTO } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { VIEW_LABELS } from "@/lib/workflow-ui";
import { VIEW_TYPES, type ViewType } from "@/server/domain/workflow-states";
import { Button } from "@/components/ui/button";
import { DesignImage } from "@/components/ui/design-image";
import { GenerationStatus } from "./generation-status";

type FinalViewGridProps = {
  views: FinalViewDTO[];
  /** Approve/regenerate controls are only shown while reviewing. */
  reviewing?: boolean;
  onApprove?: (viewId: string) => void;
  onRegenerate?: (viewType: ViewType) => void;
  isRunning?: (key: string) => boolean;
  disabled?: boolean;
};

/** Front / Back / Left / Right. Missing views keep their slot so the grid never reflows. */
export function FinalViewGrid({ views, reviewing, onApprove, onRegenerate, isRunning, disabled }: FinalViewGridProps) {
  const byType = new Map(views.map((v) => [v.viewType, v]));
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-5 2xl:grid-cols-4" aria-label="Final views">
      {VIEW_TYPES.map((type) => {
        const view = byType.get(type);
        const status = view?.status;
        return (
          <li key={type} className="flex flex-col gap-2.5">
            <DesignImage
              src={view?.imageUrl ?? null}
              alt={`${VIEW_LABELS[type]} view`}
              sizes="(min-width: 1536px) 18vw, (min-width: 1024px) 32vw, 48vw"
              className={cn(status === "APPROVED" && "ring-2 ring-success/60 ring-offset-2 ring-offset-canvas")}
            >
              {!view || status === "GENERATING" ? <GenerationStatus variant="overlay" title="Generating…" /> : null}
              {status === "FAILED" ? (
                <div className="absolute inset-0 grid place-items-center bg-danger-soft text-caption font-medium text-danger">
                  Couldn&apos;t generate
                </div>
              ) : null}
            </DesignImage>
            <div className="flex min-h-8 items-center justify-between gap-2 px-0.5">
              <span className="text-callout font-medium text-ink">
                {VIEW_LABELS[type]}
                {view && view.versionNumber > 1 ? <span className="ml-1.5 text-caption text-ink-3">v{view.versionNumber}</span> : null}
              </span>
              {status === "APPROVED" ? (
                <span className="inline-flex items-center gap-1 text-caption font-medium text-success">
                  {view?.driveFileId ? <CloudUpload className="size-3.5" /> : <Check className="size-3.5" strokeWidth={2.5} />}
                  {view?.driveFileId ? "In Drive" : "Approved"}
                </span>
              ) : null}
            </div>
            {reviewing && view && (status === "READY" || status === "FAILED") ? (
              <div className="flex gap-2">
                {status === "READY" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    icon={<Check className="size-3.5" strokeWidth={2.5} />}
                    onClick={() => onApprove?.(view.id)}
                    loading={isRunning?.(`approve-${view.id}`)}
                    disabled={disabled}
                  >
                    Approve
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  className={status === "FAILED" ? "flex-1" : undefined}
                  onClick={() => onRegenerate?.(type)}
                  loading={isRunning?.(`regenerate-${type}`)}
                  disabled={disabled}
                  aria-label={`Regenerate ${VIEW_LABELS[type]} view`}
                  icon={<RotateCcw className="size-3.5" />}
                >
                  {status === "FAILED" ? "Try again" : null}
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
