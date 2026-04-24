export type DashboardPage = "mission-control" | "cron-jobs";

export type WidgetSize = "small" | "medium" | "large";

export interface DashboardWidgetLayout {
  id: string;
  type: string;
  size: WidgetSize;
  row: number;
  col: number;
}

export type DashboardWidgetDraft = Omit<DashboardWidgetLayout, "row" | "col"> & Partial<Pick<DashboardWidgetLayout, "row" | "col">>;

export interface DashboardLayoutFile {
  version: 1;
  widgets: DashboardWidgetLayout[];
}

export interface DashboardWidgetDefinition {
  type: string;
  title: string;
  description: string;
  defaultSize: WidgetSize;
  allowedSizes: WidgetSize[];
}

const GRID_COLUMNS = 3;

function getWidgetSpan(size: WidgetSize) {
  if (size === "large") return 3;
  if (size === "medium") return 2;
  return 1;
}

function canPlace(occupied: Set<string>, row: number, col: number, span: number) {
  for (let offset = 0; offset < span; offset += 1) {
    if (occupied.has(`${row}:${col + offset}`)) return false;
  }
  return true;
}

function markPlaced(occupied: Set<string>, row: number, col: number, span: number) {
  for (let offset = 0; offset < span; offset += 1) {
    occupied.add(`${row}:${col + offset}`);
  }
}

function normalizeWidgets(widgets: DashboardWidgetDraft[]): DashboardWidgetLayout[] {
  const occupied = new Set<string>();

  return widgets.map((widget) => {
    const span = Math.max(1, Math.min(GRID_COLUMNS, getWidgetSpan(widget.size)));
    let row = typeof widget.row === "number" && Number.isFinite(widget.row) && widget.row >= 1
      ? Math.floor(widget.row)
      : 1;
    let col = typeof widget.col === "number" && Number.isFinite(widget.col) && widget.col >= 1
      ? Math.floor(widget.col)
      : 1;

    const maxStartCol = GRID_COLUMNS - span + 1;
    if (col > maxStartCol) col = maxStartCol;

    if (!canPlace(occupied, row, col, span)) {
      row = 1;
      col = 1;
      while (true) {
        let placed = false;
        for (let candidateCol = 1; candidateCol <= maxStartCol; candidateCol += 1) {
          if (!canPlace(occupied, row, candidateCol, span)) continue;
          col = candidateCol;
          placed = true;
          break;
        }
        if (placed) break;
        row += 1;
      }
    }

    markPlaced(occupied, row, col, span);
    return { ...widget, row, col };
  });
}

function getLayoutStorageKey(page: DashboardPage) {
  return `openclaw:dashboard-layout:${page}`;
}

function readLayoutFromStorage(page: DashboardPage) {
  if (typeof window === "undefined" || !window.localStorage) return null;

  try {
    const raw = window.localStorage.getItem(getLayoutStorageKey(page));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isDashboardLayoutFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLayoutToStorage(page: DashboardPage, layout: DashboardLayoutFile) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(getLayoutStorageKey(page), JSON.stringify(layout));
  } catch {
    // Ignore quota/security errors and continue with file-based persistence.
  }
}

function deleteLayoutFromStorage(page: DashboardPage) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(getLayoutStorageKey(page));
  } catch {
    // Ignore storage deletion errors.
  }
}

export function buildLayoutUrl(page: DashboardPage) {
  const baseHref = typeof document !== "undefined" ? document.baseURI : "/chatui/";
  return new URL(`src/layouts/${page}.layout.json`, baseHref).toString();
}

export function createWidgetId(type: string) {
  return `${type}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

export function cloneLayout(layout: DashboardLayoutFile): DashboardLayoutFile {
  return createLayout(layout.widgets);
}

export function createLayout(widgets: DashboardWidgetDraft[]): DashboardLayoutFile {
  return {
    version: 1,
    widgets: normalizeWidgets(widgets.map((widget) => ({ ...widget }))),
  };
}

export function isDashboardLayoutFile(value: unknown): value is DashboardLayoutFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.widgets)) return false;

  return record.widgets.every((widget) => {
    if (typeof widget !== "object" || widget === null || Array.isArray(widget)) return false;
    const widgetRecord = widget as Record<string, unknown>;
    const hasValidRow = widgetRecord.row === undefined
      || (typeof widgetRecord.row === "number" && Number.isFinite(widgetRecord.row) && widgetRecord.row >= 1);
    const hasValidCol = widgetRecord.col === undefined
      || (typeof widgetRecord.col === "number" && Number.isFinite(widgetRecord.col) && widgetRecord.col >= 1);
    return typeof widgetRecord.id === "string"
      && typeof widgetRecord.type === "string"
      && hasValidRow
      && hasValidCol
      && (widgetRecord.size === "small" || widgetRecord.size === "medium" || widgetRecord.size === "large");
  });
}

export async function loadDashboardLayout(page: DashboardPage) {
  const stored = readLayoutFromStorage(page);
  if (stored) return stored;

  try {
    const response = await fetch(buildLayoutUrl(page), { cache: "no-store" });
    if (!response.ok) return null;

    const payload = await response.json();
    if (!isDashboardLayoutFile(payload)) return null;
    writeLayoutToStorage(page, payload);
    return payload;
  } catch {
    return null;
  }
}

export async function saveDashboardLayout(page: DashboardPage, layout: DashboardLayoutFile) {
  writeLayoutToStorage(page, layout);

  try {
    const response = await fetch(buildLayoutUrl(page), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(layout),
    });

    if (!response.ok) {
      throw new Error(`Failed to save layout (${response.status})`);
    }
  } catch {
    // Local storage already persisted the layout. Ignore file persistence failures.
  }
}

export async function deleteDashboardLayout(page: DashboardPage) {
  deleteLayoutFromStorage(page);

  try {
    const response = await fetch(buildLayoutUrl(page), { method: "DELETE" });
    if (!response.ok && response.status !== 204 && response.status !== 404) {
      throw new Error(`Failed to delete layout (${response.status})`);
    }
  } catch {
    // Ignore deletion failures for file persistence; local state is already reset.
  }
}