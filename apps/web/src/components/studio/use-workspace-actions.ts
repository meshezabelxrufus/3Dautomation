"use client";

import { useCallback, useState, useTransition } from "react";
import type { ActionResult } from "@/app/projects/actions";
import { useRefreshWorkspace } from "@/lib/api/hooks";

export type Notice = { tone: "error" | "success"; message: string };

/**
 * Runs Server Actions for the workspace: tracks which action is pending, refreshes
 * workspace queries right away, and turns failures into an inline notice.
 */
export function useWorkspaceActions(projectId: string) {
  const refresh = useRefreshWorkspace(projectId);
  const [isPending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const run = useCallback(
    (key: string, action: () => Promise<ActionResult>, successMessage?: string) =>
      new Promise<boolean>((resolve) => {
        setPendingKey(key);
        setNotice(null);
        startTransition(async () => {
          let ok = false;
          try {
            const result = await action();
            ok = result.ok;
            if (!result.ok) setNotice({ tone: "error", message: result.message });
            else if (successMessage) setNotice({ tone: "success", message: successMessage });
          } catch {
            setNotice({ tone: "error", message: "Something went wrong. Please try again." });
          } finally {
            await refresh();
            setPendingKey(null);
            resolve(ok);
          }
        });
      }),
    [refresh],
  );

  return {
    run,
    isPending,
    isRunning: (key: string) => isPending && pendingKey === key,
    notice,
    dismissNotice: () => setNotice(null),
  };
}
