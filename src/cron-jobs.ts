import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

type CronJobRecord = Record<string, unknown>;

interface CronJobsPayload {
  jobs?: unknown[];
}

interface CronRunRecord {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  error?: string;
  summary?: string;
  sessionKey?: string;
}

interface CronRunsPayload {
  runs?: CronRunRecord[];
}

interface CronActionResult {
  ok?: boolean;
  error?: string;
  response?: {
    ok?: boolean;
    error?: unknown;
    payload?: unknown;
  };
}

@customElement("cron-jobs-view")
export class CronJobsView extends LitElement {
  @property({ type: String }) gatewayUrl = "";

  @state() private loading = false;
  @state() private error = "";
  @state() private jobs: CronJobRecord[] = [];
  @state() private runs: CronRunRecord[] = [];
  @state() private nowMs = Date.now();

  // Modal/form state
  @state() private formMode: "create" | "update" | null = null;
  @state() private formJobId = "";
  @state() private showDeleteConfirm = false;
  @state() private deleteConfirmJobId = "";

  // Form field state
  @state() private formName = "";
  @state() private formDescription = "";
  @state() private formAgentId = "";
  @state() private formEnabled = true;
  @state() private formScheduleType = "every"; // every, at, cron
  @state() private formScheduleValue = "5";
  @state() private formScheduleUnit = "minutes"; // minutes, hours, days
  @state() private formSession = "main"; // main, isolated
  @state() private formWakeMode = "now"; // now, next-heartbeat
  @state() private formPayload = "system-event"; // system-event, agent-turn
  @state() private formSystemText = "";

  // Agent picker state
  @state() private agents: Array<{ id: string; name: string }> = [];
  @state() private agentPickerOpen = false;
  @state() private agentPickerSearch = "";

  @state() private actionBusy = false;
  @state() private actionError = "";
  @state() private actionMessage = "";
  @state() private expandedSparklineJobIds: string[] = [];

