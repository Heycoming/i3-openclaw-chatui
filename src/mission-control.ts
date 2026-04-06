import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface MissionControlEvent {
  id?: number | string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  eventType?: string;
  action?: string;
  title?: string;
  description?: string;
  message?: string;
  data?: unknown;
  timestamp?: string;
  createdAt?: string;
}

interface MissionControlDocument {
  id?: number | string;
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  title?: string;
  description?: string;
  content?: unknown;
  type?: string;
  path?: string;
  eventType?: string;
  timestamp?: string;
  createdAt?: string;
}

interface MissionControlTask {
  id?: number | string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  status?: string;
  title?: string;
  description?: string;
  prompt?: string;
  response?: unknown;
  error?: unknown;
  source?: string;
  timestamp?: string;
  createdAt?: string;
  events?: MissionControlEvent[];
  documents?: MissionControlDocument[];
}

interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
}

interface LogsPayload {
  error?: string;
  dbPath?: string;
  generatedAt?: string;
  tasks?: MissionControlTask[];
  pagination?: Partial<PaginationMeta>;
}

type FilterPreset = "none" | "today" | "last7days" | "success" | "failed" | "running" | "5min" | "10min" | "30min" | "1h" | "6h" | "12h" | "24h";
type TimePreset = "5min" | "10min" | "30min" | "1h" | "6h" | "12h" | "24h" | "none";

const DEFAULT_PAGINATION: PaginationMeta = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 0,
  hasPrev: false,
  hasNext: false,
};

@customElement("mission-control-view")
export class MissionControlView extends LitElement {
  @property({ type: String }) gatewayUrl = "";

  @state() private loading = false;
  @state() private tasks: MissionControlTask[] = [];
  @state() private dbPath = "-";
  @state() private generatedAt = "";
  @state() private error = "";

  @state() private pagination: PaginationMeta = { ...DEFAULT_PAGINATION };
  @state() private pageSize = 20;

  @state() private showFilters = false;
  @state() private activePreset: FilterPreset = "none";
  @state() private activeTimePreset: TimePreset = "none";
  @state() private keyword = "";
  @state() private statusFilter = "all";
  @state() private sourceFilter = "";
  @state() private sessionIdFilter = "";
  @state() private sessionKeyFilter = "";
  @state() private timeFrom = "";
  @state() private timeTo = "";
  @state() private dateFromTime = "";
  @state() private dateToTime = "";
  @state() private outcomeFilter: "all" | "success" | "failed" = "all";
  @state() private selectedSessionId = "";
  @state() private sessionPickerSearch = "";

