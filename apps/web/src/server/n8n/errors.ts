/** n8n could not be reached, timed out, or returned a server error (5xx). Safe to retry. */
export class N8nUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "N8nUnavailableError";
  }
}

/** n8n rejected the request (4xx), e.g. validation. `fields` uses the app's field names. */
export class N8nRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "N8nRejectedError";
  }
}

/** n8n answered with something that doesn't match the contract (a bug, not an outage). */
export class N8nContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "N8nContractError";
  }
}
