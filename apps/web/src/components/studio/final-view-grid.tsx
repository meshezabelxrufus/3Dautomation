"use client";

import { Check, CloudUpload, RotateCcw, TriangleAlert } from "lucide-react";
import type { FinalViewDTO } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { VIEW_LABELS } from "@/lib/workflow-ui";
import { VIEW_TYPES, type ViewType } from "@/server/domain/workflow-states";
import { Button } from "@/components/ui/button";
import { DesignImage } from "@/components/ui/design-image";
import { GenerationStatus } from "./generation-status";

type FinalViewGridProps = {
  views: FinalViewDTO[];
  /** "Regenerate this view" on ready views (only while reviewing views). */
  canRegenerate?: boolean;
  /** "Retry" on failed views. */
  canRetry?: boolean;
  onRegenerate?: (viewType: ViewType) => void;
  isRunning?: (key: string) => boolean;
  disabled?: boolean;
};

/** Front / Back / Left / Right, each with its own state. Missing views keep their slot so the grid never reflows. */
export function FinalViewGrid({ views, canRegenerate, canRetry, onRegenerate, isRunning, disabled }: FinalViewGridProps) {
  const byType = new Map(views.map((v) => [v.viewType, v]));
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-5 xl:grid-cols-4" aria-label="Final views">
      {VIEW_TYPES.map((type) => {
        const view = byType.get(type);
        const status = view?.status;
        const label = VIEW_LABELS[type];
        return (
          <li key={type} className="flex flex-col gap-2.5" aria-label={`${label} view${status ? `, ${status.toLowerCase()}` : ""}`}>
            <DesignImage
              src={view?.imageUrl ?? null}
              alt={`${label} view`}
              sizes="(min-width: 1280px) 22vw, 48vw"
              className={cn(status === "APPROVED" && "ring-2 ring-success/60 ring-offset-2 ring-offset-canvas")}
            >
              {!view || status === "GENERATING" ? (
                <GenerationStatus variant="overlay" title={`Rendering ${label.toLowerCase()} view…`} />
              ) : null}
              {status === "FAILED" ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-danger-soft p-4 text-center">
                  <TriangleAlert className="size-5 text-danger" aria-hidden="true" />
                  <span className="text-caption font-medium text-danger">Couldn&apos;t generate</span>
                </div>
              ) : null}
            </DesignImage>
            <div className="flex min-h-8 items-center justify-between gap-2 px-0.5">
              <span className="text-callout font-medium text-ink">
                {label}
                {view && view.versionNumber > 1 ? (
                  <span className="ml-1.5 text-caption font-normal text-ink-3" title={`Version ${view.versionNumber}`}>
                    v{view.versionNumber}
                  </span>
                ) : null}
              </span>
              {status === "APPROVED" ? (
                <span className="inline-flex items-center gap-1 text-caption font-medium text-success">
                  {view?.driveFileId ? <CloudUpload className="size-3.5" /> : <Check className="size-3.5" strokeWidth={2.5} />}
                  {view?.driveFileId ? "In Drive" : "Approved"}
                </span>
              ) : status === "READY" ? (
                <span className="text-caption text-ink-3">Ready</span>
              ) : null}
            </div>
            {status === "FAILED" ? (
              <div className="flex flex-col gap-2">
                <p className="text-caption text-ink-2">{view?.errorReason ?? "This view didn't finish."}</p>
                {canRetry ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onRegenerate?.(type)}
                    loading={isRunning?.(`regenerate-${type}`)}
                    disabled={disabled}
                    icon={<RotateCcw className="size-3.5" />}
                  >
                    Retry {label.toLowerCase()}
                  </Button>
                ) : null}
              </div>
            ) : canRegenerate && (status === "READY" || status === "APPROVED") ? (
              <Button
                size="sm"
                variant="ghost"
                className="self-start px-2"
                onClick={() => onRegenerate?.(type)}
                loading={isRunning?.(`regenerate-${type}`)}
                disabled={disabled}
                icon={<RotateCcw className="size-3.5" />}
              >
                Regenerate this view
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
