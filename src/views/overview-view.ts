import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayClient, ConnectionState } from "../gateway-client.js";
import type { HelloOkPayload } from "../types.js";

@customElement("overview-view")
export class OverviewView extends LitElement {
  @property({ attribute: false }) client!: GatewayClient;
  @property({ type: String }) connectionState: ConnectionState = "disconnected";
  @property({ attribute: false }) serverInfo: HelloOkPayload | null = null;

  @state() private statusData: Record<string, unknown> | null = null;
  @state() private channels: unknown[] = [];
  @state() private presence: unknown[] = [];

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this.loadData();
  }

  private async loadData() {
    if (!this.client || this.connectionState !== "connected") return;
    try {
      const [status, channels, presence] = await Promise.all([
        this.client.loadStatus(),
        this.client.loadChannels().catch(() => null),
        this.client.loadPresence().catch(() => null),
      ]);
      this.statusData = status as Record<string, unknown>;
      this.channels = (channels as { channels?: unknown[] })?.channels ?? [];
      this.presence = (presence as { entries?: unknown[] })?.entries ?? [];
    } catch (err) {
      console.error("Failed to load overview:", err);
    }
  }

  private formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m ${s % 60}s`;
  }

  render() {
    const snap = this.serverInfo?.snapshot;
    const uptime = snap ? this.formatUptime((snap as { uptimeMs?: number }).uptimeMs ?? 0) : "--";
    const authMode = (snap as { authMode?: string })?.authMode ?? "--";
    const version = this.serverInfo?.server?.version ?? "--";

    return html`
      <div class="content">
        <div class="content__header">
          <h1 class="content__title">Overview</h1>
          <button class="btn btn--ghost btn--sm" @click=${() => this.loadData()}>↻ Refresh</button>
        </div>

        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-card__label">Status</div>
            <div class="stat-card__value">
              <span class="status-indicator status-indicator--${this.connectionState}"></span>
              ${this.connectionState === "connected" ? "Online" : "Offline"}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">Version</div>
            <div class="stat-card__value">${version}</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">Uptime</div>
            <div class="stat-card__value">${uptime}</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">Auth</div>
            <div class="stat-card__value">${authMode}</div>
          </div>
        </div>

        ${this.channels.length > 0 ? html`
          <div class="card">
            <h2 class="card__title">Channels</h2>
            <div class="channel-list">
              ${(this.channels as Array<{ id?: string; type?: string; status?: string }>).map((ch) => html`
                <div class="channel-item">
                  <span class="channel-item__name">${ch.type ?? ch.id ?? "unknown"}</span>
                  <span class="badge badge--${ch.status === "connected" ? "ok" : "warn"}">
                    ${ch.status ?? "unknown"}
                  </span>
                </div>
              `)}
            </div>
          </div>
        ` : nothing}

        ${this.presence.length > 0 ? html`
          <div class="card">
            <h2 class="card__title">Active Connections</h2>
            <div class="presence-list">
              ${(this.presence as Array<{ clientId?: string; role?: string }>).map((p) => html`
                <div class="presence-item">
                  <span>${p.clientId ?? "client"}</span>
                  <span class="badge">${p.role ?? ""}</span>
                </div>
              `)}
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }
}
