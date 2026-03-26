export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: string;
  };
  role: string;
  scopes: string[];
  caps: string[];
  auth?: {
    token?: string;
  };
  userAgent: string;
  locale: string;
}

export interface HelloOkPayload {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features: { methods: string[]; events: string[] };
  snapshot: {
    sessionDefaults?: {
      defaultAgentId?: string;
      mainKey?: string;
      mainSessionKey?: string;
    };
  };
}

export interface ChatSendParams {
  sessionKey: string;
  message: string;
  deliver: boolean;
  idempotencyKey: string;
}

export interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: {
    role?: string;
    text?: string;
    content?: Array<{ type: string; text?: string }>;
    timestamp?: number;
  };
  errorMessage?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  state?: "sending" | "streaming" | "done" | "error";
}
