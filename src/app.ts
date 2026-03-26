import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GatewayClient, type ConnectionState } from "./gateway-client.js";
import type { ChatEventPayload } from "./types.js";
import { uuid } from "./uuid.js";
import "./views/chat-view.js";
import "./views/overview-view.js";
import "./views/logs-view.js";

type Tab = "chat" | "overview" | "logs";

interface ChatMessage {
  id: string;
  role: string;
  text: string;
  content?: Array<{ type: string; text?: string; tool_use_id?: string; tool_name?: string; tool_input?: unknown }>;
  timestamp?: number;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  cost?: { total?: number };
}

interface SessionRow {
  key: string;
  kind?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  status?: string;
  totalTokens?: number;
  model?: string;
}

type SessionGroup = { label: string; sessions: SessionRow[] };

function groupSessionsByTime(sessions: SessionRow[]): SessionGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;

  const today: SessionRow[] = [];
  const yesterday: SessionRow[] = [];
  const earlier: SessionRow[] = [];

  for (const s of sessions) {
    const t = s.updatedAt ?? 0;
    if (t >= todayStart) today.push(s);
    else if (t >= yesterdayStart) yesterday.push(s);
    else earlier.push(s);
  }

  const groups: SessionGroup[] = [];
  if (today.length) groups.push({ label: "Today", sessions: today });
  if (yesterday.length) groups.push({ label: "Yesterday", sessions: yesterday });
  if (earlier.length) groups.push({ label: "Earlier", sessions: earlier });
  return groups;
}

function sessionTitle(s: SessionRow): string {
  if (s.label) return s.label;
  if (s.displayName) return s.displayName;
  const parts = s.key.split(":");
  const last = parts[parts.length - 1];
  if (last === "main") return "Main Chat";
  if (last.length > 12) return last.slice(0, 12) + "...";
  return last;
}

@customElement("openclaw-app")
export class OpenClawApp extends LitElement {
  @state() connectionState: ConnectionState = "disconnected";
  @state() tab: Tab = "chat";
  @state() lastError = "";
  @state() navCollapsed = false;
  @state() mobileNavOpen = false;

  @state() gatewayUrl = "";
  @state() token = "";

  @state() chatMessages: ChatMessage[] = [];
  @state() chatStream = "";
  @state() chatStreamRunId = "";
  @state() chatLoading = false;
  @state() chatRunning = false;

  @state() sessions: SessionRow[] = [];

