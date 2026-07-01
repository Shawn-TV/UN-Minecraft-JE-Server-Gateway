const APP_TITLE = "UN 服务器控制台";
const STORAGE_KEY = "unmc.dashboard.layout.v1";
const VIEW_STORAGE_KEY = "unmc.dashboard.view.v1";
const RESTART_STORAGE_KEY = "unmc.restart.pending.v1";
const LAYOUT_VERSION = 17;
const ACTIVE_REFRESH_MS = 10000;
const HIDDEN_REFRESH_MS = 60000;
const BACKUP_REFRESH_MS = 1400;
const BACKUP_NOTICE_MS = 5200;
const STATUS_TIMEOUT_MS = 16000;
const ACTION_TIMEOUT_MS = 120000;
const LOG_BOTTOM_THRESHOLD = 34;
const LOG_TOP_THRESHOLD = 28;
const LOG_CHUNK_LINES = 1000;

if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

const state = {
  busy: false,
  editing: false,
  interaction: null,
  logTarget: "server",
  logCursor: { server: "", tunnel: "" },
  logHasMore: { server: false, tunnel: false },
  logStartDate: { server: "", tunnel: "" },
  logLoadingOlder: false,
  logHistoryError: "",
  latencyHistory: [],
  latestData: null,
  latestLogs: "",
  activeView: "overview",
  consoleCommand: "",
  consoleComposing: false,
  pendingConsoleRender: false,
  logScroll: {
    server: { pinned: true, top: 0 },
    tunnel: { pinned: true, top: 0 },
  },
  restartPending: localStorage.getItem(RESTART_STORAGE_KEY) === "true",
  backupWasRunning: false,
  backupNoticeUntil: 0,
  backupStartingUntil: 0,
  feedback: {
    kind: "idle",
    title: "命令回执",
    meta: "待命",
    body: "没有新的回执",
  },
  confirmation: null,
  layout: [],
};

let masonryFrame = 0;
let masonryResizeObserver = null;
let silentRenderTimer = 0;
let initialScrollTimer = 0;
let pendingRefreshAnchor = null;
let pendingRefreshTop = null;
let scrollSpyFrame = 0;
let refreshVisualTimer = 0;
let initialScrollDeadline = Date.now() + 1800;
let initialDataRendered = false;
let backupPollTimer = 0;
let backupNoticeTimer = 0;
let logOlderLoadTimer = 0;
let restoringLogScroll = false;

const endpointMeta = {
  "127.0.0.1": {
    name: "本机",
    color: "#009f8f",
    route: "面板 → Mac mini 本机 → JE",
    note: "本机查询只看 JE 自身响应，通常应该接近 1ms。",
  },
  "playje.unmcserver.com": {
    name: "北京入口",
    color: "#0a66ff",
    route: "Mac mini → 北京公网入口 → SSH 反向隧道 → JE",
    note: "这是 Minecraft status 查询，用来看北京入口和反向隧道是否通畅。",
  },
  "la.playje.unmcserver.com": {
    name: "洛杉矶入口",
    color: "#e2552d",
    route: "Mac mini → 洛杉矶入口 → 北京入口 → SSH 反向隧道 → JE",
    note: "探测内容是 Minecraft 状态握手；数值是请求发出到状态响应返回的耗时。",
  },
};

const SIZE_ORDER = ["compact", "medium", "wide", "tall", "large", "full"];
const SIZE_LABELS = {
  compact: "紧凑",
  medium: "标准",
  wide: "加宽",
  tall: "纵向",
  large: "大型",
  full: "全幅",
};

const WIDGETS = {
  status: { title: "核心状态", category: "运行", defaultSize: "wide", render: renderStatusWidget },
  entries: { title: "入口延迟", category: "网络", defaultSize: "wide", render: renderEntriesWidget },
  players: { title: "在线玩家", category: "玩家", defaultSize: "wide", render: renderPlayersWidget },
  totals: { title: "世界统计", category: "世界", defaultSize: "wide", render: renderTotalsWidget },
  leaderboards: { title: "榜单", category: "玩家", defaultSize: "large", render: renderLeaderboardsWidget },
  achievements: { title: "成就墙", category: "成就", defaultSize: "wide", render: renderAchievementsWidget },
  resources: { title: "资源监控", category: "运行", defaultSize: "wide", render: renderResourcesWidget },
  world: { title: "存档与文件", category: "世界", defaultSize: "medium", render: renderWorldWidget },
  plugins: { title: "插件", category: "配置", defaultSize: "wide", render: renderPluginsWidget },
  config: { title: "图形化配置", category: "配置", defaultSize: "large", render: renderConfigWidget },
  items: { title: "物品热点", category: "世界", defaultSize: "medium", render: renderItemsWidget },
  chat: { title: "最近聊天", category: "玩家", defaultSize: "medium", render: renderChatWidget },
  routes: { title: "路径说明", category: "网络", defaultSize: "wide", render: renderRoutesWidget },
  settings: { title: "服务器配置", category: "运行", defaultSize: "medium", render: renderSettingsWidget },
  sessions: { title: "进程与会话", category: "运行", defaultSize: "medium", render: renderSessionsWidget },
  logs: { title: "日志", category: "控制", defaultSize: "full", render: renderLogsWidget },
  controls: { title: "控制台", category: "控制", defaultSize: "full", render: renderControlsWidget },
};

const DASHBOARD_VIEWS = {
  overview: {
    label: "运行状态",
    detail: "可进服 · 延迟",
    types: ["status", "entries", "resources"],
  },
  players: {
    label: "玩家数据",
    detail: "在线 · 统计",
    types: ["players", "totals", "achievements", "leaderboards", "items", "chat"],
  },
  control: {
    label: "终端命令",
    detail: "日志 · 指令",
    types: ["logs", "controls", "sessions", "routes"],
  },
  config: {
    label: "设置与备份",
    detail: "插件 · 自动备份",
    types: ["settings", "plugins", "config", "world"],
  },
};

const VIEW_ORDER = Object.keys(DASHBOARD_VIEWS);

const CONFIG_FIELDS = [
  { key: "motd", label: "MOTD", type: "text" },
  { key: "difficulty", label: "难度", type: "select", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "gamemode", label: "默认模式", type: "select", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "max-players", label: "最大人数", type: "number", min: 1, max: 200 },
  { key: "view-distance", label: "视距", type: "number", min: 2, max: 32 },
  { key: "simulation-distance", label: "模拟距离", type: "number", min: 2, max: 32 },
  { key: "spawn-protection", label: "出生点保护", type: "number", min: 0, max: 64 },
  { key: "player-idle-timeout", label: "挂机踢出", type: "number", min: 0, max: 10080 },
  { key: "allow-flight", label: "允许飞行", type: "bool" },
  { key: "force-gamemode", label: "强制模式", type: "bool" },
  { key: "hardcore", label: "极限模式", type: "bool" },
  { key: "white-list", label: "白名单", type: "bool" },
  { key: "enforce-whitelist", label: "强制白名单", type: "bool" },
  { key: "online-mode", label: "正版验证", type: "bool" },
  { key: "enable-status", label: "允许状态查询", type: "bool" },
  { key: "hide-online-players", label: "隐藏在线玩家", type: "bool" },
  { key: "pvp", label: "PVP", type: "bool" },
];

const ACTION_CONFIRMATIONS = {
  start_all: {
    title: "启动全部",
    body: "会启动 JE 服务器、反向隧道和面板相关进程。一般只在整套服务没有运行时使用。",
    confirm: "启动全部",
  },
  restart_server: {
    title: "重启 JE",
    body: "会让在线玩家短暂掉线，并重新读取 server.properties 和插件状态。",
    confirm: "确认重启 JE",
    danger: true,
  },
  restart_tunnel: {
    title: "重启隧道",
    body: "会短暂断开公网入口连接。正在进服或在线的玩家可能会被断开。",
    confirm: "确认重启隧道",
    danger: true,
  },
  stop_server: {
    title: "停止 JE",
    body: "会关闭 Java 生存服，玩家将无法进入服务器。需要再次启动后才会恢复。",
    confirm: "确认停止 JE",
    danger: true,
  },
};

const GRID_GAP = 16;
const GRID_ROW = 132;
const STAGE_GAP = GRID_GAP;
const FLOW_GAP = 16;

const SIZE_PRESETS = {
  compact: { cols: 2, rows: 2 },
  medium: { cols: 2, rows: 2 },
  wide: { cols: 3, rows: 2 },
  tall: { cols: 2, rows: 3 },
  large: { cols: 4, rows: 3 },
  full: { cols: 6, rows: 4 },
};

const WIDGET_SIZE_PRESETS = {
  status: {
    compact: { cols: 2, rows: 2 },
    medium: { cols: 2, rows: 2 },
    tall: { cols: 2, rows: 3 },
    wide: { cols: 3, rows: 2 },
    large: { cols: 4, rows: 2 },
  },
  entries: {
    medium: { cols: 3, rows: 2 },
    wide: { cols: 3, rows: 3 },
    large: { cols: 4, rows: 3 },
    full: { cols: 6, rows: 3 },
  },
  players: {
    medium: { cols: 2, rows: 2 },
    wide: { cols: 3, rows: 2 },
    tall: { cols: 2, rows: 3 },
    large: { cols: 4, rows: 3 },
  },
  totals: {
    wide: { cols: 3, rows: 2 },
    large: { cols: 4, rows: 2 },
    full: { cols: 6, rows: 2 },
  },
  achievements: {
    wide: { cols: 3, rows: 2 },
    large: { cols: 4, rows: 2 },
    full: { cols: 6, rows: 2 },
  },
  resources: {
    medium: { cols: 2, rows: 2 },
    wide: { cols: 2, rows: 2 },
    large: { cols: 3, rows: 2 },
  },
  leaderboards: {
    large: { cols: 5, rows: 4 },
    full: { cols: 8, rows: 4 },
  },
  world: {
    medium: { cols: 2, rows: 2 },
    wide: { cols: 3, rows: 2 },
    large: { cols: 4, rows: 2 },
  },
  plugins: {
    medium: { cols: 2, rows: 2 },
    wide: { cols: 3, rows: 2 },
    large: { cols: 4, rows: 3 },
  },
  config: {
    large: { cols: 4, rows: 5 },
    full: { cols: 8, rows: 5 },
  },
  routes: {
    wide: { cols: 3, rows: 3 },
    large: { cols: 4, rows: 3 },
    full: { cols: 6, rows: 3 },
  },
  logs: {
    large: { cols: 5, rows: 4 },
    full: { cols: 8, rows: 4 },
  },
  controls: {
    wide: { cols: 3, rows: 2 },
    large: { cols: 4, rows: 2 },
    full: { cols: 8, rows: 2 },
  },
  items: {
    medium: { cols: 2, rows: 2 },
    wide: { cols: 3, rows: 2 },
  },
};

const DEFAULT_GRIDS = {
  status: { col: 0, row: 0 },
  entries: { col: 3, row: 0 },
  players: { col: 0, row: 2 },
  resources: { col: 3, row: 3 },
  items: { col: 0, row: 4 },
  totals: { col: 2, row: 5 },
  achievements: { col: 0, row: 7 },
  world: { col: 3, row: 7 },
  plugins: { col: 0, row: 9 },
  settings: { col: 3, row: 9 },
  sessions: { col: 0, row: 11 },
  chat: { col: 2, row: 11 },
  routes: { col: 0, row: 13 },
  leaderboards: { col: 0, row: 16 },
  config: { col: 0, row: 20 },
  logs: { col: 0, row: 25 },
  controls: { col: 0, row: 29 },
};

const WIDE_DEFAULT_GRIDS = {
  status: { col: 0, row: 0 },
  entries: { col: 3, row: 0 },
  resources: { col: 6, row: 0 },
  players: { col: 0, row: 2 },
  items: { col: 6, row: 2 },
  totals: { col: 3, row: 3 },
  achievements: { col: 0, row: 4 },
  world: { col: 3, row: 5 },
  settings: { col: 6, row: 5 },
  plugins: { col: 0, row: 6 },
  sessions: { col: 3, row: 7 },
  chat: { col: 5, row: 7 },
  routes: { col: 0, row: 9 },
  leaderboards: { col: 0, row: 12 },
  config: { col: 0, row: 16 },
  logs: { col: 0, row: 21 },
  controls: { col: 0, row: 25 },
};

const NARROW_DEFAULT_GRIDS = {
  status: { col: 0, row: 0 },
  entries: { col: 0, row: 2 },
  players: { col: 0, row: 5 },
  resources: { col: 0, row: 7 },
  items: { col: 2, row: 7 },
  totals: { col: 0, row: 9 },
  achievements: { col: 0, row: 11 },
  world: { col: 0, row: 13 },
  plugins: { col: 0, row: 15 },
  settings: { col: 2, row: 15 },
  sessions: { col: 0, row: 17 },
  chat: { col: 2, row: 17 },
  routes: { col: 0, row: 19 },
  leaderboards: { col: 0, row: 22 },
  config: { col: 0, row: 26 },
  logs: { col: 0, row: 31 },
  controls: { col: 0, row: 35 },
};

const $ = (selector) => document.querySelector(selector);

function item(type, size = WIDGETS[type]?.defaultSize || "medium") {
  const base = defaultGridForType(type);
  const span = sizeGrid(type, size);
  const grid = clampGrid({ ...base, colSpan: span.cols, rowSpan: span.rows });
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    size,
    grid,
    rect: rectFromGrid(grid),
    z: 1,
    prefs: {},
  };
}

const DEFAULT_LAYOUT_TYPES = [
  ["status", "wide"],
  ["entries", "wide"],
  ["players", "wide"],
  ["totals", "wide"],
  ["achievements", "wide"],
  ["resources", "wide"],
  ["world", "wide"],
  ["plugins", "wide"],
  ["items", "medium"],
  ["routes", "large"],
  ["settings", "medium"],
  ["sessions", "medium"],
  ["chat", "medium"],
  ["leaderboards", "full"],
  ["config", "full"],
  ["logs", "full"],
  ["controls", "full"],
];

const DEFAULT_TYPE_ORDER = new Map(DEFAULT_LAYOUT_TYPES.map(([type], index) => [type, index]));

const VIEW_ORDER_BY_COLUMNS = {
  8: ["status", "entries", "players", "totals", "resources", "achievements", "world", "items", "plugins", "routes", "settings", "sessions", "chat", "leaderboards", "config", "logs", "controls"],
  6: ["status", "entries", "players", "resources", "items", "totals", "achievements", "world", "plugins", "settings", "sessions", "chat", "routes", "leaderboards", "config", "logs", "controls"],
  4: ["status", "entries", "players", "resources", "totals", "achievements", "world", "items", "settings", "sessions", "chat", "plugins", "routes", "leaderboards", "config", "logs", "controls"],
  1: DEFAULT_LAYOUT_TYPES.map(([type]) => type),
};

const DISPLAY_VIEW_ORDER_BY_COLUMNS = {
  overview: {
    4: ["status", "entries", "resources"],
    3: ["status", "resources", "entries"],
    2: ["status", "entries", "resources"],
    1: ["status", "entries", "resources"],
  },
  players: {
    4: ["players", "totals", "achievements", "leaderboards", "items", "chat"],
    3: ["players", "chat", "totals", "items", "achievements", "leaderboards"],
    2: ["players", "totals", "achievements", "leaderboards", "items", "chat"],
    1: ["players", "totals", "achievements", "leaderboards", "items", "chat"],
  },
  control: {
    4: ["logs", "controls", "sessions", "routes"],
    3: ["logs", "controls", "sessions", "routes"],
    2: ["logs", "controls", "sessions", "routes"],
    1: ["logs", "controls", "sessions", "routes"],
  },
  config: {
    4: ["settings", "world", "plugins", "config"],
    3: ["settings", "plugins", "world", "config"],
    2: ["settings", "plugins", "config", "world"],
    1: ["settings", "plugins", "config", "world"],
  },
};

function activeViewId() {
  return DASHBOARD_VIEWS[state.activeView] ? state.activeView : "overview";
}

function activeView() {
  return DASHBOARD_VIEWS[activeViewId()];
}

function activeViewTypes() {
  return activeView().types;
}

function displayOrderForView(viewId, columns) {
  const viewOrders = DISPLAY_VIEW_ORDER_BY_COLUMNS[viewId] || {};
  return viewOrders[columns] || viewOrders[columns >= 4 ? 4 : columns >= 3 ? 3 : columns >= 2 ? 2 : 1] || activeViewTypes();
}

