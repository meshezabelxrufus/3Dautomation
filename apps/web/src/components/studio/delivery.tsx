"use client";

import { Check, CircleAlert, ExternalLink, FileJson, FolderOpen, ImageIcon, RotateCcw } from "lucide-react";
import type { DeliveryDTO, DeliveryItemDTO } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "./error-state";
import { GenerationStatus } from "./generation-status";

/** A Drive link is only shown for real Google Drive (never for the local test double). */
export function driveFolderLink(delivery: DeliveryDTO): string | null {
  const url = delivery.folder?.url;
  return delivery.run?.mode === "live" && url && /^https:\/\/drive\.google\.com\//.test(url) ? url : null;
}

/** Upload progress while the project is UPLOADING_TO_DRIVE, with retry for whatever didn't make it. */
export function DeliveryProgress({
  delivery,
  onRetry,
  pending,
  busy,
}: {
  delivery: DeliveryDTO;
  onRetry: () => void;
  pending: boolean;
  busy: boolean;
}) {
  const run = delivery.run;
  const failed = delivery.items.filter((i) => i.status === "FAILED");
  const doneFiles = delivery.items.filter((i) => i.status === "DONE").length;

  if (!run || run.status === "FAILED") {
    return (
      <div className="flex flex-col gap-4">
        <ErrorState
          variant="inline"
          title={run ? "The Google Drive upload didn't finish" : "The Google Drive upload hasn't started"}
          message={
            run?.errorReason ??
            "All four views are approved. Start the upload to deliver the design package to Google Drive."
          }
          actions={
            <Button size="sm" onClick={onRetry} loading={pending} disabled={busy} icon={<RotateCcw className="size-3.5" />}>
              {run ? "Retry upload" : "Start upload"}
            </Button>
          }
        />
        {run ? (
          <p className="text-caption text-ink-3">
            Files already in Drive are kept and won&apos;t be uploaded again. {failed.length ? `Still missing: ${failed.map((f) => f.name).join(", ")}.` : ""}
          </p>
        ) : null}
        <DeliveryList items={delivery.items} running={false} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <GenerationStatus
        title="Delivering to Google Drive"
        description="Creating the project folder and uploading the master design, the four views and project.json."
        startedAt={run.startedAt}
        progressLabel={`${doneFiles} of ${delivery.items.length} files`}
        progress={doneFiles / Math.max(1, delivery.items.length)}
      />
      <DeliveryList items={delivery.items} />
    </div>
  );
}

export function DeliveryList({ items, compact, running = true }: { items: DeliveryItemDTO[]; compact?: boolean; running?: boolean }) {
  return (
    <ul className={cn("grid gap-2", compact ? "sm:grid-cols-2" : "sm:grid-cols-3")} aria-label="Package files">
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            "flex min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2",
            item.status === "FAILED" ? "border-danger/30 bg-danger-soft/40" : "border-hairline bg-surface",
          )}
        >
          <span className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true">
            {item.kind === "FOLDER" ? <FolderOpen className="size-4" /> : item.name.endsWith(".json") ? <FileJson className="size-4" /> : <ImageIcon className="size-4" />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-callout text-ink">{item.name}</span>
            {item.status === "FAILED" && item.error ? <span className="text-caption text-danger">{item.error}</span> : null}
          </span>
          <span className="mt-0.5 shrink-0" aria-label={item.status.toLowerCase()}>
            {item.status === "DONE" ? (
              <Check className="size-4 text-success" strokeWidth={2.5} />
            ) : item.status === "FAILED" ? (
              <CircleAlert className="size-4 text-danger" />
            ) : running ? (
              <Spinner className="text-[0.8rem] text-ink-3" />
            ) : (
              <span className="text-caption text-ink-3">Not uploaded</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Folder reference on the completion screen: a link for Google Drive, plain text otherwise. */
export function DriveFolderReference({ delivery }: { delivery: DeliveryDTO }) {
  if (!delivery.folder) return null;
  const link = driveFolderLink(delivery);
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-surface p-4">
      <p className="text-eyebrow text-ink-3">Google Drive</p>
      <p className="flex items-center gap-2 text-callout text-ink">
        <FolderOpen className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
        <span className="truncate">3D PROJECTS / {delivery.folder.name}</span>
      </p>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-callout font-medium text-accent hover:underline"
        >
          Open folder in Google Drive <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      ) : delivery.run?.mode === "test" ? (
        <p className="text-caption text-ink-3">Delivered to the local Drive test double (development), not to Google Drive.</p>
      ) : null}
    </div>
  );
}
