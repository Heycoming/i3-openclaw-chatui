import type {
  ConnectParams,
  ResponseFrame,
  EventFrame,
  Frame,
  HelloOkPayload,
  ChatSendParams,
  ChatEventPayload,
} from "./types.js";
import { uuid } from "./uuid.js";

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
};

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type GatewayClientEvents = {
  stateChange: (state: ConnectionState) => void;
  chatEvent: (payload: ChatEventPayload) => void;
  sessionsChanged: (payload: unknown) => void;
  event: (name: string, payload: unknown) => void;
  error: (message: string) => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private listeners: Partial<{ [K in keyof GatewayClientEvents]: GatewayClientEvents[K][] }> = {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 800;
  private maxReconnectDelay = 15_000;
  private shouldReconnect = false;

  private _state: ConnectionState = "disconnected";
  private _url = "";
  private _token = "";
  private _sessionKey = "agent:main:main";
  private _helloOk: HelloOkPayload | null = null;

  get state() { return this._state; }
  get sessionKey() { return this._sessionKey; }
  set sessionKey(key: string) { this._sessionKey = key; }
  get serverInfo() { return this._helloOk; }
  get features() { return this._helloOk?.features; }

  on<K extends keyof GatewayClientEvents>(event: K, fn: GatewayClientEvents[K]) {
    (this.listeners[event] ??= [] as GatewayClientEvents[K][]).push(fn);
  }

  private emit<K extends keyof GatewayClientEvents>(event: K, ...args: Parameters<GatewayClientEvents[K]>) {
    const fns = this.listeners[event];
    if (fns) for (const fn of fns) (fn as (...a: unknown[]) => void)(...args);
  }

  private setState(state: ConnectionState) {
    this._state = state;
    this.emit("stateChange", state);
  }

  connect(url: string, token: string) {
    this._url = url;
    this._token = token;
    this.shouldReconnect = true;
    this.reconnectDelay = 800;
    this.doConnect();
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.flushPending("Disconnected");
    this.setState("disconnected");
  }

  // --- Chat API ---
  async sendChat(message: string, sessionKey?: string): Promise<string> {
    const idempotencyKey = uuid();
    const params: ChatSendParams = {
      sessionKey: sessionKey ?? this._sessionKey,
      message,
      deliver: false,
      idempotencyKey,
    };
    await this.request("chat.send", params);
    return idempotencyKey;
  }

  async loadChatHistory(sessionKey?: string, limit = 200): Promise<unknown> {
    return this.request("chat.history", {
      sessionKey: sessionKey ?? this._sessionKey,
      limit,
    });
  }

  async abortChat(sessionKey?: string, runId?: string): Promise<unknown> {
    return this.request("chat.abort", {
      sessionKey: sessionKey ?? this._sessionKey,
      ...(runId ? { runId } : {}),
    });
  }

  // --- Sessions API ---
  async listSessions(): Promise<unknown> {
    return this.request("sessions.list", {
      limit: 50,
      includeDerivedTitles: true,
      includeGlobal: false,
      includeUnknown: false,
    });
  }

  async createSession(opts?: { label?: string; task?: string }): Promise<unknown> {
    return this.request("sessions.create", { agentId: "main", ...opts });
  }

  async resetSession(key?: string): Promise<unknown> {
    return this.request("sessions.reset", { key: key ?? this._sessionKey });
  }

  async patchSession(key: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request("sessions.patch", { key, ...patch });
  }

  async deleteSessions(keys: string[]): Promise<unknown> {
    return this.request("sessions.delete", { keys });
  }

  // --- Channels API ---
  async loadChannels(): Promise<unknown> {
    return this.request("channels.status", {});
  }

  // --- Config API ---
  async loadConfig(): Promise<unknown> {
    return this.request("config.load", {});
  }

  async saveConfig(config: unknown): Promise<unknown> {
    return this.request("config.save", { config });
  }

  // --- Status / Logs / Debug ---
  async loadStatus(): Promise<unknown> {
    return this.request("status", {});
  }

  async loadLogs(opts?: { level?: string; limit?: number; before?: string }): Promise<unknown> {
    return this.request("logs.read", opts ?? {});
  }

  // --- Agents ---
  async listAgents(): Promise<unknown> {
    return this.request("agents.list", {});
  }

  // --- Skills ---
  async loadSkills(): Promise<unknown> {
    return this.request("skills.status", {});
  }

  // --- Cron ---
  async listCronJobs(): Promise<unknown> {
    return this.request("cron.jobs.list", {});
  }

  // --- Devices ---
  async listDevices(): Promise<unknown> {
    return this.request("devices.list", {});
  }

  // --- Presence ---
  async loadPresence(): Promise<unknown> {
    return this.request("presence.list", {});
  }

  // --- Usage ---
  async queryUsage(params?: Record<string, unknown>): Promise<unknown> {
    return this.request("usage.query", params ?? {});
  }

  // --- Generic request ---
  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not open"));
        return;
      }
      const id = uuid();
      this.pending.set(id, { resolve, reject });
      const frame = { type: "req", id, method, params };
      this.ws.send(JSON.stringify(frame));

      setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.reject(new Error(`Request ${method} timed out`));
        }
      }, 30_000);
    });
  }

  // --- Internal ---
  private doConnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState("connecting");

    const wsUrl = this._url.replace(/^http/, "ws");
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      setTimeout(() => this.sendConnectFrame(), 200);
    };

    this.ws.onmessage = (ev) => {
      try {
        const frame: Frame = JSON.parse(ev.data as string);
        this.handleFrame(frame);
      } catch {
        console.warn("[gateway] Failed to parse frame", ev.data);
      }
    };

    this.ws.onclose = () => {
      this.flushPending("Connection closed");
      if (this._state === "connected") {
        this.setState("disconnected");
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.emit("error", "WebSocket connection error");
      this.setState("error");
    };
  }

  private async sendConnectFrame() {
    const params: ConnectParams = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "webchat-ui",
        version: "0.1.0",
        platform: "web",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
      caps: ["tool-events"],
      auth: { token: this._token },
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    try {
      const result = await this.request("connect", params) as HelloOkPayload;
      this._helloOk = result;
      if (result?.snapshot?.sessionDefaults?.mainSessionKey) {
        this._sessionKey = result.snapshot.sessionDefaults.mainSessionKey;
      }
      this.reconnectDelay = 800;
      this.setState("connected");
      console.log("[gateway] Connected, session:", this._sessionKey);
    } catch (err) {
      console.error("[gateway] Connect failed:", err);
      this.emit("error", `Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
      this.setState("error");
      this.shouldReconnect = false;
    }
  }

  private handleFrame(frame: Frame) {
    if (frame.type === "res") {
      this.handleResponse(frame as ResponseFrame);
    } else if (frame.type === "event") {
      this.handleEvent(frame as EventFrame);
    }
  }

  private handleResponse(frame: ResponseFrame) {
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    if (frame.ok) {
      p.resolve(frame.payload);
    } else {
      p.reject(new Error(frame.error?.message ?? "Unknown error"));
    }
  }

  private handleEvent(frame: EventFrame) {
    if (frame.event === "chat") {
      this.emit("chatEvent", frame.payload as ChatEventPayload);
    } else if (frame.event === "sessions.changed") {
      this.emit("sessionsChanged", frame.payload);
    }
    this.emit("event", frame.event, frame.payload);
  }

  private flushPending(reason: string) {
    for (const [id, p] of this.pending) {
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.doConnect();
      }
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
  }
}