function layoutForActiveView() {
  const allowed = new Set(activeViewTypes());
  return state.layout.filter((entry) => allowed.has(entry.type));
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function logDateDivider(dateText) {
  return `──────── ${dateText} ────────`;
}

function isLogDateDivider(line) {
  return /^──────── \d{4}-\d{2}-\d{2} ────────$/.test(line);
}

function renderLogText(text) {
  return String(text || "")
    .split("\n")
    .map((line) => isLogDateDivider(line)
      ? `<span class="log-date-divider">${escapeHTML(line)}</span>`
      : escapeHTML(line))
    .join("\n");
}

function stripLeadingLogDateDivider(text, dateText) {
  if (!dateText) return text;
  const lines = String(text || "").split("\n");
  return lines[0] === logDateDivider(dateText) ? lines.slice(1).join("\n") : text;
}

function formatPercent(value) {
  if (value === undefined || value === null) return "--";
  return `${Number(value).toFixed(1)}%`;
}

function formatMemoryMB(value) {
  const number = Number(value || 0);
  if (!number) return "--";
  if (number >= 1024) return `${(number / 1024).toFixed(number >= 10_240 ? 0 : 1)}GB`;
  return `${Math.round(number)}MB`;
}

function javaMemoryPercent(data, java) {
  const direct = Number(java.mem_percent);
  if (Number.isFinite(direct)) return direct;
  const total = Number(data.stats?.system?.memory_mb || 0);
  const rss = Number(java.rss_mb || 0);
  return total && rss ? (rss / total) * 100 : 0;
}

function javaMemoryDetail(data, java) {
  const total = Number(data.stats?.system?.memory_mb || 0);
  const percent = javaMemoryPercent(data, java);
  if (total && Number.isFinite(percent)) return `全机 ${formatMemoryMB(total)} · ${formatPercent(percent)}`;
  if (Number.isFinite(percent)) return `${formatPercent(percent)} 全机占用`;
  return "Java RSS";
}

function javaMemoryMeterValue(data, java) {
  if (!java.rss_mb) return "--";
  return `${formatMemoryMB(java.rss_mb)} / ${formatPercent(javaMemoryPercent(data, java))}`;
}

function javaMemoryMeterSubtext(data) {
  const total = Number(data.stats?.system?.memory_mb || 0);
  return total ? `全机 ${formatMemoryMB(total)}` : "";
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 10_000) return `${Math.round(number / 1000)}K`;
  return String(number);
}

