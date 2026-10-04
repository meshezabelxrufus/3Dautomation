import { ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/studio/error-state";

export default function ProjectNotFound() {
  return (
    <ErrorState
      title="Project not found"
      message="It may have been deleted, or the link is incomplete."
      actions={<ButtonLink href="/projects">All projects</ButtonLink>}
    />
  );
}
