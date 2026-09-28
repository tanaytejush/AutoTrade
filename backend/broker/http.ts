import { BrokerError } from "./types.js";

export async function requestJson(
  url: string,
  init: RequestInit,
  provider: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new BrokerError(
      `${provider} request failed: ${error instanceof Error ? error.message : "network error"}`,
      "REQUEST_FAILED"
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new BrokerError(`${provider} TOKEN REJECTED / ACCESS DENIED: ${url}`, "AUTH_EXPIRED", response.status);
  }
  if (response.status === 429) {
    throw new BrokerError(`${provider} rate limit exceeded.`, "RATE_LIMITED", response.status);
  }
  if (!response.ok) {
    throw new BrokerError(`${provider} request failed with HTTP ${response.status}.`, "REQUEST_FAILED", response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new BrokerError(`${provider} returned malformed JSON.`, "MALFORMED_RESPONSE", response.status);
  }
}

export async function requestText(
  url: string,
  init: RequestInit,
  provider: string
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new BrokerError(
      `${provider} request failed: ${error instanceof Error ? error.message : "network error"}`,
      "REQUEST_FAILED"
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new BrokerError(`${provider} TOKEN REJECTED / ACCESS DENIED: ${url}`, "AUTH_EXPIRED", response.status);
  }
  if (response.status === 429) {
    throw new BrokerError(`${provider} rate limit exceeded.`, "RATE_LIMITED", response.status);
  }
  if (!response.ok) {
    throw new BrokerError(`${provider} request failed with HTTP ${response.status}.`, "REQUEST_FAILED", response.status);
  }

  return response.text();
}

export function malformed(provider: string, detail: string): BrokerError {
  return new BrokerError(`${provider} returned a malformed response: ${detail}`, "MALFORMED_RESPONSE");
}

export function numberField(value: unknown, provider: string, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    throw malformed(provider, `expected numeric ${field}`);
  }
  return parsed;
}
