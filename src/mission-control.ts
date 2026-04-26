import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  cloneLayout,
  createLayout,
  createWidgetId,
  loadDashboardLayout,
  saveDashboardLayout,
  type DashboardLayoutFile,
  type DashboardWidgetDefinition,
  type DashboardWidgetLayout,
} from "./dashboard-layout.js";

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
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUsd?: number | null;
  responseUsage?: unknown;
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

interface SubagentRunRecord {
  runId: string;
  entry?: unknown;
}

interface SubagentSessionRecord {
  key?: string;
  sessionId?: string;
  label?: string;
  sessionFile?: string;
  [key: string]: unknown;
}

interface SubagentRunsPayload {
  runs?: SubagentRunRecord[];
}

interface SubagentSessionsPayload {
  sessions?: SubagentSessionRecord[];
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
  @state() private layoutEditorOpen = false;
  @state() private layoutPaletteOpen = false;
  @state() private layoutSaving = false;
  @state() private layoutDirty = false;
  @state() private layoutError = "";
  @state() private isMobileLayout = this.getIsMobileViewport();
  @state() private widgetLayout: DashboardLayoutFile = this.createDefaultLayout();
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
  @state() private selectedSessionId = "all";
  @state() private sessionPickerSearch = "";
  @state() private subagentRuns: SubagentRunRecord[] = [];
  @state() private subagentSessions: SubagentSessionRecord[] = [];

  private readonly apiPath = "/api/mission-control/chatui";
  private readonly subagentRunsPath = "/api/subagents/runs";
  private readonly subagentSessionsPath = "/api/subagents/sessions";
  private readonly layoutPage = "mission-control" as const;
  private readonly widgetDefinitions: DashboardWidgetDefinition[] = [
    {
      type: "task-summary",
      title: "Latest task",
      description: "A compact snapshot of the most recent task",
      defaultSize: "small",
      allowedSizes: ["small", "medium", "large"],
    },
    {
      type: "task-metrics",
      title: "Task metrics",
      description: "Counts, totals, and error signals across tasks",
      defaultSize: "small",
      allowedSizes: ["small", "medium", "large"],
    },
    {
      type: "task-recent-list",
      title: "Recent tasks",
      description: "A rolling list of the latest tasks",
      defaultSize: "medium",
      allowedSizes: ["small", "medium", "large"],
    },
    {
      type: "task-history",
      title: "Task history",
      description: "A denser history view of recent work",
      defaultSize: "large",
      allowedSizes: ["medium", "large"],
    },
    {
      type: "subagent-summary",
      title: "Subagent activity",
      description: "A quick view of runs and sessions tied to the current data",
      defaultSize: "medium",
      allowedSizes: ["small", "medium", "large"],
    },
  ];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private viewportResizeHandler: (() => void) | null = null;
  private layoutSnapshot: DashboardLayoutFile | null = null;
  private openDetails = new Set<string>();
  @state() private activeDragWidgetId = "";
  @state() private mobileDropTargetWidgetId = "";
  private mobileLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  private mobilePointerStartX = 0;
  private mobilePointerStartY = 0;
  private mobilePointerClientX = 0;
  private mobilePointerClientY = 0;
  private mobileDragActive = false;
  private mobileAutoScrollRaf: number | null = null;
  private mobileAutoScrollVelocity = 0;
  private mobilePrevBodyOverflow = "";
  private mobilePrevBodyTouchAction = "";
  private mobilePrevHtmlOverscrollBehavior = "";
  private mobileScrollBlocker: ((event: Event) => void) | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.isMobileLayout = this.getIsMobileViewport();
    this.initializeDefaultTimes();
    void this.refresh();
    void this.loadWidgetLayout();
    this.viewportResizeHandler = () => {
      const nextIsMobile = this.getIsMobileViewport();
      if (nextIsMobile === this.isMobileLayout) return;
      this.isMobileLayout = nextIsMobile;
      this.layoutEditorOpen = false;
      this.layoutPaletteOpen = false;
      this.layoutDirty = false;
      void this.loadWidgetLayout();
    };
    window.addEventListener("resize", this.viewportResizeHandler, { passive: true });
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
    this.clearMobileLongPress();
    this.stopMobileAutoScroll();
    this.setMobileDragScrollLock(false);
    if (this.viewportResizeHandler) {
      window.removeEventListener("resize", this.viewportResizeHandler);
      this.viewportResizeHandler = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private getIsMobileViewport() {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 768px)").matches;
  }

  private getMobileLayoutStorageKey() {
    return `openclaw:dashboard-layout:${this.layoutPage}:mobile`;
  }

  private readMobileLayoutFromStorage() {
    if (typeof window === "undefined" || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem(this.getMobileLayoutStorageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as DashboardLayoutFile;
      if (!parsed || !Array.isArray(parsed.widgets)) return null;
      return createLayout(parsed.widgets);
    } catch {
      return null;
    }
  }

  private writeMobileLayoutToStorage(layout: DashboardLayoutFile) {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      window.localStorage.setItem(this.getMobileLayoutStorageKey(), JSON.stringify(layout));
    } catch {
      // Best effort only.
    }
  }

  private toMobileLayout(widgets: DashboardWidgetLayout[]) {
    return createLayout(
      widgets.map<DashboardWidgetLayout>((widget, index) => ({
        ...widget,
        size: "small",
        row: index + 1,
        col: 1,
      })),
    );
  }