  private readonly jobsPath = "/api/cron/jobs";
  private readonly runsPath = "/api/cron/runs?limit=150";
  private readonly runActionPath = "/api/cron/run";
  private readonly wakePath = "/api/cron/wake";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.loadAgents();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, 5000);
    this.clockTimer = setInterval(() => {
      this.nowMs = Date.now();
    }, 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
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

  private buildApiUrl(pathname: string) {
    return new URL(pathname, this.resolveApiOrigin()).toString();
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private getJobId(job: unknown) {
    if (!this.isRecord(job)) return "";
    return typeof job.id === "string" ? job.id : "";
  }

  private getJobLabel(job: CronJobRecord) {
    const id = this.getJobId(job) || "unknown-job";
    const name = typeof job.name === "string" ? job.name : "";
    const schedule = this.formatScheduleSummary(job);
    const text = name || schedule || id;
    return text.length > 68 ? `${text.slice(0, 68)}...` : text;
  }

  private formatRunTs(ts?: number) {
    if (!Number.isFinite(ts)) return "-";
    const n = Number(ts);
    const ms = n > 1_000_000_000_000 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.valueOf()) ? "-" : d.toLocaleString();
  }

  private formatMs(ts?: unknown) {
    return typeof ts === "number" ? this.formatRunTs(ts) : "-";
  }

  private formatDurationMs(ms?: unknown) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    if (ms % 1000 === 0) return `${ms / 1000}s`;
    return `${ms}ms`;
  }

  private formatScheduleSummary(job: CronJobRecord) {
    const schedule = this.isRecord(job.schedule) ? job.schedule : null;
    if (!schedule) {
      return typeof job.schedule === "string" && job.schedule ? job.schedule : "-";
    }

    const kind = typeof schedule.kind === "string" ? schedule.kind : "unknown";
    if (kind === "every") {
      const everyMs = typeof schedule.everyMs === "number" ? schedule.everyMs : Number(schedule.everyMs);
      return Number.isFinite(everyMs) ? `Every ${this.formatDurationMs(everyMs)}` : "Every";
    }

    if (kind === "at") {
      return typeof schedule.at === "string" && schedule.at ? `At ${schedule.at}` : "At";
    }

    if (kind === "cron") {
      const expr = typeof schedule.expr === "string" && schedule.expr ? schedule.expr : "-";
      const tz = typeof schedule.tz === "string" && schedule.tz ? ` (${schedule.tz})` : "";
      return `Cron ${expr}${tz}`;
    }

    return kind;
  }

  private formatPayloadSummary(job: CronJobRecord) {
    const payload = this.isRecord(job.payload) ? job.payload : null;
    if (!payload) {
      return typeof job.payload === "string" && job.payload ? job.payload : "-";
    }

    const kind = typeof payload.kind === "string" ? payload.kind : "unknown";
    if (kind === "systemEvent") {
      const text = typeof payload.text === "string" && payload.text ? payload.text : "-";
      return `System event: ${text}`;
    }

    if (kind === "agentTurn") {
      const message = typeof payload.message === "string" && payload.message ? payload.message : "-";
      return `Agent turn: ${message}`;
    }

    return kind;
  }

  private formatSessionTarget(job: CronJobRecord) {
    return typeof job.sessionTarget === "string" && job.sessionTarget ? job.sessionTarget : "-";
  }

  private formatWakeMode(job: CronJobRecord) {
    return typeof job.wakeMode === "string" && job.wakeMode ? job.wakeMode : "-";
  }

  private formatJobState(job: CronJobRecord) {
    if (!this.isRecord(job.state)) return "-";
    const state = job.state;
    const nextRunAtMs = typeof state.nextRunAtMs === "number" ? state.nextRunAtMs : Number(state.nextRunAtMs);
    return Number.isFinite(nextRunAtMs) ? this.formatRunTs(nextRunAtMs) : "-";
  }

  private getNextRunAtMs(job: CronJobRecord) {
    if (!this.isRecord(job.state)) return null;
    const state = job.state;
    const nextRunAtMs = typeof state.nextRunAtMs === "number" ? state.nextRunAtMs : Number(state.nextRunAtMs);
    return Number.isFinite(nextRunAtMs) ? nextRunAtMs : null;
  }

  private getRemainingMs(job: CronJobRecord) {
    const nextRunAtMs = this.getNextRunAtMs(job);
    return nextRunAtMs === null ? null : Math.max(0, nextRunAtMs - this.nowMs);
  }

  private formatJobCountdownInline(job: CronJobRecord) {
    const remainingMs = this.getRemainingMs(job);
    const intervalMs = this.resolveIntervalMs(job);
    const countdown = remainingMs === null ? "-" : this.formatCountdown(remainingMs);
    const intervalLabel = intervalMs && intervalMs > 0 ? this.formatDurationMs(intervalMs) : "-";
    return `${countdown} / ${intervalLabel}`;
  }

  private getJobsSortedByNextRun() {
    return [...this.jobs].sort((left, right) => {
      const leftRemaining = this.getRemainingMs(left);
      const rightRemaining = this.getRemainingMs(right);
      if (leftRemaining === null && rightRemaining === null) {
        return this.getJobLabel(left).localeCompare(this.getJobLabel(right));
      }
      if (leftRemaining === null) return 1;
      if (rightRemaining === null) return -1;
      return leftRemaining - rightRemaining;
    });
  }

  private getSparklineStatusColor(status: string) {
    switch (status) {
      case "ok":
      case "success":
        return "#2f9e44";
      case "running":
        return "#228be6";
      case "warning":
        return "#f08c00";
      case "error":
      case "failed":
        return "#e03131";
      default:
        return "#adb5bd";
    }
  }

  private getTimelineMarkerColor(index: number) {
    const colors = ["#2563eb", "#7c3aed", "#059669", "#d97706", "#dc2626", "#0f766e", "#9333ea", "#14b8a6"];
    return colors[index % colors.length] || colors[0];
  }

  private isSparklineExpanded(jobId: string) {
    return this.expandedSparklineJobIds.includes(jobId);
  }

  private toggleSparkline(jobId: string) {
    this.expandedSparklineJobIds = this.isSparklineExpanded(jobId)
      ? this.expandedSparklineJobIds.filter((id) => id !== jobId)
      : [...this.expandedSparklineJobIds, jobId];
  }

  private getJobRuns(jobId: string) {
    return this.runs
      .filter((run) => run.jobId === jobId)
      .sort((left, right) => (Number(right.ts ?? 0) || 0) - (Number(left.ts ?? 0) || 0));
  }

  private renderRunSparkline(job: CronJobRecord) {
    const jobId = this.getJobId(job);
    const runs = this.getJobRuns(jobId).slice(0, 20);
    const expanded = this.isSparklineExpanded(jobId);

    if (!runs.length) {
      return html`
        <div class="mc-row" style="grid-column: 1 / -1;">
          <div class="mc-row__key">Run Sparkline</div>
          <div class="mc-row__value">
            <button class="btn btn--ghost btn--xs" @click=${() => this.toggleSparkline(jobId)}>Show recent runs</button>
          </div>
        </div>
      `;
    }

    const visibleRuns = expanded ? runs : runs.slice(0, Math.min(8, runs.length));

    return html`
      <div class="mc-row" style="grid-column: 1 / -1;">
        <div class="mc-row__key">Run Sparkline</div>
        <div class="mc-row__value" style="width: 100%; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <div style="display: flex; align-items: flex-end; gap: 3px; min-height: 28px;">
              ${visibleRuns.map((run) => {
                const status = typeof run.status === "string" ? run.status : "unknown";
                const color = this.getSparklineStatusColor(status);
                const title = `${this.formatRunTs(run.ts)} • ${status}${run.summary ? ` • ${run.summary}` : ""}`;
                return html`
                  <div
                    title=${title}
                    style="width: 10px; height: ${status === "running" ? "26px" : "14px"}; border-radius: 999px; background: ${color}; opacity: 0.95;"
                  ></div>
                `;
              })}
            </div>
            <span style="opacity: 0.8;">${runs.length} runs</span>
            <button class="btn btn--ghost btn--xs" @click=${() => this.toggleSparkline(jobId)}>
              ${expanded ? "Collapse" : "Expand"}
            </button>
          </div>
          ${expanded
            ? html`
                <div style="display: grid; gap: 4px;">
                  ${runs.map((run) => {
                    const status = typeof run.status === "string" ? run.status : "unknown";
                    return html`
                      <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 0.9em; opacity: 0.9;">
                        <span style="color: ${this.getSparklineStatusColor(status)}; font-weight: 600;">${status}</span>
                        <span>${this.formatRunTs(run.ts)}</span>
                        <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${run.summary || run.action || "-"}</span>
                      </div>
                    `;
                  })}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private renderJobState(job: CronJobRecord) {
    if (!this.isRecord(job.state)) {
      return html`<div class="mc-row"><div class="mc-row__key">State</div><div class="mc-row__value">-</div></div>`;
    }

    const state = job.state;
    const lastStatus = typeof state.lastStatus === "string" ? state.lastStatus : "-";
    const lastRunAtMs = typeof state.lastRunAtMs === "number" ? state.lastRunAtMs : Number(state.lastRunAtMs);
    const nextRunAtMs = typeof state.nextRunAtMs === "number" ? state.nextRunAtMs : Number(state.nextRunAtMs);
    const lastError = typeof state.lastError === "string" ? state.lastError : "";

    return html`
      <div class="mc-row"><div class="mc-row__key">Last Status</div><div class="mc-row__value">${lastStatus}</div></div>
      <div class="mc-row"><div class="mc-row__key">Last Run</div><div class="mc-row__value">${Number.isFinite(lastRunAtMs) ? this.formatRunTs(lastRunAtMs) : "-"}</div></div>
      <div class="mc-row"><div class="mc-row__key">Next Run</div><div class="mc-row__value">${Number.isFinite(nextRunAtMs) ? this.formatRunTs(nextRunAtMs) : "-"}</div></div>
      ${lastError ? html`<div class="mc-row"><div class="mc-row__key">Last Error</div><div class="mc-row__value">${lastError}</div></div>` : nothing}
    `;
  }

  private resolveIntervalMs(job: CronJobRecord) {
    const schedule = this.isRecord(job.schedule) ? job.schedule : null;
    if (schedule && schedule.kind === "every") {
      const everyMs = typeof schedule.everyMs === "number" ? schedule.everyMs : Number(schedule.everyMs);
      if (Number.isFinite(everyMs) && everyMs > 0) return everyMs;
    }

    const state = this.isRecord(job.state) ? job.state : null;
    if (!state) return null;
    const lastRunAtMs = typeof state.lastRunAtMs === "number" ? state.lastRunAtMs : Number(state.lastRunAtMs);
    const nextRunAtMs = typeof state.nextRunAtMs === "number" ? state.nextRunAtMs : Number(state.nextRunAtMs);
    if (Number.isFinite(lastRunAtMs) && Number.isFinite(nextRunAtMs) && nextRunAtMs > lastRunAtMs) {
      return nextRunAtMs - lastRunAtMs;
    }

    return null;
  }

  private formatCountdown(remainingMs: number) {
    const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const dd = String(days).padStart(2, "0");
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    return `${dd}:${hh}:${mm}:${ss}`;
  }

  private renderNextRunCountdown(job: CronJobRecord) {
    const state = this.isRecord(job.state) ? job.state : null;
    if (!state) {
      return html`<div class="mc-row"><div class="mc-row__key">Countdown</div><div class="mc-row__value">-</div></div>`;
    }

    const nextRunAtMs = typeof state.nextRunAtMs === "number" ? state.nextRunAtMs : Number(state.nextRunAtMs);
    if (!Number.isFinite(nextRunAtMs)) {
      return html`<div class="mc-row"><div class="mc-row__key">Countdown</div><div class="mc-row__value">-</div></div>`;
    }

    const intervalMs = this.resolveIntervalMs(job);
    const remainingMs = Math.max(0, nextRunAtMs - this.nowMs);
    const elapsedMs = intervalMs && intervalMs > 0 ? Math.max(0, Math.min(intervalMs, intervalMs - remainingMs)) : null;
    const progressNow = elapsedMs ?? 0;
    const progressMax = intervalMs && intervalMs > 0 ? intervalMs : 1;
    const intervalLabel = intervalMs && intervalMs > 0 ? this.formatDurationMs(intervalMs) : "-";

    return html`
      <div class="mc-row" style="grid-column: 1 / -1;">
        <div class="mc-row__key">Countdown</div>
        <div class="mc-row__value" style="width: 100%; display: flex; flex-direction: column; gap: 6px;">
          <div style="display: flex; align-items: baseline; gap: 8px;">
            <span style="font-weight: 700; letter-spacing: 0.04em;">${this.formatCountdown(remainingMs)} / ${intervalLabel}</span>
          </div>
          <progress style="width: 100%; height: 10px;" .max=${progressMax} .value=${progressNow}></progress>
        </div>
      </div>
    `;
  }

  private renderTimelineView() {
    const timelineWindowMs = 24 * 60 * 60 * 1000;
    const now = this.nowMs;
    const timelineUpperBound = now + timelineWindowMs;
    const timelineJobs = this.getJobsSortedByNextRun().filter((job) => {
      const nextRunAtMs = this.getNextRunAtMs(job);
      return nextRunAtMs !== null && nextRunAtMs >= now && nextRunAtMs <= timelineUpperBound;
    });
    const markerWidth = timelineJobs.length > 12 ? 108 : timelineJobs.length > 8 ? 128 : 156;
    const markerLineHeight = timelineJobs.length > 12 ? 22 : timelineJobs.length > 8 ? 26 : 32;
    const markerFontSize = timelineJobs.length > 12 ? 11 : timelineJobs.length > 8 ? 12 : 13;

    return html`
      <section class="card" style="margin-top: 12px;">
        <header class="mc-task-card__header">
          <span class="badge badge--warn">Timeline</span>
          <h3 class="mc-task-card__title">Next 24 Hours</h3>
          <span style="margin-left: auto; opacity: 0.8; font-size: 0.9em;">Sorted by next execution</span>
        </header>

        <div style="display: grid; gap: 12px;">
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; font-size: 0.82em; opacity: 0.7; padding: 0 6px;">
            <span>Now</span>
            <span style="text-align: center;">6h</span>
            <span style="text-align: center;">12h</span>
            <span style="text-align: right;">24h</span>
          </div>

          ${timelineJobs.length
            ? html`
                <div style="position: relative; min-height: 190px; border-radius: 16px; border: 1px solid var(--border-color, rgba(0,0,0,0.08)); background: linear-gradient(180deg, rgba(15,23,42,0.03), rgba(15,23,42,0.01)); overflow: hidden; padding: 14px 14px 12px;">
                  <div style="position: absolute; left: 14px; right: 14px; top: 50%; height: 2px; transform: translateY(-50%); background: linear-gradient(90deg, rgba(37,99,235,0.35), rgba(16,185,129,0.35));"></div>
                  <div style="position: absolute; left: 14px; right: 14px; top: 50%; transform: translateY(-50%); display: flex; justify-content: space-between; pointer-events: none; opacity: 0.75; font-size: 0.72em; color: var(--text-secondary, #64748b);">
                    <span>${this.formatRunTs(now)}</span>
                    <span>${this.formatRunTs(now + 6 * 60 * 60 * 1000)}</span>
                    <span>${this.formatRunTs(now + 12 * 60 * 60 * 1000)}</span>
                    <span>${this.formatRunTs(now + timelineWindowMs)}</span>
                  </div>

                  ${timelineJobs.map((job, index) => {
                    const nextRunAtMs = this.getNextRunAtMs(job) ?? now;
                    const remainingMs = Math.max(0, nextRunAtMs - now);
                    const positionPct = Math.max(0, Math.min(100, (remainingMs / timelineWindowMs) * 100));
                    const color = this.getTimelineMarkerColor(index);
                    const markerWidthPx = markerWidth;
                    const markerGapPx = 8;
                    const jobNameStyle = `padding: 4px 8px; border-radius: 999px; background: rgba(255,255,255,0.96); border: 1px solid rgba(15,23,42,0.08); color: #0f172a; font-size: ${markerFontSize}px; font-weight: 700; text-align: center; box-shadow: 0 2px 10px rgba(15,23,42,0.08); white-space: normal; overflow: visible; line-height: 1.2; word-break: break-word; overflow-wrap: anywhere; max-width: 100%;`;
                    const countdownStyle = `padding: 2px 6px; border-radius: 999px; background: ${color}; color: white; font-size: ${Math.max(10, markerFontSize - 1)}px; font-weight: 700; box-shadow: 0 2px 8px rgba(0,0,0,0.14); white-space: nowrap; max-width: 100%;`;

                    return html`
                      <div
                        style="position: absolute; left: clamp(0px, calc(${positionPct}% - ${markerWidthPx / 2}px), calc(100% - ${markerWidthPx}px)); top: 10px; bottom: 10px; width: ${markerWidthPx}px; pointer-events: none;"
                      >
                        <div
                          style="position: absolute; inset: 0;"
                        >
                          <div
                            style="position: absolute; left: 50%; bottom: calc(50% + ${markerGapPx + Math.max(18, markerLineHeight)}px); transform: translateX(-50%); ${jobNameStyle}"
                            title=${this.getJobLabel(job)}
                          >
                            ${this.getJobLabel(job)}
                          </div>
                          <div style="position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 3px; height: ${markerLineHeight}px; border-radius: 999px; background: ${color}; box-shadow: 0 0 0 1px rgba(255,255,255,0.8); opacity: 0.95;"></div>
                          <div
                            style="position: absolute; left: 50%; top: calc(50% + ${markerGapPx + Math.max(18, markerLineHeight)}px); transform: translateX(-50%); ${countdownStyle}"
                          >
                            ${this.formatCountdown(remainingMs)}
                          </div>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
            : html`<div class="card empty-state">No scheduled next-run timestamps found yet.</div>`}
        </div>
      </section>
    `;
  }

  private parseEveryMs(value: string, unit: string) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return 5 * 60_000;
    switch (unit) {
      case "hours":
        return amount * 3_600_000;
      case "days":
        return amount * 86_400_000;
      default:
        return amount * 60_000;
    }
  }

  private buildScheduleFromForm() {
    if (this.formScheduleType === "every") {
      return {
        kind: "every",
        everyMs: this.parseEveryMs(this.formScheduleValue.trim(), this.formScheduleUnit),
      };
    }

    if (this.formScheduleType === "at") {
      return {
        kind: "at",
        at: this.formScheduleValue.trim(),
      };
    }

    return {
      kind: "cron",
      expr: this.formScheduleValue.trim(),
    };
  }

  private buildPayloadFromForm() {
    if (this.formPayload === "agent-turn") {
      return {
        kind: "agentTurn",
        message: this.formSystemText.trim(),
      };
    }

    return {
      kind: "systemEvent",
      text: this.formSystemText.trim(),
    };
  }

  private loadAgents() {
    // Mock agent list - in a real app, this would fetch from an API
    this.agents = [
      { id: "agent-001", name: "General Assistant" },
      { id: "agent-002", name: "Research Agent" },
      { id: "agent-003", name: "Code Helper" },
      { id: "agent-004", name: "Data Analyst" },
    ];
  }

  private async refresh() {
    this.loading = true;
    this.error = "";

    try {
      const [jobsRes, runsRes] = await Promise.all([
        fetch(this.buildApiUrl(this.jobsPath), { cache: "no-store" }),
        fetch(this.buildApiUrl(this.runsPath), { cache: "no-store" }),
      ]);

      const jobsPayload = (await jobsRes.json()) as CronJobsPayload;
      const runsPayload = (await runsRes.json()) as CronRunsPayload;

      this.jobs = Array.isArray(jobsPayload.jobs)
        ? jobsPayload.jobs.filter((job): job is CronJobRecord => this.isRecord(job))
        : [];
      this.runs = Array.isArray(runsPayload.runs) ? runsPayload.runs : [];
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.jobs = [];
      this.runs = [];
    } finally {
      this.loading = false;
    }
  }

  private extractActionError(payload: CronActionResult, status: number) {
    const topLevel = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "";
    if (topLevel) return topLevel;

    const nested = payload.response?.error;
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
    if (nested && typeof nested === "object") {
      const record = nested as Record<string, unknown>;
      const message = typeof record.message === "string" ? record.message : "";
      const code = typeof record.code === "string" ? record.code : "";
      if (code && message) return `${code}: ${message}`;
      if (message) return message;
      if (code) return code;
    }

    return `Request failed (${status})`;
  }

  private async performAction(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) {
    const res = await fetch(this.buildApiUrl(path), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await res.json()) as CronActionResult;
    const failed = !res.ok || payload.ok === false || payload.response?.ok === false;
    if (failed) {
      throw new Error(this.extractActionError(payload, res.status));
    }
  }

  private setActionStateStart() {
    this.actionBusy = true;
    this.actionError = "";
    this.actionMessage = "";
  }

  private setActionStateDone(message: string) {
    this.actionBusy = false;
    this.actionMessage = message;
  }

  private setActionStateError(error: unknown) {
    this.actionBusy = false;
    this.actionError = error instanceof Error ? error.message : String(error);
  }

  private resetForm() {
    this.formJobId = "";
    this.formName = "";
    this.formDescription = "";
    this.formAgentId = "";
    this.formEnabled = true;
    this.formScheduleType = "every";
    this.formScheduleValue = "5";
    this.formScheduleUnit = "minutes";
    this.formSession = "main";
    this.formWakeMode = "now";
    this.formPayload = "system-event";
    this.formSystemText = "";
  }

  private openCreateForm() {
    this.resetForm();
    this.formMode = "create";
  }

  private openUpdateForm(job: CronJobRecord) {
    this.formJobId = this.getJobId(job);
    this.formName = typeof job.name === "string" ? job.name : "";
    this.formDescription = typeof job.description === "string" ? job.description : "";
    this.formAgentId = typeof job.agentId === "string" ? job.agentId : "";
    this.formEnabled = typeof job.enabled === "boolean" ? job.enabled : true;
    const schedule = this.isRecord(job.schedule) ? job.schedule : null;
    if (schedule) {
      this.formScheduleType = typeof schedule.kind === "string" ? schedule.kind : "every";
      if (this.formScheduleType === "every") {
        const everyMs = typeof schedule.everyMs === "number" ? schedule.everyMs : Number(schedule.everyMs);
        this.formScheduleValue = Number.isFinite(everyMs) ? String(Math.max(1, everyMs / 60_000)) : "5";
        this.formScheduleUnit = "minutes";
      } else if (this.formScheduleType === "at") {
        this.formScheduleValue = typeof schedule.at === "string" ? schedule.at : "";
      } else if (this.formScheduleType === "cron") {
        this.formScheduleValue = typeof schedule.expr === "string" ? schedule.expr : "";
      } else {
        this.formScheduleType = "every";
        this.formScheduleValue = "5";
        this.formScheduleUnit = "minutes";
      }
    } else {
      this.formScheduleType = "every";
      this.formScheduleValue = "5";
      this.formScheduleUnit = "minutes";
    }
    this.formSession = typeof job.sessionTarget === "string" ? job.sessionTarget : "main";
    this.formWakeMode = typeof job.wakeMode === "string" ? job.wakeMode : "now";
    const payload = this.isRecord(job.payload) ? job.payload : null;
    this.formPayload = payload?.kind === "agentTurn" ? "agent-turn" : "system-event";
    this.formSystemText = payload
      ? typeof payload.text === "string"
        ? payload.text
        : typeof payload.message === "string"
          ? payload.message
          : ""
      : "";
    this.formMode = "update";
  }

  private buildJobFromForm(options?: { includeId?: boolean; jobId?: string }) {
    const includeId = options?.includeId ?? true;
    const jobId = options?.jobId;
    const base: Record<string, unknown> = {
      name: this.formName.trim(),
      description: this.formDescription.trim(),
      agentId: this.formAgentId.trim(),
      enabled: this.formEnabled,
      schedule: this.buildScheduleFromForm(),
      sessionTarget: this.formSession,
      wakeMode: this.formWakeMode,
      payload: this.buildPayloadFromForm(),
    };
    if (includeId) {
      base.id = jobId || `job-${Date.now()}`;
    }
    return base;
  }

  private async createJob() {
    this.setActionStateStart();
    try {
      if (!this.formName.trim()) throw new Error("Job name is required");
      const job = this.buildJobFromForm({ includeId: false });
      await this.performAction(this.jobsPath, "POST", job);
      this.setActionStateDone(`Created job: ${this.formName.trim()}`);
      this.formMode = null;
      this.resetForm();
      await this.refresh();
    } catch (error) {
      this.setActionStateError(error);
    }
  }

  private async updateJob(jobId: string) {
    this.setActionStateStart();
    try {
      if (!this.formName.trim()) throw new Error("Job name is required");
      const patch = this.buildJobFromForm({ includeId: false, jobId });
      await this.performAction(`${this.jobsPath}/${encodeURIComponent(jobId)}`, "PUT", { patch });
      this.setActionStateDone(`Updated job: ${jobId}`);
      this.formMode = null;
      this.resetForm();
      await this.refresh();
    } catch (error) {
      this.setActionStateError(error);
    }
  }

  private deleteJob(jobId: string) {
    this.deleteConfirmJobId = jobId;
    this.showDeleteConfirm = true;
  }

  private async confirmDelete() {
    this.setActionStateStart();
    try {
      const id = this.deleteConfirmJobId.trim();
      if (!id) throw new Error("Job ID is required");
      await this.performAction(`${this.jobsPath}/${encodeURIComponent(id)}`, "DELETE");
      this.setActionStateDone(`Deleted job: ${id}`);
        this.showDeleteConfirm = false;
        this.deleteConfirmJobId = "";
      await this.refresh();
    } catch (error) {
      this.setActionStateError(error);
    }
  }

  private async runNow(jobId: string) {
    this.setActionStateStart();
    try {
      await this.performAction(this.runActionPath, "POST", { id: jobId, mode: "force" });
      this.setActionStateDone(`Run requested: ${jobId}`);
      await this.refresh();
    } catch (error) {
      this.setActionStateError(error);
    }
  }

  private async wake() {
    this.setActionStateStart();
    try {
      await this.performAction(this.wakePath, "POST", {});
      this.setActionStateDone("Wake requested");
      await this.refresh();
    } catch (error) {
      this.setActionStateError(error);
    }
  }

  private setAgentId(agentId: string) {
    this.formAgentId = agentId;
    this.agentPickerOpen = false;
    this.agentPickerSearch = "";
  }

  private renderAgentPicker() {
    if (!this.agentPickerOpen) {
      const selected = this.agents.find((a) => a.id === this.formAgentId);
      return html`
        <button
          class="btn btn--ghost btn--sm"
          style="width: 100%; text-align: left; justify-content: flex-start;"
          @click=${() => { this.agentPickerOpen = true; }}
        >
          ${selected ? selected.name : "Select an agent"}
        </button>
      `;
    }

    const q = this.agentPickerSearch.trim().toLowerCase();
    const visible = q
      ? this.agents.filter((a) => a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      : this.agents;

    return html`
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <input
          class="field__input"
          type="text"
          .value=${this.agentPickerSearch}
          placeholder="Search agents..."
          @input=${(event: Event) => { this.agentPickerSearch = (event.target as HTMLInputElement).value; }}
        />
        <div style="max-height: 200px; overflow: auto; display: flex; flex-direction: column; gap: 4px;">
          ${visible.map((agent) => html`
            <button
              class="btn btn--ghost btn--sm"
              style="width: 100%; text-align: left; justify-content: flex-start;"
              @click=${() => this.setAgentId(agent.id)}
            >
              ${agent.name}
            </button>
          `)}
        </div>
        <button
          class="btn btn--ghost btn--sm"
          @click=${() => { this.agentPickerOpen = false; this.agentPickerSearch = ""; }}
        >
          Close
        </button>
      </div>
    `;
  }

  private renderFormModal() {
    if (!this.formMode) return nothing;

    const isCreate = this.formMode === "create";
    const title = isCreate ? "Create Cron Job" : "Update Cron Job";

    return html`
      <div class="modal-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) this.formMode = null; }} style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
        <div class="card" style="width: 90%; max-width: 600px; max-height: 90vh; overflow-y: auto; position: relative;">
          <header class="mc-task-card__header" style="position: sticky; top: 0; background: white; z-index: 10;">
            <h2 class="mc-task-card__title">${title}</h2>
          </header>

            <div style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
              <div class="field">
                <label class="field__label">Name</label>
                <input
                  class="field__input"
                  type="text"
                  .value=${this.formName}
                  placeholder="Job name"
                  @input=${(event: Event) => { this.formName = (event.target as HTMLInputElement).value; }}
                />
              </div>

              <div class="field">
                <label class="field__label">Description</label>
                <input
                  class="field__input"
                  type="text"
                  .value=${this.formDescription}
                  placeholder="Job description"
                  @input=${(event: Event) => { this.formDescription = (event.target as HTMLInputElement).value; }}
                />
              </div>

              <div class="field">
                <label class="field__label">Agent ID</label>
                ${this.renderAgentPicker()}
              </div>

              <div class="field">
                <label class="field__label">
                  <input type="checkbox" .checked=${this.formEnabled} @change=${(event: Event) => { this.formEnabled = (event.target as HTMLInputElement).checked; }} />
                  Enabled
                </label>
              </div>

              <div class="field">
                <label class="field__label">Schedule</label>
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
                  <select
                    class="field__input"
                    .value=${this.formScheduleType}
                    @change=${(event: Event) => { this.formScheduleType = (event.target as HTMLSelectElement).value; }}
                  >
                    <option value="every">Every</option>
                    <option value="at">At</option>
                    <option value="cron">Cron</option>
                  </select>
                  <input
                    class="field__input"
                    type="text"
                    .value=${this.formScheduleValue}
                    placeholder="Value"
                    @input=${(event: Event) => { this.formScheduleValue = (event.target as HTMLInputElement).value; }}
                  />
                  <select
                    class="field__input"
                    .value=${this.formScheduleUnit}
                    @change=${(event: Event) => { this.formScheduleUnit = (event.target as HTMLSelectElement).value; }}
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </div>
              </div>

              <div class="field">
                <label class="field__label">Session Target</label>
                <select
                  class="field__input"
                  .value=${this.formSession}
                  @change=${(event: Event) => { this.formSession = (event.target as HTMLSelectElement).value; }}
                >
                  <option value="main">Main</option>
                  <option value="isolated">Isolated</option>
                </select>
              </div>

              <div class="field">
                <label class="field__label">Wake Mode</label>
                <select
                  class="field__input"
                  .value=${this.formWakeMode}
                  @change=${(event: Event) => { this.formWakeMode = (event.target as HTMLSelectElement).value; }}
                >
                  <option value="now">Now</option>
                  <option value="next-heartbeat">Next Heartbeat</option>
                </select>
              </div>

              <div class="field">
                <label class="field__label">Payload Kind</label>
                <select
                  class="field__input"
                  .value=${this.formPayload}
                  @change=${(event: Event) => { this.formPayload = (event.target as HTMLSelectElement).value; }}
                >
                  <option value="system-event">System Event</option>
                  <option value="agent-turn">Agent Turn</option>
                </select>
              </div>

              <div class="field">
                <label class="field__label">${this.formPayload === "agent-turn" ? "Message" : "System Text"}</label>
                <textarea
                  class="field__input"
                  rows="3"
                  .value=${this.formSystemText}
                  placeholder=${this.formPayload === "agent-turn" ? "Agent turn message..." : "System event text..."}
                  @input=${(event: Event) => { this.formSystemText = (event.target as HTMLTextAreaElement).value; }}
                ></textarea>
              </div>
            </div>

            <div style="padding: 16px; border-top: 1px solid var(--border-color, #eee); display: flex; gap: 8px; justify-content: flex-end;">
              <button
                class="btn btn--ghost btn--sm"
                ?disabled=${this.actionBusy}
                @click=${() => {
                  this.formMode = null;
                  this.resetForm();
                }}
              >
                Discard
              </button>
              <button
                class="btn btn--primary btn--sm"
                ?disabled=${this.actionBusy}
                @click=${() => {
                  if (isCreate) {
                    void this.createJob();
                  } else {
                    void this.updateJob(this.formJobId);
                  }
                }}
              >
                ${isCreate ? "Create" : "Save"}
              </button>
            </div>
        </div>
      </div>
    `;
  }

    private renderDeleteConfirmDialog() {
      if (!this.showDeleteConfirm || !this.deleteConfirmJobId) return nothing;

      const job = this.jobs.find((j) => this.getJobId(j) === this.deleteConfirmJobId);
      const label = job ? this.getJobLabel(job) : this.deleteConfirmJobId;

      return html`
        <div class="modal-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
          <div class="card" style="width: 90%; max-width: 400px;">
            <header class="mc-task-card__header">
              <h2 class="mc-task-card__title">Confirm Delete</h2>
            </header>
            <div style="padding: 16px;">
              <p>Are you sure you want to delete this cron job?</p>
              <p style="font-weight: 600; margin-top: 8px;">${label}</p>
            </div>
            <div style="padding: 16px; border-top: 1px solid var(--border-color, #eee); display: flex; gap: 8px; justify-content: flex-end;">
              <button
                class="btn btn--ghost btn--sm"
                ?disabled=${this.actionBusy}
                @click=${() => {
                  this.showDeleteConfirm = false;
                  this.deleteConfirmJobId = "";
                }}
              >
                Cancel
              </button>
              <button
                class="btn btn--danger btn--sm"
                ?disabled=${this.actionBusy}
                @click=${() => void this.confirmDelete()}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      `;
    }

    private renderJobsList() {
        const jobs = this.getJobsSortedByNextRun();
      return html`
        <section class="card" style="margin-top: 12px;">
          <header class="mc-task-card__header">
            <span class="badge">Cron Jobs</span>
              <h3 class="mc-task-card__title">Jobs (${jobs.length})</h3>
            <button
              class="btn btn--primary btn--sm"
              @click=${() => this.openCreateForm()}
            >
              Create
            </button>
          </header>

          <div class="mc-nested-list">
              ${jobs.length
                ? jobs.map((job) => {
                const id = this.getJobId(job);
                const enabled = typeof job.enabled === "boolean" ? job.enabled : true;
                return html`
                  <article class="mc-nested-item">
                    <header class="mc-nested-item__header" style="display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;">
                      <span class="badge">${enabled ? "enabled" : "disabled"}</span>
                      <span class="mc-nested-item__title" style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.getJobLabel(job)}</span>
                      <span class="badge badge--warn" style="font-variant-numeric: tabular-nums;">${this.formatJobCountdownInline(job)}</span>
                      <div style="display: flex; gap: 6px; margin-left: auto;">
                        <button
                          class="btn btn--ghost btn--xs"
                          @click=${() => this.openUpdateForm(job)}
                        >
                          Update
                        </button>
                        <button
                          class="btn btn--ghost btn--xs"
                          @click=${() => this.deleteJob(id)}
                        >
                          Delete
                        </button>
                        <button
                          class="btn btn--ghost btn--xs"
                          @click=${() => void this.runNow(id)}
                        >
                          Run Now
                        </button>
                        <button
                          class="btn btn--ghost btn--xs"
                          @click=${() => void this.wake()}
                        >
                          Wake
                        </button>
                      </div>
                    </header>
                    <details class="mc-details" style="margin-top: 8px;">
                      <summary>Details</summary>
                      <div class="mc-nested-grid" style="margin-top: 8px;">
                        <div class="mc-row"><div class="mc-row__key">ID</div><div class="mc-row__value">${id}</div></div>
                        ${typeof job.createdAtMs === "number" ? html`<div class="mc-row"><div class="mc-row__key">Created</div><div class="mc-row__value">${this.formatMs(job.createdAtMs)}</div></div>` : nothing}
                        ${typeof job.updatedAtMs === "number" ? html`<div class="mc-row"><div class="mc-row__key">Updated</div><div class="mc-row__value">${this.formatMs(job.updatedAtMs)}</div></div>` : nothing}
                        ${job.description ? html`<div class="mc-row"><div class="mc-row__key">Description</div><div class="mc-row__value">${job.description}</div></div>` : nothing}
                        <div class="mc-row"><div class="mc-row__key">Schedule</div><div class="mc-row__value">${this.formatScheduleSummary(job)}</div></div>
                        <div class="mc-row"><div class="mc-row__key">Session Target</div><div class="mc-row__value">${this.formatSessionTarget(job)}</div></div>
                        <div class="mc-row"><div class="mc-row__key">Wake Mode</div><div class="mc-row__value">${this.formatWakeMode(job)}</div></div>
                        <div class="mc-row"><div class="mc-row__key">Payload</div><div class="mc-row__value">${this.formatPayloadSummary(job)}</div></div>
                        ${this.renderJobState(job)}
                        ${this.renderRunSparkline(job)}
                        ${job.agentId ? html`<div class="mc-row"><div class="mc-row__key">Agent ID</div><div class="mc-row__value">${job.agentId}</div></div>` : nothing}
                      </div>
                    </details>
                  </article>
                `;
              })
              : html`<div class="card empty-state">No cron jobs found. <button class="btn btn--primary btn--sm" @click=${() => this.openCreateForm()}>Create one</button></div>`}
          </div>
        </section>
      `;
    }

  render() {
    return html`
      <section class="content mission-control">
        <header class="content__header mission-control__header">
          <div>
            <h1 class="content__title">Cron Jobs</h1>
             <p class="mission-control__meta">Manage cron jobs and view their run history.</p>
          </div>
          <div class="content__actions">
            <button class="btn btn--ghost btn--sm" @click=${() => void this.refresh()}>
              ${this.loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </header>

        ${this.error ? html`<div class="callout callout--danger">${this.error}</div>` : nothing}
        ${this.actionError ? html`<div class="callout callout--danger">${this.actionError}</div>` : nothing}
        ${this.actionMessage ? html`<div class="callout">${this.actionMessage}</div>` : nothing}

         ${this.renderTimelineView()}
         ${this.renderJobsList()}

        <section class="card" style="margin-top: 12px;">
          <header class="mc-task-card__header">
            <span class="badge badge--warn">Cron</span>
             <h3 class="mc-task-card__title">Run History (${this.runs.length})</h3>
          </header>
          <div class="mc-nested-list">
            ${this.runs.length
              ? this.runs.map((run, index) => html`
                 <article class="mc-nested-item">
                   <header class="mc-nested-item__header">
                     <span class="badge">${run.status || "run"}</span>
                     <span class="mc-nested-item__title">${run.jobId || `run-${index + 1}`}</span>
                   </header>
                   <div class="mc-nested-grid">
                     <div class="mc-row"><div class="mc-row__key">Action</div><div class="mc-row__value">${run.action || "-"}</div></div>
                     <div class="mc-row"><div class="mc-row__key">At</div><div class="mc-row__value">${this.formatRunTs(run.ts)}</div></div>
                     <div class="mc-row"><div class="mc-row__key">Session</div><div class="mc-row__value">${run.sessionKey || "-"}</div></div>
                     <div class="mc-row"><div class="mc-row__key">Summary</div><div class="mc-row__value">${run.summary || "-"}</div></div>
                     <div class="mc-row"><div class="mc-row__key">Error</div><div class="mc-row__value">${run.error || "-"}</div></div>
                   </div>
                 </article>
              `)
              : html`<div class="card empty-state">No cron runs found.</div>`}

            ${this.renderFormModal()}
            ${this.renderDeleteConfirmDialog()}
          </div>
        </section>
      </section>
    `;
  }
}
