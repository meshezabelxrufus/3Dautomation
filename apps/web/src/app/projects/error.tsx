"use client";

import { RotateCcw } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/studio/error-state";

export default function ProjectsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Couldn't load this page"
      message="The studio couldn't reach its data just now. Check that the services are running, then try again."
      actions={
        <>
          <Button onClick={reset} icon={<RotateCcw className="size-4" />}>
            Try again
          </Button>
          <ButtonLink href="/projects" variant="secondary">
            All projects
          </ButtonLink>
        </>
      }
    />
  );
}
