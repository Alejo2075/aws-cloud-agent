import type { ApiResponse } from "./types.js";
import type { ApiRequest } from "./types.js";

/** Subset of the API Gateway HTTP API (payload v2) event this adapter reads. */
export interface HttpApiEvent {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

export function toApiRequest(e: HttpApiEvent): ApiRequest {
  const headers = Object.fromEntries(
    Object.entries(e.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method: e.requestContext.http.method,
    path: e.rawPath,
    headers,
    ...(e.queryStringParameters && { query: e.queryStringParameters }),
    ...(e.body !== undefined && {
      body: e.isBase64Encoded ? Buffer.from(e.body, "base64").toString("utf8") : e.body,
    }),
  };
}

export function lambdaHandler(handle: (r: ApiRequest) => Promise<ApiResponse>) {
  return async (e: HttpApiEvent) => {
    const r = await handle(toApiRequest(e));
    return { statusCode: r.status, headers: r.headers, body: r.body };
  };
}
