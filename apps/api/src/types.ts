export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
  body?: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Principal {
  /** Stable id from the identity provider. Recorded as the actor in every audit record. */
  id: string;
  grants: Array<{ systemId: string; environment?: string; actions: Action[] }>;
}

export type Action = "read" | "ask" | "approve" | "approve-elevated";