  private createDesktopDefaultLayout() {
    return createLayout([
      { id: "task-metrics", type: "task-metrics", size: "small" },
      { id: "task-summary", type: "task-summary", size: "small" },
      { id: "subagent-activity", type: "subagent-summary", size: "small" },
      { id: "recent-tasks", type: "task-recent-list", size: "large" },
      { id: "task-history", type: "task-history", size: "large" },
    ]);
  }

  private createMobileDefaultLayout() {
    return createLayout([
      { id: "task-metrics", type: "task-metrics", size: "small", row: 1, col: 1 },
      { id: "task-summary", type: "task-summary", size: "small", row: 2, col: 1 },
      { id: "subagent-activity", type: "subagent-summary", size: "small", row: 3, col: 1 },
      { id: "recent-tasks", type: "task-recent-list", size: "small", row: 4, col: 1 },
      { id: "task-history", type: "task-history", size: "small", row: 5, col: 1 },
    ]);
  }

  private createDefaultLayout() {
    return this.isMobileLayout ? this.createMobileDefaultLayout() : this.createDesktopDefaultLayout();
  }

  private getWidgetDefinition(type: string) {
    return this.widgetDefinitions.find((widget) => widget.type === type) ?? null;
  }

  private getWidgetLabel(widget: DashboardWidgetLayout) {
    return this.getWidgetDefinition(widget.type)?.title ?? widget.type;
  }

  private getWidgetDescription(widget: DashboardWidgetLayout) {
    return this.getWidgetDefinition(widget.type)?.description ?? "";
  }

  private getWidgetSpan(size: DashboardWidgetLayout["size"]) {
    if (size === "large") return 3;
    if (size === "medium") return 2;
    return 1;
  }

  private reflowWidgetsInOrder(widgets: DashboardWidgetLayout[]): DashboardWidgetLayout[] {
    if (this.isMobileLayout) {
      return widgets.map<DashboardWidgetLayout>((widget, index) => ({
        ...widget,
        size: "small",
        row: index + 1,
        col: 1,
      }));
    }

    let row = 1;
    let col = 1;

    return widgets.map((widget) => {
      const span = this.getWidgetSpan(widget.size);
      if (col + span - 1 > 3) {
        row += 1;
        col = 1;
      }

      const placed = { ...widget, row, col };
      col += span;

      if (col > 3) {
        row += 1;
        col = 1;
      }

      return placed;
    });
  }

  private async loadWidgetLayout() {
    if (this.isMobileLayout) {
      const mobileSaved = this.readMobileLayoutFromStorage();
      if (mobileSaved) {
        this.widgetLayout = this.toMobileLayout(mobileSaved.widgets);
        return;
      }

      const desktopSaved = await loadDashboardLayout(this.layoutPage);
      if (desktopSaved) {
        this.widgetLayout = this.toMobileLayout(desktopSaved.widgets);
        return;
      }

      this.widgetLayout = this.createMobileDefaultLayout();
      return;
    }

    const saved = await loadDashboardLayout(this.layoutPage);
    if (saved) {
      this.widgetLayout = cloneLayout(saved);
      return;
    }

    this.widgetLayout = this.createDesktopDefaultLayout();
  }

  private async persistLayout() {
    this.layoutSaving = true;
    this.layoutError = "";

    try {
      if (this.isMobileLayout) {
        this.writeMobileLayoutToStorage(this.toMobileLayout(this.widgetLayout.widgets));
        return;
      }
      await saveDashboardLayout(this.layoutPage, this.widgetLayout);
    } catch (error) {
      this.layoutError = error instanceof Error ? error.message : String(error);
    } finally {
      this.layoutSaving = false;
    }
  }

  private resetLayoutDraft() {
    this.widgetLayout = this.createDefaultLayout();
    this.layoutDirty = true;
  }

  private async saveLayoutChanges() {
    await this.persistLayout();
    this.layoutEditorOpen = false;
    this.layoutPaletteOpen = false;
    this.layoutDirty = false;
    this.layoutSnapshot = null;
  }

  private discardLayoutChanges() {
    if (this.layoutSnapshot) {
      this.widgetLayout = cloneLayout(this.layoutSnapshot);
    }
    this.layoutEditorOpen = false;
    this.layoutPaletteOpen = false;
    this.layoutDirty = false;
    this.layoutSnapshot = null;
  }

  private toggleLayoutEditor() {
    if (!this.layoutEditorOpen) {
      if (!this.widgetLayout.widgets.length) {
        this.widgetLayout = this.createDefaultLayout();
      }
      this.layoutSnapshot = cloneLayout(this.widgetLayout);
      this.layoutEditorOpen = true;
      this.layoutPaletteOpen = false;
      this.layoutDirty = false;
      return;
    }

    this.discardLayoutChanges();
  }

  private updateWidgetLayout(mutator: (widgets: DashboardWidgetLayout[]) => DashboardWidgetLayout[]) {
    const nextLayout = createLayout(mutator([...this.widgetLayout.widgets]));
    this.widgetLayout = this.isMobileLayout ? this.toMobileLayout(nextLayout.widgets) : nextLayout;
    if (this.layoutEditorOpen) {
      this.layoutDirty = true;
    } else {
      void this.persistLayout();
    }
  }