  client = new GatewayClient();
  private sessionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.client.on("stateChange", (s) => this.handleStateChange(s));
    this.client.on("chatEvent", (p) => this.handleChatEvent(p));
    this.client.on("sessionsChanged", () => this.debouncedLoadSessions());
    this.client.on("error", (m) => { this.lastError = m; });
    this.loadFromUrl();
  }

  private loadFromUrl() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : "");
    this.gatewayUrl = params.get("gateway") ?? hashParams.get("gateway") ?? "";
    this.token = hashParams.get("token") ?? params.get("token") ?? "";
    if (this.gatewayUrl && this.token) {
      this.doConnect();
    }
  }

  private doConnect() {
    let wsUrl = this.gatewayUrl;
    if (wsUrl.startsWith("http://")) wsUrl = wsUrl.replace("http://", "ws://");
    else if (wsUrl.startsWith("https://")) wsUrl = wsUrl.replace("https://", "wss://");
    else if (!wsUrl.startsWith("ws://") && !wsUrl.startsWith("wss://")) wsUrl = `wss://${wsUrl}`;
    this.lastError = "";
    this.client.connect(wsUrl, this.token);
  }

  private handleStateChange(s: ConnectionState) {
    this.connectionState = s;
    if (s === "connected") {
      this.loadChatHistory();
      this.loadSessions();
    }
  }

  private async loadChatHistory() {
    this.chatLoading = true;
    try {
      const result = await this.client.loadChatHistory() as { messages?: ChatMessage[] };
      this.chatMessages = (result?.messages ?? []).map((m: ChatMessage) => ({
        ...m,
        id: (m as { id?: string }).id ?? uuid(),
        text: this.extractMessageText(m),
      }));
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      this.chatLoading = false;
    }
  }

  async loadSessions() {
    try {
      const result = await this.client.listSessions() as { sessions?: SessionRow[] };
      const list = result?.sessions ?? [];
      list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      this.sessions = list;
    } catch { /* ignore */ }
  }

  private debouncedLoadSessions() {
    if (this.sessionsRefreshTimer) return;
    this.sessionsRefreshTimer = setTimeout(() => {
      this.sessionsRefreshTimer = null;
      this.loadSessions();
    }, 500);
  }

  private handleChatEvent(payload: ChatEventPayload) {
    if (payload.state === "delta") {
      const text = this.extractEventText(payload);
      if (text) {
        this.chatStream += text;
        this.chatStreamRunId = payload.runId;
        this.chatRunning = true;
      }
    } else if (payload.state === "final") {
      const finalText = this.extractEventText(payload) || this.chatStream;
      const msg: ChatMessage = {
        id: uuid(),
        role: "assistant",
        text: finalText,
        content: (payload.message as ChatMessage)?.content,
        timestamp: Date.now(),
        model: (payload.message as ChatMessage)?.model,
        usage: (payload.message as ChatMessage)?.usage,
        cost: (payload.message as ChatMessage)?.cost,
      };
      this.chatMessages = [...this.chatMessages, msg];
      this.chatStream = "";
      this.chatStreamRunId = "";
      this.chatRunning = false;
      this.debouncedLoadSessions();
    } else if (payload.state === "error") {
      const msg: ChatMessage = {
        id: uuid(),
        role: "assistant",
        text: `Error: ${payload.errorMessage ?? "Unknown error"}`,
        timestamp: Date.now(),
      };
      this.chatMessages = [...this.chatMessages, msg];
      this.chatStream = "";
      this.chatRunning = false;
    } else if (payload.state === "aborted") {
      if (this.chatStream) {
        const msg: ChatMessage = {
          id: uuid(),
          role: "assistant",
          text: this.chatStream,
          timestamp: Date.now(),
        };
        this.chatMessages = [...this.chatMessages, msg];
      }
      this.chatStream = "";
      this.chatRunning = false;
    }
  }

  async handleSendChat(text: string) {
    const userMsg: ChatMessage = {
      id: uuid(),
      role: "user",
      text,
      timestamp: Date.now(),
    };
    this.chatMessages = [...this.chatMessages, userMsg];
    this.chatRunning = true;
    this.chatStream = "";
    try {
      await this.client.sendChat(text);
    } catch (err) {
      this.chatRunning = false;
      const errMsg: ChatMessage = {
        id: uuid(),
        role: "assistant",
        text: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      };
      this.chatMessages = [...this.chatMessages, errMsg];
    }
  }

  async handleAbortChat() {
    try {
      await this.client.abortChat();
    } catch { /* ignore */ }
  }

  async handleNewChat() {
    try {
      const result = await this.client.createSession() as { key?: string };
      if (result?.key) {
        this.client.sessionKey = result.key;
        this.chatMessages = [];
        this.chatStream = "";
        this.chatRunning = false;
        this.tab = "chat";
        this.mobileNavOpen = false;
        this.loadSessions();
        return;
      }
    } catch {
      // sessions.create not supported on older gateways, fall back to reset
    }
    try {
      await this.client.resetSession();
    } catch {
      // ignore
    }
    this.chatMessages = [];
    this.chatStream = "";
    this.chatRunning = false;
    this.chatLoading = false;
    this.tab = "chat";
    this.mobileNavOpen = false;
  }

  async handleSwitchSession(key: string) {
    if (key === this.client.sessionKey) {
      this.tab = "chat";
      this.mobileNavOpen = false;
      return;
    }
    this.client.sessionKey = key;
    this.chatMessages = [];
    this.chatStream = "";
    this.chatRunning = false;
    this.tab = "chat";
    this.mobileNavOpen = false;
    await this.loadChatHistory();
  }

  private extractMessageText(m: ChatMessage): string {
    if (m.text) return m.text;
    if (m.content) {
      return m.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("");
    }
    return "";
  }

  private extractEventText(payload: ChatEventPayload): string {
    if (!payload.message) return "";
    const msg = payload.message as ChatMessage;
    if (typeof msg.text === "string") return msg.text;
    if (msg.content) {
      return msg.content
        .filter((c: { type: string; text?: string }) => c.type === "text" && c.text)
        .map((c: { text?: string }) => c.text!)
        .join("");
    }
    return "";
  }

  private handleLogin() {
    const gInput = this.querySelector<HTMLInputElement>("#login-gateway")!;
    const tInput = this.querySelector<HTMLInputElement>("#login-token")!;
    this.gatewayUrl = gInput.value.trim();
    this.token = tInput.value.trim();
    if (!this.gatewayUrl || !this.token) {
      this.lastError = "Gateway URL and token are required";
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("gateway", this.gatewayUrl);
    url.hash = `token=${encodeURIComponent(this.token)}`;
    window.history.replaceState(null, "", url.toString());
    this.doConnect();
  }

  private setTab(t: Tab) {
    this.tab = t;
    this.mobileNavOpen = false;
  }

  render() {
    if (this.connectionState === "disconnected" && !this.gatewayUrl) {
      return this.renderLogin();
    }
    return this.renderShell();
  }

  private renderLogin() {
    return html`
      <div class="login-gate">
        <div class="login-gate__card">
          <div class="login-gate__header">
            <h1 class="login-gate__title">OpenClaw</h1>
            <p class="login-gate__subtitle">Connect to your gateway</p>
          </div>
          <div class="login-gate__form">
            <div class="field">
              <label class="field__label">Gateway URL</label>
              <input id="login-gateway" class="field__input" type="url"
                placeholder="wss://35-188-23-25.nip.io"
                .value=${this.gatewayUrl}
                @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.handleLogin()} />
            </div>
            <div class="field">
              <label class="field__label">Token</label>
              <input id="login-token" class="field__input" type="password"
                placeholder="Your gateway token"
                .value=${this.token}
                @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.handleLogin()} />
            </div>
            ${this.lastError ? html`<div class="callout callout--danger">${this.lastError}</div>` : nothing}
            <button class="btn btn--primary btn--lg" style="width:100%;margin-top:8px"
              @click=${() => this.handleLogin()}>
              ${this.connectionState === "connecting" ? "Connecting..." : "Connect"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderShell() {
    return html`
      <div class="shell" ?data-nav-collapsed=${this.navCollapsed}>
        <div class="topbar">
          <button class="topbar__menu-btn" @click=${() => { this.mobileNavOpen = !this.mobileNavOpen; }}>☰</button>
          <span class="topbar__title">OpenClaw</span>
          <div class="topbar__status">
            <span class="status-indicator status-indicator--${this.connectionState}"></span>
          </div>
        </div>

        <nav class="nav ${this.mobileNavOpen ? "nav--mobile-open" : ""}">
          <div class="nav__header">
            <span class="nav__logo">OpenClaw</span>
            <button class="nav__collapse-btn" @click=${() => { this.navCollapsed = !this.navCollapsed; }}>
              ${this.navCollapsed ? "›" : "‹"}
            </button>
          </div>

          <div class="nav__new-chat">
            <button class="nav__new-chat-btn" @click=${() => this.handleNewChat()}>
              <span class="nav__new-chat-icon">+</span>
              <span class="nav__item-label">New Chat</span>
            </button>
          </div>

          <div class="nav__sessions">
            ${this.renderSessionList()}
          </div>

          <div class="nav__divider"></div>

          <div class="nav__items">
            <button class="nav__item ${this.tab === "overview" ? "nav__item--active" : ""}"
              @click=${() => this.setTab("overview")}>
              <span class="nav__item-icon">📊</span>
              <span class="nav__item-label">Overview</span>
            </button>
            <button class="nav__item ${this.tab === "logs" ? "nav__item--active" : ""}"
              @click=${() => this.setTab("logs")}>
              <span class="nav__item-icon">📜</span>
              <span class="nav__item-label">Logs</span>
            </button>
          </div>

          <div class="nav__footer">
            <div class="nav__connection-info">
              <span class="status-indicator status-indicator--${this.connectionState}"></span>
              <span class="nav__connection-label">
                ${this.connectionState === "connected" ? "Connected" :
                  this.connectionState === "connecting" ? "Connecting..." :
                  this.connectionState === "error" ? "Error" : "Disconnected"}
              </span>
            </div>
          </div>
        </nav>

        ${this.mobileNavOpen ? html`
          <div class="nav-backdrop" @click=${() => { this.mobileNavOpen = false; }}></div>
        ` : nothing}

        <main class="main-content">
          ${this.renderTab()}
        </main>
      </div>
    `;
  }

  private renderSessionList() {
    if (this.sessions.length === 0) {
      return html`<div class="nav__sessions-empty">No conversations yet</div>`;
    }

    const groups = groupSessionsByTime(this.sessions);
    const activeKey = this.client.sessionKey;

    return groups.map((g) => html`
      <div class="nav__session-group">
        <div class="nav__session-group-label">${g.label}</div>
        ${g.sessions.map((s) => html`
          <button
            class="nav__session-item ${s.key === activeKey ? "nav__session-item--active" : ""}"
            @click=${() => this.handleSwitchSession(s.key)}
            title=${s.key}
          >
            <span class="nav__session-title">${sessionTitle(s)}</span>
            ${s.status === "running" ? html`<span class="nav__session-running"></span>` : nothing}
          </button>
        `)}
      </div>
    `);
  }

  private renderTab() {
    switch (this.tab) {
      case "chat":
        return html`
          <chat-view
            .messages=${this.chatMessages}
            .stream=${this.chatStream}
            .loading=${this.chatLoading}
            .running=${this.chatRunning}
            .connected=${this.connectionState === "connected"}
            .sessionKey=${this.client.sessionKey}
            @send-chat=${(e: CustomEvent) => this.handleSendChat(e.detail)}
            @abort-chat=${() => this.handleAbortChat()}
            @new-session=${() => this.handleNewChat()}
          ></chat-view>
        `;
      case "overview":
        return html`
          <overview-view
            .client=${this.client}
            .connectionState=${this.connectionState}
            .serverInfo=${this.client.serverInfo}
          ></overview-view>
        `;
      case "logs":
        return html`
          <logs-view .client=${this.client}></logs-view>
        `;
      default:
        return nothing;
    }
  }
}