function formatPlayerMinutes(value) {
  const minutes = Number(value || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return "少于1分钟";
  if (minutes < 60) return `${Math.round(minutes)}分钟`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}小时`;
}

function formatPlayerHours(value) {
  const hours = Number(value || 0);
  if (!Number.isFinite(hours) || hours <= 0) return "--";
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function formatEtime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "--";

  let days = 0;
  let timePart = raw;
  if (raw.includes("-")) {
    const pieces = raw.split("-");
    days = Number(pieces[0]);
    timePart = pieces.slice(1).join("-");
  }

  const parts = timePart.split(":").map((part) => Number(part));
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else if (parts.length === 1) {
    [seconds] = parts;
  } else {
    return raw;
  }

  if (![days, hours, minutes, seconds].every(Number.isFinite)) return raw;
  const chunks = [];
  if (days) chunks.push(`${days}天`);
  if (hours || chunks.length) chunks.push(`${hours}小时`);
  if (minutes || chunks.length) chunks.push(`${minutes}分钟`);
  chunks.push(`${seconds}秒`);
  return chunks.join("");
}

function last24hMinutes(activity) {
  return (activity?.last_24h?.players || []).reduce((total, player) => total + Number(player.session_minutes_24h || 0), 0);
}

function fakeNameSet(data) {
  return new Set((data.stats?.players?.fake?.names || []).map((name) => String(name).toLowerCase()));
}

function feedbackTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function gridColumns(width = stageWidth()) {
  if (width >= 1540) return 8;
  if (width >= 1120) return 6;
  if (width >= 760) return 4;
  return 1;
}

function flowColumns(width = stageWidth()) {
  if (width >= 1200) return 4;
  if (width >= 780) return 3;
  if (width >= 560) return 2;
  return 1;
}

function gridMetrics(width = stageWidth()) {
  const columns = gridColumns(width);
  const colWidth = (width - GRID_GAP * (columns - 1)) / columns;
  return {
    columns,
    colWidth,
    rowHeight: GRID_ROW,
    gap: GRID_GAP,
    stepX: colWidth + GRID_GAP,
    stepY: GRID_ROW + GRID_GAP,
  };
}

function sizeOptions(type) {
  const overrides = WIDGET_SIZE_PRESETS[type] || {};
  return SIZE_ORDER.filter((size) => overrides[size] || SIZE_PRESETS[size]);
}

function sizeGrid(type, size) {
  const fallback = WIDGETS[type]?.defaultSize || "medium";
  const preset = WIDGET_SIZE_PRESETS[type]?.[size] || SIZE_PRESETS[size] || WIDGET_SIZE_PRESETS[type]?.[fallback] || SIZE_PRESETS.medium;
  return { cols: preset.cols, rows: preset.rows };
}

function defaultGridForType(type) {
  const columns = gridColumns();
  const grids = columns >= 8 ? WIDE_DEFAULT_GRIDS : columns <= 4 ? NARROW_DEFAULT_GRIDS : DEFAULT_GRIDS;
  const span = sizeGrid(type, WIDGETS[type]?.defaultSize || "medium");
  return {
    col: grids[type]?.col || 0,
    row: grids[type]?.row || 0,
    colSpan: span.cols,
    rowSpan: span.rows,
  };
}

function nearestSizeName(type, colSpan, rowSpan) {
  const options = sizeOptions(type);
  let best = options[0] || "medium";
  let bestScore = Infinity;
  options.forEach((size) => {
    const span = sizeGrid(type, size);
    const score = Math.abs(span.cols - colSpan) * 1.3 + Math.abs(span.rows - rowSpan);
    if (score < bestScore) {
      best = size;
      bestScore = score;
    }
  });
  return best;
}

function clampGrid(grid, width = stageWidth()) {
  const metrics = gridMetrics(width);
  const colSpan = Math.min(Math.max(1, Math.round(grid.colSpan || 1)), metrics.columns);
  const rowSpan = Math.max(1, Math.round(grid.rowSpan || 1));
  const col = Math.min(Math.max(0, Math.round(grid.col || 0)), Math.max(0, metrics.columns - colSpan));
  const row = Math.max(0, Math.round(grid.row || 0));
  return { col, row, colSpan, rowSpan };
}

function rectFromGrid(grid, width = stageWidth()) {
  const metrics = gridMetrics(width);
  const clean = clampGrid(grid, width);
  return {
    x: clean.col * metrics.stepX,
    y: clean.row * metrics.stepY,
    w: clean.colSpan * metrics.colWidth + (clean.colSpan - 1) * metrics.gap,
    h: clean.rowSpan * metrics.rowHeight + (clean.rowSpan - 1) * metrics.gap,
  };
}

function gridFromRect(rect, type, width = stageWidth()) {
  const metrics = gridMetrics(width);
  const desiredCols = Math.max(1, Math.round((Number(rect.w || 0) + metrics.gap) / metrics.stepX));
  const desiredRows = Math.max(1, Math.round((Number(rect.h || 0) + metrics.gap) / metrics.stepY));
  const size = nearestSizeName(type, desiredCols, desiredRows);
  const span = sizeGrid(type, size);
  return clampGrid({
    col: Math.round(Number(rect.x || 0) / metrics.stepX),
    row: Math.round(Number(rect.y || 0) / metrics.stepY),
    colSpan: span.cols,
    rowSpan: span.rows,
  }, width);
}

function defaultLayout() {
  return DEFAULT_LAYOUT_TYPES.map(([type, size]) => normalizeEntry(item(type, size)));
}

function normalizeEntry(entry, index = 0) {
  const type = entry.type;
  const fallback = item(type, entry.size || WIDGETS[type]?.defaultSize || "medium");
  const options = sizeOptions(type);
  const size = options.includes(entry.size) ? entry.size : fallback.size;
  const span = sizeGrid(type, size);
  const roughGrid = entry.grid
    ? entry.grid
    : entry.rect
      ? gridFromRect(entry.rect, type)
      : fallback.grid;
  const grid = clampGrid({
    col: Number.isFinite(Number(roughGrid.col)) ? Number(roughGrid.col) : fallback.grid.col + (index % 2),
    row: Number.isFinite(Number(roughGrid.row)) ? Number(roughGrid.row) : fallback.grid.row + Math.floor(index / 2),
    colSpan: span.cols,
    rowSpan: span.rows,
  });
  return {
    id: entry.id || fallback.id,
    type,
    size,
    grid,
    rect: rectFromGrid(grid),
    z: Number.isFinite(Number(entry.z)) ? Number(entry.z) : index + 1,
    prefs: entry.prefs && typeof entry.prefs === "object" ? entry.prefs : {},
  };
}

function clampRect(rect, stageWidth) {
  const maxWidth = Math.max(240, stageWidth);
  const width = Math.min(Math.max(240, rect.w), maxWidth);
  const height = Math.max(160, rect.h);
  const x = Math.min(Math.max(0, rect.x), Math.max(0, stageWidth - width));
  const y = Math.max(0, rect.y);
  return { x, y, w: width, h: height };
}

function stageWidth() {
  const dashboardWidth = $("#dashboard")?.clientWidth;
  if (dashboardWidth) return dashboardWidth;
  if (typeof window !== "undefined" && window.innerWidth) {
    const gutter = window.innerWidth <= 720
      ? 22
      : Math.max(28, Math.min(64, window.innerWidth * 0.04));
    return Math.max(320, Math.min(1740, window.innerWidth - gutter));
  }
  return 1380;
}

function fitLayoutToStage(width = stageWidth(), entries = layoutForActiveView()) {
  const occupied = [];
  const metrics = gridMetrics(width);
  entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => compareLayoutEntries(left.entry, right.entry, left.index, right.index))
    .forEach(({ entry }) => {
      const grid = clampGrid(entry.grid || gridFromRect(entry.rect || {}, entry.type, width), width);
      let col = grid.col;
      let row = grid.row;
      if (!canPlace(occupied, col, row, grid.colSpan, grid.rowSpan, metrics.columns)) {
        const spot = firstOpenGrid(occupied, grid.colSpan, grid.rowSpan, metrics.columns);
        col = spot.col;
        row = spot.row;
      }
      entry.grid = { ...grid, col, row };
      markPlace(occupied, col, row, grid.colSpan, grid.rowSpan);
      entry.rect = rectFromGrid(entry.grid, width);
    });
}

function layoutSortValue(entry, index) {
  const grid = entry.grid || {};
  return [
    Number.isFinite(Number(grid.row)) ? Number(grid.row) : 999,
    Number.isFinite(Number(grid.col)) ? Number(grid.col) : 999,
    DEFAULT_TYPE_ORDER.get(entry.type) ?? 999,
    index,
  ];
}

function compareLayoutEntries(left, right, leftIndex, rightIndex) {
  const leftScore = layoutSortValue(left, leftIndex);
  const rightScore = layoutSortValue(right, rightIndex);
  for (let i = 0; i < leftScore.length; i += 1) {
    if (leftScore[i] !== rightScore[i]) return leftScore[i] - rightScore[i];
  }
  return 0;
}

function canPlace(occupied, col, row, colSpan, rowSpan, columns) {
  if (col + colSpan > columns) return false;
  for (let y = row; y < row + rowSpan; y += 1) {
    for (let x = col; x < col + colSpan; x += 1) {
      if (occupied[y]?.[x]) return false;
    }
  }
  return true;
}

function markPlace(occupied, col, row, colSpan, rowSpan) {
  for (let y = row; y < row + rowSpan; y += 1) {
    occupied[y] = occupied[y] || [];
    for (let x = col; x < col + colSpan; x += 1) occupied[y][x] = true;
  }
}

function firstOpenGrid(occupied, colSpan, rowSpan, columns) {
  for (let row = 0; row < 500; row += 1) {
    for (let col = 0; col <= columns - colSpan; col += 1) {
      if (canPlace(occupied, col, row, colSpan, rowSpan, columns)) return { col, row };
    }
  }
  return { col: 0, row: occupied.length };
}

function compactLayoutForView(entries, width = stageWidth(), orderTypes = null) {
  const columns = gridColumns(width);
  const occupied = [];
  const viewOrder = new Map((orderTypes || VIEW_ORDER_BY_COLUMNS[columns] || VIEW_ORDER_BY_COLUMNS[1]).map((type, index) => [type, index]));
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftOrder = viewOrder.get(left.entry.type) ?? DEFAULT_TYPE_ORDER.get(left.entry.type) ?? 999;
      const rightOrder = viewOrder.get(right.entry.type) ?? DEFAULT_TYPE_ORDER.get(right.entry.type) ?? 999;
      return leftOrder === rightOrder ? left.index - right.index : leftOrder - rightOrder;
    })
    .map(({ entry }) => {
      const span = viewSpanForEntry(entry, columns);
      const colSpan = span.cols;
      const rowSpan = span.rows;
      const spot = firstOpenGrid(occupied, colSpan, rowSpan, columns);
      markPlace(occupied, spot.col, spot.row, colSpan, rowSpan);
      const grid = { col: spot.col, row: spot.row, colSpan, rowSpan };
      return { ...entry, grid, rect: rectFromGrid(grid, width) };
    });
}

function displaySpanForEntry(entry, columns, viewId = activeViewId()) {
  if (columns <= 1) return 1;
  const sizeSpan = {
    compact: 1,
    medium: 1,
    wide: 2,
    tall: 1,
    large: 2,
    full: columns,
  }[entry.size] || 1;
  const viewSpans = {
    overview: {
      status: columns >= 3 ? 2 : columns,
      entries: columns === 3 ? 3 : columns >= 4 ? 2 : columns,
      resources: columns >= 4 ? columns : columns >= 3 ? 1 : columns,
    },
    players: {
      players: Math.min(2, columns),
      totals: columns === 3 ? columns : columns >= 4 ? 2 : columns,
      achievements: columns === 3 ? 2 : columns >= 4 ? 2 : columns,
      leaderboards: columns,
      items: columns >= 4 ? 2 : 1,
      chat: columns >= 4 ? 2 : 1,
    },
    control: {
      logs: columns,
      controls: columns,
      sessions: columns >= 3 ? 1 : columns,
      routes: columns >= 4 ? 3 : columns >= 3 ? 2 : columns,
    },
    config: {
      settings: columns >= 4 ? 1 : columns,
      plugins: columns >= 4 ? 2 : columns,
      config: columns,
      world: columns >= 4 ? 1 : columns,
    },
  };
  const span = viewSpans[viewId]?.[entry.type] ?? sizeSpan;
  return Math.max(1, Math.min(columns, span));
}

function displayLayoutForView(entries, width = stageWidth(), orderTypes = displayOrderForView(activeViewId(), flowColumns(width))) {
  const columns = flowColumns(width);
  const viewOrder = new Map(orderTypes.map((type, index) => [type, index]));
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftOrder = viewOrder.get(left.entry.type) ?? DEFAULT_TYPE_ORDER.get(left.entry.type) ?? 999;
      const rightOrder = viewOrder.get(right.entry.type) ?? DEFAULT_TYPE_ORDER.get(right.entry.type) ?? 999;
      return leftOrder === rightOrder ? left.index - right.index : leftOrder - rightOrder;
    })
    .map(({ entry }, index) => ({
      ...entry,
      flowSpan: displaySpanForEntry(entry, columns),
      flowOrder: index,
    }));
}

function viewSpanForEntry(entry, columns) {
  const span = sizeGrid(entry.type, entry.size);
  let cols = Math.min(span.cols, columns);
  let rows = Math.max(1, span.rows);
  if (columns === 4 && cols === 3) cols = 4;
  if (columns === 6 && entry.type === "entries") rows = 2;
  if (columns === 6 && entry.type === "routes") cols = 6;
  return { cols, rows };
}

function stageHeight(entries = state.layout) {
  if (!entries.length) return 300;
  return Math.max(...entries.map((entry) => entry.rect.y + entry.rect.h), 300) + STAGE_GAP;
}

function widgetStyle(entry, editing = state.editing) {
  if (!editing) {
    const flowSpan = Math.max(1, Number(entry.flowSpan) || 1);
    const flowOrder = Math.max(0, Number(entry.flowOrder) || 0);
    return `--z:${entry.z || 1}; --flow-span:${flowSpan}; order:${flowOrder};`;
  }
  const rect = entry.rect;
  const grid = entry.grid || {};
  const col = (grid.col || 0) + 1;
  const row = (grid.row || 0) + 1;
  const colSpan = grid.colSpan || 1;
  const rowSpan = grid.rowSpan || 1;
  return `--x:${rect.x}px; --y:${rect.y}px; --w:${rect.w}px; --h:${rect.h}px; --z:${entry.z || 1}; --grid-col:${col}; --grid-row:${row}; --grid-colspan:${colSpan}; --grid-rowspan:${rowSpan}; grid-column:${col} / span ${colSpan}; grid-row:${row} / span ${rowSpan};`;
}

function nextWidgetZ() {
  return Math.max(1, ...state.layout.map((entry) => Number(entry.z) || 1)) + 1;
}

function getLayout() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    const legacy = Array.isArray(parsed);
    const savedLayout = legacy ? parsed : parsed.layout;
    const clean = (savedLayout || []).filter((entry) => WIDGETS[entry.type] && SIZE_ORDER.includes(entry.size));
    if (clean.length) {
      if (!legacy && parsed.version === LAYOUT_VERSION) return clean.map(normalizeEntry);
    }
  } catch (_error) {
    // Fall through to defaults.
  }
  return defaultLayout();
}

function saveLayout() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: LAYOUT_VERSION, layout: state.layout }));
}

function setRestartPending(value) {
  state.restartPending = Boolean(value);
  localStorage.setItem(RESTART_STORAGE_KEY, state.restartPending ? "true" : "false");
}

function resetLayout() {
  state.layout = defaultLayout();
  saveLayout();
  renderAll();
}

async function getJson(url, options = {}) {
  const { timeoutMs = STATUS_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      ...fetchOptions,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，面板后端可能没有响应");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function rememberLatency(items) {
  const sample = { at: new Date(), values: {} };
  items.forEach((entry) => {
    sample.values[entry.host] = entry.ok ? entry.latency_ms : null;
  });
  state.latencyHistory.push(sample);
  if (state.latencyHistory.length > 72) state.latencyHistory.shift();
}

function latencyClass(value) {
  if (value === null || value === undefined) return "bad";
  if (value < 120) return "good";
  if (value < 450) return "warn";
  return "bad";
}

function endpointTone(entry) {
  if (isLocalLaProbeIssue(entry)) return "warn";
  return entry?.ok ? latencyClass(entry.latency_ms) : "bad";
}

function endpointByHost(items, host) {
  return (items || []).find((entry) => entry.host === host) || {};
}

function isLocalLaProbeIssue(entry) {
  return entry?.host === "la.playje.unmcserver.com" && !entry.ok;
}

function endpointValue(entry) {
  if (entry?.ok) return `${entry.latency_ms}ms`;
  if (isLocalLaProbeIssue(entry)) return "握手未返回";
  return "异常";
}

function endpointDetail(entry, fallback = "") {
  if (isLocalLaProbeIssue(entry)) return "Minecraft 状态握手未返回";
  return fallback;
}

function formatCommandResult(result) {
  if (!result) return "";
  const parts = [result.ok ? "OK" : "ERR"];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  return parts.join("\n");
}

function dataOrEmpty() {
  return state.latestData || {
    loading: true,
    running: {},
    sessions: {},
    processes: {},
    process_stats: { java: [], tunnel: [], panel: [] },
    minecraft: [],
    properties: {},
    stats: {},
    warnings: [],
  };
}

function localStatus(data) {
  return (data.minecraft || []).find((entry) => entry.host === "127.0.0.1") || {};
}

function metricCard(label, value, detail = "", tone = "") {
  return `
    <div class="mini-card ${tone}">
      <span>${escapeHTML(label)}</span>
      <b>${escapeHTML(value ?? "--")}</b>
      <small>${escapeHTML(detail || "")}</small>
    </div>
  `;
}

function statusPill(ok, text) {
  const tone = ok === null ? "warn" : ok ? "ok" : "bad";
  return `<span class="status-pill ${tone}">${escapeHTML(text)}</span>`;
}

function renderStatusWidget(data) {
  const local = localStatus(data);
  const java = data.process_stats?.java?.[0] || {};
  const props = data.properties || {};
  const loading = Boolean(data.loading);
  const serverState = loading ? "正在检查" : data.running?.server ? "运行中" : "未运行";
  const tunnelState = loading ? "检测中" : data.running?.tunnel ? "隧道已连接" : "隧道未连接";
  return `
    <div class="status-hero ${loading ? "checking" : ""}">
      <div>
        <span>Java 生存服</span>
        <strong>${serverState}</strong>
        <small>${escapeHTML(loading ? "等待面板采样..." : props.motd || local.motd || "--")}</small>
      </div>
      ${statusPill(loading ? null : Boolean(data.running?.tunnel), tunnelState)}
    </div>
    <div class="mini-grid">
      ${metricCard("玩家", local.ok ? `${local.online}/${local.max}` : "--/--", loading ? "等待采样" : local.version || "本地状态异常")}
      ${metricCard("难度", props.difficulty || "--", `模式 ${props.gamemode || "--"}`)}
      ${metricCard("运行", formatEtime(java.etime), "JE 运行时长", "mini-wide")}
      ${metricCard("连接", data.stats?.connections?.established ?? "--", "TCP established")}
    </div>
  `;
}

function latencyChartMarkup(items) {
  const width = 720;
  const height = 180;
  const pad = { left: 42, right: 14, top: 16, bottom: 30 };
  const hosts = items.map((entry) => entry.host);
  const values = state.latencyHistory.flatMap((sample) =>
    hosts.map((host) => sample.values[host]).filter((value) => typeof value === "number")
  );
  const max = Math.max(100, Math.ceil((Math.max(...values, 1) + 80) / 100) * 100);
  const grid = [0, 0.5, 1]
    .map((ratio) => {
      const y = pad.top + (height - pad.top - pad.bottom) * ratio;
      return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}" class="chart-grid"></line><text x="8" y="${y + 4}" class="chart-label">${Math.round(max * (1 - ratio))}ms</text>`;
    })
    .join("");
  const lines = hosts
    .map((host) => {
      const meta = endpointMeta[host] || {};
      const points = state.latencyHistory
        .map((sample, index) => {
          const value = sample.values[host];
          if (typeof value !== "number") return null;
          const x = pad.left + (index / Math.max(1, state.latencyHistory.length - 1)) * (width - pad.left - pad.right);
          const y = pad.top + (1 - Math.min(value, max) / max) * (height - pad.top - pad.bottom);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .filter(Boolean);
      const lastPoint = points.at(-1);
      return `
        <polyline class="chart-line" points="${points.join(" ")}" fill="none" stroke="${meta.color || "#777"}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${lastPoint ? `<circle class="chart-dot" cx="${lastPoint.split(",")[0]}" cy="${lastPoint.split(",")[1]}" r="4" fill="${meta.color || "#777"}"></circle>` : ""}
      `;
    })
    .join("");
  return `<svg viewBox="0 0 720 180" role="img" aria-label="入口延迟趋势">${grid}${lines}<text x="${pad.left}" y="${height - 8}" class="chart-label">最近采样</text></svg>`;
}

function renderEndpointRouteMap(items) {
  const local = endpointByHost(items, "127.0.0.1");
  const beijing = endpointByHost(items, "playje.unmcserver.com");
  const la = endpointByHost(items, "la.playje.unmcserver.com");
  const node = (label, detail, mark, tone = "ok") => `
    <div class="route-node ${tone}">
      <i class="route-mark route-mark-${escapeHTML(mark.toLowerCase())}" aria-hidden="true">${escapeHTML(mark)}</i>
      <b>${escapeHTML(label)}</b>
      <span>${escapeHTML(detail)}</span>
    </div>
  `;
  const connector = () => `
    <div class="route-connector" aria-hidden="true">
      <i class="rail-forward"></i>
      <i class="rail-back"></i>
    </div>
  `;
  return `
    <div class="route-map route-map-roundtrip" aria-label="入口路径图示">
      <div class="route-line-main">
        ${node("LA 入口", endpointValue(la), "LA", la.ok ? "warm" : "warn")}
        ${connector()}
        ${node("北京入口", endpointValue(beijing), "BJ", beijing.ok ? "blue" : "bad")}
        ${connector()}
        ${node("Mac mini", endpointValue(local), "JE", local.ok ? "teal" : "bad")}
      </div>
      <p class="route-copy">LA 线路：LA → 北京入口 → Mac mini / JE；北京线路：北京入口 → Mac mini / JE。探测内容是 Minecraft 状态握手，显示请求到响应返回的往返耗时。</p>
    </div>
  `;
}

function renderNetworkHealthDiagram(items) {
  const beijing = endpointByHost(items, "playje.unmcserver.com");
  const la = endpointByHost(items, "la.playje.unmcserver.com");
  const publicOk = [beijing, la].filter((entry) => entry.ok).length;
  const delta = beijing.ok && la.ok ? la.latency_ms - beijing.latency_ms : null;
  const deltaText = delta === null ? "--" : `${delta >= 0 ? "+" : ""}${delta}ms`;
  const healthCard = (label, value, detail, tone) => `
    <div class="network-health-card ${tone}">
      <i aria-hidden="true"></i>
      <span>${escapeHTML(label)}</span>
      <b>${escapeHTML(value)}</b>
      <small>${escapeHTML(detail)}</small>
    </div>
  `;
  return `
    <div class="network-health-grid network-health-compact" aria-label="入口健康图示">
      ${healthCard("公网入口", `${publicOk}/2`, "北京与 LA 可达数", publicOk === 2 ? "good" : publicOk ? "warn" : "bad")}
      ${healthCard("LA 差值", isLocalLaProbeIssue(la) ? "未返回" : deltaText, "相对北京入口", isLocalLaProbeIssue(la) ? "warn" : delta !== null && delta < 250 ? "good" : delta !== null && delta < 700 ? "warn" : "bad")}
    </div>
  `;
}

function renderEntriesWidget(data, entry = {}) {
  const items = data.minecraft || [];
  if (!items.length) {
    return `<div class="empty-state"><b>正在检测入口</b><span>本机、北京和洛杉矶入口会在采样完成后显示延迟。</span></div>`;
  }
  const max = Math.max(1000, ...items.map((entry) => (entry.ok ? entry.latency_ms : 1000)));
  const rows = items
    .map((entry) => {
      const meta = endpointMeta[entry.host] || {};
      const value = endpointValue(entry);
      const width = entry.ok ? Math.max(2, Math.min(100, (entry.latency_ms / max) * 100)) : 100;
      return `
        <div class="latency-row ${endpointTone(entry)}">
          <div>
            <b>${escapeHTML(meta.name || entry.host)}</b>
            <span>${escapeHTML(endpointDetail(entry, `${entry.host}:${entry.port}`))}</span>
          </div>
          <div class="latency-track"><i style="width:${width}%; background:${meta.color || "#777"}"></i></div>
          <strong>${escapeHTML(value)}</strong>
        </div>
      `;
    })
    .join("");
  const showChart = entry.prefs?.chart !== false;
  return `${renderEndpointRouteMap(items)}${renderNetworkHealthDiagram(items)}<div class="latency-bars">${rows}</div>${showChart ? `<div class="chart-shell">${latencyChartMarkup(items)}</div>` : ""}`;
}

function renderOnlinePlayers(local, activity, fakeNames = new Set()) {
  const sample = local?.sample || [];
  const fallback = activity?.since_start?.currently_online_names || [];
  const names = (sample.length ? sample.map((entry) => entry.name) : fallback)
    .filter((name) => !fakeNames.has(String(name).toLowerCase()));
  if (!names.length) return `<div class="empty-state player-empty"><b>无人在线</b><span>当前 0 人</span></div>`;
  return names
    .map((name) => `
      <div class="person-row">
        <i>${escapeHTML((name || "?").slice(0, 1).toUpperCase())}</i>
        <div><b>${escapeHTML(name)}</b><span>${sample.length ? "服务端实时返回" : "日志推断"}</span></div>
      </div>
    `)
    .join("");
}

function renderHistory(activity) {
  const players = activity?.last_24h?.players || [];
  if (!players.length) return `<div class="empty-state player-empty"><b>24 小时内无人上线</b><span>有人进服后这里会自动列出名字和时长</span></div>`;
  return `<div class="history-list history-list-24h">${players.map(historyItemMarkup).join("")}</div>`;
}

function historyItemMarkup(player) {
  const timeText = player.last_join_time || "--";
  const sessionText = formatPlayerMinutes(player.session_minutes_24h);
  const totalText = formatPlayerHours(player.play_hours);
  const joinText = `加入 ${Number(player.join_events || 0)} 次`;
  return `
    <div class="history-item history-player ${player.online ? "online" : ""}">
      <span>${escapeHTML(timeText)}</span>
      <div>
        <b>${escapeHTML(player.name)}</b>
        <small>游玩 ${escapeHTML(sessionText)} · 累计 ${escapeHTML(totalText)} · ${escapeHTML(joinText)}</small>
      </div>
      ${player.online ? `<em>在线</em>` : ""}
    </div>
  `;
}

function playerStatPill(label, value, detail) {
  return `<div class="player-stat-pill"><span>${escapeHTML(label)}</span><b>${escapeHTML(value)}</b><small>${escapeHTML(detail)}</small></div>`;
}

function renderPlayersWidget(data) {
  const local = localStatus(data);
  const activity = data.stats?.activity || {};
  const last24h = activity.last_24h || {};
  const sinceStart = activity.since_start || {};
  const fake = data.stats?.players?.fake || {};
  const fakeNames = fakeNameSet(data);
  const fakeActive = Number(fake.active || 0);
  const onlineCount = Number.isFinite(Number(local.online))
    ? Math.max(0, Number(local.online) - fakeActive)
    : (sinceStart.currently_online_names || []).filter((name) => !fakeNames.has(String(name).toLowerCase())).length;
  const maxPlayers = Number.isFinite(Number(local.max)) ? Number(local.max) : "--";
  const last24hPlayers = last24h.players || [];
  const activeMinutes = last24hMinutes(activity);
  return `
    <div class="player-overview-frame">
      <div class="player-widget-grid">
        <section class="player-panel live-panel">
          <div class="player-panel-head">
            <span>当前在线</span>
            <b>${escapeHTML(`${onlineCount}/${maxPlayers}`)}</b>
          </div>
          <div class="person-list">${renderOnlinePlayers(local, activity, fakeNames)}</div>
        </section>
        <section class="player-panel history-panel">
          <div class="player-panel-head">
            <span>过去 24 小时上线</span>
            <b>${escapeHTML(`${last24hPlayers.length} 人`)}</b>
          </div>
          ${renderHistory(activity)}
        </section>
      </div>
      <div class="player-stat-strip">
        ${playerStatPill("上线人数", last24h.unique_joined || 0, "过去24小时 · 不含假人")}
        ${playerStatPill("加入次数", last24h.join_events || 0, "过去24小时 · 不含假人")}
        ${playerStatPill("游玩时长", formatPlayerMinutes(activeMinutes), "过去24小时 · 不含假人")}
      </div>
    </div>
  `;
}

function renderTotalsWidget(data) {
  const totals = data.stats?.players?.totals || {};
  const fake = data.stats?.players?.fake || {};
  return `
    <div class="mini-grid dense">
      ${metricCard("玩家总游玩", `${totals.play_hours || 0}h`, "不含假人")}
      ${metricCard("玩家总移动", `${totals.distance_km || 0}km`, "不含假人")}
      ${metricCard("当前假人", fake.active || 0, "正在运行")}
      ${metricCard("总死亡", totals.deaths || 0, "历史")}
      ${metricCard("怪物击杀", totals.mob_kills || 0, "累计")}
      ${metricCard("玩家击杀", totals.player_kills || 0, "累计")}
      ${metricCard("进度", totals.advancements || 0, "已完成")}
      ${metricCard("挖掘", compactNumber(totals.blocks_mined), "方块")}
      ${metricCard("合成", compactNumber(totals.items_crafted), "物品")}
    </div>
  `;
}

function boardMarkup(title, rows, key, suffix = "") {
  const items = (rows || [])
    .slice(0, 5)
    .map((row, index) => `<li><span>${index + 1}. ${escapeHTML(row.name)}</span><b>${escapeHTML(compactNumber(row[key]))}${suffix}</b></li>`)
    .join("");
  return `<div class="leaderboard-block"><h3>${escapeHTML(title)}</h3><ol>${items || "<li><span>暂无</span><b>--</b></li>"}</ol></div>`;
}

function renderLeaderboardsWidget(data) {
  const boards = data.stats?.players?.leaderboards || {};
  return `
    <div class="leaderboard-grid">
      ${boardMarkup("肝帝榜", boards.playtime, "play_hours", "h")}
      ${boardMarkup("跑图榜", boards.distance, "distance_km", "km")}
      ${boardMarkup("死亡榜", boards.deaths, "deaths", "次")}
      ${boardMarkup("挖掘榜", boards.mined, "blocks_mined", "块")}
      ${boardMarkup("击杀榜", boards.mob_kills, "mob_kills", "只")}
      ${boardMarkup("进度榜", boards.advancements, "advancements", "个")}
    </div>
  `;
}

function badge(label, value, detail = "", active = true) {
  return `
    <div class="badge-card ${active ? "active" : ""}">
      <span>${escapeHTML(label)}</span>
      <b>${escapeHTML(value)}</b>
      <small>${escapeHTML(detail)}</small>
    </div>
  `;
}

function firstName(rows) {
  return rows?.[0]?.name || "--";
}

function renderAchievementsWidget(data) {
  const players = data.stats?.players || {};
  const totals = players.totals || {};
  const boards = players.leaderboards || {};
  const activity = data.stats?.activity || {};
  return `
    <div class="badge-grid">
      ${badge("长线世界", `${totals.play_hours || 0}h`, "全服累计游玩")}
      ${badge("远行者", `${totals.distance_km || 0}km`, "全服累计移动")}
      ${badge("地下工程", compactNumber(totals.blocks_mined), "累计挖掘方块")}
      ${badge("怪物猎场", compactNumber(totals.mob_kills), "累计怪物击杀")}
      ${badge("进度收藏", compactNumber(totals.advancements), "累计完成进度")}
      ${badge("24小时火种", activity.last_24h?.unique_joined || 0, "过去 24 小时玩家进服")}
      ${badge("本季肝帝", firstName(boards.playtime), "游玩时间第一")}
      ${badge("最远旅人", firstName(boards.distance), "移动距离第一")}
    </div>
  `;
}

function renderResourcesWidget(data) {
  const java = data.process_stats?.java?.[0] || {};
  const tunnel = data.process_stats?.tunnel?.[0] || {};
  const load = data.stats?.system?.load || [];
  const cores = data.stats?.system?.cores || 1;
  const loadPressure = load[0] ? (Number(load[0]) / cores) * 100 : 0;
  return `
    <div class="mini-grid dense">
      ${metricCard("CPU", formatPercent(java.cpu_percent), "Java")}
      ${metricCard("内存", java.rss_mb ? `${java.rss_mb}MB` : "--", javaMemoryDetail(data, java))}
      ${metricCard("系统压力", formatPercent(loadPressure), `${load.join(" / ") || "--"} · ${cores} 核`)}
      ${metricCard("连接", data.stats?.connections?.established ?? "--", "TCP established")}
      ${metricCard("Java PID", java.pid || "--", java.etime ? `运行 ${formatEtime(java.etime)}` : "")}
      ${metricCard("隧道 PID", tunnel.pid || "--", tunnel.etime ? `运行 ${formatEtime(tunnel.etime)}` : "")}
    </div>
  `;
}

function renderWorldWidget(data) {
  const world = data.stats?.world || {};
  const disk = data.stats?.disk || {};
  const plugins = data.stats?.plugins || {};
  return `
    <div class="mini-grid">
      ${metricCard("存档", disk.world?.label || data.disk?.world || "--", "server/world")}
      ${metricCard("服务端", disk.server?.label || data.disk?.server || "--", "server")}
      ${metricCard("日志", disk.logs?.label || "--", "server/logs")}
      ${metricCard("插件", disk.plugins?.label || "--", `${plugins.jars || 0} 个 Jar`)}
      ${metricCard("区域文件", world.region_files || 0, "region .mca")}
      ${metricCard("玩家档案", world.player_files || 0, "playerdata")}
      ${metricCard("统计文件", world.stats_files || 0, "stats")}
      ${metricCard("存档写入", world.level_dat_mtime?.slice(5) || "--", "level.dat")}
    </div>
  `;
}

function renderPluginsWidget(data) {
  const plugins = data.stats?.plugins?.files || [];
  if (!plugins.length) {
    return `<div class="empty-state"><b>没有发现插件</b><span>server/plugins 第一层没有可管理的插件 Jar</span></div>`;
  }
  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;
  const rows = plugins
    .map((plugin) => `
      <div class="plugin-row ${plugin.enabled ? "enabled" : "disabled"}">
        <div>
          <b>${escapeHTML(plugin.name)}</b>
          <span>${escapeHTML(plugin.file)} · ${escapeHTML(plugin.size)} · 重启 JE 后生效</span>
        </div>
        <label class="plugin-switch">
          <input type="checkbox" data-plugin-toggle="${escapeHTML(plugin.file)}" ${plugin.enabled ? "checked" : ""} ${state.busy ? "disabled" : ""}>
          <span class="plugin-switch-track"><i></i></span>
          <em>${plugin.enabled ? "已启用" : "已停用"}</em>
        </label>
      </div>
    `)
    .join("");
  return `
    <div class="widget-note">${enabledCount}/${plugins.length} 已启用 · 开关后重启 JE 生效</div>
    <div class="plugin-list">${rows}</div>
  `;
}

function configInput(field, value) {
  const safeValue = escapeHTML(value ?? "");
  if (field.type === "select") {
    const options = field.options
      .map((option) => `<option value="${escapeHTML(option)}" ${option === value ? "selected" : ""}>${escapeHTML(option)}</option>`)
      .join("");
    return `<select name="value">${options}</select>`;
  }
  if (field.type === "bool") {
    const boolValue = value === "true" ? "true" : "false";
    return `
      <select name="value">
        <option value="true" ${boolValue === "true" ? "selected" : ""}>true</option>
        <option value="false" ${boolValue === "false" ? "selected" : ""}>false</option>
      </select>
    `;
  }
  if (field.type === "number") {
    return `<input name="value" type="number" min="${field.min}" max="${field.max}" value="${safeValue}">`;
  }
  return `<input name="value" type="text" value="${safeValue}">`;
}

function renderConfigWidget(data) {
  const props = data.properties || {};
  const rows = CONFIG_FIELDS.map((field) => {
    const current = props[field.key] ?? "";
    return `
      <form class="config-row" data-config-form>
        <input type="hidden" name="key" value="${escapeHTML(field.key)}">
        <label>
          <span>${escapeHTML(field.label)}</span>
          <small>${escapeHTML(field.key)} · 重启 JE 后生效</small>
        </label>
        ${configInput(field, current)}
        <button type="submit" ${state.busy ? "disabled" : ""}>保存</button>
      </form>
    `;
  }).join("");
  return `<div class="config-list">${rows}</div>`;
}

function renderItemsWidget(data) {
  const items = data.stats?.players?.items || {};
  return `
    <div class="feature-list">
      ${featureItem("常挖", items.most_mined)}
      ${featureItem("常合成", items.most_crafted)}
      ${featureItem("常使用", items.most_used)}
    </div>
  `;
}

function featureItem(label, itemData = {}) {
  return `<div class="feature-item"><span>${escapeHTML(label)}</span><b>${escapeHTML(itemData.name || "--")}</b><small>${escapeHTML(compactNumber(itemData.count || 0))}</small></div>`;
}

function renderChatWidget(data) {
  const chat = data.stats?.activity?.last_chat || [];
  if (!chat.length) return `<div class="empty-state"><b>暂无聊天</b><span>最近日志里没有玩家聊天记录</span></div>`;
  return `<div class="chat-list">${chat.map((entry) => `<div class="chat-row"><b>${escapeHTML(entry.name)}</b><span>${escapeHTML(entry.message)}</span></div>`).join("")}</div>`;
}

function renderRoutesWidget(data) {
  const rows = (data.minecraft || [])
    .map((entry) => {
      const meta = endpointMeta[entry.host] || {};
      return `
        <div class="route-item">
          <b>${escapeHTML(meta.name || entry.host)} ${entry.ok ? "· 在线" : isLocalLaProbeIssue(entry) ? "· 状态握手未返回" : "· 异常"}</b>
          <span>${escapeHTML(meta.route || entry.host)}</span>
          <small>${escapeHTML(endpointDetail(entry, meta.note || entry.error || ""))}</small>
        </div>
      `;
    })
    .join("");
  return `<div class="route-list">${rows}</div>`;
}

function renderSettingsWidget(data) {
  const props = data.properties || {};
  const warnings = data.warnings || [];
  return `
    <div class="mini-grid">
      ${metricCard("端口", props["server-port"] || "--", "server-port")}
      ${metricCard("难度", props.difficulty || "--", "difficulty")}
      ${metricCard("模式", props.gamemode || "--", "gamemode")}
      ${metricCard("最大人数", props["max-players"] || "--", "max-players")}
      ${metricCard("正版验证", props["online-mode"] || "--", "online-mode")}
      ${metricCard("警告", warnings.length || 0, warnings.join(" · ") || "正常")}
    </div>
  `;
}

function renderSessionsWidget(data) {
  const sessions = data.sessions || {};
  const processCounts = data.processes || {};
  return `
    <div class="mini-grid">
      ${metricCard("JE screen", sessions["unmc-je"] || "no screen", "unmc-je")}
      ${metricCard("隧道 screen", sessions["unmc-tunnel"] || "no screen", "unmc-tunnel")}
      ${metricCard("面板 screen", sessions["unmc-panel"] || "no screen", "unmc-panel")}
      ${metricCard("Java 进程", processCounts.java?.length || 0, "purpur")}
      ${metricCard("SSH 隧道", processCounts.tunnel?.length || 0, "ssh")}
      ${metricCard("隧道守护", processCounts.tunnel_loop?.length || 0, "loop")}
    </div>
  `;
}

function renderLogsWidget() {
  const logState = logScrollState();
  const held = !logState.pinned;
  const historyText = state.logLoadingOlder
    ? "正在接上更早日志..."
    : state.logHistoryError
      ? state.logHistoryError
      : state.logHasMore[state.logTarget]
        ? "上滑到顶部自动加载更早日志"
        : "已经到最早日志";
  return `
    <div class="log-toolbar">
      <div class="tabs" role="tablist">
        <button class="tab ${state.logTarget === "server" ? "active" : ""}" data-log="server" type="button">JE</button>
        <button class="tab ${state.logTarget === "tunnel" ? "active" : ""}" data-log="tunnel" type="button">隧道</button>
      </div>
      <span class="log-history-meta ${state.logLoadingOlder ? "loading" : ""}">${escapeHTML(historyText)}</span>
    </div>
    <div class="log-frame ${held ? "is-held" : ""}">
      <pre id="logBox" class="log-box" data-log-target="${escapeHTML(state.logTarget)}">${renderLogText(state.latestLogs || "")}</pre>
      ${held ? `
        <button class="log-latest-hint" data-log-latest type="button" title="回到最新日志">
          <i aria-hidden="true">↓</i>
          <span>不在最新</span>
        </button>
      ` : ""}
    </div>
  `;
}

function renderControlsWidget() {
  return `
    <div class="button-row">
      <button data-action="start_all" type="button" ${state.busy ? "disabled" : ""}>启动全部</button>
      <button data-action="restart_server" type="button" ${state.busy ? "disabled" : ""}>重启 JE</button>
      <button data-action="restart_tunnel" type="button" ${state.busy ? "disabled" : ""}>重启隧道</button>
      <button data-console="save-all" type="button" ${state.busy ? "disabled" : ""}>保存世界</button>
      <button data-console="list" type="button" ${state.busy ? "disabled" : ""}>玩家列表</button>
      <button data-action="stop_server" class="danger" type="button" ${state.busy ? "disabled" : ""}>停 JE</button>
    </div>
    <form id="consoleForm" class="console-form">
      <input id="consoleCommand" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Minecraft 控制台命令" value="${escapeHTML(state.consoleCommand)}" ${state.busy ? "disabled" : ""}>
      <button type="submit" ${state.busy ? "disabled" : ""}>发送</button>
    </form>
    <div id="commandFeedback" class="command-feedback ${state.feedback.kind}" aria-live="polite">
      <div class="feedback-head">
        <span class="feedback-dot"></span>
        <strong>${escapeHTML(state.feedback.title)}</strong>
        <small>${escapeHTML(state.feedback.meta)}</small>
      </div>
      <pre class="action-output">${escapeHTML(state.feedback.body)}</pre>
    </div>
  `;
}

function renderSkeletonWidget(type) {
  if (type === "status") {
    return `
      <div class="skeleton-hero skeleton-status-hero">
        <div>
          <i></i>
          <b></b>
          <span></span>
        </div>
        <em></em>
      </div>
      <div class="skeleton-grid skeleton-metrics">
        <i></i><i></i><i></i><i></i>
      </div>
    `;
  }
  if (type === "entries") {
    return `
      <div class="skeleton-latency-list">
        <div class="skeleton-latency-row"><span><b></b><i></i></span><em></em><strong></strong></div>
        <div class="skeleton-latency-row"><span><b></b><i></i></span><em></em><strong></strong></div>
        <div class="skeleton-latency-row"><span><b></b><i></i></span><em></em><strong></strong></div>
      </div>
      <div class="skeleton-chart"></div>
    `;
  }
  if (type === "players") {
    return `
      <div class="player-widget-grid skeleton-player-grid">
        <div class="skeleton-player-panel"><span></span><b></b><i></i></div>
        <div class="skeleton-player-panel"><span></span><b></b><i></i><i></i><i></i></div>
      </div>
      <div class="skeleton-stat-strip">
        <i></i><i></i>
      </div>
    `;
  }
  if (type === "logs") {
    return `<div class="skeleton-log"><i></i><i></i><i></i><i></i><i></i><i></i></div>`;
  }
  return `
    <div class="skeleton-grid">
      <i></i><i></i><i></i><i></i>
      <i></i><i></i>
    </div>
  `;
}

function renderPanelBody(type, entry = {}) {
  const definition = WIDGETS[type];
  if (!definition) return "";
  const data = dataOrEmpty();
  return data.loading ? renderSkeletonWidget(type) : definition.render(data, entry);
}

function renderPanelCard(type, options = {}) {
  const definition = WIDGETS[type] || {};
  const body = options.body ?? renderPanelBody(type, options.entry || {});
  const title = options.title || definition.title || "";
  const category = options.category || definition.category || "";
  const className = options.className || "";
  return `
    <article class="panel-card ${className}" data-panel-type="${escapeHTML(type)}">
      <div class="panel-card-head">
        <div>
          <span>${escapeHTML(category)}</span>
          <h2>${escapeHTML(title)}</h2>
        </div>
        ${options.aside ? `<p>${options.aside}</p>` : ""}
      </div>
      <div class="panel-card-body">${body}</div>
    </article>
  `;
}

function renderPanelSection(id, title, body, className = "") {
  return `
    <section id="${escapeHTML(id)}" class="panel-section section-${escapeHTML(id)} ${escapeHTML(className)}">
      <div class="section-head">
        <span>UN 控制台</span>
        <h1>${escapeHTML(title)}</h1>
      </div>
      <div class="section-body">${body}</div>
    </section>
  `;
}

function renderGlassModule(title, eyebrow, body, className = "") {
  return `
    <article class="glass-module ${className}">
      <div class="module-head">
        <div>
          <span>${escapeHTML(eyebrow)}</span>
          <h2>${escapeHTML(title)}</h2>
        </div>
      </div>
      <div class="module-body">${body}</div>
    </article>
  `;
}

function renderCalmCard(title, eyebrow, body, className = "") {
  return `
    <article class="calm-card ${className}">
      <div class="calm-card-head">
        <div>
          <span>${escapeHTML(eyebrow)}</span>
          <h2>${escapeHTML(title)}</h2>
        </div>
      </div>
      <div class="calm-card-body">${body}</div>
    </article>
  `;
}

function renderFact(label, value, detail = "", tone = "") {
  return `
    <div class="fact ${tone}">
      <span>${escapeHTML(label)}</span>
      <b>${escapeHTML(value ?? "--")}</b>
      <small>${escapeHTML(detail)}</small>
    </div>
  `;
}

function renderFactGrid(items, className = "") {
  return `<div class="fact-grid ${className}">${items.join("")}</div>`;
}

function renderStatusOverview(data) {
  const local = localStatus(data);
  const props = data.properties || {};
  const java = data.process_stats?.java?.[0] || {};
  const world = data.stats?.world || {};
  const serverRunning = Boolean(data.running?.server);
  const tunnelRunning = Boolean(data.running?.tunnel);
  const title = serverRunning ? "运行中" : "未运行";
  return `
    <div class="overview-hero ${serverRunning ? "online" : "offline"}">
      <div class="hero-status-line">
        <span>Java 生存服</span>
      </div>
      <strong>${escapeHTML(title)}</strong>
      <p>${escapeHTML(props.motd || local.motd || "United Nations")}</p>
      ${renderFactGrid([
        renderFact("玩家", local.ok ? `${local.online}/${local.max}` : "--/--", local.version || "Purpur"),
        renderFact("难度", props.difficulty || "--", `模式 ${props.gamemode || "--"}`),
        renderFact("运行", formatEtime(java.etime), "JE 运行时长", "fact-wide"),
        renderFact("隧道", tunnelRunning ? "已连接" : "未连接", data.sessions?.["unmc-tunnel"] || "screen"),
        renderFact("存档写入", world.level_dat_mtime?.slice(11) || "--", "level.dat"),
        renderFact("TCP", data.stats?.connections?.established ?? "--", "established"),
      ], "hero-facts")}
    </div>
  `;
}

function renderRuntimeOverview(data) {
  const java = data.process_stats?.java?.[0] || {};
  const tunnel = data.process_stats?.tunnel?.[0] || {};
  const panel = data.process_stats?.panel?.[0] || {};
  const load = data.stats?.system?.load || [];
  const cores = data.stats?.system?.cores || 1;
  const memoryPercent = javaMemoryPercent(data, java);
  return `
    <div class="meter-list clean-meters">
      ${barMeter("Java CPU", formatPercent(java.cpu_percent), "", java.cpu_percent, "teal")}
      ${barMeter("Java 内存", javaMemoryMeterValue(data, java), "", memoryPercent, "blue", javaMemoryMeterSubtext(data))}
      ${renderLoadPressure(load, cores)}
    </div>
    ${renderFactGrid([
      renderFact("Java PID", java.pid || "--", "purpur"),
      renderFact("隧道 PID", tunnel.pid || "--", tunnel.etime ? `运行 ${formatEtime(tunnel.etime)}` : "ssh"),
      renderFact("面板 PID", panel.pid || "--", panel.etime ? `运行 ${formatEtime(panel.etime)}` : "panel"),
    ], "process-facts")}
  `;
}

function loadTone(percent) {
  if (percent >= 85) return "bad";
  if (percent >= 58) return "warm";
  return "teal";
}

function renderLoadPressure(load = [], cores = 1) {
  const safeCores = Math.max(1, Number(cores) || 1);
  const labels = ["1m", "5m", "15m"];
  const current = Number(load[0] || 0);
  const currentPercent = Math.max(0, Math.min(100, (current / safeCores) * 100));
  const rows = labels.map((label, index) => {
    const value = Number(load[index] || 0);
    const percent = Math.max(0, Math.min(100, (value / safeCores) * 100));
    return `
      <div class="load-chip ${loadTone(percent)}">
        <span>${label}</span>
        <b>${value ? value.toFixed(2) : "--"}</b>
        <i><em style="width:${percent}%"></em></i>
      </div>
    `;
  }).join("");
  return `
    <div class="load-pressure ${loadTone(currentPercent)}">
      <div class="load-pressure-head">
        <span>系统压力</span>
        <b>${formatPercent(currentPercent)}</b>
        <small>1m / 5m / 15m</small>
      </div>
      <div class="load-chip-grid">${rows}</div>
    </div>
  `;
}

function renderWorldOverview(data) {
  const disk = data.stats?.disk || {};
  const world = data.stats?.world || {};
  const plugins = data.stats?.plugins || {};
  return renderFactGrid([
    renderFact("存档", disk.world?.label || data.disk?.world || "--", "server/world"),
    renderFact("服务端", disk.server?.label || data.disk?.server || "--", "server"),
    renderFact("日志", disk.logs?.label || "--", "server/logs"),
    renderFact("插件", disk.plugins?.label || "--", `${plugins.jars || 0} 个 Jar`),
    renderFact("区域文件", world.region_files || 0, "region .mca"),
    renderFact("玩家档案", world.player_files || 0, "playerdata"),
    renderFact("统计文件", world.stats_files || 0, "stats"),
    renderFact("进度文件", world.advancement_files || 0, "advancements"),
  ], "world-facts");
}

function backupScheduleText(config = {}) {
  if (!config.enabled) return "已关闭";
  if (config.mode === "interval") return `每 ${config.interval_hours || 24} 小时`;
  return `每天 ${config.time || "08:00"}`;
}

function backupRecordMarkup(record) {
  return `
    <div class="backup-record">
      <div>
        <b>${escapeHTML(record.name || "--")}</b>
        <span>${escapeHTML(record.created_at || "--")}</span>
      </div>
      <strong>${escapeHTML(record.size || "--")}</strong>
    </div>
  `;
}

function backupStage(config = {}, job = {}) {
  if (job.running) {
    const total = Number(job.total || 0);
    const progress = Math.min(Number(job.progress || 0), total);
    const percent = total ? Math.min(100, (progress / total) * 100) : 7;
    return {
      tone: "running",
      title: job.message || "正在备份",
      detail: total ? `已处理 ${progress}/${total} 个文件` : "正在让 Minecraft 把世界写入磁盘",
      percent,
      label: total ? `${progress}/${total}` : "准备中",
      progressLabel: total ? `${Math.round(percent)}%` : "准备中",
    };
  }
  if (config.last_error) {
    return {
      tone: "bad",
      title: "上次备份失败",
      detail: config.last_error,
      percent: 0,
      label: "失败",
      progressLabel: "失败",
    };
  }
  if (config.last_success_at) {
    return {
      tone: "done",
      title: "上次备份完成",
      detail: `${config.last_success_at}${config.last_file ? ` · ${config.last_file}` : ""}`,
      percent: 100,
      label: "完成",
      progressLabel: "100%",
    };
  }
  return {
    tone: "idle",
    title: config.enabled === false ? "自动备份已关闭" : "等待第一次备份",
    detail: config.enabled === false ? "开启后会按设置自动备份" : "到点后会自动生成，也可以点“立刻备份”。",
    percent: 0,
    label: "待命",
    progressLabel: "0%",
  };
}

function renderBackupWidget(data) {
  const backup = data.backup || {};
  const config = backup.config || {};
  const job = backup.job || {};
  const running = Boolean(job.running);
  const enabled = config.enabled !== false;
  const mode = config.mode === "interval" ? "interval" : "daily";
  const records = (backup.backups || []).slice(0, 5).map(backupRecordMarkup).join("");
  return `
    <div class="backup-panel">
      <div class="backup-hero">
        <div>
          <span>本机自动备份</span>
          <b>${backupScheduleText(config)}</b>
          <small>${running ? "备份正在进行，进度会在右下角弹出" : `下一次：${backup.next_run_at || "--"}`}</small>
        </div>
        <button data-action="backup_now" type="button" ${state.busy || running ? "disabled" : ""}>立刻备份</button>
      </div>
      <form class="backup-form" data-backup-form>
        <label>
          <span>自动备份</span>
          <select name="enabled">
            <option value="true" ${enabled ? "selected" : ""}>开启</option>
            <option value="false" ${!enabled ? "selected" : ""}>关闭</option>
          </select>
        </label>
        <label>
          <span>周期</span>
          <select name="mode">
            <option value="daily" ${mode === "daily" ? "selected" : ""}>每天固定时间</option>
            <option value="interval" ${mode === "interval" ? "selected" : ""}>每隔几小时</option>
          </select>
        </label>
        <label>
          <span>每天时间</span>
          <input name="time" type="time" value="${escapeHTML(config.time || "08:00")}">
        </label>
        <label>
          <span>间隔小时</span>
          <input name="interval_hours" type="number" min="1" max="168" value="${escapeHTML(config.interval_hours || 24)}">
        </label>
        <label>
          <span>本机保留</span>
          <input name="keep" type="number" min="1" max="60" value="${escapeHTML(config.keep || 7)}">
        </label>
        <button type="submit" ${state.busy ? "disabled" : ""}>保存设置</button>
      </form>
      <div class="backup-meta">
        <span>位置：backups/world</span>
        <span>上次成功：${escapeHTML(config.last_success_at || "--")}</span>
      </div>
      <div class="backup-records">
        ${records || `<div class="empty-state"><b>还没有备份</b><span>到点后会自动生成，也可以点“立刻备份”。</span></div>`}
      </div>
    </div>
  `;
}

function renderBackupHud(data) {
  const backup = data.backup || {};
  const config = backup.config || {};
  const job = backup.job || {};
  const running = Boolean(job.running);
  const starting = !running && Date.now() < state.backupStartingUntil;
  const visible = running || starting || Date.now() < state.backupNoticeUntil;
  if (!visible) return "";

  const stage = starting
    ? {
        tone: "running",
        title: "正在启动备份",
        detail: "准备保存世界，然后压缩本机存档。",
        percent: 5,
        label: "启动中",
        progressLabel: "准备中",
      }
    : backupStage(config, job);
  const title = running || starting
    ? "正在备份存档"
    : stage.tone === "bad"
      ? "备份失败"
      : "备份完成";
  return `
    <aside class="backup-hud ${stage.tone}" aria-live="polite">
      <div class="backup-hud-orb" aria-hidden="true"></div>
      <div class="backup-hud-copy">
        <div class="backup-hud-head">
          <span>本机备份</span>
          <strong>${escapeHTML(stage.progressLabel)}</strong>
        </div>
        <b>${escapeHTML(title)}</b>
        <small>${escapeHTML(stage.title)}</small>
        <p>${escapeHTML(stage.detail)}</p>
        <div class="backup-hud-progress">
          <i><em style="width:${Math.max(0, Math.min(100, stage.percent))}%"></em></i>
        </div>
      </div>
    </aside>
  `;
}

function renderNetworkOverview(data) {
  if (data.loading) return renderSkeletonWidget("entries");
  return `
    <div class="network-stack compact-network">
      ${renderEntriesWidget(data, { prefs: { chart: true } })}
    </div>
  `;
}

function renderPlayerTotalsStrip(data) {
  const totals = data.stats?.players?.totals || {};
  const activity = data.stats?.activity || {};
  const last24h = activity.last_24h || {};
  const fake = data.stats?.players?.fake || {};
  return renderFactGrid([
    renderFact("玩家总游玩", `${totals.play_hours || 0}h`, "不含假人"),
    renderFact("玩家总移动", `${totals.distance_km || 0}km`, "不含假人"),
    renderFact("当前假人", fake.active || 0, "正在运行"),
    renderFact("上线人数", last24h.unique_joined || 0, "24h · 不含假人"),
    renderFact("加入次数", last24h.join_events || 0, "24h · 不含假人"),
  ], "player-summary-facts");
}

function renderConfigSummary(data) {
  const props = data.properties || {};
  return renderFactGrid([
    renderFact("端口", props["server-port"] || "--", "server-port"),
    renderFact("难度", props.difficulty || "--", "difficulty"),
    renderFact("模式", props.gamemode || "--", "gamemode"),
    renderFact("最大人数", props["max-players"] || "--", "max-players"),
    renderFact("正版验证", props["online-mode"] || "--", "online-mode"),
    renderFact("PVP", props.pvp || "--", "pvp"),
  ], "config-summary-facts");
}

function barMeter(label, value, detail, percent, tone = "", subtext = "") {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const hasDetail = Boolean(detail);
  return `
    <div class="meter-row ${tone} ${hasDetail ? "" : "no-detail"}">
      <div>
        <span>${escapeHTML(label)}</span>
        <b>${escapeHTML(value ?? "--")}</b>
        ${subtext ? `<small class="meter-subtext">${escapeHTML(subtext)}</small>` : ""}
      </div>
      <i><em style="width:${safePercent}%"></em></i>
      ${hasDetail ? `<small>${escapeHTML(detail)}</small>` : ""}
    </div>
  `;
}

function renderRuntimePanel(data) {
  const java = data.process_stats?.java?.[0] || {};
  const tunnel = data.process_stats?.tunnel?.[0] || {};
  const panel = data.process_stats?.panel?.[0] || {};
  const load = data.stats?.system?.load || [];
  const cores = data.stats?.system?.cores || 1;
  const memoryPercent = javaMemoryPercent(data, java);
  return `
    <div class="meter-list">
      ${barMeter("Java CPU", formatPercent(java.cpu_percent), "", java.cpu_percent, "teal")}
      ${barMeter("Java 内存", javaMemoryMeterValue(data, java), "", memoryPercent, "blue", javaMemoryMeterSubtext(data))}
      ${renderLoadPressure(load, cores)}
    </div>
    <div class="mini-grid dense">
      ${metricCard("Java PID", java.pid || "--", "purpur")}
      ${metricCard("隧道 PID", tunnel.pid || "--", tunnel.etime ? `运行 ${formatEtime(tunnel.etime)}` : "ssh")}
      ${metricCard("面板 PID", panel.pid || "--", panel.etime ? `运行 ${formatEtime(panel.etime)}` : "panel")}
      ${metricCard("TCP 连接", data.stats?.connections?.established ?? "--", "established")}
    </div>
  `;
}

function renderRestartGuide(data) {
  const pending = state.restartPending;
  const serverRunning = Boolean(data.running?.server);
  return `
    <div class="restart-guide ${pending ? "pending" : "clean"}">
      <div class="restart-copy">
        <span>${pending ? "有改动待生效" : "配置状态"}</span>
        <b>${pending ? "保存成功，重启 JE 后才会真正进入游戏" : "当前没有待重启的配置改动"}</b>
        <small>${pending ? "server.properties 和插件文件在磁盘上已经改好；Minecraft 需要重启才会重新读取。" : "保存配置或开关插件后，这里会自动变成重启引导。"}</small>
      </div>
      <div class="restart-flow" aria-label="重启生效步骤">
        <span class="${pending ? "done" : ""}">保存</span>
        <i></i>
        <span class="${pending ? "now" : ""}">重启 JE</span>
        <i></i>
        <span>生效</span>
      </div>
      <button data-action="restart_server" class="primary-action" type="button" ${state.busy || !serverRunning || !pending ? "disabled" : ""}>
        ${pending ? (serverRunning ? "重启 JE 并应用改动" : "JE 未运行") : "当前无需重启"}
      </button>
    </div>
  `;
}

function renderMiniSignal(label, value, detail, tone = "ok") {
  return `
    <div class="mini-signal ${tone}">
      <span>${escapeHTML(label)}</span>
      <b>${escapeHTML(value)}</b>
      <small>${escapeHTML(detail)}</small>
    </div>
  `;
}

function renderCommandCenter(data) {
  const local = localStatus(data);
  const props = data.properties || {};
  const players = local.ok ? `${local.online}/${local.max}` : "--/--";
  const serverRunning = Boolean(data.running?.server);
  const tunnelRunning = Boolean(data.running?.tunnel);
  const beijing = (data.minecraft || []).find((entry) => entry.host === "playje.unmcserver.com");
  const la = (data.minecraft || []).find((entry) => entry.host === "la.playje.unmcserver.com");
  const publicOk = Boolean(beijing?.ok) && Boolean(la?.ok);
  const headline = serverRunning && tunnelRunning ? "Java 生存服正在运行" : serverRunning ? "服务器在线，入口需检查" : "服务器未运行";
  const routeState = publicOk ? "公网入口正常" : beijing?.ok ? "北京入口可用，LA 状态握手未返回" : "公网入口需检查";
  return `
    <section class="command-center" aria-label="服务器驾驶舱">
      <div class="center-copy">
        <span>UN Java 生存服 · Mac mini</span>
        <h1>${escapeHTML(headline)}</h1>
        <p>${escapeHTML(`${routeState} · ${props.motd || "The Retards Season4 hosted by unmcserver.com"}`)}</p>
      </div>
      <div class="center-signals">
        ${renderMiniSignal("JE", serverRunning ? "运行中" : "未运行", props.gamemode ? `${props.gamemode} / ${props.difficulty || "--"}` : "等待采样", serverRunning ? "ok" : "bad")}
        ${renderMiniSignal("隧道", tunnelRunning ? "已连接" : "未连接", publicOk ? "公网入口正常" : "检查入口", tunnelRunning ? "ok" : "warn")}
        ${renderMiniSignal("玩家", players, local.version || "Purpur", Number(local.online || 0) > 0 ? "blue" : "neutral")}
        ${renderMiniSignal("北京入口", beijing?.ok ? `${beijing.latency_ms}ms` : "异常", "playje.unmcserver.com", beijing?.ok ? "blue" : "bad")}
        ${renderMiniSignal("LA 入口", endpointValue(la), endpointDetail(la, "la.playje.unmcserver.com"), la?.ok ? "warm" : "warn")}
      </div>
      <div class="center-actions">
        <button class="quick-action save" data-console="save-all" type="button" ${state.busy || !serverRunning ? "disabled" : ""}>保存世界</button>
        <button class="quick-action list" data-console="list" type="button" ${state.busy || !serverRunning ? "disabled" : ""}>在线玩家</button>
        <button class="quick-action restart ${state.restartPending ? "attention" : ""}" data-action="restart_server" type="button" ${state.busy || !serverRunning ? "disabled" : ""}>重启 JE</button>
        <button class="quick-action tunnel" data-action="restart_tunnel" type="button" ${state.busy ? "disabled" : ""}>重启隧道</button>
      </div>
    </section>
  `;
}

function renderOverviewSection(data) {
  return renderPanelSection(
    "overview",
    "运行状态",
    `
      <div class="overview-layout">
        <div class="overview-column">
          ${renderCalmCard("服务器", "可进服吗", data.loading ? renderSkeletonWidget("status") : renderStatusOverview(data))}
          ${renderCalmCard("机器负载", "Mac mini", data.loading ? renderSkeletonWidget("resources") : renderRuntimeOverview(data))}
        </div>
        <div class="overview-column">
          ${renderCalmCard("入口延迟", "域名连接", renderNetworkOverview(data))}
          ${renderCalmCard("存档文件", "世界", data.loading ? renderSkeletonWidget("world") : renderWorldOverview(data))}
        </div>
      </div>
    `,
    "section-clean"
  );
}

function renderPlayersSection(data) {
  const playerBody = data.loading ? renderSkeletonWidget("players") : renderPlayersWidget(data);
  const totalsBody = data.loading ? renderSkeletonWidget("totals") : renderPlayerTotalsStrip(data);
  const leaderboardBody = data.loading ? renderSkeletonWidget("leaderboards") : renderLeaderboardsWidget(data);
  const badgesBody = data.loading ? renderSkeletonWidget("achievements") : renderAchievementsWidget(data);
  const itemsBody = data.loading ? renderSkeletonWidget("items") : renderItemsWidget(data);
  const chatBody = data.loading ? renderSkeletonWidget("chat") : renderChatWidget(data);
  return renderPanelSection(
    "players",
    "玩家数据",
    `
      <div class="calm-grid calm-grid-two">
        ${renderCalmCard("在线与历史", "玩家", playerBody, "span-6 player-card-overview")}
        ${renderCalmCard("全服概览", "统计", totalsBody, "span-6 player-card-totals")}
        ${renderCalmCard("排行榜", "榜单", leaderboardBody, "span-12")}
        ${renderCalmCard("成就墙", "高光", badgesBody, "span-4")}
        ${renderCalmCard("物品热点", "世界", itemsBody, "span-4")}
        ${renderCalmCard("最近聊天", "聊天", chatBody, "span-4")}
      </div>
    `,
    "section-clean"
  );
}

function renderControlSection(data) {
  const terminalBody = data.loading
    ? `${renderSkeletonWidget("logs")}${renderSkeletonWidget("controls")}`
    : `<div class="terminal-stack">${renderLogsWidget()}<div class="command-dock">${renderControlsWidget()}</div></div>`;
  return renderPanelSection(
    "control",
    "终端命令",
    `
      <div class="calm-grid calm-grid-two">
        ${renderCalmCard("服务器终端", "控制", terminalBody, "span-12 terminal-card")}
        ${renderCalmCard("运行会话", "进程", data.loading ? renderSkeletonWidget("sessions") : renderSessionsWidget(data), "span-12")}
      </div>
    `,
    "section-clean"
  );
}

function renderConfigSection(data) {
  const pluginBody = data.loading ? renderSkeletonWidget("plugins") : renderPluginsWidget(data);
  const configBody = data.loading ? renderSkeletonWidget("config") : renderConfigWidget(data);
  const worldBody = data.loading ? renderSkeletonWidget("world") : renderWorldOverview(data);
  const backupBody = data.loading ? renderSkeletonWidget("world") : renderBackupWidget(data);
  return renderPanelSection(
    "config",
    "设置与备份",
    `
      <div class="calm-grid calm-grid-two">
        ${renderCalmCard("重启生效", "保存后提示", renderRestartGuide(data), "span-12")}
        ${renderCalmCard("当前规则", "摘要", data.loading ? renderSkeletonWidget("settings") : renderConfigSummary(data), "span-6")}
        ${renderCalmCard("插件", "启用状态", pluginBody, "span-6")}
        ${renderCalmCard("本机备份", "自动存档", backupBody, "span-12")}
        ${renderCalmCard("文件与存档", "世界", worldBody, "span-12")}
        ${renderCalmCard("图形化配置", "server.properties", configBody, "span-12")}
      </div>
    `,
    "section-clean"
  );
}

function renderFixedDashboard() {
  const data = dataOrEmpty();
  return `
    <div class="panel-scroll-page">
      ${renderOverviewSection(data)}
      ${renderPlayersSection(data)}
      ${renderControlSection(data)}
      ${renderConfigSection(data)}
    </div>
    ${renderBackupHud(data)}
    ${renderConfirmDialog()}
  `;
}

function renderConfirmDialog() {
  const confirmation = state.confirmation;
  if (!confirmation) return "";
  return `
    <div class="confirm-scrim" role="presentation" data-confirm-cancel></div>
    <section class="confirm-dialog ${confirmation.danger ? "danger" : ""}" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmBody">
      <div class="confirm-mark" aria-hidden="true"></div>
      <div class="confirm-copy">
        <span>${confirmation.danger ? "需要确认" : "操作确认"}</span>
        <h2 id="confirmTitle">${escapeHTML(confirmation.title)}</h2>
        <p id="confirmBody">${escapeHTML(confirmation.body)}</p>
      </div>
      <div class="confirm-actions">
        <button type="button" class="ghost-action" data-confirm-cancel>取消</button>
        <button type="button" class="confirm-action ${confirmation.danger ? "danger" : ""}" data-confirm-run>${escapeHTML(confirmation.confirm || "确认")}</button>
      </div>
    </section>
  `;
}

function renderWidget(entry, editing = state.editing) {
  const definition = WIDGETS[entry.type];
  if (!definition) return "";
  const data = dataOrEmpty();
  const body = data.loading ? renderSkeletonWidget(entry.type) : definition.render(data, entry);
  const options = sizeOptions(entry.type);
  const sizeIndex = options.indexOf(entry.size);
  const canShrink = sizeIndex > 0;
  const canGrow = sizeIndex < options.length - 1;
  const prefs = entry.prefs || {};
  const density = prefs.density === "compact" ? "compact" : "normal";
  const chrome = prefs.chrome === "minimal" ? "minimal" : "full";
  return `
    <section class="widget widget-${entry.size} density-${density} chrome-${chrome}" data-widget-id="${entry.id}" data-widget-type="${entry.type}" style="${widgetStyle(entry, editing)}">
      <div class="widget-titlebar">
        <div>
          <span>${escapeHTML(definition.category)}</span>
          <h2>${escapeHTML(definition.title)}</h2>
        </div>
        <div class="widget-actions">
          <button type="button" data-widget-customize title="自定义组件">•••</button>
          <button type="button" data-widget-size="down" ${canShrink ? "" : "disabled"} title="缩小">−</button>
          <button type="button" data-widget-size="up" ${canGrow ? "" : "disabled"} title="放大">＋</button>
          <button type="button" data-widget-delete title="删除组件">×</button>
        </div>
      </div>
      ${renderCustomizer(entry)}
      <div class="widget-body">${body}</div>
      <span class="resize-handle resize-nw" data-resize-corner="nw" title="拖动调整大小"></span>
      <span class="resize-handle resize-ne" data-resize-corner="ne" title="拖动调整大小"></span>
      <span class="resize-handle resize-sw" data-resize-corner="sw" title="拖动调整大小"></span>
      <span class="resize-handle resize-se" data-resize-corner="se" title="拖动调整大小"></span>
    </section>
  `;
}

function renderCustomizer(entry) {
  if (!entry.prefs?.open) return "";
  const density = entry.prefs.density === "compact" ? "compact" : "normal";
  const chrome = entry.prefs.chrome === "minimal" ? "minimal" : "full";
  const chartToggle = entry.type === "entries"
    ? `<button type="button" data-widget-pref="chart" data-pref-value="${entry.prefs.chart === false ? "true" : "false"}">${entry.prefs.chart === false ? "显示图表" : "隐藏图表"}</button>`
    : "";
  return `
    <div class="widget-customizer">
      <span>组件设置</span>
      <div class="segmented">
        <button type="button" data-widget-pref="density" data-pref-value="normal" class="${density === "normal" ? "active" : ""}">标准</button>
        <button type="button" data-widget-pref="density" data-pref-value="compact" class="${density === "compact" ? "active" : ""}">紧凑</button>
      </div>
      <div class="segmented">
        <button type="button" data-widget-pref="chrome" data-pref-value="full" class="${chrome === "full" ? "active" : ""}">完整</button>
        <button type="button" data-widget-pref="chrome" data-pref-value="minimal" class="${chrome === "minimal" ? "active" : ""}">极简</button>
      </div>
      ${chartToggle}
    </div>
  `;
}

function renderDashboard(options = {}) {
  const dashboard = $("#dashboard");
  const silent = Boolean(options.silent);
  const hadContent = Boolean(dashboard.innerHTML.trim());
  const previousScroll = Number.isFinite(options.fallbackTop) ? options.fallbackTop : window.scrollY;
  const previousAnchor = options.scrollAnchor || captureScrollAnchor();
  const previousHeight = dashboard.offsetHeight;
  const consoleFocus = captureConsoleFocus();
  if (silent) {
    window.clearTimeout(silentRenderTimer);
    dashboard.classList.add("is-silent-render");
    if (hadContent) dashboard.style.minHeight = `${Math.max(previousHeight, 320)}px`;
  }
  state.editing = false;
  dashboard.classList.remove("is-editing");
  dashboard.classList.add("fixed-dashboard", "is-arranged");
  dashboard.innerHTML = renderFixedDashboard();
  dashboard.style.height = "";
  document.body.classList.remove("editing");
  document.body.classList.toggle("confirming", Boolean(state.confirmation));
  const editButton = $("#editLayoutBtn");
  if (editButton) editButton.textContent = "编辑布局";
  const editStrip = $("#editStrip");
  if (editStrip) editStrip.hidden = true;
  syncLogScrollAfterRender();
  restoreConsoleFocus(consoleFocus);
  if (state.confirmation) window.requestAnimationFrame(focusConfirmDialog);
  if (!hadContent || Date.now() < initialScrollDeadline) {
    window.requestAnimationFrame(resetInitialScroll);
  }
  if (silent) {
    if (hadContent) restoreScrollAnchor(previousAnchor, previousScroll);
    window.requestAnimationFrame(() => {
      if (hadContent) restoreScrollAnchor(previousAnchor, previousScroll);
      window.requestAnimationFrame(() => {
        if (hadContent) restoreScrollAnchor(previousAnchor, previousScroll);
        silentRenderTimer = window.setTimeout(() => {
          dashboard.classList.remove("is-silent-render");
          dashboard.style.minHeight = "";
          restoreScrollAnchor(previousAnchor, previousScroll);
          window.requestAnimationFrame(() => restoreScrollAnchor(previousAnchor, previousScroll));
        }, 520);
      });
    });
  }
}

function focusConfirmDialog() {
  const dialog = $(".confirm-dialog");
  if (!dialog) return;
  const cancelButton = dialog.querySelector("[data-confirm-cancel]");
  cancelButton?.focus({ preventScroll: true });
}

function renderViewSwitcher() {
  const switcher = $("#viewSwitcher");
  if (!switcher) return;
  const marks = {
    overview: "状态",
    players: "玩家",
    control: "终端",
    config: "设置",
  };
  const refreshButton = `
    <button id="directoryRefresh" class="view-tab directory-refresh" data-refresh type="button" ${state.busy ? "disabled" : ""}>
      <i aria-hidden="true">↻</i>
      <span>
        <b>刷新</b>
        <small>重新检测</small>
      </span>
    </button>
  `;
  const tabs = VIEW_ORDER.map((id, index) => {
    const view = DASHBOARD_VIEWS[id];
    const active = id === activeViewId();
    return `
      <a class="view-tab directory-tab ${active ? "active" : ""}" href="#${escapeHTML(id)}" data-jump="#${escapeHTML(id)}" ${active ? 'aria-current="location"' : ""}>
        <i>${escapeHTML(marks[id] || String(index + 1))}</i>
        <span>
          <b>${escapeHTML(view.label)}</b>
          <small>${escapeHTML(view.detail)}</small>
        </span>
      </a>
    `;
  }).join("");
  switcher.innerHTML = `${refreshButton}${tabs}`;
}

function updateViewSwitcherActive() {
  const switcher = $("#viewSwitcher");
  if (!switcher) return;
  switcher.querySelectorAll("[data-jump]").forEach((link) => {
    const id = link.dataset.jump.replace(/^#/, "");
    const active = id === activeViewId();
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  switcher.querySelectorAll("[data-refresh]").forEach((button) => {
    button.disabled = state.busy;
  });
}

function renderLibrary() {
  const activeTypes = new Set(state.layout.map((entry) => entry.type));
  const currentOrder = new Map(activeViewTypes().map((type, index) => [type, index]));
  const nodes = Object.entries(WIDGETS)
    .sort(([leftType], [rightType]) => {
      const leftOrder = currentOrder.get(leftType) ?? 100 + (DEFAULT_TYPE_ORDER.get(leftType) ?? 99);
      const rightOrder = currentOrder.get(rightType) ?? 100 + (DEFAULT_TYPE_ORDER.get(rightType) ?? 99);
      return leftOrder - rightOrder;
    })
    .map(([type, definition]) => {
      const active = activeTypes.has(type);
      const inView = currentOrder.has(type);
      return `
        <button class="library-item" data-add-widget="${type}" type="button" ${active ? "disabled" : ""}>
          <b>${escapeHTML(definition.title)}</b>
          <span>${escapeHTML(definition.category)}${inView ? " · 当前视图" : ""}${active ? " · 已在面板" : ""}</span>
        </button>
      `;
    })
    .join("");
  $("#libraryList").innerHTML = nodes;
  $("#libraryCount").textContent = `${Object.keys(WIDGETS).length} 个组件`;
}

function consoleInputNode() {
  return $("#consoleCommand");
}

function consoleInputActive() {
  const input = consoleInputNode();
  return Boolean(input && document.activeElement === input);
}

function shouldHoldConsoleRender() {
  return state.consoleComposing || consoleInputActive();
}

function captureConsoleFocus() {
  const input = consoleInputNode();
  if (!input) return null;
  state.consoleCommand = input.value;
  if (document.activeElement !== input) return null;
  return {
    focused: true,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
  };
}

function restoreConsoleFocus(snapshot) {
  if (!snapshot?.focused) return;
  const input = consoleInputNode();
  if (!input) return;
  input.focus({ preventScroll: true });
  const length = input.value.length;
  const start = Math.min(snapshot.selectionStart ?? length, length);
  const end = Math.min(snapshot.selectionEnd ?? start, length);
  try {
    input.setSelectionRange(start, end);
  } catch {
    // Some browser/input states reject selection updates; keeping focus is enough.
  }
}

function flushPendingConsoleRender() {
  if (!state.pendingConsoleRender || shouldHoldConsoleRender()) return;
  state.pendingConsoleRender = false;
  renderAllPreservingScroll({ silent: true });
}

function renderAll(options = {}) {
  if (options.silent && $("#viewSwitcher")?.children.length) updateViewSwitcherActive();
  else renderViewSwitcher();
  renderDashboard(options);
}

function renderAllPreservingScroll(options = {}) {
  const left = window.scrollX;
  const top = window.scrollY;
  renderAll(options);
  const restore = () => window.scrollTo({ left, top, behavior: "auto" });
  restore();
  window.requestAnimationFrame(restore);
}

function logScrollState(target = state.logTarget) {
  if (!state.logScroll[target]) state.logScroll[target] = { pinned: true, top: 0 };
  return state.logScroll[target];
}

function logDistanceFromBottom(box) {
  return box.scrollHeight - box.clientHeight - box.scrollTop;
}

function logPinnedToBottom(box) {
  return logDistanceFromBottom(box) <= LOG_BOTTOM_THRESHOLD;
}

function logLatestHintMarkup() {
  return `
    <button class="log-latest-hint" data-log-latest type="button" title="回到最新日志">
      <i aria-hidden="true">↓</i>
      <span>不在最新</span>
    </button>
  `;
}

function syncLogHint(box = $("#logBox")) {
  if (!box) return;
  const frame = box.closest(".log-frame");
  if (!frame) return;
  const held = !logScrollState(box.dataset.logTarget || state.logTarget).pinned;
  frame.classList.toggle("is-held", held);
  const hint = frame.querySelector("[data-log-latest]");
  if (held && !hint) frame.insertAdjacentHTML("beforeend", logLatestHintMarkup());
  if (!held && hint) hint.remove();
}

function captureCurrentLogScroll(box = $("#logBox")) {
  if (!box || restoringLogScroll) return;
  const current = logScrollState(box.dataset.logTarget || state.logTarget);
  current.top = box.scrollTop;
  current.pinned = logPinnedToBottom(box);
  syncLogHint(box);
  if (!current.pinned && box.scrollTop <= LOG_TOP_THRESHOLD) {
    scheduleLoadOlderLogs();
  }
}

function syncLogScrollAfterRender(options = {}) {
  const box = $("#logBox");
  if (!box) return;
  const current = logScrollState(box.dataset.logTarget || state.logTarget);
  restoringLogScroll = true;
  if (options.forceBottom || current.pinned) {
    box.scrollTop = box.scrollHeight;
    current.pinned = true;
    current.top = box.scrollTop;
  } else {
    const maxTop = Math.max(0, box.scrollHeight - box.clientHeight);
    box.scrollTop = Math.min(current.top, maxTop);
  }
  syncLogHint(box);
  window.requestAnimationFrame(() => {
    restoringLogScroll = false;
    captureCurrentLogScroll(box);
  });
}

function jumpLogToLatest() {
  const current = logScrollState();
  current.pinned = true;
  current.top = 0;
  syncLogScrollAfterRender({ forceBottom: true });
}

function scheduleLoadOlderLogs() {
  if (state.logLoadingOlder || !state.logHasMore[state.logTarget]) return;
  window.clearTimeout(logOlderLoadTimer);
  logOlderLoadTimer = window.setTimeout(loadOlderLogs, 80);
}

function captureScrollAnchor() {
  const sections = Array.from(document.querySelectorAll(".panel-section[id]"));
  if (!sections.length) return { top: window.scrollY };
  const threshold = window.scrollY + sectionScrollOffset() + 8;
  let current = null;
  sections.forEach((section) => {
    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    if (sectionTop <= threshold) {
      current = {
        id: section.id,
        offset: window.scrollY - sectionTop,
      };
    }
  });
  return current || { top: window.scrollY };
}

function restoreScrollAnchor(anchor, fallbackTop = window.scrollY) {
  if (anchor?.id) {
    const target = document.getElementById(anchor.id);
    if (target) {
      const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY + anchor.offset);
      window.scrollTo({ top, left: window.scrollX, behavior: "auto" });
      return;
    }
  }
  window.scrollTo({ top: anchor?.top ?? fallbackTop, left: window.scrollX, behavior: "auto" });
}

function sectionScrollOffset() {
  const topbar = $(".topbar");
  const switcher = $("#viewSwitcher");
  const topbarHeight = topbar?.getBoundingClientRect().height || 0;
  const switcherStyle = switcher ? getComputedStyle(switcher) : null;
  const switcherHeight = switcherStyle?.position === "sticky" ? switcher.getBoundingClientRect().height : 0;
  return Math.round(topbarHeight + switcherHeight + 26);
}

function scrollToSection(target, preferredBehavior = "smooth") {
  if (!target) return;
  const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - sectionScrollOffset());
  const distance = Math.abs(window.scrollY - top);
  const behavior = distance > window.innerHeight * 1.4 ? "auto" : preferredBehavior;
  window.scrollTo({ top, behavior });
}

function settleScrollToSection(sectionId) {
  const target = document.getElementById(sectionId);
  if (!target) return;
  const settle = () => {
    scrollToSection(target, "auto");
    updateActiveViewFromScroll();
  };
  window.requestAnimationFrame(settle);
  window.setTimeout(settle, 260);
  window.setTimeout(settle, 950);
}

function updateActiveViewFromScroll() {
  const sections = Array.from(document.querySelectorAll(".panel-section[id]"));
  if (!sections.length) return;
  const threshold = window.scrollY + sectionScrollOffset() + 34;
  let current = "overview";
  sections.forEach((section) => {
    const top = section.getBoundingClientRect().top + window.scrollY;
    if (top <= threshold && DASHBOARD_VIEWS[section.id]) current = section.id;
  });
  if (current !== activeViewId()) {
    state.activeView = current;
    renderViewSwitcher();
  }
}

function scheduleScrollSpy() {
  window.cancelAnimationFrame(scrollSpyFrame);
  scrollSpyFrame = window.requestAnimationFrame(updateActiveViewFromScroll);
}

function applyDisplayMasonry() {
  const dashboard = $("#dashboard");
  if (!dashboard) return;
  if (state.editing) {
    dashboard.classList.add("is-arranged");
    return;
  }
  const width = dashboard.clientWidth || stageWidth();
  const columns = flowColumns(width);
  dashboard.style.setProperty("--flow-columns", columns);
  if (columns <= 1) {
    dashboard.style.height = "";
    dashboard.querySelectorAll(".widget").forEach((node) => {
      node.style.removeProperty("--flow-x");
      node.style.removeProperty("--flow-y");
      node.style.removeProperty("--flow-w");
    });
    dashboard.classList.add("is-arranged");
    return;
  }
  const gap = FLOW_GAP;
  const colWidth = (width - gap * (columns - 1)) / columns;
  const widgets = Array.from(dashboard.querySelectorAll(".widget"));
  if (!widgets.length) {
    dashboard.style.height = "";
    dashboard.classList.add("is-arranged");
    return;
  }

  const spans = widgets.map((node) => {
    const requested = Number(node.style.getPropertyValue("--flow-span")) || 1;
    return Math.max(1, Math.min(columns, Math.round(requested)));
  });

  widgets.forEach((node, index) => {
    const span = spans[index];
    const widgetWidth = span * colWidth + (span - 1) * gap;
    node.style.setProperty("--flow-w", `${widgetWidth}px`);
  });

  const columnHeights = Array(columns).fill(0);
  widgets.forEach((node, index) => {
    const span = spans[index];
    let bestCol = 0;
    let bestY = Infinity;
    for (let col = 0; col <= columns - span; col += 1) {
      const y = Math.max(...columnHeights.slice(col, col + span));
      if (y < bestY) {
        bestY = y;
        bestCol = col;
      }
    }
    const x = bestCol * (colWidth + gap);
    const y = Number.isFinite(bestY) ? bestY : 0;
    node.style.setProperty("--flow-x", `${x}px`);
    node.style.setProperty("--flow-y", `${y}px`);
    const height = node.offsetHeight;
    for (let col = bestCol; col < bestCol + span; col += 1) {
      columnHeights[col] = y + height + gap;
    }
  });

  const height = Math.max(...columnHeights, 320) - gap;
  dashboard.style.height = `${Math.max(320, height)}px`;
  dashboard.classList.add("is-arranged");
  syncLogScrollAfterRender();
}

function scheduleDisplayMasonry() {
  if (state.editing) return;
  window.cancelAnimationFrame(masonryFrame);
  masonryFrame = window.requestAnimationFrame(() => {
    applyDisplayMasonry();
    window.requestAnimationFrame(applyDisplayMasonry);
  });
}

function observeDisplayMasonry() {
  masonryResizeObserver?.disconnect();
  masonryResizeObserver = null;
  if (state.editing || !("ResizeObserver" in window)) return;
  const dashboard = $("#dashboard");
  if (!dashboard) return;
  masonryResizeObserver = new ResizeObserver(() => scheduleDisplayMasonry());
  dashboard.querySelectorAll(".widget").forEach((node) => masonryResizeObserver.observe(node));
}

function openLibrary() {
  $("#libraryDrawer").classList.add("open");
  $("#libraryDrawer").setAttribute("aria-hidden", "false");
  $("#drawerScrim").hidden = false;
}

function closeLibrary() {
  $("#libraryDrawer").classList.remove("open");
  $("#libraryDrawer").setAttribute("aria-hidden", "true");
  $("#drawerScrim").hidden = true;
}

function addWidget(type) {
  if (!WIDGETS[type] || state.layout.some((entry) => entry.type === type)) return;
  const entry = normalizeEntry(item(type));
  const metrics = gridMetrics();
  entry.grid.col = Math.min(state.layout.length % metrics.columns, Math.max(0, metrics.columns - entry.grid.colSpan));
  entry.grid.row = Math.max(0, Math.round((window.scrollY - ($("#dashboard")?.getBoundingClientRect().top || 0) + 24) / metrics.stepY));
  entry.grid = clampGrid(entry.grid);
  entry.rect = rectFromGrid(entry.grid);
  state.layout.push(entry);
  saveLayout();
  renderAll();
  window.requestAnimationFrame(() => {
    const node = document.querySelector(`[data-widget-id="${entry.id}"]`);
    node?.classList.add("is-new");
    window.setTimeout(() => node?.classList.remove("is-new"), 420);
  });
}

function deleteWidget(id) {
  const node = document.querySelector(`[data-widget-id="${id}"]`);
  node?.classList.add("is-removing");
  window.setTimeout(() => {
    state.layout = state.layout.filter((entry) => entry.id !== id);
    saveLayout();
    renderAll();
  }, node ? 180 : 0);
}

function resizeWidget(id, direction) {
  const entry = state.layout.find((itemEntry) => itemEntry.id === id);
  if (!entry) return;
  const options = sizeOptions(entry.type);
  const index = Math.max(0, options.indexOf(entry.size));
  const next = direction === "up" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
  entry.size = options[next];
  const span = sizeGrid(entry.type, entry.size);
  entry.grid = clampGrid({ ...entry.grid, colSpan: span.cols, rowSpan: span.rows });
  entry.rect = rectFromGrid(entry.grid);
  saveLayout();
  renderAll();
}

function setWidgetPref(id, key, value) {
  const entry = state.layout.find((itemEntry) => itemEntry.id === id);
  if (!entry) return;
  entry.prefs = entry.prefs || {};
  if (key === "chart") {
    entry.prefs.chart = value === "true";
  } else {
    entry.prefs[key] = value;
  }
  saveLayout();
  renderAll();
}

function toggleCustomizer(id) {
  const entry = state.layout.find((itemEntry) => itemEntry.id === id);
  if (!entry) return;
  entry.prefs = entry.prefs || {};
  entry.prefs.open = !entry.prefs.open;
  saveLayout();
  renderAll();
}

function updateWidgetElement(entry) {
  const node = document.querySelector(`[data-widget-id="${entry.id}"]`);
  if (!node) return;
  node.style.setProperty("--x", `${entry.rect.x}px`);
  node.style.setProperty("--y", `${entry.rect.y}px`);
  node.style.setProperty("--w", `${entry.rect.w}px`);
  node.style.setProperty("--h", `${entry.rect.h}px`);
  node.style.setProperty("--z", entry.z || 1);
  SIZE_ORDER.forEach((size) => node.classList.toggle(`widget-${size}`, entry.size === size));
  $("#dashboard").style.height = `${stageHeight(layoutForActiveView())}px`;
}

function resizeCornerFromPoint(widgetNode, clientX, clientY) {
  if (!state.editing) return "";
  const rect = widgetNode.getBoundingClientRect();
  const zone = 46;
  const nearLeft = clientX - rect.left <= zone;
  const nearRight = rect.right - clientX <= zone;
  const nearTop = clientY - rect.top <= zone;
  const nearBottom = rect.bottom - clientY <= zone;
  if (nearLeft && nearTop) return "nw";
  if (nearRight && nearTop) return "ne";
  if (nearLeft && nearBottom) return "sw";
  if (nearRight && nearBottom) return "se";
  return "";
}

function setFeedback(kind, title, body) {
  state.feedback = {
    kind,
    title,
    meta: feedbackTime(),
    body: body || "没有新的回执",
  };
  renderAll();
}

function requestConfirmation(config) {
  state.confirmation = {
    danger: false,
    ...config,
  };
  renderAllPreservingScroll();
}

function clearConfirmation() {
  state.confirmation = null;
  renderAllPreservingScroll();
}

function actionWithConfirmation(payload, config = null) {
  const confirmation = config || ACTION_CONFIRMATIONS[payload.action];
  if (!confirmation) {
    runAction(payload);
    return;
  }
  requestConfirmation({ ...confirmation, payload });
}

async function refreshStatus(options = {}) {
  if (options.visual) {
    window.clearTimeout(refreshVisualTimer);
    document.body.classList.add("refreshing");
    refreshVisualTimer = window.setTimeout(() => {
      document.body.classList.remove("refreshing");
    }, 950);
  }
  const data = await getJson("/api/status");
  state.latestData = data;
  updateBackupNotice(data);
  rememberLatency(data.minecraft || []);
  const beijingOk = (data.minecraft || []).some((entry) => entry.host === "playje.unmcserver.com" && entry.ok);
  document.title = `${data.running?.server && beijingOk ? "在线" : "检查"} · ${APP_TITLE}`;
  $("#lastUpdated").textContent = data.time || "--";
}

function backupIsRunning(data = state.latestData) {
  return Boolean(data?.backup?.job?.running);
}

function scheduleBackupNoticeDismiss() {
  window.clearTimeout(backupNoticeTimer);
  const wait = Math.max(0, state.backupNoticeUntil - Date.now());
  if (!wait) return;
  backupNoticeTimer = window.setTimeout(() => {
    if (backupIsRunning()) return;
    state.backupNoticeUntil = 0;
    state.backupStartingUntil = 0;
    renderAll({ silent: true });
  }, wait + 80);
}

function updateBackupNotice(data) {
  const running = backupIsRunning(data);
  if (running) {
    state.backupWasRunning = true;
    state.backupStartingUntil = 0;
    state.backupNoticeUntil = Date.now() + BACKUP_NOTICE_MS;
    scheduleBackupNoticeDismiss();
    return;
  }
  if (state.backupWasRunning) {
    state.backupWasRunning = false;
    state.backupNoticeUntil = Date.now() + BACKUP_NOTICE_MS;
    scheduleBackupNoticeDismiss();
  } else if (state.backupStartingUntil && Date.now() > state.backupStartingUntil) {
    state.backupStartingUntil = 0;
  }
}

function scheduleBackupProgressRefresh(data = state.latestData) {
  window.clearTimeout(backupPollTimer);
  if (!backupIsRunning(data) && Date.now() >= state.backupStartingUntil) return;
  backupPollTimer = window.setTimeout(() => {
    refreshAll({ backupPoll: true });
  }, BACKUP_REFRESH_MS);
}

async function refreshLogs(options = {}) {
  const target = state.logTarget;
  const current = logScrollState(target);
  if (!options.force && !current.pinned && state.latestLogs) return;
  const data = await getJson(`/api/logs?target=${encodeURIComponent(target)}&lines=${LOG_CHUNK_LINES}`);
  if (target !== state.logTarget) return;
  state.latestLogs = data.text || "";
  state.logCursor[target] = data.cursor || "";
  state.logHasMore[target] = Boolean(data.has_more);
  state.logStartDate[target] = data.start_date || "";
  state.logLoadingOlder = false;
  state.logHistoryError = "";
}

async function loadOlderLogs() {
  const target = state.logTarget;
  const cursor = state.logCursor[target];
  const box = $("#logBox");
  if (!box || state.logLoadingOlder || !state.logHasMore[target] || !cursor) return;

  const previousHeight = box.scrollHeight;
  const previousTop = box.scrollTop;
  state.logLoadingOlder = true;
  state.logHistoryError = "";
  renderAll({ silent: true });

  try {
    const data = await getJson(`/api/logs?target=${encodeURIComponent(target)}&lines=${LOG_CHUNK_LINES}&cursor=${encodeURIComponent(cursor)}`);
    if (target !== state.logTarget) return;
    const olderText = data.text || "";
    if (olderText) {
      const currentLogs = data.end_date === state.logStartDate[target]
        ? stripLeadingLogDateDivider(state.latestLogs, state.logStartDate[target])
        : state.latestLogs;
      state.latestLogs = `${olderText}${currentLogs ? "\n" : ""}${currentLogs}`;
    }
    state.logCursor[target] = data.cursor || "";
    state.logHasMore[target] = Boolean(data.has_more);
    state.logStartDate[target] = data.start_date || state.logStartDate[target] || "";
    state.logLoadingOlder = false;
    renderAll({ silent: true });
    window.requestAnimationFrame(() => {
      const nextBox = $("#logBox");
      if (!nextBox) return;
      restoringLogScroll = true;
      const delta = nextBox.scrollHeight - previousHeight;
      nextBox.scrollTop = previousTop + delta;
      const current = logScrollState(target);
      current.pinned = false;
      current.top = nextBox.scrollTop;
      syncLogHint(nextBox);
      window.requestAnimationFrame(() => {
        restoringLogScroll = false;
        captureCurrentLogScroll(nextBox);
      });
    });
  } catch (error) {
    state.logLoadingOlder = false;
    state.logHistoryError = `加载更早日志失败：${error.message}`;
    renderAll({ silent: true });
  }
}

async function refreshAll(options = {}) {
  const visual = Boolean(options.visual);
  try {
    await Promise.all([refreshStatus({ visual }), refreshLogs()]);
  } catch (error) {
    document.title = `离线 · ${APP_TITLE}`;
    state.latestData = state.latestData || dataOrEmpty();
    state.latestData.warnings = [`面板连接异常：${error.message}`];
  } finally {
    const userMovedAfterManualRefresh = visual
      && Number.isFinite(options.fallbackTop)
      && Math.abs(window.scrollY - options.fallbackTop) > 24;
    const firstDataRender = !initialDataRendered && state.latestData && !state.latestData.loading;
    if (firstDataRender) initialDataRendered = true;
    const scrollAnchor = firstDataRender
      ? { top: 0 }
      : userMovedAfterManualRefresh
        ? captureScrollAnchor()
        : options.scrollAnchor;
    const fallbackTop = firstDataRender ? 0 : userMovedAfterManualRefresh ? window.scrollY : options.fallbackTop;
    if (shouldHoldConsoleRender()) {
      state.pendingConsoleRender = true;
      scheduleBackupProgressRefresh(state.latestData);
      if (visual) {
        window.clearTimeout(refreshVisualTimer);
        window.setTimeout(() => {
          document.body.classList.remove("refreshing");
        }, 420);
      } else {
        document.body.classList.remove("refreshing");
      }
      return;
    }
    renderAll({
      silent: true,
      scrollAnchor,
      fallbackTop,
    });
    scheduleBackupProgressRefresh(state.latestData);
    if (visual) {
      window.clearTimeout(refreshVisualTimer);
      window.setTimeout(() => {
        document.body.classList.remove("refreshing");
      }, 420);
    } else {
      document.body.classList.remove("refreshing");
    }
  }
}

async function runAction(payload) {
  if (state.busy) return;
  if (payload.action === "backup_now") {
    state.backupStartingUntil = Date.now() + 8000;
    state.backupNoticeUntil = Date.now() + 8000;
    scheduleBackupNoticeDismiss();
  }
  state.busy = true;
  setFeedback("busy", "发送中", "等待服务器回执...");
  try {
    const data = await getJson("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: ACTION_TIMEOUT_MS,
    });
    const body = formatCommandResult(data.result);
    if (data.result?.ok && ["set_property", "toggle_plugin"].includes(payload.action)) {
      setRestartPending(true);
    }
    if (data.result?.ok && ["restart_server", "start_all"].includes(payload.action)) {
      setRestartPending(false);
    }
    setFeedback(data.result?.ok ? "ok has-output" : "bad has-output", data.result?.ok ? "命令已送达" : "命令失败", body);
    if (payload.action === "backup_now" && !data.result?.ok) {
      state.backupStartingUntil = 0;
      state.backupNoticeUntil = 0;
    }
    await refreshAll();
  } catch (error) {
    setFeedback("bad has-output", "命令失败", `ERR\n${error.message}`);
  } finally {
    state.busy = false;
    renderAll();
    $("#consoleCommand")?.focus();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.target?.matches?.("#consoleCommand") && event.key === "Enter" && (event.isComposing || state.consoleComposing)) {
    event.preventDefault();
    return;
  }
  if (!state.confirmation || event.key !== "Escape") return;
  event.preventDefault();
  clearConfirmation();
});

document.addEventListener("input", (event) => {
  if (!event.target?.matches?.("#consoleCommand")) return;
  state.consoleCommand = event.target.value;
});

document.addEventListener("compositionstart", (event) => {
  if (!event.target?.matches?.("#consoleCommand")) return;
  state.consoleComposing = true;
});

document.addEventListener("compositionend", (event) => {
  if (!event.target?.matches?.("#consoleCommand")) return;
  state.consoleComposing = false;
  state.consoleCommand = event.target.value;
});

document.addEventListener("focusout", (event) => {
  if (!event.target?.matches?.("#consoleCommand")) return;
  state.consoleCommand = event.target.value;
  window.setTimeout(flushPendingConsoleRender, 0);
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#refreshBtn, [data-refresh]")) return;
  pendingRefreshAnchor = captureScrollAnchor();
  pendingRefreshTop = window.scrollY;
}, true);

document.addEventListener("scroll", (event) => {
  if (event.target?.id === "logBox") captureCurrentLogScroll(event.target);
}, true);

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-confirm-cancel]")) {
    clearConfirmation();
    return;
  }

  if (event.target.closest("[data-confirm-run]")) {
    const payload = state.confirmation?.payload;
    state.confirmation = null;
    renderAllPreservingScroll();
    if (payload) runAction(payload);
    return;
  }

  const jumpLink = event.target.closest("[data-jump]");
  if (jumpLink) {
    event.preventDefault();
    const target = document.querySelector(jumpLink.dataset.jump);
    const sectionId = jumpLink.dataset.jump.replace(/^#/, "");
    if (DASHBOARD_VIEWS[sectionId]) {
      state.activeView = sectionId;
      localStorage.setItem(VIEW_STORAGE_KEY, sectionId);
      renderViewSwitcher();
    }
    scrollToSection(target);
    settleScrollToSection(sectionId);
    return;
  }

  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    const nextView = viewButton.dataset.view;
    if (DASHBOARD_VIEWS[nextView] && nextView !== activeViewId()) {
      state.activeView = nextView;
      localStorage.setItem(VIEW_STORAGE_KEY, nextView);
      renderAll();
    }
    return;
  }

  const refreshButton = event.target.closest("#refreshBtn, [data-refresh]");
  if (refreshButton) {
    const scrollAnchor = pendingRefreshAnchor || captureScrollAnchor();
    const fallbackTop = Number.isFinite(pendingRefreshTop) ? pendingRefreshTop : window.scrollY;
    pendingRefreshAnchor = null;
    pendingRefreshTop = null;
    refreshButton.classList.remove("clicked");
    refreshButton.offsetWidth;
    refreshButton.classList.add("clicked");
    window.setTimeout(() => refreshButton.classList.remove("clicked"), 700);
    refreshButton.blur();
    restoreScrollAnchor(scrollAnchor, fallbackTop);
    window.requestAnimationFrame(() => restoreScrollAnchor(scrollAnchor, fallbackTop));
    refreshAll({ visual: true, scrollAnchor, fallbackTop });
    return;
  }

  if (event.target.closest("#editLayoutBtn")) {
    state.editing = !state.editing;
    renderAll();
    return;
  }

  if (event.target.closest("#openLibraryBtn")) {
    openLibrary();
    return;
  }

  if (event.target.closest("#closeLibraryBtn") || event.target.closest("#drawerScrim")) {
    closeLibrary();
    return;
  }

  if (event.target.closest("#resetLayoutBtn")) {
    resetLayout();
    return;
  }

  const addButton = event.target.closest("[data-add-widget]");
  if (addButton) {
    addWidget(addButton.dataset.addWidget);
    return;
  }

  const widget = event.target.closest("[data-widget-id]");
  const customizeButton = event.target.closest("[data-widget-customize]");
  if (widget && customizeButton) {
    toggleCustomizer(widget.dataset.widgetId);
    return;
  }

  const prefButton = event.target.closest("[data-widget-pref]");
  if (widget && prefButton) {
    setWidgetPref(widget.dataset.widgetId, prefButton.dataset.widgetPref, prefButton.dataset.prefValue);
    return;
  }

  const deleteButton = event.target.closest("[data-widget-delete]");
  if (widget && deleteButton) {
    deleteWidget(widget.dataset.widgetId);
    return;
  }

  const sizeButton = event.target.closest("[data-widget-size]");
  if (widget && sizeButton) {
    resizeWidget(widget.dataset.widgetId, sizeButton.dataset.widgetSize);
    return;
  }

  const logButton = event.target.closest("[data-log]");
  if (logButton) {
    captureCurrentLogScroll();
    state.logTarget = logButton.dataset.log;
    state.latestLogs = "";
    state.logLoadingOlder = false;
    state.logHistoryError = "";
    logScrollState(state.logTarget).pinned = true;
    refreshLogs({ force: true }).then(renderAll);
    return;
  }

  if (event.target.closest("[data-log-latest]")) {
    jumpLogToLatest();
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    actionWithConfirmation({ action: actionButton.dataset.action });
    return;
  }

  const consoleButton = event.target.closest("[data-console]");
  if (consoleButton) {
    runAction({ action: "console", command: consoleButton.dataset.console });
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.matches("[data-backup-form]")) {
    event.preventDefault();
    const form = event.target;
    runAction({
      action: "set_backup_config",
      enabled: form.elements.enabled.value === "true",
      mode: form.elements.mode.value,
      time: form.elements.time.value,
      interval_hours: form.elements.interval_hours.value,
      keep: form.elements.keep.value,
    });
    return;
  }
  if (event.target.matches("[data-config-form]")) {
    event.preventDefault();
    const key = event.target.elements.key.value;
    const value = event.target.elements.value.value;
    runAction({ action: "set_property", key, value });
    return;
  }
  if (!event.target.matches("#consoleForm")) return;
  event.preventDefault();
  if (state.consoleComposing) return;
  const input = $("#consoleCommand");
  const command = input.value.trim();
  if (!command) return;
  state.consoleCommand = "";
  state.pendingConsoleRender = false;
  input.value = "";
  runAction({ action: "console", command });
});

document.addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-plugin-toggle]");
  if (!toggle) return;
  const enabled = toggle.checked;
  actionWithConfirmation(
    {
      action: "toggle_plugin",
      file: toggle.dataset.pluginToggle,
      enabled,
    },
    {
      title: enabled ? "启用插件" : "停用插件",
      body: `${toggle.dataset.pluginToggle} 会被${enabled ? "启用" : "停用"}，但需要重启 JE 后才会真正生效。`,
      confirm: enabled ? "确认启用" : "确认停用",
      danger: true,
    }
  );
});

document.addEventListener("pointerdown", (event) => {
  if (!state.editing || event.button !== 0) return;
  const widgetNode = event.target.closest("[data-widget-id]");
  if (!widgetNode) return;
  const handle = event.target.closest("[data-resize-corner]");
  const corner = handle?.dataset.resizeCorner || resizeCornerFromPoint(widgetNode, event.clientX, event.clientY);
  if (!corner && event.target.closest("button, input, select, textarea, a, summary, label")) return;
  const entry = state.layout.find((itemEntry) => itemEntry.id === widgetNode.dataset.widgetId);
  if (!entry) return;
  const titlebar = event.target.closest(".widget-titlebar");
  if (!corner && !titlebar) return;
  event.preventDefault();
  entry.z = nextWidgetZ();
  updateWidgetElement(entry);
  widgetNode.setPointerCapture(event.pointerId);
  widgetNode.classList.add("is-moving");
  document.body.classList.add("stage-moving");
  state.interaction = {
    pointerId: event.pointerId,
    id: entry.id,
    mode: corner ? "resize" : "move",
    corner,
    startX: event.clientX,
    startY: event.clientY,
    rect: { ...entry.rect },
    grid: { ...entry.grid },
  };
});

document.addEventListener("pointermove", (event) => {
  const interaction = state.interaction;
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  const entry = state.layout.find((itemEntry) => itemEntry.id === interaction.id);
  if (!entry) return;
  const dx = event.clientX - interaction.startX;
  const dy = event.clientY - interaction.startY;
  const metrics = gridMetrics();
  if (interaction.mode === "move") {
    entry.grid = clampGrid({
      ...interaction.grid,
      col: Math.round((interaction.rect.x + dx) / metrics.stepX),
      row: Math.round((interaction.rect.y + dy) / metrics.stepY),
    });
    entry.rect = rectFromGrid(entry.grid);
  } else {
    let { x, y, w, h } = interaction.rect;
    if (interaction.corner.includes("e")) w += dx;
    if (interaction.corner.includes("s")) h += dy;
    if (interaction.corner.includes("w")) {
      x += dx;
      w -= dx;
    }
    if (interaction.corner.includes("n")) {
      y += dy;
      h -= dy;
    }
    const desiredCols = Math.max(1, Math.round((w + metrics.gap) / metrics.stepX));
    const desiredRows = Math.max(1, Math.round((h + metrics.gap) / metrics.stepY));
    const nextSize = nearestSizeName(entry.type, desiredCols, desiredRows);
    const span = sizeGrid(entry.type, nextSize);
    const right = interaction.grid.col + interaction.grid.colSpan;
    const bottom = interaction.grid.row + interaction.grid.rowSpan;
    entry.size = nextSize;
    entry.grid = clampGrid({
      col: interaction.corner.includes("w") ? right - span.cols : interaction.grid.col,
      row: interaction.corner.includes("n") ? bottom - span.rows : interaction.grid.row,
      colSpan: span.cols,
      rowSpan: span.rows,
    });
    entry.rect = rectFromGrid(entry.grid);
  }
  updateWidgetElement(entry);
});

function endPointerInteraction(event) {
  const interaction = state.interaction;
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  const node = document.querySelector(`[data-widget-id="${interaction.id}"]`);
  node?.classList.remove("is-moving");
  document.body.classList.remove("stage-moving");
  state.interaction = null;
  saveLayout();
  renderAll();
}

document.addEventListener("pointerup", endPointerInteraction);
document.addEventListener("pointercancel", endPointerInteraction);

function resetInitialScroll() {
  if (location.hash) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function scheduleInitialScrollReset() {
  window.clearTimeout(initialScrollTimer);
  initialScrollDeadline = Date.now() + 1800;
  resetInitialScroll();
  window.requestAnimationFrame(resetInitialScroll);
  [90, 260, 700, 1400].forEach((delay) => {
    window.setTimeout(resetInitialScroll, delay);
  });
  initialScrollTimer = window.setTimeout(() => {
    initialScrollDeadline = 0;
  }, 1820);
}

let resizeFrame = 0;
window.addEventListener("resize", () => {
  window.cancelAnimationFrame(resizeFrame);
  resizeFrame = window.requestAnimationFrame(() => renderDashboard());
});

window.addEventListener("scroll", scheduleScrollSpy, { passive: true });

state.layout = getLayout();
saveLayout();
renderAll();
scheduleInitialScrollReset();
scheduleScrollSpy();
refreshAll();

async function refreshLoop() {
  await refreshAll();
  window.setTimeout(refreshLoop, document.hidden ? HIDDEN_REFRESH_MS : ACTIVE_REFRESH_MS);
}

window.setTimeout(refreshLoop, ACTIVE_REFRESH_MS);
window.addEventListener("pageshow", scheduleInitialScrollReset, { once: true });
window.addEventListener("load", scheduleInitialScrollReset, { once: true });