  private addWidget(type: string) {
    const definition = this.getWidgetDefinition(type);
    if (!definition) return;

    this.updateWidgetLayout((widgets) => [
      ...widgets,
      { id: createWidgetId(type), type, size: this.isMobileLayout ? "small" : definition.defaultSize, row: 1, col: 1 },
    ]);
  }

  private removeWidget(widgetId: string) {
    this.updateWidgetLayout((widgets) => widgets.filter((widget) => widget.id !== widgetId));
  }

  private setWidgetSize(widgetId: string, size: DashboardWidgetLayout["size"]) {
    if (this.isMobileLayout) return;
    this.updateWidgetLayout((widgets) => widgets.map((widget) => (widget.id === widgetId ? { ...widget, size } : widget)));
  }

  private moveWidget(widgetId: string, targetWidgetId: string) {
    this.updateWidgetLayout((widgets) => {
      const fromIndex = widgets.findIndex((widget) => widget.id === widgetId);
      const toIndex = widgets.findIndex((widget) => widget.id === targetWidgetId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return widgets;

      const next = [...widgets];
      [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
      return this.reflowWidgetsInOrder(next);
    });
  }

  private onWidgetDragStart(event: DragEvent, widgetId: string) {
    if (!this.layoutEditorOpen || this.isMobileLayout) {
      event.preventDefault();
      return;
    }

    event.dataTransfer?.setData("text/plain", widgetId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
    this.activeDragWidgetId = widgetId;
    this.mobileDropTargetWidgetId = "";
  }

  private onWidgetDragEnd() {
    this.activeDragWidgetId = "";
    this.mobileDropTargetWidgetId = "";
  }

  private onWidgetDrop(event: DragEvent, targetWidgetId: string) {
    event.preventDefault();
    event.stopPropagation();
    const widgetId = event.dataTransfer?.getData("text/plain") || "";
    this.activeDragWidgetId = "";
    this.mobileDropTargetWidgetId = "";
    if (!widgetId || widgetId === targetWidgetId) return;
    this.moveWidget(widgetId, targetWidgetId);
  }

  private onCanvasDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const widgetId = event.dataTransfer?.getData("text/plain") || "";
    this.activeDragWidgetId = "";
    this.mobileDropTargetWidgetId = "";
    if (!widgetId) return;

    const widgets = [...this.widgetLayout.widgets];
    const fromIndex = widgets.findIndex((widget) => widget.id === widgetId);
    if (fromIndex < 0) return;

    const [widget] = widgets.splice(fromIndex, 1);
    widgets.push(widget);
    this.widgetLayout = createLayout(this.reflowWidgetsInOrder(widgets));
    if (this.layoutEditorOpen) {
      this.layoutDirty = true;
    } else {
      void this.persistLayout();
    }
  }

  private clearMobileLongPress() {
    if (this.mobileLongPressTimer) {
      clearTimeout(this.mobileLongPressTimer);
      this.mobileLongPressTimer = null;
    }
  }

  private setMobileDragScrollLock(locked: boolean) {
    if (typeof document === "undefined") return;
    if (locked) {
      this.mobilePrevBodyTouchAction = document.body.style.touchAction;
      this.mobilePrevHtmlOverscrollBehavior = document.documentElement.style.overscrollBehavior;
      document.body.style.touchAction = "none";
      document.documentElement.style.overscrollBehavior = "none";

      if (!this.mobileScrollBlocker) {
        this.mobileScrollBlocker = (event: Event) => {
          if (!this.mobileDragActive) return;
          if ((event as { cancelable?: boolean }).cancelable) {
            event.preventDefault();
          }
        };
      }
      document.addEventListener("touchmove", this.mobileScrollBlocker, { passive: false });
      document.addEventListener("wheel", this.mobileScrollBlocker, { passive: false });
      return;
    }

    if (this.mobileScrollBlocker) {
      document.removeEventListener("touchmove", this.mobileScrollBlocker);
      document.removeEventListener("wheel", this.mobileScrollBlocker);
    }
    document.body.style.touchAction = this.mobilePrevBodyTouchAction;
    document.documentElement.style.overscrollBehavior = this.mobilePrevHtmlOverscrollBehavior;
    this.mobilePrevBodyTouchAction = "";
    this.mobilePrevHtmlOverscrollBehavior = "";
  }

  private stopMobileAutoScroll() {
    if (this.mobileAutoScrollRaf !== null) {
      window.cancelAnimationFrame(this.mobileAutoScrollRaf);
      this.mobileAutoScrollRaf = null;
    }
    this.mobileAutoScrollVelocity = 0;
  }

  private startMobileAutoScroll() {
    if (this.mobileAutoScrollRaf !== null) return;

    const tick = () => {
      if (!this.mobileDragActive) {
        this.stopMobileAutoScroll();
        return;
      }

      if (this.mobileAutoScrollVelocity !== 0) {
        window.scrollBy(0, this.mobileAutoScrollVelocity);
        const targetId = this.getWidgetIdFromPoint(this.mobilePointerClientX, this.mobilePointerClientY);
        if (targetId) {
          this.mobileDropTargetWidgetId = targetId;
        }
      }

      this.mobileAutoScrollRaf = window.requestAnimationFrame(tick);
    };

    this.mobileAutoScrollRaf = window.requestAnimationFrame(tick);
  }

  private updateMobileAutoScroll(clientY: number) {
    const edgeThreshold = 88;
    const maxStep = 16;
    let velocity = 0;

    if (clientY < edgeThreshold) {
      velocity = -Math.max(1, Math.round(((edgeThreshold - clientY) / edgeThreshold) * maxStep));
    } else if (clientY > window.innerHeight - edgeThreshold) {
      velocity = Math.max(1, Math.round(((clientY - (window.innerHeight - edgeThreshold)) / edgeThreshold) * maxStep));
    }

    this.mobileAutoScrollVelocity = velocity;
    if (velocity !== 0) {
      this.startMobileAutoScroll();
      return;
    }
    this.stopMobileAutoScroll();
  }

  private getWidgetIdFromPoint(clientX: number, clientY: number) {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const card = el?.closest(".dashboard-widget") as HTMLElement | null;
    return card?.dataset.widgetId ?? "";
  }

  private resetMobileDragState() {
    this.clearMobileLongPress();
    this.stopMobileAutoScroll();
    this.setMobileDragScrollLock(false);
    this.mobileDragActive = false;
    this.activeDragWidgetId = "";
    this.mobileDropTargetWidgetId = "";
  }

  private onGripPointerDown(event: PointerEvent, widgetId: string) {
    if (!this.layoutEditorOpen || !this.isMobileLayout) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, select, input, textarea, a, label")) return;
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    this.clearMobileLongPress();
    this.mobileDragActive = false;
    this.activeDragWidgetId = "";
    this.mobileDropTargetWidgetId = "";
    this.mobilePointerStartX = event.clientX;
    this.mobilePointerStartY = event.clientY;
    this.mobilePointerClientX = event.clientX;
    this.mobilePointerClientY = event.clientY;
    this.mobileLongPressTimer = setTimeout(() => {
      this.mobileDragActive = true;
      this.activeDragWidgetId = widgetId;
      this.mobileDropTargetWidgetId = widgetId;
      this.setMobileDragScrollLock(true);
      this.updateMobileAutoScroll(this.mobilePointerClientY);
    }, 500);
  }

  private onGripPointerMove(event: PointerEvent) {
    if (!this.layoutEditorOpen || !this.isMobileLayout) return;
    this.mobilePointerClientX = event.clientX;
    this.mobilePointerClientY = event.clientY;

    if (!this.mobileDragActive) {
      const deltaX = Math.abs(event.clientX - this.mobilePointerStartX);
      const deltaY = Math.abs(event.clientY - this.mobilePointerStartY);
      if (deltaX > 8 || deltaY > 8) {
        this.clearMobileLongPress();
      }
      return;
    }

    event.preventDefault();
    const targetId = this.getWidgetIdFromPoint(event.clientX, event.clientY);
    if (targetId) {
      this.mobileDropTargetWidgetId = targetId;
    }
    this.updateMobileAutoScroll(event.clientY);
  }

  private onGripPointerUp(event: PointerEvent) {
    if (!this.layoutEditorOpen || !this.isMobileLayout) return;
    (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);

    const wasDragging = this.mobileDragActive;
    const sourceId = this.activeDragWidgetId;
    const targetId = this.mobileDropTargetWidgetId;
    this.resetMobileDragState();

    if (wasDragging && sourceId && targetId && sourceId !== targetId) {
      this.moveWidget(sourceId, targetId);
    }
  }

  private onGripPointerCancel(event: PointerEvent) {
    if (!this.layoutEditorOpen || !this.isMobileLayout) return;
    (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
    this.resetMobileDragState();
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

  private buildApiUrl(pathname: string) {
    return new URL(pathname, this.resolveApiOrigin()).toString();
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

      const [subagentRunsResult, subagentSessionsResult] = await Promise.allSettled([
        fetch(this.buildApiUrl(this.subagentRunsPath), { cache: "no-store" }),
        fetch(this.buildApiUrl(this.subagentSessionsPath), { cache: "no-store" }),
      ]);

      if (subagentRunsResult.status === "fulfilled" && subagentRunsResult.value.ok) {
        const subagentRunsPayload = (await subagentRunsResult.value.json()) as SubagentRunsPayload;
        this.subagentRuns = Array.isArray(subagentRunsPayload.runs) ? subagentRunsPayload.runs : [];
      } else {
        this.subagentRuns = [];
      }

      if (subagentSessionsResult.status === "fulfilled" && subagentSessionsResult.value.ok) {
        const subagentSessionsPayload = (await subagentSessionsResult.value.json()) as SubagentSessionsPayload;
        this.subagentSessions = Array.isArray(subagentSessionsPayload.sessions) ? subagentSessionsPayload.sessions : [];
      } else {
        this.subagentSessions = [];
      }

    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.tasks = [];
      this.subagentRuns = [];
      this.subagentSessions = [];
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

  private getSubagentDataForTask(task: MissionControlTask) {
    const taskRunId = task.runId || "";
    const taskSessionKey = task.sessionKey || "";
    const taskSessionId = task.sessionId || "";

    const runs = this.subagentRuns.filter((run) => {
      if (run.runId === taskRunId) return true;
      if (!this.isRecord(run.entry)) return false;

      const entryRunId = typeof run.entry.runId === "string" ? run.entry.runId : "";
      const parentRunId = typeof run.entry.parentRunId === "string" ? run.entry.parentRunId : "";
      const sessionKey = typeof run.entry.sessionKey === "string" ? run.entry.sessionKey : "";
      const parentSessionKey = typeof run.entry.parentSessionKey === "string" ? run.entry.parentSessionKey : "";
      const sessionId = typeof run.entry.sessionId === "string" ? run.entry.sessionId : "";

      if (entryRunId && entryRunId === taskRunId) return true;
      if (parentRunId && parentRunId === taskRunId) return true;
      if (sessionId && taskSessionId && sessionId === taskSessionId) return true;
      if (sessionKey && taskSessionKey && sessionKey === taskSessionKey) return true;
      if (parentSessionKey && taskSessionKey && parentSessionKey === taskSessionKey) return true;

      return false;
    });

    const sessions = this.subagentSessions.filter((session) => {
      const sid = typeof session.sessionId === "string" ? session.sessionId : "";
      const key = typeof session.key === "string" ? session.key : "";

      if (sid && taskSessionId && sid === taskSessionId) return true;
      if (taskSessionKey && key.includes(taskSessionKey)) return true;
      return false;
    });

    return { runs, sessions };
  }

  private renderSubagentSection(task: MissionControlTask, baseKey: string) {
    const { runs, sessions } = this.getSubagentDataForTask(task);
    const total = runs.length + sessions.length;
    if (!total) return nothing;

    return html`
      <details
        class="mc-details"
        ?open=${this.isOpen(`${baseKey}:subagents`)}
        @toggle=${(event: Event) => this.toggleDetail(`${baseKey}:subagents`, (event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Subagents (${total})</summary>

        ${runs.length
          ? html`
            <div class="mc-nested-list">
              ${runs.map((run, index) => html`
                <article class="mc-nested-item">
                  <header class="mc-nested-item__header">
                    <span class="badge">Run</span>
                    <span class="mc-nested-item__title">${run.runId || `subagent-${index + 1}`}</span>
                  </header>
                  <div class="mc-nested-grid">
                    ${this.renderRow("Run ID", run.runId || "-")}
                    ${this.renderRow("Entry", this.renderStructuredValue(run.entry, `${baseKey}:subagent-run:${run.runId || index}`))}
                  </div>
                </article>
              `)}
            </div>
          `
          : nothing}

        ${sessions.length
          ? html`
            <div class="mc-nested-list">
              ${sessions.map((session, index) => html`
                <article class="mc-nested-item">
                  <header class="mc-nested-item__header">
                    <span class="badge">Session</span>
                    <span class="mc-nested-item__title">${session.label || session.sessionId || `subagent-session-${index + 1}`}</span>
                  </header>
                  <div class="mc-nested-grid">
                    ${this.renderRow("Session ID", session.sessionId || "-")}
                    ${this.renderRow("Key", session.key || "-")}
                    ${this.renderRow("Data", this.renderStructuredValue(session, `${baseKey}:subagent-session:${session.sessionId || index}`))}
                  </div>
                </article>
              `)}
            </div>
          `
          : nothing}
      </details>
    `;
  }

  private formatDate(value?: string) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.valueOf())) return value;
    return d.toLocaleString();
  }

  private formatTokenCount(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    return value.toLocaleString();
  }

  private formatUsd(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    return `$${value.toFixed(6)}`;
  }

  private getSortedTasks() {
    return [...this.tasks].sort((left, right) => this.getTaskTimestamp(right) - this.getTaskTimestamp(left));
  }

  private getTaskTimestamp(task: MissionControlTask) {
    const raw = task.timestamp || task.createdAt || "";
    const parsed = raw ? Date.parse(raw) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private getTaskTokenTotal(task: MissionControlTask) {
    return Number(task.totalTokens ?? task.inputTokens ?? 0) || 0;
  }

  private getTaskCostTotal(task: MissionControlTask) {
    return Number(task.estimatedCostUsd ?? 0) || 0;
  }

  private getTaskCountByStatus(status: string) {
    const normalized = status.toLowerCase();
    return this.tasks.filter((task) => (task.status || "").toLowerCase() === normalized).length;
  }

  private renderMetricCard(label: string, value: unknown, tone: string = "") {
    return html`
      <div class="widget-metric ${tone ? `widget-metric--${tone}` : ""}">
        <div class="widget-metric__label">${label}</div>
        <div class="widget-metric__value">${value ?? "-"}</div>
      </div>
    `;
  }

  private renderTaskSummaryWidget(size: DashboardWidgetLayout["size"]) {
    const task = this.getSortedTasks()[0];
    if (!task) {
      return html`<div class="widget-empty">No task logs available yet.</div>`;
    }

    const promptPreview = task.prompt ? task.prompt.slice(0, size === "small" ? 90 : size === "medium" ? 160 : 260) : "-";
    const responsePreview = task.response
      ? (typeof task.response === "string"
        ? task.response.slice(0, size === "small" ? 90 : 180)
        : JSON.stringify(task.response).slice(0, size === "small" ? 90 : 180))
      : "-";

    return html`
      <div class="widget-stack">
        <div class="widget-row"><span>Status</span><strong>${task.status || "unknown"}</strong></div>
        <div class="widget-row"><span>Run</span><strong>${task.runId || "-"}</strong></div>
        <div class="widget-row"><span>Session</span><strong>${task.sessionKey || task.sessionId || "-"}</strong></div>
        <div class="widget-row"><span>Agent</span><strong>${task.agentId || "-"}</strong></div>
        <div class="widget-row"><span>At</span><strong>${this.formatDate(task.timestamp)}</strong></div>
        <div class="widget-row"><span>Tokens</span><strong>${this.formatTokenCount(task.totalTokens ?? task.inputTokens)}</strong></div>
        <div class="widget-row"><span>Cost</span><strong>${this.formatUsd(task.estimatedCostUsd)}</strong></div>
        ${size !== "small" ? html`<p class="widget-preview">${promptPreview}</p>` : nothing}
        ${size === "large" ? html`
          <div class="widget-stack widget-stack--compact">
            <div class="widget-row"><span>Response</span><strong>${responsePreview}</strong></div>
            <div class="widget-row"><span>Events</span><strong>${Array.isArray(task.events) ? task.events.length : 0}</strong></div>
            <div class="widget-row"><span>Documents</span><strong>${Array.isArray(task.documents) ? task.documents.length : 0}</strong></div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderTaskMetricsWidget(size: DashboardWidgetLayout["size"]) {
    const totalTokens = this.tasks.reduce((sum, task) => sum + this.getTaskTokenTotal(task), 0);
    const totalCost = this.tasks.reduce((sum, task) => sum + this.getTaskCostTotal(task), 0);
    const errorCount = this.tasks.filter((task) => Boolean(task.error)).length;

    return html`
      <div class="widget-grid widget-grid--metrics">
        ${this.renderMetricCard("Total", this.tasks.length, "primary")}
        ${this.renderMetricCard("Active", this.getTaskCountByStatus("running") + this.getTaskCountByStatus("progress"), "success")}
        ${this.renderMetricCard("Errors", errorCount, "danger")}
        ${this.renderMetricCard("Tokens", totalTokens.toLocaleString(), "neutral")}
        ${size !== "small" ? this.renderMetricCard("Cost", this.formatUsd(totalCost), "neutral") : nothing}
        ${size === "large" ? this.renderMetricCard("Subagent runs", this.subagentRuns.length, "accent") : nothing}
      </div>
    `;
  }

  private renderTaskRecentListWidget(size: DashboardWidgetLayout["size"]) {
    const grouped = this.getSessionGroupedTasks();
    const limit = size === "small" ? 3 : size === "medium" ? 5 : 8;
    const tasks = grouped.slice(0, limit);

    if (!tasks.length) {
      return html`<div class="widget-empty">No recent tasks yet.</div>`;
    }

    return html`
      <div class="widget-stack">
        ${this.showFilters ? this.renderSessionTabs() : nothing}
        ${this.showFilters ? this.renderFilterPanel() : nothing}
        <div class="widget-list">
        ${tasks.map((task) => html`
          <article class="widget-list-item">
            <div class="widget-list-item__title-row">
              <span class="badge ${this.statusBadgeClass(task.status)}">${task.status || "unknown"}</span>
              <strong>${task.runId || task.id || "task"}</strong>
            </div>
            <div class="widget-list-item__body">${task.title || task.prompt || "Untitled task"}</div>
            <div class="widget-list-item__meta">
              <span>${this.formatDate(task.timestamp)}</span>
              <span>${this.formatTokenCount(task.totalTokens ?? task.inputTokens)} tokens</span>
              <span>${this.formatUsd(task.estimatedCostUsd)}</span>
            </div>
          </article>
        `)}
        </div>
      </div>
    `;
  }

  private renderTaskHistoryWidget(size: DashboardWidgetLayout["size"]) {
    const grouped = this.getSessionGroupedTasks();
    const limit = size === "medium" ? 4 : 6;
    const tasks = grouped.slice(0, limit);

    if (!tasks.length) {
      return html`<div class="widget-empty">Task history is empty.</div>`;
    }

    return html`
      <div class="widget-stack">
        ${this.showFilters ? this.renderSessionTabs() : nothing}
        ${this.showFilters ? this.renderFilterPanel() : nothing}
        <div class="widget-history">
        ${tasks.map((task) => html`
          <article class="widget-history-item">
            <header class="widget-history-item__header">
              <span class="badge ${this.statusBadgeClass(task.status)}">${task.status || "unknown"}</span>
              <strong>${task.runId || task.id || "task"}</strong>
              <span>${this.formatDate(task.timestamp)}</span>
            </header>
            <div class="widget-history-item__summary">
              <span>${task.sessionKey || task.sessionId || "-"}</span>
              <span>${task.agentId || "-"}</span>
              <span>${this.formatTokenCount(task.totalTokens ?? task.inputTokens)} tokens</span>
            </div>
            <p class="widget-preview">${task.title || task.prompt || task.description || "No description"}</p>
          </article>
        `)}
        </div>
      </div>
    `;
  }

  private renderSubagentSummaryWidget(size: DashboardWidgetLayout["size"]) {
    const recentRuns = this.subagentRuns.slice(0, size === "small" ? 3 : 5);
    const recentSessions = this.subagentSessions.slice(0, size === "small" ? 2 : 4);

    return html`
      <div class="widget-stack">
        <div class="widget-grid widget-grid--compact">
          ${this.renderMetricCard("Runs", this.subagentRuns.length, "accent")}
          ${this.renderMetricCard("Sessions", this.subagentSessions.length, "primary")}
        </div>
        ${size !== "small" ? html`
          <div class="widget-list widget-list--compact">
            ${recentRuns.map((run) => html`<div class="widget-list-item"><strong>${run.runId}</strong><div class="widget-list-item__body">${typeof run.entry === "object" ? "Structured entry" : String(run.entry ?? "-")}</div></div>`)}
          </div>
        ` : nothing}
        ${size === "large" ? html`
          <div class="widget-list widget-list--compact">
            ${recentSessions.map((session) => html`<div class="widget-list-item"><strong>${session.label || session.sessionId || "session"}</strong><div class="widget-list-item__body">${session.key || "-"}</div></div>`)}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderWidgetContent(widget: DashboardWidgetLayout) {
    switch (widget.type) {
      case "task-summary":
        return this.renderTaskSummaryWidget(widget.size);
      case "task-metrics":
        return this.renderTaskMetricsWidget(widget.size);
      case "task-recent-list":
        return this.renderTaskRecentListWidget(widget.size);
      case "task-history":
        return this.renderTaskHistoryWidget(widget.size);
      case "subagent-summary":
        return this.renderSubagentSummaryWidget(widget.size);
      default:
        return html`<div class="widget-empty">Unknown widget: ${widget.type}</div>`;
    }
  }

  private renderWidgetCard(widget: DashboardWidgetLayout) {
    const definition = this.getWidgetDefinition(widget.type);
    const allowedSizes = this.isMobileLayout
      ? (["small"] as DashboardWidgetLayout["size"][])
      : (definition?.allowedSizes ?? ["small", "medium", "large"]);
    const fallbackSize = definition?.defaultSize ?? "small";
    const effectiveSize = this.isMobileLayout
      ? "small"
      : allowedSizes.includes(widget.size)
      ? widget.size
      : (allowedSizes.includes(fallbackSize) ? fallbackSize : allowedSizes[0]);
    const span = this.isMobileLayout ? 1 : this.getWidgetSpan(effectiveSize);
    const widgetForRender = effectiveSize === widget.size ? widget : { ...widget, size: effectiveSize };
    const row = Math.floor(widget.row);
    const col = Math.floor(widget.col);
    const styleParts = this.isMobileLayout
      ? ["grid-column: 1 / -1;"]
      : [
        `grid-column: ${col} / span ${span};`,
        `grid-row: ${row};`,
      ].filter(Boolean);
    const showFilterToggle = !this.layoutEditorOpen && (widget.type === "task-recent-list" || widget.type === "task-history");
    const isLifted = this.activeDragWidgetId === widget.id;
    const isDropTarget = this.mobileDropTargetWidgetId === widget.id && this.activeDragWidgetId !== widget.id;

    return html`
      <article
        data-widget-id=${widget.id}
        class="dashboard-widget dashboard-widget--${effectiveSize} ${this.layoutEditorOpen ? "dashboard-widget--editing" : ""} ${isLifted ? "dashboard-widget--lifted" : ""} ${isDropTarget ? "dashboard-widget--drop-target" : ""}"
        style=${styleParts.join(" ")}
        draggable=${this.layoutEditorOpen && !this.isMobileLayout ? "true" : "false"}
        @pointerdown=${(event: PointerEvent) => this.onGripPointerDown(event, widget.id)}
        @pointermove=${(event: PointerEvent) => this.onGripPointerMove(event)}
        @pointerup=${(event: PointerEvent) => this.onGripPointerUp(event)}
        @pointercancel=${(event: PointerEvent) => this.onGripPointerCancel(event)}
        @dragstart=${(event: DragEvent) => this.onWidgetDragStart(event, widget.id)}
        @dragend=${() => this.onWidgetDragEnd()}
        @dragover=${(event: DragEvent) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        @drop=${(event: DragEvent) => this.onWidgetDrop(event, widget.id)}
      >
        <header class="dashboard-widget__header">
          <div class="dashboard-widget__title-group">
            ${this.layoutEditorOpen ? html`
              <span
                class="dashboard-widget__grip"
                title=${this.isMobileLayout ? "Hold anywhere on widget for 0.5s, then drag onto another widget" : "Drag to reorder"}
              >⠿</span>
            ` : nothing}
            <div>
              <h3>${definition?.title ?? widget.type}</h3>
              ${definition?.description ? html`<p>${definition.description}</p>` : nothing}
            </div>
          </div>

          ${(showFilterToggle || this.layoutEditorOpen) ? html`
            <div class="dashboard-widget__actions">
              ${showFilterToggle ? html`
                <button class="btn btn--ghost btn--sm" @click=${() => { this.showFilters = !this.showFilters; }}>
                  ${this.showFilters ? "Hide filter" : "Filter"}
                </button>
              ` : nothing}
              ${this.layoutEditorOpen && !this.isMobileLayout ? html`
                <select
                  class="field__select dashboard-widget__size-select"
                  aria-label="Widget size"
                  @change=${(event: Event) => this.setWidgetSize(widget.id, (event.target as HTMLSelectElement).value as DashboardWidgetLayout["size"])}
                >
                  ${allowedSizes.map((size) => html`<option value=${size} ?selected=${size === effectiveSize}>${size}</option>`) }
                </select>
                <button class="btn btn--ghost btn--sm" @click=${() => this.removeWidget(widget.id)}>Remove</button>
              ` : nothing}
            </div>
          ` : nothing}
        </header>

        <div class="dashboard-widget__body">
          ${this.renderWidgetContent(widgetForRender)}
        </div>
      </article>
    `;
  }

  private renderWidgetEditorToolbar() {
    return html`
      <div class="dashboard-toolbar">
        <div class="dashboard-toolbar__meta">
          <span class="badge badge--warn">Editable layout</span>
          <span>
            ${this.layoutSaving
              ? "Saving layout..."
              : this.layoutDirty
                ? "Unsaved layout changes"
                : "No unsaved changes"}
          </span>
          <span>
            ${this.isMobileLayout
              ? "Hold any widget for 0.5s, then drag it onto another widget to reorder."
              : "Drag one widget onto another to reorder."}
          </span>
        </div>
        <div class="dashboard-toolbar__actions">
          <button class="btn btn--ghost btn--sm" @click=${() => { this.layoutPaletteOpen = !this.layoutPaletteOpen; }}>
            ${this.layoutPaletteOpen ? "Close widget picker" : "Add widget"}
          </button>
          <button class="btn btn--ghost btn--sm" @click=${() => this.resetLayoutDraft()}>
            Reset draft
          </button>
          <button class="btn btn--ghost btn--sm" @click=${() => this.discardLayoutChanges()}>
            Not save
          </button>
          <button class="btn btn--primary btn--sm" @click=${() => void this.saveLayoutChanges()}>
            Save
          </button>
        </div>
      </div>
    `;
  }

  private renderWidgetPalette() {
    if (!this.layoutPaletteOpen) return nothing;

    return html`
      <section class="dashboard-palette">
        ${this.widgetDefinitions.map((widget) => html`
          <button class="dashboard-palette__item" @click=${() => this.addWidget(widget.type)}>
            <strong>${widget.title}</strong>
            <span>${widget.description}</span>
          </button>
        `)}
      </section>
    `;
  }

  private renderWidgetDashboard() {
    return html`
      <section class="content mission-control mission-control--widgets">
        <header class="content__header mission-control__header">
          <div>
            <h1 class="content__title">Mission Control Logs</h1>
            <p class="mission-control__meta">SQLite task traces with events and documents. Use Edit layout to rearrange widgets.</p>
          </div>
          <div class="content__actions">
            <button class="btn btn--primary btn--sm" @click=${() => this.toggleLayoutEditor()}>
              ${this.layoutEditorOpen ? "Close editor" : "Edit layout"}
            </button>
          </div>
        </header>

        <div class="mission-control__pills">
          <span class="badge">DB: ${this.dbPath}</span>
          <span class="badge">Updated: ${this.generatedAt ? this.formatDate(this.generatedAt) : "-"}</span>
          <span class="badge">Auto refresh: 3s</span>
          <span class="badge">Tasks on page: ${this.tasks.length}</span>
        </div>

        ${this.layoutError ? html`<div class="callout callout--danger">${this.layoutError}</div>` : nothing}
        ${this.error ? html`<div class="callout callout--danger">${this.error}</div>` : nothing}

        ${this.layoutEditorOpen ? this.renderWidgetEditorToolbar() : nothing}
        ${this.layoutEditorOpen ? this.renderWidgetPalette() : nothing}

        <section
          class="dashboard-grid"
          @dragover=${(event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          @drop=${(event: DragEvent) => this.onCanvasDrop(event)}
        >
          ${this.widgetLayout.widgets.map((widget) => this.renderWidgetCard(widget))}
        </section>
      </section>
    `;
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
            ${this.renderRow("Input Tokens", this.formatTokenCount(task.inputTokens))}
            ${this.renderRow("Output Tokens", this.formatTokenCount(task.outputTokens))}
            ${this.renderRow("Cache Read Tokens", this.formatTokenCount(task.cacheReadTokens))}
            ${this.renderRow("Cache Write Tokens", this.formatTokenCount(task.cacheWriteTokens))}
            ${this.renderRow("Total Tokens", this.formatTokenCount(task.totalTokens))}
            ${this.renderRow("Estimated Cost (USD)", this.formatUsd(task.estimatedCostUsd))}
          </div>
          ${task.responseUsage ? this.renderRow("Response Usage", this.renderStructuredValue(task.responseUsage, `${baseKey}:response-usage`)) : nothing}
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

        ${this.renderSubagentSection(task, baseKey)}
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
      this.selectedSessionId = "all";
      return;
    }

    if (this.selectedSessionId === "all") return;

    const hasCurrent = groups.some((group) => group.sessionId === this.selectedSessionId);
    if (!this.selectedSessionId || !hasCurrent) {
      this.selectedSessionId = "all";
    }
  }

  private getSessionGroupedTasks() {
    const all = this.getSortedTasks();
    if (this.selectedSessionId === "all") return all;
    return all.filter((task) => (task.sessionId || "") === this.selectedSessionId);
  }

  private renderSessionTabs() {
    const groups = this.getSessionGroups();
    if (!groups.length) return html`
      <section class="card" style="padding: 10px 12px;">
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          <span style="font-weight: 500; color: var(--text-secondary, #666);">Sessions:</span>
          <button
            class="btn btn--ghost btn--sm mc-filter-preset--active"
            @click=${() => { this.selectedSessionId = "all"; }}
          >
            All
          </button>
        </div>
      </section>
    `;

    return html`
      <section class="card" style="padding: 10px 12px;">
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          <span style="font-weight: 500; color: var(--text-secondary, #666);">Sessions:</span>
          <button
            class="btn btn--ghost btn--sm ${this.selectedSessionId === "all" ? "mc-filter-preset--active" : ""}"
            @click=${() => { this.selectedSessionId = "all"; }}
          >
            All
          </button>
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
    return this.renderWidgetDashboard();
  }
}
