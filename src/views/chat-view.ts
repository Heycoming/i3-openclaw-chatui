import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { Marked } from "marked";
import DOMPurify from "dompurify";

const marked = new Marked();

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

function renderMarkdown(text: string): string {
  try {
    const raw = marked.parse(text) as string;
    return DOMPurify.sanitize(raw);
  } catch {
    return DOMPurify.sanitize(text);
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

@customElement("chat-view")
export class ChatView extends LitElement {
  @property({ type: Array }) messages: ChatMessage[] = [];
  @property({ type: String }) stream = "";
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) running = false;
  @property({ type: Boolean }) connected = false;
  @property({ type: String }) sessionKey = "";

  @state() private draft = "";
  @query("#chat-thread") private threadEl!: HTMLElement;
  @query("#chat-input") private inputEl!: HTMLTextAreaElement;

  createRenderRoot() { return this; }

  updated(changed: Map<string, unknown>) {
    if (changed.has("messages") || changed.has("stream")) {
      this.scrollToBottom();
    }
    if (changed.has("connected") && this.connected && this.inputEl) {
      this.inputEl.focus();
    }
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.threadEl) {
        this.threadEl.scrollTop = this.threadEl.scrollHeight;
      }
    });
  }

  private handleSend() {
    const text = this.draft.trim();
    if (!text || !this.connected) return;
    this.draft = "";
    if (this.inputEl) {
      this.inputEl.value = "";
      this.inputEl.style.height = "auto";
    }
    this.dispatchEvent(new CustomEvent("send-chat", { detail: text }));
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleInput(e: InputEvent) {
    const ta = e.target as HTMLTextAreaElement;
    this.draft = ta.value;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 150) + "px";
  }

  render() {
    return html`
      <div class="chat-layout">
        <div class="chat-layout__header">
          <div class="chat-layout__session-info">
            <span class="chat-layout__session-label">${this.sessionKey}</span>
          </div>
          <div class="chat-layout__actions">
            <button class="btn btn--ghost btn--sm" title="New session"
              @click=${() => this.dispatchEvent(new CustomEvent("new-session"))}>
              + New
            </button>
          </div>
        </div>

        <div class="chat-thread" id="chat-thread" role="log" aria-live="polite">
          ${this.loading ? this.renderLoading() : nothing}
          ${this.messages.length === 0 && !this.loading ? this.renderWelcome() : nothing}
          ${this.renderMessages()}
          ${this.stream ? this.renderStreamingMessage() : nothing}
          ${this.running && !this.stream ? this.renderTypingIndicator() : nothing}
        </div>

        <div class="chat-input-area">
          <textarea
            id="chat-input"
            class="chat-input-area__textarea"
            rows="1"
            placeholder=${this.connected ? "Type a message..." : "Connecting..."}
            ?disabled=${!this.connected}
            .value=${this.draft}
            @input=${this.handleInput}
            @keydown=${this.handleKeyDown}
          ></textarea>
          ${this.running
            ? html`<button class="chat-send-btn chat-send-btn--stop" @click=${() =>
                this.dispatchEvent(new CustomEvent("abort-chat"))}>■</button>`
            : html`<button class="chat-send-btn" ?disabled=${!this.connected || !this.draft.trim()}
                @click=${this.handleSend}>↑</button>`
          }
        </div>
      </div>
    `;
  }

  private renderLoading() {
    return html`
      <div class="chat-loading-skeleton">
        <div class="chat-skeleton-bubble chat-skeleton-bubble--short"></div>
        <div class="chat-skeleton-bubble chat-skeleton-bubble--long"></div>
        <div class="chat-skeleton-bubble chat-skeleton-bubble--medium"></div>
      </div>
    `;
  }

  private renderWelcome() {
    return html`
      <div class="chat-welcome">
        <h2 class="chat-welcome__title">OpenClaw</h2>
        <p class="chat-welcome__subtitle">Send a message to start chatting</p>
      </div>
    `;
  }

  private renderMessages() {
    const groups = this.groupMessages(this.messages);
    return groups.map((group) => this.renderMessageGroup(group));
  }

  private groupMessages(messages: ChatMessage[]): ChatMessage[][] {
    const groups: ChatMessage[][] = [];
    let current: ChatMessage[] = [];
    for (const msg of messages) {
      if (current.length > 0 && current[current.length - 1].role !== msg.role) {
        groups.push(current);
        current = [];
      }
      current.push(msg);
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  private isToolRole(role: string) {
    const normalized = role.toLowerCase();
    return normalized === "tool" || normalized === "toolresult" || normalized === "tool_result";
  }

  private isToolBlock(block: Record<string, unknown>) {
    const type = String(block.type ?? "").toLowerCase();
    return type.includes("tool") || type === "result" || type === "input" || Boolean(block.tool_name) || Boolean(block.toolInput);
  }

  private getMessageText(msg: ChatMessage) {
    if (msg.text && msg.text.trim()) return msg.text.trim();
    if (!Array.isArray(msg.content)) return "";
    return msg.content
      .filter((c) => c.type === "text" && typeof c.text === "string" && c.text.trim())
      .map((c) => c.text!.trim())
      .join("\n\n");
  }

  private getMessageToolBlocks(msg: ChatMessage) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const role = msg.role.toLowerCase();
    const toolBlocks = blocks.filter((block) => this.isToolBlock(block as Record<string, unknown>));
    if (toolBlocks.length > 0) {
      return toolBlocks;
    }
    if (!this.isToolRole(role)) {
      return [];
    }
    const raw = msg as Record<string, unknown>;
    const summary = typeof raw.toolName === "string" ? raw.toolName : typeof raw.tool_name === "string" ? raw.tool_name : typeof raw.name === "string" ? raw.name : "tool result";
    return summary ? [{ type: "tool_result", tool_name: summary, content: raw.content, details: raw.details, tool_input: raw.tool_input }] : [];
  }

  private hasRenderableMessage(msg: ChatMessage) {
    return Boolean(this.getMessageText(msg) || this.getMessageToolBlocks(msg).length);
  }

  private formatToolTitle(block: Record<string, unknown>, isToolResult: boolean) {
    const toolName = typeof block.tool_name === "string" && block.tool_name.trim()
      ? block.tool_name.trim()
      : typeof block.name === "string" && block.name.trim()
        ? block.name.trim()
        : typeof block.toolName === "string" && block.toolName.trim()
          ? block.toolName.trim()
          : "tool";
    return isToolResult ? `tool result: ${toolName}` : toolName;
  }

  private formatToolDetails(block: Record<string, unknown>) {
    const chunks: string[] = [];
    const args = block.arguments ?? block.tool_input ?? block.input;
    if (args !== undefined) {
      chunks.push(typeof args === "string" ? args : JSON.stringify(args, null, 2));
    }
    const details = block.details;
    if (details !== undefined) {
      chunks.push(typeof details === "string" ? details : JSON.stringify(details, null, 2));
    }
    const text = typeof block.text === "string" ? block.text.trim() : "";
    if (text) {
      chunks.push(text);
    }
    const content = block.content;
    if (Array.isArray(content)) {
      const contentText = content
        .map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? String((item as { text?: unknown }).text).trim() : ""))
        .filter(Boolean)
        .join("\n\n");
      if (contentText) {
        chunks.push(contentText);
      }
    }
    return chunks.filter(Boolean).join("\n\n");
  }

  private renderToolCard(block: Record<string, unknown>, isToolResult: boolean) {
    const title = this.formatToolTitle(block, isToolResult);
    const details = this.formatToolDetails(block);

    return html`
      <details class="tool-card chat-tool-card">
        <summary class="tool-card__summary">
          <span class="tool-card__name">🔧 ${title}</span>
          <span class="tool-card__summary-hint">details</span>
        </summary>
        ${details ? html`
          <div class="tool-card__details">
            <pre class="tool-card__input">${details}</pre>
          </div>
        ` : nothing}
      </details>
    `;
  }

  private renderMessageGroup(group: ChatMessage[]) {
    const visibleMessages = group.filter((msg) => this.hasRenderableMessage(msg));
    if (visibleMessages.length === 0) return nothing;

    const role = visibleMessages[0].role;
    const isUser = role === "user";
    const isTool = this.isToolRole(role);
    const lastMsg = visibleMessages[visibleMessages.length - 1];

    return html`
      <div class="chat-group chat-group--${role}">
        ${!isUser ? html`<div class="chat-group__avatar">${isTool ? "🧰" : "🤖"}</div>` : nothing}
        <div class="chat-group__messages">
          ${visibleMessages.map((msg) => this.renderBubble(msg, isUser))}
          ${lastMsg.timestamp ? html`
            <div class="chat-group__meta">
              <span class="chat-group__time">${formatTime(lastMsg.timestamp)}</span>
              ${lastMsg.model ? html`<span class="chat-group__model">${this.shortenModel(lastMsg.model)}</span>` : nothing}
              ${lastMsg.usage ? html`
                <span class="chat-group__tokens">
                  ↑${formatTokens(lastMsg.usage.input ?? 0)}
                  ↓${formatTokens(lastMsg.usage.output ?? 0)}
                </span>
              ` : nothing}
              ${lastMsg.cost?.total ? html`
                <span class="chat-group__cost">$${lastMsg.cost.total.toFixed(4)}</span>
              ` : nothing}
            </div>
          ` : nothing}
        </div>
        ${isUser ? html`<div class="chat-group__avatar chat-group__avatar--user">👤</div>` : nothing}
      </div>
    `;
  }

  private renderBubble(msg: ChatMessage, isUser: boolean) {
    const text = this.getMessageText(msg);
    const toolBlocks = this.getMessageToolBlocks(msg).map((block) => block as Record<string, unknown>);
    const isTool = this.isToolRole(msg.role);

    if (!text && toolBlocks.length === 0) {
      return nothing;
    }

    if (isTool) {
      return html`
        <div class="chat-bubble chat-bubble--tool">
          ${toolBlocks.map((block) => this.renderToolCard(block, true))}
        </div>
      `;
    }

    return html`
      <div class="chat-bubble ${isUser ? "chat-bubble--user" : "chat-bubble--assistant"}">
        ${isUser
          ? html`<div class="chat-bubble__text">${text}</div>`
          : text
            ? html`<div class="chat-bubble__text chat-bubble__markdown"
                .innerHTML=${renderMarkdown(text)}></div>`
            : nothing
        }
        ${toolBlocks.length > 0 ? html`
          <div class="chat-bubble__tools">
            ${toolBlocks.map((block) => this.renderToolCard(block, false))}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderStreamingMessage() {
    return html`
      <div class="chat-group chat-group--assistant">
        <div class="chat-group__avatar">🤖</div>
        <div class="chat-group__messages">
          <div class="chat-bubble chat-bubble--assistant chat-bubble--streaming">
            <div class="chat-bubble__text chat-bubble__markdown"
              .innerHTML=${renderMarkdown(this.stream)}></div>
            <span class="streaming-cursor"></span>
          </div>
        </div>
      </div>
    `;
  }

  private renderTypingIndicator() {
    return html`
      <div class="chat-group chat-group--assistant">
        <div class="chat-group__avatar">🤖</div>
        <div class="chat-group__messages">
          <div class="chat-bubble chat-bubble--assistant chat-reading-indicator">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
        </div>
      </div>
    `;
  }

  private shortenModel(model: string): string {
    return model
      .replace("claude-", "")
      .replace("gpt-", "")
      .replace("-latest", "")
      .replace("-20250", "");
  }
}
