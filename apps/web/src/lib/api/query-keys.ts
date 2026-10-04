export const queryKeys = {
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  status: (id: string) => ["project", id, "status"] as const,
  /** Detail queries are keyed by the status changeToken: a new token means refetch. */
  detail: (id: string, part: "project" | "concepts" | "revisions" | "views", token: string) =>
    ["project", id, part, token] as const,
};
