export type DashboardPage = "mission-control" | "cron-jobs";

export type WidgetSize = "small" | "medium" | "large";

export interface DashboardWidgetLayout {
  id: string;
  type: string;
  size: WidgetSize;
}

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

export function buildLayoutUrl(page: DashboardPage) {
  return new URL(`src/layouts/${page}.layout.json`, import.meta.env.BASE_URL).toString();
}

export function createWidgetId(type: string) {
  return `${type}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

export function cloneLayout(layout: DashboardLayoutFile): DashboardLayoutFile {
  return {
    version: layout.version,
    widgets: layout.widgets.map((widget) => ({ ...widget })),
  };
}

export function createLayout(widgets: DashboardWidgetLayout[]): DashboardLayoutFile {
  return {
    version: 1,
    widgets: widgets.map((widget) => ({ ...widget })),
  };
}

export function isDashboardLayoutFile(value: unknown): value is DashboardLayoutFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.widgets)) return false;

  return record.widgets.every((widget) => {
    if (typeof widget !== "object" || widget === null || Array.isArray(widget)) return false;
    const widgetRecord = widget as Record<string, unknown>;
    return typeof widgetRecord.id === "string"
      && typeof widgetRecord.type === "string"
      && (widgetRecord.size === "small" || widgetRecord.size === "medium" || widgetRecord.size === "large");
  });
}

export async function loadDashboardLayout(page: DashboardPage) {
  try {
    const response = await fetch(buildLayoutUrl(page), { cache: "no-store" });
    if (!response.ok) return null;

    const payload = await response.json();
    return isDashboardLayoutFile(payload) ? payload : null;
  } catch {
    return null;
  }
}

export async function saveDashboardLayout(page: DashboardPage, layout: DashboardLayoutFile) {
  const response = await fetch(buildLayoutUrl(page), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(layout),
  });

  if (!response.ok) {
    throw new Error(`Failed to save layout (${response.status})`);
  }
}

export async function deleteDashboardLayout(page: DashboardPage) {
  const response = await fetch(buildLayoutUrl(page), { method: "DELETE" });
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    throw new Error(`Failed to delete layout (${response.status})`);
  }
}