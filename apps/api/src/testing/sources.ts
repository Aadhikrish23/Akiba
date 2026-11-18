import { readFileSync } from 'node:fs';

/** Helpers for the source tests: recorded fixtures and a fake network. Test code only. */

export interface Fixture {
  readonly status: number;
  readonly response: unknown;
  readonly request?: { readonly variables: Record<string, unknown> };
}

export function fixture(source: 'anilist' | 'jikan', name: string): Fixture {
  const path = new URL(`../sources/fixtures/${source}/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const fixtureResponse = (fx: Fixture): Response => jsonResponse(fx.status, fx.response);

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;
}

export type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

/** A `fetch` that records what was asked and answers through `responder`. */
export class FakeNet {
  readonly requests: RecordedRequest[] = [];
  responder: Responder;

  constructor(responder: Responder) {
    this.responder = responder;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request: RecordedRequest = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    this.requests.push(request);
    return this.responder(request, this.requests.length - 1);
  };

  /** Variables of the n-th GraphQL request. */
  variables(index = 0): Record<string, unknown> {
    return (this.requests[index]?.body?.['variables'] ?? {}) as Record<string, unknown>;
  }
}

/** A clock the test moves by hand, and a sleep that only advances it. */
export class ManualTime {
  #ms = 1_700_000_000_000;
  readonly slept: number[] = [];

  readonly now = (): number => this.#ms;

  readonly sleep = (ms: number): Promise<void> => {
    this.slept.push(ms);
    this.#ms += ms;
    return Promise.resolve();
  };

  advance(ms: number): void {
    this.#ms += ms;
  }
}