  private readonly apiPath = "/api/mission-control/logs";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private openDetails = new Set<string>();

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.initializeDefaultTimes();
    void this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, 3000);
  }

  private initializeDefaultTimes() {
    // Initialize dateFromTime to 5 minutes before now and dateToTime to now
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    
    this.dateFromTime = this.formatTimeInput(fiveMinutesAgo);
    this.dateToTime = this.formatTimeInput(now);
  }

  private formatTimeInput(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private resolveApiOrigin() {
    const raw = this.gatewayUrl.trim();
    if (!raw) return window.location.origin;

    let normalized = raw;
    if (normalized.startsWith("ws://")) {
      normalized = normalized.replace("ws://", "http://");
    } else if (normalized.startsWith("wss://")) {
      normalized = normalized.replace("wss://", "https://");
    } else if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      normalized = `https://${normalized}`;
    }

    try {
      return new URL(normalized).origin;
    } catch {
      return window.location.origin;
    }
  }

  private buildRequestUrl() {
    const url = new URL(this.apiPath, this.resolveApiOrigin());
    url.searchParams.set("page", String(this.pagination.page));
    url.searchParams.set("pageSize", String(this.pageSize));

    if (this.keyword.trim()) url.searchParams.set("q", this.keyword.trim());
    if (this.statusFilter !== "all") url.searchParams.set("status", this.statusFilter);
    if (this.sourceFilter.trim()) url.searchParams.set("source", this.sourceFilter.trim());
    if (this.sessionIdFilter.trim()) url.searchParams.set("sessionId", this.sessionIdFilter.trim());
    if (this.sessionKeyFilter.trim()) url.searchParams.set("sessionKey", this.sessionKeyFilter.trim());
    if (this.outcomeFilter !== "all") url.searchParams.set("outcome", this.outcomeFilter);

    if (this.timeFrom) {
      const timeStr = this.dateFromTime || "00:00:00";
      const from = new Date(`${this.timeFrom}T${timeStr}.000Z`);
      if (!Number.isNaN(from.valueOf())) {
        url.searchParams.set("timeFrom", from.toISOString());
      }
    }

    if (this.timeTo) {
      const timeStr = this.dateToTime || "23:59:59";
      const to = new Date(`${this.timeTo}T${timeStr}.999Z`);
      if (!Number.isNaN(to.valueOf())) {
        url.searchParams.set("timeTo", to.toISOString());
      }
    }

    return url.toString();
  }

  private async refresh() {
    this.loading = true;
    this.error = "";

    try {
      const response = await fetch(this.buildRequestUrl(), { cache: "no-store" });
      const payload = (await response.json()) as LogsPayload;

      if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }

      this.setPayload(payload);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.tasks = [];
    } finally {
      this.loading = false;
    }
  }

  private setPayload(payload: LogsPayload) {
    this.error = payload.error || "";
    this.dbPath = payload.dbPath || "-";
    this.generatedAt = payload.generatedAt || "";
    this.tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    this.syncSelectedSession();

    const pagination = payload.pagination;
    this.pagination = {
      page: Number.isFinite(pagination?.page) ? Number(pagination?.page) : this.pagination.page,
      pageSize: Number.isFinite(pagination?.pageSize) ? Number(pagination?.pageSize) : this.pageSize,
      total: Number.isFinite(pagination?.total) ? Number(pagination?.total) : this.tasks.length,
      totalPages: Number.isFinite(pagination?.totalPages) ? Number(pagination?.totalPages) : 0,
      hasPrev: Boolean(pagination?.hasPrev),
      hasNext: Boolean(pagination?.hasNext),
    };

    if (this.pagination.pageSize !== this.pageSize) {
      this.pageSize = this.pagination.pageSize;
    }
  }

  private async goToPage(page: number) {
    const totalPages = this.pagination.totalPages > 0 ? this.pagination.totalPages : 1;
    const nextPage = Math.min(Math.max(page, 1), totalPages);
    if (nextPage === this.pagination.page) return;
    this.pagination = { ...this.pagination, page: nextPage };
    await this.refresh();
  }

  private async handlePageSizeChange(event: Event) {
    const value = Number((event.target as HTMLSelectElement).value);
    if (!Number.isFinite(value) || value < 1) return;
    this.pageSize = value;
    this.pagination = { ...this.pagination, page: 1 };
    await this.refresh();
  }

  private async applyFilters() {
    this.pagination = { ...this.pagination, page: 1 };
    await this.refresh();
  }

  private async clearFilters() {
    this.activePreset = "none";
    this.activeTimePreset = "none";
    this.keyword = "";
    this.statusFilter = "all";
    this.sourceFilter = "";
    this.sessionIdFilter = "";
    this.sessionKeyFilter = "";
    this.timeFrom = "";
    this.timeTo = "";
    this.dateFromTime = "00:00:00";
    this.dateToTime = "23:59:59";
    this.outcomeFilter = "all";
    this.pagination = { ...this.pagination, page: 1 };
    await this.refresh();
  }

  private async applyPreset(preset: FilterPreset) {
    this.activePreset = preset;
    this.activeTimePreset = "none";

    if (preset === "today") {
      const today = new Date().toISOString().slice(0, 10);
      
      this.keyword = "";
      this.statusFilter = "all";
      this.sourceFilter = "";
      this.sessionIdFilter = "";
      this.sessionKeyFilter = "";
      this.timeFrom = today;
      this.timeTo = today;
      this.dateFromTime = "00:00:00";
      this.dateToTime = "23:59:59";
      this.outcomeFilter = "all";
    }

    if (preset === "last7days") {
      const now = new Date();
      const from = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

      this.keyword = "";
      this.statusFilter = "all";
      this.sourceFilter = "";
      this.sessionIdFilter = "";
      this.sessionKeyFilter = "";
      this.timeFrom = from.toISOString().slice(0, 10);
      this.timeTo = now.toISOString().slice(0, 10);
      this.dateFromTime = "00:00:00";
      this.dateToTime = "23:59:59";
      this.outcomeFilter = "all";
    }

    if (preset === "success") {
      this.keyword = "";
      this.statusFilter = "all";
      this.sourceFilter = "";
      this.sessionIdFilter = "";
      this.sessionKeyFilter = "";
      this.timeFrom = "";
      this.timeTo = "";
      this.dateFromTime = "00:00:00";
      this.dateToTime = "23:59:59";
      this.outcomeFilter = "success";
    }

    if (preset === "failed") {
      this.keyword = "";
      this.statusFilter = "all";
      this.sourceFilter = "";
      this.sessionIdFilter = "";
      this.sessionKeyFilter = "";
      this.timeFrom = "";
      this.timeTo = "";
      this.dateFromTime = "00:00:00";
      this.dateToTime = "23:59:59";
      this.outcomeFilter = "failed";
    }

    if (preset === "running") {
      this.keyword = "";
      this.statusFilter = "running";
      this.sourceFilter = "";
      this.sessionIdFilter = "";
      this.sessionKeyFilter = "";
      this.timeFrom = "";
      this.timeTo = "";
      this.dateFromTime = "00:00:00";
      this.dateToTime = "23:59:59";
      this.outcomeFilter = "all";
    }

    if (preset === "none") {
      this.activePreset = "none";
      this.activeTimePreset = "none";
      this.keyword = "";
      this.statusFilter = "all";
      this.sourceFilter = "";
      this.sessionIdFilter = "";
      this.sessionKeyFilter = "";
      this.timeFrom = "";
      this.timeTo = "";
      this.dateFromTime = "00:00:00";
      this.dateToTime = "23:59:59";
      this.outcomeFilter = "all";
    }

    this.pagination = { ...this.pagination, page: 1 };
    await this.refresh();
  }

  private async applyTimePreset(preset: TimePreset) {
    if (preset === "none") {
      this.activeTimePreset = "none";
      this.pagination = { ...this.pagination, page: 1 };
      await this.refresh();
      return;
    }

    this.activeTimePreset = preset;
    this.activePreset = "none";

    const now = new Date();
    let minutesBack = 0;

    if (preset === "5min") minutesBack = 5;
    if (preset === "10min") minutesBack = 10;
    if (preset === "30min") minutesBack = 30;
    if (preset === "1h") minutesBack = 60;
    if (preset === "6h") minutesBack = 360;
    if (preset === "12h") minutesBack = 720;
    if (preset === "24h") minutesBack = 1440;

    const from = new Date(now.getTime() - minutesBack * 60 * 1000);
    this.timeFrom = from.toISOString().slice(0, 10);
    this.timeTo = now.toISOString().slice(0, 10);
    this.dateFromTime = this.formatTimeInput(from);
    this.dateToTime = this.formatTimeInput(now);

    this.pagination = { ...this.pagination, page: 1 };
    await this.refresh();
  }

  private toggleDetail(key: string, opened: boolean) {
    if (opened) {
      this.openDetails.add(key);
    } else {
      this.openDetails.delete(key);
    }

    this.openDetails = new Set(this.openDetails);
  }

  private isOpen(key: string) {
    return this.openDetails.has(key);
  }

  private statusBadgeClass(status?: string) {
    const s = (status || "").toLowerCase();
    if (["end", "ok", "success", "completed", "done"].includes(s)) return "badge--ok";
    if (["start", "progress", "warning", "running", "pending"].includes(s)) return "badge--warn";
    if (["error", "failed", "abort", "aborted"].includes(s)) return "badge--danger";
    return "";
  }

  private normalizeEventData(data: unknown): unknown {
    if (typeof data !== "string") return data;
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return data;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private renderToolStatusBadge(isError: boolean) {
    return html`
      <span class="badge ${isError ? "badge--danger" : "badge--ok"}">${isError ? "Error" : "OK"}</span>
    `;
  }

  private renderRow(label: string, value: unknown) {
    return html`
      <div class="mc-row">
        <div class="mc-row__key">${label}</div>
        <div class="mc-row__value">${value === undefined || value === null || value === "" ? "-" : value}</div>
      </div>
    `;
  }

  private renderTextDetails(value: unknown, label: string, key: string) {
    if (value === null || value === undefined || value === "") return nothing;
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return html`
      <details
        class="mc-details"
        ?open=${this.isOpen(key)}
        @toggle=${(event: Event) => this.toggleDetail(key, (event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>${label}</summary>
        <pre>${text}</pre>
      </details>
    `;
  }

  private renderStructuredValue(value: unknown, key: string): unknown {
    if (value === null || value === undefined || value === "") return "-";

    if (typeof value === "string") {
      if (value.includes("\n") || value.length > 180) {
        return html`<pre class="mc-pre">${value}</pre>`;
      }
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      if (!value.length) return "[]";
      return html`
        <details
          class="mc-details"
          ?open=${this.isOpen(`${key}:array`)}
          @toggle=${(event: Event) => this.toggleDetail(`${key}:array`, (event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>Array (${value.length})</summary>
          <div class="mc-nested-grid">
            ${value.map((item, index) => this.renderRow(`[${index}]`, this.renderStructuredValue(item, `${key}:${index}`)))}
          </div>
        </details>
      `;
    }

    if (this.isRecord(value)) {
      const entries = Object.entries(value);
      const isToolObject = typeof value.isError === "boolean";
      const visibleEntries = isToolObject ? entries.filter(([entryKey]) => entryKey !== "isError") : entries;
      if (!visibleEntries.length && !isToolObject) return "{}";

      const nestedRows = visibleEntries.map(([entryKey, entryValue]) => this.renderRow(entryKey, this.renderStructuredValue(entryValue, `${key}:${entryKey}`)));
      return html`
        <details
          class="mc-details"
          ?open=${this.isOpen(`${key}:object`)}
          @toggle=${(event: Event) => this.toggleDetail(`${key}:object`, (event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>Object (${entries.length})</summary>
          ${isToolObject ? html`<div class="mc-nested-grid">${this.renderRow("Status", this.renderToolStatusBadge(Boolean(value.isError)))}</div>` : nothing}
          <div class="mc-nested-grid">
            ${nestedRows}
          </div>
        </details>
      `;
    }

    return String(value);
  }

  private renderEvent(event: MissionControlEvent) {
    const statusLabel = event.eventType || "event";
    const title = event.title || event.message || event.action || "Event";
    const baseKey = `event:${event.id || `${event.runId || "-"}:${event.timestamp || "-"}`}`;
    const parsed = this.normalizeEventData(event.data);

    const eventDetails = this.isRecord(parsed)
      ? (() => {
        const isToolObject = typeof parsed.isError === "boolean";
        const entries = Object.entries(parsed).filter(([k]) => !(isToolObject && k === "isError"));

        return html`
          <div class="mc-nested-grid">
            ${isToolObject ? this.renderRow("Status", this.renderToolStatusBadge(Boolean(parsed.isError))) : nothing}
            ${entries.map(([k, v]) => this.renderRow(k, this.renderStructuredValue(v, `${baseKey}:${k}`)))}
          </div>
        `;
      })()
      : this.renderTextDetails(parsed, "Details", `${baseKey}:details`);

    return html`
      <article class="mc-nested-item">
        <header class="mc-nested-item__header">
          <span class="badge ${this.statusBadgeClass(event.action)}">${statusLabel}</span>
          <span class="mc-nested-item__title">${title}</span>
        </header>

        ${event.description ? html`<p class="mc-description">${event.description}</p>` : nothing}

        ${eventDetails}
      </article>
    `;
  }

  private renderDocument(doc: MissionControlDocument) {
    const baseKey = `doc:${doc.id || `${doc.runId || "-"}:${doc.title || "-"}`}`;

    return html`
      <article class="mc-nested-item">
        <header class="mc-nested-item__header">
          <span class="badge">${doc.type || "file"}</span>
          <span class="mc-nested-item__title">${doc.title || "Document"}</span>
        </header>
        ${doc.description ? html`<p class="mc-description">${doc.description}</p>` : nothing}
        ${doc.path ? this.renderRow("Path", doc.path) : nothing}
        ${this.renderTextDetails(doc.content, "Content", `${baseKey}:content`)}
      </article>
    `;
  }

  private formatDate(value?: string) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.valueOf())) return value;
    return d.toLocaleString();
  }

  private renderTask(task: MissionControlTask) {
    const baseKey = `task:${task.id || task.runId || "unknown"}`;
    const taskTitle = task.prompt
      ? (task.prompt.length > 84 ? `${task.prompt.slice(0, 84)}...` : task.prompt)
      : `Task ${task.runId || "unknown"}`;

    return html`
      <article class="card mc-task-card">
        <header class="mc-task-card__header">
          <span class="badge ${this.statusBadgeClass(task.status)}">${task.status || "unknown"}</span>
          <h3 class="mc-task-card__title">${taskTitle}</h3>
        </header>

        ${task.title ? html`<p class="mc-task-card__subtitle">${task.title}</p>` : nothing}
        ${task.description ? html`<p class="mc-description">${task.description}</p>` : nothing}

        <details
          class="mc-details"
          ?open=${this.isOpen(`${baseKey}:details`)}
          @toggle=${(event: Event) => this.toggleDetail(`${baseKey}:details`, (event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>Task Details</summary>
          <div class="mc-nested-grid">
            ${this.renderRow("Run", task.runId || "-")}
            ${this.renderRow("Session ID", task.sessionId || "-")}
            ${this.renderRow("Session", task.sessionKey || "-")}
            ${this.renderRow("Agent", task.agentId || "-")}
            ${this.renderRow("Source", task.source || "-")}
            ${this.renderRow("At", this.formatDate(task.timestamp))}
          </div>
          ${this.renderTextDetails(task.prompt, "Prompt", `${baseKey}:prompt`)}
          ${this.renderTextDetails(task.response, "Response", `${baseKey}:response`)}
          ${this.renderTextDetails(task.error, "Error", `${baseKey}:error`)}
        </details>

        ${Array.isArray(task.events) && task.events.length
          ? html`
            <details
              class="mc-details"
              ?open=${this.isOpen(`${baseKey}:events`)}
              @toggle=${(event: Event) => this.toggleDetail(`${baseKey}:events`, (event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>Events (${task.events.length})</summary>
              <div class="mc-nested-list">
                ${task.events.map((event) => this.renderEvent(event))}
              </div>
            </details>
          `
          : nothing}

        ${Array.isArray(task.documents) && task.documents.length
          ? html`
            <details
              class="mc-details"
              ?open=${this.isOpen(`${baseKey}:documents`)}
              @toggle=${(event: Event) => this.toggleDetail(`${baseKey}:documents`, (event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>Documents (${task.documents.length})</summary>
              <div class="mc-nested-list">
                ${task.documents.map((document) => this.renderDocument(document))}
              </div>
            </details>
          `
          : nothing}
      </article>
    `;
  }

  private renderPresetButton(preset: FilterPreset, label: string) {
    return html`
      <button
        class="btn btn--ghost btn--sm ${this.activePreset === preset ? "mc-filter-preset--active" : ""}"
        @click=${() => void this.applyPreset(preset)}
      >
        ${label}
      </button>
    `;
  }

  private renderFilterPanel() {
    if (!this.showFilters) return nothing;

    return html`
      <section class="card mc-filter-panel">
        <div class="mc-filter-panel__presets">
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
            <span style="font-weight: 500; color: var(--text-secondary, #666);">Quick presets:</span>
            ${this.renderPresetButton("today", "Today")}
            ${this.renderPresetButton("last7days", "Last 7 Days")}
            ${this.renderPresetButton("success", "Success")}
            ${this.renderPresetButton("failed", "Failed")}
            ${this.renderPresetButton("running", "Running")}
            <span style="margin-left: 12px; font-weight: 500; color: var(--text-secondary, #666);">Time range:</span>
            <select class="field__select" style="min-width: 120px;" @change=${(event: Event) => { void this.applyTimePreset((event.target as HTMLSelectElement).value as TimePreset); }}>
              <option value="none" ?selected=${this.activeTimePreset === "none"}>Custom</option>
              <option value="5min" ?selected=${this.activeTimePreset === "5min"}>Last 5 min</option>
              <option value="10min" ?selected=${this.activeTimePreset === "10min"}>Last 10 min</option>
              <option value="30min" ?selected=${this.activeTimePreset === "30min"}>Last 30 min</option>
              <option value="1h" ?selected=${this.activeTimePreset === "1h"}>Last 1 hour</option>
              <option value="6h" ?selected=${this.activeTimePreset === "6h"}>Last 6 hours</option>
              <option value="12h" ?selected=${this.activeTimePreset === "12h"}>Last 12 hours</option>
              <option value="24h" ?selected=${this.activeTimePreset === "24h"}>Last 24 hours</option>
            </select>
          </div>
        </div>

        <div class="mc-filter-grid">
          <div class="field">
            <label class="field__label">Keyword Search</label>
            <input class="field__input" type="text" .value=${this.keyword}
              placeholder="run id, prompt, response, error..."
              @input=${(event: Event) => { this.keyword = (event.target as HTMLInputElement).value; this.activePreset = "none"; }} />
          </div>

          <div class="field">
            <label class="field__label">Session ID</label>
            ${this.renderSessionPicker()}
          </div>

          <div class="field">
            <label class="field__label">Session Key</label>
            <input class="field__input" type="text" .value=${this.sessionKeyFilter}
              placeholder="agent:main:..."
              @input=${(event: Event) => { this.sessionKeyFilter = (event.target as HTMLInputElement).value; this.activePreset = "none"; }} />
          </div>

          <div class="field">
            <label class="field__label">Status</label>
            <select class="field__select" @change=${(event: Event) => { this.statusFilter = (event.target as HTMLSelectElement).value; this.activePreset = "none"; }}>
              ${["all", "start", "progress", "running", "pending", "end", "success", "completed", "done", "error", "failed", "aborted"]
                .map((value) => html`<option value=${value} ?selected=${value === this.statusFilter}>${value}</option>`)}
            </select>
          </div>

          <div class="field">
            <label class="field__label">Outcome</label>
            <select class="field__select" @change=${(event: Event) => { this.outcomeFilter = (event.target as HTMLSelectElement).value as "all" | "success" | "failed"; this.activePreset = "none"; }}>
              ${["all", "success", "failed"].map((value) => html`<option value=${value} ?selected=${value === this.outcomeFilter}>${value}</option>`)}
            </select>
          </div>

          <div class="field">
            <label class="field__label">Source</label>
            <input class="field__input" type="text" .value=${this.sourceFilter}
              placeholder="telegram, discord, ..."
              @input=${(event: Event) => { this.sourceFilter = (event.target as HTMLInputElement).value; this.activePreset = "none"; }} />
          </div>
        </div>

        <div class="mc-filter-datetime">
          <div class="mc-filter-datetime__section">
            <h3 class="mc-filter-datetime__heading">From</h3>
            <div class="mc-filter-datetime__inputs">
              <div class="field">
                <label class="field__label">Date</label>
                <input class="field__input" type="date" .value=${this.timeFrom}
                  @change=${(event: Event) => { this.timeFrom = (event.target as HTMLInputElement).value; this.activePreset = "none"; this.activeTimePreset = "none"; }} />
              </div>
              <div class="field">
                <label class="field__label">Time (HH:MM:SS)</label>
                <input class="field__input" type="time" step="1" .value=${this.dateFromTime}
                  @change=${(event: Event) => { this.dateFromTime = (event.target as HTMLInputElement).value; this.activePreset = "none"; this.activeTimePreset = "none"; }} />
              </div>
            </div>
          </div>

          <div class="mc-filter-datetime__section">
            <h3 class="mc-filter-datetime__heading">To</h3>
            <div class="mc-filter-datetime__inputs">
              <div class="field">
                <label class="field__label">Date</label>
                <input class="field__input" type="date" .value=${this.timeTo}
                  @change=${(event: Event) => { this.timeTo = (event.target as HTMLInputElement).value; this.activePreset = "none"; this.activeTimePreset = "none"; }} />
              </div>
              <div class="field">
                <label class="field__label">Time (HH:MM:SS)</label>
                <input class="field__input" type="time" step="1" .value=${this.dateToTime}
                  @change=${(event: Event) => { this.dateToTime = (event.target as HTMLInputElement).value; this.activePreset = "none"; this.activeTimePreset = "none"; }} />
              </div>
            </div>
          </div>
        </div>

        <div class="mc-filter-actions">
          <button class="btn btn--primary btn--sm" @click=${() => void this.applyFilters()}>Apply Filters</button>
          <button class="btn btn--ghost btn--sm" @click=${() => void this.clearFilters()}>Clear</button>
        </div>
      </section>
    `;
  }

  private renderPagination() {
    const totalPages = this.pagination.totalPages;
    if (totalPages <= 1 && this.pagination.total <= this.pageSize) return nothing;

    const page = this.pagination.page;
    const pageButtons: number[] = [];
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages || 1, page + 2);

    for (let p = start; p <= end; p += 1) {
      pageButtons.push(p);
    }

    return html`
      <footer class="card mc-pagination">
        <div class="mc-pagination__meta">
          <span>Total: ${this.pagination.total}</span>
          <span>Page ${this.pagination.page}${totalPages ? ` / ${totalPages}` : ""}</span>
        </div>

        <div class="mc-pagination__controls">
          <label class="mc-pagination__size">
            Per page
            <select class="field__select" @change=${(event: Event) => void this.handlePageSizeChange(event)}>
              ${[10, 20, 50].map((size) => html`<option value=${String(size)} ?selected=${size === this.pageSize}>${size}</option>`)}
            </select>
          </label>

          <button class="btn btn--ghost btn--sm" ?disabled=${!this.pagination.hasPrev} @click=${() => void this.goToPage(page - 1)}>
            Prev
          </button>

          ${pageButtons.map((p) => html`
            <button class="btn btn--ghost btn--sm ${p === page ? "mc-page-btn--active" : ""}" @click=${() => void this.goToPage(p)}>
              ${p}
            </button>
          `)}

          <button class="btn btn--ghost btn--sm" ?disabled=${!this.pagination.hasNext} @click=${() => void this.goToPage(page + 1)}>
            Next
          </button>
        </div>
      </footer>
    `;
  }

  private getTaskTimestamp(task: MissionControlTask) {
    const raw = task.timestamp || task.createdAt || "";
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private truncateText(value: string, maxLength = 96) {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}...`;
  }

  private getTaskPreviewText(task: MissionControlTask) {
    const fromEvent = Array.isArray(task.events)
      ? [...task.events]
        .reverse()
        .find((event) => event.message || event.title || event.description)
      : undefined;

    const response = typeof task.response === "string" ? task.response.trim() : "";
    const prompt = task.prompt?.trim() || "";
    const title = task.title?.trim() || "";
    const description = task.description?.trim() || "";
    const eventText = (fromEvent?.message || fromEvent?.title || fromEvent?.description || "").trim();

    const preview = title || description || prompt || response || eventText || "(no message)";
    return this.truncateText(preview.replace(/\s+/g, " "));
  }

  private getSessionId(task: MissionControlTask) {
    const value = task.sessionId?.trim();
    return value || "unknown";
  }

  private getSessionGroups() {
    const groups = new Map<string, { sessionId: string; tasks: MissionControlTask[]; latestTs: number; latestPreview: string }>();

    for (const task of this.tasks) {
      const sessionId = task.sessionId?.trim();
      if (!sessionId) continue;
      const current = groups.get(sessionId);
      const ts = this.getTaskTimestamp(task);
      const preview = this.getTaskPreviewText(task);

      if (!current) {
        groups.set(sessionId, { sessionId, tasks: [task], latestTs: ts, latestPreview: preview });
      } else {
        current.tasks.push(task);
        if (ts >= current.latestTs) {
          current.latestTs = ts;
          current.latestPreview = preview;
        }
      }
    }

    return Array.from(groups.values()).sort((a, b) => b.latestTs - a.latestTs);
  }

  private getVisibleSessionGroups() {
    const query = this.sessionPickerSearch.trim().toLowerCase();
    const groups = this.getSessionGroups();
    if (!query) return groups;

    return groups.filter((group) => {
      return group.sessionId.toLowerCase().includes(query) || group.latestPreview.toLowerCase().includes(query);
    });
  }

  private renderSessionPicker() {
    const groups = this.getVisibleSessionGroups();
    const detailsKey = "filter:session-picker";
    const selectedGroup = this.getSessionGroups().find((group) => group.sessionId === this.sessionIdFilter);
    const buttonLabel = selectedGroup ? this.truncateText(selectedGroup.latestPreview, 48) : "Pick a session";

    return html`
      <div style="position: relative; display: inline-block; width: 100%; overflow: visible;">
        <details
          class="mc-details"
          ?open=${this.isOpen(detailsKey)}
          @toggle=${(event: Event) => this.toggleDetail(detailsKey, (event.currentTarget as HTMLDetailsElement).open)}
          style="margin: 0; width: 100%;"
        >
          <summary style="list-style: none; cursor: pointer; display: block;">
            <span class="btn btn--ghost btn--sm" style="width: 100%; justify-content: space-between; display: inline-flex; gap: 12px;">
              <span>${buttonLabel}</span>
              <span class="badge">${groups.length}</span>
            </span>
          </summary>

          <div
            style="position: absolute; top: calc(100% + 8px); left: 0; z-index: 25; width: min(520px, 92vw); max-width: 100%;"
          >
            <section class="card" style="padding: 10px 12px; box-shadow: var(--shadow-lg, 0 14px 35px rgba(0, 0, 0, 0.18));">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px;">
                <div>
                  <div style="font-weight: 600;">Sessions</div>
                  <div style="font-size: 12px; color: var(--text-secondary, #666);">Search by session id or preview</div>
                </div>
                <button
                  class="btn btn--ghost btn--sm"
                  @click=${() => {
                    this.sessionIdFilter = "";
                    this.selectedSessionId = "";
                    this.sessionPickerSearch = "";
                    this.activePreset = "none";
                    this.toggleDetail(detailsKey, false);
                  }}
                >
                  Clear
                </button>
              </div>

              <input
                class="field__input"
                type="text"
                .value=${this.sessionPickerSearch}
                placeholder="Search sessions or previews..."
                @input=${(event: Event) => { this.sessionPickerSearch = (event.target as HTMLInputElement).value; }}
                style="margin-bottom: 10px;"
              />

              <div class="mc-nested-list" style="max-height: 260px; overflow: auto;">
                ${groups.length
                  ? groups.map((group) => html`
                    <button
                      class="btn btn--ghost btn--sm ${this.selectedSessionId === group.sessionId ? "mc-filter-preset--active" : ""}"
                      style="width: 100%; text-align: left; justify-content: flex-start; margin-bottom: 6px; padding-top: 10px; padding-bottom: 10px;"
                      @click=${() => {
                        this.sessionIdFilter = group.sessionId;
                        this.selectedSessionId = group.sessionId;
                        this.activePreset = "none";
                        this.sessionPickerSearch = "";
                        this.toggleDetail(detailsKey, false);
                      }}
                    >
                      <div style="display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%;">
                        <span style="font-weight: 600; line-height: 1.2;">${group.latestPreview}</span>
                        <span style="font-size: 12px; color: var(--text-secondary, #666);">${group.sessionId} · ${group.tasks.length} tasks</span>
                      </div>
                    </button>
                  `)
                  : html`<div class="mc-description">No sessions available yet.</div>`}
              </div>
            </section>
          </div>
        </details>
      </div>
    `;
  }

  private syncSelectedSession() {
    const groups = this.getSessionGroups();
    if (!groups.length) {
      this.selectedSessionId = "";
      return;
    }

    const hasCurrent = groups.some((group) => group.sessionId === this.selectedSessionId);
    if (!this.selectedSessionId || !hasCurrent) {
      this.selectedSessionId = groups[0].sessionId;
    }
  }

  private renderSessionTabs() {
    const groups = this.getSessionGroups();
    if (!groups.length) return nothing;

    return html`
      <section class="card" style="padding: 10px 12px;">
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          <span style="font-weight: 500; color: var(--text-secondary, #666);">Sessions:</span>
          ${groups.map((group) => html`
            <button
              class="btn btn--ghost btn--sm ${this.selectedSessionId === group.sessionId ? "mc-filter-preset--active" : ""}"
              title=${`Session ID: ${group.sessionId}`}
              @click=${() => { this.selectedSessionId = group.sessionId; }}
            >
              ${this.truncateText(group.latestPreview, 48)} (${group.tasks.length})
            </button>
          `)}
        </div>
      </section>
    `;
  }

  render() {
    const sessionGroups = this.getSessionGroups();
    const selectedGroup = sessionGroups.find((group) => group.sessionId === this.selectedSessionId);
    const visibleTasks = selectedGroup ? selectedGroup.tasks : this.tasks;

    return html`
      <section class="content mission-control">
        <header class="content__header mission-control__header">
          <div>
            <h1 class="content__title">Mission Control Logs</h1>
            <p class="mission-control__meta">SQLite task traces with events and documents.</p>
          </div>
          <div class="content__actions">
            <button class="btn btn--ghost btn--sm" @click=${() => { this.showFilters = !this.showFilters; }}>
              ${this.showFilters ? "Hide Filters" : "Filters"}
            </button>
            <button class="btn btn--ghost btn--sm" @click=${() => void this.refresh()}>
              ${this.loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </header>

        <div class="mission-control__pills">
          <span class="badge">DB: ${this.dbPath}</span>
          <span class="badge">Updated: ${this.generatedAt ? this.formatDate(this.generatedAt) : "-"}</span>
          <span class="badge">Auto refresh: 3s</span>
          <span class="badge">Tasks on page: ${this.tasks.length}</span>
        </div>

        ${this.renderFilterPanel()}

        ${this.renderSessionTabs()}

        ${this.error ? html`<div class="callout callout--danger">${this.error}</div>` : nothing}

        <div class="mission-control__list">
          ${visibleTasks.length
            ? visibleTasks.map((task) => this.renderTask(task))
            : html`<div class="card empty-state">${this.loading ? "Loading logs..." : "No task logs yet"}</div>`}
        </div>

        ${this.renderPagination()}
      </section>
    `;
  }
}
