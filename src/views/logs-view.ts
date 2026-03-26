import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayClient } from "../gateway-client.js";

interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  [key: string]: unknown;
}

@customElement("logs-view")
export class LogsView extends LitElement {
  @property({ attribute: false }) client!: GatewayClient;

  @state() private entries: LogEntry[] = [];
  @state() private loading = false;
  @state() private levelFilter = "all";
  @state() private autoScroll = true;

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this.loadLogs();
  }

  private async loadLogs() {
    if (!this.client) return;
    this.loading = true;
    try {
      const result = await this.client.loadLogs({ limit: 200 }) as { entries?: LogEntry[] };
      this.entries = result?.entries ?? [];
      if (this.autoScroll) {
        requestAnimationFrame(() => {
          const el = this.querySelector(".logs-container");
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    } catch (err) {
      console.error("Failed to load logs:", err);
    } finally {
      this.loading = false;
    }
  }

  render() {
    const levels = ["all", "error", "warn", "info", "debug"];
    const filtered = this.levelFilter === "all"
      ? this.entries
      : this.entries.filter((e) => e.level === this.levelFilter);

    return html`
      <div class="content">
        <div class="content__header">
          <h1 class="content__title">Logs</h1>
          <div class="content__actions">
            <select class="field__select" @change=${(e: Event) => {
              this.levelFilter = (e.target as HTMLSelectElement).value;
            }}>
              ${levels.map((l) => html`<option value=${l} ?selected=${l === this.levelFilter}>${l}</option>`)}
            </select>
            <button class="btn btn--ghost btn--sm" @click=${() => this.loadLogs()}>
              ${this.loading ? "Loading..." : "↻ Refresh"}
            </button>
          </div>
        </div>

        <div class="logs-container card" style="max-height:calc(100vh - 160px);overflow-y:auto;font-family:var(--mono);font-size:12px;">
          ${filtered.length === 0
            ? html`<div class="empty-state">No log entries</div>`
            : filtered.map((entry) => this.renderEntry(entry))
          }
        </div>
      </div>
    `;
  }

  private renderEntry(entry: LogEntry) {
    const level = entry.level ?? "info";
    const levelClass = level === "error" ? "danger" : level === "warn" ? "warn" : level === "debug" ? "muted" : "";

    return html`
      <div class="log-entry log-entry--${level}" style="padding:4px 8px;border-bottom:1px solid var(--border);">
        <span class="log-entry__time" style="color:var(--muted);margin-right:8px;">
          ${entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ""}
        </span>
        <span class="log-entry__level badge badge--${levelClass}" style="margin-right:8px;font-size:10px;">
          ${level.toUpperCase()}
        </span>
        <span class="log-entry__message">${entry.message ?? JSON.stringify(entry)}</span>
      </div>
    `;
  }
}
