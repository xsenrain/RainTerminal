import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Fragment, memo, Profiler, startTransition, useSyncExternalStore } from 'react'
import { useDeferredValue } from 'react'
import { createContext, useContext } from 'react'
import { useLayoutEffect } from 'react'
import type { CSSProperties, MouseEvent, MutableRefObject, PointerEvent, ProfilerOnRenderCallback, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { convertFileAssetSrc, getCurrentWindow, invoke, isSandboxMode, listen } from './tauriBridge'
import {
  getCredentialVaultStatus,
  migrateAndHydrateCredentials,
  syncCredentials,
  type CredentialSecretRecord,
} from './credentialVault'
import { createMessageChannel, type RemoteDesktopConnection } from './ironRdpBridge'
import RemoteDesktopWidget from './RemoteDesktopWidget'
import MonitorUplot from './MonitorUplot'
import {
  cancelTransfer,
  canCancelTransfer,
  canRetryTransfer,
  clearFinishedTransfers,
  getTransfersSnapshot,
  retryTransfer,
  subscribeTransfers,
  upsertTransfer,
  type TransferRecord,
} from './operationsStore'
import {
  formatLocalizedDateTime,
  getSystemTimeZone,
  getTimeZoneOffsetLabel,
  resolveAppLanguage,
  translateUiText,
  type AppLanguage,
  type ResolvedLanguage,
} from './i18n'
import {
  appThemePresetMap,
  appThemePresets,
  DEFAULT_THEME_PRESET_ID,
  isAppThemePresetId,
  type AppAppearance,
  type AppThemePreset,
  type AppThemePresetId,
  type GlobalThemeSettings,
  type TerminalAnsiPalette,
} from './skins'
import {
  addWidgetToLayout,
  createLayoutForWidgets,
  ensureLayoutWidgets,
  moveWidgetInLayout,
  parseLayoutNode,
  removeWidgetFromLayout,
  resizeLayoutBranch,
  type LayoutBranch,
  type LayoutDirection,
  type LayoutDropZone,
  type LayoutNode,
} from './layoutTree'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import claudeCodeLogo from '@lobehub/icons-static-svg/icons/claudecode-color.svg'
import codexLogo from '@lobehub/icons-static-svg/icons/codex-color.svg'
import geminiCliLogo from '@lobehub/icons-static-svg/icons/geminicli-color.svg'
import githubCopilotLogo from '@lobehub/icons-static-svg/icons/githubcopilot.svg'
import kiroLogo from '@lobehub/icons-static-svg/icons/kiro-color.svg'
import openCodeLogo from '@lobehub/icons-static-svg/icons/opencode.svg'
import qwenLogo from '@lobehub/icons-static-svg/icons/qwen-color.svg'
import aiderLogo from './assets/cli/aider.png'
import '@xterm/xterm/css/xterm.css'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { basicSetup, minimalSetup, EditorView } from 'codemirror'
import { json } from '@codemirror/lang-json'
import { EditorState, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Archive,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  ClipboardPaste,
  ClipboardList,
  Copy,
  Database,
  Download,
  Edit3,
  Eraser,
  Eye,
  EyeOff,
  ExternalLink,
  FileClock,
  FolderOpen,
  FolderTree,
  GripVertical,
  HardDrive,
  Image as ImageIcon,
  Languages,
  ListTree,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Palette,
  PackageOpen,
  Minus,
  MoreVertical,
  FolderPlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Star,
  Sun,
  Terminal,
  FileText,
  Trash2,
  Upload,
  Network,
  Wifi,
  Wrench,
  X,
} from 'lucide-react'

type ConnectionState = 'disconnected' | 'ready' | 'connecting' | 'connected' | 'error'

type AppBackgroundSettings = {
  enabled: boolean
  path: string
  name: string
  transparency: number
}

type AppBackgroundSelection = Pick<AppBackgroundSettings, 'path' | 'name'>

type AppUpdateCheckResult = {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  status: 'current' | 'available' | 'unavailable'
  notes: string | null
  releaseUrl: string | null
  publishedAt: string | null
  installer: {
    url: string
    sha256: string
    size: number
  } | null
}

type AppUpdateDownloadState = FileDownloadProgress & {
  status: 'idle' | 'downloading' | 'ready' | 'error' | 'cancelled' | 'launching' | 'launched'
  installerPath: string
  error: string
}

type AppUpdateDownloadResult = {
  installerPath: string
  totalBytes: number
}

const APP_VERSION = '1.0.2'

type AppLocaleContextValue = {
  language: AppLanguage
  resolvedLanguage: ResolvedLanguage
  timeZonePreference: string
  systemTimeZone: string
  resolvedTimeZone: string
  t: (text: string) => string
}

const defaultLocaleContext: AppLocaleContextValue = {
  language: 'system',
  resolvedLanguage: 'zh-CN',
  timeZonePreference: 'system',
  systemTimeZone: 'UTC',
  resolvedTimeZone: 'UTC',
  t: (text) => text,
}

const AppLocaleContext = createContext<AppLocaleContextValue>(defaultLocaleContext)

function useAppLocale() {
  return useContext(AppLocaleContext)
}

export type ServerProtocol = 'ssh' | 'telnet' | 'serial'

export type ServerProfile = {
  id: string
  name: string
  host: string
  user: string
  port: number
  group: string
  auth: 'Password' | 'Key' | 'Agent'
  password?: string
  privateKeyPath?: string
  protocol?: ServerProtocol
  serialPort?: string
  baudRate?: number
  dataBits?: number
  stopBits?: number
  parity?: string
  flowControl?: string
  logEnabled?: boolean
  logPath?: string
}

type ServerDraft = Omit<ServerProfile, 'id'> & { id?: string }

type RemoteDesktopProfile = RemoteDesktopConnection & {
  id: string
  name: string
  group: string
}

type RemoteDesktopDraft = Omit<RemoteDesktopProfile, 'id'> & { id?: string }

type CommandItem = {
  label: string
  command: string
  group: string
}

type CommandHistoryItem = {
  id: string
  command: string
  server: string
  time: string
}

type Snippet = {
  id: string
  name: string
  command: string
  category?: string
}

type SessionNote = {
  id: string
  text: string
  done: boolean
}

type InspectorTab = 'run' | 'snippets' | 'history' | 'notes' | 'inspect'

type InspectDevice = {
  id: string
  name: string
  host: string
  port: number
  username: string
  password: string
  vendor: string
  remark: string
  encryptedPassword?: string
}

const DEFAULT_INSPECT_VENDORS = ['linux', 'huawei', 'h3c', 'ruijie', 'zte', 'other']

/// 读取持久化的厂商列表；无数据或损坏时回退内置默认列表。
function readInspectVendors(): string[] {
  try {
    const raw = localStorage.getItem('rain.inspectVendors')
    if (raw) {
      const list: unknown = JSON.parse(raw)
      if (Array.isArray(list) && list.length > 0 && list.every((item) => typeof item === 'string')) {
        return list as string[]
      }
    }
  } catch {
    /* ignore */
  }
  return [...DEFAULT_INSPECT_VENDORS]
}
function buildInspectHtmlReport(record: InspectHistoryRecord): string {
  const healthClass = (health: string) => (health === 'critical' ? 'h-crit' : health === 'warn' ? 'h-warn' : 'h-ok')
  const healthLabel = (health: string) => (health === 'critical' ? '严重' : health === 'warn' ? '警告' : '正常')
  const rows = record.results
    .map((result) => {
      const commands = result.outputs.map((o) => o.command).join(' | ')
      const issues = result.outputs.flatMap((o) => o.issues).join('; ') || '-'
      return `<tr>
        <td>${escapeHtml(result.deviceName)}</td>
        <td>${escapeHtml(result.host)}</td>
        <td><span class="${healthClass(result.health)}">${healthLabel(result.health)}</span></td>
        <td>${result.success ? '成功' : '失败'}</td>
        <td>${(result.durationMs / 1000).toFixed(1)}s</td>
        <td>${escapeHtml(commands)}</td>
        <td>${escapeHtml(issues)}</td>
        <td>${result.logPath ? escapeHtml(result.logPath) : '-'}</td>
      </tr>`
    })
    .join('\n')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>巡检报告 ${record.id}</title>
<style>
  body { font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; margin: 24px; color: #24292f; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #57606a; font-size: 13px; margin-bottom: 16px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
  .stat { border: 1px solid #d0d7de; border-radius: 8px; padding: 8px 14px; font-size: 13px; }
  .stat b { font-size: 18px; display: block; }
  .stat.crit b { color: #d1242f; }
  .stat.warn b { color: #bf8700; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { border: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  .h-ok { color: #1a7f37; font-weight: 600; }
  .h-warn { color: #bf8700; font-weight: 600; }
  .h-crit { color: #d1242f; font-weight: 600; }
  .note { color: #57606a; font-size: 12px; margin-top: 12px; }
</style>
</head>
<body>
  <h1>巡检报告</h1>
  <div class="meta">RainTerminal 自动化巡检 · 记录 ID ${escapeHtml(record.id)} · ${escapeHtml(record.savedAt)}</div>
  <div class="stats">
    <div class="stat"><b>${record.meta.deviceCount}</b>设备</div>
    <div class="stat"><b>${record.meta.commandCount}</b>命令</div>
    <div class="stat"><b>${record.meta.successCount}</b>成功</div>
    <div class="stat"><b>${record.meta.failCount}</b>失败</div>
    <div class="stat crit"><b>${record.meta.criticalCount}</b>严重</div>
    <div class="stat warn"><b>${record.meta.warnCount}</b>警告</div>
  </div>
  <table>
    <thead><tr><th>设备名称</th><th>主机</th><th>健康状态</th><th>执行结果</th><th>耗时</th><th>命令</th><th>判断依据</th><th>日志文件</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="note">由 RainTerminal 自动化巡检生成</div>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}


type InspectCommandOutput = {
  command: string
  output: string
  success: boolean
  health: 'ok' | 'warn' | 'critical' | string
  issues: string[]
}

type InspectExecResult = {
  deviceName: string
  host: string
  success: boolean
  error?: string | null
  outputs: InspectCommandOutput[]
  durationMs: number
  health: 'ok' | 'warn' | 'critical' | string
  logPath?: string | null
}

type InspectHistoryMeta = {
  id: string
  savedAt: string
  deviceCount: number
  commandCount: number
  successCount: number
  failCount: number
  criticalCount: number
  warnCount: number
  okCount: number
}

type InspectHistoryRecord = {
  id: string
  savedAt: string
  meta: InspectHistoryMeta
  results: InspectExecResult[]
}

type InspectRuleType = 'keyword' | 'missing' | 'threshold'

type InspectRuleConfig = {
  id: string
  vendor: string
  commandContains: string
  severity: 'warn' | 'critical' | string
  type: InspectRuleType
  keyword?: string | null
  missingKeyword?: string | null
  threshold?: number | null
  percent: boolean
  label: string
  enabled: boolean
}

type InspectPlanFrequency = 'daily' | 'weekly' | 'monthly' | 'interval'

type InspectPlan = {
  id: string
  name: string
  deviceIds: string[]
  commands: { name: string; command: string }[]
  concurrency: number
  frequency: InspectPlanFrequency
  weekdays: number[]
  monthDay: number
  hour: number
  minute: number
  intervalHours: number
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
}

type InspectWorkspaceView = 'workbench' | 'history' | 'rules' | 'plans'

type DockPanel = 'servers' | 'local' | 'tools' | InspectorTab | null

type GlobalSearchEntry = {
  key: string
  kind: 'server' | 'desktop'
  title: string
  detail: string
  searchParts: string[]
  server?: ServerProfile
  desktop?: RemoteDesktopProfile
}

type SshEventPayload = {
  session_id: string
  data?: string
  message?: string
}

type SshHealthPayload = {
  session_id: string
  connected: boolean
  idle_ms: number
  write_idle_ms: number
  connected_ms: number
  total_read: number
  total_written: number
}

type LocalEventPayload = SshEventPayload

type TerminalController = {
  kind: 'local' | 'ssh'
  isReady: () => boolean
  write: (data: string) => Promise<void>
  clear: () => void
  focus: () => void
  readText: () => string
}

type CliToolInfo = {
  id: string
  name: string
  command: string
}

export type WorkbenchWidgetType = 'local-terminal' | 'ssh-terminal' | 'files' | 'monitor' | 'processes' | 'remote-desktop'

export type WorkbenchWidget = {
  id: string
  type: WorkbenchWidgetType
  title: string
  x: number
  y: number
  w: number
  h: number
  serverId?: string
  sessionId?: string
  remoteDesktop?: RemoteDesktopConnection
  maximized?: boolean
  restore?: Pick<WorkbenchWidget, 'x' | 'y' | 'w' | 'h'>
}

type WidgetRect = Pick<WorkbenchWidget, 'x' | 'y' | 'w' | 'h'>

export type WorkbenchWorkspace = {
  id: string
  name: string
  widgets: WorkbenchWidget[]
  focusedWidgetId: string
  layout: LayoutNode | null
  magnifiedWidgetId?: string
  layoutPreset?: WorkbenchLayoutPreset
}

type LocalFileEntry = {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: string
  permissions: string
  file_type: string
}

type FileDownloadProgress = {
  totalBytes: number
  transferredBytes: number
  bytesPerSecond: number
  copiedFiles: number
  totalFiles: number
  currentFile: string
  completed: boolean
}

type FileDownloadResult = {
  destination: string
  copiedFiles: number
  totalFiles: number
  totalBytes: number
}

type FileDownloadPanelState = FileDownloadProgress & {
  entryName: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  message: string
  destination?: string
}

type LocalSystemStats = {
  user: string
  home_dir: string
  os: string
  shell: string
  process_count: number
  cpu_usage: number
  memory_used: number
  memory_total: number
  disk_used: number
  disk_total: number
  swap_used: number
  swap_total: number
  network_received: number
  network_transmitted: number
  cpu_cores: number
  cpu_freq_mhz: number
  tcp_connections: number
  udp_connections: number
}

type SystemProcessEntry = {
  pid: number
  name: string
  cpu_usage: number
  memory: number
  status: string
  command: string
}

type SortDirection = 'asc' | 'desc'
type FileSortKey = 'name' | 'permissions' | 'modified' | 'file_type' | 'size'
type ProcessSortKey = 'pid' | 'name' | 'cpu_usage' | 'memory' | 'status'

type RemoteDirectoryResponse = {
  path: string
  entries: LocalFileEntry[]
}

type TerminalThemeSettings = {
  fontFamily: string
  fontSize: number
  background: string
  foreground: string
  cursor: string
  accent: string
  palette: TerminalAnsiPalette
}

type ResizeDirection = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type WorkbenchLayoutPreset = 'local-remote' | 'groups' | 'wave' | 'columns' | 'grid' | 'focus-left' | 'focus-right' | 'rows'

type WorkbenchViewport = {
  width: number
  height: number
}

type ContextMenuItem = {
  label: string
  hint?: string
  icon?: ReactNode
  disabled?: boolean
  separatorBefore?: boolean
  danger?: boolean
  onClick: () => void
}

type ContextMenuState = {
  x: number
  y: number
  items: ContextMenuItem[]
} | null

type CredentialPersistenceState = {
  ready: boolean
  error?: string
}

const sandboxServers: ServerProfile[] = [
  {
    id: 'sandbox-198',
    name: '192.0.2.198',
    host: '192.0.2.198',
    user: 'root',
    port: 22,
    group: 'Sandbox',
    auth: 'Password',
    password: 'sandbox',
  },
  {
    id: 'sandbox-201',
    name: '192.0.2.201',
    host: '192.0.2.201',
    user: 'root',
    port: 22,
    group: 'Sandbox',
    auth: 'Password',
    password: 'sandbox',
  },
  {
    id: 'sandbox-81',
    name: '192.0.2.81',
    host: '192.0.2.81',
    user: 'root',
    port: 22,
    group: 'Sandbox',
    auth: 'Password',
    password: 'sandbox',
  },
  {
    id: 'sandbox-91',
    name: '192.0.2.91',
    host: '192.0.2.91',
    user: 'root',
    port: 22,
    group: 'Sandbox',
    auth: 'Password',
    password: 'sandbox',
  },
]

const defaultServers: ServerProfile[] = isSandboxMode ? sandboxServers : []

const emptyServer: ServerProfile = {
  id: 'empty-server',
  name: '未配置服务器',
  host: '',
  user: 'root',
  port: 22,
  group: 'Workspace',
  auth: 'Password',
  password: '',
}

const localQuickCommands: CommandItem[] = [
  { label: '当前目录', command: 'cd', group: '本地' },
  { label: '文件列表', command: 'dir', group: '本地' },
  { label: '目录树', command: 'tree /f', group: '本地' },
  { label: '当前用户', command: 'whoami', group: '本地' },
  { label: '网络配置', command: 'ipconfig', group: '本地' },
  { label: '网络连通', command: 'ping 8.8.8.8', group: '本地' },
  { label: '进程列表', command: 'tasklist', group: '本地' },
  { label: '系统信息', command: 'systeminfo', group: '本地' },
  { label: '环境变量', command: 'set', group: '本地' },
]

const remoteQuickCommands: CommandItem[] = [
  { label: '系统负载', command: 'uptime', group: '系统' },
  { label: '磁盘占用', command: 'df -h', group: '系统' },
  { label: '内存占用', command: 'free -m', group: '系统' },
  { label: 'Nginx 状态', command: 'systemctl status nginx --no-pager', group: '服务' },
  { label: 'Docker 容器', command: 'docker ps', group: '容器' },
  { label: '系统日志', command: 'tail -n 80 /var/log/syslog', group: '日志' },
]

const defaultSnippets: Snippet[] = [
  // ---- Linux 服务器 ----
  { id: 'snippet-restart-nginx', name: '重启 Nginx', command: 'systemctl restart nginx', category: 'Linux 服务器' },
  { id: 'snippet-journal-nginx', name: '查看 Nginx 日志', command: 'journalctl -u nginx -n 120 --no-pager', category: 'Linux 服务器' },
  { id: 'snippet-docker-stats', name: '容器资源', command: 'docker stats --no-stream', category: 'Linux 服务器' },
  // ---- 通用查询（设备无关）----
  { id: 'snippet-gen-clock', name: '通用·设备时间', command: 'display clock', category: '通用' },
  { id: 'snippet-gen-clock-show', name: '通用·当前时间', command: 'show clock', category: '通用' },
  // ---- 华为 VRP（display 系）----
  { id: 'snippet-hw-version', name: '华为·版本信息', command: 'display version', category: '华为' },
  { id: 'snippet-hw-running', name: '华为·当前配置', command: 'display current-configuration', category: '华为' },
  { id: 'snippet-hw-interface', name: '华为·接口状态', command: 'display interface brief', category: '华为' },
  { id: 'snippet-hw-ip-interface', name: '华为·IP 接口', command: 'display ip interface brief', category: '华为' },
  { id: 'snippet-hw-cpu', name: '华为·CPU 使用率', command: 'display cpu-usage', category: '华为' },
  { id: 'snippet-hw-memory', name: '华为·内存使用率', command: 'display memory-usage', category: '华为' },
  { id: 'snippet-hw-device', name: '华为·设备健康', command: 'display device', category: '华为' },
  { id: 'snippet-hw-transceiver', name: '华为·光模块信息', command: 'display transceiver interface', category: '华为' },
  { id: 'snippet-hw-fan', name: '华为·风扇状态', command: 'display fan', category: '华为' },
  { id: 'snippet-hw-power', name: '华为·电源状态', command: 'display power', category: '华为' },
  { id: 'snippet-hw-arp', name: '华为·ARP 表', command: 'display arp', category: '华为' },
  { id: 'snippet-hw-mac', name: '华为·MAC 表', command: 'display mac-address', category: '华为' },
  { id: 'snippet-hw-lldp', name: '华为·LLDP 邻居', command: 'display lldp neighbor-information', category: '华为' },
  { id: 'snippet-hw-log', name: '华为·日志缓冲', command: 'display logbuffer', category: '华为' },
  // ---- 华三 Comware（display 系）----
  { id: 'snippet-h3c-version', name: '华三·版本信息', command: 'display version', category: '华三' },
  { id: 'snippet-h3c-running', name: '华三·当前配置', command: 'display current-configuration', category: '华三' },
  { id: 'snippet-h3c-interface', name: '华三·接口状态', command: 'display interface brief', category: '华三' },
  { id: 'snippet-h3c-ip-interface', name: '华三·IP 接口', command: 'display ip interface brief', category: '华三' },
  { id: 'snippet-h3c-cpu', name: '华三·CPU 使用率', command: 'display cpu-usage', category: '华三' },
  { id: 'snippet-h3c-memory', name: '华三·内存使用率', command: 'display memory', category: '华三' },
  { id: 'snippet-h3c-device', name: '华三·设备信息', command: 'display device', category: '华三' },
  { id: 'snippet-h3c-transceiver', name: '华三·光模块诊断', command: 'display transceiver diagnosis interface', category: '华三' },
  { id: 'snippet-h3c-fan', name: '华三·风扇状态', command: 'display fan', category: '华三' },
  { id: 'snippet-h3c-power', name: '华三·电源状态', command: 'display power', category: '华三' },
  { id: 'snippet-h3c-arp', name: '华三·ARP 表', command: 'display arp', category: '华三' },
  { id: 'snippet-h3c-mac', name: '华三·MAC 表', command: 'display mac-address', category: '华三' },
  { id: 'snippet-h3c-lldp', name: '华三·LLDP 邻居', command: 'display lldp neighbor-information', category: '华三' },
  { id: 'snippet-h3c-manuinfo', name: '华三·设备序列号', command: 'display device manuinfo', category: '华三' },
  // ---- 锐捷 RGOS（show 系）----
  { id: 'snippet-rg-version', name: '锐捷·版本信息', command: 'show version', category: '锐捷' },
  { id: 'snippet-rg-running', name: '锐捷·运行配置', command: 'show running-config', category: '锐捷' },
  { id: 'snippet-rg-interface', name: '锐捷·接口状态', command: 'show interface status', category: '锐捷' },
  { id: 'snippet-rg-ip-interface', name: '锐捷·IP 接口', command: 'show ip interface brief', category: '锐捷' },
  { id: 'snippet-rg-cpu', name: '锐捷·CPU 使用率', command: 'show cpu', category: '锐捷' },
  { id: 'snippet-rg-memory', name: '锐捷·内存使用率', command: 'show memory', category: '锐捷' },
  { id: 'snippet-rg-arp', name: '锐捷·ARP 表', command: 'show arp', category: '锐捷' },
  { id: 'snippet-rg-mac', name: '锐捷·MAC 表', command: 'show mac-address-table', category: '锐捷' },
  { id: 'snippet-rg-vlan', name: '锐捷·VLAN 列表', command: 'show vlan', category: '锐捷' },
  { id: 'snippet-rg-lldp', name: '锐捷·LLDP 邻居', command: 'show lldp neighbors', category: '锐捷' },
  { id: 'snippet-rg-route', name: '锐捷·路由表', command: 'show ip route', category: '锐捷' },
  { id: 'snippet-rg-inventory', name: '锐捷·设备序列号', command: 'show inventory', category: '锐捷' },
  // ---- 中兴 ZXR10（show 系）----
  { id: 'snippet-zte-version', name: '中兴·版本信息', command: 'show version', category: '中兴' },
  { id: 'snippet-zte-running', name: '中兴·运行配置', command: 'show running-config', category: '中兴' },
  { id: 'snippet-zte-interface', name: '中兴·接口状态', command: 'show interface brief', category: '中兴' },
  { id: 'snippet-zte-ip-interface', name: '中兴·IP 接口', command: 'show ip interface brief', category: '中兴' },
  { id: 'snippet-zte-cpu', name: '中兴·CPU 使用率', command: 'show cpu', category: '中兴' },
  { id: 'snippet-zte-memory', name: '中兴·内存使用率', command: 'show memory', category: '中兴' },
  { id: 'snippet-zte-arp', name: '中兴·ARP 表', command: 'show arp', category: '中兴' },
  { id: 'snippet-zte-mac', name: '中兴·MAC 表', command: 'show mac-address', category: '中兴' },
  { id: 'snippet-zte-vlan', name: '中兴·VLAN 列表', command: 'show vlan', category: '中兴' },
  { id: 'snippet-zte-log', name: '中兴·日志缓冲', command: 'show logging buffer', category: '中兴' },
  { id: 'snippet-zte-route', name: '中兴·路由表', command: 'show ip route', category: '中兴' },
  { id: 'snippet-zte-transceiver', name: '中兴·光模块信息', command: 'show interface transceiver', category: '中兴' },
]

const SNIPPET_CATEGORIES = ['Linux 服务器', '华为', '华三', '锐捷', '中兴', '通用', '未分类'] as const
const SNIPPETS_VERSION = 2

const TERMINAL_WRITE_CHUNK_SIZE = 12 * 1024
const TERMINAL_WRITE_QUEUE_LIMIT = 1024 * 1024
const REMOTE_TERMINAL_REPLAY_LIMIT = 384 * 1024
const REMOTE_TERMINAL_INPUT_QUEUE_KEEP = 64 * 1024
const TERMINAL_LINE_HEIGHT = 1.42
const DEFAULT_TERMINAL_FONT_SIZE = 12
const MIN_TERMINAL_FONT_SIZE = 9
const MAX_TERMINAL_FONT_SIZE = 22
const DEFAULT_APP_BACKGROUND_TRANSPARENCY = 18
const MIN_APP_BACKGROUND_TRANSPARENCY = 0
const MAX_APP_BACKGROUND_TRANSPARENCY = 45
const REMOTE_TERMINAL_RESIZE_DEBOUNCE_MS = 140
const REMOTE_TERMINAL_RECONNECT_DELAYS_MS = [2000, 4000, 8000, 15000, 30000] as const
const REMOTE_TERMINAL_CONNECT_REQUEST_EVENT = 'xundu:ssh-connect-request'
const LOCAL_TERMINAL_NOTICE_EVENT = 'xundu:local-terminal-notice'
const ENABLE_REMOTE_XTERM_WEBGL = false
const AUX_WIDGET_MOUNT_DELAY_MS = 250
const REMOTE_AUX_AFTER_CONNECT_DELAY_MS = 0
const REMOTE_FILE_RETRY_DELAYS_MS = [800, 1800] as const
const DEFAULT_REMOTE_AUX_CONCURRENCY = 30
const MIN_REMOTE_AUX_CONCURRENCY = 1
const MAX_REMOTE_AUX_CONCURRENCY = 100
const LOCAL_DRIVES_PATH = '::local-drives'
const DIAG_SLOW_MS = 80
const WORKBENCH_LAYOUT_SETTLED_EVENT = 'xundu:workbench-layout-settled'
const WORKBENCH_FLIP_DURATION_MS = 190
const COMMON_TIME_ZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
] as const

const remoteTerminalConnectedSessions = new Set<string>()
const remoteTerminalConnectingSessions = new Set<string>()
const remoteTerminalManualConnectSessions = new Set<string>()

function requestRemoteTerminalSessionConnection(sessionId: string) {
  remoteTerminalManualConnectSessions.add(sessionId)
  window.dispatchEvent(new CustomEvent<string>(REMOTE_TERMINAL_CONNECT_REQUEST_EVENT, { detail: sessionId }))
}

const remoteTerminalOutputCache = new Map<string, string>()
const remoteTerminalStatusCache = new Map<string, string>()
const remoteDesktopAutoConnectWidgets = new Set<string>()
const localTerminalOutputCache = new Map<string, string>()
const localTerminalRunningSessions = new Set<string>()
const localTerminalRecoveryRequests = new Map<string, Promise<void>>()
const localTerminalStopTimers = new Map<string, number>()
const terminalControllers = new Map<string, TerminalController>()
const cliToolCache = new Map<string, { expiresAt: number; tools: CliToolInfo[] }>()
const cliToolRequests = new Map<string, Promise<CliToolInfo[]>>()
const fileManagerViewCache = new Map<string, { path: string; sort: { key: FileSortKey; direction: SortDirection } }>()
const remoteDirectoryRequests = new Map<string, Promise<RemoteDirectoryResponse>>()
const monitorViewCache = new Map<string, {
  serverId?: string
  metric: MonitorMetric
  stats: LocalSystemStats | null
  history: MonitorHistory
  lastNetwork: number
}>()
const processViewCache = new Map<string, {
  serverId?: string
  query: string
  sort: { key: ProcessSortKey; direction: SortDirection }
  processes: SystemProcessEntry[]
}>()

const CLI_TOOL_CACHE_MS = 60_000

function getWorkspaceCommandTarget(workspace?: WorkbenchWorkspace) {
  if (!workspace) return undefined
  const focused = workspace.widgets.find((widget) => widget.id === workspace.focusedWidgetId)
  if (focused?.type === 'local-terminal' || focused?.type === 'ssh-terminal') return focused
  return workspace.widgets.find((widget) => widget.type === 'local-terminal' || widget.type === 'ssh-terminal')
}

function formatTerminalCommand(command: string) {
  const normalized = command.replace(/\r\n/g, '\n').replace(/\n/g, '\r')
  return normalized.endsWith('\r') ? normalized : `${normalized}\r`
}

function hasSshAuthentication(server?: ServerProfile) {
  if (!server?.host || !server.user) return false
  if (server.auth === 'Agent') return true
  if (server.auth === 'Key') return Boolean(server.privateKeyPath?.trim())
  return Boolean(server.password)
}

/** 设备连接前校验：SSH 需要认证信息；Telnet/Serial 只需地址/串口即可 */
function hasConnectionAuthentication(server?: ServerProfile) {
  if (!server) return false
  if (server.protocol === 'telnet') return Boolean(server.host && server.port > 0)
  if (server.protocol === 'serial') return Boolean(server.serialPort?.trim())
  return hasSshAuthentication(server)
}

function serverAddressLabel(server?: ServerProfile) {
  if (!server) return '设备配置缺失'
  if (server.protocol === 'serial') return server.serialPort || '串口未配置'
  if (server.protocol === 'telnet') return `${server.host}:${server.port}`
  return `${server.user}@${server.host}:${server.port}`
}

function sshAuthenticationHint(server: ServerProfile) {
  if (server.auth === 'Agent') return 'SSH Agent'
  if (server.auth === 'Key') return server.privateKeyPath?.trim() ? '私钥' : '需要私钥'
  return server.password ? `${server.user}@${server.host}` : '需要密码'
}

function readXtermBuffer(terminal?: XTerm | null) {
  if (!terminal) return ''
  const selection = terminal.getSelection()
  if (selection) return selection
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

function terminalCliCacheKey(server?: ServerProfile) {
  return server ? `ssh:${server.user}@${server.host}:${server.port}` : 'local'
}

function requestTerminalCliTools(server?: ServerProfile) {
  const key = terminalCliCacheKey(server)
  const cached = cliToolCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.tools)
  const pending = cliToolRequests.get(key)
  if (pending) return pending

  const request = invoke<CliToolInfo[]>(server ? 'remote_detect_cli_tools' : 'local_detect_cli_tools', server
    ? {
        host: server.host,
        user: server.user,
        password: server.password ?? '',
        port: server.port,
      }
    : undefined)
    .then((tools) => {
      const normalized = Array.isArray(tools) ? tools : []
      cliToolCache.set(key, { expiresAt: Date.now() + CLI_TOOL_CACHE_MS, tools: normalized })
      return normalized
    })
    .finally(() => cliToolRequests.delete(key))
  cliToolRequests.set(key, request)
  return request
}

function requestRemoteDirectory(
  args: { host: string; user: string; password: string; port: number },
  path?: string,
) {
  const normalizedPath = path || '~'
  const key = `${args.user}@${args.host}:${args.port}:${normalizedPath}`
  const activeRequest = remoteDirectoryRequests.get(key)
  if (activeRequest) return activeRequest

  const request = invoke<RemoteDirectoryResponse>('remote_list_dir', {
    ...args,
    path: path || null,
  })
  remoteDirectoryRequests.set(key, request)
  const clearRequest = () => {
    if (remoteDirectoryRequests.get(key) === request) remoteDirectoryRequests.delete(key)
  }
  void request.then(clearRequest, clearRequest)
  return request
}

function isRetryableRemoteFileConnectionError(message: string) {
  const normalized = message.toLowerCase()
  return normalized.includes('unable to exchange encryption keys')
    || normalized.includes('ssh handshake failed')
    || normalized.includes('failed getting banner')
    || normalized.includes('connection reset')
    || normalized.includes('connection timed out')
    || normalized.includes('timed out waiting on socket')
    || normalized.includes('ssh connection queue timed out')
}

function formatRemoteFileConnectionError(message: string) {
  return isRetryableRemoteFileConnectionError(message)
    ? '文件通道握手失败：已完成自动重试，请稍后刷新；SSH 终端连接不会受影响。'
    : message
}

function extractSshHostKeyFingerprint(message: string) {
  const match = message.match(/SSH host key mismatch[^()]*\(((?:[0-9a-f]{2}:){15,}[0-9a-f]{2})\)/i)
  return match?.[1]?.toLowerCase() ?? ''
}

const SSH_HOST_KEY_UPDATED_EVENT = 'xundu:ssh-host-key-updated'
const FILE_TRANSFER_MANAGER_OPEN_EVENT = 'xundu:open-file-transfer-manager'
let activeSshHostKeyPrompt = ''

function claimSshHostKeyPrompt(claim: string) {
  if (activeSshHostKeyPrompt) return false
  activeSshHostKeyPrompt = claim
  return true
}

function releaseSshHostKeyPrompt(claim: string) {
  if (activeSshHostKeyPrompt === claim) activeSshHostKeyPrompt = ''
}

const blankDraft: ServerDraft = {
  name: '',
  host: '',
  user: 'root',
  port: 22,
  group: 'Production',
  auth: 'Password',
  password: '',
  privateKeyPath: '',
  protocol: 'ssh',
  serialPort: '',
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  logEnabled: false,
  logPath: '',
}

const blankRemoteDesktopDraft: RemoteDesktopDraft = {
  name: '',
  group: 'Production',
  protocol: 'rdp',
  host: '',
  port: 3389,
  username: 'Administrator',
  password: '',
  domain: '',
  security: 'any',
  ignoreCertificate: true,
  viewOnly: false,
}

const defaultWorkbenchWidgets: WorkbenchWidget[] = [
  {
    id: 'local-terminal-1',
    type: 'local-terminal',
    title: '本地终端 1',
    x: 18,
    y: 58,
    w: 560,
    h: 420,
    sessionId: 'local-terminal-1',
  },
]

const defaultWorkspaces: WorkbenchWorkspace[] = [
  {
    id: 'workspace-1',
    name: 'W1 工作台',
    widgets: defaultWorkbenchWidgets,
    focusedWidgetId: defaultWorkbenchWidgets[0].id,
    layout: createLayoutForWidgets(defaultWorkbenchWidgets.map((widget) => widget.id)),
    layoutPreset: 'grid',
  },
  {
    id: 'workspace-2',
    name: 'W2 工作台',
    widgets: [],
    focusedWidgetId: '',
    layout: null,
    layoutPreset: 'grid',
  },
]

const fileRowHeight = 36
const fileListOverscan = 8

function toTerminalTheme(theme: GlobalThemeSettings): TerminalThemeSettings {
  return {
    fontFamily: theme.terminalFontFamily,
    fontSize: theme.terminalFontSize,
    background: theme.terminalBackground,
    foreground: theme.terminalForeground,
    cursor: theme.terminalCursor,
    accent: theme.accent,
    palette: theme.terminalPalette,
  }
}

function toXtermTheme(theme: TerminalThemeSettings) {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    selectionBackground: toAlphaColor(theme.accent, 0.26),
    selectionInactiveBackground: toAlphaColor(theme.accent, 0.14),
    ...theme.palette,
  }
}

const layoutPresets: {
  id: WorkbenchLayoutPreset
  label: string
  blocks: CSSProperties[]
}[] = [
  {
    id: 'local-remote',
    label: '本地/远程',
    blocks: [
      { left: '0%', top: '0%', width: '34%', height: '100%' },
      { left: '36%', top: '0%', width: '36%', height: '100%' },
      { left: '74%', top: '0%', width: '26%', height: '34%' },
      { left: '74%', top: '38%', width: '26%', height: '62%' },
    ],
  },
  {
    id: 'groups',
    label: '工作组',
    blocks: [
      { left: '0%', top: '0%', width: '58%', height: '100%' },
      { left: '60%', top: '0%', width: '40%', height: '38%' },
      { left: '60%', top: '42%', width: '40%', height: '58%' },
    ],
  },
  {
    id: 'columns',
    label: '等分列',
    blocks: [
      { left: '0%', top: '0%', width: '50%', height: '100%' },
      { left: '50%', top: '0%', width: '50%', height: '100%' },
    ],
  },
  {
    id: 'focus-left',
    label: '主左列',
    blocks: [
      { left: '0%', top: '0%', width: '62%', height: '100%' },
      { left: '62%', top: '0%', width: '38%', height: '50%' },
      { left: '62%', top: '50%', width: '38%', height: '50%' },
    ],
  },
  {
    id: 'focus-right',
    label: '主右列',
    blocks: [
      { left: '0%', top: '0%', width: '38%', height: '50%' },
      { left: '0%', top: '50%', width: '38%', height: '50%' },
      { left: '38%', top: '0%', width: '62%', height: '100%' },
    ],
  },
  {
    id: 'grid',
    label: '网格',
    blocks: [
      { left: '0%', top: '0%', width: '50%', height: '50%' },
      { left: '50%', top: '0%', width: '50%', height: '50%' },
      { left: '0%', top: '50%', width: '50%', height: '50%' },
      { left: '50%', top: '50%', width: '50%', height: '50%' },
    ],
  },
  {
    id: 'rows',
    label: '等分行',
    blocks: [
      { left: '0%', top: '0%', width: '100%', height: '50%' },
      { left: '0%', top: '50%', width: '100%', height: '50%' },
    ],
  },
  {
    id: 'wave',
    label: '智能列',
    blocks: [
      { left: '0%', top: '0%', width: '36%', height: '50%' },
      { left: '0%', top: '50%', width: '36%', height: '50%' },
      { left: '36%', top: '0%', width: '24%', height: '40%' },
      { left: '60%', top: '0%', width: '40%', height: '100%' },
    ],
  },
]

function App() {
  if (isSandboxMode) {
    const sandboxWindow = window as typeof window & { __XUNDU_SANDBOX_APP_RENDERS__?: number }
    sandboxWindow.__XUNDU_SANDBOX_APP_RENDERS__ = (sandboxWindow.__XUNDU_SANDBOX_APP_RENDERS__ ?? 0) + 1
  }
  const [servers, setServers, serverCredentialState] = usePersistentServers()
  const [remoteDesktopProfiles, setRemoteDesktopProfiles, remoteDesktopCredentialState] = usePersistentRemoteDesktopProfiles()
  const [snippets, setSnippets] = usePersistentSnippets()
  const [snippetCategories, setSnippetCategories] = usePersistentSnippetCategories()
  const [sessionNotes, setSessionNotes] = usePersistentSessionNotes()
  const [inspectDevices, setInspectDevices] = usePersistentInspectDevices()
  const inspectCredentialMigratedRef = useRef(false)
  useEffect(() => {
    if (inspectCredentialMigratedRef.current) return
    const needMigration = inspectDevices.some((d) => Boolean(d.password) && !d.encryptedPassword)
    if (!needMigration) {
      inspectCredentialMigratedRef.current = true
      return
    }
    let cancelled = false
    void (async () => {
      const next = await Promise.all(
        inspectDevices.map(async (d) => {
          if (d.password && !d.encryptedPassword) {
            try {
              const encryptedPassword = await invoke<string>('encrypt_secret', { plain: d.password })
              return { ...d, password: '', encryptedPassword }
            } catch {
              return d
            }
          }
          return d
        }),
      )
      if (cancelled) return
      inspectCredentialMigratedRef.current = true
      setInspectDevices(next)
    })()
    return () => {
      cancelled = true
    }
  }, [inspectDevices, setInspectDevices])
  const [remoteAuxConcurrency, setRemoteAuxConcurrency] = usePersistentRemoteAuxConcurrency()
  const [appearance, setAppearance] = usePersistentAppAppearance()
  const [themePreset, setThemePreset] = usePersistentThemePreset()
  const reduceMotion = useReducedMotion()
  const themeTransitionSequenceRef = useRef(0)
  const [themeTransition, setThemeTransition] = useState<{
    id: number
    color: string
    intensity: number
  } | null>(null)
  const [appBackground, setAppBackground] = usePersistentAppBackground()
  const [terminalFontSize, setTerminalFontSize] = usePersistentTerminalFontSize()
  const [displayLanguage, setDisplayLanguage] = usePersistentDisplayLanguage()
  const [timeZonePreference, setTimeZonePreference] = usePersistentTimeZonePreference()
  const [systemTimeZone, setSystemTimeZone] = useState(getSystemTimeZone)
  const resolvedLanguage = resolveAppLanguage(displayLanguage)
  const resolvedTimeZone = timeZonePreference === 'system' ? systemTimeZone : timeZonePreference
  const t = useCallback(
    (text: string) => translateUiText(text, resolvedLanguage),
    [resolvedLanguage],
  )
  const [selectedServerId, setSelectedServerId] = useState(servers[0]?.id ?? '')
  const [connectionState, setConnectionState] = useState<ConnectionState>('ready')
  const [password, setPassword] = useState(servers[0]?.password ?? '')
  const [serverModal, setServerModal] = useState<ServerDraft | null>(null)
  const [remoteDesktopModal, setRemoteDesktopModal] = useState<RemoteDesktopDraft | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [backgroundBusy, setBackgroundBusy] = useState(false)
  const [transferManagerOpen, setTransferManagerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [activePanel, setActivePanel] = useState<DockPanel>(null)
  const [mainView, setMainView] = useState<'workbench' | 'inspect' | 'tools'>('workbench')
  // 巡检工作台持久状态（跨视图切换保留）
  const [inspectSelectedIds, setInspectSelectedIds] = useState<Set<string>>(new Set())
  const [inspectCommands, setInspectCommands] = useState<{ id: string; name: string; command: string }[]>([])
  const [inspectRunning, setInspectRunning] = useState(false)
  const [inspectResults, setInspectResults] = useState<InspectExecResult[] | null>(null)
  const [inspectConcurrency, setInspectConcurrency] = useState(5)
  const [inspectProgress, setInspectProgress] = useState<{ current: number; total: number } | null>(null)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('run')
  const [toast, setToast] = useState('')
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())
  const [activeConnectedServerId, setActiveConnectedServerId] = useState<string | null>(null)
  const [serverConnectionStates, setServerConnectionStates] = useState<Record<string, ConnectionState>>({})
  const [terminalSize] = useState({ cols: 120, rows: 34 })
  const [serverLaunchOptions, setServerLaunchOptions] = useState({ files: true, monitor: false, processes: false })
  const [commandHistory, setCommandHistory] = useState<CommandHistoryItem[]>([])
  const [commandDraft, setCommandDraft] = useState('')
  const [workspaces, setWorkspaces, workspaceCredentialState] = usePersistentWorkspaces()
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => {
    try {
      const persistedId = localStorage.getItem('xundu.activeWorkspaceId')
      if (persistedId && workspaces.some((workspace) => workspace.id === persistedId)) return persistedId
    } catch {
      // Fall back to the first workspace when storage is unavailable.
    }
    return workspaces[0]?.id ?? defaultWorkspaces[0].id
  })
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const appHeartbeatRef = useRef({ activeWorkspaceId: defaultWorkspaces[0].id, widgetCount: 0 })
  const selectedServerIdRef = useRef(selectedServerId)
  const remoteStatusSnapshotRef = useRef(new Map<string, string>())
  const startupConnectionsResetRef = useRef(false)

  if (!startupConnectionsResetRef.current) {
    startupConnectionsResetRef.current = true
    remoteTerminalConnectedSessions.clear()
    remoteTerminalConnectingSessions.clear()
    remoteTerminalManualConnectSessions.clear()
    remoteTerminalStatusCache.clear()
    remoteDesktopAutoConnectWidgets.clear()
    terminalControllers.clear()
  }

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? servers[0] ?? emptyServer,
    [selectedServerId, servers],
  )
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0],
    [activeWorkspaceId, workspaces],
  )
  const commandTargetWidget = useMemo(
    () => getWorkspaceCommandTarget(activeWorkspace),
    [activeWorkspace],
  )
  const commandTargetServer = commandTargetWidget?.type === 'ssh-terminal'
    ? servers.find((server) => server.id === commandTargetWidget.serverId)
    : undefined
  const commandTargetLabel = commandTargetWidget?.type === 'ssh-terminal'
    ? commandTargetServer
      ? formatServerAddress(commandTargetServer)
      : 'SSH 终端配置缺失'
    : commandTargetWidget?.title ?? '未打开终端'
  const globalTheme = useMemo<GlobalThemeSettings>(() => ({
    ...appThemePresetMap[themePreset].themes[appearance],
    terminalFontSize,
  }), [appearance, terminalFontSize, themePreset])
  const backgroundActive = Boolean(appBackground.enabled && appBackground.path)
  const interfaceOpacity = backgroundActive ? 1 - appBackground.transparency / 100 : 1
  const backgroundAssetUrl = useMemo(
    () => appBackground.path ? convertFileAssetSrc(appBackground.path) : '',
    [appBackground.path],
  )
  const terminalTheme = useMemo(() => {
    const theme = toTerminalTheme(globalTheme)
    return backgroundActive
      ? { ...theme, background: 'rgba(0, 0, 0, 0)' }
      : theme
  }, [backgroundActive, globalTheme])
  const localeContext = useMemo<AppLocaleContextValue>(() => ({
    language: displayLanguage,
    resolvedLanguage,
    timeZonePreference,
    systemTimeZone,
    resolvedTimeZone,
    t,
  }), [displayLanguage, resolvedLanguage, resolvedTimeZone, systemTimeZone, t, timeZonePreference])

  useEffect(() => {
    if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
      setActiveWorkspaceId(workspaces[0]?.id ?? defaultWorkspaces[0].id)
      return
    }
    try {
      localStorage.setItem('xundu.activeWorkspaceId', activeWorkspaceId)
    } catch {
      // Active workspace persistence is best-effort.
    }
  }, [activeWorkspaceId, workspaces])

  useEffect(() => {
    appHeartbeatRef.current = {
      activeWorkspaceId,
      widgetCount: workspaces.reduce((total, workspace) => total + workspace.widgets.length, 0),
    }
  }, [activeWorkspaceId, workspaces])

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance
    document.documentElement.dataset.themePreset = themePreset
    document.documentElement.dataset.customBackground = backgroundActive ? 'enabled' : 'disabled'
    document.documentElement.dataset.interfaceTransparency = String(backgroundActive ? appBackground.transparency : 0)
    applyGlobalThemeTokens(globalTheme, backgroundActive ? interfaceOpacity : 1)
    applyThemeEffectTokens(appThemePresetMap[themePreset].effects)
  }, [appearance, appBackground.transparency, backgroundActive, globalTheme, interfaceOpacity, themePreset])

  useEffect(() => {
    const openTransferManager = () => setTransferManagerOpen(true)
    window.addEventListener(FILE_TRANSFER_MANAGER_OPEN_EVENT, openTransferManager)
    return () => window.removeEventListener(FILE_TRANSFER_MANAGER_OPEN_EVENT, openTransferManager)
  }, [])

  useEffect(() => {
    const showLocalTerminalNotice = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      if (message) setToast(message)
    }
    window.addEventListener(LOCAL_TERMINAL_NOTICE_EVENT, showLocalTerminalNotice)
    return () => window.removeEventListener(LOCAL_TERMINAL_NOTICE_EVENT, showLocalTerminalNotice)
  }, [])

  useEffect(() => {
    try {
      localStorage.removeItem('xundu.windowVisuals')
      localStorage.removeItem('xundu.phase2.session.v1')
      localStorage.removeItem('xundu.phase2.recovery.v1')
      localStorage.removeItem('__xundu.sandbox.recovery')
    } catch {
      // Deprecated preferences are best-effort cleanup.
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = resolvedLanguage
    document.documentElement.dataset.language = resolvedLanguage
    document.documentElement.dataset.timeZone = resolvedTimeZone
  }, [resolvedLanguage, resolvedTimeZone])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    void getCredentialVaultStatus()
      .then((status) => {
        if (!status.persistent) setToast('当前系统不支持安全凭据保险库，连接密码不会持久化')
      })
      .catch((error) => setToast(`凭据保险库不可用：${String(error)}`))
  }, [])

  useEffect(() => {
    const error = serverCredentialState.error
      ?? remoteDesktopCredentialState.error
      ?? workspaceCredentialState.error
    if (error) setToast(`凭据保险库同步失败：${error}`)
  }, [remoteDesktopCredentialState.error, serverCredentialState.error, workspaceCredentialState.error])

  useEffect(() => {
    const refreshSystemTimeZone = () => setSystemTimeZone(getSystemTimeZone())
    window.addEventListener('focus', refreshSystemTimeZone)
    document.addEventListener('visibilitychange', refreshSystemTimeZone)
    return () => {
      window.removeEventListener('focus', refreshSystemTimeZone)
      document.removeEventListener('visibilitychange', refreshSystemTimeZone)
    }
  }, [])

  useEffect(() => {
    selectedServerIdRef.current = selectedServerId
  }, [selectedServerId])

  useEffect(() => {
    diag('app', 'mounted')
    let last = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      const lag = now - last - 1000
      if (lag > 200) {
        diag('ui-lag', `lag_ms=${lag.toFixed(1)} active=${appHeartbeatRef.current.activeWorkspaceId} widgets=${appHeartbeatRef.current.widgetCount}`)
      }
      last = now
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void invoke<number>('set_remote_aux_limit', { limit: remoteAuxConcurrency }).catch((error) => {
      setToast(`并发设置未应用：${String(error)}`)
    })
  }, [remoteAuxConcurrency])

  useEffect(() => {
    if (!serverCredentialState.ready) return
    void invoke('ssh_register_auth_profiles', {
      profiles: servers.map((server) => ({
        host: server.host,
        user: server.user,
        port: server.port,
        authMethod: server.auth,
        privateKeyPath: server.privateKeyPath || null,
        password: server.password ?? '',
      })),
    }).catch((error) => setToast(`SSH 认证配置未应用：${String(error)}`))
  }, [serverCredentialState.ready, servers])

  useEffect(() => {
    if (!servers.some((server) => server.id === selectedServerId)) {
      setSelectedServerId(servers[0]?.id ?? '')
      setConnectionState('ready')
      setActiveConnectedServerId(null)
      setSessionId(crypto.randomUUID())
      setPassword(servers[0]?.password ?? '')
    }
  }, [selectedServerId, servers])

  useEffect(() => {
    setPassword(selectedServer.password ?? '')
  }, [selectedServer.id, selectedServer.password])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setContextMenu(null)
        setPaletteOpen((current) => !current)
        return
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
        setContextMenu(null)
        setSettingsOpen(false)
        setServerModal(null)
        setRemoteDesktopModal(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const unlistenTasks = [
      listen<SshEventPayload>('ssh:connected', (event) => {
        if (event.payload.session_id !== sessionId) return
        setConnectionState('connected')
        setActiveConnectedServerId(selectedServerId)
        setToast('SSH 已连接')
      }).catch(() => () => undefined),
      listen<SshEventPayload>('ssh:error', (event) => {
        if (event.payload.session_id !== sessionId) return
        setConnectionState('error')
        setActiveConnectedServerId(null)
        setToast(`SSH 失败：${event.payload.message ?? '连接错误'}`)
      }).catch(() => () => undefined),
    ]

    return () => {
      void Promise.all(unlistenTasks).then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten())
      })
    }
  }, [selectedServerId, sessionId])

  useEffect(() => {
    const unlistenTask = listen<{ current: number; total: number; deviceName: string }>(
      'inspect-progress',
      (event) => {
        setInspectProgress({ current: event.payload.current, total: event.payload.total })
      },
    ).catch(() => () => undefined)
    return () => {
      void unlistenTask.then((unlisten) => unlisten())
    }
  }, [])

  useEffect(() => {
    function suppressNativeContextMenu(event: globalThis.MouseEvent) {
      const target = event.target as HTMLElement
      if (!target.closest('[data-native-context-menu]')) {
        event.preventDefault()
      }
    }

    function closeContextMenu(event: Event) {
      const target = event.target
      if (target instanceof Element && target.closest('.context-menu')) return
      setContextMenu(null)
    }

    const closeContextMenuImmediately = () => setContextMenu(null)

    window.addEventListener('contextmenu', suppressNativeContextMenu)
    document.addEventListener('pointerdown', closeContextMenu, true)
    document.addEventListener('scroll', closeContextMenuImmediately, true)
    window.addEventListener('blur', closeContextMenuImmediately)
    window.addEventListener('resize', closeContextMenuImmediately)
    return () => {
      window.removeEventListener('contextmenu', suppressNativeContextMenu)
      document.removeEventListener('pointerdown', closeContextMenu, true)
      document.removeEventListener('scroll', closeContextMenuImmediately, true)
      window.removeEventListener('blur', closeContextMenuImmediately)
      window.removeEventListener('resize', closeContextMenuImmediately)
    }
  }, [])

  useEffect(() => {
    if (connectionState === 'disconnected' || connectionState === 'ready' || connectionState === 'error') {
      setActiveConnectedServerId(null)
    }
  }, [connectionState])

  function saveServer(draft: ServerDraft) {
    const normalized = normalizeServerProfile(draft)
    if (!normalized) {
      setToast('设备主机不能为空，端口必须在 1-65535 之间')
      return
    }
    if (!hasConnectionAuthentication(normalized)) {
      if (normalized.protocol === 'serial') {
        setToast('请选择串口')
      } else if (normalized.protocol === 'telnet') {
        setToast('请填写 Telnet 主机和端口')
      } else {
        setToast(normalized.auth === 'Key' ? '请选择 SSH 私钥文件' : '请输入 SSH 密码')
      }
      return
    }

    if (normalized.id === selectedServerId && (connectionState === 'connected' || connectionState === 'connecting')) {
      void closeCurrentSshSession()
      setConnectionState('ready')
      setActiveConnectedServerId(null)
      setSessionId(crypto.randomUUID())
      setPassword(normalized.password ?? '')
    }

    setServers((current) => {
      const exists = current.some((server) => server.id === normalized.id)
      return exists
        ? current.map((server) => (server.id === normalized.id ? normalized : server))
        : [...current, normalized]
    })
    setSelectedServerId(normalized.id)
    setPassword(normalized.password ?? '')
    setServerModal(null)
    setToast('服务器配置已保存')
  }

  function saveRemoteDesktopProfile(draft: RemoteDesktopDraft) {
    const normalized = normalizeRemoteDesktopProfile({
      ...draft,
      id: draft.id || crypto.randomUUID(),
      protocol: 'rdp',
      ignoreCertificate: true,
    })
    if (!normalized || !normalized.username.trim() || !normalized.password) {
      setToast('请完整填写桌面地址、用户名和密码')
      return
    }
    setRemoteDesktopProfiles((current) => {
      const exists = current.some((profile) => profile.id === normalized.id)
      return exists
        ? current.map((profile) => profile.id === normalized.id ? normalized : profile)
        : [...current, normalized]
    })
    setRemoteDesktopModal(null)
    setToast('远程桌面配置已保存')
  }

  function openRemoteDesktopProfile(profile: RemoteDesktopProfile) {
    const existing = activeWorkspace.widgets.find((widget) =>
      widget.type === 'remote-desktop'
      && widget.remoteDesktop?.host === profile.host
      && widget.remoteDesktop.port === profile.port
      && widget.remoteDesktop.username === profile.username,
    )
    if (existing) {
      focusWorkbenchWidget(existing.id)
      setActivePanel(null)
      setToast(`${profile.name} 已聚焦，点击连接后启动`)
      return
    }

    const sameTypeCount = activeWorkspace.widgets.filter((widget) => widget.type === 'remote-desktop').length
    const { id: _id, name: _name, group: _group, ...connection } = profile
    const nextWidget: WorkbenchWidget = {
      ...createWorkbenchWidget('remote-desktop', sameTypeCount, activeWorkspace.widgets.length),
      title: profile.name,
      remoteDesktop: connection,
    }
    setWorkspaces((current) => current.map((workspace) => workspace.id === activeWorkspace.id
      ? {
          ...workspace,
          widgets: [...workspace.widgets, nextWidget],
          layout: addWidgetToLayout(workspace.layout, nextWidget.id),
          focusedWidgetId: nextWidget.id,
          magnifiedWidgetId: undefined,
          layoutPreset: undefined,
        }
      : workspace))
    setActivePanel(null)
    setToast(`${profile.name} 已添加到工作台，当前保持待命`)
  }

  function deleteRemoteDesktopProfile(id: string) {
    const profile = remoteDesktopProfiles.find((item) => item.id === id)
    setRemoteDesktopProfiles((current) => current.filter((item) => item.id !== id))
    setToast(`${profile?.name ?? '远程桌面'} 已删除`)
  }

  function openRemoteDesktopProfileContextMenu(event: MouseEvent<HTMLElement>, profile: RemoteDesktopProfile) {
    openContextMenu(event, [
      { label: '打开到工作台', hint: `${profile.host}:${profile.port}`, onClick: () => openRemoteDesktopProfile(profile) },
      { label: '编辑桌面连接', hint: profile.name, onClick: () => setRemoteDesktopModal(profile) },
      {
        label: '复制连接地址',
        hint: `${profile.host}:${profile.port}`,
        onClick: () => {
          void navigator.clipboard.writeText(`${profile.host}:${profile.port}`)
          setToast('桌面连接地址已复制')
        },
      },
      { label: '删除桌面连接', hint: profile.name, danger: true, onClick: () => deleteRemoteDesktopProfile(profile.id) },
    ])
  }

  function deleteServer(id: string) {
    if (id === selectedServerId) {
      void closeCurrentSshSession()
      setPassword('')
      setConnectionState('ready')
      setActiveConnectedServerId(null)
      setSessionId(crypto.randomUUID())
    }

    setServers((current) => {
      const next = current.filter((server) => server.id !== id)
      if (selectedServerId === id) {
        setSelectedServerId(next[0]?.id ?? '')
      }
      return next
    })
    setServerConnectionStates((current) => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
    setToast('服务器已删除')
  }

  async function closeCurrentSshSession() {
    try {
      await invoke('ssh_disconnect', { sessionId })
    } catch {
      // The session may already be closed remotely.
    }
  }

  function selectServer(id: string) {
    if (id === selectedServerId) return

    const nextState = serverConnectionStates[id] ?? 'ready'
    selectedServerIdRef.current = id
    setSelectedServerId(id)
    setConnectionState(nextState)
    setActiveConnectedServerId(nextState === 'connected' || nextState === 'connecting' ? id : null)
    setSessionId(crypto.randomUUID())
    setPassword(servers.find((server) => server.id === id)?.password ?? '')
    setToast('已切换服务器')
  }

  function openServerTerminal(server: ServerProfile, connectImmediately = false) {
    if (server.id !== selectedServerId) {
      selectServer(server.id)
    }

    if (server.protocol === 'serial') {
      if (!server.serialPort) {
        setToast('请先编辑设备并选择串口')
        setServerModal(server)
        return
      }
    } else if (!server.host.trim()) {
      setToast('设备主机不能为空')
      setServerModal(server)
      return
    }

    if (!hasConnectionAuthentication(server)) {
      setToast(server.protocol === 'telnet' ? '请先编辑设备并补全 Telnet 连接信息' : '请先编辑设备并补全 SSH 认证信息')
      setServerModal(server)
      return
    }

    const currentWidgets = activeWorkspace.widgets
    const requestedAuxTypes: Array<Extract<WorkbenchWidgetType, 'files' | 'monitor' | 'processes'>> = server.protocol === 'ssh'
      ? [
          ...(serverLaunchOptions.files ? ['files' as const] : []),
          ...(serverLaunchOptions.monitor ? ['monitor' as const] : []),
          ...(serverLaunchOptions.processes ? ['processes' as const] : []),
        ]
      : []
    const existing = currentWidgets.find(
      (widget) => widget.type === 'ssh-terminal' && widget.serverId === server.id,
    )
    const nextTerminalWidget = existing
      ? undefined
      : {
          ...createWorkbenchWidget(
            'ssh-terminal',
            currentWidgets.filter((widget) => widget.type === 'ssh-terminal').length,
            currentWidgets.length,
          ),
          title: server.name || `${server.user}@${server.host}`,
          serverId: server.id,
        }
    const missingAuxTypes = requestedAuxTypes.filter((type) =>
      !currentWidgets.some((widget) => widget.type === type && widget.serverId === server.id),
    )

    if (connectImmediately) {
      requestRemoteTerminalSessionConnection(getRemoteWidgetSessionId(existing ?? nextTerminalWidget!))
    }

    if (existing && missingAuxTypes.length === 0) {
      focusWorkbenchWidget(existing.id)
      setActivePanel(null)
      setToast(connectImmediately ? `${server.name} 正在连接 SSH` : `${server.name} 终端已聚焦`)
      return
    }

    setWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id !== activeWorkspace.id) return workspace
        const widgets = [...workspace.widgets]
        const existingTerminal = widgets.find(
          (widget) => widget.type === 'ssh-terminal' && widget.serverId === server.id,
        )
        let focusedWidgetId = existingTerminal?.id ?? ''

        if (!existingTerminal && nextTerminalWidget) {
          widgets.push(nextTerminalWidget)
          focusedWidgetId = nextTerminalWidget.id
        }

        requestedAuxTypes.forEach((type) => {
          if (widgets.some((widget) => widget.type === type && widget.serverId === server.id)) return
          const typeLabel = type === 'files' ? '文件管理' : type === 'monitor' ? '机器监控' : '系统进程'
          const sameTypeCount = widgets.filter((widget) => widget.type === type).length
          widgets.push({
            ...createWorkbenchWidget(type, sameTypeCount, widgets.length),
            title: `${server.name} ${typeLabel}`,
            serverId: server.id,
          })
        })

        return {
          ...workspace,
          widgets,
          layout: ensureLayoutWidgets(workspace.layout, widgets.map((widget) => widget.id)),
          focusedWidgetId: focusedWidgetId || widgets.at(-1)?.id || '',
          magnifiedWidgetId: undefined,
          layoutPreset: undefined,
        }
      }),
    )
    setActivePanel(null)
    setConnectionState('ready')
    setActiveConnectedServerId(null)
    setServerConnectionStates((current) => ({ ...current, [server.id]: 'ready' }))
    setToast(connectImmediately
      ? `${server.name} 正在连接 SSH`
      : requestedAuxTypes.length
        ? `${server.name} 终端已待命，辅助窗口已按勾选添加`
        : `${server.name} 终端已待命，点击连接后启动`)
  }

  function openServerRunPanel(server: ServerProfile) {
    openServerTerminal(server, true)
  }

  function connectServerFromList(server: ServerProfile) {
    openServerTerminal(server)
  }

  function openServerAuxWidget(server: ServerProfile, type: Extract<WorkbenchWidgetType, 'files' | 'monitor' | 'processes'>) {
    if (server.protocol && server.protocol !== 'ssh') {
      setToast('文件管理/机器监控/系统进程仅支持 SSH 设备')
      return
    }
    if (server.id !== selectedServerId) {
      selectServer(server.id)
    }

    if (!server.host.trim()) {
      setToast('服务器主机不能为空')
      setServerModal(server)
      return
    }

    if (!hasSshAuthentication(server)) {
      setToast('请先编辑服务器并补全 SSH 认证信息')
      setServerModal(server)
      return
    }

    const existing = activeWorkspace.widgets.find(
      (widget) => widget.type === type && widget.serverId === server.id,
    )
    const typeLabel = type === 'files' ? '文件管理' : type === 'monitor' ? '机器监控' : '系统进程'

    if (existing) {
      focusWorkbenchWidget(existing.id)
      setActivePanel(null)
      setToast(`${server.name} ${typeLabel}已聚焦`)
      return
    }

    const sameTypeCount = activeWorkspace.widgets.filter((widget) => widget.type === type).length
    const nextWidget = {
      ...createWorkbenchWidget(type, sameTypeCount, activeWorkspace.widgets.length),
      title: `${server.name} ${typeLabel}`,
      serverId: server.id,
    }

    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? {
              ...workspace,
              widgets: [...workspace.widgets, nextWidget],
              layout: addWidgetToLayout(workspace.layout, nextWidget.id),
              focusedWidgetId: nextWidget.id,
              magnifiedWidgetId: undefined,
              layoutPreset: undefined,
            }
          : workspace,
      ),
    )
    setActivePanel(null)
    setToast(`${server.name} ${typeLabel}已打开`)
  }

  function openServerContextMenu(event: MouseEvent<HTMLElement>, server: ServerProfile) {
    if (server.id !== selectedServerId) {
      selectServer(server.id)
    }
    openContextMenu(event, [
      {
        label: server.protocol === 'telnet' ? '打开 Telnet 终端' : server.protocol === 'serial' ? '打开串口终端' : '打开 SSH 终端',
        hint: server.protocol === 'serial' ? (server.serialPort ?? '') : sshAuthenticationHint(server),
        onClick: () => connectServerFromList(server),
      },
      ...(server.protocol === 'ssh' ? [
        { label: '打开文件管理', hint: hasSshAuthentication(server) ? server.host : sshAuthenticationHint(server), onClick: () => openServerAuxWidget(server, 'files') },
        { label: '打开机器监控', hint: hasSshAuthentication(server) ? server.host : sshAuthenticationHint(server), onClick: () => openServerAuxWidget(server, 'monitor') },
        { label: '打开系统进程', hint: hasSshAuthentication(server) ? server.host : sshAuthenticationHint(server), onClick: () => openServerAuxWidget(server, 'processes') },
      ] : []),
      { label: '编辑设备', hint: server.host, onClick: () => setServerModal(server) },
      {
        label: '复制连接地址',
        hint: server.protocol === 'serial' ? (server.serialPort ?? '') : `${server.user}@${server.host}:${server.port}`,
        onClick: () => {
          void navigator.clipboard.writeText(server.protocol === 'serial' ? (server.serialPort ?? '') : `${server.user}@${server.host}:${server.port}`)
          setToast('连接地址已复制')
        },
      },
      { label: '删除设备', hint: server.name, danger: true, onClick: () => deleteServer(server.id) },
    ])
  }

  async function connectEmbeddedSsh() {
    if (connectionState === 'connecting') {
      setToast('正在连接中，请稍候')
      return
    }

    if (connectionState === 'connected' && activeConnectedServerId === selectedServer.id) {
      setToast('当前服务器已经连接')
      return
    }

    if (!hasSshAuthentication(selectedServer)) {
      if (selectedServer.protocol && selectedServer.protocol !== 'ssh') {
        setToast('Telnet/串口设备请在服务器工作台中打开终端连接')
        return
      }
      setConnectionState('error')
      setToast('请补全 SSH 认证信息后再连接')
      return
    }

    if (!selectedServer.host.trim() || !selectedServer.user.trim()) {
      setConnectionState('error')
      setToast('服务器主机和用户不能为空')
      return
    }

    if (connectionState === 'connected' && activeConnectedServerId !== selectedServer.id) {
      await closeCurrentSshSession()
    }

    setConnectionState('connecting')
    try {
      await invoke('ssh_connect', {
        sessionId,
        host: selectedServer.host,
        user: selectedServer.user,
        password,
        authMethod: selectedServer.auth,
        privateKeyPath: selectedServer.privateKeyPath || null,
        port: selectedServer.port,
        cols: terminalSize.cols,
        rows: terminalSize.rows,
      })
      setToast('SSH 正在后台连接')
    } catch (error) {
      setConnectionState('error')
      setActiveConnectedServerId(null)
      setToast(`SSH 失败：${String(error)}`)
    }
  }

  async function disconnectEmbeddedSsh() {
    try {
      await invoke('ssh_disconnect', { sessionId })
      setConnectionState('disconnected')
      setSessionId(crypto.randomUUID())
      setActiveConnectedServerId(null)
      setToast('SSH 已断开')
    } catch (error) {
      setConnectionState('disconnected')
      setActiveConnectedServerId(null)
      setSessionId(crypto.randomUUID())
      setToast(`断开失败：${String(error)}`)
    }
  }

  async function copyTerminal() {
    const target = getWorkspaceCommandTarget(activeWorkspace)
    const controller = target ? terminalControllers.get(target.id) : undefined
    if (!target || !controller) {
      setToast('当前工作台没有可复制的终端')
      return
    }
    const text = controller.readText()
    if (!text.trim()) {
      setToast('当前终端没有可复制的输出')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setToast('终端输出已复制')
    } catch {
      setToast('复制失败：系统剪贴板不可用')
    }
  }

  function addCommandHistory(widget: WorkbenchWidget, command: string) {
    const server = widget.type === 'ssh-terminal'
      ? servers.find((item) => item.id === widget.serverId)
      : undefined
    setCommandHistory((current) => [
      {
        id: crypto.randomUUID(),
        command,
        server: server ? formatServerAddress(server) : '本地终端',
        time: formatLocalizedDateTime(new Date(), resolvedLanguage, resolvedTimeZone, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
      },
      ...current,
    ].slice(0, 12))
  }

  async function writeCommandToTerminal(widget: WorkbenchWidget, command: string, successMessage?: string) {
    const controller = terminalControllers.get(widget.id)
    if (!controller) throw new Error('终端还没有准备好，请稍后重试')
    if (!controller.isReady()) {
      throw new Error(controller.kind === 'ssh' ? 'SSH 终端尚未连接' : '本地终端尚未启动')
    }
    focusWorkbenchWidget(widget.id)
    await controller.write(formatTerminalCommand(command))
    controller.focus()
    addCommandHistory(widget, command)
    if (successMessage) setToast(successMessage)
  }

  function sendCommand(command: string) {
    if (!command.trim()) return
    const target = getWorkspaceCommandTarget(activeWorkspace)
    if (!target) {
      setToast('当前工作台没有可执行命令的终端')
      return
    }
    void writeCommandToTerminal(target, command).catch((error) => {
      setToast(`执行失败：${String(error)}`)
    })
  }

  function runTerminalCli(widgetId: string, tool: CliToolInfo) {
    const widget = workspaces.flatMap((workspace) => workspace.widgets).find((item) => item.id === widgetId)
    if (!widget || (widget.type !== 'local-terminal' && widget.type !== 'ssh-terminal')) {
      setToast('目标终端不存在')
      return
    }
    void writeCommandToTerminal(widget, tool.command, `${tool.name} 已在 ${widget.title} 中启动`).catch((error) => {
      setToast(`启动 ${tool.name} 失败：${String(error)}`)
    })
  }

  function clearCurrentTerminal() {
    const target = getWorkspaceCommandTarget(activeWorkspace)
    const controller = target ? terminalControllers.get(target.id) : undefined
    if (!target || !controller) {
      setToast('当前工作台没有可清空的终端')
      return
    }
    controller.clear()
    controller.focus()
    setToast(`${target.title} 已清空`)
  }

  function addWorkbenchWidget(type: WorkbenchWidgetType) {
    const currentWidgets = activeWorkspace.widgets
    const sameTypeCount = currentWidgets.filter((widget) => widget.type === type).length
    const nextWidget = createWorkbenchWidget(type, sameTypeCount, currentWidgets.length)
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? {
              ...workspace,
              widgets: [...workspace.widgets, nextWidget],
              layout: addWidgetToLayout(workspace.layout, nextWidget.id),
              focusedWidgetId: nextWidget.id,
              magnifiedWidgetId: undefined,
              layoutPreset: undefined,
            }
          : workspace,
      ),
    )
    setActivePanel(null)
    setToast(`${nextWidget.title} 已添加`)
  }

  function setWorkbenchWidgetConnection(widgetId: string, serverId?: string) {
    setWorkspaces((current) =>
      current.map((workspace) => ({
        ...workspace,
        widgets: workspace.widgets.map((widget) =>
          widget.id === widgetId && (widget.type === 'files' || widget.type === 'monitor' || widget.type === 'processes')
            ? { ...widget, serverId }
            : widget,
        ),
      })),
    )
    const server = serverId ? servers.find((item) => item.id === serverId) : undefined
    setToast(server ? `已连接 ${server.user}@${server.host}` : '已切换到本地计算机')
  }

  function setRemoteDesktopConnection(widgetId: string, connection: RemoteDesktopConnection) {
    setWorkspaces((current) => current.map((workspace) => ({
      ...workspace,
      widgets: workspace.widgets.map((widget) => widget.id === widgetId && widget.type === 'remote-desktop'
        ? {
            ...widget,
            title: `${connection.protocol.toUpperCase()} ${connection.host}`,
            remoteDesktop: connection,
          }
        : widget),
    })))
    setToast(`${connection.protocol.toUpperCase()} ${connection.host} 已保存`)
  }

  function saveWorkbenchWidgetConnection(widgetId: string, draft: ServerDraft) {
    const normalized = normalizeServerProfile(draft)
    if (!normalized || !hasSshAuthentication(normalized)) {
      setToast('连接信息不完整，请检查地址、端口和 SSH 认证信息')
      return
    }
    setServers((current) => {
      const exists = current.some((server) => server.id === normalized.id)
      return exists
        ? current.map((server) => (server.id === normalized.id ? normalized : server))
        : [...current, normalized]
    })
    setWorkspaces((current) =>
      current.map((workspace) => ({
        ...workspace,
        widgets: workspace.widgets.map((widget) =>
          widget.id === widgetId && (widget.type === 'files' || widget.type === 'monitor' || widget.type === 'processes')
            ? { ...widget, serverId: normalized.id }
            : widget,
        ),
      })),
    )
    setSelectedServerId(normalized.id)
    setToast(`已保存并连接 ${normalized.user}@${normalized.host}`)
  }

  function addWorkspace() {
    const nextIndex = workspaces.reduce((highest, workspace) => {
      const match = /^W(\d+)\s/.exec(workspace.name)
      return Math.max(highest, match ? Number(match[1]) : 0)
    }, 0) + 1
    const workspace: WorkbenchWorkspace = {
      id: `workspace-${crypto.randomUUID()}`,
      name: `W${nextIndex} 工作台`,
      widgets: [],
      focusedWidgetId: '',
      layout: null,
      layoutPreset: 'grid',
    }
    setWorkspaces((current) => [...current, workspace])
    setActiveWorkspaceId(workspace.id)
    setToast(`${workspace.name} 已创建`)
  }

  function closeWorkspace(workspaceId: string) {
    const closingIndex = workspaces.findIndex((workspace) => workspace.id === workspaceId)
    const closingWorkspace = workspaces[closingIndex]
    if (!closingWorkspace) return

    closingWorkspace.widgets.forEach((widget) => {
      fileManagerViewCache.delete(widget.id)
      monitorViewCache.delete(widget.id)
      processViewCache.delete(widget.id)
      if (widget.type === 'local-terminal') {
        localTerminalOutputCache.delete(getLocalWidgetSessionId(widget))
      }
      if (widget.type === 'ssh-terminal') {
        const widgetSessionId = getRemoteWidgetSessionId(widget)
        remoteTerminalOutputCache.delete(widgetSessionId)
        remoteTerminalConnectedSessions.delete(widgetSessionId)
        remoteTerminalConnectingSessions.delete(widgetSessionId)
        remoteTerminalManualConnectSessions.delete(widgetSessionId)
        void stopRemoteTerminalSession(widgetSessionId, widget.serverId)
      }
      if (widget.type === 'remote-desktop') {
        remoteDesktopAutoConnectWidgets.delete(widget.id)
        void invoke('rdp_disconnect', { sessionId: getRemoteDesktopWidgetSessionId(widget) }).catch(() => undefined)
      }
    })

    const remainingWorkspaces = workspaces.filter((workspace) => workspace.id !== workspaceId)
    if (remainingWorkspaces.length === 0) {
      const replacement: WorkbenchWorkspace = {
        id: `workspace-${crypto.randomUUID()}`,
        name: 'W1 工作台',
        widgets: [],
        focusedWidgetId: '',
        layout: null,
        layoutPreset: 'grid',
      }
      setWorkspaces([replacement])
      setActiveWorkspaceId(replacement.id)
    } else {
      setWorkspaces(remainingWorkspaces)
      if (activeWorkspaceId === workspaceId) {
        const nextWorkspace = remainingWorkspaces[Math.min(closingIndex, remainingWorkspaces.length - 1)]
        setActiveWorkspaceId(nextWorkspace.id)
      }
    }

    setContextMenu(null)
    setToast(`${closingWorkspace.name} 已关闭`)
  }

  const openContextMenu = useCallback((event: MouseEvent<HTMLElement>, items: ContextMenuItem[]) => {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = Math.min(300, Math.max(220, window.innerWidth - 16))
    const menuHeight = Math.min(items.length * 38 + 12, window.innerHeight - 16)
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      items,
    })
  }, [])

  function resizeWorkbenchLayout(
    branchId: string,
    beforeIndex: number,
    beforeSize: number,
    afterSize: number,
  ) {
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? {
              ...workspace,
              layout: resizeLayoutBranch(
                workspace.layout,
                branchId,
                beforeIndex,
                beforeSize,
                afterSize,
              ),
              layoutPreset: undefined,
            }
          : workspace,
      ),
    )
  }

  function stopRemoteTerminalSession(sessionId: string, serverId?: string) {
    const protocol = serverId ? servers.find((server) => server.id === serverId)?.protocol ?? 'ssh' : 'ssh'
    if (protocol === 'telnet') return invoke('telnet_session_stop', { sessionId }).catch(() => undefined)
    if (protocol === 'serial') return invoke('serial_session_stop', { sessionId }).catch(() => undefined)
    return invoke('ssh_disconnect', { sessionId }).catch(() => undefined)
  }

  function closeWorkbenchWidget(id: string) {
    const closingWidget = activeWorkspace.widgets.find((widget) => widget.id === id)
    fileManagerViewCache.delete(id)
    monitorViewCache.delete(id)
    processViewCache.delete(id)
    if (closingWidget?.type === 'local-terminal') {
      localTerminalOutputCache.delete(getLocalWidgetSessionId(closingWidget))
    }
    if (closingWidget?.type === 'ssh-terminal') {
      const sessionId = getRemoteWidgetSessionId(closingWidget)
      remoteTerminalOutputCache.delete(sessionId)
      remoteTerminalConnectedSessions.delete(sessionId)
      remoteTerminalConnectingSessions.delete(sessionId)
      remoteTerminalManualConnectSessions.delete(sessionId)
      void stopRemoteTerminalSession(sessionId, closingWidget.serverId)
      if (closingWidget.serverId) {
        setServerConnectionStates((current) => ({ ...current, [closingWidget.serverId!]: 'ready' }))
        if (selectedServerIdRef.current === closingWidget.serverId) {
          setConnectionState('ready')
          setActiveConnectedServerId(null)
        }
      }
    }
    if (closingWidget?.type === 'remote-desktop') {
      remoteDesktopAutoConnectWidgets.delete(closingWidget.id)
      void invoke('rdp_disconnect', { sessionId: getRemoteDesktopWidgetSessionId(closingWidget) }).catch(() => undefined)
    }
    setWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id !== activeWorkspace.id) return workspace
        const widgets = workspace.widgets.filter((widget) => widget.id !== id)
        return {
          ...workspace,
          widgets,
          layout: removeWidgetFromLayout(workspace.layout, id),
          focusedWidgetId: workspace.focusedWidgetId === id ? widgets.at(-1)?.id ?? '' : workspace.focusedWidgetId,
          magnifiedWidgetId: workspace.magnifiedWidgetId === id ? undefined : workspace.magnifiedWidgetId,
          layoutPreset: undefined,
        }
      }),
    )
    setContextMenu(null)
  }

  function refreshWorkbenchWidget(id: string) {
    const refreshingWidget = activeWorkspace.widgets.find((widget) => widget.id === id)
    if (refreshingWidget?.type === 'local-terminal') {
      localTerminalOutputCache.delete(getLocalWidgetSessionId(refreshingWidget))
    }
    if (refreshingWidget?.type === 'ssh-terminal') {
      const sessionId = getRemoteWidgetSessionId(refreshingWidget)
      remoteTerminalOutputCache.delete(sessionId)
      remoteTerminalConnectedSessions.delete(sessionId)
      remoteTerminalConnectingSessions.delete(sessionId)
      remoteTerminalManualConnectSessions.delete(sessionId)
      void stopRemoteTerminalSession(sessionId, refreshingWidget.serverId)
      if (refreshingWidget.serverId) {
        setServerConnectionStates((current) => ({ ...current, [refreshingWidget.serverId!]: 'connecting' }))
        if (selectedServerIdRef.current === refreshingWidget.serverId) {
          setConnectionState('connecting')
          setActiveConnectedServerId(refreshingWidget.serverId)
        }
      }
    }
    if (refreshingWidget?.type === 'remote-desktop') {
      void invoke('rdp_disconnect', { sessionId: getRemoteDesktopWidgetSessionId(refreshingWidget) }).catch(() => undefined)
    }
    setWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id !== activeWorkspace.id) return workspace
        const widgets = workspace.widgets.map((widget) => {
          if (widget.id !== id) return widget
          return {
            ...widget,
            ...(widget.type === 'ssh-terminal' ? { sessionId: `ssh-${crypto.randomUUID()}` } : {}),
            ...(widget.type === 'local-terminal' ? { sessionId: `local-${crypto.randomUUID()}` } : {}),
            ...(widget.type === 'remote-desktop' ? { sessionId: `desktop-${crypto.randomUUID()}` } : {}),
          }
        })
        return {
          ...workspace,
          widgets,
        }
      }),
    )
    setToast('窗口正在刷新')
  }

  function moveWorkbenchWidget(
    sourceId: string,
    targetId: string,
    zone: LayoutDropZone,
    parentDirection: LayoutDirection,
  ) {
    if (!sourceId || !targetId || sourceId === targetId) return
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? {
              ...workspace,
              layout: moveWidgetInLayout(
                workspace.layout,
                sourceId,
                targetId,
                zone,
                parentDirection,
              ),
              focusedWidgetId: sourceId,
              layoutPreset: undefined,
            }
          : workspace,
      ),
    )
    diag('workbench-move', `source=${sourceId} target=${targetId} zone=${zone}`)
  }

  function moveWorkbenchWidgetToWorkspace(widgetId: string, targetWorkspaceId: string) {
    const sourceWorkspace = workspaces.find((workspace) => workspace.widgets.some((widget) => widget.id === widgetId))
    const targetWorkspace = workspaces.find((workspace) => workspace.id === targetWorkspaceId)
    const movingWidget = sourceWorkspace?.widgets.find((widget) => widget.id === widgetId)
    if (!sourceWorkspace || !targetWorkspace || !movingWidget || sourceWorkspace.id === targetWorkspace.id) return

    const preserveMagnified = sourceWorkspace.magnifiedWidgetId === widgetId
    setWorkspaces((current) => current.map((workspace) => {
      if (workspace.id === sourceWorkspace.id) {
        const widgets = workspace.widgets.filter((widget) => widget.id !== widgetId)
        return {
          ...workspace,
          widgets,
          layout: removeWidgetFromLayout(workspace.layout, widgetId),
          focusedWidgetId: workspace.focusedWidgetId === widgetId ? widgets.at(-1)?.id ?? '' : workspace.focusedWidgetId,
          magnifiedWidgetId: workspace.magnifiedWidgetId === widgetId ? undefined : workspace.magnifiedWidgetId,
          layoutPreset: undefined,
        }
      }
      if (workspace.id === targetWorkspace.id) {
        const widgets = [...workspace.widgets, movingWidget]
        return {
          ...workspace,
          widgets,
          layout: addWidgetToLayout(workspace.layout, widgetId),
          focusedWidgetId: widgetId,
          magnifiedWidgetId: preserveMagnified ? widgetId : workspace.magnifiedWidgetId,
          layoutPreset: undefined,
        }
      }
      return workspace
    }))
    setActiveWorkspaceId(targetWorkspace.id)
    setToast(`${movingWidget.title} 已移动到 ${targetWorkspace.name}`)
    diag('workbench-workspace-move', `widget=${widgetId} source=${sourceWorkspace.id} target=${targetWorkspace.id}`)
  }

  function focusWorkbenchWidget(id: string) {
    const started = performance.now()
    setWorkspaces((current) => {
      const workspace = current.find((item) => item.id === activeWorkspace.id)
      if (!workspace || (workspace.focusedWidgetId === id && (!workspace.magnifiedWidgetId || workspace.magnifiedWidgetId === id))) return current
      diag('workbench-focus', `widget=${id} from=${workspace.focusedWidgetId} elapsed_ms=${(performance.now() - started).toFixed(1)}`)
      return current.map((item) => (item.id === activeWorkspace.id
        ? {
            ...item,
            focusedWidgetId: id,
            magnifiedWidgetId: item.magnifiedWidgetId === id ? id : undefined,
          }
        : item))
    })
  }

  function toggleMaximizeWidget(id: string) {
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? {
              ...workspace,
              focusedWidgetId: id,
              magnifiedWidgetId: workspace.magnifiedWidgetId === id ? undefined : id,
            }
          : workspace,
      ),
    )
  }

  function arrangeActiveWorkspace() {
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? {
              ...workspace,
              layout: createLayoutForWidgets(workspace.widgets.map((widget) => widget.id)),
              magnifiedWidgetId: undefined,
              layoutPreset: undefined,
            }
          : workspace,
      ),
    )
    setToast('已重置为 Wave 智能分屏')
  }

  async function exportServers() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(
        servers.map(({ password: _password, ...server }) => server),
        null,
        2,
      ))
      setToast('服务器配置 JSON 已复制（不包含凭据）')
    } catch {
      setToast('复制失败：系统剪贴板不可用')
    }
  }

  function importServersFromText(value: string) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (!Array.isArray(parsed)) {
        setToast('导入失败：配置必须是数组')
        return
      }

      const normalized = parsed
        .map((server) => normalizeServerProfile(server))
        .filter((server): server is ServerProfile => Boolean(server))

      if (normalized.length === 0) {
        setToast('没有找到有效服务器配置')
        return
      }

      void closeCurrentSshSession()
      setServers(normalized)
      setSelectedServerId(normalized[0].id)
      setConnectionState('ready')
      setActiveConnectedServerId(null)
      setServerConnectionStates({})
      setSessionId(crypto.randomUUID())
      setPassword('')
      setToast('服务器配置已导入')
    } catch {
      setToast('导入失败：JSON 无效')
    }
  }

  function resetServers() {
    void closeCurrentSshSession()
    setServers(defaultServers)
    setSelectedServerId('')
    setConnectionState('ready')
    setActiveConnectedServerId(null)
    setServerConnectionStates({})
    setSessionId(crypto.randomUUID())
    setPassword('')
    setToast('服务器配置已重置')
  }

  function addSnippet(snippet: Omit<Snippet, 'id'>) {
    const name = snippet.name.trim()
    const command = snippet.command.trim()
    if (!name || !command) {
      setToast('片段名称和命令不能为空')
      return
    }

    setSnippets((current) => {
      const withoutDuplicate = current.filter((item) => item.command !== command)
      return [{ id: crypto.randomUUID(), name, command, category: snippet.category || '未分类' }, ...withoutDuplicate]
    })
    setToast('命令片段已保存')
  }

  function deleteSnippet(id: string) {
    setSnippets((current) => current.filter((snippet) => snippet.id !== id))
    setToast('命令片段已删除')
  }

  function addCategory(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (snippetCategories.includes(trimmed)) {
      setToast(`分类「${trimmed}」已存在`)
      return
    }
    setSnippetCategories((current) => {
      const withoutUncategorized = current.filter((c) => c !== '未分类')
      return [...withoutUncategorized, trimmed, '未分类']
    })
    setToast(`分类「${trimmed}」新增成功`)
  }

  function deleteCategory(name: string) {
    if (name === '未分类') {
      setToast('「未分类」是默认分类，不可删除')
      return
    }
    const commandCount = snippets.filter((s) => s.category === name).length
    if (commandCount > 0) {
      const confirmed = window.confirm(`分类「${name}」下存在 ${commandCount} 条命令，删除分类将连同命令一起删除，是否继续？`)
      if (!confirmed) return
    }
    setSnippetCategories((current) => current.filter((c) => c !== name))
    setSnippets((current) => current.filter((s) => s.category !== name))
    setToast(`分类「${name}」删除成功${commandCount > 0 ? `（含 ${commandCount} 条命令）` : ''}`)
  }

  function reorderCategories(fromIndex: number, toIndex: number) {
    setSnippetCategories((current) => {
      const withoutUncategorized = current.filter((c) => c !== '未分类')
      if (fromIndex < 0 || fromIndex >= withoutUncategorized.length || toIndex < 0 || toIndex >= withoutUncategorized.length) return current
      const result = [...withoutUncategorized]
      const [moved] = result.splice(fromIndex, 1)
      result.splice(toIndex, 0, moved)
      return [...result, '未分类']
    })
  }

  function moveSnippet(id: string, category: string) {
    setSnippets((current) =>
      current.map((s) => (s.id === id ? { ...s, category } : s)),
    )
  }

  function addInspectDevice(device: Omit<InspectDevice, 'id'>) {
    const id = `inspect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    setInspectDevices((current) => [...current, { ...device, id }])
    setToast(t('设备已添加'))
  }

  function updateInspectDevice(id: string, patch: Partial<Omit<InspectDevice, 'id'>>) {
    setInspectDevices((current) => current.map((d) => (d.id === id ? { ...d, ...patch } : d)))
    setToast(t('设备已更新'))
  }

  function deleteInspectDevice(id: string) {
    setInspectDevices((current) => current.filter((d) => d.id !== id))
    setToast(t('设备已删除'))
  }

  async function importOpenSshConfig() {
    try {
      const imported = await invoke<unknown[]>('ssh_import_config')
      const normalized = imported
        .map((server) => normalizeServerProfile(server))
        .filter((server): server is ServerProfile => Boolean(server))
      if (normalized.length === 0) {
        setToast('没有在 ~/.ssh/config 中找到可导入的主机')
        return
      }
      const existing = new Set(servers.map((server) => `${server.user}@${server.host}:${server.port}`.toLowerCase()))
      const additions = normalized.filter((server) => {
        const key = `${server.user}@${server.host}:${server.port}`.toLowerCase()
        if (existing.has(key)) return false
        existing.add(key)
        return true
      })
      if (additions.length > 0) setServers((current) => [...current, ...additions])
      setToast(additions.length > 0 ? `已从 SSH config 导入 ${additions.length} 个服务器` : 'SSH config 中的服务器已经存在')
    } catch (error) {
      setToast(`SSH config 导入失败：${String(error)}`)
    }
  }

  async function exportDiagnostics() {
    try {
      const destination = await invoke<string | null>('export_diagnostics')
      setToast(destination ? `诊断日志已导出到 ${destination}` : '已取消导出诊断日志')
    } catch (error) {
      setToast(`诊断日志导出失败：${String(error)}`)
    }
  }

  function clearCommandHistory() {
    setCommandHistory([])
    setToast('执行记录已清空')
  }

  function addSessionNote(text: string) {
    const cleanText = text.trim()
    if (!cleanText) {
      setToast('笔记内容不能为空')
      return
    }

    setSessionNotes((current) => [{ id: crypto.randomUUID(), text: cleanText, done: false }, ...current])
    setToast('会话笔记已添加')
  }

  function toggleSessionNote(id: string) {
    setSessionNotes((current) =>
      current.map((note) => (note.id === id ? { ...note, done: !note.done } : note)),
    )
  }

  function deleteSessionNote(id: string) {
    setSessionNotes((current) => current.filter((note) => note.id !== id))
    setToast('会话笔记已删除')
  }

  const handleRemoteStatus = useCallback((serverId: string, state: ConnectionState, message?: string) => {
    const snapshot = `${state}\u0000${message ?? ''}`
    if (remoteStatusSnapshotRef.current.get(serverId) === snapshot) return
    remoteStatusSnapshotRef.current.set(serverId, snapshot)
    setServerConnectionStates((current) => (
      current[serverId] === state ? current : { ...current, [serverId]: state }
    ))
    if (selectedServerIdRef.current === serverId) {
      setConnectionState((current) => (current === state ? current : state))
      const nextConnectedServerId = state === 'connected' || state === 'connecting' ? serverId : null
      setActiveConnectedServerId((current) => (
        current === nextConnectedServerId ? current : nextConnectedServerId
      ))
    }
    if (message) setToast((current) => (current === message ? current : message))
  }, [])

  const handleRenderProfile = useCallback<ProfilerOnRenderCallback>((id, phase, actualDuration, baseDuration) => {
    if (actualDuration > DIAG_SLOW_MS) {
      diag(
        'react-render',
        `${id} phase=${phase} actual_ms=${actualDuration.toFixed(1)} base_ms=${baseDuration.toFixed(1)} widgets=${appHeartbeatRef.current.widgetCount}`,
      )
    }
  }, [])

  function changeThemePreset(value: AppThemePresetId) {
    if (value === themePreset || !isAppThemePresetId(value)) return
    const nextPreset = appThemePresetMap[value]
    if (!reduceMotion) {
      themeTransitionSequenceRef.current += 1
      setThemeTransition({
        id: themeTransitionSequenceRef.current,
        color: nextPreset.effects.glowPrimary,
        intensity: nextPreset.effects.motionIntensity,
      })
    }
    setThemePreset(value)
  }

  async function chooseAppBackground() {
    if (backgroundBusy) return
    setBackgroundBusy(true)
    try {
      const selection = await invoke<AppBackgroundSelection | null>('choose_app_background')
      if (!selection) return
      setAppBackground((current) => ({
        ...current,
        enabled: true,
        path: selection.path,
        name: selection.name,
      }))
    } catch (reason) {
      setToast(`背景图片设置失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    } finally {
      setBackgroundBusy(false)
    }
  }

  function changeAppBackgroundEnabled(enabled: boolean) {
    if (enabled && !appBackground.path) {
      void chooseAppBackground()
      return
    }
    setAppBackground((current) => ({ ...current, enabled }))
  }

  async function clearAppBackground() {
    if (backgroundBusy) return
    setBackgroundBusy(true)
    try {
      await invoke('clear_app_background')
      setAppBackground({
        enabled: false,
        path: '',
        name: '',
        transparency: DEFAULT_APP_BACKGROUND_TRANSPARENCY,
      })
    } catch (reason) {
      setToast(`清除背景图片失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    } finally {
      setBackgroundBusy(false)
    }
  }

  function openPanel(panel: Exclude<DockPanel, null>) {
    if (panel === 'inspect') {
      // 自动化巡检为独立全页视图，不再使用右侧抽屉
      setMainView('inspect')
      setActivePanel(null)
      return
    }
    if (panel === 'tools') {
      // 小工具为独立全页视图
      setMainView('tools')
      setActivePanel(null)
      return
    }
    setMainView('workbench')
    setActivePanel((current) => (current === panel ? null : panel))
    if (panel !== 'servers' && panel !== 'local') {
      setInspectorTab(panel)
    }
  }

  function collapsePanelFromWorkspace(event: MouseEvent<HTMLDivElement>) {
    if (!activePanel) return

    const target = event.target as HTMLElement
    if (target.closest('.workspace-drawer, .dock-rail, button, input, textarea, select, a, [role="button"], [contenteditable="true"]')) return

    setActivePanel(null)
  }

  const activePanelTitle = activePanel
    ? t(({
        servers: '服务器',
        local: '本地工具',
        run: '运行命令',
        snippets: '常用命令',
        inspect: '自动化',
        tools: '小工具',
        history: '执行记录',
        notes: '待办笔记',
      } satisfies Record<Exclude<DockPanel, null>, string>)[activePanel])
    : ''

  return (
    <AppLocaleContext.Provider value={localeContext}>
    <main className={`app-shell ${activePanel ? 'drawer-open' : 'drawer-collapsed'} ${backgroundActive ? 'custom-background-active' : ''}`}>
      <AnimatePresence>
        {themeTransition && (
          <motion.div
            aria-hidden="true"
            className="theme-transition-wash"
            key={themeTransition.id}
            style={{ '--theme-transition-color': themeTransition.color } as CSSProperties}
            initial={{ opacity: 0.1 + themeTransition.intensity * 0.12, scale: 0.96 }}
            animate={{ opacity: 0, scale: 1.06 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
            onAnimationComplete={() => {
              setThemeTransition((current) => current?.id === themeTransition.id ? null : current)
            }}
          />
        )}
      </AnimatePresence>
      {backgroundActive && (
        <div className="app-custom-background" aria-hidden="true">
          <img
            src={backgroundAssetUrl}
            alt=""
            onError={() => {
              setAppBackground((current) => ({ ...current, enabled: false }))
              setToast('背景图片加载失败，已恢复默认背景')
            }}
          />
          <span />
        </div>
      )}
      <section className="application-window">
      <LiquidTitleBar
        servers={servers}
        remoteDesktopProfiles={remoteDesktopProfiles}
        onOpenServer={openServerRunPanel}
        onOpenRemoteDesktop={openRemoteDesktopProfile}
        appearance={appearance}
        onAppearanceChange={setAppearance}
        onAdd={() => setServerModal({ ...blankDraft, protocol: 'ssh' })}
        onSettings={() => setSettingsOpen(true)}
        onTransfers={() => setTransferManagerOpen(true)}
        onPalette={() => setPaletteOpen(true)}
        onRefresh={clearCurrentTerminal}
      />
      <div className="workspace" onMouseDown={collapsePanelFromWorkspace}>
        <DockRail
          activePanel={activePanel}
          connectionState={connectionState}
          onOpen={openPanel}
          onSettings={() => setSettingsOpen(true)}
        />
        <aside className="workspace-drawer" aria-hidden={!activePanel}>
          <AnimatePresence initial={false}>
            {activePanel && (
              <motion.div
                className="drawer-content"
                key={activePanel}
                initial={reduceMotion ? false : { opacity: 0, x: -12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                transition={{ duration: reduceMotion ? 0.01 : 0.26, ease: [0.16, 1, 0.3, 1] }}
              >
                <motion.div
                  className="drawer-header"
                  initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reduceMotion ? 0.01 : 0.2, delay: reduceMotion ? 0 : 0.025, ease: [0.16, 1, 0.3, 1] }}
                >
                  <strong>{activePanelTitle}</strong>
                  <button type="button" onClick={() => setActivePanel(null)} title={t('收起侧边栏')} aria-label={t('收起侧边栏')}>
                    <X size={14} />
                  </button>
                </motion.div>
                <motion.div
                  className="drawer-body"
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reduceMotion ? 0.01 : 0.24, delay: reduceMotion ? 0 : 0.055, ease: [0.16, 1, 0.3, 1] }}
                >
                  {activePanel === 'servers' ? (
                    <SourceList
                      servers={servers}
                      remoteDesktopProfiles={remoteDesktopProfiles}
                      selectedServerId={selectedServer.id}
                      onSelect={selectServer}
                      onOpenServer={openServerRunPanel}
                      onServerContextMenu={openServerContextMenu}
                      onAdd={(protocol) => setServerModal({ ...blankDraft, protocol, port: protocol === 'telnet' ? 23 : protocol === 'serial' ? 22 : 22, user: protocol === 'serial' ? '' : 'root' })}
                      onAddRemoteDesktop={() => setRemoteDesktopModal(blankRemoteDesktopDraft)}
                      onOpenRemoteDesktop={openRemoteDesktopProfile}
                      onRemoteDesktopContextMenu={openRemoteDesktopProfileContextMenu}
                      connectionState={connectionState}
                      serverConnectionStates={serverConnectionStates}
                      launchOptions={serverLaunchOptions}
                      onLaunchOptionsChange={setServerLaunchOptions}
                    />
                  ) : activePanel === 'local' ? (
                    <LocalToolsPanel
                      connectionState={connectionState}
                      onCommand={sendCommand}
                      onClear={clearCurrentTerminal}
                      onCopy={copyTerminal}
                      onDisconnect={disconnectEmbeddedSsh}
                      onAddServer={() => setServerModal(blankDraft)}
                      onAddTerminal={() => addWorkbenchWidget('local-terminal')}
                      onAddFiles={() => addWorkbenchWidget('files')}
                      onAddMonitor={() => addWorkbenchWidget('monitor')}
                      onAddProcesses={() => addWorkbenchWidget('processes')}
                    />
                  ) : (
                    <Inspector
                      targetLabel={commandTargetLabel}
                      remoteTarget={commandTargetWidget?.type === 'ssh-terminal'}
                      onCommand={sendCommand}
                      commandDraft={commandDraft}
                      onCommandDraftChange={setCommandDraft}
                      snippets={snippets}
                      categories={snippetCategories}
                      onAddSnippet={addSnippet}
                      onDeleteSnippet={deleteSnippet}
                      onAddCategory={addCategory}
                      onDeleteCategory={deleteCategory}
                      onMoveSnippet={moveSnippet}
                      onReorderCategories={reorderCategories}
                      inspectDevices={inspectDevices}
                      onAddInspectDevice={addInspectDevice}
                      onUpdateInspectDevice={updateInspectDevice}
                      onDeleteInspectDevice={deleteInspectDevice}
                      onNotify={(message) => setToast(message)}
                      commandHistory={commandHistory}
                      onClearHistory={clearCommandHistory}
                      notes={sessionNotes}
                      onAddNote={addSessionNote}
                      onToggleNote={toggleSessionNote}
                      onDeleteNote={deleteSessionNote}
                      activeTab={inspectorTab}
                      onActiveTabChange={(tab) => {
                        setInspectorTab(tab)
                        setActivePanel(tab)
                      }}
                    />
                  )}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </aside>
        <div style={{ display: mainView === 'inspect' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <InspectWorkspace
            inspectDevices={inspectDevices}
            onAddInspectDevice={addInspectDevice}
            onUpdateInspectDevice={updateInspectDevice}
            onDeleteInspectDevice={deleteInspectDevice}
            onNotify={(message) => setToast(message)}
            snippets={snippets}
            selectedInspectIds={inspectSelectedIds}
            setSelectedInspectIds={setInspectSelectedIds}
            inspectCommands={inspectCommands}
            setInspectCommands={setInspectCommands}
            inspectRunning={inspectRunning}
            setInspectRunning={setInspectRunning}
            inspectResults={inspectResults}
            setInspectResults={setInspectResults}
            inspectConcurrency={inspectConcurrency}
            setInspectConcurrency={setInspectConcurrency}
            inspectProgress={inspectProgress}
            setInspectProgress={setInspectProgress}
          />
        </div>
        <div style={{ display: mainView === 'tools' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <InspectToolbox onNotify={(message) => setToast(message)} />
        </div>
        {mainView !== 'inspect' && mainView !== 'tools' && (
        <Profiler id="Workbench" onRender={handleRenderProfile}>
          <Workbench
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspace.id}
            drawerOpen={Boolean(activePanel)}
            servers={servers}
            onSelectWorkspace={setActiveWorkspaceId}
            onAddWorkspace={addWorkspace}
            onCloseWorkspace={closeWorkspace}
            onFocusWidget={focusWorkbenchWidget}
            onResizeLayout={resizeWorkbenchLayout}
            onCloseWidget={closeWorkbenchWidget}
            onRefreshWidget={refreshWorkbenchWidget}
            onToggleMaximizeWidget={toggleMaximizeWidget}
            onMoveWidget={moveWorkbenchWidget}
            onMoveWidgetToWorkspace={moveWorkbenchWidgetToWorkspace}
            onArrangeWidgets={arrangeActiveWorkspace}
            onAddWidget={addWorkbenchWidget}
            onSetWidgetConnection={setWorkbenchWidgetConnection}
            onSaveWidgetConnection={saveWorkbenchWidgetConnection}
            onSetRemoteDesktopConnection={setRemoteDesktopConnection}
            onContextMenu={openContextMenu}
            onOpenSettings={() => setSettingsOpen(true)}
            onEditConnections={() => setActivePanel('servers')}
            onRemoteStatus={handleRemoteStatus}
            onRunTerminalCli={runTerminalCli}
            serverConnectionStates={serverConnectionStates}
            terminalTheme={terminalTheme}
            onToast={setToast}
          />
        </Profiler>
        )}
      </div>
      </section>

      <AnimatePresence>
        {toast && (
          <motion.div
            className="app-toast"
            key={toast}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
          >
            {t(toast)}
          </motion.div>
        )}
      </AnimatePresence>

      {contextMenu && <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}

      <AnimatePresence>
        {serverModal && (
          <ServerModal
            key="server-modal"
            draft={serverModal}
            onCancel={() => setServerModal(null)}
            onSave={saveServer}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {remoteDesktopModal && (
          <RemoteDesktopModal
            key="remote-desktop-modal"
            draft={remoteDesktopModal}
            onCancel={() => setRemoteDesktopModal(null)}
            onSave={saveRemoteDesktopProfile}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {transferManagerOpen && (
          <TransferManager key="transfer-manager" onClose={() => setTransferManagerOpen(false)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
      {settingsOpen && (
          <SettingsModal
            key="settings-modal"
            onClose={() => setSettingsOpen(false)}
            onExport={exportServers}
            onImport={importServersFromText}
            onImportSshConfig={importOpenSshConfig}
            onExportDiagnostics={exportDiagnostics}
            onReset={resetServers}
            appearance={appearance}
            onAppearanceChange={setAppearance}
            themePreset={themePreset}
            onThemePresetChange={changeThemePreset}
            appBackground={appBackground}
            backgroundAssetUrl={backgroundAssetUrl}
            backgroundBusy={backgroundBusy}
            onBackgroundEnabledChange={changeAppBackgroundEnabled}
            onBackgroundChoose={() => { void chooseAppBackground() }}
            onBackgroundClear={() => { void clearAppBackground() }}
            onBackgroundTransparencyChange={(transparency) => setAppBackground((current) => ({
              ...current,
              transparency: normalizeAppBackgroundTransparency(transparency),
            }))}
            terminalFontSize={terminalFontSize}
            onTerminalFontSizeChange={setTerminalFontSize}
            remoteAuxConcurrency={remoteAuxConcurrency}
            onRemoteAuxConcurrencyChange={setRemoteAuxConcurrency}
            displayLanguage={displayLanguage}
            onDisplayLanguageChange={setDisplayLanguage}
            timeZonePreference={timeZonePreference}
            onTimeZonePreferenceChange={setTimeZonePreference}
            systemTimeZone={systemTimeZone}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {paletteOpen && (
          <CommandPalette
            key="command-palette"
            server={selectedServer}
            connectionState={connectionState}
            onClose={() => setPaletteOpen(false)}
            onConnect={connectEmbeddedSsh}
            onDisconnect={disconnectEmbeddedSsh}
            onCommand={sendCommand}
            onAddServer={() => setServerModal(blankDraft)}
            onSettings={() => setSettingsOpen(true)}
            onClear={clearCurrentTerminal}
            onCopy={copyTerminal}
            snippets={snippets}
          />
        )}
      </AnimatePresence>
    </main>
    </AppLocaleContext.Provider>
  )
}

function GlobalConnectionSearch({
  servers,
  remoteDesktopProfiles,
  onOpenServer,
  onOpenRemoteDesktop,
}: {
  servers: ServerProfile[]
  remoteDesktopProfiles: RemoteDesktopProfile[]
  onOpenServer: (server: ServerProfile) => void
  onOpenRemoteDesktop: (profile: RemoteDesktopProfile) => void
}) {
  const { t } = useAppLocale()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const deferredQuery = useDeferredValue(query)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const searchIndex = useMemo<GlobalSearchEntry[]>(() => [
    ...servers.map((server) => ({
      key: `server:${server.id}`,
      kind: 'server' as const,
      title: server.name || server.host,
      detail: `${server.user}@${server.host}:${server.port}${server.group ? ` · ${server.group}` : ''}`,
      searchParts: [
        server.name,
        server.host,
        server.user,
        server.group,
        `${server.user}@${server.host}`,
        `${server.user}@${server.host}:${server.port}`,
        String(server.port),
        'ssh',
      ].map(normalizeGlobalSearchText),
      server,
    })),
    ...remoteDesktopProfiles.map((desktop) => ({
      key: `desktop:${desktop.id}`,
      kind: 'desktop' as const,
      title: desktop.name || desktop.host,
      detail: `${desktop.username ? `${desktop.username}@` : ''}${desktop.host}:${desktop.port}${desktop.group ? ` · ${desktop.group}` : ''}`,
      searchParts: [
        desktop.name,
        desktop.host,
        desktop.username,
        desktop.domain ?? '',
        desktop.group,
        `${desktop.username}@${desktop.host}`,
        `${desktop.host}:${desktop.port}`,
        String(desktop.port),
        'rdp',
        'desktop',
      ].map(normalizeGlobalSearchText),
      desktop,
    })),
  ], [remoteDesktopProfiles, servers])
  const normalizedQuery = normalizeGlobalSearchText(deferredQuery).trim()
  const results = useMemo(() => {
    if (!normalizedQuery) return searchIndex.slice(0, 8)
    return searchIndex
      .map((entry) => ({ entry, score: scoreGlobalSearchEntry(entry, normalizedQuery) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((left, right) => left.score - right.score || left.entry.title.localeCompare(right.entry.title))
      .slice(0, 16)
      .map((item) => item.entry)
  }, [normalizedQuery, searchIndex])
  const pending = query !== deferredQuery

  useEffect(() => {
    setActiveIndex(0)
  }, [normalizedQuery])

  useEffect(() => {
    if (activeIndex < results.length) return
    setActiveIndex(Math.max(0, results.length - 1))
  }, [activeIndex, results.length])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  }, [open])

  function activate(entry: GlobalSearchEntry) {
    setOpen(false)
    setQuery('')
    setActiveIndex(0)
    window.setTimeout(() => {
      if (entry.server) onOpenServer(entry.server)
      if (entry.desktop) onOpenRemoteDesktop(entry.desktop)
    }, 0)
  }

  return (
    <div className={`global-search ${open ? 'open' : ''}`} ref={rootRef}>
      <div className="command-search">
        <Search size={15} />
        <input
          ref={inputRef}
          role="combobox"
          aria-label={t('搜索设备和远程桌面')}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="global-search-results"
          aria-activedescendant={open && results.length ? `global-search-result-${activeIndex}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              if (results.length) setActiveIndex((current) => (current + 1) % results.length)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              if (results.length) setActiveIndex((current) => (current - 1 + results.length) % results.length)
            }
            if (event.key === 'Enter' && open && results[activeIndex]) {
              event.preventDefault()
              activate(results[activeIndex])
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              inputRef.current?.blur()
            }
            if (event.key === 'Tab') setOpen(false)
          }}
          placeholder={t('搜索设备和远程桌面')}
        />
        {query && (
          <button
            className="search-clear"
            type="button"
            onClick={() => {
              setQuery('')
              setOpen(true)
              inputRef.current?.focus()
            }}
            title={t('清除搜索')}
            aria-label={t('清除搜索')}
          >
            <X size={13} />
          </button>
        )}
      </div>

      {open && (
        <div className="global-search-popover">
          <div className="global-search-summary">
            <strong>{normalizedQuery ? t('搜索结果') : t('快速访问')}</strong>
            <span>{pending ? t('正在搜索') : results.length}</span>
          </div>
          <div className="global-search-results" id="global-search-results" role="listbox">
            {results.map((entry, index) => (
              <button
                className={`global-search-result ${activeIndex === index ? 'active' : ''}`}
                id={`global-search-result-${index}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => activate(entry)}
                key={entry.key}
              >
                <span className="global-search-result-icon">
                  {entry.kind === 'server' ? <Server size={15} /> : <Monitor size={15} />}
                </span>
                <span className="global-search-result-copy">
                  <strong>{entry.title}</strong>
                  <em>{entry.detail}</em>
                </span>
                <span className="global-search-result-kind">{entry.kind === 'server' ? 'SSH' : 'RDP'}</span>
              </button>
            ))}
            {!results.length && (
              <div className="global-search-empty">
                <Search size={18} />
                <strong>{searchIndex.length ? t('未找到匹配的连接') : t('暂无可搜索的连接')}</strong>
                <span>{searchIndex.length ? t('可按名称、地址、用户或分组搜索') : t('添加服务器或远程桌面后会显示在这里')}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function normalizeGlobalSearchText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function scoreGlobalSearchEntry(entry: GlobalSearchEntry, query: string) {
  const tokens = query.split(/\s+/).filter(Boolean)
  let score = 0
  for (const token of tokens) {
    let best = Number.POSITIVE_INFINITY
    entry.searchParts.forEach((part, partIndex) => {
      if (!part) return
      const matchIndex = part.indexOf(token)
      if (matchIndex < 0) return
      const rank = part === token
        ? partIndex
        : matchIndex === 0
          ? 20 + partIndex
          : 60 + matchIndex + partIndex
      best = Math.min(best, rank)
    })
    if (!Number.isFinite(best)) return Number.POSITIVE_INFINITY
    score += best
  }
  return score
}

function LiquidTitleBar({
  servers,
  remoteDesktopProfiles,
  onOpenServer,
  onOpenRemoteDesktop,
  appearance,
  onAppearanceChange,
  onAdd,
  onSettings,
  onTransfers,
  onPalette,
  onRefresh,
}: {
  servers: ServerProfile[]
  remoteDesktopProfiles: RemoteDesktopProfile[]
  onOpenServer: (server: ServerProfile) => void
  onOpenRemoteDesktop: (profile: RemoteDesktopProfile) => void
  appearance: AppAppearance
  onAppearanceChange: (value: AppAppearance) => void
  onAdd: () => void
  onSettings: () => void
  onTransfers: () => void
  onPalette: () => void
  onRefresh: () => void
}) {
  const { t } = useAppLocale()
  return (
    <header className="titlebar" data-tauri-drag-region onMouseDown={startWindowDrag}>
      <div className="brand-block" data-tauri-drag-region>
        <div className="brand-icon">
          <img src="/rain-terminal-icon.svg" alt="" />
        </div>
        <div>
          <h1>RainTerminal</h1>
          <p>{t('一体化运维工作台')}</p>
        </div>
      </div>

      <GlobalConnectionSearch
        servers={servers}
        remoteDesktopProfiles={remoteDesktopProfiles}
        onOpenServer={onOpenServer}
        onOpenRemoteDesktop={onOpenRemoteDesktop}
      />

      <div className="title-actions">
        <AppearanceSwitch appearance={appearance} onChange={onAppearanceChange} />
        <TransferCenterTrigger onClick={onTransfers} />
        <IconButton label={t('命令面板')} onClick={onPalette}>
          <Terminal size={16} />
        </IconButton>
        <IconButton label={t('添加服务器')} onClick={onAdd}>
          <Plus size={16} />
        </IconButton>
        <IconButton label={t('清空终端')} onClick={onRefresh}>
          <RefreshCw size={16} />
        </IconButton>
        <IconButton label={t('设置')} onClick={onSettings}>
          <Settings2 size={16} />
        </IconButton>
        <div className="window-controls" aria-label={t('窗口操作')}>
          <button type="button" aria-label={t('最小化')} title={t('最小化')} onClick={() => runWindowAction('minimize')}>
            <Minus size={14} />
          </button>
          <button type="button" aria-label={t('最大化')} title={t('最大化')} onClick={() => runWindowAction('toggleMaximize')}>
            <Square size={12} />
          </button>
          <button className="close" type="button" aria-label={t('关闭窗口')} title={t('关闭')} onClick={() => runWindowAction('close')}>
            <X size={14} />
          </button>
        </div>
      </div>
    </header>
  )
}

function TransferCenterTrigger({ onClick }: { onClick: () => void }) {
  const { t } = useAppLocale()
  const transfers = useSyncExternalStore(subscribeTransfers, getTransfersSnapshot, getTransfersSnapshot)
  const activeCount = transfers.filter((item) => item.status === 'queued' || item.status === 'running').length
  return (
    <button
      className={`icon-button transfer-center-trigger ${activeCount ? 'active' : ''}`}
      type="button"
      aria-label={t('文件传输管理')}
      title={t('文件传输管理')}
      onClick={onClick}
    >
      <Activity size={16} />
      {activeCount > 0 && <span>{Math.min(activeCount, 99)}</span>}
    </button>
  )
}

type TransferManagerFilter = 'all' | 'active' | 'upload' | 'download'

function TransferManager({ onClose }: { onClose: () => void }) {
  const { resolvedLanguage, t } = useAppLocale()
  const transfers = useSyncExternalStore(subscribeTransfers, getTransfersSnapshot, getTransfersSnapshot)
  const [filter, setFilter] = useState<TransferManagerFilter>('all')
  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState('')
  const activeCount = transfers.filter((item) => item.status === 'queued' || item.status === 'running').length
  const visibleTransfers = transfers.filter((item) => {
    if (filter === 'active') return item.status === 'queued' || item.status === 'running'
    if (filter === 'upload') return item.direction === 'upload'
    if (filter === 'download') return item.direction === 'download' || item.direction === 'copy'
    return true
  })

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  async function runTransferAction(item: TransferRecord, action: 'cancel' | 'retry') {
    setBusyId(item.id)
    setActionError('')
    try {
      const handled = action === 'cancel'
        ? await cancelTransfer(item.id)
        : await retryTransfer(item.id)
      if (!handled) setActionError(t(action === 'cancel' ? '当前任务无法取消' : '当前任务无法重试'))
    } catch (reason) {
      setActionError(`${t(action === 'cancel' ? '取消失败' : '重试失败')}：${String(reason)}`)
    } finally {
      setBusyId('')
    }
  }

  return createPortal(
    <motion.div
      className="modal-backdrop transfer-manager-backdrop"
      role="presentation"
      onPointerDown={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
    >
      <motion.section
        className="transfer-manager-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('文件传输管理')}
        onPointerDown={(event) => event.stopPropagation()}
        initial={{ opacity: 0, y: 16, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.985 }}
        transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      >
        <header className="transfer-manager-header">
          <div className="transfer-manager-title">
            <span><Activity size={18} /></span>
            <div>
              <strong>{t('文件传输管理')}</strong>
              <em>{activeCount ? `${activeCount} ${t('项正在进行')}` : t('当前没有运行中的任务')}</em>
            </div>
          </div>
          <div className="transfer-manager-header-actions">
            <button type="button" onClick={clearFinishedTransfers} disabled={!transfers.some((item) => item.status !== 'queued' && item.status !== 'running')}>
              {t('清理已完成')}
            </button>
            <button type="button" aria-label={t('关闭')} title={t('关闭')} onClick={onClose}><X size={15} /></button>
          </div>
        </header>

        <nav className="transfer-manager-filters" aria-label={t('传输筛选')}>
          {([
            ['all', '全部'],
            ['active', '进行中'],
            ['upload', '上传'],
            ['download', '下载'],
          ] as const).map(([value, label]) => (
            <button className={filter === value ? 'active' : ''} type="button" onClick={() => setFilter(value)} key={value}>
              {t(label)}
            </button>
          ))}
        </nav>

        {actionError && <p className="transfer-manager-error" role="alert">{actionError}</p>}
        <div className="transfer-manager-list">
          {visibleTransfers.length === 0 && (
            <div className="transfer-manager-empty">
              <Activity size={24} />
              <span>{t('暂无传输任务')}</span>
            </div>
          )}
          {visibleTransfers.map((item) => {
            const percent = item.totalBytes > 0
              ? Math.min(100, Math.max(0, Math.round(item.transferredBytes / item.totalBytes * 100)))
              : item.status === 'completed' ? 100 : 0
            const active = item.status === 'queued' || item.status === 'running'
            const statusLabel = item.status === 'completed'
              ? '已完成'
              : item.status === 'cancelled'
                ? '已取消'
                : item.status === 'error'
                  ? '失败'
                  : item.status === 'queued'
                    ? '等待中'
                    : '传输中'
            return (
              <article className={`transfer-manager-item status-${item.status}`} key={item.id}>
                <div className={`transfer-manager-direction direction-${item.direction}`}>
                  {item.direction === 'upload' ? <Upload size={16} /> : <Download size={16} />}
                </div>
                <div className="transfer-manager-copy">
                  <div className="transfer-manager-item-heading">
                    <strong title={item.title}>{item.title}</strong>
                    <span className={`transfer-manager-status status-${item.status}`}>{t(statusLabel)}</span>
                  </div>
                  <div className={`transfer-manager-track ${active && item.totalBytes === 0 ? 'indeterminate' : ''}`}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                  <div className="transfer-manager-meta">
                    <span title={`${item.source} → ${item.destination}`}>{item.source} → {item.destination}</span>
                    <em>{item.totalBytes > 0 ? `${formatBytes(item.transferredBytes)} / ${formatBytes(item.totalBytes)}` : `${item.copiedFiles}/${item.totalFiles || 0}`}</em>
                    {active && item.bytesPerSecond > 0 && <em>{formatBytes(item.bytesPerSecond)}/s</em>}
                    <em>{new Date(item.updatedAt).toLocaleTimeString(resolvedLanguage, { hour: '2-digit', minute: '2-digit' })}</em>
                  </div>
                  {item.message && <p title={item.message}>{item.message}</p>}
                </div>
                <div className="transfer-manager-item-actions">
                  {canCancelTransfer(item.id) && active && (
                    <button type="button" disabled={busyId === item.id} onClick={() => { void runTransferAction(item, 'cancel') }} title={t('取消')} aria-label={t(`取消 ${item.title}`)}>
                      <X size={13} />
                    </button>
                  )}
                  {canRetryTransfer(item.id) && !active && (
                    <button type="button" disabled={busyId === item.id} onClick={() => { void runTransferAction(item, 'retry') }} title={t('重试')} aria-label={t(`重试 ${item.title}`)}>
                      <RefreshCw size={13} />
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </motion.section>
    </motion.div>,
    document.body,
  )
}

function startWindowDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0) return
  if (event.detail > 1) return

  const target = event.target as HTMLElement
  const blockedSelector = [
    'button',
    'input',
    'textarea',
    'select',
    'a',
    '[role="button"]',
    '.window-controls',
  ].join(',')

  if (target.closest(blockedSelector)) return

  const stopPerformanceMode = startNativeWindowDragPerformanceMode()
  try {
    void Promise.resolve(getCurrentWindow().startDragging()).finally(() => {
      window.setTimeout(stopPerformanceMode, 90)
    })
  } catch {
    stopPerformanceMode()
    // Browser preview does not expose native window dragging.
  }
}

function AppearanceSwitch({
  appearance,
  onChange,
}: {
  appearance: AppAppearance
  onChange: (value: AppAppearance) => void
}) {
  const { t } = useAppLocale()
  return (
    <div className="appearance-switch" role="group" aria-label={t('应用外观')}>
      <button
        className={appearance === 'light' ? 'active' : ''}
        type="button"
        aria-label={t('切换浅色外观')}
        title={t('浅色外观')}
        onClick={() => onChange('light')}
      >
        <Sun size={14} />
      </button>
      <button
        className={appearance === 'dark' ? 'active' : ''}
        type="button"
        aria-label={t('切换深色外观')}
        title={t('深色外观')}
        onClick={() => onChange('dark')}
      >
        <Moon size={14} />
      </button>
    </div>
  )
}

let nativeWindowDragResetTimer = 0

function startNativeWindowDragPerformanceMode() {
  document.body.classList.add('native-window-drag-active')
  if (nativeWindowDragResetTimer) {
    window.clearTimeout(nativeWindowDragResetTimer)
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    document.body.classList.remove('native-window-drag-active')
    window.removeEventListener('mouseup', stop, true)
    window.removeEventListener('pointerup', stop, true)
    window.removeEventListener('blur', stop, true)
    if (nativeWindowDragResetTimer) {
      window.clearTimeout(nativeWindowDragResetTimer)
      nativeWindowDragResetTimer = 0
    }
  }

  window.addEventListener('mouseup', stop, true)
  window.addEventListener('pointerup', stop, true)
  window.addEventListener('blur', stop, true)
  nativeWindowDragResetTimer = window.setTimeout(stop, 8000)
  return stop
}

function runWindowAction(action: 'close' | 'minimize' | 'toggleMaximize') {
  try {
    const appWindow = getCurrentWindow()
    if (action === 'close') void appWindow.close()
    if (action === 'minimize') void appWindow.minimize()
    if (action === 'toggleMaximize') void appWindow.toggleMaximize()
  } catch {
    // Browser preview does not expose Tauri window metadata.
  }
}

function DockRail({
  activePanel,
  connectionState,
  onOpen,
  onSettings,
}: {
  activePanel: DockPanel
  connectionState: ConnectionState
  onOpen: (panel: Exclude<DockPanel, null>) => void
  onSettings: () => void
}) {
  const { t } = useAppLocale()
  const workspaceItems: Array<{ panel: Exclude<DockPanel, null>; label: string; icon: ReactNode }> = [
    { panel: 'servers', label: '服务器', icon: <Server size={18} /> },
    { panel: 'local', label: '本地', icon: <Database size={18} /> },
  ]
  const activityItems: Array<{ panel: Exclude<DockPanel, null>; label: string; icon: ReactNode }> = [
    { panel: 'run', label: '运行命令', icon: <Terminal size={18} /> },
    { panel: 'snippets', label: '常用命令', icon: <Star size={18} /> },
    { panel: 'inspect', label: '自动化', icon: <Activity size={18} /> },
    { panel: 'tools', label: '小工具', icon: <Wrench size={18} /> },
    { panel: 'history', label: '执行记录', icon: <Clock3 size={18} /> },
    { panel: 'notes', label: '待办笔记', icon: <ClipboardList size={18} /> },
  ]

  return (
    <aside className="dock-rail" aria-label={t('主导航')}>
      <div className="dock-rail-top">
        {[workspaceItems, activityItems].map((items, groupIndex) => (
          <div className="dock-rail-section" key={groupIndex}>
            {items.map((item) => (
              <button
                className={`dock-button ${activePanel === item.panel ? 'active' : ''}`}
                type="button"
                aria-label={t(item.label)}
                title={t(item.label)}
                onClick={() => onOpen(item.panel)}
                key={item.panel}
              >
                {item.icon}
                <span>{t(item.label)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="dock-rail-bottom">
        <button
          className="dock-button settings-dock-button"
          type="button"
          aria-label={t('设置')}
          title={t('设置')}
          onClick={onSettings}
        >
          <Settings2 size={18} />
          <span>{t('设置')}</span>
        </button>
        <span className={`connection-dot ${connectionState}`} />
      </div>
    </aside>
  )
}

function SourceList({
  servers,
  remoteDesktopProfiles,
  selectedServerId,
  onSelect,
  onOpenServer,
  onServerContextMenu,
  onAdd,
  onAddRemoteDesktop,
  onOpenRemoteDesktop,
  onRemoteDesktopContextMenu,
  connectionState,
  serverConnectionStates,
  launchOptions,
  onLaunchOptionsChange,
}: {
  servers: ServerProfile[]
  remoteDesktopProfiles: RemoteDesktopProfile[]
  selectedServerId: string
  onSelect: (id: string) => void
  onOpenServer: (server: ServerProfile) => void
  onServerContextMenu: (event: MouseEvent<HTMLElement>, server: ServerProfile) => void
  onAdd: (protocol: ServerProtocol) => void
  onAddRemoteDesktop: () => void
  onOpenRemoteDesktop: (profile: RemoteDesktopProfile) => void
  onRemoteDesktopContextMenu: (event: MouseEvent<HTMLElement>, profile: RemoteDesktopProfile) => void
  connectionState: ConnectionState
  serverConnectionStates: Record<string, ConnectionState>
  launchOptions: { files: boolean; monitor: boolean; processes: boolean }
  onLaunchOptionsChange: (options: { files: boolean; monitor: boolean; processes: boolean }) => void
}) {
  const { t } = useAppLocale()
  function renderServerSection(titleKey: string, protocol: ServerProtocol, emptyText: string, addLabel: string) {
    const filtered = servers.filter((server) => (server.protocol ?? 'ssh') === protocol)
    return (
      <div className="source-section">
        <div className="source-heading">
          <span>{t(titleKey)}</span>
          <button className="small-control" type="button" aria-label={t(addLabel)} title={t(addLabel)} onClick={() => onAdd(protocol)}>
            <Plus size={16} />
          </button>
        </div>
        <div className="server-list">
          {filtered.map((server) => (
              <button
                key={server.id}
                className={`server-item ${server.id === selectedServerId ? 'active' : ''}`}
                type="button"
                onClick={() => onSelect(server.id)}
                onDoubleClick={() => onOpenServer(server)}
                onContextMenu={(event) => onServerContextMenu(event, server)}
              >
                <span className={`connection-dot ${serverConnectionStates[server.id] ?? (server.id === selectedServerId ? connectionState : 'disconnected')}`} />
                <span className="server-main">
                  <span className="server-name">
                    {server.name}
                    {protocol !== 'ssh' && (
                      <span className={`server-protocol-badge protocol-${protocol}`}>
                        {protocol === 'telnet' ? 'Telnet' : 'Serial'}
                      </span>
                    )}
                  </span>
                  <span className="server-host">
                    {protocol === 'serial'
                      ? (server.serialPort ?? '')
                      : protocol === 'telnet'
                        ? server.host
                        : `${server.user}@${server.host}`}
                  </span>
                </span>
                <span className="server-port">
                  {protocol === 'serial' ? (server.baudRate ?? 9600) : server.port}
                </span>
              </button>
            ))}
          {filtered.length === 0 && (
            <div className="empty-panel compact-empty-panel">
              <span>{t(emptyText)}</span>
              <button className="ghost-button compact" type="button" onClick={() => onAdd(protocol)}>
                <Plus size={14} />
                {t(addLabel)}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }
  return (
    <aside className="source-list server-source-list">
      {renderServerSection('SSH 服务器', 'ssh', '还没有 SSH 服务器', '添加 SSH 服务器')}
      {renderServerSection('Telnet 设备', 'telnet', '还没有 Telnet 设备', '添加 Telnet 设备')}
      {renderServerSection('串口设备', 'serial', '还没有串口设备', '添加串口设备')}
      <div className="source-section remote-desktop-source-section">
        <div className="source-heading">
          <span>{t('远程桌面')}</span>
          <button className="small-control" type="button" aria-label={t('添加远程桌面')} title={t('添加远程桌面')} onClick={onAddRemoteDesktop}>
            <Plus size={16} />
          </button>
        </div>
        <div className="server-list remote-desktop-profile-list">
          {remoteDesktopProfiles.map((profile) => (
            <button
              key={profile.id}
              className="server-item remote-desktop-profile-item"
              type="button"
              onClick={() => onOpenRemoteDesktop(profile)}
              onContextMenu={(event) => onRemoteDesktopContextMenu(event, profile)}
              title={t('打开到工作台，连接前保持待命')}
            >
              <span className="connection-dot ready" />
              <span className="server-main">
                <span className="server-name">{profile.name}</span>
                <span className="server-host">{profile.username}@{profile.host}</span>
              </span>
              <span className="server-port">RDP · {profile.port}</span>
            </button>
          ))}
          {remoteDesktopProfiles.length === 0 && (
            <div className="empty-panel compact-empty-panel">
              <span>{t('还没有远程桌面连接')}</span>
              <button className="ghost-button compact" type="button" onClick={onAddRemoteDesktop}>
                <Monitor size={14} />
                {t('添加远程桌面')}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="source-section server-launch-options">
        <div className="source-heading">
          <span>{t('连接时打开')}</span>
        </div>
        <label>
          <input
            type="checkbox"
            checked={launchOptions.files}
            onChange={(event) => onLaunchOptionsChange({ ...launchOptions, files: event.target.checked })}
          />
          <span>{t('文件管理')}</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={launchOptions.monitor}
            onChange={(event) => onLaunchOptionsChange({ ...launchOptions, monitor: event.target.checked })}
          />
          <span>{t('机器监控')}</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={launchOptions.processes}
            onChange={(event) => onLaunchOptionsChange({ ...launchOptions, processes: event.target.checked })}
          />
          <span>{t('系统进程')}</span>
        </label>
      </div>
    </aside>
  )
}

function LocalToolsPanel({
  connectionState,
  onCommand,
  onClear,
  onCopy,
  onDisconnect,
  onAddServer,
  onAddTerminal,
  onAddFiles,
  onAddMonitor,
  onAddProcesses,
}: {
  connectionState: ConnectionState
  onCommand: (command: string) => void
  onClear: () => void
  onCopy: () => void
  onDisconnect: () => void
  onAddServer: () => void
  onAddTerminal: () => void
  onAddFiles: () => void
  onAddMonitor: () => void
  onAddProcesses: () => void
}) {
  const { t } = useAppLocale()
  const [customCommand, setCustomCommand] = useState('')
  const remoteActive = connectionState === 'connected' || connectionState === 'connecting'
  const featureRows = [
    { icon: <FolderTree size={15} />, label: '默认目录', value: '%USERPROFILE%' },
    { icon: <Terminal size={15} />, label: '运行环境', value: 'Windows cmd' },
    { icon: <ShieldCheck size={15} />, label: '窗口策略', value: '内嵌无弹窗' },
  ]

  function runCommand(command: string) {
    if (!command.trim() || remoteActive) return
    onCommand(command)
  }

  function runCustomCommand() {
    runCommand(customCommand)
    if (!remoteActive) setCustomCommand('')
  }

  return (
    <aside className="local-tools">
      <section className="local-hero">
        <div className="local-hero-icon">
          <Terminal size={18} />
        </div>
        <div>
          <p className="section-title">{t('本地终端')}</p>
          <h2>{t('本机命令中心')}</h2>
          <span>{t('启动即进入用户目录，可直接执行 Windows 本地命令。')}</span>
        </div>
      </section>

      {remoteActive && (
        <div className="empty-panel local-warning">
          <strong>{t('当前正在使用 SSH 会话')}</strong>
          <span>{t('断开远程连接后，本地命令会恢复执行，避免误发到服务器。')}</span>
          <button className="ghost-button compact" type="button" onClick={onDisconnect}>
            {t('断开 SSH，回到本地')}
          </button>
        </div>
      )}

      <section className="source-section">
        <p className="section-title">{t('添加到任务窗口')}</p>
        <div className="local-actions">
          <button className="ghost-button compact" type="button" onClick={onAddTerminal}>
            <Terminal size={14} />
            {t('终端')}
          </button>
          <button className="ghost-button compact" type="button" onClick={onAddFiles}>
            <FolderTree size={14} />
            {t('文件管理')}
          </button>
          <button className="ghost-button compact" type="button" onClick={onAddMonitor}>
            <Activity size={14} />
            {t('机器监控')}
          </button>
          <button className="ghost-button compact" type="button" onClick={onAddProcesses}>
            <ListTree size={14} />
            {t('进程')}
          </button>
        </div>
      </section>

      <section className="source-section">
        <p className="section-title">{t('状态')}</p>
        {featureRows.map((item) => (
          <InfoRow icon={item.icon} label={t(item.label)} value={t(item.value)} key={item.label} />
        ))}
      </section>

      <section className="source-section">
        <p className="section-title">{t('常用命令')}</p>
        <div className="command-list">
          {localQuickCommands.map((item) => (
            <button
              className="command-chip"
              type="button"
              onClick={() => runCommand(item.command)}
              disabled={remoteActive}
              key={item.command}
            >
              <strong>{t(item.label)}</strong>
              <span>{item.command}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="source-section">
        <p className="section-title">{t('自定义')}</p>
        <label className="field">
          <span>{t('本地命令')}</span>
          <textarea
            value={customCommand}
            onChange={(event) => setCustomCommand(event.target.value)}
            placeholder={t('例如：dir、ipconfig、tasklist')}
            disabled={remoteActive}
          />
        </label>
        <button className="connect-button compact" type="button" onClick={runCustomCommand} disabled={remoteActive}>
          {t('运行本地命令')}
        </button>
      </section>

      <section className="source-section">
        <p className="section-title">{t('会话操作')}</p>
        <div className="local-actions">
          <button className="ghost-button compact" type="button" onClick={onClear}>
            <Eraser size={14} />
            {t('清空终端')}
          </button>
          <button className="ghost-button compact" type="button" onClick={onCopy}>
            <Copy size={14} />
            {t('复制输出')}
          </button>
          <button className="ghost-button compact" type="button" onClick={onAddServer}>
            <Plus size={14} />
            {t('添加服务器')}
          </button>
        </div>
      </section>
    </aside>
  )
}

type WaveDropPreview = {
  targetId: string
  zone: LayoutDropZone
  parentDirection: LayoutDirection
}

type WaveDragRuntime = {
  sourceId: string
  startX: number
  startY: number
  dragging: boolean
  proxy: HTMLDivElement | null
  sourceLeaf: HTMLElement | null
  cleanup: () => void
}

function getWaveDropZone(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  parentDirection: LayoutDirection,
): LayoutDropZone {
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)))
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(rect.height, 1)))
  if (x >= 0.4 && x <= 0.6 && y >= 0.4 && y <= 0.6) return 'swap'

  const dx = x - 0.5
  const dy = y - 0.5
  const inlineOffset = parentDirection === 'row' ? dx : dy
  const crossOffset = parentDirection === 'row' ? dy : dx
  if (Math.abs(inlineOffset) >= Math.abs(crossOffset)) {
    return inlineOffset < 0 ? 'inline-before' : 'inline-after'
  }

  const crossPosition = parentDirection === 'row' ? y : x
  if (crossOffset < 0) return crossPosition < 0.23 ? 'outer-before' : 'inner-before'
  return crossPosition > 0.77 ? 'outer-after' : 'inner-after'
}

const CLI_TOOL_LOGOS: Record<string, { src: string; monochrome?: boolean }> = {
  claude: { src: claudeCodeLogo },
  codex: { src: codexLogo },
  gemini: { src: geminiCliLogo },
  opencode: { src: openCodeLogo, monochrome: true },
  kiro: { src: kiroLogo },
  qwen: { src: qwenLogo },
  aider: { src: aiderLogo },
  copilot: { src: githubCopilotLogo, monochrome: true },
}

function TerminalCliLaunchers({
  widgetId,
  server,
  enabled,
  onLaunch,
}: {
  widgetId: string
  server?: ServerProfile
  enabled: boolean
  onLaunch: (widgetId: string, tool: CliToolInfo) => void
}) {
  const { t } = useAppLocale()
  const [tools, setTools] = useState<CliToolInfo[]>([])
  const [detectionRevision, setDetectionRevision] = useState(0)

  useEffect(() => {
    let disposed = false
    let refreshTimer: number | null = null
    const scheduleRefresh = (delay: number) => {
      if (disposed) return
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        setDetectionRevision((current) => current + 1)
      }, delay)
    }
    if (!enabled || (server && !hasSshAuthentication(server))) {
      setTools([])
      return () => {
        disposed = true
        if (refreshTimer !== null) window.clearTimeout(refreshTimer)
      }
    }
    void requestTerminalCliTools(server)
      .then((detected) => {
        if (disposed) return
        setTools(detected)
        scheduleRefresh(CLI_TOOL_CACHE_MS + 100)
      })
      .catch(() => {
        if (disposed) return
        setTools([])
        scheduleRefresh(15_000)
      })
    return () => {
      disposed = true
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    }
  }, [detectionRevision, enabled, server])

  if (!enabled || tools.length === 0) return null

  return (
    <div
      className="terminal-cli-launchers"
      aria-label={t('已安装的 AI 编程工具')}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {tools.map((tool) => {
        const logo = CLI_TOOL_LOGOS[tool.id]
        if (!logo) return null
        return (
          <button
            className="terminal-cli-launcher"
            data-tool={tool.id}
            data-monochrome={logo.monochrome || undefined}
            type="button"
            aria-label={`${t('运行')} ${tool.name}`}
            title={`${t('在此终端运行')} ${tool.name}`}
            onClick={() => onLaunch(widgetId, tool)}
            key={tool.id}
          >
            <img src={logo.src} alt="" draggable={false} />
          </button>
        )
      })}
    </div>
  )
}

function Workbench({
  workspaces,
  activeWorkspaceId,
  drawerOpen,
  servers,
  terminalTheme,
  onSelectWorkspace,
  onAddWorkspace,
  onCloseWorkspace,
  onFocusWidget,
  onResizeLayout,
  onCloseWidget,
  onRefreshWidget,
  onToggleMaximizeWidget,
  onMoveWidget,
  onMoveWidgetToWorkspace,
  onArrangeWidgets,
  onAddWidget,
  onSetWidgetConnection,
  onSaveWidgetConnection,
  onSetRemoteDesktopConnection,
  onContextMenu,
  onOpenSettings,
  onEditConnections,
  onRemoteStatus,
  onRunTerminalCli,
  serverConnectionStates,
  onToast,
}: {
  workspaces: WorkbenchWorkspace[]
  activeWorkspaceId: string
  drawerOpen: boolean
  servers: ServerProfile[]
  terminalTheme: TerminalThemeSettings
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: () => void
  onCloseWorkspace: (id: string) => void
  onFocusWidget: (id: string) => void
  onResizeLayout: (
    branchId: string,
    beforeIndex: number,
    beforeSize: number,
    afterSize: number,
  ) => void
  onCloseWidget: (id: string) => void
  onRefreshWidget: (id: string) => void
  onToggleMaximizeWidget: (id: string) => void
  onMoveWidget: (
    sourceId: string,
    targetId: string,
    zone: LayoutDropZone,
    parentDirection: LayoutDirection,
  ) => void
  onMoveWidgetToWorkspace: (widgetId: string, workspaceId: string) => void
  onArrangeWidgets: () => void
  onAddWidget: (type: WorkbenchWidgetType) => void
  onSetWidgetConnection: (widgetId: string, serverId?: string) => void
  onSaveWidgetConnection: (widgetId: string, draft: ServerDraft) => void
  onSetRemoteDesktopConnection: (widgetId: string, connection: RemoteDesktopConnection) => void
  onContextMenu: (event: MouseEvent<HTMLElement>, items: ContextMenuItem[]) => void
  onOpenSettings: () => void
  onEditConnections: () => void
  onRemoteStatus: (serverId: string, state: ConnectionState, message?: string) => void
  onRunTerminalCli: (widgetId: string, tool: CliToolInfo) => void
  serverConnectionStates: Record<string, ConnectionState>
  onToast: (message: string) => void
}) {
  const { t } = useAppLocale()
  const [dropPreview, setDropPreview] = useState<WaveDropPreview | null>(null)
  const [draggingSourceId, setDraggingSourceId] = useState('')
  const [workspaceDropTargetId, setWorkspaceDropTargetId] = useState('')
  const [refreshingWidgetIds, setRefreshingWidgetIds] = useState<Set<string>>(() => new Set())
  const [remoteDesktopStates, setRemoteDesktopStates] = useState<Record<string, ConnectionState>>({})
  const [layoutRevision, setLayoutRevision] = useState(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dropPreviewRef = useRef<WaveDropPreview | null>(null)
  const workspaceDropTargetRef = useRef('')
  const dragRuntimeRef = useRef<WaveDragRuntime | null>(null)
  const refreshingWidgetIdsRef = useRef(new Set<string>())
  const layoutRectsRef = useRef(new Map<string, DOMRect>())
  const skipNextLayoutAnimationRef = useRef(false)
  const layoutAnimationTimerRef = useRef<number | null>(null)
  const previousDrawerOpenRef = useRef(drawerOpen)
  const drawerLayoutSkipUntilRef = useRef(0)

  const toggleMagnifyWidget = useCallback((widgetId: string) => {
    skipNextLayoutAnimationRef.current = true
    onToggleMaximizeWidget(widgetId)
  }, [onToggleMaximizeWidget])

  const setActiveDropPreview = useCallback((preview: WaveDropPreview | null) => {
    const current = dropPreviewRef.current
    if (
      current?.targetId === preview?.targetId
      && current?.zone === preview?.zone
      && current?.parentDirection === preview?.parentDirection
    ) return
    dropPreviewRef.current = preview
    setDropPreview(preview)
  }, [])

  const setWorkspaceDropTarget = useCallback((workspaceId: string) => {
    if (workspaceDropTargetRef.current === workspaceId) return
    workspaceDropTargetRef.current = workspaceId
    setWorkspaceDropTargetId(workspaceId)
  }, [])

  const triggerRefreshWidget = useCallback((id: string) => {
    if (refreshingWidgetIdsRef.current.has(id)) return
    refreshingWidgetIdsRef.current.add(id)
    setRefreshingWidgetIds(new Set(refreshingWidgetIdsRef.current))
    onRefreshWidget(id)
    window.setTimeout(() => {
      refreshingWidgetIdsRef.current.delete(id)
      setRefreshingWidgetIds(new Set(refreshingWidgetIdsRef.current))
    }, 1200)
  }, [onRefreshWidget])

  const updateMagnifyBounds = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const insetX = 10
    const insetY = 10
    stage.style.setProperty('--wave-magnify-left', `${rect.left + insetX}px`)
    stage.style.setProperty('--wave-magnify-top', `${rect.top + insetY}px`)
    stage.style.setProperty('--wave-magnify-width', `${Math.max(320, rect.width - insetX * 2)}px`)
    stage.style.setProperty('--wave-magnify-height', `${Math.max(240, rect.height - insetY * 2)}px`)
  }, [])

  useLayoutEffect(() => {
    updateMagnifyBounds()
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(updateMagnifyBounds)
    observer.observe(stage)
    window.addEventListener('resize', updateMagnifyBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateMagnifyBounds)
    }
  }, [updateMagnifyBounds])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const drawerChanged = previousDrawerOpenRef.current !== drawerOpen
    previousDrawerOpenRef.current = drawerOpen
    if (drawerChanged) {
      drawerLayoutSkipUntilRef.current = performance.now() + WORKBENCH_FLIP_DURATION_MS + 40
      layoutRectsRef.current.clear()
      skipNextLayoutAnimationRef.current = false
      return
    }
    if (performance.now() < drawerLayoutSkipUntilRef.current) return
    const leaves = Array.from(
      stage.querySelectorAll<HTMLElement>(
        '.workspace-layer.active .wave-layout-leaf[data-workbench-widget-id]',
      ),
    )
    const nextRects = new Map<string, DOMRect>()
    leaves.forEach((leaf) => {
      const widgetId = leaf.dataset.workbenchWidgetId
      if (widgetId) nextRects.set(widgetId, leaf.getBoundingClientRect())
    })

    const shouldSkip = skipNextLayoutAnimationRef.current
      || document.body.classList.contains('wave-layout-resizing')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    skipNextLayoutAnimationRef.current = false
    let animated = false

    if (!shouldSkip && layoutRectsRef.current.size > 0) {
      leaves.forEach((leaf) => {
        const widgetId = leaf.dataset.workbenchWidgetId
        if (!widgetId || leaf.classList.contains('is-magnified')) return
        const previous = layoutRectsRef.current.get(widgetId)
        const next = nextRects.get(widgetId)
        if (!previous || !next || next.width < 1 || next.height < 1) return
        const deltaX = previous.left - next.left
        const deltaY = previous.top - next.top
        const scaleX = Math.max(0.65, Math.min(1.6, previous.width / next.width))
        const scaleY = Math.max(0.65, Math.min(1.6, previous.height / next.height))
        if (
          Math.abs(deltaX) < 0.5
          && Math.abs(deltaY) < 0.5
          && Math.abs(scaleX - 1) < 0.005
          && Math.abs(scaleY - 1) < 0.005
        ) return
        try {
          leaf.getAnimations().forEach((animation) => animation.cancel())
          leaf.animate(
            [
              {
                transformOrigin: '0 0',
                transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${scaleX}, ${scaleY})`,
                opacity: 0.92,
              },
              { transformOrigin: '0 0', transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
            ],
            {
              duration: WORKBENCH_FLIP_DURATION_MS,
              easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
              fill: 'both',
            },
          )
          animated = true
        } catch {
          // Older embedded webviews fall back to the final geometry.
        }
      })
    }

    layoutRectsRef.current = nextRects
    if (!animated) return
    document.body.classList.add('wave-layout-animating')
    if (layoutAnimationTimerRef.current !== null) {
      window.clearTimeout(layoutAnimationTimerRef.current)
    }
    layoutAnimationTimerRef.current = window.setTimeout(() => {
      layoutAnimationTimerRef.current = null
      document.body.classList.remove('wave-layout-animating')
      signalWorkbenchLayoutSettled()
    }, WORKBENCH_FLIP_DURATION_MS + 24)
  }, [activeWorkspaceId, drawerOpen, workspaces])

  useEffect(() => {
    function handleMagnifyShortcut(event: KeyboardEvent) {
      if (!event.altKey || event.key.toLowerCase() !== 'm') return
      const workspace = workspaces.find((item) => item.id === activeWorkspaceId)
      if (!workspace?.focusedWidgetId) return
      event.preventDefault()
      toggleMagnifyWidget(workspace.focusedWidgetId)
      window.setTimeout(() => {
        updateMagnifyBounds()
        setLayoutRevision((current) => current + 1)
        signalWorkbenchLayoutSettled()
      })
    }
    window.addEventListener('keydown', handleMagnifyShortcut)
    return () => window.removeEventListener('keydown', handleMagnifyShortcut)
  }, [activeWorkspaceId, toggleMagnifyWidget, updateMagnifyBounds, workspaces])

  useEffect(() => {
    return () => {
      dragRuntimeRef.current?.cleanup()
      dragRuntimeRef.current?.proxy?.remove()
      document.body.classList.remove('wave-layout-dragging', 'wave-layout-resizing')
      workspaceDropTargetRef.current = ''
      if (layoutAnimationTimerRef.current !== null) window.clearTimeout(layoutAnimationTimerRef.current)
      document.body.classList.remove('wave-layout-animating')
    }
  }, [])

  const openCanvasMenu = (event: MouseEvent<HTMLElement>) => {
    onContextMenu(event, [
      { label: t('新开本地终端'), hint: 'Alt + N', onClick: () => onAddWidget('local-terminal') },
      { label: t('新开远程桌面'), onClick: () => onAddWidget('remote-desktop') },
      { label: t('新开文件管理'), onClick: () => onAddWidget('files') },
      { label: t('新开机器监控'), onClick: () => onAddWidget('monitor') },
      { label: t('新开系统进程'), onClick: () => onAddWidget('processes') },
      { label: t('重置分屏布局'), hint: t('Wave 智能排列'), onClick: onArrangeWidgets },
      { label: t('设置'), hint: t('外观 / 终端'), onClick: onOpenSettings },
    ])
  }

  const openWidgetMenu = (
    event: MouseEvent<HTMLElement>,
    widget: WorkbenchWidget,
    magnified: boolean,
  ) => {
    onFocusWidget(widget.id)
    const widgetServer = widget.serverId ? servers.find((server) => server.id === widget.serverId) : undefined
    const isTerminal = widget.type === 'ssh-terminal'
    const widgetSessionId = isTerminal ? getRemoteWidgetSessionId(widget) : ''
    const terminalConnected = isTerminal ? remoteTerminalConnectedSessions.has(widgetSessionId) : false
    const logRecording = isTerminal ? remoteTerminalLogStore.get(widgetSessionId).recording : false
    onContextMenu(event, [
      { label: t(magnified ? '退出聚焦' : '聚焦窗口'), hint: 'Alt + M', onClick: () => toggleMagnifyWidget(widget.id) },
      ...(isTerminal ? [{
        label: logRecording ? '停止保存会话日志' : '保存会话日志',
        hint: widgetServer ? serverAddressLabel(widgetServer) : undefined,
        disabled: !terminalConnected && !logRecording,
        onClick: () => toggleWidgetSessionLog(widgetSessionId, widgetServer, onToast),
      }] : []),
      { label: '新开本地终端', onClick: () => onAddWidget('local-terminal') },
      { label: '新开远程桌面', onClick: () => onAddWidget('remote-desktop') },
      { label: '新开文件管理', onClick: () => onAddWidget('files') },
      { label: '新开机器监控', onClick: () => onAddWidget('monitor') },
      { label: '新开系统进程', onClick: () => onAddWidget('processes') },
      { label: '重置分屏布局', onClick: onArrangeWidgets },
      { label: '全局配色设置', onClick: onOpenSettings },
      { label: '关闭窗口', danger: true, onClick: () => onCloseWidget(widget.id) },
    ])
  }

  function startLayoutPanelDrag(event: PointerEvent<HTMLElement>, widgetId: string) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, select, .xterm, .cm-editor')) return
    event.preventDefault()
    event.stopPropagation()
    onFocusWidget(widgetId)

    const sourceLeaf = event.currentTarget.closest<HTMLElement>('.wave-layout-leaf')
    const moveDrag = (moveEvent: globalThis.PointerEvent) => {
      const runtime = dragRuntimeRef.current
      if (!runtime) return
      const dx = moveEvent.clientX - runtime.startX
      const dy = moveEvent.clientY - runtime.startY
      if (!runtime.dragging) {
        if (Math.hypot(dx, dy) < 7) return
        runtime.dragging = true
        runtime.proxy = createLayoutDragProxy(
          runtime.sourceLeaf?.querySelector<HTMLElement>('.remote-session-panel') ?? runtime.sourceLeaf,
          runtime.sourceLeaf?.querySelector('strong')?.textContent ?? '窗口',
        )
        runtime.sourceLeaf?.classList.add('is-drag-source')
        document.body.classList.add('wave-layout-dragging')
        setDraggingSourceId(runtime.sourceId)
      }
      if (runtime.proxy) runtime.proxy.style.transform = `translate3d(${dx}px, ${dy}px, 0)`

      const workspaceTab = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>('.task-tab-shell[data-workspace-id], .task-tab[data-workspace-id]')
      const workspaceId = workspaceTab?.dataset.workspaceId ?? ''
      if (workspaceId && workspaceId !== activeWorkspaceId) {
        setWorkspaceDropTarget(workspaceId)
        setActiveDropPreview(null)
        return
      }
      setWorkspaceDropTarget('')

      const targetLeaf = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>('.wave-layout-leaf[data-workbench-widget-id]')
      const targetId = targetLeaf?.dataset.workbenchWidgetId
      if (!targetLeaf || !targetId || targetId === runtime.sourceId) {
        setActiveDropPreview(null)
        return
      }
      const parentDirection: LayoutDirection = targetLeaf.dataset.parentDirection === 'column'
        ? 'column'
        : 'row'
      setActiveDropPreview({
        targetId,
        parentDirection,
        zone: getWaveDropZone(
          moveEvent.clientX,
          moveEvent.clientY,
          targetLeaf.getBoundingClientRect(),
          parentDirection,
        ),
      })
    }

    const stopDrag = () => {
      const runtime = dragRuntimeRef.current
      const preview = dropPreviewRef.current
      const workspaceTargetId = workspaceDropTargetRef.current
      runtime?.cleanup()
      runtime?.proxy?.remove()
      runtime?.sourceLeaf?.classList.remove('is-drag-source')
      if (runtime?.dragging && workspaceTargetId) {
        onMoveWidgetToWorkspace(runtime.sourceId, workspaceTargetId)
        setLayoutRevision((current) => current + 1)
        window.setTimeout(signalWorkbenchLayoutSettled, WORKBENCH_FLIP_DURATION_MS + 24)
      } else if (runtime?.dragging && preview) {
        onMoveWidget(
          runtime.sourceId,
          preview.targetId,
          preview.zone,
          preview.parentDirection,
        )
        setLayoutRevision((current) => current + 1)
        window.setTimeout(signalWorkbenchLayoutSettled, WORKBENCH_FLIP_DURATION_MS + 24)
      }
      dragRuntimeRef.current = null
      document.body.classList.remove('wave-layout-dragging')
      setDraggingSourceId('')
      setActiveDropPreview(null)
      setWorkspaceDropTarget('')
    }

    const cleanup = () => {
      document.removeEventListener('pointermove', moveDrag)
      document.removeEventListener('pointerup', stopDrag)
      document.removeEventListener('pointercancel', stopDrag)
      window.removeEventListener('blur', stopDrag)
    }

    dragRuntimeRef.current?.cleanup()
    dragRuntimeRef.current = {
      sourceId: widgetId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      proxy: null,
      sourceLeaf,
      cleanup,
    }
    document.addEventListener('pointermove', moveDrag, { passive: true })
    document.addEventListener('pointerup', stopDrag)
    document.addEventListener('pointercancel', stopDrag)
    window.addEventListener('blur', stopDrag)
  }

  function startLayoutResize(
    event: PointerEvent<HTMLDivElement>,
    branch: LayoutBranch,
    beforeIndex: number,
  ) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const branchElement = event.currentTarget.parentElement
    if (!branchElement) return
    const shells = Array.from(
      branchElement.querySelectorAll<HTMLElement>(':scope > .wave-layout-node-shell'),
    )
    const beforeShell = shells[beforeIndex]
    const afterShell = shells[beforeIndex + 1]
    const beforeNode = branch.children[beforeIndex]
    const afterNode = branch.children[beforeIndex + 1]
    if (!beforeShell || !afterShell || !beforeNode || !afterNode) return

    const horizontal = branch.direction === 'row'
    const beforeRect = beforeShell.getBoundingClientRect()
    const afterRect = afterShell.getBoundingClientRect()
    const beforePixels = horizontal ? beforeRect.width : beforeRect.height
    const afterPixels = horizontal ? afterRect.width : afterRect.height
    const pairPixels = Math.max(1, beforePixels + afterPixels)
    const pairUnits = beforeNode.size + afterNode.size
    const startPointer = horizontal ? event.clientX : event.clientY
    let nextBeforeSize = beforeNode.size
    let nextAfterSize = afterNode.size
    let changed = false
    let resizeFrame: number | null = null
    let pendingPointer = startPointer
    let resizePending = false
    document.body.classList.add('wave-layout-resizing')

    const applyResize = () => {
      resizeFrame = null
      if (!resizePending) return
      resizePending = false
      const minimumPixels = Math.min(140, pairPixels * 0.35)
      const nextBeforePixels = Math.max(
        minimumPixels,
        Math.min(pairPixels - minimumPixels, beforePixels + pendingPointer - startPointer),
      )
      nextBeforeSize = pairUnits * (nextBeforePixels / pairPixels)
      nextAfterSize = pairUnits - nextBeforeSize
      beforeShell.style.flexGrow = String(nextBeforeSize)
      afterShell.style.flexGrow = String(nextAfterSize)
      changed = true
    }

    const moveResize = (moveEvent: globalThis.PointerEvent) => {
      pendingPointer = horizontal ? moveEvent.clientX : moveEvent.clientY
      resizePending = true
      if (resizeFrame === null) resizeFrame = window.requestAnimationFrame(applyResize)
    }

    const stopResize = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame)
        resizeFrame = null
      }
      applyResize()
      cleanup()
      document.body.classList.remove('wave-layout-resizing')
      if (!changed) return
      skipNextLayoutAnimationRef.current = true
      onResizeLayout(branch.id, beforeIndex, nextBeforeSize, nextAfterSize)
      setLayoutRevision((current) => current + 1)
      window.setTimeout(signalWorkbenchLayoutSettled, 100)
    }

    const cleanup = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame)
        resizeFrame = null
      }
      document.removeEventListener('pointermove', moveResize)
      document.removeEventListener('pointerup', stopResize)
      document.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
    }

    document.addEventListener('pointermove', moveResize, { passive: true })
    document.addEventListener('pointerup', stopResize)
    document.addEventListener('pointercancel', stopResize)
    window.addEventListener('blur', stopResize)
  }

  function renderLayoutNode(
    node: LayoutNode,
    parentDirection: LayoutDirection,
    workspace: WorkbenchWorkspace,
    workspaceActive: boolean,
    activeWidgetId: string,
    liveTerminalIds: Set<string>,
  ): ReactNode {
    if (node.type === 'branch') {
      return (
        <div
          className={`wave-layout-branch direction-${node.direction}`}
          data-layout-branch-id={node.id}
        >
          {node.children.map((child, index) => (
            <Fragment key={child.id}>
              <div className="wave-layout-node-shell" style={{ flexGrow: child.size }}>
                {renderLayoutNode(
                  child,
                  node.direction,
                  workspace,
                  workspaceActive,
                  activeWidgetId,
                  liveTerminalIds,
                )}
              </div>
              {index < node.children.length - 1 && (
                <div
                  className={`wave-layout-divider divider-${node.direction}`}
                  data-layout-branch-id={node.id}
                  data-layout-divider-index={index}
                  onPointerDown={(event) => startLayoutResize(event, node, index)}
                />
              )}
            </Fragment>
          ))}
        </div>
      )
    }

    const widget = workspace.widgets.find((item) => item.id === node.widgetId)
    if (!widget) return null
    const isRemoteTerminal = widget.type === 'ssh-terminal'
    const isRemoteDesktop = widget.type === 'remote-desktop'
    const widgetServer = widget.serverId
      ? servers.find((server) => server.id === widget.serverId)
      : undefined
    const state = isRemoteTerminal && widget.serverId
      ? serverConnectionStates[widget.serverId] ?? 'ready'
      : isRemoteDesktop ? remoteDesktopStates[widget.id] ?? 'ready' : 'connected'
    const active = widget.id === activeWidgetId
    const magnified = widget.id === workspace.magnifiedWidgetId
    const addressLabel = isRemoteTerminal
      ? serverAddressLabel(widgetServer)
      : isRemoteDesktop
        ? (widget.remoteDesktop
            ? `${widget.remoteDesktop.protocol.toUpperCase()} ${widget.remoteDesktop.host}:${widget.remoteDesktop.port}`
            : t('未配置'))
      : widget.serverId && widgetServer
        ? `${widgetServer.user}@${widgetServer.host}:${widgetServer.port}`
        : widget.type === 'local-terminal'
          ? t('本地终端')
          : t('本地')
    const displayTitle = t(isRemoteTerminal ? (widgetServer?.name || widget.title) : widget.title)
    const terminalLayoutKey = [
      node.id,
      node.size,
      workspaceActive ? 1 : 0,
      magnified ? 1 : 0,
      layoutRevision,
    ].join(':')
    const activePreview = dropPreview?.targetId === widget.id ? dropPreview : null

    return (
      <div
        className={`wave-layout-leaf ${active ? 'is-active' : ''} ${magnified ? 'is-magnified' : ''} ${draggingSourceId === widget.id ? 'is-drag-source' : ''}`}
        data-workbench-widget-id={widget.id}
        data-parent-direction={parentDirection}
        onPointerDown={() => onFocusWidget(widget.id)}
      >
        <div className={`remote-session-panel ${active ? 'active' : ''} remote-session-${widget.type}`}>
          <div
            className="remote-session-toolbar"
            onPointerDown={(event) => startLayoutPanelDrag(event, widget.id)}
            title={t('拖动到其他窗口进行分屏或交换')}
          >
            <GripVertical className="remote-session-grip" size={13} />
            <span className={`connection-dot ${state}`} />
            <strong className="remote-session-title">{displayTitle}</strong>
            <span className="remote-session-address">{addressLabel}</span>
            <div className="remote-session-actions">
              {(widget.type === 'local-terminal' || widget.type === 'ssh-terminal') && (
                <TerminalCliLaunchers
                  widgetId={widget.id}
                  server={widget.type === 'ssh-terminal' ? widgetServer : undefined}
                  enabled={widget.type === 'local-terminal' || (
                    state === 'connected' && remoteTerminalConnectedSessions.has(getRemoteWidgetSessionId(widget))
                  )}
                  onLaunch={onRunTerminalCli}
                />
              )}
              <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => openWidgetMenu(event, widget, magnified)} title={t('更多操作')}>
                <MoreVertical size={13} />
              </button>
              <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => toggleMagnifyWidget(widget.id)} title={t(magnified ? '退出聚焦' : '聚焦窗口')}>
                {magnified ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => triggerRefreshWidget(widget.id)}
                disabled={refreshingWidgetIds.has(widget.id)}
                title={t('刷新窗口')}
              >
                <RefreshCw size={13} />
              </button>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => magnified ? toggleMagnifyWidget(widget.id) : onCloseWidget(widget.id)}
                title={t(magnified ? '退出聚焦' : '关闭窗口')}
              >
                {magnified ? <Minimize2 size={14} /> : <X size={14} />}
              </button>
            </div>
          </div>
          {widget.type === 'local-terminal' && (
            <MemoLocalTerminalWidget
              key={getLocalWidgetSessionId(widget)}
              widgetId={widget.id}
              title={widget.title}
              sessionId={getLocalWidgetSessionId(widget)}
              terminalTheme={terminalTheme}
              layoutKey={terminalLayoutKey}
            />
          )}
          {widget.type === 'ssh-terminal' && (
            <MemoRemoteTerminalWidget
              key={getRemoteWidgetSessionId(widget)}
              widgetId={widget.id}
              title={widget.title}
              sessionId={getRemoteWidgetSessionId(widget)}
              server={widgetServer}
              terminalTheme={terminalTheme}
              layoutKey={terminalLayoutKey}
              focused={workspaceActive && active}
              renderActive={workspaceActive && (magnified || active || liveTerminalIds.has(widget.id))}
              onActivate={() => onFocusWidget(widget.id)}
              onStatus={onRemoteStatus}
            />
          )}
          {widget.type === 'remote-desktop' && (
            <MemoRemoteDesktopWidget
              key={getRemoteDesktopWidgetSessionId(widget)}
              widgetId={widget.id}
              sessionId={getRemoteDesktopWidgetSessionId(widget)}
              connection={widget.remoteDesktop}
              active={workspaceActive && active}
              autoConnect={remoteDesktopAutoConnectWidgets.has(widget.id)}
              t={t}
              onAutoConnectChange={(enabled) => {
                if (enabled) remoteDesktopAutoConnectWidgets.add(widget.id)
                else remoteDesktopAutoConnectWidgets.delete(widget.id)
              }}
              onSaveConnection={(connection) => onSetRemoteDesktopConnection(widget.id, connection)}
              onStatusChange={(nextState) => setRemoteDesktopStates((current) => current[widget.id] === nextState
                ? current
                : { ...current, [widget.id]: nextState })}
            />
          )}
          {widget.type === 'files' && (
            <MemoFileManagerWidget
              widgetId={widget.id}
              active={workspaceActive}
              server={widgetServer}
              servers={servers}
              onSelectConnection={(serverId) => onSetWidgetConnection(widget.id, serverId)}
              onSaveConnection={(draft) => onSaveWidgetConnection(widget.id, draft)}
              onEditConnections={onEditConnections}
              onContextMenu={onContextMenu}
            />
          )}
          {widget.type === 'monitor' && (
            <MemoMachineMonitorWidget
              widgetId={widget.id}
              active={workspaceActive}
              server={widgetServer}
              servers={servers}
              onSelectConnection={(serverId) => onSetWidgetConnection(widget.id, serverId)}
              onSaveConnection={(draft) => onSaveWidgetConnection(widget.id, draft)}
              onEditConnections={onEditConnections}
            />
          )}
          {widget.type === 'processes' && (
            <MemoProcessManagerWidget
              widgetId={widget.id}
              active={workspaceActive}
              server={widgetServer}
              servers={servers}
              onSelectConnection={(serverId) => onSetWidgetConnection(widget.id, serverId)}
              onSaveConnection={(draft) => onSaveWidgetConnection(widget.id, draft)}
              onEditConnections={onEditConnections}
            />
          )}
        </div>
        {activePreview && (
          <div
            className="wave-layout-drop-preview"
            data-drop-zone={activePreview.zone}
            data-parent-direction={activePreview.parentDirection}
            aria-hidden="true"
          />
        )}
      </div>
    )
  }

  return (
    <section className="workbench wave-workbench">
      <div className="workbench-topbar">
        <div className="workbench-tabs" role="tablist" aria-label={t('工作区')}>
          {workspaces.map((workspace) => {
            const active = workspace.id === activeWorkspaceId
            return (
              <div
                className={`task-tab-shell ${active ? 'active' : ''} ${workspace.id === workspaceDropTargetId ? 'workspace-drop-target' : ''}`}
                data-workspace-id={workspace.id}
                key={workspace.id}
              >
                <button
                  className={`task-tab ${active ? 'active' : ''}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSelectWorkspace(workspace.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1) onCloseWorkspace(workspace.id)
                  }}
                >
                  <span>{t(workspace.name)}</span>
                </button>
                <button
                  className="task-tab-close"
                  type="button"
                  title={`${t('关闭工作区')} ${t(workspace.name)}`}
                  aria-label={`${t('关闭工作区')} ${t(workspace.name)}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseWorkspace(workspace.id)
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
          <button className="task-add" type="button" onClick={onAddWorkspace} title={t('新建工作区')} aria-label={t('新建工作区')}>
            <Plus size={14} />
          </button>
        </div>
        <div className="workbench-actions">
          <button type="button" onClick={() => onAddWidget('local-terminal')} title={t('新建终端')}>
            <Terminal size={14} />
            {t('终端')}
          </button>
          <button type="button" onClick={() => onAddWidget('remote-desktop')} title={t('新建远程桌面')}>
            <Monitor size={14} />
            {t('桌面')}
          </button>
          <button type="button" onClick={() => onAddWidget('files')} title={t('新建文件管理')}>
            <FolderTree size={14} />
            {t('文件')}
          </button>
          <button type="button" onClick={() => onAddWidget('monitor')} title={t('新建机器监控')}>
            <Activity size={14} />
            {t('监控')}
          </button>
          <button type="button" onClick={() => onAddWidget('processes')} title={t('新建系统进程')}>
            <ListTree size={14} />
            {t('进程')}
          </button>
          <button type="button" onClick={onArrangeWidgets} title={t('重置为 Wave 智能分屏')}>
            <RotateCcw size={14} />
            {t('重排')}
          </button>
        </div>
      </div>

      <div
        className={`workbench-stage ${workspaces.some((workspace) => workspace.id === activeWorkspaceId && workspace.magnifiedWidgetId) ? 'has-magnified' : ''}`}
        ref={stageRef}
      >
        {workspaces.map((workspace) => {
          const workspaceActive = workspace.id === activeWorkspaceId
          const layout = ensureLayoutWidgets(
            workspace.layout,
            workspace.widgets.map((widget) => widget.id),
          )
          const activeWidgetId = workspace.focusedWidgetId || workspace.widgets[0]?.id || ''
          const liveTerminalIds = new Set(
            workspaceActive
              ? workspace.widgets
                  .filter((widget) => widget.type === 'local-terminal' || widget.type === 'ssh-terminal')
                  .map((widget) => widget.id)
              : [],
          )
          return (
            <div
              className={`workbench-canvas workspace-layer wave-workspace-layer ${workspaceActive ? 'active' : ''}`}
              onContextMenu={workspaceActive ? openCanvasMenu : undefined}
              key={workspace.id}
            >
              {!layout && (
                <div className="workspace-empty">
                  <strong>{t(workspace.name)}</strong>
                  <span>{t('从一个终端开始，再把文件、监控或进程拖成你需要的分屏。')}</span>
                  <div>
                    <button type="button" onClick={() => onAddWidget('local-terminal')}><Terminal size={14} />{t('终端')}</button>
                    <button type="button" onClick={() => onAddWidget('remote-desktop')}><Monitor size={14} />{t('桌面')}</button>
                    <button type="button" onClick={() => onAddWidget('files')}><FolderTree size={14} />{t('文件')}</button>
                    <button type="button" onClick={() => onAddWidget('monitor')}><Activity size={14} />{t('监控')}</button>
                    <button type="button" onClick={() => onAddWidget('processes')}><ListTree size={14} />{t('进程')}</button>
                  </div>
                </div>
              )}
              {layout && (
                <div className={`wave-layout-root ${workspace.magnifiedWidgetId ? 'has-magnified' : ''}`}>
                  {renderLayoutNode(
                    layout,
                    'row',
                    workspace,
                    workspaceActive,
                    activeWidgetId,
                    liveTerminalIds,
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function LegacyWorkbench({
  workspaces,
  activeWorkspaceId,
  servers,
  terminalTheme,
  onSelectWorkspace,
  onAddWorkspace,
  onFocusWidget,
  onResizeWidget,
  onSetWidgetRect,
  onCloseWidget,
  onRefreshWidget,
  onToggleMaximizeWidget,
  onReorderWidget,
  onArrangeWidgets,
  onApplyLayout,
  onApplyLayoutDrop,
  onAddWidget,
  onContextMenu,
  onOpenSettings,
  onRemoteStatus,
  onRunTerminalCli,
  serverConnectionStates,
}: {
  workspaces: WorkbenchWorkspace[]
  activeWorkspaceId: string
  servers: ServerProfile[]
  terminalTheme: TerminalThemeSettings
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: () => void
  onFocusWidget: (id: string) => void
  onResizeWidget: (id: string, direction: ResizeDirection, dx: number, dy: number) => void
  onSetWidgetRect: (id: string, rect: Pick<WorkbenchWidget, 'x' | 'y' | 'w' | 'h'>) => void
  onCloseWidget: (id: string) => void
  onRefreshWidget: (id: string) => void
  onToggleMaximizeWidget: (id: string) => void
  onReorderWidget: (sourceId: string, targetId: string, viewport: WorkbenchViewport) => void
  onArrangeWidgets: () => void
  onApplyLayout: (preset: WorkbenchLayoutPreset, viewport: WorkbenchViewport) => void
  onApplyLayoutDrop: (preset: WorkbenchLayoutPreset, sourceId: string, slotIndex: number, viewport: WorkbenchViewport) => void
  onAddWidget: (type: WorkbenchWidgetType) => void
  onContextMenu: (event: MouseEvent<HTMLElement>, items: ContextMenuItem[]) => void
  onOpenSettings: () => void
  onRemoteStatus: (serverId: string, state: ConnectionState, message?: string) => void
  onRunTerminalCli: (widgetId: string, tool: CliToolInfo) => void
  serverConnectionStates: Record<string, ConnectionState>
}) {
  void applyWorkbenchLayout
  void moveWorkbenchWidgetToIndex
  void getDefaultWorkbenchViewport
  void shouldUseLocalRemoteLayout
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)
  const [layoutSnapHintVisible, setLayoutSnapHintVisible] = useState(false)
  const [refreshingWidgetIds, setRefreshingWidgetIds] = useState<Set<string>>(() => new Set())
  const [layoutRevision, setLayoutRevision] = useState(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const layoutMenuOpenRef = useRef(false)
  const layoutSnapHintVisibleRef = useRef(false)
  const refreshingWidgetIdsRef = useRef(new Set<string>())
  const layoutDragRef = useRef<{
    sourceId: string
    startX: number
    startY: number
    dx: number
    dy: number
    dragging: boolean
    lastTargetId: string
    proxy: HTMLDivElement | null
    sourcePanel: HTMLElement | null
    deck: HTMLElement | null
    hoveredPreset: WorkbenchLayoutPreset | ''
    hoveredSlotIndex: number
    openedLayoutMenu: boolean
    menuWasOpen: boolean
    cleanup: () => void
  } | null>(null)
  const layoutResizeRef = useRef<{
    widget: WorkbenchWidget
    direction: ResizeDirection
    startX: number
    startY: number
    dx: number
    dy: number
    panel: HTMLElement | null
    cleanup: () => void
  } | null>(null)
  const layoutResizeFrameRef = useRef<number | null>(null)

  useEffect(() => {
    layoutMenuOpenRef.current = layoutMenuOpen
  }, [layoutMenuOpen])

  const setLayoutSnapHint = useCallback((visible: boolean) => {
    if (layoutSnapHintVisibleRef.current === visible) return
    layoutSnapHintVisibleRef.current = visible
    setLayoutSnapHintVisible(visible)
  }, [])

  const triggerRefreshWidget = useCallback((id: string) => {
    if (refreshingWidgetIdsRef.current.has(id)) return
    refreshingWidgetIdsRef.current.add(id)
    setRefreshingWidgetIds(new Set(refreshingWidgetIdsRef.current))
    onRefreshWidget(id)
    window.setTimeout(() => {
      refreshingWidgetIdsRef.current.delete(id)
      setRefreshingWidgetIds(new Set(refreshingWidgetIdsRef.current))
    }, 1200)
  }, [onRefreshWidget])

  const openSettings = useCallback(() => {
    setLayoutMenuOpen(false)
    onOpenSettings()
  }, [onOpenSettings])

  useEffect(() => {
    return () => {
      layoutDragRef.current?.cleanup()
      layoutDragRef.current?.proxy?.remove()
      layoutDragRef.current = null
      layoutResizeRef.current?.cleanup()
      layoutResizeRef.current = null
      if (layoutResizeFrameRef.current !== null) window.cancelAnimationFrame(layoutResizeFrameRef.current)
      document.body.classList.remove('widget-drag-active')
      clearLayoutDragClasses()
    }
  }, [])

  function applyLayoutPreset(preset: WorkbenchLayoutPreset) {
    const deck = stageRef.current?.querySelector<HTMLElement>('.workspace-layer.active .remote-terminal-deck')
    onApplyLayout(preset, measureWorkbenchViewport(stageRef.current, deck))
    setLayoutRevision((current) => current + 1)
    signalWorkbenchLayoutSettled()
    setLayoutMenuOpen(false)
  }

  const openCanvasMenu = (event: MouseEvent<HTMLElement>) => {
    onContextMenu(event, [
      { label: '新开本地终端', hint: 'cmd / 用户目录', onClick: () => onAddWidget('local-terminal') },
      { label: '新开文件管理', hint: '用户目录', onClick: () => onAddWidget('files') },
      { label: '新开机器占用', hint: '本机概览', onClick: () => onAddWidget('monitor') },
      { label: '自动排列窗口', hint: '当前桌面', onClick: onArrangeWidgets },
      { label: '打开布局模板', hint: 'Snap', onClick: () => setLayoutMenuOpen(true) },
      { label: '设置', hint: '外观 / 服务器', onClick: openSettings },
    ])
  }

  const openWidgetMenu = (event: MouseEvent<HTMLElement>, widget: WorkbenchWidget) => {
    onFocusWidget(widget.id)
    onContextMenu(event, [
      { label: '置顶当前窗口', hint: widget.title, onClick: () => onFocusWidget(widget.id) },
      { label: '新开本地终端', onClick: () => onAddWidget('local-terminal') },
      { label: '新开文件管理', onClick: () => onAddWidget('files') },
      { label: '新开机器占用', onClick: () => onAddWidget('monitor') },
      { label: widget.maximized ? '还原窗口' : '最大化窗口', onClick: () => onToggleMaximizeWidget(widget.id) },
      { label: '自动排列窗口', onClick: onArrangeWidgets },
      { label: '全局配色设置', hint: '工作台 / 终端', onClick: openSettings },
      {
        label: '关闭窗口',
        danger: true,
        onClick: () => onCloseWidget(widget.id),
      },
    ])
  }

  const startLayoutPanelDrag = (event: PointerEvent<HTMLElement>, widgetId: string) => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, select, .xterm, .cm-editor')) return
    event.preventDefault()
    event.stopPropagation()
    onFocusWidget(widgetId)
    const sourcePanel = event.currentTarget.closest<HTMLElement>('[data-workbench-widget-id]')
    const deck = sourcePanel?.closest<HTMLElement>('.remote-terminal-deck') ?? null
    sourcePanel?.classList.add('layout-armed')

    const moveLayoutDrag = (moveEvent: globalThis.PointerEvent) => {
      const dragState = layoutDragRef.current
      if (!dragState) return
      dragState.dx = moveEvent.clientX - dragState.startX
      dragState.dy = moveEvent.clientY - dragState.startY
      if (!dragState.dragging) {
        if (Math.hypot(dragState.dx, dragState.dy) < 8) return
        dragState.dragging = true
        document.body.classList.add('widget-drag-active')
        dragState.sourcePanel?.classList.add('layout-dragging')
        dragState.proxy = createLayoutDragProxy(
          dragState.sourcePanel,
          dragState.sourcePanel?.querySelector('strong')?.textContent ?? '窗口',
        )
      }
      if (dragState.proxy) {
        dragState.proxy.style.transform = `translate3d(${dragState.dx}px, ${dragState.dy}px, 0)`
      }

      const shouldShowSnapHint = !layoutMenuOpenRef.current && shouldShowDragLayoutHint(
        dragState.deck,
        moveEvent.clientX,
        moveEvent.clientY,
        dragState.dy,
      )
      setLayoutSnapHint(shouldShowSnapHint)

      if (shouldOpenDragLayoutChooser(dragState.deck, moveEvent.clientX, moveEvent.clientY, dragState.dy)) {
        if (!layoutMenuOpenRef.current) {
          dragState.openedLayoutMenu = true
          layoutMenuOpenRef.current = true
          setLayoutSnapHint(false)
          setLayoutMenuOpen(true)
        }
      }

      const hoveredLayoutDrop = getHoveredLayoutDrop(moveEvent.clientX, moveEvent.clientY)
      const hoveredPreset = hoveredLayoutDrop?.preset ?? null
      const hoveredSlotIndex = hoveredLayoutDrop?.slotIndex ?? -1
      if (hoveredPreset !== dragState.hoveredPreset || hoveredSlotIndex !== dragState.hoveredSlotIndex) {
        dragState.hoveredPreset = hoveredPreset ?? ''
        dragState.hoveredSlotIndex = hoveredSlotIndex
        markActiveLayoutPreset(hoveredPreset, hoveredSlotIndex)
      }
      if (hoveredPreset) return

      const directTargetPanel = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>('[data-workbench-widget-id]')
      const targetId = getLayoutDropTargetId(
        dragState.deck,
        dragState.sourceId,
        moveEvent.clientX,
        moveEvent.clientY,
      ) ?? directTargetPanel?.dataset.workbenchWidgetId
      markLayoutDropTarget(targetId)
      if (!targetId || targetId === dragState.sourceId || targetId === dragState.lastTargetId) return
      dragState.lastTargetId = targetId
      onReorderWidget(dragState.sourceId, targetId, measureWorkbenchViewport(stageRef.current, dragState.deck))
    }

    const stopLayoutDrag = () => {
      const dragState = layoutDragRef.current
      dragState?.cleanup()
      dragState?.proxy?.remove()
      if (dragState?.hoveredPreset) {
        onApplyLayoutDrop(
          dragState.hoveredPreset,
          dragState.sourceId,
          dragState.hoveredSlotIndex,
          measureWorkbenchViewport(stageRef.current, dragState.deck),
        )
      }
      if (dragState?.openedLayoutMenu && !dragState.menuWasOpen) {
        layoutMenuOpenRef.current = false
        setLayoutMenuOpen(false)
      }
      layoutDragRef.current = null
      document.body.classList.remove('widget-drag-active')
      setLayoutSnapHint(false)
      clearLayoutDragClasses()
      setLayoutRevision((current) => current + 1)
      signalWorkbenchLayoutSettled()
    }

    const cleanup = () => {
      document.removeEventListener('pointermove', moveLayoutDrag)
      document.removeEventListener('pointerup', stopLayoutDrag)
      document.removeEventListener('pointercancel', stopLayoutDrag)
      window.removeEventListener('blur', stopLayoutDrag)
    }

    layoutDragRef.current?.cleanup()
    layoutDragRef.current = {
      sourceId: widgetId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      dragging: false,
      lastTargetId: '',
      proxy: null,
      sourcePanel,
      deck,
      hoveredPreset: '',
      hoveredSlotIndex: -1,
      openedLayoutMenu: false,
      menuWasOpen: layoutMenuOpenRef.current,
      cleanup,
    }
    document.addEventListener('pointermove', moveLayoutDrag, { passive: true })
    document.addEventListener('pointerup', stopLayoutDrag)
    document.addEventListener('pointercancel', stopLayoutDrag)
    window.addEventListener('blur', stopLayoutDrag)
  }

  function flushLayoutPanelResizePreview() {
    layoutResizeFrameRef.current = null
    const resizeState = layoutResizeRef.current
    if (!resizeState?.panel) return
    const preview = resizeWidgetRect(
      resizeState.widget,
      resizeState.direction,
      resizeState.dx,
      resizeState.dy,
    )
    resizeState.panel.style.left = `${preview.x}px`
    resizeState.panel.style.top = `${preview.y}px`
    resizeState.panel.style.width = `${preview.w}px`
    resizeState.panel.style.height = `${preview.h}px`
  }

  function startLayoutPanelResize(direction: ResizeDirection, event: PointerEvent<HTMLDivElement>, widget: WorkbenchWidget) {
    event.preventDefault()
    event.stopPropagation()
    onFocusWidget(widget.id)
    const panel = event.currentTarget.closest<HTMLElement>('.remote-session-panel')
    const moveResize = (moveEvent: globalThis.PointerEvent) => {
      const resizeState = layoutResizeRef.current
      if (!resizeState) return
      resizeState.dx = moveEvent.clientX - resizeState.startX
      resizeState.dy = moveEvent.clientY - resizeState.startY
      if (layoutResizeFrameRef.current === null) {
        layoutResizeFrameRef.current = window.requestAnimationFrame(flushLayoutPanelResizePreview)
      }
    }
    const stopResize = () => {
      if (layoutResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutResizeFrameRef.current)
        layoutResizeFrameRef.current = null
      }
      const resizeState = layoutResizeRef.current
      resizeState?.cleanup()
      resizeState?.panel?.classList.remove('resizing')
      if (resizeState && (resizeState.dx || resizeState.dy)) {
        onResizeWidget(resizeState.widget.id, resizeState.direction, resizeState.dx, resizeState.dy)
      }
      layoutResizeRef.current = null
      setLayoutRevision((current) => current + 1)
      signalWorkbenchLayoutSettled()
    }
    const cleanup = () => {
      document.removeEventListener('pointermove', moveResize)
      document.removeEventListener('pointerup', stopResize)
      document.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
    }
    layoutResizeRef.current?.cleanup()
    layoutResizeRef.current = {
      widget,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      panel,
      cleanup,
    }
    panel?.classList.add('resizing')
    document.addEventListener('pointermove', moveResize, { passive: true })
    document.addEventListener('pointerup', stopResize)
    document.addEventListener('pointercancel', stopResize)
    window.addEventListener('blur', stopResize)
  }

  return (
    <section className="workbench">
      <div className="workbench-topbar">
        <span className={`snap-layout-edge-hint ${layoutSnapHintVisible ? 'visible' : ''}`} aria-hidden="true" />
        <div className="workbench-tabs">
          {workspaces.map((workspace) => (
            <button
              className={`task-tab ${workspace.id === activeWorkspaceId ? 'active' : ''}`}
              type="button"
              onClick={() => onSelectWorkspace(workspace.id)}
              key={workspace.id}
            >
              {workspace.name}
            </button>
          ))}
          <button className="task-add" type="button" onClick={onAddWorkspace}>
            <Plus size={14} />
          </button>
        </div>
        <div className="workbench-actions">
          <button type="button" onClick={() => onAddWidget('local-terminal')}>
            <Terminal size={14} />
            终端
          </button>
          <button type="button" onClick={() => onAddWidget('files')}>
            <FolderTree size={14} />
            文件
          </button>
          <button type="button" onClick={() => onAddWidget('monitor')}>
            <Activity size={14} />
            监控
          </button>
          <button type="button" onClick={() => setLayoutMenuOpen((current) => !current)}>
            <Square size={14} />
            布局
          </button>
        </div>
        <AnimatePresence>
          {layoutMenuOpen && (
            <motion.div
              className="snap-layout-popover"
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
            >
              {layoutPresets.map((preset) => (
                <button
                  className={workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.layoutPreset === preset.id ? 'active' : ''}
                  type="button"
                  data-layout-preset={preset.id}
                  onClick={() => applyLayoutPreset(preset.id)}
                  key={preset.id}
                >
                  <span className={`layout-preview layout-${preset.id}`}>
                    {preset.blocks.map((block, index) => (
                      <i
                        className="layout-preview-slot"
                        data-layout-preset={preset.id}
                        data-layout-slot={index}
                        style={block}
                        key={index}
                      />
                    ))}
                  </span>
                  <em>{preset.label}</em>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="workbench-stage" ref={stageRef} onMouseDown={() => layoutMenuOpen && setLayoutMenuOpen(false)}>
        {workspaces.map((workspace) => (
          (() => {
            const workspaceActive = workspace.id === activeWorkspaceId
            const layoutWidgets = workspace.widgets
            const floatingWidgets: WorkbenchWidget[] = []
            const maximizedLayoutWidget = layoutWidgets.find((widget) => widget.maximized)
            const visibleLayoutWidgets = maximizedLayoutWidget ? [maximizedLayoutWidget] : layoutWidgets
            const singleLayoutWidget = visibleLayoutWidgets.length === 1
            const activeLayoutWidget = maximizedLayoutWidget
              ?? layoutWidgets.find((widget) => widget.id === workspace.focusedWidgetId)
              ?? layoutWidgets[0]
            const deckDensityClass = getWorkbenchDeckDensityClass(visibleLayoutWidgets.length)
            const liveTerminalIds = new Set(
              workspaceActive
                ? visibleLayoutWidgets
                    .filter((widget) => widget.type === 'local-terminal' || widget.type === 'ssh-terminal')
                    .map((widget) => widget.id)
                : [],
            )
            const deckStyle: CSSProperties = {
              height: maximizedLayoutWidget || singleLayoutWidget ? '100%' : getWorkbenchDeckHeight(visibleLayoutWidgets),
            }
            return (
          <div
            className={`workbench-canvas workspace-layer ${layoutWidgets.length ? 'terminal-deck-canvas' : ''} ${workspace.id === activeWorkspaceId ? 'active' : ''}`}
            style={{ minHeight: singleLayoutWidget ? undefined : getWorkbenchDeckHeight(visibleLayoutWidgets) }}
            onContextMenu={workspaceActive ? openCanvasMenu : undefined}
            key={workspace.id}
          >
            {workspace.widgets.length === 0 && (
              <div className="workspace-empty">
                <strong>{workspace.name} 空桌面</strong>
                <span>像 Windows 多桌面一样，这里会保留自己的任务窗口。</span>
                <div>
                  <button type="button" onClick={() => onAddWidget('local-terminal')}>
                    <Terminal size={14} />
                    终端
                  </button>
                  <button type="button" onClick={() => onAddWidget('files')}>
                    <FolderTree size={14} />
                    文件
                  </button>
                  <button type="button" onClick={() => onAddWidget('monitor')}>
                    <Activity size={14} />
                    监控
                  </button>
                </div>
              </div>
            )}
            {layoutWidgets.length > 0 && (
              <div className={`remote-terminal-deck ${maximizedLayoutWidget || singleLayoutWidget ? 'single' : ''} layout-${workspace.layoutPreset ?? 'grid'} ${deckDensityClass}`} style={deckStyle}>
                {visibleLayoutWidgets.map((widget) => {
                  const isRemoteTerminal = widget.type === 'ssh-terminal'
                  const widgetServer = isRemoteTerminal
                    ? servers.find((server) => server.id === widget.serverId)
                    : widget.serverId
                      ? servers.find((server) => server.id === widget.serverId)
                    : undefined
                  const state = isRemoteTerminal && widget.serverId
                    ? serverConnectionStates[widget.serverId] ?? 'ready'
                    : 'connected'
                  const active = widget.id === activeLayoutWidget?.id
                  const addressLabel = isRemoteTerminal
                    ? serverAddressLabel(widgetServer)
                    : widget.serverId && widgetServer
                      ? `${widgetServer.user}@${widgetServer.host}:${widgetServer.port}`
                      : widget.type === 'local-terminal'
                        ? '本地终端'
                        : '本地'
                  const displayTitle = isRemoteTerminal ? (widgetServer?.name || widget.title) : widget.title
                  const remoteAuxReady = widget.serverId ? hasSshAuthentication(widgetServer) : true
                  const remoteAuxActive = remoteAuxReady
                  const panelStyle: CSSProperties = maximizedLayoutWidget || singleLayoutWidget
                    ? { inset: 0 }
                    : {
                        left: widget.x,
                        top: widget.y,
                        width: widget.w,
                        height: widget.h,
                      }
                  const terminalLayoutKey = [
                    widget.x,
                    widget.y,
                    widget.w,
                    widget.h,
                    widget.maximized ? 1 : 0,
                    singleLayoutWidget ? 1 : 0,
                    workspaceActive ? 1 : 0,
                    layoutRevision,
                  ].join(':')
                  return (
                    <div
                      className={`remote-session-panel ${active ? 'active' : ''} remote-session-${widget.type}`}
                      data-workbench-widget-id={widget.id}
                      onPointerDown={() => onFocusWidget(widget.id)}
                      style={panelStyle}
                      key={widget.id}
                    >
                      <div
                        className="remote-session-toolbar"
                        onPointerDown={(event) => startLayoutPanelDrag(event, widget.id)}
                        title="拖动调整窗口顺序"
                      >
                        <GripVertical className="remote-session-grip" size={13} />
                        <span className={`connection-dot ${state}`} />
                        <strong className="remote-session-title">{displayTitle}</strong>
                        <span className="remote-session-address">{addressLabel}</span>
                        <div className="remote-session-actions">
                          {(widget.type === 'local-terminal' || widget.type === 'ssh-terminal') && (
                            <TerminalCliLaunchers
                              widgetId={widget.id}
                              server={widget.type === 'ssh-terminal' ? widgetServer : undefined}
                              enabled={widget.type === 'local-terminal' || (
                                state === 'connected' && remoteTerminalConnectedSessions.has(getRemoteWidgetSessionId(widget))
                              )}
                              onLaunch={onRunTerminalCli}
                            />
                          )}
                          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => openWidgetMenu(event, widget)} title="更多操作">
                            <MoreVertical size={13} />
                          </button>
                          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => onFocusWidget(widget.id)} title="聚焦窗口">
                            <Eye size={13} />
                          </button>
                          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={openSettings} title="设置">
                            <Settings2 size={13} />
                          </button>
                          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => onToggleMaximizeWidget(widget.id)} title={widget.maximized ? '还原终端' : '最大化终端'}>
                            <Maximize2 size={13} />
                          </button>
                          <button
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => triggerRefreshWidget(widget.id)}
                            disabled={refreshingWidgetIds.has(widget.id)}
                            title="刷新窗口"
                          >
                            <RefreshCw size={13} />
                          </button>
                          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => onCloseWidget(widget.id)} title="关闭终端">
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                      {widget.type === 'local-terminal' && (
                        <MemoLocalTerminalWidget
                          key={getLocalWidgetSessionId(widget)}
                          widgetId={widget.id}
                          title={widget.title}
                          sessionId={getLocalWidgetSessionId(widget)}
                          terminalTheme={terminalTheme}
                          layoutKey={terminalLayoutKey}
                        />
                      )}
                      {widget.type === 'ssh-terminal' && (
                        <MemoRemoteTerminalWidget
                          key={getRemoteWidgetSessionId(widget)}
                          widgetId={widget.id}
                          title={widget.title}
                          sessionId={getRemoteWidgetSessionId(widget)}
                          server={widgetServer}
                          terminalTheme={terminalTheme}
                          layoutKey={terminalLayoutKey}
                          focused={workspaceActive && active}
                          renderActive={workspaceActive && (Boolean(maximizedLayoutWidget) || active || liveTerminalIds.has(widget.id))}
                          onActivate={() => onFocusWidget(widget.id)}
                          onStatus={onRemoteStatus}
                        />
                      )}
                      {widget.type === 'files' && (
                        remoteAuxActive ? (
                          <MemoFileManagerWidget
                            widgetId={widget.id}
                            active={workspaceActive && remoteAuxActive}
                            server={widgetServer}
                            onContextMenu={onContextMenu}
                          />
                        ) : (
                          <AuxIdlePlaceholder type="files" />
                        )
                      )}
                      {widget.type === 'monitor' && (
                        remoteAuxActive ? (
                          <MemoMachineMonitorWidget
                            active={workspaceActive && remoteAuxActive}
                            server={widgetServer}
                          />
                        ) : (
                          <AuxIdlePlaceholder type="monitor" />
                        )
                      )}
                      {!maximizedLayoutWidget && !singleLayoutWidget && (['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeDirection[]).map((direction) => (
                        <div
                          className={`resize-handle resize-${direction}`}
                          onPointerDown={(event) => startLayoutPanelResize(direction, event, widget)}
                          key={direction}
                        />
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
            {getWorkbenchGroupFrames(floatingWidgets, servers).map((frame) => (
              <div
                className="workbench-group-frame"
                style={{
                  left: frame.x,
                  top: frame.y,
                  width: frame.w,
                  height: frame.h,
                }}
                key={frame.id}
              >
                <span>{frame.title}</span>
                <em>{frame.count} 个窗口</em>
              </div>
            ))}
            {floatingWidgets.map((widget, index) => (
              (() => {
                const widgetServer = servers.find((server) => server.id === widget.serverId)
                const remoteAuxReady = widget.serverId ? hasSshAuthentication(widgetServer) : true
                const widgetFocused = widget.id === workspace.focusedWidgetId && workspaceActive
                const remoteAuxActive = remoteAuxReady
                return (
              <FloatingWidget
                widget={widget}
                server={widgetServer}
                zIndex={widget.id === workspace.focusedWidgetId ? 20 : 10 + index}
                focused={widgetFocused}
                onFocus={() => onFocusWidget(widget.id)}
                onResize={(direction, dx, dy) => onResizeWidget(widget.id, direction, dx, dy)}
                onSetRect={(rect) => onSetWidgetRect(widget.id, rect)}
                onClose={() => onCloseWidget(widget.id)}
                onRefresh={() => triggerRefreshWidget(widget.id)}
                onOpenSettings={openSettings}
                onToggleMaximize={() => onToggleMaximizeWidget(widget.id)}
                onContextMenu={(event) => openWidgetMenu(event, widget)}
                onMore={(event) => openWidgetMenu(event, widget)}
                key={widget.id}
              >
                {widget.type === 'local-terminal' && (
                  <MemoLocalTerminalWidget
                    key={getLocalWidgetSessionId(widget)}
                    widgetId={widget.id}
                    title={widget.title}
                    sessionId={getLocalWidgetSessionId(widget)}
                    terminalTheme={terminalTheme}
                    layoutKey={`${widget.x}:${widget.y}:${widget.w}:${widget.h}:${workspaceActive ? 1 : 0}:${layoutRevision}`}
                  />
                )}
                {widget.type === 'files' && (
                  remoteAuxActive ? (
                    <MemoFileManagerWidget
                      widgetId={widget.id}
                      active={workspaceActive && remoteAuxActive}
                      server={widgetServer}
                      onContextMenu={onContextMenu}
                    />
                  ) : (
                    <AuxIdlePlaceholder type="files" />
                  )
                )}
                {widget.type === 'monitor' && (
                  remoteAuxActive ? (
                    <MemoMachineMonitorWidget
                      active={workspaceActive && remoteAuxActive}
                      server={widgetServer}
                    />
                  ) : (
                    <AuxIdlePlaceholder type="monitor" />
                  )
                )}
              </FloatingWidget>
                )
              })()
            ))}
          </div>
            )
          })()
        ))}
      </div>
    </section>
  )
}

function FloatingWidget({
  widget,
  server,
  zIndex,
  focused,
  children,
  onFocus,
  onResize,
  onSetRect,
  onClose,
  onRefresh,
  onOpenSettings,
  onToggleMaximize,
  onContextMenu,
  onMore,
}: {
  widget: WorkbenchWidget
  server?: ServerProfile
  zIndex: number
  focused: boolean
  children: ReactNode
  onFocus: () => void
  onResize: (direction: ResizeDirection, dx: number, dy: number) => void
  onSetRect: (rect: Pick<WorkbenchWidget, 'x' | 'y' | 'w' | 'h'>) => void
  onClose: () => void
  onRefresh: () => void
  onOpenSettings: () => void
  onToggleMaximize: () => void
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onMore: (event: MouseEvent<HTMLElement>) => void
}) {
  const widgetRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    dx: number
    dy: number
    proxy: HTMLDivElement | null
    cleanup: () => void
  } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; dx: number; dy: number; direction: ResizeDirection } | null>(null)
  const moveFrameRef = useRef<number | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const icon = widgetIcon(widget.type)

  useEffect(() => {
    return () => {
      if (moveFrameRef.current !== null) window.cancelAnimationFrame(moveFrameRef.current)
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
      dragRef.current?.cleanup()
      dragRef.current?.proxy?.remove()
      document.body.classList.remove('widget-drag-active')
    }
  }, [])

  function flushMovePreview() {
    moveFrameRef.current = null
    if (!dragRef.current?.proxy) return
    dragRef.current.proxy.style.transform = `translate3d(${dragRef.current.dx}px, ${dragRef.current.dy}px, 0)`
  }

  function flushResizePreview() {
    resizeFrameRef.current = null
    if (!resizeRef.current || !widgetRef.current) return
    const preview = resizeWidgetRect(widget, resizeRef.current.direction, resizeRef.current.dx, resizeRef.current.dy)
    widgetRef.current.style.left = `${preview.x}px`
    widgetRef.current.style.top = `${preview.y}px`
    widgetRef.current.style.width = `${preview.w}px`
    widgetRef.current.style.height = `${preview.h}px`
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, .xterm')) return
    event.preventDefault()
    event.stopPropagation()
    window.getSelection()?.removeAllRanges()
    document.body.classList.add('widget-drag-active')
    onFocus()
    const proxy = createDragProxy(widgetRef.current, widget, zIndex)
    const moveDrag = (moveEvent: globalThis.PointerEvent) => {
      const dragState = dragRef.current
      if (!dragState) return
      dragState.dx = moveEvent.clientX - dragState.startX
      dragState.dy = moveEvent.clientY - dragState.startY
      if (moveFrameRef.current === null) {
        moveFrameRef.current = window.requestAnimationFrame(flushMovePreview)
      }
    }
    const stopNativeDrag = () => finishDrag()
    const cleanup = () => {
      document.removeEventListener('pointermove', moveDrag)
      document.removeEventListener('pointerup', stopNativeDrag)
      document.removeEventListener('pointercancel', stopNativeDrag)
      window.removeEventListener('blur', stopNativeDrag)
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      proxy,
      cleanup,
    }
    widgetRef.current?.classList.add('dragging')
    document.addEventListener('pointermove', moveDrag, { passive: true })
    document.addEventListener('pointerup', stopNativeDrag)
    document.addEventListener('pointercancel', stopNativeDrag)
    window.addEventListener('blur', stopNativeDrag)
  }

  function startResize(direction: ResizeDirection, event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    onFocus()
    resizeRef.current = { startX: event.clientX, startY: event.clientY, dx: 0, dy: 0, direction }
    widgetRef.current?.classList.add('resizing')
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resize(event: PointerEvent<HTMLDivElement>) {
    if (!resizeRef.current) return
    resizeRef.current = {
      ...resizeRef.current,
      dx: event.clientX - resizeRef.current.startX,
      dy: event.clientY - resizeRef.current.startY,
    }
    if (resizeFrameRef.current === null) {
      resizeFrameRef.current = window.requestAnimationFrame(flushResizePreview)
    }
  }

  function stopResize(event: PointerEvent<HTMLDivElement>) {
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
    }
    const finalResize = resizeRef.current
    widgetRef.current?.classList.remove('resizing')
    if (finalResize && (finalResize.dx || finalResize.dy)) {
      widgetRef.current?.style.removeProperty('left')
      widgetRef.current?.style.removeProperty('top')
      widgetRef.current?.style.removeProperty('width')
      widgetRef.current?.style.removeProperty('height')
      onResize(finalResize.direction, finalResize.dx, finalResize.dy)
    }
    resizeRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released.
    }
  }

  function finishDrag() {
    if (moveFrameRef.current !== null) {
      window.cancelAnimationFrame(moveFrameRef.current)
      moveFrameRef.current = null
    }
    const finalDrag = dragRef.current
    finalDrag?.cleanup()
    document.body.classList.remove('widget-drag-active')
    widgetRef.current?.classList.remove('dragging')
    if (finalDrag && (finalDrag.dx || finalDrag.dy)) {
      onSetRect({
        x: Math.max(0, Math.round(widget.x + finalDrag.dx)),
        y: Math.max(0, Math.round(widget.y + finalDrag.dy)),
        w: widget.w,
        h: widget.h,
      })
    }
    finalDrag?.proxy?.remove()
    dragRef.current = null
  }

  function stopTitlebarActionPointer(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation()
    if (dragRef.current) {
      finishDrag()
      return
    }
    document.body.classList.remove('widget-drag-active')
  }

  return (
      <article
        ref={widgetRef}
        className={`workspace-widget widget-${widget.type} ${widget.type === 'files' ? 'file-widget-host' : ''} ${focused ? 'focused' : ''}`}
        style={{
          left: widget.x,
          top: widget.y,
          width: widget.w,
          height: widget.h,
          zIndex,
        }}
        onContextMenu={onContextMenu}
      >
        <div
          className="widget-titlebar"
          onPointerDown={startDrag}
        >
          <span className="widget-icon">{icon}</span>
          <strong>{widget.title}</strong>
          <div className="widget-actions">
            <button className="widget-action-button" type="button" onPointerDown={stopTitlebarActionPointer} onClick={onMore} aria-label="更多操作">
              <MoreVertical size={12} />
            </button>
            {widget.type === 'ssh-terminal' && (
              <RemoteTerminalLogButton
                sessionId={getRemoteWidgetSessionId(widget)}
                server={server}
              />
            )}
            {widget.type === 'ssh-terminal' && (
              <button className="widget-action-button" type="button" onPointerDown={stopTitlebarActionPointer} onClick={onRefresh} aria-label="重连终端" title="重连终端">
                <RefreshCw size={12} />
              </button>
            )}
            <button className="widget-action-button" type="button" onPointerDown={stopTitlebarActionPointer} onClick={onFocus} aria-label="聚焦窗口">
              <Eye size={12} />
            </button>
            <button className="widget-action-button" type="button" onPointerDown={stopTitlebarActionPointer} onClick={onOpenSettings} aria-label="设置">
              <Settings2 size={12} />
            </button>
            <button className="widget-action-button" type="button" onPointerDown={stopTitlebarActionPointer} onClick={onToggleMaximize} aria-label="最大化">
              <Maximize2 size={12} />
            </button>
            <button className="widget-action-button danger" type="button" onPointerDown={stopTitlebarActionPointer} onClick={onClose} aria-label="关闭窗口">
              <X size={13} />
            </button>
          </div>
        </div>
        <div className="widget-body">{children}</div>
        {(['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeDirection[]).map((direction) => (
          <div
            className={`resize-handle resize-${direction}`}
            onPointerDown={(event) => startResize(direction, event)}
            onPointerMove={resize}
            onPointerUp={stopResize}
            onPointerCancel={stopResize}
            key={direction}
          />
        ))}
      </article>
  )
}

function LocalTerminalWidget({
  widgetId,
  title,
  sessionId,
  terminalTheme,
  layoutKey,
}: {
  widgetId: string
  title: string
  sessionId: string
  terminalTheme: TerminalThemeSettings
  layoutKey: string
}) {
  const { t } = useAppLocale()
  const terminalHost = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef(sessionId)
  const initialThemeRef = useRef(terminalTheme)
  const initialTranslateRef = useRef(t)
  const writeQueueRef = useRef('')
  const writeFrameRef = useRef<number | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  const recoverTerminalRef = useRef<(reason: unknown) => Promise<void>>(() => Promise.resolve())
  const [terminalMenu, setTerminalMenu] = useState<ContextMenuState>(null)

  useEffect(() => {
    if (!terminalHost.current || terminalRef.current) return

    const host = terminalHost.current
    const shellSessionId = sessionIdRef.current
    const pendingStop = localTerminalStopTimers.get(shellSessionId)
    if (pendingStop !== undefined) {
      window.clearTimeout(pendingStop)
      localTerminalStopTimers.delete(shellSessionId)
    }
    const fitAddon = new FitAddon()
    const terminal = new XTerm({
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      cursorWidth: 2,
      customGlyphs: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 4.5,
      rescaleOverlappingGlyphs: false,
      scrollOnUserInput: true,
      scrollSensitivity: 2,
      fastScrollSensitivity: 5,
      scrollback: 10000,
      smoothScrollDuration: 0,
      fontFamily: initialThemeRef.current.fontFamily,
      fontSize: initialThemeRef.current.fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      lineHeight: TERMINAL_LINE_HEIGHT,
      theme: toXtermTheme(initialThemeRef.current),
    })

    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    scheduleTerminalFit(fitAddonRef, fitFrameRef)
    const detachTerminalContextMenu = attachTerminalContextMenu(host, terminal, setTerminalMenu)
    const cachedOutput = localTerminalOutputCache.get(shellSessionId)
    if (cachedOutput) {
      terminal.write(cachedOutput)
    } else {
      const initialOutput = `\x1b[94m${initialTranslateRef.current(title)}\x1b[0m\r\n${initialTranslateRef.current('本地终端已启动。')}\r\n\r\n`
      localTerminalOutputCache.set(shellSessionId, initialOutput)
      terminal.write(initialOutput)
    }

    const recoverLocalTerminal = (reason: unknown) => {
      const pendingRecovery = localTerminalRecoveryRequests.get(shellSessionId)
      if (pendingRecovery) return pendingRecovery

      localTerminalRunningSessions.delete(shellSessionId)
      diag('local-shell', `recovery-start session=${shellSessionId} stale=${isLocalShellStaleError(reason)}`)
      const recovery = (async () => {
        try {
          await invoke('local_shell_stop', { sessionId: shellSessionId }).catch(() => undefined)
          await invoke('local_shell_start', {
            sessionId: shellSessionId,
            cols: terminalRef.current?.cols ?? 120,
            rows: terminalRef.current?.rows ?? 30,
          })
          localTerminalRunningSessions.add(shellSessionId)
          const message = '本地终端已自动恢复，请重新执行 adb shell。'
          const output = `\r\n\x1b[93m${message}\x1b[0m\r\n`
          appendTerminalOutputCache(localTerminalOutputCache, shellSessionId, output)
          terminalRef.current?.write(output)
          window.dispatchEvent(new CustomEvent<string>(LOCAL_TERMINAL_NOTICE_EVENT, { detail: message }))
          diag('local-shell', `recovery-complete session=${shellSessionId}`)
        } catch (error) {
          localTerminalRunningSessions.delete(shellSessionId)
          const message = `本地终端恢复失败：${String(error)}`
          const output = `\r\n\x1b[91m${message}\x1b[0m\r\n`
          appendTerminalOutputCache(localTerminalOutputCache, shellSessionId, output)
          terminalRef.current?.write(output)
          window.dispatchEvent(new CustomEvent<string>(LOCAL_TERMINAL_NOTICE_EVENT, { detail: message }))
          diag('local-shell', `recovery-failed session=${shellSessionId} message=${String(error)}`)
        }
      })()
      localTerminalRecoveryRequests.set(shellSessionId, recovery)
      void recovery.then(() => {
        if (localTerminalRecoveryRequests.get(shellSessionId) === recovery) {
          localTerminalRecoveryRequests.delete(shellSessionId)
        }
      })
      return recovery
    }
    recoverTerminalRef.current = recoverLocalTerminal

    const sendLocalTerminalInput = (data: string) => {
      if (localTerminalRecoveryRequests.has(shellSessionId)) return
      void invoke('local_shell_write', { sessionId: shellSessionId, data }).catch((error) => {
        if (isLocalShellStaleError(error)) {
          void recoverLocalTerminal(error)
          return
        }
        terminal.writeln(`\r\n\x1b[91m写入失败：${String(error)}\x1b[0m`)
      })
    }
    const controller: TerminalController = {
      kind: 'local',
      isReady: () => localTerminalRunningSessions.has(shellSessionId),
      write: async (data) => {
        const pendingRecovery = localTerminalRecoveryRequests.get(shellSessionId)
        if (pendingRecovery) {
          await pendingRecovery
          throw new Error('本地终端连接已恢复，请重新执行命令')
        }
        try {
          await invoke('local_shell_write', { sessionId: shellSessionId, data })
        } catch (error) {
          if (!isLocalShellStaleError(error)) throw error
          await recoverLocalTerminal(error)
          throw new Error('本地终端连接已恢复，请重新执行命令')
        }
      },
      clear: () => terminal.clear(),
      focus: () => {
        terminal.focus()
        terminal.scrollToBottom()
      },
      readText: () => readXtermBuffer(terminal) || getRemoteTerminalPreview(localTerminalOutputCache.get(shellSessionId) ?? ''),
    }
    terminalControllers.set(widgetId, controller)
    terminal.onData(sendLocalTerminalInput)
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      void invoke('local_shell_resize', { sessionId: shellSessionId, cols, rows }).catch(() => undefined)
    })
    const detachTerminalIme = attachTerminalImeShiftCommit(host, terminal, sendLocalTerminalInput)

    const resizeObserver = new ResizeObserver(() => scheduleTerminalFit(fitAddonRef, fitFrameRef))
    resizeObserver.observe(host)

    return () => {
      resizeObserver.disconnect()
      if (writeFrameRef.current !== null) {
        window.cancelAnimationFrame(writeFrameRef.current)
        writeFrameRef.current = null
      }
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      detachTerminalIme()
      detachTerminalContextMenu()
      resizeDisposable.dispose()
      if (terminalControllers.get(widgetId) === controller) terminalControllers.delete(widgetId)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      const stopTimer = window.setTimeout(() => {
        localTerminalStopTimers.delete(shellSessionId)
        const stopSession = () => {
          localTerminalRunningSessions.delete(shellSessionId)
          void invoke('local_shell_stop', { sessionId: shellSessionId })
        }
        const recovery = localTerminalRecoveryRequests.get(shellSessionId)
        if (recovery) void recovery.then(stopSession)
        else stopSession()
      }, 500)
      localTerminalStopTimers.set(shellSessionId, stopTimer)
    }
  }, [title, widgetId])

  useEffect(() => {
    let disposed = false
    const shellSessionId = sessionIdRef.current
    const unlistenTasks = [
      listen<LocalEventPayload>('local:data', (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return
        const data = (event.payload.data ?? '').split('\u007f').join('\b')
        appendTerminalOutputCache(localTerminalOutputCache, sessionIdRef.current, data)
        bufferTerminalWrite(terminalRef, writeQueueRef, writeFrameRef, data)
      }).catch(() => () => undefined),
      listen<LocalEventPayload>('local:error', (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return
        if (isLocalShellStaleError(event.payload.message)) {
          void recoverTerminalRef.current(event.payload.message)
          return
        }
        const data = `\r\n\x1b[91m${event.payload.message ?? 'Local shell error'}\x1b[0m\r\n`
        appendTerminalOutputCache(localTerminalOutputCache, sessionIdRef.current, data)
        terminalRef.current?.write(data)
      }).catch(() => () => undefined),
      listen<LocalEventPayload>('local:closed', (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return
        localTerminalRunningSessions.delete(shellSessionId)
        diag('local-shell', `closed session=${shellSessionId} message=${event.payload.message ?? 'unknown'}`)
        const data = `\r\n\x1b[93m${event.payload.message ?? 'Local shell closed'}\x1b[0m\r\n`
        appendTerminalOutputCache(localTerminalOutputCache, sessionIdRef.current, data)
        terminalRef.current?.write(data)
      }).catch(() => () => undefined),
    ]

    void Promise.all(unlistenTasks).then(() => {
      if (disposed) return
      if (localTerminalRunningSessions.has(shellSessionId)) return
      localTerminalRunningSessions.add(shellSessionId)
      const terminal = terminalRef.current
      void invoke('local_shell_start', {
        sessionId: shellSessionId,
        cols: terminal?.cols ?? 120,
        rows: terminal?.rows ?? 30,
      }).catch((error) => {
        localTerminalRunningSessions.delete(shellSessionId)
        diag('local-shell', `start-failed session=${shellSessionId} message=${String(error)}`)
        const data = `\r\n\x1b[91m启动失败：${String(error)}\x1b[0m\r\n`
        appendTerminalOutputCache(localTerminalOutputCache, shellSessionId, data)
        terminalRef.current?.write(data)
      })
    })

    return () => {
      disposed = true
      void Promise.all(unlistenTasks).then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten())
      })
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.options = {
      fontFamily: terminalTheme.fontFamily,
      fontSize: terminalTheme.fontSize,
      lineHeight: TERMINAL_LINE_HEIGHT,
      theme: toXtermTheme(terminalTheme),
    }
    scheduleTerminalFit(fitAddonRef, fitFrameRef)
  }, [terminalTheme])

  useEffect(() => {
    scheduleTerminalFit(fitAddonRef, fitFrameRef)
  }, [layoutKey])

  useLayoutEffect(() => {
    fitAddonRef.current?.fit()
  }, [layoutKey])

  useEffect(() => {
    let settledFitTimer: number | null = null
    const fitSettledLayout = () => {
      scheduleTerminalFit(fitAddonRef, fitFrameRef)
      if (settledFitTimer !== null) window.clearTimeout(settledFitTimer)
      settledFitTimer = window.setTimeout(() => {
        settledFitTimer = null
        scheduleTerminalFit(fitAddonRef, fitFrameRef)
      }, 120)
    }
    window.addEventListener(WORKBENCH_LAYOUT_SETTLED_EVENT, fitSettledLayout)
    return () => {
      window.removeEventListener(WORKBENCH_LAYOUT_SETTLED_EVENT, fitSettledLayout)
      if (settledFitTimer !== null) window.clearTimeout(settledFitTimer)
    }
  }, [])

  useEffect(() => {
    if (!terminalMenu) return
    function closeMenu(event: globalThis.MouseEvent) {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.context-menu')) setTerminalMenu(null)
    }
    window.addEventListener('mousedown', closeMenu)
    return () => window.removeEventListener('mousedown', closeMenu)
  }, [terminalMenu])

  return (
    <>
      <div className="widget-terminal-host">
        <div ref={terminalHost} className="widget-terminal-canvas" />
      </div>
      {terminalMenu && createPortal(
        <ContextMenu menu={terminalMenu} onClose={() => setTerminalMenu(null)} />,
        document.body,
      )}
    </>
  )
}

interface RemoteTerminalLogState {
  recording: boolean
  path: string
}

const remoteTerminalLogStore = {
  map: new Map<string, RemoteTerminalLogState>(),
  listeners: new Set<() => void>(),
  get(sessionId: string): RemoteTerminalLogState {
    return this.map.get(sessionId) ?? { recording: false, path: '' }
  },
  set(sessionId: string, state: RemoteTerminalLogState) {
    this.map.set(sessionId, state)
    this.emit()
  },
  emit() {
    this.listeners.forEach((listener) => listener())
  },
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  },
}

function formatLogTimestamp(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

const remoteTerminalLogBusy = new Set<string>()

function toggleWidgetSessionLog(sessionId: string, server: ServerProfile | undefined, onToast: (message: string) => void) {
  if (remoteTerminalLogBusy.has(sessionId)) return
  remoteTerminalLogBusy.add(sessionId)
  const finish = () => remoteTerminalLogBusy.delete(sessionId)
  const state = remoteTerminalLogStore.get(sessionId)
  if (state.recording) {
    void invoke('session_log_stop', { sessionId })
      .then(() => {
        remoteTerminalLogStore.set(sessionId, { recording: false, path: '' })
        onToast(`已停止会话日志：${state.path}`)
      })
      .catch((error) => onToast(`停止日志失败：${String(error)}`))
      .finally(finish)
    return
  }
  const host = server?.host || server?.serialPort || 'device'
  const defaultName = `${host}-${formatLogTimestamp(new Date())}.log`
  void invoke<string | null>('choose_log_file', { defaultName })
    .then((fullPath) => {
      if (!fullPath) return null
      const lastSep = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'))
      const dir = lastSep > 0 ? fullPath.slice(0, lastSep) : '.'
      const fileName = lastSep >= 0 ? fullPath.slice(lastSep + 1) : fullPath
      if (!fileName) return null
      const baseName = fileName.toLowerCase().endsWith('.log') ? fileName.slice(0, -4) : fileName
      return invoke<string>('session_log_start', { sessionId, dir, name: baseName })
    })
    .then((path) => {
      if (!path) {
        onToast('会话日志开启失败：未取得日志路径')
        return
      }
      remoteTerminalLogStore.set(sessionId, { recording: true, path })
      onToast(`会话日志已开始保存：${path}`)
    })
    .catch((error) => onToast(`开启日志失败：${String(error)}`))
    .finally(finish)
}

function RemoteTerminalLogButton({ sessionId, server }: { sessionId: string; server?: ServerProfile }) {
  const { t } = useAppLocale()
  const state = useSyncExternalStore(
    (listener) => remoteTerminalLogStore.subscribe(listener),
    () => remoteTerminalLogStore.get(sessionId),
    () => remoteTerminalLogStore.get(sessionId),
  )
  const connected = remoteTerminalConnectedSessions.has(sessionId)
  const busyRef = useRef(false)
  function toggleSessionLog() {
    if (busyRef.current) return
    busyRef.current = true
    if (state.recording) {
      void invoke('session_log_stop', { sessionId })
        .then(() => remoteTerminalLogStore.set(sessionId, { recording: false, path: '' }))
        .catch((error) => console.error('停止日志失败', error))
        .finally(() => {
          busyRef.current = false
        })
    } else {
      void invoke<string | null>('session_log_start', { sessionId, dir: null, name: server?.name ?? 'session' })
        .then((path) => remoteTerminalLogStore.set(sessionId, { recording: true, path: path ?? '' }))
        .catch((error) => console.error('开启日志失败', error))
        .finally(() => {
          busyRef.current = false
        })
    }
  }
  return (
    <button
      className={`widget-action-button ${state.recording ? 'active' : ''}`}
      type="button"
      disabled={!connected}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={toggleSessionLog}
      aria-label={t('保存会话日志')}
      title={connected ? (state.recording ? `正在记录：${state.path}` : t('保存会话日志')) : t('连接后可用')}
    >
      <FileText size={12} />
    </button>
  )
}

function RemoteTerminalWidget({
  widgetId,
  title,
  sessionId,
  server,
  terminalTheme,
  layoutKey,
  focused,
  renderActive = false,
  onActivate,
  onStatus,
}: {
  widgetId: string
  title: string
  sessionId: string
  server?: ServerProfile
  terminalTheme: TerminalThemeSettings
  layoutKey: string
  focused: boolean
  renderActive?: boolean
  onActivate: () => void
  onStatus: (serverId: string, state: ConnectionState, message?: string) => void
}) {
  const { t } = useAppLocale()
  const terminalHost = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglAddonRef = useRef<WebglAddon | null>(null)
  const webglContextLossRef = useRef<{ dispose: () => void } | null>(null)
  const sessionIdRef = useRef(sessionId)
  const onStatusRef = useRef(onStatus)
  const focusedRef = useRef(focused)
  const intentionalCloseRef = useRef(false)
  const eventPrefix = server?.protocol === 'telnet' ? 'telnet' : server?.protocol === 'serial' ? 'serial' : 'ssh'
  const protocolLabel = server?.protocol === 'telnet' ? 'Telnet' : server?.protocol === 'serial' ? 'Serial' : 'SSH'

  function startTerminalSession(targetServer: ServerProfile, size: { cols: number; rows: number }) {
    if (targetServer.protocol === 'telnet') {
      return invoke('telnet_connect', {
        request: {
          sessionId: sessionIdRef.current,
          host: targetServer.host,
          port: targetServer.port,
          cols: size.cols,
          rows: size.rows,
          logEnabled: false,
          logPath: null,
          name: targetServer.name,
        },
      })
    }
    if (targetServer.protocol === 'serial') {
      return invoke('serial_connect', {
        request: {
          sessionId: sessionIdRef.current,
          portName: targetServer.serialPort ?? '',
          baudRate: targetServer.baudRate ?? 9600,
          dataBits: targetServer.dataBits ?? 8,
          stopBits: targetServer.stopBits ?? 1,
          parity: targetServer.parity ?? 'none',
          flowControl: targetServer.flowControl ?? 'none',
          logEnabled: false,
          logPath: null,
          name: targetServer.name,
        },
      })
    }
    return invoke('ssh_connect', {
      sessionId: sessionIdRef.current,
      host: targetServer.host,
      user: targetServer.user,
      password: targetServer.password ?? '',
      authMethod: targetServer.auth,
      privateKeyPath: targetServer.privateKeyPath || null,
      port: targetServer.port,
      cols: size.cols,
      rows: size.rows,
      logEnabled: false,
      logPath: null,
      logName: targetServer.name,
    })
  }

  const outputBacklogRef = useRef(remoteTerminalOutputCache.get(sessionId) ?? '')
  const writeQueueRef = useRef('')
  const writeFrameRef = useRef<number | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  const terminalThemeRef = useRef(terminalTheme)
  const sshStartedRef = useRef(false)
  const inputWriteChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const inputUnavailableNoticeRef = useRef(false)
  const lastRemoteSizeRef = useRef({ cols: 0, rows: 0 })
  const pendingRemoteSizeRef = useRef<{ cols: number; rows: number; reason: string } | null>(null)
  const resizeSyncTimerRef = useRef<number | null>(null)
  const deferredFitTimerRef = useRef<number | null>(null)
  const rendererCreateTimerRef = useRef<number | null>(null)
  const rendererDisposeTimerRef = useRef<number | null>(null)
  const detachTerminalContextMenuRef = useRef<(() => void) | null>(null)
  const detachTerminalImeRef = useRef<(() => void) | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const reconnectAwaitingDataRef = useRef(false)
  const reconnectBlockedRef = useRef(false)
  const [connectionRequested, setConnectionRequested] = useState(() => remoteTerminalManualConnectSessions.has(sessionId))
  const connectionRequestedRef = useRef(connectionRequested)
  const [terminalMenu, setTerminalMenu] = useState<ContextMenuState>(null)
  const [health, setHealth] = useState<SshHealthPayload | null>(null)

  useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])

  function reportRemoteStatus(serverId: string, state: ConnectionState, message?: string) {
    const snapshot = `${serverId}\u0000${state}\u0000${message ?? ''}`
    const currentSessionId = sessionIdRef.current
    if (remoteTerminalStatusCache.get(currentSessionId) === snapshot) return
    remoteTerminalStatusCache.set(currentSessionId, snapshot)
    onStatusRef.current(serverId, state, message)
  }

  useEffect(() => {
    connectionRequestedRef.current = connectionRequested
  }, [connectionRequested])

  useEffect(() => {
    function handleConnectionRequest(event: Event) {
      if ((event as CustomEvent<string>).detail !== sessionIdRef.current) return
      if (!hasConnectionAuthentication(server)) {
        if (server) reportRemoteStatus(server.id, 'error', '设备连接信息不完整')
        return
      }
      intentionalCloseRef.current = false
      reconnectBlockedRef.current = false
      remoteTerminalManualConnectSessions.add(sessionIdRef.current)
      setConnectionRequested(true)
    }

    window.addEventListener(REMOTE_TERMINAL_CONNECT_REQUEST_EVENT, handleConnectionRequest)
    return () => window.removeEventListener(REMOTE_TERMINAL_CONNECT_REQUEST_EVENT, handleConnectionRequest)
  }, [server])

  function requestRemoteConnection() {
    if (!hasConnectionAuthentication(server)) {
      if (server) reportRemoteStatus(server.id, 'error', '设备连接信息不完整')
      return
    }
    intentionalCloseRef.current = false
    reconnectBlockedRef.current = false
    remoteTerminalManualConnectSessions.add(sessionIdRef.current)
    setConnectionRequested(true)
  }

  function clearReconnectTimer() {
    if (reconnectTimerRef.current === null) return
    window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null
  }

  function scheduleRemoteReconnect(message: string) {
    if (server?.protocol && server.protocol !== 'ssh') {
      remoteTerminalConnectingSessions.delete(sessionIdRef.current)
      remoteTerminalConnectedSessions.delete(sessionIdRef.current)
      remoteTerminalLogStore.emit()
      sshStartedRef.current = false
      return
    }
    if (!server || !connectionRequestedRef.current || intentionalCloseRef.current || reconnectBlockedRef.current || reconnectTimerRef.current !== null || !hasConnectionAuthentication(server)) return
    const targetServer = server
    const normalized = message.toLowerCase()
    if (normalized.includes('authentication') || normalized.includes('password auth') || normalized.includes('permission denied')) return

    remoteTerminalConnectedSessions.delete(sessionIdRef.current)
    remoteTerminalConnectingSessions.add(sessionIdRef.current)
    sshStartedRef.current = false
    reconnectAwaitingDataRef.current = false
    const attempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = attempt
    const delay = REMOTE_TERMINAL_RECONNECT_DELAYS_MS[
      Math.min(attempt - 1, REMOTE_TERMINAL_RECONNECT_DELAYS_MS.length - 1)
    ]
    appendRemoteTerminalOutput(`\r\n连接中断，${Math.ceil(delay / 1000)} 秒后自动重连...\r\n`)
    reportRemoteStatus(targetServer.id, 'connecting', `${targetServer.name} 正在自动重连`)

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      if (intentionalCloseRef.current || !hasConnectionAuthentication(targetServer)) return
      const size = getCurrentTerminalSize()
      void startTerminalSession(targetServer, size).catch((error) => scheduleRemoteReconnect(String(error)))
    }, delay)
  }

  function trimRemoteBacklog() {
    if (outputBacklogRef.current.length > REMOTE_TERMINAL_REPLAY_LIMIT) {
      outputBacklogRef.current = outputBacklogRef.current.slice(-REMOTE_TERMINAL_REPLAY_LIMIT)
    }
  }

  function appendRemoteTerminalOutput(data: string) {
    if (!data) return
    outputBacklogRef.current += data
    trimRemoteBacklog()
    remoteTerminalOutputCache.set(sessionIdRef.current, outputBacklogRef.current)
    if (terminalRef.current) {
      bufferTerminalWrite(terminalRef, writeQueueRef, writeFrameRef, data, {
        immediateSmallWrites: true,
      })
    }
  }

  function showRemoteInputUnavailable(message: string) {
    if (inputUnavailableNoticeRef.current) return
    inputUnavailableNoticeRef.current = true
    appendRemoteTerminalOutput(`\r\n${message}\r\n`)
  }

  function queueRemoteTerminalInput(data: string) {
    if (!data || !sshStartedRef.current) return
    const targetSessionId = sessionIdRef.current
    const queuedAt = performance.now()
    inputWriteChainRef.current = inputWriteChainRef.current
      .catch(() => undefined)
      .then(() => {
        if (targetSessionId !== sessionIdRef.current || !sshStartedRef.current) return undefined
        return invoke(`${eventPrefix}_session_write`, { sessionId: targetSessionId, data }).then(() => {
          const elapsed = performance.now() - queuedAt
          if (elapsed > 32) {
            diag('ssh-input', `slow dispatch server=${server?.host ?? 'unknown'} bytes=${data.length} elapsed_ms=${elapsed.toFixed(1)}`)
          }
        })
      })
      .catch((error) => {
        if (targetSessionId !== sessionIdRef.current) return
        sshStartedRef.current = false
        remoteTerminalConnectedSessions.delete(targetSessionId)
        showRemoteInputUnavailable(`写入失败：${String(error)}`)
        if (server) reportRemoteStatus(server.id, 'error', `${protocolLabel} 会话已断开`)
      })
  }

  useEffect(() => {
    const controller: TerminalController = {
      kind: 'ssh',
      isReady: () => sshStartedRef.current,
      write: (data) => {
        if (!sshStartedRef.current) return Promise.reject(new Error('SSH 终端尚未连接'))
        queueRemoteTerminalInput(data)
        return inputWriteChainRef.current.then(() => undefined)
      },
      clear: () => terminalRef.current?.clear(),
      focus: () => {
        terminalRef.current?.focus()
        terminalRef.current?.scrollToBottom()
      },
      readText: () => readXtermBuffer(terminalRef.current) || getRemoteTerminalPreview(outputBacklogRef.current),
    }
    terminalControllers.set(widgetId, controller)
    return () => {
      if (terminalControllers.get(widgetId) === controller) terminalControllers.delete(widgetId)
    }
  }, [widgetId])

  function getCurrentTerminalSize() {
    const terminal = terminalRef.current
    return {
      cols: Math.max(20, terminal?.cols ?? 100),
      rows: Math.max(8, terminal?.rows ?? 30),
    }
  }

  function terminalLayoutBusy() {
    return document.body.classList.contains('widget-drag-active')
      || document.body.classList.contains('native-window-drag-active')
  }

  function flushRemoteTerminalSize() {
    resizeSyncTimerRef.current = null
    if (terminalLayoutBusy()) {
      scheduleRemoteTerminalSizeSync('layout-busy')
      return
    }
    const pending = pendingRemoteSizeRef.current
    if (!pending || !sshStartedRef.current) return
    pendingRemoteSizeRef.current = null
    const previous = lastRemoteSizeRef.current
    if (previous.cols === pending.cols && previous.rows === pending.rows) return

    lastRemoteSizeRef.current = { cols: pending.cols, rows: pending.rows }
    diag('ssh-resize', `server=${server?.host ?? 'unknown'} size=${pending.cols}x${pending.rows} reason=${pending.reason}`)
    const resizeCommand = eventPrefix === 'telnet' ? 'telnet_session_resize' : eventPrefix === 'serial' ? null : 'ssh_resize'
    if (resizeCommand) {
      void invoke(resizeCommand, {
        sessionId: sessionIdRef.current,
        cols: pending.cols,
        rows: pending.rows,
      }).catch((error) => {
        diag('ssh-resize', `error server=${server?.host ?? 'unknown'} reason=${pending.reason} message=${String(error)}`)
      })
    }
  }

  function scheduleRemoteTerminalSizeSync(reason: string) {
    if (!sshStartedRef.current) return
    const terminal = terminalRef.current
    if (!terminal) return
    pendingRemoteSizeRef.current = {
      cols: Math.max(20, terminal.cols),
      rows: Math.max(8, terminal.rows),
      reason,
    }
    if (resizeSyncTimerRef.current !== null) {
      window.clearTimeout(resizeSyncTimerRef.current)
    }
    resizeSyncTimerRef.current = window.setTimeout(
      flushRemoteTerminalSize,
      terminalLayoutBusy() ? REMOTE_TERMINAL_RESIZE_DEBOUNCE_MS * 2 : REMOTE_TERMINAL_RESIZE_DEBOUNCE_MS,
    )
  }

  function syncRemoteTerminalSize(reason: string) {
    scheduleRemoteTerminalSizeSync(reason)
  }

  function fitRemoteTerminal(reason: string) {
    if (terminalLayoutBusy()) {
      if (deferredFitTimerRef.current !== null) window.clearTimeout(deferredFitTimerRef.current)
      deferredFitTimerRef.current = window.setTimeout(() => {
        deferredFitTimerRef.current = null
        fitRemoteTerminal(`${reason}:deferred`)
      }, REMOTE_TERMINAL_RESIZE_DEBOUNCE_MS * 2)
      return
    }
    scheduleTerminalFit(fitAddonRef, fitFrameRef, () => {
      syncRemoteTerminalSize(reason)
      scheduleTerminalScrollToBottom(terminalRef)
    })
  }

  function fitRemoteTerminalNow(reason: string, sync = true) {
    scheduleTerminalFit(fitAddonRef, fitFrameRef, () => {
      if (sync) syncRemoteTerminalSize(reason)
      scheduleTerminalScrollToBottom(terminalRef)
    })
  }

  function disposeRemoteRenderer() {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    detachTerminalContextMenuRef.current?.()
    detachTerminalContextMenuRef.current = null
    detachTerminalImeRef.current?.()
    detachTerminalImeRef.current = null
    if (writeFrameRef.current !== null) {
      window.cancelAnimationFrame(writeFrameRef.current)
      writeFrameRef.current = null
    }
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current)
      fitFrameRef.current = null
    }
    if (resizeSyncTimerRef.current !== null) {
      window.clearTimeout(resizeSyncTimerRef.current)
      resizeSyncTimerRef.current = null
    }
    if (deferredFitTimerRef.current !== null) {
      window.clearTimeout(deferredFitTimerRef.current)
      deferredFitTimerRef.current = null
    }
    pendingRemoteSizeRef.current = null
    writeQueueRef.current = ''
    webglContextLossRef.current?.dispose()
    webglContextLossRef.current = null
    webglAddonRef.current?.dispose()
    webglAddonRef.current = null
    terminalRef.current?.dispose()
    terminalRef.current = null
    fitAddonRef.current = null
  }

  function cancelRemoteRendererDispose() {
    if (rendererDisposeTimerRef.current === null) return
    window.clearTimeout(rendererDisposeTimerRef.current)
    rendererDisposeTimerRef.current = null
  }

  function scheduleRemoteRendererDispose() {
    if (rendererDisposeTimerRef.current !== null) return
    rendererDisposeTimerRef.current = window.setTimeout(() => {
      rendererDisposeTimerRef.current = null
      disposeRemoteRenderer()
    }, 0)
  }

  function cancelRemoteRendererCreate() {
    if (rendererCreateTimerRef.current === null) return
    window.clearTimeout(rendererCreateTimerRef.current)
    rendererCreateTimerRef.current = null
  }

  function scheduleRemoteRendererCreate() {
    cancelRemoteRendererDispose()
    if (terminalRef.current || rendererCreateTimerRef.current !== null) return
    rendererCreateTimerRef.current = window.setTimeout(() => {
      rendererCreateTimerRef.current = null
      createRemoteRenderer()
    }, 180)
  }

  function createRemoteRenderer() {
    cancelRemoteRendererDispose()
    if (!terminalHost.current || terminalRef.current) return
    const host = terminalHost.current
    const fitAddon = new FitAddon()
    const theme = terminalThemeRef.current
    const terminal = new XTerm({
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      cursorWidth: 2,
      customGlyphs: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 4.5,
      rescaleOverlappingGlyphs: false,
      scrollOnUserInput: true,
      scrollSensitivity: 2,
      fastScrollSensitivity: 5,
      scrollback: 10000,
      smoothScrollDuration: 0,
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      lineHeight: TERMINAL_LINE_HEIGHT,
      theme: toXtermTheme(theme),
    })

    terminal.loadAddon(fitAddon)
    if (ENABLE_REMOTE_XTERM_WEBGL) try {
      const webglAddon = new WebglAddon()
      webglContextLossRef.current = webglAddon.onContextLoss(() => {
        diag('xterm-webgl', `context lost server=${server?.host ?? 'unknown'} fallback=dom`)
        webglContextLossRef.current?.dispose()
        webglContextLossRef.current = null
        webglAddonRef.current = null
      })
      terminal.loadAddon(webglAddon)
      webglAddonRef.current = webglAddon
      diag('xterm-webgl', `enabled server=${server?.host ?? 'unknown'}`)
    } catch (error) {
      diag('xterm-webgl', `fallback dom server=${server?.host ?? 'unknown'} error=${String(error)}`)
    } else {
      diag('xterm-webgl', `disabled server=${server?.host ?? 'unknown'}`)
    }
    terminal.open(host)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    fitRemoteTerminal('create')
    detachTerminalContextMenuRef.current = attachTerminalContextMenu(host, terminal, setTerminalMenu)

    const sendRemoteTerminalInput = (data: string) => {
      if (writeQueueRef.current.length > REMOTE_TERMINAL_INPUT_QUEUE_KEEP * 2) {
        diag('xterm-input', `trim queued output before input server=${server?.host ?? 'unknown'} before=${writeQueueRef.current.length}`)
        writeQueueRef.current = writeQueueRef.current.slice(-REMOTE_TERMINAL_INPUT_QUEUE_KEEP)
      }
      if (!sshStartedRef.current) {
        if (!remoteTerminalConnectingSessions.has(sessionIdRef.current)) {
          showRemoteInputUnavailable(`${protocolLabel} 会话已断开，请刷新窗口后重连。`)
        }
        return
      }
      queueRemoteTerminalInput(data)
    }
    terminal.onData(sendRemoteTerminalInput)
    detachTerminalImeRef.current = attachTerminalImeShiftCommit(host, terminal, sendRemoteTerminalInput)

    const resizeObserver = new ResizeObserver(() => fitRemoteTerminal('observer'))
    resizeObserver.observe(host)
    resizeObserverRef.current = resizeObserver
    if (outputBacklogRef.current) {
      bufferTerminalWrite(terminalRef, writeQueueRef, writeFrameRef, outputBacklogRef.current, {
        chunkSize: 32 * 1024,
      })
    }
    window.setTimeout(() => {
      if (focusedRef.current) terminal.focus()
      fitRemoteTerminal('create-timeout')
    }, 0)
  }

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true
      clearReconnectTimer()
      cancelRemoteRendererCreate()
      scheduleRemoteRendererDispose()
    }
  }, [])

  useEffect(() => {
    focusedRef.current = focused
    if (connectionRequested && (focused || renderActive)) {
      scheduleRemoteRendererCreate()
    }
    if (focused) {
      window.setTimeout(() => {
        terminalRef.current?.focus()
        fitRemoteTerminal('focus')
      }, 0)
    }
    if (!connectionRequested || (!focused && !renderActive)) {
      cancelRemoteRendererCreate()
      cancelRemoteRendererDispose()
      disposeRemoteRenderer()
    }
  }, [connectionRequested, focused, renderActive])

  useEffect(() => {
    terminalThemeRef.current = terminalTheme
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.options = {
      fontFamily: terminalTheme.fontFamily,
      fontSize: terminalTheme.fontSize,
      lineHeight: TERMINAL_LINE_HEIGHT,
      theme: toXtermTheme(terminalTheme),
    }
    fitRemoteTerminal('theme')
  }, [terminalTheme])

  useEffect(() => {
    fitRemoteTerminal('layout')
  }, [layoutKey])

  useLayoutEffect(() => {
    fitAddonRef.current?.fit()
  }, [layoutKey])

  useEffect(() => {
    let settledFitTimer: number | null = null
    const fitSettledLayout = () => {
      fitRemoteTerminal('layout-settled')
      if (settledFitTimer !== null) window.clearTimeout(settledFitTimer)
      settledFitTimer = window.setTimeout(() => {
        settledFitTimer = null
        fitRemoteTerminal('layout-settled:verify')
      }, 120)
    }
    window.addEventListener(WORKBENCH_LAYOUT_SETTLED_EVENT, fitSettledLayout)
    return () => {
      window.removeEventListener(WORKBENCH_LAYOUT_SETTLED_EVENT, fitSettledLayout)
      if (settledFitTimer !== null) window.clearTimeout(settledFitTimer)
    }
  }, [])

  useEffect(() => {
    const sshSessionId = sessionIdRef.current
    intentionalCloseRef.current = false

    if (!connectionRequested) {
      sshStartedRef.current = false
      if (server) reportRemoteStatus(server.id, 'ready', `${server.name} 等待连接`)
      return undefined
    }

    if (!server) {
      appendRemoteTerminalOutput('服务器配置不存在，请重新添加。\r\n')
      return undefined
    }

    if (!hasConnectionAuthentication(server)) {
      appendRemoteTerminalOutput('该设备的连接信息不完整，请先编辑设备配置。\r\n')
      reportRemoteStatus(server.id, 'error', '设备缺少连接信息')
      return undefined
    }

    if (
      remoteTerminalConnectedSessions.has(sshSessionId)
      || remoteTerminalConnectingSessions.has(sshSessionId)
    ) {
      diag('ssh-session', `reuse session=${sshSessionId} server=${server.host}`)
      sshStartedRef.current = remoteTerminalConnectedSessions.has(sshSessionId)
      inputUnavailableNoticeRef.current = false
      lastRemoteSizeRef.current = { cols: 0, rows: 0 }
      fitRemoteTerminalNow('reuse-session', sshStartedRef.current)
      reportRemoteStatus(
        server.id,
        sshStartedRef.current ? 'connected' : 'connecting',
        sshStartedRef.current ? `${server.name} 已连接` : `${server.name} 正在连接`,
      )
      return undefined
    }

    outputBacklogRef.current = ''
    remoteTerminalOutputCache.delete(sshSessionId)
    writeQueueRef.current = ''
    inputUnavailableNoticeRef.current = false
    reconnectBlockedRef.current = false
    reconnectAttemptRef.current = 0
    sshStartedRef.current = false
    lastRemoteSizeRef.current = { cols: 0, rows: 0 }
    terminalRef.current?.reset()
    fitRemoteTerminalNow('before-connect', false)
    const initialTerminalSize = getCurrentTerminalSize()
    appendRemoteTerminalOutput(`${title}\r\n正在连接 ${server.protocol === 'serial' ? (server.serialPort ?? '') : `${server.host}:${server.port}`} ...\r\n\r\n`)
    reportRemoteStatus(server.id, 'connecting', `${server.name} 正在连接`)
    remoteTerminalConnectingSessions.add(sshSessionId)

    void startTerminalSession(server, initialTerminalSize)
      .then(() => {
        reportRemoteStatus(server.id, 'connecting', `${server.name} 正在连接`)
      })
      .catch((error) => {
        remoteTerminalConnectingSessions.delete(sshSessionId)
        remoteTerminalConnectedSessions.delete(sshSessionId)
        sshStartedRef.current = false
        appendRemoteTerminalOutput(`\r\n${protocolLabel} 连接失败：${String(error)}\r\n`)
        reportRemoteStatus(server.id, 'error', `${protocolLabel} 失败：${String(error)}`)
      })

    return () => {
      sshStartedRef.current = false
      if (writeFrameRef.current !== null) window.cancelAnimationFrame(writeFrameRef.current)
    }
  }, [connectionRequested, server?.id, title, sessionId])

  useEffect(() => {
    const unlistenTasks = [
      listen<SshEventPayload>(`${eventPrefix}:connected`, (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return
        diag('ssh-event', `connected server=${server?.host ?? 'unknown'} session=${sessionIdRef.current}`)
        remoteTerminalConnectingSessions.delete(sessionIdRef.current)
        remoteTerminalConnectedSessions.add(sessionIdRef.current)
        remoteTerminalLogStore.emit()
        clearReconnectTimer()
        sshStartedRef.current = true
        reconnectAwaitingDataRef.current = reconnectAttemptRef.current > 0
        inputUnavailableNoticeRef.current = false
        setHealth((current) => current ?? {
          session_id: sessionIdRef.current,
          connected: true,
          idle_ms: 0,
          write_idle_ms: 0,
          connected_ms: 0,
          total_read: 0,
          total_written: 0,
        })
        fitRemoteTerminal('connected')
        appendRemoteTerminalOutput(`\r\n[${protocolLabel} 已连接] 等待设备输出...\r\n`)
        if (server) reportRemoteStatus(server.id, 'connected', `${server.name} 已连接`)
      }).catch(() => () => undefined),
      listen<SshEventPayload>(`${eventPrefix}:data`, (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return
        const data = event.payload.data ?? ''
        if (data && reconnectAwaitingDataRef.current) {
          reconnectAwaitingDataRef.current = false
          reconnectAttemptRef.current = 0
          reconnectBlockedRef.current = false
          appendRemoteTerminalOutput('\r\nSSH 已自动重连。\r\n')
          if (server) reportRemoteStatus(server.id, 'connected', `${server.name} 已重新连接`)
        }
        if (data.length > 32 * 1024) {
          diag('ssh-event', `data server=${server?.host ?? 'unknown'} bytes=${data.length} focused=${focusedRef.current}`)
        }
        appendRemoteTerminalOutput(data)
      }).catch(() => () => undefined),
      listen<SshHealthPayload>(`${eventPrefix}:health`, (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return
        setHealth(event.payload)
        if (event.payload.connected && event.payload.connected_ms >= 30_000) {
          reconnectAttemptRef.current = 0
        }
        if (!event.payload.connected) {
          remoteTerminalConnectedSessions.delete(sessionIdRef.current)
          sshStartedRef.current = false
        }
      }).catch(() => () => undefined),
      listen<SshEventPayload>(`${eventPrefix}:error`, (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return
        const message = event.payload.message ?? `${protocolLabel} error`
        diag('ssh-event', `error server=${server?.host ?? 'unknown'} message=${message}`)
        if (message.toLowerCase().includes('resize')) return
        if (/authentication|password auth|permission denied/i.test(message)) reconnectBlockedRef.current = true
        remoteTerminalConnectingSessions.delete(sessionIdRef.current)
        remoteTerminalConnectedSessions.delete(sessionIdRef.current)
        remoteTerminalLogStore.emit()
        setHealth((current) => current ? { ...current, connected: false } : null)
        inputUnavailableNoticeRef.current = true
        appendRemoteTerminalOutput(`\r\n${message}\r\n`)
        if (server) reportRemoteStatus(server.id, 'error', message)
        scheduleRemoteReconnect(message)
      }).catch(() => () => undefined),
      listen<SshEventPayload>(`${eventPrefix}:closed`, (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return
        diag('ssh-event', `closed server=${server?.host ?? 'unknown'} intentional=${intentionalCloseRef.current}`)
        remoteTerminalConnectingSessions.delete(sessionIdRef.current)
        remoteTerminalConnectedSessions.delete(sessionIdRef.current)
        remoteTerminalLogStore.emit()
        sshStartedRef.current = false
        setHealth((current) => current ? { ...current, connected: false } : null)
        inputUnavailableNoticeRef.current = true
        if (intentionalCloseRef.current) return
        const message = event.payload.message ?? `${protocolLabel} 会话已关闭`
        appendRemoteTerminalOutput(`\r\n${message}\r\n`)
        if (server) reportRemoteStatus(server.id, 'ready', `${protocolLabel} 会话已关闭`)
        scheduleRemoteReconnect(message)
      }).catch(() => () => undefined),
    ]

    return () => {
      void Promise.all(unlistenTasks).then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten())
      })
    }
  }, [server])

  useEffect(() => {
    if (!hasConnectionAuthentication(server)) return
    const timer = window.setInterval(() => {
      if (intentionalCloseRef.current || !sshStartedRef.current || reconnectTimerRef.current !== null) return
      void invoke<SshHealthPayload>(`${eventPrefix}_session_health`, { sessionId: sessionIdRef.current })
        .then((payload) => {
          setHealth(payload)
          if (!payload.connected) scheduleRemoteReconnect(`${protocolLabel} health check reported a closed session`)
        })
        .catch((error) => scheduleRemoteReconnect(`${protocolLabel} health check failed: ${String(error)}`))
    }, 8000)
    return () => window.clearInterval(timer)
  }, [server])

  useEffect(() => {
    if (!focused) return
    fitRemoteTerminal('focused-effect')
  }, [focused])

  useEffect(() => {
    if (!terminalMenu) return
    function closeMenu(event: globalThis.MouseEvent) {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.context-menu')) setTerminalMenu(null)
    }
    window.addEventListener('mousedown', closeMenu)
    return () => window.removeEventListener('mousedown', closeMenu)
  }, [terminalMenu])

  if (!connectionRequested) {
    return (
      <div className="terminal-standby-host">
        <span className="terminal-standby-icon"><Terminal size={22} /></span>
        <strong>{t(`${protocolLabel} 终端待命`)}</strong>
        <span>{server ? (server.protocol === 'serial' ? (server.serialPort ?? '') : `${server.host}:${server.port}`) : t('设备配置缺失')}</span>
        <button type="button" onClick={requestRemoteConnection} disabled={!hasConnectionAuthentication(server)}>
          <Wifi size={14} />
          {t(`连接 ${protocolLabel}`)}
        </button>
        {server && !hasConnectionAuthentication(server) && <em>{t('请先在设备配置中补全连接信息')}</em>}
      </div>
    )
  }

  if (!focused && !renderActive) {
    return (
      <button className="terminal-sleep-host" type="button" onClick={onActivate}>
        <strong>{server?.name || title}</strong>
        <span>{server ? (server.protocol === 'serial' ? (server.serialPort ?? '') : `${server.host}:${server.port}`) : '设备配置缺失'}</span>
        <em>{t(formatSshHealth(health))}</em>
        <code>{t(getRemoteTerminalPreview(outputBacklogRef.current))}</code>
      </button>
    )
  }

  return (
    <>
      <div
        className="remote-terminal-render-shell"
        onPointerDown={onActivate}
        style={{
          color: terminalTheme.foreground,
        }}
      >
        <div className="widget-terminal-host">
          <div
            ref={terminalHost}
            className="widget-terminal-canvas remote-xterm-host"
          />
        </div>
        <span className={`terminal-health-badge ${health?.connected === false ? 'error' : ''}`}>
          {t(formatSshHealth(health))}
        </span>
      </div>
      {terminalMenu && createPortal(
        <ContextMenu menu={terminalMenu} onClose={() => setTerminalMenu(null)} />,
        document.body,
      )}
    </>
  )
}

/* Legacy guacd preview retained only as reference for persisted-data migration.
type RemoteDesktopStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

function createLegacyRemoteDesktopConnection(): LegacyRemoteDesktopConnection {
  return {
    protocol: 'rdp',
    host: '',
    port: 3389,
    username: '',
    password: '',
    domain: '',
    security: 'any',
    ignoreCertificate: false,
    viewOnly: false,
    guacdHost: '127.0.0.1',
    guacdPort: 4822,
  }
}

function LegacyRemoteDesktopWidget({
  widgetId,
  sessionId,
  connection,
  active,
  onSaveConnection,
  onStatusChange,
}: {
  widgetId: string
  sessionId: string
  connection?: LegacyRemoteDesktopConnection
  active: boolean
  onSaveConnection: (connection: LegacyRemoteDesktopConnection) => void
  onStatusChange: (state: ConnectionState) => void
}) {
  const { t, systemTimeZone } = useAppLocale()
  const [draft, setDraft] = useState<LegacyRemoteDesktopConnection>(() => connection ?? createLegacyRemoteDesktopConnection())
  const [editing, setEditing] = useState(!connection)
  const [status, setStatus] = useState<RemoteDesktopStatus>('disconnected')
  const [message, setMessage] = useState('')
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const displayHostRef = useRef<HTMLDivElement | null>(null)
  const clientRef = useRef<any>(null)
  const tunnelRef = useRef<GuacamoleTunnelHandle | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const generationRef = useRef(0)
  const remoteClipboardRef = useRef('')
  const connectRef = useRef<((candidate?: LegacyRemoteDesktopConnection) => Promise<void>) | null>(null)

  useEffect(() => {
    if (!connection) return
    setDraft(connection)
  }, [connection])

  useEffect(() => () => {
    generationRef.current += 1
    cleanupRef.current?.()
    cleanupRef.current = null
  }, [])

  useEffect(() => {
    if (!connection || !remoteDesktopAutoConnectWidgets.has(widgetId)) return
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => void connectRef.current?.(connection))
      cleanupRef.current = cleanupRef.current ?? (() => window.cancelAnimationFrame(secondFrame))
    })
    return () => window.cancelAnimationFrame(firstFrame)
  }, [connection, sessionId, widgetId])

  const normalizedDraft = (): LegacyRemoteDesktopConnection | null => {
    const host = draft.host.trim()
    const guacdHost = draft.guacdHost.trim()
    const port = Math.round(Number(draft.port))
    const guacdPort = Math.round(Number(draft.guacdPort))
    if (!host || !guacdHost || port < 1 || port > 65535 || guacdPort < 1 || guacdPort > 65535) {
      setMessage(t('请检查远程主机和 guacd 地址'))
      return null
    }
    return {
      ...draft,
      host,
      guacdHost,
      port,
      guacdPort,
      username: draft.username.trim(),
      domain: draft.domain.trim(),
    }
  }

  const disconnect = (nextMessage = '', manual = false) => {
    if (manual) remoteDesktopAutoConnectWidgets.delete(widgetId)
    generationRef.current += 1
    cleanupRef.current?.()
    cleanupRef.current = null
    clientRef.current = null
    tunnelRef.current = null
    setStatus('disconnected')
    onStatusChange('ready')
    setMessage(nextMessage)
  }

  const connect = async (candidate?: LegacyRemoteDesktopConnection) => {
    const nextConnection = candidate ?? normalizedDraft()
    if (!nextConnection) return
    onSaveConnection(nextConnection)
    setDraft(nextConnection)
    setEditing(false)
    disconnect()
    const generation = ++generationRef.current
    const viewport = viewportRef.current
    const displayHost = displayHostRef.current
    if (!viewport || !displayHost) {
      setStatus('error')
      onStatusChange('error')
      setMessage(t('远程桌面画布尚未就绪'))
      return
    }

    displayHost.replaceChildren()
    setStatus('connecting')
    onStatusChange('connecting')
    setMessage(t('正在连接 guacd'))
    const width = Math.max(320, Math.floor(viewport.clientWidth))
    const height = Math.max(200, Math.floor(viewport.clientHeight))

    let tunnelHandle: GuacamoleTunnelHandle
    try {
      tunnelHandle = await createTauriGuacamoleTunnel({
        sessionId,
        connection: nextConnection,
        width,
        height,
        dpi: Math.round(96 * Math.max(1, window.devicePixelRatio || 1)),
        timezone: systemTimeZone,
        onStatus: (nextStatus, nextMessage) => {
          if (generationRef.current !== generation) return
          if (nextStatus === 'connected') remoteDesktopAutoConnectWidgets.add(widgetId)
          setStatus(nextStatus)
          onStatusChange(nextStatus === 'disconnected' ? 'ready' : nextStatus)
          setMessage(nextMessage ?? '')
        },
      })
    } catch (error) {
      setStatus('error')
      onStatusChange('error')
      setMessage(String(error))
      return
    }
    if (generationRef.current !== generation) {
      tunnelHandle.dispose()
      return
    }

    const client = new Guacamole.Client(tunnelHandle.tunnel)
    const display = client.getDisplay()
    const displayElement = display.getElement() as HTMLElement
    displayElement.tabIndex = 0
    displayElement.setAttribute('aria-label', t('远程桌面画面'))
    displayHost.appendChild(displayElement)
    clientRef.current = client
    tunnelRef.current = tunnelHandle

    const fitDisplay = () => {
      const remoteWidth = Math.max(1, display.getWidth())
      const remoteHeight = Math.max(1, display.getHeight())
      const scale = Math.min(
        displayHost.clientWidth / remoteWidth,
        displayHost.clientHeight / remoteHeight,
      )
      display.scale(Number.isFinite(scale) && scale > 0 ? scale : 1)
    }

    let resizeTimer: number | null = null
    const resizeObserver = new ResizeObserver(() => {
      fitDisplay()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        if (generationRef.current !== generation || !clientRef.current) return
        client.sendSize(
          Math.max(320, Math.floor(viewport.clientWidth)),
          Math.max(200, Math.floor(viewport.clientHeight)),
        )
      }, 180)
    })
    resizeObserver.observe(viewport)
    display.onresize = fitDisplay

    const mouse = new Guacamole.Mouse(displayElement)
    mouse.onEach(['mousedown', 'mousemove', 'mouseup'], (event: any) => {
      if (!nextConnection.viewOnly) client.sendMouseState(event.state, true)
      displayElement.focus({ preventScroll: true })
    })
    const keyboard = new Guacamole.Keyboard(displayElement)
    keyboard.onkeydown = (keysym: number) => {
      if (!nextConnection.viewOnly) client.sendKeyEvent(1, keysym)
      return false
    }
    keyboard.onkeyup = (keysym: number) => {
      if (!nextConnection.viewOnly) client.sendKeyEvent(0, keysym)
      return false
    }
    client.onclipboard = (stream: any, mimetype: string) => {
      if (!mimetype.startsWith('text/')) return
      const reader = new Guacamole.StringReader(stream)
      let text = ''
      reader.ontext = (chunk: string) => { text += chunk }
      reader.onend = () => {
        remoteClipboardRef.current = text
        void navigator.clipboard.writeText(text).catch(() => undefined)
        setMessage(t('远程剪贴板已接收'))
      }
    }
    client.onerror = (error: { message?: string; code?: number }) => {
      if (generationRef.current !== generation) return
      setStatus('error')
      onStatusChange('error')
      setMessage(error.message || `${t('远程桌面错误')} ${error.code ?? ''}`.trim())
    }

    const preventContextMenu = (event: Event) => event.preventDefault()
    displayElement.addEventListener('contextmenu', preventContextMenu)
    cleanupRef.current = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      keyboard.reset?.()
      keyboard.onkeydown = null
      keyboard.onkeyup = null
      displayElement.removeEventListener('contextmenu', preventContextMenu)
      try { client.disconnect() } catch {}
      tunnelHandle.dispose()
      displayHost.replaceChildren()
    }

    client.connect()
    fitDisplay()
  }
  connectRef.current = connect

  const syncClipboard = async () => {
    const client = clientRef.current
    if (!client || status !== 'connected') return
    try {
      const text = await navigator.clipboard.readText()
      const writer = new Guacamole.StringWriter(client.createClipboardStream('text/plain'))
      writer.sendText(text)
      writer.sendEnd()
      setMessage(t('本地剪贴板已发送'))
    } catch (error) {
      setMessage(`${t('剪贴板同步失败')}：${String(error)}`)
    }
  }

  const sendCtrlAltDelete = () => {
    const client = clientRef.current
    if (!client || status !== 'connected' || draft.viewOnly) return
    const keys = [0xffe3, 0xffe9, 0xffff]
    keys.forEach((keysym) => client.sendKeyEvent(1, keysym))
    keys.reverse().forEach((keysym) => client.sendKeyEvent(0, keysym))
  }

  if (editing) {
    return (
      <form
        className="remote-desktop-form"
        data-remote-desktop-widget-id={widgetId}
        onSubmit={(event) => {
          event.preventDefault()
          const normalized = normalizedDraft()
          if (!normalized) return
          onSaveConnection(normalized)
          setDraft(normalized)
          setEditing(false)
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => void connectRef.current?.(normalized))
          })
        }}
      >
        <div className="remote-desktop-protocol" role="group" aria-label={t('远程桌面协议')}>
          {(['rdp', 'vnc'] as const).map((protocol) => (
            <button
              className={draft.protocol === protocol ? 'active' : ''}
              type="button"
              onClick={() => setDraft((current) => ({
                ...current,
                protocol,
                port: protocol === 'rdp' ? 3389 : 5900,
              }))}
              key={protocol}
            >
              {protocol.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="remote-desktop-fields">
          <label><span>{t('主机')}</span><input autoFocus value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="192.168.1.20" /></label>
          <label><span>{t('端口')}</span><input type="number" min="1" max="65535" value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></label>
          <label><span>{t('用户名')}</span><input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} autoComplete="username" /></label>
          <label><span>{t('密码')}</span><input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} autoComplete="current-password" /></label>
          {draft.protocol === 'rdp' && <label><span>{t('域')}</span><input value={draft.domain} onChange={(event) => setDraft({ ...draft, domain: event.target.value })} /></label>}
        </div>
        <details className="remote-desktop-advanced">
          <summary>{t('网关与安全')}</summary>
          <div className="remote-desktop-fields">
            <label><span>guacd</span><input value={draft.guacdHost} onChange={(event) => setDraft({ ...draft, guacdHost: event.target.value })} /></label>
            <label><span>{t('网关端口')}</span><input type="number" min="1" max="65535" value={draft.guacdPort} onChange={(event) => setDraft({ ...draft, guacdPort: Number(event.target.value) })} /></label>
            {draft.protocol === 'rdp' && (
              <label><span>{t('安全模式')}</span><select value={draft.security} onChange={(event) => setDraft({ ...draft, security: event.target.value as LegacyRemoteDesktopConnection['security'] })}><option value="any">Auto</option><option value="nla">NLA</option><option value="tls">TLS</option><option value="rdp">RDP</option></select></label>
            )}
          </div>
          <label className="remote-desktop-check"><input type="checkbox" checked={draft.ignoreCertificate} onChange={(event) => setDraft({ ...draft, ignoreCertificate: event.target.checked })} />{t('忽略远程证书错误')}</label>
          <label className="remote-desktop-check"><input type="checkbox" checked={draft.viewOnly} onChange={(event) => setDraft({ ...draft, viewOnly: event.target.checked })} />{t('只看模式')}</label>
        </details>
        {message && <p className="remote-desktop-form-message">{message}</p>}
        <div className="remote-desktop-form-actions">
          {connection && <button type="button" onClick={() => setEditing(false)}>{t('取消')}</button>}
          <button className="primary" type="submit"><Monitor size={14} />{t('保存并连接')}</button>
        </div>
      </form>
    )
  }

  return (
    <div className={`remote-desktop-shell ${active ? 'active' : ''}`} data-status={status} data-remote-desktop-widget-id={widgetId}>
      <div className="remote-desktop-controls">
        <span className={`connection-dot ${status === 'connected' ? 'connected' : status === 'error' ? 'error' : status === 'connecting' ? 'connecting' : 'ready'}`} />
        <strong>{draft.protocol.toUpperCase()}</strong>
        <span>{draft.host}:{draft.port}</span>
        <button type="button" onClick={() => void syncClipboard()} disabled={status !== 'connected'} title={t('同步本地剪贴板')}><ClipboardList size={13} /></button>
        <button type="button" onClick={sendCtrlAltDelete} disabled={status !== 'connected' || draft.viewOnly} title="Ctrl+Alt+Del"><KeyRound size={13} /></button>
        <button type="button" onClick={() => { disconnect('', true); setEditing(true) }} title={t('编辑连接')}><Edit3 size={13} /></button>
        {status === 'connected' || status === 'connecting'
          ? <button type="button" onClick={() => disconnect(t('已断开远程桌面'), true)} title={t('断开')}><Wifi size={13} /></button>
          : <button type="button" onClick={() => void connect(draft)} title={t('连接')}><Monitor size={13} /></button>}
      </div>
      <div className="remote-desktop-viewport" ref={viewportRef}>
        <div className="remote-desktop-display" ref={displayHostRef} />
        {status !== 'connected' && (
          <div className={`remote-desktop-status ${status}`}>
            <Monitor size={24} />
            <strong>{status === 'connecting' ? t('正在连接') : status === 'error' ? t('连接失败') : t('远程桌面')}</strong>
            {message && <span>{message}</span>}
          </div>
        )}
      </div>
      {status === 'connected' && message && <span className="remote-desktop-message">{message}</span>}
    </div>
  )
}

void LegacyRemoteDesktopWidget
*/

type AuxConnectionPickerProps = {
  server?: ServerProfile
  servers: ServerProfile[]
  onSelectConnection: (serverId?: string) => void
  onSaveConnection: (draft: ServerDraft) => void
  onEditConnections: () => void
}

function parseQuickConnection(value: string) {
  const normalized = value.trim().replace(/^ssh:\/\//i, '')
  if (!normalized || /\s/.test(normalized)) return null
  const match = normalized.match(/^(?:([^@:\s]+)@)?([^:\s]+)(?::(\d{1,5}))?$/)
  if (!match) return null
  const port = match[3] ? Number(match[3]) : 22
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null
  return {
    user: match[1] || 'root',
    host: match[2],
    port,
  }
}

function AuxConnectionPicker({
  server,
  servers,
  onSelectConnection,
  onSaveConnection,
  onEditConnections,
}: AuxConnectionPickerProps) {
  const { t } = useAppLocale()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [credentialDraft, setCredentialDraft] = useState<ServerDraft | null>(null)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredServers = useMemo(() => {
    if (!normalizedQuery) return servers
    return servers.filter((item) =>
      [item.name, item.host, item.user, `${item.user}@${item.host}`, `${item.user}@${item.host}:${item.port}`]
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    )
  }, [normalizedQuery, servers])

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 16)
    const estimatedHeight = credentialDraft ? 250 : Math.min(430, window.innerHeight - 24)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    const belowTop = rect.bottom + 7
    const top = belowTop + estimatedHeight <= window.innerHeight - 8
      ? belowTop
      : Math.max(8, rect.top - estimatedHeight - 7)
    setPosition({ left, top })
  }, [credentialDraft])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const reposition = () => updatePosition()
    document.addEventListener('pointerdown', closeOnOutside, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, updatePosition])

  function closePicker() {
    setOpen(false)
    setQuery('')
    setCredentialDraft(null)
  }

  function selectLocal() {
    onSelectConnection(undefined)
    closePicker()
  }

  function selectServer(nextServer: ServerProfile) {
    if (!nextServer.password) {
      setCredentialDraft({ ...nextServer })
      return
    }
    onSelectConnection(nextServer.id)
    closePicker()
  }

  function beginQuickConnection() {
    const exactServer = servers.find((item) => {
      const address = `${item.user}@${item.host}`.toLowerCase()
      const addressWithPort = `${address}:${item.port}`
      return normalizedQuery === item.name.toLowerCase()
        || normalizedQuery === item.host.toLowerCase()
        || normalizedQuery === address
        || normalizedQuery === addressWithPort
    })
    if (exactServer) {
      selectServer(exactServer)
      return
    }
    const target = parseQuickConnection(query)
    if (!target) {
      if (filteredServers[0]) selectServer(filteredServers[0])
      return
    }
    setCredentialDraft({
      name: target.host,
      host: target.host,
      user: target.user,
      port: target.port,
      group: 'Quick Connect',
      auth: 'Password',
      password: '',
    })
  }

  function saveQuickConnection() {
    if (!credentialDraft?.password) return
    onSaveConnection(credentialDraft)
    closePicker()
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={`aux-connection-trigger ${server ? 'remote' : 'local'}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
        title={t(server ? `连接：${server.user}@${server.host}` : '连接：本地计算机')}
      >
        {server ? <Server size={13} /> : <HardDrive size={13} />}
        <span>{server ? `${server.user}@${server.host}` : t('本地')}</span>
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={popoverRef}
              className="aux-connection-popover"
              style={{ left: position.left, top: position.top }}
              initial={{ opacity: 0, y: -5, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -3, scale: 0.99 }}
              transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {!credentialDraft ? (
                <>
                  <label className="aux-connection-search">
                    <Search size={16} />
                    <input
                      autoFocus
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') beginQuickConnection()
                        if (event.key === 'Escape') closePicker()
                      }}
                      placeholder={t('连接到 username@host...')}
                    />
                  </label>
                  <div className="aux-connection-scroll">
                    <p className="aux-connection-heading">{t('本地')}</p>
                    <button className="aux-connection-option" type="button" onClick={selectLocal}>
                      <HardDrive size={15} />
                      <span><strong>{t('本地计算机')}</strong><em>Windows</em></span>
                      {!server && <CheckCircle2 size={15} />}
                    </button>
                    <p className="aux-connection-heading">{t('远程')}</p>
                    {filteredServers.map((item) => (
                      <button className="aux-connection-option" type="button" onClick={() => selectServer(item)} key={item.id}>
                        <Server size={15} />
                        <span><strong>{item.name}</strong><em>{item.user}@{item.host}:{item.port}</em></span>
                        {server?.id === item.id && <CheckCircle2 size={15} />}
                      </button>
                    ))}
                    {normalizedQuery && parseQuickConnection(query) && !filteredServers.length && (
                      <button className="aux-connection-option quick" type="button" onClick={beginQuickConnection}>
                        <Wifi size={15} />
                        <span><strong>{t('快速连接')}</strong><em>{query.trim()}</em></span>
                      </button>
                    )}
                    {!filteredServers.length && !normalizedQuery && (
                      <p className="aux-connection-empty">{t('还没有已保存的远程连接')}</p>
                    )}
                  </div>
                  <button
                    className="aux-connection-edit"
                    type="button"
                    onClick={() => {
                      closePicker()
                      onEditConnections()
                    }}
                  >
                    <Settings2 size={14} />
                    {t('管理连接')}
                  </button>
                </>
              ) : (
                <div className="aux-credential-form">
                  <button className="aux-credential-back" type="button" onClick={() => setCredentialDraft(null)} title={t('返回')}>
                    <ChevronLeft size={14} />
                  </button>
                  <div className="aux-credential-title">
                    <Server size={16} />
                    <span><strong>{credentialDraft.name || credentialDraft.host}</strong><em>{credentialDraft.user}@{credentialDraft.host}:{credentialDraft.port}</em></span>
                  </div>
                  <label>
                    <span>{t('SSH 密码')}</span>
                    <input
                      autoFocus
                      type="password"
                      value={credentialDraft.password ?? ''}
                      onChange={(event) => setCredentialDraft({ ...credentialDraft, password: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveQuickConnection()
                        if (event.key === 'Escape') setCredentialDraft(null)
                      }}
                      placeholder={t('输入密码')}
                    />
                  </label>
                  <button className="primary-button" type="button" disabled={!credentialDraft.password} onClick={saveQuickConnection}>
                    <Wifi size={14} />
                    {t('连接并保存')}
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}

function FileManagerWidget({
  widgetId = '',
  active = true,
  server,
  servers = [],
  onSelectConnection = () => undefined,
  onSaveConnection = () => undefined,
  onEditConnections = () => undefined,
  onContextMenu,
}: {
  widgetId?: string
  active?: boolean
  server?: ServerProfile
  servers?: ServerProfile[]
  onSelectConnection?: (serverId?: string) => void
  onSaveConnection?: (draft: ServerDraft) => void
  onEditConnections?: () => void
  onContextMenu: (event: MouseEvent<HTMLElement>, items: ContextMenuItem[]) => void
}) {
  const { resolvedLanguage, t } = useAppLocale()
  const rememberedView = widgetId ? fileManagerViewCache.get(widgetId) : undefined
  const rememberedPath = rememberedView?.path ?? ''
  const [path, setPath] = useState(rememberedPath)
  const [pathDraft, setPathDraft] = useState(rememberedPath === LOCAL_DRIVES_PATH ? '' : rememberedPath)
  const [entries, setEntries] = useState<LocalFileEntry[]>([])
  const [selectedEntry, setSelectedEntry] = useState<LocalFileEntry | null>(null)
  const [editorFile, setEditorFile] = useState<LocalFileEntry | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [editorDirty, setEditorDirty] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [fileOperation, setFileOperation] = useState<{ kind: 'rename' | 'delete'; entry: LocalFileEntry } | null>(null)
  const [operationLoading, setOperationLoading] = useState(false)
  const [hostKeyConfirmation, setHostKeyConfirmation] = useState<{ fingerprint: string; error?: string } | null>(null)
  const [hostKeyUpdating, setHostKeyUpdating] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [downloadPanel, setDownloadPanel] = useState<FileDownloadPanelState | null>(null)
  const [fileDragActive, setFileDragActive] = useState(false)
  const [error, setError] = useState(server && !hasSshAuthentication(server) ? '请选择可用连接，或补全该服务器的 SSH 认证信息。' : '')
  const [fileSort, setFileSort] = useState<{ key: FileSortKey; direction: SortDirection }>(
    rememberedView?.sort ?? { key: 'name', direction: 'asc' },
  )
  const rememberedPathRef = useRef(rememberedPath)
  const fileWidgetRef = useRef<HTMLDivElement | null>(null)
  const previousServerIdRef = useRef(server?.id)
  const editorViewRef = useRef<EditorView | null>(null)
  const editorRequestRef = useRef(0)
  const directoryRequestRef = useRef(0)
  const directoryRetryTimerRef = useRef<number | null>(null)
  const downloadRef = useRef<{ id: string; cancelled: boolean } | null>(null)
  const uploadRef = useRef<{ id: string; cancelled: boolean } | null>(null)
  const uploadFilesRef = useRef<(sources: string[]) => void>(() => undefined)
  const fileDropReadyRef = useRef(false)
  const hostKeyPromptClaimRef = useRef('')

  const remoteArgs = useMemo(() => (
    server
      ? { host: server.host, user: server.user, password: server.password ?? '', port: server.port }
      : null
  ), [server])
  const remoteReady = !server || hasSshAuthentication(server)
  const remoteMissingPassword = Boolean(server && !hasSshAuthentication(server))
  const remoteActivationDelay = remoteArgs
    ? AUX_WIDGET_MOUNT_DELAY_MS + REMOTE_AUX_AFTER_CONNECT_DELAY_MS
    : 120
  const delayedActive = useDelayedActive(active && remoteReady, remoteActivationDelay)
  const dismissHostKeyConfirmation = useCallback(() => {
    if (hostKeyUpdating) return
    releaseSshHostKeyPrompt(hostKeyPromptClaimRef.current)
    hostKeyPromptClaimRef.current = ''
    setHostKeyConfirmation(null)
  }, [hostKeyUpdating])
  const sortedEntries = useMemo(() => {
    const direction = fileSort.direction === 'asc' ? 1 : -1
    return [...entries].sort((left, right) => {
      if (left.is_dir !== right.is_dir) return left.is_dir ? -1 : 1
      let comparison = 0
      if (fileSort.key === 'size') comparison = left.size - right.size
      else comparison = String(left[fileSort.key] ?? '').localeCompare(
        String(right[fileSort.key] ?? ''),
        resolvedLanguage,
        { numeric: true, sensitivity: 'base' },
      )
      if (comparison === 0) comparison = left.name.localeCompare(right.name, resolvedLanguage, { numeric: true })
      return comparison * direction
    })
  }, [entries, fileSort, resolvedLanguage])

  function toggleFileSort(key: FileSortKey) {
    setFileSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'name' || key === 'file_type' || key === 'permissions' ? 'asc' : 'desc' })
  }

  useEffect(() => {
    rememberedPathRef.current = path
    if (!widgetId) return
    fileManagerViewCache.set(widgetId, { path, sort: fileSort })
  }, [fileSort, path, widgetId])

  useEffect(() => {
    setPathDraft(path === LOCAL_DRIVES_PATH ? '' : path)
  }, [path])

  useEffect(() => {
    if (!fileOperation || operationLoading) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFileOperation(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [fileOperation, operationLoading])

  useEffect(() => {
    if (!hostKeyConfirmation || hostKeyUpdating) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissHostKeyConfirmation()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [dismissHostKeyConfirmation, hostKeyConfirmation, hostKeyUpdating])

  useEffect(() => () => {
    releaseSshHostKeyPrompt(hostKeyPromptClaimRef.current)
  }, [])

  const loadDirectory = useCallback((nextPath?: string, retryAttempt = 0) => {
    if (retryAttempt === 0 && directoryRetryTimerRef.current !== null) {
      window.clearTimeout(directoryRetryTimerRef.current)
      directoryRetryTimerRef.current = null
    }
    const requestId = directoryRequestRef.current + 1
    directoryRequestRef.current = requestId
    const started = performance.now()
    diag('file-load', `start request=${requestId} remote=${Boolean(remoteArgs)} host=${server?.host ?? 'local'} path=${nextPath || '~'}`)
    setError('')
    setDirectoryLoading(true)
    const request = (remoteArgs
      ? requestRemoteDirectory(remoteArgs, nextPath)
      : nextPath === LOCAL_DRIVES_PATH
        ? invoke<LocalFileEntry[]>('local_list_drives')
        : invoke<LocalFileEntry[]>('local_list_dir', { path: nextPath || null }))
      .then((items) => {
        if (directoryRequestRef.current !== requestId) return
        const entryCount = Array.isArray(items) ? items.length : items.entries.length
        diag('file-load', `done request=${requestId} entries=${entryCount} elapsed_ms=${(performance.now() - started).toFixed(1)}`)
        startTransition(() => {
          if (Array.isArray(items)) {
            setEntries(items)
            if (nextPath) {
              rememberedPathRef.current = nextPath
              setPath(nextPath)
            }
          } else {
            setEntries(items.entries)
            rememberedPathRef.current = items.path
            setPath(items.path)
          }
          setSelectedEntry(null)
        })
      })
      .catch((reason) => {
        if (directoryRequestRef.current === requestId) {
          const message = String(reason)
          const fingerprint = extractSshHostKeyFingerprint(message)
          diag('file-load', `error request=${requestId} elapsed_ms=${(performance.now() - started).toFixed(1)} error=${message}`)
          if (remoteArgs && fingerprint) {
            setError('服务器身份信息发生变化，已暂停连接。')
            const claim = `${remoteArgs.host}:${remoteArgs.port}:${fingerprint}`
            if (claimSshHostKeyPrompt(claim)) {
              hostKeyPromptClaimRef.current = claim
              setHostKeyConfirmation({ fingerprint })
            }
          } else if (
            remoteArgs
            && isRetryableRemoteFileConnectionError(message)
            && retryAttempt < REMOTE_FILE_RETRY_DELAYS_MS.length
          ) {
            const delay = REMOTE_FILE_RETRY_DELAYS_MS[retryAttempt]
            setError(`文件通道握手失败，正在自动重试 ${retryAttempt + 1}/${REMOTE_FILE_RETRY_DELAYS_MS.length}…`)
            directoryRetryTimerRef.current = window.setTimeout(() => {
              directoryRetryTimerRef.current = null
              loadDirectory(nextPath, retryAttempt + 1)
            }, delay)
          } else {
            setError(formatRemoteFileConnectionError(message))
          }
        }
      })
      .finally(() => {
        if (directoryRequestRef.current === requestId) {
          diag('file-load', `finally request=${requestId} elapsed_ms=${(performance.now() - started).toFixed(1)}`)
          setDirectoryLoading(false)
        }
      })
    void request
  }, [remoteArgs, server?.host])

  useEffect(() => () => {
    if (directoryRetryTimerRef.current !== null) {
      window.clearTimeout(directoryRetryTimerRef.current)
      directoryRetryTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!remoteArgs) return
    const handleKnownHostUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ host: string; port: number }>).detail
      if (!detail || detail.host !== remoteArgs.host || detail.port !== remoteArgs.port) return
      setHostKeyConfirmation(null)
      setError('')
      loadDirectory(rememberedPathRef.current)
    }
    window.addEventListener(SSH_HOST_KEY_UPDATED_EVENT, handleKnownHostUpdated)
    return () => window.removeEventListener(SSH_HOST_KEY_UPDATED_EVENT, handleKnownHostUpdated)
  }, [loadDirectory, remoteArgs])

  const parentPath = useMemo(() => {
    if (!remoteArgs && path === LOCAL_DRIVES_PATH) return ''
    if (!remoteArgs && isWindowsDriveRoot(path)) return LOCAL_DRIVES_PATH
    return remoteArgs ? getRemoteParentPath(path) : getParentPath(path)
  }, [path, remoteArgs])

  function goParent() {
    if (!parentPath || parentPath === path) return
    loadDirectory(parentPath)
  }

  function submitPath() {
    const nextPath = normalizeSubmittedPath(pathDraft, Boolean(remoteArgs))
    const destination = nextPath || (remoteArgs ? '~' : LOCAL_DRIVES_PATH)
    setPathDraft(destination === LOCAL_DRIVES_PATH ? '' : destination)
    loadDirectory(destination)
  }

  async function replaceKnownHost() {
    const confirmation = hostKeyConfirmation
    if (!remoteArgs || !confirmation || hostKeyUpdating) return
    setHostKeyUpdating(true)
    setHostKeyConfirmation({ fingerprint: confirmation.fingerprint })
    try {
      await invoke<string>('ssh_replace_known_host', {
        host: remoteArgs.host,
        port: remoteArgs.port,
        expectedFingerprint: confirmation.fingerprint,
      })
      releaseSshHostKeyPrompt(hostKeyPromptClaimRef.current)
      hostKeyPromptClaimRef.current = ''
      setHostKeyConfirmation(null)
      setError('')
      window.dispatchEvent(new CustomEvent(SSH_HOST_KEY_UPDATED_EVENT, {
        detail: { host: remoteArgs.host, port: remoteArgs.port },
      }))
    } catch (reason) {
      setHostKeyConfirmation({
        fingerprint: confirmation.fingerprint,
        error: String(reason),
      })
    } finally {
      setHostKeyUpdating(false)
    }
  }

  function openEntry(entry: LocalFileEntry) {
    setSelectedEntry(entry)
    if (entry.is_dir) {
      loadDirectory(entry.path)
      return
    }
    openEditor(entry)
  }

  function openEditor(entry = selectedEntry) {
    if (!entry || entry.is_dir) return
    const requestId = editorRequestRef.current + 1
    editorRequestRef.current = requestId
    setError('')
    setEditorError('')
    setEditorFile(entry)
    setEditorDirty(false)
    setEditorContent('')
    setEditorLoading(true)
    void invoke<string>(
      remoteArgs ? 'remote_read_file' : 'local_read_file',
      remoteArgs ? { ...remoteArgs, path: entry.path } : { path: entry.path },
    )
      .then((content) => {
        if (editorRequestRef.current !== requestId) return
        setEditorContent(content)
        setEditorDirty(false)
      })
      .catch((reason) => {
        if (editorRequestRef.current !== requestId) return
        const message = String(reason).replace(/^Error:\s*/i, '')
        setEditorError(message)
        setError(message)
      })
      .finally(() => {
        if (editorRequestRef.current === requestId) setEditorLoading(false)
      })
  }

  function saveEditor() {
    if (!editorFile) return
    setError('')
    setEditorLoading(true)
    const content = editorViewRef.current?.state.doc.toString() ?? editorContent
    void invoke(remoteArgs ? 'remote_write_file' : 'local_write_file', remoteArgs ? { ...remoteArgs, path: editorFile.path, content } : { path: editorFile.path, content })
      .then(() => {
        setEditorError('')
        setEditorDirty(false)
        loadDirectory(path)
      })
      .catch((reason) => {
        const message = String(reason).replace(/^Error:\s*/i, '')
        setEditorError(message)
        setError(message)
      })
      .finally(() => setEditorLoading(false))
  }

  function closeEditor() {
    setEditorFile(null)
    setEditorContent('')
    setEditorDirty(false)
    setEditorLoading(false)
    setEditorError('')
    editorViewRef.current = null
    editorRequestRef.current += 1
  }

  function compressEntry(entry = selectedEntry) {
    if (!entry) return
    if (remoteArgs) {
      setError('远程压缩功能稍后接入；当前可先在 SSH 终端执行 tar/zip 命令。')
      return
    }
    setError('')
    void invoke<string>('local_compress_paths', { paths: [entry.path], destination: null })
      .then(() => loadDirectory(path))
      .catch((reason) => setError(String(reason)))
  }

  function extractEntry(entry = selectedEntry) {
    if (!entry || entry.is_dir || !isArchiveFile(entry.name)) return
    if (remoteArgs) {
      setError('远程解压功能稍后接入；当前可先在 SSH 终端执行 unzip/tar 命令。')
      return
    }
    setError('')
    void invoke<string>('local_extract_archive', { path: entry.path, destination: null })
      .then((outputPath) => loadDirectory(outputPath))
      .catch((reason) => setError(String(reason)))
  }

  async function downloadEntry(entry = selectedEntry) {
    if (!entry || downloadRef.current) return
    setError('')
    let destination: string | null
    try {
      destination = await invoke<string | null>('choose_file_download_destination', {
        suggestedName: entry.name,
        isDir: entry.is_dir,
      })
    } catch (reason) {
      setError(`无法选择保存位置：${String(reason)}`)
      return
    }
    if (!destination) return

    const transferId = crypto.randomUUID()
    const transfer = { id: transferId, cancelled: false }
    downloadRef.current = transfer
    upsertTransfer({
      id: transferId,
      protocol: remoteArgs ? 'sftp' : 'local',
      direction: remoteArgs ? 'download' : 'copy',
      title: entry.name,
      source: entry.path,
      destination,
      status: 'running',
      totalBytes: entry.is_dir ? 0 : entry.size,
      transferredBytes: 0,
      bytesPerSecond: 0,
      copiedFiles: 0,
      totalFiles: entry.is_dir ? 0 : 1,
      currentFile: entry.name,
      message: t(remoteArgs ? '正在从服务器下载' : '正在复制到所选位置'),
      resumable: Boolean(remoteArgs && !entry.is_dir),
    }, {
      cancel: () => cancelDownload(),
      retry: () => downloadEntry(entry),
    })
    setDownloadPanel({
      entryName: entry.name,
      status: 'running',
      message: t(remoteArgs ? '正在从服务器下载' : '正在复制到所选位置'),
      totalBytes: entry.is_dir ? 0 : entry.size,
      transferredBytes: 0,
      bytesPerSecond: 0,
      copiedFiles: 0,
      totalFiles: entry.is_dir ? 0 : 1,
      currentFile: entry.name,
      completed: false,
    })

    const onProgress = createMessageChannel<FileDownloadProgress>((progress) => {
      if (downloadRef.current?.id !== transferId) return
      upsertTransfer({
        id: transferId,
        ...progress,
        status: progress.completed ? 'completed' : 'running',
        message: progress.completed ? t('下载完成') : t(remoteArgs ? '正在从服务器下载' : '正在复制到所选位置'),
      })
      setDownloadPanel((current) => current ? {
        ...current,
        ...progress,
        message: progress.completed ? t('下载完成') : current.message,
        status: progress.completed ? 'completed' : 'running',
      } : current)
    })

    try {
      const result = await invoke<FileDownloadResult>(remoteArgs ? 'remote_download_path' : 'local_download_path', remoteArgs
        ? {
            ...remoteArgs,
            transferId,
            remotePath: entry.path,
            destination,
            onProgress,
          }
        : {
            transferId,
            source: entry.path,
            destination,
            onProgress,
          })
      if (downloadRef.current?.id !== transferId) return
      upsertTransfer({
        id: transferId,
        status: 'completed',
        destination: result.destination,
        copiedFiles: result.copiedFiles,
        totalBytes: result.totalBytes,
        transferredBytes: result.totalBytes,
        bytesPerSecond: 0,
        currentFile: '',
        message: `${t('已保存到')} ${result.destination}`,
      })
      setDownloadPanel((current) => current ? {
        ...current,
        completed: true,
        status: 'completed',
        message: `${t('已保存到')} ${result.destination}`,
        destination: result.destination,
        copiedFiles: result.copiedFiles,
        totalBytes: result.totalBytes,
        transferredBytes: result.totalBytes,
        currentFile: '',
      } : current)
    } catch (reason) {
      if (downloadRef.current?.id !== transferId) return
      const detail = String(reason).replace(/^Error:\s*/i, '')
      const cancelled = transfer.cancelled || detail.includes('取消')
      upsertTransfer({
        id: transferId,
        status: cancelled ? 'cancelled' : 'error',
        bytesPerSecond: 0,
        currentFile: '',
        message: cancelled ? t('下载已取消') : `${t('下载失败')}：${detail}`,
      })
      setDownloadPanel((current) => current ? {
        ...current,
        status: cancelled ? 'cancelled' : 'error',
        message: cancelled ? t('下载已取消') : `${t('下载失败')}：${detail}`,
        currentFile: '',
      } : current)
    } finally {
      if (downloadRef.current?.id === transferId) downloadRef.current = null
    }
  }

  function cancelDownload() {
    const transfer = downloadRef.current
    if (!transfer || transfer.cancelled) return
    transfer.cancelled = true
    upsertTransfer({ id: transfer.id, message: t('正在取消下载...'), bytesPerSecond: 0 })
    setDownloadPanel((current) => current ? { ...current, message: t('正在取消下载...') } : current)
    void invoke('cancel_file_download', { transferId: transfer.id }).catch((reason) => {
      setError(`取消下载失败：${String(reason)}`)
    })
  }

  async function uploadFiles(retrySources?: string[]) {
    if (!remoteArgs || uploadRef.current) return
    setError('')
    let sources = retrySources
    if (!sources) {
      try {
        sources = await invoke<string[]>('choose_file_upload_sources')
      } catch (reason) {
        setError(`${t('无法选择上传文件')}：${String(reason)}`)
        return
      }
    }
    if (!sources.length) return

    const transferId = crypto.randomUUID()
    const transfer = { id: transferId, cancelled: false }
    const targetDirectory = path || '~'
    const title = sources.length === 1
      ? transferPathName(sources[0])
      : `${sources.length} ${t('个项目')}`
    uploadRef.current = transfer
    upsertTransfer({
      id: transferId,
      protocol: 'sftp',
      direction: 'upload',
      title,
      source: sources.join('; '),
      destination: `${remoteArgs.host}:${targetDirectory}`,
      status: 'running',
      totalBytes: 0,
      transferredBytes: 0,
      bytesPerSecond: 0,
      copiedFiles: 0,
      totalFiles: sources.length,
      currentFile: transferPathName(sources[0]),
      message: t('正在上传到服务器'),
      resumable: false,
    }, {
      cancel: () => cancelUpload(),
      retry: () => uploadFiles(sources),
    })
    window.dispatchEvent(new Event(FILE_TRANSFER_MANAGER_OPEN_EVENT))

    const onProgress = createMessageChannel<FileDownloadProgress>((progress) => {
      if (uploadRef.current?.id !== transferId) return
      upsertTransfer({
        id: transferId,
        ...progress,
        status: progress.completed ? 'completed' : 'running',
        message: progress.completed ? t('上传完成') : t('正在上传到服务器'),
      })
    })

    try {
      const result = await invoke<FileDownloadResult>('remote_upload_paths', {
        ...remoteArgs,
        transferId,
        sources,
        remoteDirectory: targetDirectory,
        onProgress,
      })
      if (uploadRef.current?.id !== transferId) return
      upsertTransfer({
        id: transferId,
        status: 'completed',
        destination: `${remoteArgs.host}:${result.destination}`,
        copiedFiles: result.copiedFiles,
        totalFiles: result.totalFiles,
        totalBytes: result.totalBytes,
        transferredBytes: result.totalBytes,
        bytesPerSecond: 0,
        currentFile: '',
        message: `${t('已上传到')} ${result.destination}`,
      })
      loadDirectory(result.destination)
    } catch (reason) {
      if (uploadRef.current?.id !== transferId) return
      const detail = String(reason).replace(/^Error:\s*/i, '')
      const cancelled = transfer.cancelled || detail.includes('取消')
      upsertTransfer({
        id: transferId,
        status: cancelled ? 'cancelled' : 'error',
        bytesPerSecond: 0,
        currentFile: '',
        message: cancelled ? t('上传已取消') : `${t('上传失败')}：${detail}`,
      })
      if (!cancelled) setError(`${t('上传失败')}：${detail}`)
    } finally {
      if (uploadRef.current?.id === transferId) uploadRef.current = null
    }
  }

  function cancelUpload() {
    const transfer = uploadRef.current
    if (!transfer || transfer.cancelled) return
    transfer.cancelled = true
    upsertTransfer({ id: transfer.id, message: t('正在取消上传...'), bytesPerSecond: 0 })
    void invoke('cancel_file_download', { transferId: transfer.id }).catch((reason) => {
      setError(`${t('取消上传失败')}：${String(reason)}`)
    })
  }

  uploadFilesRef.current = (sources) => { void uploadFiles(sources) }
  fileDropReadyRef.current = Boolean(active && delayedActive && remoteArgs && remoteReady && !editorFile)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const appWindow = getCurrentWindow()
    void appWindow.scaleFactor().then((scaleFactor) => appWindow.onDragDropEvent((event: {
      payload: { type: string; paths?: string[]; position?: { x: number; y: number } }
    }) => {
      if (disposed) return
      const payload = event.payload
      if (payload.type === 'leave') {
        setFileDragActive(false)
        return
      }
      const position = payload.position
      const widget = fileWidgetRef.current
      if (!position || !widget) return
      const rect = widget.getBoundingClientRect()
      const x = position.x / Math.max(1, scaleFactor)
      const y = position.y / Math.max(1, scaleFactor)
      const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      const ready = fileDropReadyRef.current && !uploadRef.current
      if (payload.type === 'enter' || payload.type === 'over') {
        setFileDragActive(inside && ready)
        return
      }
      if (payload.type === 'drop') {
        setFileDragActive(false)
        if (inside && ready && payload.paths?.length) uploadFilesRef.current(payload.paths)
      }
    })).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    }).catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  function openRenameDialog(entry: LocalFileEntry) {
    setRenameDraft(entry.name)
    setFileOperation({ kind: 'rename', entry })
  }

  function openDeleteDialog(entry: LocalFileEntry) {
    setFileOperation({ kind: 'delete', entry })
  }

  async function renameEntry() {
    if (!fileOperation || fileOperation.kind !== 'rename' || operationLoading) return
    const nextName = renameDraft.trim()
    if (!nextName || nextName === fileOperation.entry.name) {
      setFileOperation(null)
      return
    }
    setOperationLoading(true)
    setError('')
    try {
      await invoke<string>(remoteArgs ? 'remote_rename_path' : 'local_rename_path', remoteArgs
        ? { ...remoteArgs, path: fileOperation.entry.path, newName: nextName }
        : { path: fileOperation.entry.path, newName: nextName })
      if (editorFile?.path === fileOperation.entry.path) closeEditor()
      setFileOperation(null)
      loadDirectory(path)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setOperationLoading(false)
    }
  }

  async function deleteEntry() {
    if (!fileOperation || fileOperation.kind !== 'delete' || operationLoading) return
    setOperationLoading(true)
    setError('')
    try {
      await invoke(remoteArgs ? 'remote_delete_path' : 'local_delete_path', remoteArgs
        ? { ...remoteArgs, path: fileOperation.entry.path }
        : { path: fileOperation.entry.path })
      if (editorFile?.path === fileOperation.entry.path) closeEditor()
      setFileOperation(null)
      loadDirectory(path)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setOperationLoading(false)
    }
  }

  function openFileMenu(event: MouseEvent<HTMLElement>, entry: LocalFileEntry) {
    setSelectedEntry(entry)
    const items: ContextMenuItem[] = [
      entry.is_dir
        ? { label: '进入文件夹', hint: entry.name, icon: <FolderOpen size={14} />, onClick: () => loadDirectory(entry.path) }
        : { label: '查看 / 编辑', hint: entry.name, icon: <Edit3 size={14} />, onClick: () => openEditor(entry) },
      {
        label: remoteArgs ? '下载到本机' : '另存为',
        hint: entry.is_dir ? '包含全部内容' : formatBytes(entry.size),
        icon: <Download size={14} />,
        disabled: Boolean(downloadRef.current),
        onClick: () => { void downloadEntry(entry) },
      },
      ...(!remoteArgs ? [{ label: '压缩为 ZIP', hint: entry.name, icon: <Archive size={14} />, onClick: () => compressEntry(entry) }] : []),
      ...(!remoteArgs && !entry.is_dir && isArchiveFile(entry.name)
        ? [{ label: '解压到文件夹', hint: entry.name, icon: <Archive size={14} />, onClick: () => extractEntry(entry) }]
        : []),
      {
        separatorBefore: true,
        label: '重命名',
        hint: entry.name,
        icon: <Edit3 size={14} />,
        onClick: () => openRenameDialog(entry),
      },
      {
        label: '复制路径',
        hint: entry.path,
        icon: <Copy size={14} />,
        onClick: () => {
          void navigator.clipboard.writeText(entry.path).catch(() => setError('复制路径失败：系统剪贴板不可用'))
        },
      },
      { label: '刷新列表', icon: <RefreshCw size={14} />, onClick: () => loadDirectory(path) },
      {
        separatorBefore: true,
        label: entry.is_dir ? '删除文件夹' : '删除文件',
        hint: entry.name,
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => openDeleteDialog(entry),
      },
    ]
    onContextMenu(event, items)
  }

  useEffect(() => {
    if (previousServerIdRef.current === server?.id) return
    previousServerIdRef.current = server?.id
    directoryRequestRef.current += 1
    if (directoryRetryTimerRef.current !== null) {
      window.clearTimeout(directoryRetryTimerRef.current)
      directoryRetryTimerRef.current = null
    }
    rememberedPathRef.current = ''
    setEntries([])
    setSelectedEntry(null)
    setPath('')
    setPathDraft('')
    dismissHostKeyConfirmation()
    setError(remoteMissingPassword ? '请选择可用连接，或补全该服务器的 SSH 认证信息。' : '')
  }, [dismissHostKeyConfirmation, remoteMissingPassword, server?.id])

  useEffect(() => {
    if (!delayedActive) return
    if (remoteArgs) {
      loadDirectory(rememberedPathRef.current)
      return
    }
    loadDirectory(rememberedPathRef.current || LOCAL_DRIVES_PATH)
  }, [delayedActive, loadDirectory, remoteArgs])

  return (
    <>
    <div
      className={`file-widget ${editorFile ? 'editing' : ''} ${fileDragActive ? 'file-drag-active' : ''}`}
      ref={fileWidgetRef}
      onDragEnter={(event) => {
        if (!fileDropReadyRef.current || uploadRef.current) return
        event.preventDefault()
        event.stopPropagation()
        setFileDragActive(true)
      }}
      onDragOver={(event) => {
        if (!fileDropReadyRef.current || uploadRef.current) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        setFileDragActive(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        event.stopPropagation()
        const nextTarget = event.relatedTarget
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
        setFileDragActive(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setFileDragActive(false)
        if (!fileDropReadyRef.current || uploadRef.current) return
        const sources = Array.from(event.dataTransfer.files)
          .map((file) => (file as File & { path?: string }).path ?? '')
          .filter(Boolean)
        if (sources.length > 0) uploadFilesRef.current(sources)
        else setError(t('请从系统文件管理器拖入文件'))
      }}
    >
      <div className="file-toolbar">
        <AuxConnectionPicker
          server={server}
          servers={servers}
          onSelectConnection={onSelectConnection}
          onSaveConnection={onSaveConnection}
          onEditConnections={onEditConnections}
        />
        <button type="button" onClick={goParent} disabled={!parentPath || parentPath === path} aria-label={t('返回上一页')}>
          <ChevronLeft size={13} />
        </button>
        {!remoteArgs && (
          <button type="button" onClick={() => loadDirectory(LOCAL_DRIVES_PATH)} disabled={directoryLoading} aria-label={t('此电脑')} title={t('此电脑')}>
            <HardDrive size={13} />
          </button>
        )}
        <button type="button" onClick={() => loadDirectory(path)} disabled={directoryLoading || !remoteReady} title={t('刷新列表')}>
          <RefreshCw size={13} />
        </button>
        <button type="button" onClick={() => openEditor()} disabled={!selectedEntry || selectedEntry.is_dir} title={t('查看 / 编辑')}>
          <Edit3 size={13} />
        </button>
        <button
          className={downloadRef.current ? 'active-transfer' : ''}
          type="button"
          onClick={() => { void downloadEntry() }}
          disabled={!selectedEntry || Boolean(downloadRef.current)}
          title={t(remoteArgs ? '下载到本机' : '另存为')}
        >
          <Download size={13} />
        </button>
        {remoteArgs && (
          <button
            className={uploadRef.current ? 'active-transfer' : ''}
            type="button"
            onClick={() => { void uploadFiles() }}
            disabled={Boolean(uploadRef.current) || !remoteReady}
            title={t('上传文件到当前目录')}
            aria-label={t('上传文件到当前目录')}
          >
            <Upload size={13} />
          </button>
        )}
        <button type="button" onClick={() => compressEntry()} disabled={!selectedEntry || Boolean(remoteArgs)} title={t('压缩为 ZIP')}>
          <Archive size={13} />
        </button>
        <button type="button" onClick={() => extractEntry()} disabled={Boolean(remoteArgs) || !selectedEntry || selectedEntry.is_dir || !isArchiveFile(selectedEntry.name)} title={t('解压')}>
          <PackageOpen size={13} />
        </button>
        <label className="file-address" title={remoteArgs ? `${server?.host ?? '服务器'}:${path || '~'}` : path || t('此电脑')}>
          <FolderOpen size={13} />
          <input
            className="file-address-input"
            type="text"
            value={pathDraft}
            placeholder={path === LOCAL_DRIVES_PATH ? t('此电脑') : t('输入路径后按回车')}
            aria-label={t('文件夹路径')}
            spellCheck={false}
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitPath()
              } else if (event.key === 'Escape') {
                setPathDraft(path === LOCAL_DRIVES_PATH ? '' : path)
                event.currentTarget.blur()
              }
            }}
          />
        </label>
      </div>
      {error && <p className="empty-note file-connection-error" role="alert">{t(error)}</p>}
      {remoteArgs && remoteReady && !delayedActive && !directoryLoading && !error && (
        <p className="empty-note">正在排队读取目录...</p>
      )}
      {!editorFile && (
        <div className="file-browser">
          <div className="file-list-header" role="row">
            {([
              ['name', '名称'],
              ['permissions', '权限'],
              ['modified', '最后修改'],
              ['file_type', '类型'],
              ['size', '大小'],
            ] as const).map(([key, label], index) => (
              <button
                className={`${index === 0 ? 'file-sort-name ' : ''}${fileSort.key === key ? 'active' : ''}`}
                type="button"
                role="columnheader"
                aria-sort={fileSort.key === key ? (fileSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                onClick={() => toggleFileSort(key)}
                key={key}
              >
                <span>{t(label)}</span>
                <SortGlyph active={fileSort.key === key} direction={fileSort.direction} />
              </button>
            ))}
          </div>
          <VirtualFileList
            entries={sortedEntries}
            selectedPath={selectedEntry?.path ?? ''}
            parentPath={parentPath}
            currentPath={path}
            directoryLoading={directoryLoading}
            onGoParent={goParent}
            onSelect={setSelectedEntry}
            onOpen={openEntry}
            onContextMenu={openFileMenu}
          />
        </div>
      )}
      {downloadPanel && (
        <div className={`file-download-progress status-${downloadPanel.status}`} role="status" aria-live="polite">
          <div className="file-download-heading">
            <Download size={14} />
            <strong>{downloadPanel.entryName}</strong>
            <span>{downloadPanel.status === 'running' ? `${fileDownloadPercent(downloadPanel)}%` : t(downloadPanel.status === 'completed' ? '已完成' : downloadPanel.status === 'cancelled' ? '已取消' : '失败')}</span>
            <button
              type="button"
              onClick={downloadPanel.status === 'running' ? cancelDownload : () => setDownloadPanel(null)}
              aria-label={t(downloadPanel.status === 'running' ? '取消下载' : '关闭下载状态')}
              title={t(downloadPanel.status === 'running' ? '取消下载' : '关闭')}
            >
              <X size={12} />
            </button>
          </div>
          <div className="file-download-track"><span style={{ width: `${fileDownloadPercent(downloadPanel)}%` }} /></div>
          <div className="file-download-detail">
            <span title={downloadPanel.message}>{downloadPanel.message}</span>
            {downloadPanel.status === 'running' && <span>{formatBytes(downloadPanel.bytesPerSecond)}/s</span>}
            <span>{formatBytes(downloadPanel.transferredBytes)} / {formatBytes(downloadPanel.totalBytes)}</span>
          </div>
        </div>
      )}
      <AnimatePresence>
        {fileDragActive && (
          <motion.div
            className="file-manager-drop-zone"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.99 }}
            transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
          >
            <span className="file-manager-drop-icon"><Upload size={24} /></span>
            <strong>{t('释放后上传到当前目录')}</strong>
            <span>{t('支持文件、文件夹和多选')}</span>
            <code>{path || '~'}</code>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    {createPortal(
      <AnimatePresence>
        {editorFile && (
          <motion.div
            className="file-editor-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <motion.section
              className="file-editor-modal"
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="file-editor-head">
                <span>{editorFile.name}</span>
                <em className="file-editor-path">{editorFile.path}</em>
                <em>{t(editorLoading ? '正在读取' : editorError ? '读取失败' : editorDirty ? '未保存' : '已同步')}</em>
                <button type="button" onClick={saveEditor} disabled={!editorDirty || editorLoading || Boolean(editorError)}>
                  <Save size={13} />
                  {t('保存')}
                </button>
                <button className="file-editor-close" type="button" onClick={closeEditor} aria-label={t('关闭编辑器')} title={t('关闭编辑器')}>
                  <X size={13} />
                </button>
              </div>
              {editorLoading && (
                <div className="file-editor-loading">
                  <span>{t('正在打开文件...')}</span>
                </div>
              )}
              {!editorLoading && editorError && (
                <div className="file-editor-error" role="alert">
                  <strong>{t('文件读取失败')}</strong>
                  <span>{editorError}</span>
                  <button type="button" onClick={() => openEditor(editorFile)}>
                    <RefreshCw size={13} />
                    {t('重新读取')}
                  </button>
                </div>
              )}
              <FileTextEditor
                key={editorFile.path}
                content={editorContent}
                fileName={editorFile.name}
                large={editorFile.size > 512 * 1024}
                onReady={(view) => {
                  editorViewRef.current = view
                }}
                onDirty={() => setEditorDirty(true)}
                onSave={saveEditor}
              />
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
    )}
    {createPortal(
      <AnimatePresence>
        {hostKeyConfirmation && (
          <motion.div
            className="modal-backdrop file-operation-backdrop"
            onPointerDown={dismissHostKeyConfirmation}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            <motion.section
              className="file-operation-modal host-key-confirmation-modal"
              role="dialog"
              aria-modal="true"
              aria-label={t('确认服务器主机密钥变更')}
              onPointerDown={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
            >
              <div className="file-operation-icon"><ShieldCheck size={18} /></div>
              <div className="file-operation-copy">
                <strong>{t('确认服务器主机密钥变更')}</strong>
                <span>{t('仅当你已确认服务器重装、IP 重新分配或密钥轮换时才继续。')}</span>
              </div>
              <div className="host-key-fingerprint">
                <span>{t('服务器返回的新指纹')}</span>
                <code>{hostKeyConfirmation.fingerprint}</code>
              </div>
              {hostKeyConfirmation.error && <p className="host-key-update-error">{hostKeyConfirmation.error}</p>}
              <div className="file-operation-actions">
                <button type="button" onClick={dismissHostKeyConfirmation} disabled={hostKeyUpdating}>{t('取消')}</button>
                <button className="primary" type="button" onClick={() => { void replaceKnownHost() }} disabled={hostKeyUpdating}>
                  {t(hostKeyUpdating ? '处理中...' : '确认并重试')}
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
    )}
    {createPortal(
      <AnimatePresence>
        {fileOperation && (
          <motion.div
            className="modal-backdrop file-operation-backdrop"
            onPointerDown={() => { if (!operationLoading) setFileOperation(null) }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            <motion.form
              className="file-operation-modal"
              onPointerDown={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault()
                if (fileOperation.kind === 'rename') void renameEntry()
                else void deleteEntry()
              }}
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
            >
              <div className="file-operation-icon">
                {fileOperation.kind === 'rename' ? <Edit3 size={18} /> : <Trash2 size={18} />}
              </div>
              <div className="file-operation-copy">
                <strong>{t(fileOperation.kind === 'rename' ? '重命名' : fileOperation.entry.is_dir ? '删除文件夹' : '删除文件')}</strong>
                <span title={fileOperation.entry.path}>{fileOperation.kind === 'delete' && fileOperation.entry.is_dir
                  ? t('文件夹内的全部内容也会被永久删除。')
                  : fileOperation.entry.name}</span>
              </div>
              {fileOperation.kind === 'rename' && (
                <input
                  autoFocus
                  value={renameDraft}
                  onFocus={(event) => {
                    const extensionIndex = renameDraft.lastIndexOf('.')
                    event.currentTarget.setSelectionRange(0, extensionIndex > 0 && !fileOperation.entry.is_dir ? extensionIndex : renameDraft.length)
                  }}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  disabled={operationLoading}
                  aria-label={t('新名称')}
                />
              )}
              <div className="file-operation-actions">
                <button type="button" onClick={() => setFileOperation(null)} disabled={operationLoading}>{t('取消')}</button>
                <button
                  className={fileOperation.kind === 'delete' ? 'danger' : 'primary'}
                  type="submit"
                  disabled={operationLoading || (fileOperation.kind === 'rename' && !renameDraft.trim())}
                >
                  {t(operationLoading ? '处理中...' : fileOperation.kind === 'rename' ? '保存' : '确认删除')}
                </button>
              </div>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
    )}
    </>
  )
}

function AuxIdlePlaceholder({ type }: { type: 'files' | 'monitor' }) {
  const { t } = useAppLocale()
  return (
    <div className={type === 'files' ? 'file-widget' : 'monitor-widget'}>
      <p className="empty-note">
        {t(type === 'files' ? '服务器密码未配置，无法读取目录。' : '服务器密码未配置，无法读取监控。')}
      </p>
    </div>
  )
}

type VirtualFileRow =
  | { type: 'parent'; id: string }
  | { type: 'entry'; id: string; entry: LocalFileEntry }

function VirtualFileList({
  entries,
  selectedPath,
  parentPath,
  currentPath,
  directoryLoading,
  onGoParent,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  entries: LocalFileEntry[]
  selectedPath: string
  parentPath: string
  currentPath: string
  directoryLoading: boolean
  onGoParent: () => void
  onSelect: (entry: LocalFileEntry) => void
  onOpen: (entry: LocalFileEntry) => void
  onContextMenu: (event: MouseEvent<HTMLElement>, entry: LocalFileEntry) => void
}) {
  const { resolvedLanguage, resolvedTimeZone, t } = useAppLocale()
  const listRef = useRef<HTMLDivElement | null>(null)
  const virtualRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const measureFrameRef = useRef<number | null>(null)
  const rowElementsRef = useRef<HTMLDivElement[]>([])
  const rowsRef = useRef<VirtualFileRow[]>([])
  const selectedPathRef = useRef(selectedPath)
  const callbacksRef = useRef({ onGoParent, onSelect, onOpen, onContextMenu })
  const [poolSize, setPoolSize] = useState(32)

  const rows = useMemo<VirtualFileRow[]>(() => {
    const nextRows: VirtualFileRow[] = []
    if (parentPath && parentPath !== currentPath) nextRows.push({ type: 'parent', id: '__parent__' })
    entries.forEach((entry) => nextRows.push({ type: 'entry', id: entry.path, entry }))
    return nextRows
  }, [currentPath, entries, parentPath])

  const renderRows = useCallback(() => {
    const element = listRef.current
    const virtual = virtualRef.current
    if (!element) return
    if (virtual) virtual.style.height = `${rowsRef.current.length * fileRowHeight}px`

    const start = Math.max(0, Math.floor(element.scrollTop / fileRowHeight) - fileListOverscan)
    const selected = selectedPathRef.current

    rowElementsRef.current.forEach((rowElement, poolIndex) => {
      const rowIndex = start + poolIndex
      const row = rowsRef.current[rowIndex]
      if (!row) {
        rowElement.hidden = true
        return
      }

      rowElement.hidden = false
      rowElement.style.transform = `translate3d(0, ${rowIndex * fileRowHeight}px, 0)`
      rowElement.dataset.rowIndex = String(rowIndex)
      const icon = rowElement.children[0] as HTMLElement | undefined
      const name = rowElement.children[1] as HTMLElement | undefined
      const permissions = rowElement.children[2] as HTMLElement | undefined
      const modified = rowElement.children[3] as HTMLElement | undefined
      const fileType = rowElement.children[4] as HTMLElement | undefined
      const size = rowElement.children[5] as HTMLElement | undefined

      if (row.type === 'parent') {
        rowElement.dataset.rowType = 'parent'
        rowElement.dataset.path = ''
        rowElement.className = 'file-row virtual parent-row'
        if (icon) icon.className = 'file-entry-icon folder-icon'
        if (name) name.textContent = '......'
        if (permissions) permissions.textContent = '-'
        if (modified) modified.textContent = t('上一级')
        if (fileType) fileType.textContent = t('文件夹')
        if (size) size.textContent = '-'
        return
      }

      const entry = row.entry
      rowElement.dataset.rowType = 'entry'
      rowElement.dataset.path = entry.path
      rowElement.className = `file-row virtual ${selected === entry.path ? 'selected' : ''}`
      if (icon) {
        icon.className = `file-entry-icon ${entry.is_dir ? 'folder-icon' : fileIconClass(entry.name)}`
        icon.textContent = entry.is_dir ? 'D' : fileIconLabel(entry.name)
      }
      if (name) name.textContent = entry.name
      if (permissions) permissions.textContent = entry.permissions || '-'
      if (modified) modified.textContent = formatFileModified(entry.modified, resolvedLanguage, resolvedTimeZone)
      if (fileType) fileType.textContent = t(entry.file_type || (entry.is_dir ? '文件夹' : '文件'))
      if (size) size.textContent = entry.is_dir ? '-' : formatBytes(entry.size)
    })
  }, [resolvedLanguage, resolvedTimeZone, t])

  useEffect(() => {
    rowsRef.current = rows
    renderRows()
  }, [renderRows, rows])

  useEffect(() => {
    selectedPathRef.current = selectedPath
    renderRows()
  }, [renderRows, selectedPath])

  useEffect(() => {
    callbacksRef.current = { onGoParent, onSelect, onOpen, onContextMenu }
  }, [onContextMenu, onGoParent, onOpen, onSelect])

  useEffect(() => {
    const element = listRef.current
    if (!element) return

    const measurePool = () => {
      if (measureFrameRef.current !== null) return
      measureFrameRef.current = window.requestAnimationFrame(() => {
        measureFrameRef.current = null
        const nextPoolSize = Math.max(24, Math.ceil(element.clientHeight / fileRowHeight) + fileListOverscan * 2)
        setPoolSize((current) => (current === nextPoolSize ? current : nextPoolSize))
      })
    }

    measurePool()
    const observer = new ResizeObserver(measurePool)
    observer.observe(element)

    return () => {
      observer.disconnect()
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      if (measureFrameRef.current !== null) window.cancelAnimationFrame(measureFrameRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    renderRows()
  }, [poolSize, renderRows])

  useEffect(() => {
    const element = listRef.current
    if (!element) return
    element.scrollTop = 0
    renderRows()
  }, [currentPath, renderRows])

  function handleScroll() {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      renderRows()
    })
  }

  function getEventRow(target: EventTarget | null) {
    const button = target instanceof HTMLElement ? target.closest<HTMLElement>('.file-row.virtual') : null
    if (!button || button.hidden) return null
    const rowIndex = Number(button.dataset.rowIndex)
    return Number.isFinite(rowIndex) ? rowsRef.current[rowIndex] ?? null : null
  }

  function selectRow(target: EventTarget | null) {
    const row = getEventRow(target)
    if (!row) return
    if (row.type === 'parent') {
      callbacksRef.current.onGoParent()
      return
    }
    selectedPathRef.current = row.entry.path
    renderRows()
    callbacksRef.current.onSelect(row.entry)
  }

  function openRow(target: EventTarget | null) {
    const row = getEventRow(target)
    if (!row) return
    if (row.type === 'parent') {
      callbacksRef.current.onGoParent()
      return
    }
    callbacksRef.current.onOpen(row.entry)
  }

  function openRowMenu(event: MouseEvent<HTMLDivElement>) {
    const row = getEventRow(event.target)
    if (!row || row.type === 'parent') return
    selectedPathRef.current = row.entry.path
    renderRows()
    callbacksRef.current.onContextMenu(event, row.entry)
  }

  return (
    <div
      className="file-list"
      ref={listRef}
      onScroll={handleScroll}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => selectRow(event.target)}
      onDoubleClick={(event) => openRow(event.target)}
      onContextMenu={openRowMenu}
    >
      {directoryLoading && (
        <div className="file-list-loading">
          <RefreshCw size={13} />
          <span>正在读取目录...</span>
        </div>
      )}
      <div className="file-list-virtual" ref={virtualRef}>
        {Array.from({ length: poolSize }, (_, index) => (
          <div
            role="button"
            tabIndex={-1}
            className="file-row virtual"
            ref={(element) => {
              if (element) rowElementsRef.current[index] = element
            }}
            key={index}
          >
            <span className="file-entry-icon" />
            <strong />
            <em className="file-permissions" />
            <em className="file-modified" />
            <em className="file-type" />
            <em className="file-size" />
          </div>
        ))}
      </div>
      {entries.length >= 800 && (
        <div className="file-list-more">
          当前目录较大，已载入前 {entries.length} 项。
        </div>
      )}
    </div>
  )
}

function FileTextEditor({
  content,
  fileName,
  large,
  onReady,
  onDirty,
  onSave,
}: {
  content: string
  fileName: string
  large: boolean
  onReady: (view: EditorView | null) => void
  onDirty: () => void
  onSave: () => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onReadyRef = useRef(onReady)
  const onDirtyRef = useRef(onDirty)
  const onSaveRef = useRef(onSave)
  const applyingExternalRef = useRef(false)
  const lastExternalContentRef = useRef(content)

  useEffect(() => {
    onReadyRef.current = onReady
    onDirtyRef.current = onDirty
    onSaveRef.current = onSave
  }, [onReady, onDirty, onSave])

  useEffect(() => {
    if (!hostRef.current) return

    const extensions: Extension[] = [
      large ? minimalSetup : basicSetup,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current()
            return true
          },
        },
      ]),
      EditorView.theme(
        {
          '&': {
            height: '100%',
            backgroundColor: 'var(--terminal-bg)',
            color: 'var(--terminal-fg)',
          },
          '.cm-scroller': {
            fontFamily: 'var(--font-mono)',
            fontSize: '13px',
            lineHeight: '1.62',
            overflow: 'auto',
          },
          '.cm-content': {
            padding: '16px 18px 28px',
            caretColor: 'var(--accent)',
          },
          '.cm-line': {
            padding: '0 2px',
          },
          '.cm-gutters': {
            backgroundColor: 'var(--surface-1)',
            color: 'var(--text-disabled)',
            borderRight: '1px solid var(--border-soft)',
          },
          '.cm-activeLine': {
            backgroundColor: 'var(--accent-dim)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'var(--accent-dim)',
          },
          '.cm-cursor': {
            borderLeftColor: 'var(--accent)',
          },
        },
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternalRef.current) onDirtyRef.current()
      }),
    ]

    if (!large) {
      extensions.push(EditorView.lineWrapping)
      if (fileName.toLowerCase().endsWith('.json')) extensions.push(json())
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions,
      }),
      parent: hostRef.current,
    })

    viewRef.current = view
    onReadyRef.current(view)
    lastExternalContentRef.current = content
    window.requestAnimationFrame(() => view.focus())

    return () => {
      onReadyRef.current(null)
      view.destroy()
      viewRef.current = null
    }
  }, [fileName, large])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (lastExternalContentRef.current === content) return

    applyingExternalRef.current = true
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
    })
    lastExternalContentRef.current = content
    applyingExternalRef.current = false
  }, [content])

  return <div className="file-code-editor" ref={hostRef} />
}

type MonitorMetric = 'cpu' | 'memory' | 'disk' | 'network'
type MonitorHistoryKey = MonitorMetric | 'swap' | 'networkUp' | 'networkDown' | 'tcp' | 'udp'
type MonitorHistory = Record<MonitorHistoryKey, number[]>

function MachineMonitorWidget({
  widgetId = '',
  active,
  server,
  servers = [],
  onSelectConnection = () => undefined,
  onSaveConnection = () => undefined,
  onEditConnections = () => undefined,
}: {
  widgetId?: string
  active: boolean
  server?: ServerProfile
  servers?: ServerProfile[]
  onSelectConnection?: (serverId?: string) => void
  onSaveConnection?: (draft: ServerDraft) => void
  onEditConnections?: () => void
}) {
  const { t } = useAppLocale()
  const rememberedView = widgetId ? monitorViewCache.get(widgetId) : undefined
  const canRestoreView = rememberedView?.serverId === server?.id
  const makeEmptyHistory = (): MonitorHistory => ({ cpu: [], memory: [], disk: [], network: [], swap: [], networkUp: [], networkDown: [], tcp: [], udp: [] })
  const [stats, setStats] = useState<LocalSystemStats | null>(canRestoreView ? rememberedView?.stats ?? null : null)
  const [error, setError] = useState(server && !hasSshAuthentication(server) ? '请选择可用连接，或补全该服务器的 SSH 认证信息。' : '')
  const [metric, setMetric] = useState<MonitorMetric>(canRestoreView ? rememberedView?.metric ?? 'cpu' : 'cpu')
  const [history, setHistory] = useState<MonitorHistory>(() => canRestoreView ? rememberedView?.history ?? makeEmptyHistory() : makeEmptyHistory())
  const lastUpRef = useRef(0)
  const lastDownRef = useRef(0)
  const lastUpValueRef = useRef(0)
  const lastDownValueRef = useRef(0)
  const previousServerIdRef = useRef(server?.id)
  const refreshInFlightRef = useRef(false)
  const refreshOffsetRef = useRef(Math.floor(Math.random() * 500))
  const remoteArgs = useMemo(() => (
    server
      ? { host: server.host, user: server.user, password: server.password ?? '', port: server.port }
      : null
  ), [server])
  const remoteReady = !server || hasSshAuthentication(server)
  const remoteMissingPassword = Boolean(server && !hasSshAuthentication(server))

  useEffect(() => {
    if (!widgetId) return
    monitorViewCache.set(widgetId, {
      serverId: server?.id,
      metric,
      stats,
      history,
      lastNetwork: lastUpRef.current + lastDownRef.current,
    })
  }, [history, metric, server?.id, stats, widgetId])

  const refresh = useCallback(() => {
    if (document.hidden) return
    if (document.body.classList.contains('native-window-drag-active')) return
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    const started = performance.now()
    diag('monitor-refresh', `start remote=${Boolean(remoteArgs)} host=${server?.host ?? 'local'}`)
    void invoke<LocalSystemStats>(remoteArgs ? 'remote_system_stats' : 'local_system_stats', remoteArgs ?? undefined)
      .then((nextStats) => {
        diag('monitor-refresh', `done remote=${Boolean(remoteArgs)} host=${server?.host ?? 'local'} elapsed_ms=${(performance.now() - started).toFixed(1)} cpu=${nextStats.cpu_usage}`)
        startTransition(() => {
          setStats(nextStats)
          setError('')
          const memoryPercent = percent(nextStats.memory_used, nextStats.memory_total)
          const diskPercent = percent(nextStats.disk_used, nextStats.disk_total)
          const swapPercent = percent(nextStats.swap_used, nextStats.swap_total)
          const upDelta = lastUpRef.current > 0 ? Math.max(0, nextStats.network_transmitted - lastUpRef.current) : 0
          const downDelta = lastDownRef.current > 0 ? Math.max(0, nextStats.network_received - lastDownRef.current) : 0
          const upValue = upDelta / 1024 / 1024
          const downValue = downDelta / 1024 / 1024
          lastUpRef.current = nextStats.network_transmitted
          lastDownRef.current = nextStats.network_received
          lastUpValueRef.current = upValue
          lastDownValueRef.current = downValue
          setHistory((current) => ({
            cpu: [...current.cpu, nextStats.cpu_usage].slice(-600),
            memory: [...current.memory, memoryPercent].slice(-600),
            disk: [...current.disk, diskPercent].slice(-600),
            network: [...current.network, Math.max(upValue, downValue)].slice(-600),
            swap: [...current.swap, swapPercent].slice(-600),
            networkUp: [...current.networkUp, upValue].slice(-600),
            networkDown: [...current.networkDown, downValue].slice(-600),
            tcp: [...current.tcp, nextStats.tcp_connections ?? 0].slice(-600),
            udp: [...current.udp, nextStats.udp_connections ?? 0].slice(-600),
          }))
        })
      })
      .catch((reason) => {
        diag('monitor-refresh', `error remote=${Boolean(remoteArgs)} host=${server?.host ?? 'local'} elapsed_ms=${(performance.now() - started).toFixed(1)} error=${String(reason)}`)
        startTransition(() => setError(String(reason)))
      })
      .finally(() => {
        diag('monitor-refresh', `finally remote=${Boolean(remoteArgs)} host=${server?.host ?? 'local'} elapsed_ms=${(performance.now() - started).toFixed(1)}`)
        refreshInFlightRef.current = false
      })
  }, [remoteArgs, server?.host])

  useEffect(() => {
    if (!active || !remoteReady) return
    const interval = 2000
    const initialDelay = (
      remoteArgs
        ? AUX_WIDGET_MOUNT_DELAY_MS + REMOTE_AUX_AFTER_CONNECT_DELAY_MS
        : 0
    ) + refreshOffsetRef.current
    const initialTimer = window.setTimeout(refresh, initialDelay)
    const timer = window.setInterval(refresh, interval + refreshOffsetRef.current)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [active, refresh, remoteArgs, remoteReady])

  useEffect(() => {
    if (previousServerIdRef.current === server?.id) return
    previousServerIdRef.current = server?.id
    setStats(null)
    setHistory({ cpu: [], memory: [], disk: [], network: [], swap: [], networkUp: [], networkDown: [], tcp: [], udp: [] })
    lastUpRef.current = 0
    lastDownRef.current = 0
    setError(remoteMissingPassword ? '请选择可用连接，或补全该服务器的 SSH 认证信息。' : '')
  }, [remoteMissingPassword, server?.id])

  const metricCards = getMonitorCards(stats).map((item) => ({
    ...item,
    label: t(item.label),
    detail: t(item.detail),
  }))
  const activeCard = metricCards.find((item) => item.key === metric) ?? metricCards[0]

  return (
    <div className="monitor-widget">
      <div className="monitor-connection-bar">
        <AuxConnectionPicker
          server={server}
          servers={servers}
          onSelectConnection={onSelectConnection}
          onSaveConnection={onSaveConnection}
          onEditConnections={onEditConnections}
        />
      </div>
      <div className="monitor-tabs">
        {metricCards.map((item) => (
          <button
            className={item.key === metric ? 'active' : ''}
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setMetric(item.key)
            }}
            key={item.key}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className="monitor-chart-head">
        <div className="mch-metric">
          <span className="mch-label">{activeCard.label}</span>
          <strong className="mch-value">{activeCard.value}</strong>
        </div>
        <span className="mch-detail">{activeCard.detail}</span>
        <span className="mch-range">{t('近')} {Math.round(((history[metric].length - 1) * 2) / 60 * 10) / 10} {t('分钟')}</span>
      </div>
      <div className="monitor-chart">
        <MonitorUplot
          values={metric === 'network' ? history.networkUp : history[metric]}
          values2={metric === 'network' ? history.networkDown : undefined}
          label={metric === 'network' ? '上传' : activeCard.label}
          label2={metric === 'network' ? '下载' : undefined}
        />
      </div>
      {stats && (
        <div className="monitor-overview">
          <MonitorResourceCard
            title="CPU"
            value={`${Math.round(stats.cpu_usage)}%`}
            sub={stats.cpu_cores ? `${stats.cpu_cores} 核${stats.cpu_freq_mhz > 0 ? ` · ${(stats.cpu_freq_mhz / 1000).toFixed(2)} GHz` : ''}` : `${stats.process_count} 进程`}
            avg={avgOf(history.cpu)}
            peak={peakOf(history.cpu)}
            spark={history.cpu}
          />
          <MonitorResourceCard
            title="内存"
            value={`${percent(stats.memory_used, stats.memory_total).toFixed(1)}%`}
            sub={`${formatBytes(stats.memory_used)} / ${formatBytes(stats.memory_total)}`}
            avg={avgOf(history.memory)}
            peak={peakOf(history.memory)}
            spark={history.memory}
          />
          <MonitorResourceCard
            title="交换空间"
            value={`${percent(stats.swap_used, stats.swap_total).toFixed(1)}%`}
            sub={stats.swap_total > 0 ? `${formatBytes(stats.swap_used)} / ${formatBytes(stats.swap_total)}` : '未启用'}
            avg={avgOf(history.swap)}
            peak={peakOf(history.swap)}
            spark={history.swap}
          />
          <MonitorResourceCard
            title="存储"
            value={`${percent(stats.disk_used, stats.disk_total).toFixed(1)}%`}
            sub={`${formatBytes(stats.disk_used)} / ${formatBytes(stats.disk_total)}`}
            avg={avgOf(history.disk)}
            peak={peakOf(history.disk)}
            spark={history.disk}
          />
          <div className="monitor-net-card">
            <div className="mrc-top">
              <span className="mrc-title">网络</span>
              <span className="mrc-value net-rate">↑ {formatRateMB(lastUpValueRef.current)} · ↓ {formatRateMB(lastDownValueRef.current)}</span>
            </div>
            <div className="mrc-sub">网卡峰值 {formatRateMB(peakOf(history.network))} · 均值 {formatRateMB(avgOf(history.network))}</div>
            <MiniDualSpark up={history.networkUp} down={history.networkDown} />
            <div className="mrc-stats">
              <span>已发送 {formatBytes(stats.network_transmitted)}</span>
              <span>已接收 {formatBytes(stats.network_received)}</span>
            </div>
          </div>
        </div>
      )}
      {remoteArgs && remoteReady && !active && !stats && !error && <p className="empty-note">{t('正在排队读取监控...')}</p>}
      {error && <p className="empty-note">{error}</p>}
    </div>
  )
}

function ProcessManagerWidget({
  widgetId = '',
  active,
  server,
  servers = [],
  onSelectConnection = () => undefined,
  onSaveConnection = () => undefined,
  onEditConnections = () => undefined,
}: {
  widgetId?: string
  active: boolean
  server?: ServerProfile
  servers?: ServerProfile[]
  onSelectConnection?: (serverId?: string) => void
  onSaveConnection?: (draft: ServerDraft) => void
  onEditConnections?: () => void
}) {
  const { t } = useAppLocale()
  const rememberedView = widgetId ? processViewCache.get(widgetId) : undefined
  const canRestoreView = rememberedView?.serverId === server?.id
  const [processes, setProcesses] = useState<SystemProcessEntry[]>(canRestoreView ? rememberedView?.processes ?? [] : [])
  const [query, setQuery] = useState(canRestoreView ? rememberedView?.query ?? '' : '')
  const [processSort, setProcessSort] = useState<{ key: ProcessSortKey; direction: SortDirection }>(
    canRestoreView ? rememberedView?.sort ?? { key: 'cpu_usage', direction: 'desc' } : { key: 'cpu_usage', direction: 'desc' },
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const inFlightRef = useRef(false)
  const previousServerIdRef = useRef(server?.id)
  const remoteArgs = useMemo(() => (
    server
      ? { host: server.host, user: server.user, password: server.password ?? '', port: server.port }
      : null
  ), [server])
  const remoteReady = !server || hasSshAuthentication(server)

  useEffect(() => {
    if (!widgetId) return
    processViewCache.set(widgetId, {
      serverId: server?.id,
      query,
      sort: processSort,
      processes,
    })
  }, [processSort, processes, query, server?.id, widgetId])

  const refresh = useCallback(() => {
    if (!active || !remoteReady || document.hidden || inFlightRef.current) return
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    inFlightRef.current = true
    setLoading(true)
    void invoke<SystemProcessEntry[]>(remoteArgs ? 'remote_process_list' : 'local_process_list', remoteArgs ?? undefined)
      .then((items) => {
        if (requestRef.current !== requestId) return
        startTransition(() => {
          setProcesses(Array.isArray(items) ? items : [])
          setError('')
        })
      })
      .catch((reason) => {
        if (requestRef.current === requestId) setError(String(reason))
      })
      .finally(() => {
        if (requestRef.current === requestId) {
          inFlightRef.current = false
          setLoading(false)
        }
      })
  }, [active, remoteArgs, remoteReady])

  useEffect(() => {
    if (previousServerIdRef.current === server?.id) return
    previousServerIdRef.current = server?.id
    setProcesses([])
    setError(server && !hasSshAuthentication(server) ? '请选择可用连接，或补全该服务器的 SSH 认证信息。' : '')
    requestRef.current += 1
    inFlightRef.current = false
  }, [server?.id, server?.password])

  useEffect(() => {
    if (!active || !remoteReady) return
    const initial = window.setTimeout(refresh, remoteArgs ? AUX_WIDGET_MOUNT_DELAY_MS : 80)
    const timer = window.setInterval(refresh, 2000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [active, refresh, remoteArgs, remoteReady])

  const visibleProcesses = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const direction = processSort.direction === 'asc' ? 1 : -1
    return processes
      .filter((item) => !normalized || `${item.pid} ${item.name} ${item.command}`.toLowerCase().includes(normalized))
      .sort((left, right) => {
        let comparison = 0
        if (processSort.key === 'name' || processSort.key === 'status') {
          comparison = left[processSort.key].localeCompare(right[processSort.key], undefined, { numeric: true, sensitivity: 'base' })
        } else {
          comparison = left[processSort.key] - right[processSort.key]
        }
        if (comparison === 0) comparison = left.pid - right.pid
        return comparison * direction
      })
  }, [processes, processSort, query])

  function toggleProcessSort(key: ProcessSortKey) {
    setProcessSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'name' || key === 'status' ? 'asc' : 'desc' })
  }

  return (
    <div className="process-widget">
      <div className="process-toolbar">
        <AuxConnectionPicker
          server={server}
          servers={servers}
          onSelectConnection={onSelectConnection}
          onSaveConnection={onSaveConnection}
          onEditConnections={onEditConnections}
        />
        <label className="process-search">
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索进程')} />
        </label>
        <div className="process-sort" role="group" aria-label={t('排序')}>
          <button className={processSort.key === 'cpu_usage' ? 'active' : ''} type="button" onClick={() => setProcessSort({ key: 'cpu_usage', direction: 'desc' })}>CPU</button>
          <button className={processSort.key === 'memory' ? 'active' : ''} type="button" onClick={() => setProcessSort({ key: 'memory', direction: 'desc' })}>{t('内存')}</button>
        </div>
        <button className="process-refresh" type="button" onClick={refresh} disabled={loading || !remoteReady} title={t('刷新进程')}>
          <RefreshCw className={loading ? 'is-spinning' : ''} size={14} />
        </button>
      </div>
      <div className="process-table" role="table">
        <div className="process-row process-head" role="row">
          {([
            ['pid', 'PID'],
            ['name', '进程'],
            ['cpu_usage', 'CPU'],
            ['memory', '内存'],
            ['status', '状态'],
          ] as const).map(([key, label]) => (
            <button
              className={processSort.key === key ? 'active' : ''}
              type="button"
              role="columnheader"
              aria-sort={processSort.key === key ? (processSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() => toggleProcessSort(key)}
              key={key}
            >
              <span>{label === 'PID' || label === 'CPU' ? label : t(label)}</span>
              <SortGlyph active={processSort.key === key} direction={processSort.direction} />
            </button>
          ))}
        </div>
        <div className="process-table-body">
          {visibleProcesses.map((item) => (
            <div className="process-row" role="row" key={item.pid}>
              <code>{item.pid}</code>
              <span className="process-name"><strong>{item.name}</strong><em title={item.command}>{item.command || item.name}</em></span>
              <span>{item.cpu_usage.toFixed(1)}%</span>
              <span>{formatBytes(item.memory)}</span>
              <span>{item.status}</span>
            </div>
          ))}
          {!loading && !error && visibleProcesses.length === 0 && <p className="process-empty">{t('暂无进程')}</p>}
          {error && <p className="process-empty error">{t(error)}</p>}
        </div>
      </div>
    </div>
  )
}

const MemoLocalTerminalWidget = memo(LocalTerminalWidget)
const MemoRemoteTerminalWidget = memo(RemoteTerminalWidget)
const MemoRemoteDesktopWidget = memo(RemoteDesktopWidget)
const MemoFileManagerWidget = memo(FileManagerWidget)
const MemoMachineMonitorWidget = memo(MachineMonitorWidget)
const MemoProcessManagerWidget = memo(ProcessManagerWidget)

function useDelayedActive(active: boolean, delayMs: number) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!active) {
      setReady(false)
      return
    }

    const timer = window.setTimeout(() => setReady(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [active, delayMs])

  return ready
}

function Inspector({
  targetLabel,
  remoteTarget,
  onCommand,
  commandDraft,
  onCommandDraftChange,
  snippets,
  categories,
  onAddSnippet,
  onDeleteSnippet,
  onAddCategory,
  onDeleteCategory,
  onMoveSnippet,
  onReorderCategories,
  inspectDevices,
  onAddInspectDevice,
  onUpdateInspectDevice,
  onDeleteInspectDevice,
  onNotify,
  commandHistory,
  onClearHistory,
  notes,
  onAddNote,
  onToggleNote,
  onDeleteNote,
  activeTab,
  onActiveTabChange,
}: {
  targetLabel: string
  remoteTarget: boolean
  onCommand: (command: string) => void
  commandDraft: string
  onCommandDraftChange: (value: string) => void
  snippets: Snippet[]
  categories: string[]
  onAddSnippet: (snippet: Omit<Snippet, 'id'>) => void
  onDeleteSnippet: (id: string) => void
  onAddCategory: (name: string) => void
  onDeleteCategory: (name: string) => void
  onMoveSnippet: (id: string, category: string) => void
  onReorderCategories: (fromIndex: number, toIndex: number) => void
  inspectDevices: InspectDevice[]
  onAddInspectDevice: (device: Omit<InspectDevice, 'id'>) => void
  onUpdateInspectDevice: (id: string, patch: Partial<Omit<InspectDevice, 'id'>>) => void
  onDeleteInspectDevice: (id: string) => void
  onNotify: (message: string) => void
  commandHistory: CommandHistoryItem[]
  onClearHistory: () => void
  notes: SessionNote[]
  onAddNote: (text: string) => void
  onToggleNote: (id: string) => void
  onDeleteNote: (id: string) => void
  activeTab: InspectorTab
  onActiveTabChange: (tab: InspectorTab) => void
}) {
  const { t } = useAppLocale()
  const [snippetName, setSnippetName] = useState('')
  const [snippetCommand, setSnippetCommand] = useState('')
  const [snippetCategory, setSnippetCategory] = useState(() => categories.find((c) => c !== '未分类') || '未分类')
  const [snippetEditorOpen, setSnippetEditorOpen] = useState(false)
  const [snippetSearch, setSnippetSearch] = useState('')
  const [groupContextMenu, setGroupContextMenu] = useState<{ x: number; y: number; category: string } | null>(null)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [newCategoryName, setNewCategoryName] = useState('')
  const [categoryEditorOpen, setCategoryEditorOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; snippetId: string } | null>(null)
  const [inspectEditorOpen, setInspectEditorOpen] = useState(false)
  const [inspectEditingId, setInspectEditingId] = useState<string | null>(null)
  const [inspectDraft, setInspectDraft] = useState<Omit<InspectDevice, 'id'>>({
    name: '',
    host: '',
    port: 22,
    username: '',
    password: '',
    vendor: 'linux',
    remark: '',
  })
  const [selectedInspectIds, setSelectedInspectIds] = useState<Set<string>>(new Set())
  const [inspectCommands, setInspectCommands] = useState<{ id: string; name: string; command: string }[]>([])
  const [inspectManualCommand, setInspectManualCommand] = useState('')
  const [inspectTemplatePickerOpen, setInspectTemplatePickerOpen] = useState(false)
  const [inspectTemplateSearch, setInspectTemplateSearch] = useState('')
  const [inspectRunning, setInspectRunning] = useState(false)
  const [inspectResults, setInspectResults] = useState<InspectExecResult[] | null>(null)
  const [inspectConcurrency, setInspectConcurrency] = useState(5)
  const [inspectProgress, setInspectProgress] = useState<{ current: number; total: number } | null>(null)

  useEffect(() => {
    if (!contextMenu && !groupContextMenu) return
    const handler = (event: globalThis.MouseEvent) => {
      if (event.button === 2) return
      setContextMenu(null)
      setGroupContextMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu, groupContextMenu])
  const [noteText, setNoteText] = useState('')
  const commandSet = getQuickCommands(remoteTarget ? 'connected' : 'ready')

  function runCustomCommand() {
    if (!commandDraft.trim()) return
    onCommand(commandDraft)
  }

  function saveSnippet() {
    if (!snippetName.trim() || !snippetCommand.trim()) return
    onAddSnippet({ name: snippetName, command: snippetCommand, category: snippetCategory })
    setSnippetName('')
    setSnippetCommand('')
    setSnippetCategory(categories.find((c) => c !== '未分类') || '未分类')
    setSnippetEditorOpen(false)
  }

  function saveNote() {
    if (!noteText.trim()) return
    onAddNote(noteText)
    setNoteText('')
  }

  function prepareCommand(command: string) {
    onCommandDraftChange(command)
    onActiveTabChange('run')
  }

  function saveCategory() {
    if (!newCategoryName.trim()) return
    const name = newCategoryName.trim()
    onAddCategory(name)
    if (!categories.includes(name)) {
      setSnippetCategory(name)
      setExpandedCategories((prev) => new Set(prev).add(name))
    }
    setNewCategoryName('')
  }

  async function openInspectEditor(device?: InspectDevice) {
    if (device) {
      setInspectEditingId(device.id)
      let password = device.password
      if (device.encryptedPassword) {
        try {
          password = await invoke<string>('decrypt_secret', { cipher: device.encryptedPassword })
        } catch {
          password = ''
        }
      }
      setInspectDraft({
        name: device.name,
        host: device.host,
        port: device.port,
        username: device.username,
        password,
        vendor: device.vendor,
        remark: device.remark,
        encryptedPassword: device.encryptedPassword ?? '',
      })
    } else {
      setInspectEditingId(null)
      setInspectDraft({
        name: '',
        host: '',
        port: 22,
        username: '',
        password: '',
        vendor: 'linux',
        remark: '',
        encryptedPassword: '',
      })
    }
    setInspectEditorOpen(true)
  }

  async function saveInspectDevice() {
    if (!inspectDraft.name.trim() || !inspectDraft.host.trim()) return
    let encryptedPassword = inspectDraft.encryptedPassword ?? ''
    if (inspectDraft.password) {
      try {
        encryptedPassword = await invoke<string>('encrypt_secret', { plain: inspectDraft.password })
      } catch {
        return
      }
    }
    const base = {
      name: inspectDraft.name.trim(),
      host: inspectDraft.host.trim(),
      port: Number(inspectDraft.port) || 22,
      username: inspectDraft.username,
      password: '',
      vendor: inspectDraft.vendor,
      remark: inspectDraft.remark,
      encryptedPassword,
    }
    if (inspectEditingId) {
      onUpdateInspectDevice(inspectEditingId, base)
    } else {
      onAddInspectDevice(base)
    }
    setInspectEditorOpen(false)
  }

  function confirmDeleteInspectDevice(device: InspectDevice) {
    const confirmed = window.confirm(`删除设备「${device.name}」？`)
    if (!confirmed) return
    onDeleteInspectDevice(device.id)
  }

  async function runInspectBatch() {
    const selectedDevices = await resolveInspectPasswords(inspectDevices.filter((d) => selectedInspectIds.has(d.id)))
    const commandList = inspectCommands
      .map((item) => ({ name: item.name, command: item.command.trim() }))
      .filter((item) => item.command.length > 0)
    if (selectedDevices.length === 0 || commandList.length === 0) return

    setInspectRunning(true)
    setInspectResults(null)
    setInspectProgress({ current: 0, total: selectedDevices.length })
    try {
      const results = await invoke<InspectExecResult[]>('batch_execute_inspect', {
        devices: selectedDevices.map((d) => ({
          name: d.name,
          host: d.host,
          port: d.port,
          username: d.username,
          password: d.password,
          vendor: d.vendor,
        })),
        commands: commandList,
        concurrency: inspectConcurrency,
      })
      setInspectResults(results)
    } catch (reason) {
      const message = String(reason).replace(/^Error:\s*/i, '')
      setInspectResults([
        {
          deviceName: t('执行失败'),
          host: '',
          success: false,
          error: message,
          outputs: [],
          durationMs: 0,
          health: 'critical',
        },
      ])
    } finally {
      setInspectRunning(false)
      setInspectProgress(null)
    }
  }

  function toggleInspectDevice(id: string) {
    setSelectedInspectIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function addInspectCommand(name: string, command: string) {
    if (!command.trim()) return
    const id = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setInspectCommands((current) => [...current, { id, name: name || t('自定义命令'), command: command.trim() }])
  }

  function removeInspectCommand(id: string) {
    setInspectCommands((current) => current.filter((item) => item.id !== id))
  }

  function moveInspectCommand(id: string, direction: -1 | 1) {
    setInspectCommands((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  function addManualInspectCommand() {
    if (!inspectManualCommand.trim()) return
    addInspectCommand(t('自定义命令'), inspectManualCommand)
    setInspectManualCommand('')
  }

  function addSnippetToInspect(snippet: Snippet) {
    addInspectCommand(snippet.name, snippet.command)
  }

  function escapeCsvCell(value: string): string {
    if (/[",\n\r]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`
    }
    return value
  }

  function healthLabel(health: string): string {
    return health === 'ok' ? t('正常') : health === 'warn' ? t('警告') : health === 'critical' ? t('严重') : health
  }

  async function exportInspectResults(format: 'json' | 'csv') {
    if (!inspectResults) return
    const date = new Date().toISOString().slice(0, 10)
    try {
      if (format === 'json') {
        await invoke('save_text_export', {
          suggestedName: `巡检报告-${date}.json`,
          content: JSON.stringify(inspectResults, null, 2),
          filter: 'json',
        })
      } else {
        const header = ['设备名称', '主机', '健康状态', '执行结果', '耗时(秒)', '问题'].map(escapeCsvCell).join(',')
        const rows = inspectResults.map((result) => {
          const issues = result.outputs.flatMap((output) => output.issues).join('; ')
          return [result.deviceName, result.host, healthLabel(result.health), result.success ? t('成功') : t('失败'), (result.durationMs / 1000).toFixed(1), issues]
            .map(escapeCsvCell)
            .join(',')
        })
        // 加 UTF-8 BOM，避免 Excel 打开乱码
        await invoke('save_text_export', {
          suggestedName: `巡检汇总-${date}.csv`,
          content: `\uFEFF${[header, ...rows].join('\r\n')}`,
          filter: 'csv',
        })
      }
    } catch (reason) {
      onNotify(`导出失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  async function importInspectDevicesCsv() {
    try {
      const text = await invoke<string | null>('open_text_import', { filter: 'csv' })
      if (!text) return
      const rows = parseCsvRows(text.replace(/^\uFEFF/, ''))
      if (rows.length === 0) {
        onNotify(t('CSV 文件为空'))
        return
      }
      const header = rows[0].map((cell) => cell.trim().toLowerCase())
      const nameIndex = header.indexOf('name')
      const hostIndex = header.indexOf('host')
      const portIndex = header.indexOf('port')
      const usernameIndex = header.indexOf('username')
      const passwordIndex = header.indexOf('password')
      const vendorIndex = header.indexOf('vendor')
      const remarkIndex = header.indexOf('remark')
      if (hostIndex < 0) {
        onNotify(t('CSV 缺少 host 列'))
        return
      }
      let added = 0
      for (const row of rows.slice(1)) {
        const host = (row[hostIndex] ?? '').trim()
        if (!host) continue
        const vendor = vendorIndex >= 0 ? (row[vendorIndex] ?? '').trim().toLowerCase() : 'linux'
        onAddInspectDevice({
          name: (nameIndex >= 0 ? row[nameIndex] ?? '' : '').trim() || host,
          host,
          port: portIndex >= 0 ? Number(row[portIndex]) || 22 : 22,
          username: (usernameIndex >= 0 ? row[usernameIndex] ?? '' : '').trim(),
          password: (passwordIndex >= 0 ? row[passwordIndex] ?? '' : '').trim(),
          vendor: vendor || 'linux',
          remark: (remarkIndex >= 0 ? row[remarkIndex] ?? '' : '').trim(),
        })
        added += 1
      }
      onNotify(`${t('CSV 导入成功')}：${added} 台`)
    } catch (reason) {
      onNotify(`CSV 导入失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  function parseCsvRows(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let cell = ''
    let inQuotes = false
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            cell += '"'
            i += 1
          } else {
            inQuotes = false
          }
        } else {
          cell += char
        }
      } else if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        row.push(cell)
        cell = ''
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i += 1
        row.push(cell)
        cell = ''
        rows.push(row)
        row = []
      } else {
        cell += char
      }
    }
    if (cell.length > 0 || row.length > 0) {
      row.push(cell)
      rows.push(row)
    }
    return rows
  }

  useEffect(() => {
    const unlistenTask = listen<{ current: number; total: number; deviceName: string }>(
      'inspect-progress',
      (event) => {
        setInspectProgress({ current: event.payload.current, total: event.payload.total })
      },
    ).catch(() => () => undefined)
    return () => {
      void unlistenTask.then((unlisten) => unlisten())
    }
  }, [])

  function openContextMenu(event: React.MouseEvent, snippetId: string) {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, snippetId })
  }

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  return (
    <aside className="inspector utility-panel">
      <section className="utility-stage">
        {activeTab === 'run' && (
          <div className="utility-page utility-run-page">
            <div className="utility-target">
              <span className="connection-dot connected" />
              <div>
                <span>{t('当前执行位置')}</span>
                <strong>{t(targetLabel)}</strong>
              </div>
            </div>
            <label className="utility-command-field">
              <span>{t('命令')}</span>
              <textarea
                className="utility-command-input"
                value={commandDraft}
                onChange={(event) => onCommandDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    runCustomCommand()
                  }
                }}
                placeholder={t('输入命令，按 Ctrl + Enter 执行')}
              />
            </label>
            <button className="utility-primary-button" type="button" onClick={runCustomCommand} disabled={!commandDraft.trim()}>
              <ArrowUp size={14} />
              {t('执行')}
            </button>
            <div className="utility-section-head">
              <div>
                <strong>{t('快捷填入')}</strong>
                <span>{t('点击后先填入编辑框，不会立即执行。')}</span>
              </div>
            </div>
            <div className="command-list utility-command-list">
              {commandSet.map((item) => (
                <button type="button" className="command-chip" onClick={() => onCommandDraftChange(item.command)} key={item.command}>
                  <strong>{t(item.label)}</strong>
                  <span>{item.command}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'snippets' && (() => {
          const keyword = snippetSearch.trim().toLowerCase()
          const filtered = keyword
            ? snippets.filter((s) =>
                s.name.toLowerCase().includes(keyword) ||
                s.command.toLowerCase().includes(keyword) ||
                (s.category || '未分类').toLowerCase().includes(keyword),
              )
            : snippets
          const groups = new Map<string, Snippet[]>()
          for (const cat of categories) groups.set(cat, [])
          for (const s of filtered) {
            const c = s.category || '未分类'
            if (!groups.has(c)) groups.set(c, [])
            groups.get(c)!.push(s)
          }
          const visibleGroups = [...groups.entries()].filter(([cat, list]) => cat !== '未分类' || list.length > 0)
          const toggleCategory = (cat: string) =>
            setExpandedCategories((prev) => {
              const next = new Set(prev)
              if (next.has(cat)) next.delete(cat)
              else next.add(cat)
              return next
            })
          return (
            <div className="utility-page">
              <div className="utility-section-head utility-page-intro">
                <div>
                  <strong>{t('保存经常使用的命令')}</strong>
                  <span>{t('点击使用后会先回到运行页，不会直接执行。')}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                  <button className="utility-text-button" type="button" onClick={() => setCategoryEditorOpen((current) => !current)}>
                    <FolderPlus size={13} />
                    {t('分类')}
                  </button>
                  <button className="utility-text-button" type="button" onClick={() => setSnippetEditorOpen((current) => !current)}>
                    {snippetEditorOpen ? <X size={13} /> : <Plus size={13} />}
                    {t(snippetEditorOpen ? '取消' : '新建')}
                  </button>
                </div>
              </div>
              <input
                className="snippet-search"
                type="text"
                value={snippetSearch}
                onChange={(event) => setSnippetSearch(event.target.value)}
                placeholder={t('搜索命令')}
              />
              {categoryEditorOpen && (
                <div className="snippet-category-manager utility-editor">
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                    <input
                      className="snippet-search"
                      style={{ marginBottom: 0, flex: 1, minWidth: 0 }}
                      type="text"
                      value={newCategoryName}
                      onChange={(event) => setNewCategoryName(event.target.value)}
                      placeholder={t('输入新分类名称')}
                      onKeyDown={(event) => { if (event.key === 'Enter') saveCategory() }}
                    />
                    <button className="utility-primary-button" type="button" onClick={saveCategory} disabled={!newCategoryName.trim()} style={{ flexShrink: 0, width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="snippet-category-list">
                    {categories.filter((cat) => cat !== '未分类').map((cat) => (
                      <div key={cat} className="snippet-category-row">
                        <span>{cat}</span>
                        <button type="button" className="utility-text-button danger" onClick={() => onDeleteCategory(cat)} title={t('删除分类')}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {snippetEditorOpen && (
                <div className="snippet-editor utility-editor">
                  <EditableField label={t('名称')} value={snippetName} onChange={setSnippetName} />
                  <label className="utility-command-field">
                    <span>{t('命令')}</span>
                    <textarea
                      value={snippetCommand}
                      onChange={(event) => setSnippetCommand(event.target.value)}
                      placeholder={t('输入要保存的命令')}
                    />
                  </label>
                  <label className="utility-command-field">
                    <span>{t('分类')}</span>
                    <select value={snippetCategory} onChange={(event) => setSnippetCategory(event.target.value)}>
                      {categories.filter((cat) => cat !== '未分类').map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="utility-primary-button" type="button" onClick={saveSnippet} disabled={!snippetName.trim() || !snippetCommand.trim()}>
                    <Save size={14} />
                    {t('保存命令')}
                  </button>
                </div>
              )}
              {visibleGroups.length === 0 && (
                <div className="utility-empty">
                  <Star size={18} />
                  <strong>{t('还没有常用命令')}</strong>
                  <span>{t('点击右上角的新建开始添加。')}</span>
                </div>
              )}
              {visibleGroups.map(([category, list]) => {
                const isExpanded = keyword ? true : expandedCategories.has(category)
                const isUncategorized = category === '未分类'
                return (
                  <div key={category} className={`snippet-group${isExpanded ? '' : ' collapsed'}`}>
                    <div
                      className="snippet-group-header-row"
                      onContextMenu={(event) => {
                        if (isUncategorized) return
                        event.preventDefault()
                        setGroupContextMenu({ x: event.clientX, y: event.clientY, category })
                      }}
                    >
                      <button type="button" className="snippet-group-header" onClick={() => toggleCategory(category)}>
                        <span className="snippet-group-arrow">{isExpanded ? '▾' : '▸'}</span>
                        <strong>{category}</strong>
                        <span className="snippet-category-count">{list.length}</span>
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="snippet-list">
                        {list.length === 0 && (
                          <div className="snippet-empty-hint">
                            {t('暂无命令，右键其他命令可移动到此分类')}
                          </div>
                        )}
                        {list.map((snippet) => (
                          <div className="snippet-item" key={snippet.id} onContextMenu={(event) => openContextMenu(event, snippet.id)}>
                            <button type="button" onClick={() => prepareCommand(snippet.command)} title={t('使用此命令')}>
                              <strong>{snippet.name}</strong>
                              <span>{snippet.command}</span>
                            </button>
                            <IconButton label={t('删除命令')} onClick={() => onDeleteSnippet(snippet.id)}>
                              <Trash2 size={14} />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {contextMenu && createPortal(
                <div
                  className="snippet-context-menu"
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="snippet-context-menu-title">{t('移动到分类')}</div>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className="snippet-context-menu-item"
                      onClick={() => {
                        onMoveSnippet(contextMenu.snippetId, cat)
                        setContextMenu(null)
                      }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>,
                document.body,
              )}
              {groupContextMenu && createPortal((() => {
                const sortable = categories.filter((c) => c !== '未分类')
                const idx = sortable.indexOf(groupContextMenu.category)
                const move = (to: number) => {
                  if (to >= 0 && to < sortable.length && to !== idx) onReorderCategories(idx, to)
                  setGroupContextMenu(null)
                }
                return (
                  <div
                    className="snippet-context-menu"
                    style={{ left: groupContextMenu.x, top: groupContextMenu.y }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="snippet-context-menu-title">{groupContextMenu.category} · 排序</div>
                    <button type="button" className="snippet-context-menu-item" disabled={idx <= 0} onClick={() => move(idx - 1)}>↑ 上移</button>
                    <button type="button" className="snippet-context-menu-item" disabled={idx >= sortable.length - 1} onClick={() => move(idx + 1)}>↓ 下移</button>
                    <button type="button" className="snippet-context-menu-item" disabled={idx <= 0} onClick={() => move(0)}>⤒ 移至顶部</button>
                    <button type="button" className="snippet-context-menu-item" disabled={idx >= sortable.length - 1} onClick={() => move(sortable.length - 1)}>⤓ 移至尾部</button>
                  </div>
                )
              })(), document.body)}
            </div>
          )
        })()}

        {activeTab === 'history' && (
          <div className="utility-page">
            <div className="utility-section-head utility-page-intro">
              <div>
                <strong>{t('最近执行')}</strong>
                <span>{t('点击记录可回到运行页重新编辑。')}</span>
              </div>
              {commandHistory.length > 0 && (
                <button className="utility-text-button danger" type="button" onClick={onClearHistory}>
                  <Trash2 size={13} />
                  {t('清空')}
                </button>
              )}
            </div>
            <div className="history-list">
              {commandHistory.length === 0 && (
                <div className="utility-empty">
                  <Clock3 size={18} />
                  <strong>{t('还没有执行记录')}</strong>
                  <span>{t('运行过的命令会自动显示在这里。')}</span>
                </div>
              )}
              {commandHistory.map((item) => (
                <button className="history-item" type="button" onClick={() => prepareCommand(item.command)} key={item.id}>
                  <strong>{item.command}</strong>
                  <span>{item.time}</span>
                  <em>{item.server}</em>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="utility-page">
            <div className="utility-section-head utility-page-intro">
              <div>
                <strong>{t('简单待办')}</strong>
                <span>{t('记录临时想法，点击方框标记完成。')}</span>
              </div>
            </div>
            <label className="utility-command-field">
              <span>{t('新笔记')}</span>
              <textarea
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    saveNote()
                  }
                }}
                placeholder={t('输入笔记或待办')}
              />
            </label>
            <button className="utility-primary-button" type="button" onClick={saveNote} disabled={!noteText.trim()}>
              <Plus size={14} />
              {t('添加')}
            </button>
            <div className="note-list">
              {notes.length === 0 && (
                <div className="utility-empty">
                  <ClipboardList size={18} />
                  <strong>{t('还没有待办笔记')}</strong>
                  <span>{t('添加的内容会保存在本机。')}</span>
                </div>
              )}
              {notes.map((note) => (
                <div className={`note-item ${note.done ? 'done' : ''}`} key={note.id}>
                  <button className="note-toggle" type="button" onClick={() => onToggleNote(note.id)} aria-label={t('切换完成状态')}>
                    <span className="note-check">{note.done ? <CheckCircle2 size={16} /> : <Square size={16} />}</span>
                    <strong>{note.text}</strong>
                  </button>
                  <IconButton label={t('删除笔记')} onClick={() => onDeleteNote(note.id)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'inspect' && (
          <div className="utility-page inspect-page">
            <div className="utility-section-head utility-page-intro">
              <div>
                <strong>{t('自动化巡检')}</strong>
                <span>{t('管理巡检设备，后续可批量执行命令。')}</span>
              </div>
              <button className="utility-primary-button compact" type="button" onClick={() => openInspectEditor()}>
                <Plus size={14} />
                {t('添加设备')}
              </button>
            </div>

            {inspectEditorOpen && (
              <div className="inspect-editor">
                <div className="inspect-editor-grid">
                  <label className="utility-command-field">
                    <span>{t('设备名称')}</span>
                    <input
                      value={inspectDraft.name}
                      onChange={(event) => setInspectDraft((d) => ({ ...d, name: event.target.value }))}
                      placeholder={t('如：核心交换机-01')}
                    />
                  </label>
                  <label className="utility-command-field">
                    <span>{t('IP地址')}</span>
                    <input
                      value={inspectDraft.host}
                      onChange={(event) => setInspectDraft((d) => ({ ...d, host: event.target.value }))}
                      placeholder={t('如：192.168.1.1')}
                    />
                  </label>
                  <label className="utility-command-field">
                    <span>{t('端口')}</span>
                    <input
                      type="number"
                      value={inspectDraft.port}
                      onChange={(event) => setInspectDraft((d) => ({ ...d, port: Number(event.target.value) || 22 }))}
                    />
                  </label>
                  <label className="utility-command-field">
                    <select value={inspectDraft.vendor} onChange={(event) => setInspectDraft((d) => ({ ...d, vendor: event.target.value }))}>
                      {readInspectVendors().map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="utility-command-field">
                    <span>{t('用户名')}</span>
                    <input
                      value={inspectDraft.username}
                      onChange={(event) => setInspectDraft((d) => ({ ...d, username: event.target.value }))}
                      placeholder={t('如：admin')}
                    />
                  </label>
                  <label className="utility-command-field">
                    <span>{t('密码')}</span>
                    <input
                      type="password"
                      value={inspectDraft.password}
                      onChange={(event) => setInspectDraft((d) => ({ ...d, password: event.target.value }))}
                      placeholder="••••••"
                    />
                  </label>
                  <label className="utility-command-field inspect-remark-field">
                    <span>{t('备注')}</span>
                    <input
                      value={inspectDraft.remark}
                      onChange={(event) => setInspectDraft((d) => ({ ...d, remark: event.target.value }))}
                      placeholder={t('可选')}
                    />
                  </label>
                </div>
                <div className="inspect-editor-actions">
                  <button className="utility-text-button" type="button" onClick={() => setInspectEditorOpen(false)}>
                    {t('取消')}
                  </button>
                  <button className="utility-primary-button compact" type="button" onClick={saveInspectDevice} disabled={!inspectDraft.name.trim() || !inspectDraft.host.trim()}>
                    <Save size={14} />
                    {inspectEditingId ? t('保存修改') : t('保存设备')}
                  </button>
                </div>
              </div>
            )}

            <div className="inspect-device-list">
              {inspectDevices.length === 0 && (
                <div className="utility-empty">
                  <Activity size={18} />
                  <strong>{t('还没有巡检设备')}</strong>
                  <span>{t('点击"添加设备"录入你的服务器或网络设备。')}</span>
                </div>
              )}
              {inspectDevices.map((device) => (
                <div className="inspect-device-item" key={device.id}>
                  <label className="inspect-device-check">
                    <input
                      type="checkbox"
                      checked={selectedInspectIds.has(device.id)}
                      onChange={() => toggleInspectDevice(device.id)}
                    />
                  </label>
                  <div className="inspect-device-main">
                    <div className="inspect-device-title">
                      <strong>{device.name}</strong>
                      <em className={`inspect-vendor-tag vendor-${device.vendor}`}>{device.vendor}</em>
                    </div>
                    <div className="inspect-device-meta">
                      <span>{device.host}:{device.port}</span>
                      {device.username && <span>{device.username}</span>}
                      {device.remark && <span>{device.remark}</span>}
                    </div>
                  </div>
                  <div className="inspect-device-actions">
                    <IconButton label={t('编辑设备')} onClick={() => openInspectEditor(device)}>
                      <Edit3 size={14} />
                    </IconButton>
                    <IconButton label={t('删除设备')} onClick={() => confirmDeleteInspectDevice(device)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>

            <div className="inspect-exec-section">
              <div className="utility-section-head">
                <div>
                  <strong>{t('批量执行')}</strong>
                  <span>{t('勾选设备，配置要执行的命令。')}</span>
                </div>
                {inspectDevices.length > 0 && (
                  <button
                    className="utility-text-button"
                    type="button"
                    onClick={() =>
                      setSelectedInspectIds(
                        selectedInspectIds.size === inspectDevices.length
                          ? new Set()
                          : new Set(inspectDevices.map((d) => d.id)),
                      )
                    }
                  >
                    {selectedInspectIds.size === inspectDevices.length ? t('取消全选') : t('全选')}
                  </button>
                )}
              </div>

              {inspectCommands.length > 0 && (
                <div className="inspect-command-list">
                  {inspectCommands.map((item, index) => (
                    <div className="inspect-command-item" key={item.id}>
                      <div className="inspect-command-item-main">
                        <strong>{item.name}</strong>
                        <code>{item.command}</code>
                      </div>
                      <div className="inspect-command-item-actions">
                        <IconButton label={t('上移')} onClick={() => moveInspectCommand(item.id, -1)} disabled={index === 0}>
                          <ArrowUp size={13} />
                        </IconButton>
                        <IconButton label={t('下移')} onClick={() => moveInspectCommand(item.id, 1)} disabled={index === inspectCommands.length - 1}>
                          <ArrowDown size={13} />
                        </IconButton>
                        <IconButton label={t('移除命令')} onClick={() => removeInspectCommand(item.id)}>
                          <X size={13} />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="inspect-command-add-row">
                <input
                  value={inspectManualCommand}
                  onChange={(event) => setInspectManualCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addManualInspectCommand()
                    }
                  }}
                  placeholder={t('输入命令后回车添加')}
                />
                <button className="utility-primary-button compact" type="button" onClick={addManualInspectCommand} disabled={!inspectManualCommand.trim()}>
                  <Plus size={13} />
                  {t('添加')}
                </button>
                <button className="utility-text-button" type="button" onClick={() => setInspectTemplatePickerOpen((v) => !v)}>
                  {t('从模板选择')}
                </button>
              </div>

              {inspectTemplatePickerOpen && (
                <div className="inspect-template-picker">
                  <div className="inspect-template-search">
                    <input
                      value={inspectTemplateSearch}
                      onChange={(event) => setInspectTemplateSearch(event.target.value)}
                      placeholder={t('搜索命令模板')}
                    />
                  </div>
                  {(() => {
                    const recommendedVendors = new Set(
                      inspectDevices
                        .filter((d) => selectedInspectIds.has(d.id))
                        .map((d) => d.vendor),
                    )
                    const groups = new Map<string, Snippet[]>()
                    for (const snippet of snippets) {
                      if (
                        inspectTemplateSearch &&
                        !snippet.name.toLowerCase().includes(inspectTemplateSearch.toLowerCase()) &&
                        !snippet.command.toLowerCase().includes(inspectTemplateSearch.toLowerCase())
                      ) {
                        continue
                      }
                      const category = snippet.category || '未分类'
                      if (!groups.has(category)) groups.set(category, [])
                      groups.get(category)!.push(snippet)
                    }
                    const addedCommands = new Set(inspectCommands.map((item) => item.command))
                    return [...groups.entries()].map(([category, items]) => {
                      const recommended = recommendedVendors.size > 0 && [...recommendedVendors].some((v) => category.includes(v))
                      return (
                        <details className="inspect-template-group" key={category} open={recommended || Boolean(inspectTemplateSearch)}>
                          <summary className={recommended ? 'recommended' : undefined}>
                            {category}
                            <span>{items.length}</span>
                          </summary>
                          {items.map((snippet) => (
                            <div className="inspect-template-item" key={snippet.id}>
                              <div className="inspect-template-item-main">
                                <strong>{snippet.name}</strong>
                                <code>{snippet.command}</code>
                              </div>
                              <button
                                className="inspect-template-add"
                                type="button"
                                disabled={addedCommands.has(snippet.command)}
                                onClick={() => addSnippetToInspect(snippet)}
                              >
                                {addedCommands.has(snippet.command) ? t('已添加') : '+'}
                              </button>
                            </div>
                          ))}
                        </details>
                      )
                    })
                  })()}
                </div>
              )}

              <div className="inspect-exec-bar">
                <label className="inspect-concurrency">
                  <span>{t('并发')}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={inspectConcurrency}
                    onChange={(event) => setInspectConcurrency(Math.min(10, Math.max(1, Number(event.target.value) || 1)))}
                  />
                </label>
                <button
                  className="utility-primary-button"
                  type="button"
                  onClick={runInspectBatch}
                  disabled={inspectRunning || selectedInspectIds.size === 0 || inspectCommands.length === 0}
                >
                  <Activity size={14} />
                  {inspectRunning
                    ? inspectProgress
                      ? `${t('执行中…')} ${inspectProgress.current}/${inspectProgress.total}`
                      : t('执行中…')
                    : `${t('执行')} (${selectedInspectIds.size})`}
                </button>
                {inspectRunning && inspectProgress && (
                  <div className="inspect-progress-track">
                    <div
                      className="inspect-progress-fill"
                      style={{ width: `${(inspectProgress.current / Math.max(1, inspectProgress.total)) * 100}%` }}
                    />
                  </div>
                )}
                {inspectResults && !inspectRunning && (
                  <div className="inspect-export-actions">
                    <button className="utility-text-button" type="button" onClick={() => void exportInspectResults('json')}>
                      {t('导出 JSON')}
                    </button>
                    <button className="utility-text-button" type="button" onClick={() => void exportInspectResults('csv')}>
                      {t('导出 CSV')}
                    </button>
                  </div>
                )}
              </div>

              <div className="inspect-import-row">
                <button className="utility-text-button" type="button" onClick={() => void importInspectDevicesCsv()}>
                  {t('从 CSV 导入设备')}
                </button>
                <span className="inspect-import-hint">{t('CSV 列：name,host,port,username,password,vendor,remark')}</span>
              </div>

              {inspectResults && (
                <div className="inspect-results">
                  <div className="inspect-results-summary">
                    <strong>
                      {t('完成')}：{inspectResults.filter((r) => r.success).length}/{inspectResults.length}
                    </strong>
                    <span>
                      {inspectResults.filter((r) => !r.success).length > 0
                        ? `${t('失败')}：${inspectResults.filter((r) => !r.success).length}`
                        : t('全部成功')}
                    </span>
                    {(() => {
                      const critical = inspectResults.filter((r) => r.health === 'critical').length
                      const warn = inspectResults.filter((r) => r.health === 'warn').length
                      const ok = inspectResults.filter((r) => r.health === 'ok').length
                      return (
                        <span className="inspect-results-health">
                          {ok > 0 && <em className="health-ok">{t('正常')} {ok}</em>}
                          {warn > 0 && <em className="health-warn">{t('警告')} {warn}</em>}
                          {critical > 0 && <em className="health-critical">{t('严重')} {critical}</em>}
                        </span>
                      )
                    })()}
                  </div>
                  {inspectResults.map((result) => (
                    <div className={`inspect-result-item ${result.health === 'ok' ? 'ok' : result.health === 'warn' ? 'warn' : 'fail'}`} key={`${result.host}-${result.deviceName}`}>
                      <div className="inspect-result-header">
                        <span className={`inspect-result-dot ${result.health === 'ok' ? 'ok' : result.health === 'warn' ? 'warn' : 'fail'}`} />
                        <strong>{result.deviceName}</strong>
                        <em>{result.host}</em>
                        <em className={`inspect-health-badge health-${result.health}`}>
                          {result.health === 'ok' ? t('正常') : result.health === 'warn' ? t('警告') : result.health === 'critical' ? t('严重') : result.health}
                        </em>
                        <span className="inspect-result-time">{(result.durationMs / 1000).toFixed(1)}s</span>
                      </div>
                      {!result.success && result.error && <div className="inspect-result-error">{result.error}</div>}
                      {result.outputs.map((output, index) => (
                        <details className="inspect-command-output" key={index} open={!output.success || output.health === 'critical'}>
                          <summary>
                            <span className={`inspect-result-dot ${output.health === 'ok' ? 'ok' : output.health === 'warn' ? 'warn' : 'fail'}`} />
                            {output.command}
                            {output.issues.length > 0 && (
                              <em className="inspect-command-issues">
                                {output.issues.map((issue) => `⚠ ${issue}`).join(' · ')}
                              </em>
                            )}
                          </summary>
                          <pre>{output.output || t('（无输出）')}</pre>
                        </details>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </aside>
  )
}

function InspectToolbox({ onNotify }: { onNotify: (message: string) => void }) {
  const { t } = useAppLocale()
  const [discoverStart, setDiscoverStart] = useState('192.168.1.1')
  const [discoverEnd, setDiscoverEnd] = useState('192.168.1.254')
  const [discoverCustomPorts, setDiscoverCustomPorts] = useState('')
  const [discoverScanning, setDiscoverScanning] = useState(false)
  const [discoverElapsed, setDiscoverElapsed] = useState(0)
  const [discoverFinished, setDiscoverFinished] = useState(false)
  const [discoverError, setDiscoverError] = useState('')
  const [discoverRows, setDiscoverRows] = useState<Record<string, { name: string; open_ports: number[] | null }>>({})
  const [activeTool, setActiveTool] = useState<'discover' | 'ports' | 'ping' | 'subnet'>('discover')

  function parseCustomPorts(raw: string): number[] {
    return raw
      .split(/[,，;；\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535)
  }

  function ipCmp(a: string, b: string): number {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < 4; i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }

  useEffect(() => {
    const tasks = [
      listen<{ ip: string; name: string }>('inspect-scan-alive', (event) => {
        setDiscoverRows((prev) => ({ ...prev, [event.payload.ip]: { name: event.payload.name, open_ports: null } }))
      }).catch(() => () => undefined),
      listen<{ ip: string; open_ports: number[] }>('inspect-scan-port', (event) => {
        setDiscoverRows((prev) => ({
          ...prev,
          [event.payload.ip]: { name: prev[event.payload.ip]?.name ?? '', open_ports: event.payload.open_ports },
        }))
      }).catch(() => () => undefined),
    ]
    return () => {
      void Promise.all(tasks).then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()))
    }
  }, [])

  useEffect(() => {
    if (!discoverScanning) {
      setDiscoverElapsed(0)
      return
    }
    const start = Date.now()
    const timer = window.setInterval(() => setDiscoverElapsed((Date.now() - start) / 1000), 100)
    return () => window.clearInterval(timer)
  }, [discoverScanning])

  async function runScan() {
    if (discoverScanning) return
    setDiscoverScanning(true)
    setDiscoverFinished(false)
    setDiscoverError('')
    setDiscoverElapsed(0)
    setDiscoverRows({})
    try {
      const hits = await invoke<{ ip: string; name: string; open_ports: number[] }[]>('scan_inspect_network', {
        startIp: discoverStart,
        endIp: discoverEnd,
        customPorts: parseCustomPorts(discoverCustomPorts),
      })
      // 兜底合并（正常情况下事件已流式填充）
      setDiscoverRows((prev) => {
        const next = { ...prev }
        for (const hit of hits) next[hit.ip] = { name: hit.name, open_ports: hit.open_ports }
        return next
      })
      if (hits.length === 0) onNotify(t('范围内未发现在线设备'))
    } catch (reason) {
      const message = String(reason).replace(/^Error:\s*/i, '')
      setDiscoverError(message)
      onNotify(message)
    } finally {
      setDiscoverScanning(false)
      setDiscoverFinished(true)
    }
  }

  return (
    <div className="inspect-toolbox">
      <div className="inspect-toolbox-header">
        <strong>{t('小工具')}</strong>
        <span>{t('常用网络与运维小工具集合')}</span>
      </div>
      <div className="inspect-toolbar">
        {(
          [
            ['discover', <Wrench size={14} key="ic" />, t('网段发现')],
            ['ports', <Wifi size={14} key="ic" />, t('端口扫描')],
            ['ping', <Activity size={14} key="ic" />, t('Ping 工具')],
            ['subnet', <Network size={14} key="ic" />, t('子网计算器')],
          ] as const
        ).map(([tool, icon, label]) => (
          <button
            key={tool}
            type="button"
            className={`inspect-toolbar-btn${activeTool === tool ? ' active' : ''}`}
            onClick={() => setActiveTool(tool)}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="inspect-tool-panel">
        <div className="inspect-tool-pane" style={{ display: activeTool === 'discover' ? 'flex' : 'none' }}>
          <div className="inspect-toolbox-card">
            <div className="inspect-toolbox-card-head">
              <Wrench size={15} />
            <strong>{t('网段发现')}</strong>
            <span>{t('探测 IP 范围内在线设备及其开放端口（SSH/RDP/VNC/FTP/Telnet/HTTP/HTTPS + 自定义），在线即上屏，单次扫描最长 10 秒自动停止')}</span>
          </div>
          <div className="inspect-discover-row">
            <span className="inspect-discover-label">{t('IP 范围')}</span>
            <input
              value={discoverStart}
              onChange={(event) => setDiscoverStart(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runScan()
              }}
              placeholder="192.168.1.1"
              disabled={discoverScanning}
            />
            <span className="inspect-discover-dash">→</span>
            <input
              value={discoverEnd}
              onChange={(event) => setDiscoverEnd(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runScan()
              }}
              placeholder="192.168.1.254"
              disabled={discoverScanning}
            />
            <button className="utility-primary-button compact" type="button" onClick={() => void runScan()} disabled={discoverScanning}>
              <Search size={13} />
              {discoverScanning ? t('扫描中…') : t('开始扫描')}
            </button>
          </div>
          <div className="inspect-discover-row">
            <span className="inspect-discover-label">{t('自定义端口')}</span>
            <input
              value={discoverCustomPorts}
              onChange={(event) => setDiscoverCustomPorts(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runScan()
              }}
              placeholder={t('如 8080,8443，逗号分隔，可留空')}
              disabled={discoverScanning}
              style={{ flex: 1, maxWidth: 320 }}
            />
          </div>
          {discoverScanning && (
            <div className="inspect-scan-progress">
              <div className="inspect-scan-progress-bar" style={{ width: `${Math.min(100, (discoverElapsed / 10) * 100)}%` }} />
              <span>
                {t('扫描中')}… {Math.min(10, discoverElapsed).toFixed(1)}s/10s · {t('已发现')} {Object.keys(discoverRows).length} {t('台')}
              </span>
            </div>
          )}
          {(discoverScanning || discoverFinished || Object.keys(discoverRows).length > 0) && (
            <div className="inspect-scan-table-wrap inspect-fill-scroll">
              <table className="inspect-scan-table">
                <thead>
                  <tr>
                    <th>{t('IP 地址')}</th>
                    <th>{t('名称')}</th>
                    <th title="22">SSH</th>
                    <th title="3389">RDP</th>
                    <th title="5900">VNC</th>
                    <th title="21">FTP</th>
                    <th title="23">Telnet</th>
                    <th title="80">HTTP</th>
                    <th title="443">HTTPS</th>
                    <th>{t('自定义')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(discoverRows).length === 0 && (
                    <tr>
                      <td className="inspect-discover-empty" colSpan={10}>
                        {discoverError
                          ? `${t('扫描失败')}：${discoverError}`
                          : discoverFinished
                            ? `${t('扫描完成')} · ${t('未发现在线设备，请确认 IP 范围或本机网络')}`
                            : t('正在检测，在线设备将逐个出现…')}
                      </td>
                    </tr>
                  )}
                  {Object.entries(discoverRows)
                    .sort(([ipA], [ipB]) => ipCmp(ipA, ipB))
                    .map(([ip, row]) => {
                      const ports = row.open_ports
                      const mark = (port: number) =>
                        ports === null ? (
                          <span className="scan-port-pending">…</span>
                        ) : ports.includes(port) ? (
                          <span className="scan-port-on">✓</span>
                        ) : (
                          <span className="scan-port-off">✗</span>
                        )
                      const custom = parseCustomPorts(discoverCustomPorts)
                      return (
                        <tr key={ip}>
                          <td className="mono">{ip}</td>
                          <td>{row.name || '-'}</td>
                          <td>{mark(22)}</td>
                          <td>{mark(3389)}</td>
                          <td>{mark(5900)}</td>
                          <td>{mark(21)}</td>
                          <td>{mark(23)}</td>
                          <td>{mark(80)}</td>
                          <td>{mark(443)}</td>
                          <td>
                            {custom.length === 0 ? (
                              '-'
                            ) : (
                              <span className="inspect-custom-ports">
                                {custom.map((port) => (
                                  <span key={port}>
                                    {port}
                                    {mark(port)}
                                    {'  '}
                                  </span>
                                ))}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          )}
            </div>
          </div>
          <div className="inspect-tool-pane" style={{ display: activeTool === 'ports' ? 'flex' : 'none' }}>
            <PortScanTool onNotify={onNotify} />
          </div>
          <div className="inspect-tool-pane" style={{ display: activeTool === 'ping' ? 'flex' : 'none' }}>
            <PingTool onNotify={onNotify} />
          </div>
          <div className="inspect-tool-pane" style={{ display: activeTool === 'subnet' ? 'flex' : 'none' }}>
            <SubnetCalcTool />
          </div>
        </div>
    </div>
  )
}

// ==================== 小工具：端口扫描 ====================

const PORT_SERVICES: Record<number, string> = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 67: 'DHCP', 68: 'DHCP',
  80: 'HTTP', 110: 'POP3', 123: 'NTP', 143: 'IMAP', 161: 'SNMP', 389: 'LDAP',
  443: 'HTTPS', 445: 'SMB', 514: 'Syslog', 636: 'LDAPS', 993: 'IMAPS', 995: 'POP3S',
  1433: 'MSSQL', 1521: 'Oracle', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL',
  5900: 'VNC', 6379: 'Redis', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt', 8888: 'HTTP-Alt',
  9090: 'Web-Console', 9200: 'Elasticsearch', 11211: 'Memcached', 27017: 'MongoDB',
}

function parsePortList(raw: string): number[] {
  const out = new Set<number>()
  for (const part of raw.split(/[,，;；\s]+/)) {
    const p = part.trim()
    if (!p) continue
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(Number)
      if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b <= 65535 && a <= b) {
        for (let n = a; n <= b; n++) out.add(n)
      }
    } else {
      const n = Number(p)
      if (Number.isInteger(n) && n >= 1 && n <= 65535) out.add(n)
    }
  }
  return [...out].sort((a, b) => a - b)
}

function PortScanTool({ onNotify }: { onNotify: (message: string) => void }) {
  const { t } = useAppLocale()
  const [host, setHost] = useState('127.0.0.1')
  const [portsRaw, setPortsRaw] = useState('22,23,80,443,3389,5900')
  const [scanning, setScanning] = useState(false)
  const [rows, setRows] = useState<Record<number, boolean>>({})
  const [openPorts, setOpenPorts] = useState<number[]>([])
  const [scanned, setScanned] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)

  // 端口事件缓冲：全端口扫描事件可达数万条/秒，先入队 200ms 批量合并，避免 UI 卡死
  const portHitBufferRef = useRef<{ port: number; open: boolean }[]>([])
  const portProgressRef = useRef<{ scanned: number; total: number } | null>(null)

  useEffect(() => {
    const flush = window.setInterval(() => {
      const hits = portHitBufferRef.current
      if (hits.length === 0 && portProgressRef.current === null) return
      portHitBufferRef.current = []
      if (hits.length > 0) {
        setRows((prev) => {
          const next = { ...prev }
          for (const { port, open } of hits) next[port] = open
          return next
        })
        setOpenPorts((prev) => {
          const next = new Set(prev)
          for (const { port, open } of hits) if (open) next.add(port)
          return [...next].sort((a, b) => a - b)
        })
      }
      if (portProgressRef.current !== null) {
        setScanned(portProgressRef.current.scanned)
        setTotal(portProgressRef.current.total)
        portProgressRef.current = null
      }
    }, 200)
    return () => window.clearInterval(flush)
  }, [])

  useEffect(() => {
    const tasks = [
      listen<{ port: number; open: boolean }>('port-scan-hit', (event) => {
        portHitBufferRef.current.push({ port: event.payload.port, open: event.payload.open })
      }).catch(() => () => undefined),
      listen<{ scanned: number; total: number }>('port-scan-progress', (event) => {
        portProgressRef.current = { scanned: event.payload.scanned, total: event.payload.total }
      }).catch(() => () => undefined),
    ]
    return () => {
      void Promise.all(tasks).then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()))
    }
  }, [])

  async function runScan() {
    if (scanning) return
    const ports = parsePortList(portsRaw)
    if (ports.length === 0) {
      setError(t('端口列表为空，请输入端口或范围'))
      return
    }
    setScanning(true)
    setError('')
    setFinished(false)
    setRows({})
    setOpenPorts([])
    setScanned(0)
    setTotal(ports.length)
    try {
      const hits = await invoke<number[]>('scan_ports_tool', { host, ports })
      setOpenPorts((prev) => [...new Set([...prev, ...hits])].sort((a, b) => a - b))
    } catch (reason) {
      const message = String(reason).replace(/^Error:\s*/i, '')
      setError(message)
      onNotify(message)
    } finally {
      setScanning(false)
      setFinished(true)
    }
  }

  async function stopScan() {
    try {
      await invoke('stop_port_scan')
    } catch {
      // 忽略：后端扫描可能已结束
    }
    setScanning(false)
    setFinished(true)
  }

  return (
    <div className="inspect-toolbox-card">
      <div className="inspect-toolbox-card-head">
        <Wifi size={15} />
        <strong>{t('端口扫描')}</strong>
        <span>{t('扫描指定主机的端口开放情况（支持 IP/域名，范围如 1-1024,8080,8443），开放端口实时上屏')}</span>
      </div>
      <div className="inspect-discover-row">
        <span className="inspect-discover-label">{t('主机')}</span>
        <input
          value={host}
          onChange={(event) => setHost(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runScan()
          }}
          placeholder="192.168.1.1"
          disabled={scanning}
        />
        <span className="inspect-discover-dash">·</span>
        <input
          value={portsRaw}
          onChange={(event) => setPortsRaw(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runScan()
          }}
          placeholder="1-1024,8080,8443"
          disabled={scanning}
          style={{ flex: 1, maxWidth: 240 }}
        />
        <button className="utility-primary-button compact" type="button" onClick={() => (scanning ? void stopScan() : void runScan())}>
          <Search size={13} />
          {scanning ? t('停止') : t('开始扫描')}
        </button>
      </div>
      <div className="inspect-port-presets">
        {(
          [
            ['常用端口', '22,23,21,25,53,80,110,143,443,445,3306,3389,5432,5900,6379,8080,8443'],
            ['Web', '80,443,8080,8443'],
            ['1-1024', '1-1024'],
            ['全端口', '1-65535'],
          ] as const
        ).map(([name, raw]) => (
          <button key={name} type="button" className="inspect-preset-btn" disabled={scanning} onClick={() => setPortsRaw(raw)}>
            {name}
          </button>
        ))}
        <span className="inspect-preset-hint">{t('全端口约 1-2 分钟，建议用范围')}</span>
      </div>
      {scanning && (
        <div className="inspect-scan-progress">
          <div className="inspect-scan-progress-bar" style={{ width: `${total > 0 ? Math.min(100, (scanned / total) * 100) : 0}%` }} />
          <span>
            {t('扫描中')}… {scanned}/{total} · {t('已开放')} {openPorts.length} {t('个端口')}
          </span>
        </div>
      )}
      {(scanning || finished || Object.keys(rows).length > 0) && (
        <div className="inspect-scan-table-wrap inspect-fill-scroll">
          <table className="inspect-scan-table">
            <thead>
              <tr>
                <th>{t('端口')}</th>
                <th>{t('服务')}</th>
                <th>{t('状态')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(rows).length === 0 && (
                <tr>
                  <td className="inspect-discover-empty" colSpan={3}>
                    {error
                      ? `${t('扫描失败')}：${error}`
                      : finished
                        ? t('扫描完成，未发现开放端口')
                        : t('正在检测，开放端口将逐个出现…')}
                  </td>
                </tr>
              )}
              {Object.entries(rows)
                .filter(([, open]) => open)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([portStr]) => {
                  const port = Number(portStr)
                  return (
                    <tr key={port}>
                      <td className="mono">{port}</td>
                      <td>{PORT_SERVICES[port] ?? '-'}</td>
                      <td>
                        <span className="scan-port-on">✓ {t('开放')}</span>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ==================== 小工具：Ping（批量，对标 PingInfoView） ====================

interface PingBatchRow {
  seq: number
  ok: boolean
  rttMs: number
  ttl: number
  time: string
}

function parseHostList(raw: string): string[] {
  const out = new Set<string>()
  for (const part of raw.split(/[\n\r,，;；\s]+/)) {
    const p = part.trim()
    if (!p) continue
    const m = p.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})-(\d{1,3})$/)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      const c = Number(m[3])
      const d1 = Number(m[4])
      const d2 = Number(m[5])
      if (d1 <= d2 && d2 <= 255) {
        for (let n = d1; n <= d2; n++) out.add(`${a}.${b}.${c}.${n}`)
      }
    } else {
      out.add(p)
    }
  }
  return [...out]
}

interface PingSummary {
  ok: number
  fail: number
  rttSum: number
  lastOk: boolean | null
  lastOkTime: string
  lastFailTime: string
  curStreak: number
  maxStreak: number
  replyIp: string
}

function formatTime(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function PingTool({ onNotify }: { onNotify: (message: string) => void }) {
  const { t } = useAppLocale()
  const [hostsRaw, setHostsRaw] = useState('192.168.1.1\n192.168.1.2')
  const [count, setCount] = useState('10')
  const [timeoutMs, setTimeoutMs] = useState('500')
  const [monitor, setMonitor] = useState(false)
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<Record<string, PingSummary>>({})
  const [detail, setDetail] = useState<Record<string, { hostname: string; rows: PingBatchRow[] }>>({})
  const [selectedIp, setSelectedIp] = useState<string | null>(null)
  const [rounds, setRounds] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [finished, setFinished] = useState(false)

  // 高频事件缓冲：后端并行 ping 事件可达数百条/秒，先入队，200ms 批量合并更新一次，明细仍近实时
  const rowBufferRef = useRef<{ ip: string; ok: boolean; rttMs: number; ttl: number }[]>([])
  const seqRef = useRef(0)
  const runningRef = useRef(false)
  const monitorTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const flush = window.setInterval(() => {
      const batch = rowBufferRef.current
      if (batch.length === 0) return
      rowBufferRef.current = []
      const now = formatTime(new Date())
      setSummary((prev) => {
        const next = { ...prev }
        for (const { ip, ok, rttMs } of batch) {
          const cur = next[ip] ?? { ok: 0, fail: 0, rttSum: 0, lastOk: null, lastOkTime: '', lastFailTime: '', curStreak: 0, maxStreak: 0, replyIp: '' }
          next[ip] = {
            ok: cur.ok + (ok ? 1 : 0),
            fail: cur.fail + (ok ? 0 : 1),
            rttSum: ok ? cur.rttSum + rttMs : cur.rttSum,
            lastOk: ok,
            lastOkTime: ok ? now : cur.lastOkTime,
            lastFailTime: ok ? cur.lastFailTime : now,
            curStreak: ok ? 0 : cur.curStreak + 1,
            maxStreak: ok ? cur.maxStreak : Math.max(cur.maxStreak, cur.curStreak + 1),
            replyIp: cur.replyIp || ip,
          }
        }
        return next
      })
      setDetail((prev) => {
        const next = { ...prev }
        for (const { ip, ok, rttMs, ttl } of batch) {
          seqRef.current += 1
          const cur = next[ip] ?? { hostname: '', rows: [] }
          const rows = [...cur.rows, { seq: seqRef.current, ok, rttMs, ttl, time: now }]
          if (rows.length > 500) rows.splice(0, rows.length - 500)
          next[ip] = { hostname: cur.hostname, rows }
        }
        return next
      })
    }, 200)
    return () => window.clearInterval(flush)
  }, [])

  useEffect(() => {
    const tasks = [
      listen<{ ip: string; seq: number; ok: boolean; rtt_ms: number; ttl: number }>('ping-batch-row', (event) => {
        rowBufferRef.current.push({ ip: event.payload.ip, ok: event.payload.ok, rttMs: event.payload.rtt_ms, ttl: event.payload.ttl })
      }).catch(() => () => undefined),
      listen<{ host: string; message: string }>('ping-batch-error', (event) => {
        setErrors((prev) => (prev.includes(event.payload.host) ? prev : [...prev, event.payload.host]))
      }).catch(() => () => undefined),
    ]
    return () => {
      void Promise.all(tasks).then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()))
    }
  }, [])

  async function runOneRound(hosts: string[], n: number) {
    try {
      // 统计与明细一律以实时事件（ping-batch-row）为准，invoke 返回只补充主机名，避免重复计数
      const details = await invoke<{ ip: string; hostname: string; rows: PingBatchRow[] }[]>('ping_batch_tool', { hosts, count: n, timeoutMs: Math.max(200, Math.min(3000, Number(timeoutMs) || 500)) })
      const hostnames: Record<string, string> = {}
      for (const d of details) hostnames[d.ip] = d.hostname
      setDetail((prev) => {
        const next = { ...prev }
        for (const [ip, name] of Object.entries(hostnames)) {
          next[ip] = { hostname: name || prev[ip]?.hostname || '', rows: prev[ip]?.rows ?? [] }
        }
        return next
      })
      return true
    } catch (reason) {
      const message = String(reason).replace(/^Error:\s*/i, '')
      setErrors([message])
      onNotify(message)
      return false
    }
  }

  function stopPing() {
    runningRef.current = false
    if (monitorTimerRef.current !== null) {
      window.clearTimeout(monitorTimerRef.current)
      monitorTimerRef.current = null
    }
    setRunning(false)
    setFinished(true)
  }

  async function startPing() {
    if (runningRef.current) return
    const hosts = parseHostList(hostsRaw)
    if (hosts.length === 0) {
      setErrors([t('主机列表为空')])
      return
    }
    if (hosts.length > 128) {
      setErrors([t('最多支持 128 个主机同时探测')])
      return
    }
    const n = Math.max(1, Math.min(100, Number(count) || 10))
    setRunning(true)
    setErrors([])
    setFinished(false)
    setSummary({})
    setDetail({})
    setSelectedIp(null)
    setRounds(0)
    runningRef.current = true
    if (!monitor) {
      await runOneRound(hosts, n)
      runningRef.current = false
      setRunning(false)
      setFinished(true)
      return
    }
    // 持续监控：以轮开始为基准固定 1 秒周期（探测耗时从等待中扣除），不通主机也不会把间隔拖成 2 秒
    const tick = async () => {
      if (!runningRef.current) return
      setRounds((r) => r + 1)
      const roundStart = Date.now()
      await runOneRound(hosts, 1)
      if (!runningRef.current) return
      const elapsed = Date.now() - roundStart
      const wait = Math.max(0, 1000 - elapsed)
      monitorTimerRef.current = window.setTimeout(() => void tick(), wait)
    }
    await tick()
  }

  const lossPct = (row: PingSummary) => {
    const total = row.ok + row.fail
    return total > 0 ? ((row.fail / total) * 100).toFixed(1) : '0.0'
  }
  const avgMs = (row: PingSummary) => (row.ok > 0 ? (row.rttSum / row.ok).toFixed(1) : '-')

  const summaryIps = Object.keys(summary).sort()

  return (
    <div className="inspect-toolbox-card">
      <div className="inspect-toolbox-card-head">
        <Activity size={15} />
        <strong>{t('批量 Ping')}</strong>
        <span>{t('批量探测多个主机连通性，主表实时汇总；点击任意行查看该主机的逐次明细')}</span>
      </div>
      <div className="inspect-batch-inputs">
        <div className="inspect-batch-left">
          <span className="inspect-discover-label">{t('主机列表')}</span>
          <textarea
            value={hostsRaw}
            onChange={(event) => setHostsRaw(event.target.value)}
            placeholder={t('每行一个 IP/域名，支持范围如 192.168.1.1-10')}
            disabled={running}
            rows={4}
            spellCheck={false}
          />
        </div>
        <div className="inspect-batch-right">
          <div className="inspect-batch-right-grid">
            <div className="inspect-discover-row">
              <span className="inspect-discover-label">{t('次数')}</span>
              <input
                value={count}
                onChange={(event) => setCount(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void startPing()
                }}
                placeholder="10"
                disabled={running}
                style={{ width: 64 }}
                title={t('次数（1-100）')}
              />
            </div>
            <div className="inspect-discover-row">
              <span className="inspect-discover-label">{t('超时(ms)')}</span>
              <input
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void startPing()
                }}
                placeholder="500"
                disabled={running}
                style={{ width: 64 }}
                title={t('单次探测超时毫秒数（200-3000），越小探测越快，过小可能误报超时')}
              />
            </div>
            <label className="inspect-check-row">
              <input type="checkbox" checked={monitor} onChange={(event) => setMonitor(event.target.checked)} disabled={running} />
              <span>{t('持续监控（每秒一轮）')}</span>
            </label>
            <button className="utility-primary-button compact" type="button" onClick={() => (running ? stopPing() : void startPing())}>
              <RefreshCw size={13} />
              {running ? `${t('停止')} ${rounds}` : t('开始探测')}
            </button>
          </div>
        </div>
      </div>
      {errors.length > 0 && (
        <div className="inspect-discover-empty">
          {errors.map((e) => (
            <div key={e}>{t('探测失败')}：{e}</div>
          ))}
        </div>
      )}
      {(running || finished || summaryIps.length > 0) && (
        <div className="inspect-scan-table-wrap inspect-fill-scroll">
          <table className="inspect-scan-table">
            <thead>
              <tr>
                <th>{t('IP 地址')}</th>
                <th>{t('主机名')}</th>
                <th>{t('应答 IP')}</th>
                <th>{t('成功次数')}</th>
                <th>{t('失败次数')}</th>
                <th>{t('连续失败')}</th>
                <th>{t('最大连续失败')}</th>
                <th>{t('失败百分比')}</th>
                <th>{t('最后状态')}</th>
                <th>{t('最后成功')}</th>
                <th>{t('最后失败')}</th>
                <th>{t('平均用时')}</th>
              </tr>
            </thead>
            <tbody>
              {summaryIps.length === 0 && (
                <tr>
                  <td className="inspect-discover-empty" colSpan={12}>
                    {running ? t('正在探测，结果将实时出现…') : t('输入主机列表后开始探测')}
                  </td>
                </tr>
              )}
              {summaryIps.map((ip) => {
                const row = summary[ip]
                return (
                  <tr
                    key={ip}
                    className={selectedIp === ip ? 'inspect-ping-row-selected' : ''}
                    onClick={() => setSelectedIp(ip)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td className="mono">{ip}</td>
                    <td>{detail[ip]?.hostname || '-'}</td>
                    <td className="mono">{row.replyIp || ip}</td>
                    <td className="mono">{row.ok}</td>
                    <td className="mono">{row.fail}</td>
                    <td className="mono">{row.curStreak}</td>
                    <td className="mono">{row.maxStreak}</td>
                    <td className="mono">{lossPct(row)}%</td>
                    <td>
                      {row.lastOk === null ? (
                        <span className="scan-port-pending">…</span>
                      ) : row.lastOk ? (
                        <span className="scan-port-on">✓ {t('响应')}</span>
                      ) : (
                        <span className="scan-port-off">✗ {t('超时')}</span>
                      )}
                    </td>
                    <td className="mono">{row.lastOkTime || '-'}</td>
                    <td className="mono">{row.lastFailTime || '-'}</td>
                    <td className="mono">{row.ok > 0 ? `${avgMs(row)}ms` : '-'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {selectedIp && detail[selectedIp] && detail[selectedIp].rows.length > 0 && (
        <div className="inspect-ping-detail">
          <div className="inspect-ping-detail-head">
            <strong className="mono">{selectedIp}</strong>
            <span>{t('逐次明细')}</span>
          </div>
          <div className="inspect-scan-table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table className="inspect-scan-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('时间')}</th>
                  <th>{t('应答 IP')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('往返时间')}</th>
                  <th>TTL</th>
                </tr>
              </thead>
              <tbody>
                {detail[selectedIp].rows.map((row) => (
                  <tr key={row.seq}>
                    <td className="mono">{row.seq}</td>
                    <td className="mono">{row.time || '-'}</td>
                    <td className="mono">{selectedIp}</td>
                    <td>
                      {row.ok ? (
                        <span className="scan-port-on">✓ {t('响应')}</span>
                      ) : (
                        <span className="scan-port-off">✗ {t('超时')}</span>
                      )}
                    </td>
                    <td className="mono">{row.ok ? `${row.rttMs}ms` : '-'}</td>
                    <td className="mono">{row.ok ? row.ttl : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== 小工具：子网计算器（纯前端） ====================

interface SubnetResult {
  network: string
  broadcast: string
  mask: string
  maskBin: string
  wildcard: string
  hosts: number
  first: string
  last: string
}

function SubnetCalcTool() {
  const { t } = useAppLocale()
  const [cidr, setCidr] = useState('192.168.1.0/24')
  const [result, setResult] = useState<SubnetResult | null>(null)
  const [error, setError] = useState('')

  function calc() {
    const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/)
    if (!m) {
      setError(t('格式应为 IP/掩码位数，如 192.168.1.0/24'))
      setResult(null)
      return
    }
    const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    const prefix = Number(m[5])
    if (octets.some((o) => o > 255) || prefix > 32) {
      setError(t('IP 或掩码位数无效'))
      setResult(null)
      return
    }
    const ipU = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
    const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0)
    const network = (ipU & mask) >>> 0
    const broadcast = (network | ~mask) >>> 0
    const hosts = prefix >= 31 ? (prefix === 32 ? 1 : 2) : Math.max(0, 2 ** (32 - prefix) - 2)
    const toIp = (v: number) => `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`
    setResult({
      network: toIp(network),
      broadcast: toIp(broadcast),
      mask: toIp(mask),
      maskBin: [0, 1, 2, 3].map((i) => ((mask >>> (24 - i * 8)) & 255).toString(2).padStart(8, '0')).join('.'),
      wildcard: toIp(~mask >>> 0),
      hosts,
      first: hosts === 0 ? toIp(network) : toIp((network + 1) >>> 0),
      last: hosts === 0 ? toIp(broadcast) : toIp((broadcast - 1) >>> 0),
    })
    setError('')
  }

  return (
    <div className="inspect-toolbox-card">
      <div className="inspect-toolbox-card-head">
        <Network size={15} />
        <strong>{t('子网计算器')}</strong>
        <span>{t('输入 CIDR 网段，自动计算网络地址、广播地址、掩码与可用主机范围')}</span>
      </div>
      <div className="inspect-discover-row">
        <span className="inspect-discover-label">CIDR</span>
        <input
          value={cidr}
          onChange={(event) => setCidr(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') calc()
          }}
          placeholder="192.168.1.0/24"
          style={{ maxWidth: 220 }}
        />
        <button className="utility-primary-button compact" type="button" onClick={calc}>
          <Search size={13} />
          {t('计算')}
        </button>
      </div>
      {error && <div className="inspect-discover-empty">{error}</div>}
      {result && (
        <div className="inspect-subnet-results">
          <div className="inspect-subnet-grid">
            <div>
              <span>{t('网络地址')}</span>
              <strong className="mono">{result.network}</strong>
            </div>
            <div>
              <span>{t('广播地址')}</span>
              <strong className="mono">{result.broadcast}</strong>
            </div>
            <div>
              <span>{t('子网掩码')}</span>
              <strong className="mono">{result.mask}</strong>
            </div>
            <div>
              <span>{t('可用主机数')}</span>
              <strong>{result.hosts}</strong>
            </div>
            <div>
              <span>{t('可用 IP 范围')}</span>
              <strong className="mono">
                {result.first} - {result.last}
              </strong>
            </div>
            <div>
              <span>{t('通配符掩码')}</span>
              <strong className="mono">{result.wildcard}</strong>
            </div>
          </div>
          <div className="inspect-subnet-maskbin">
            <span>{t('掩码二进制')}</span>
            <code className="mono">{result.maskBin}</code>
          </div>
        </div>
      )}
    </div>
  )
}

function InspectWorkspace({
  inspectDevices,
  onAddInspectDevice,
  onUpdateInspectDevice,
  onDeleteInspectDevice,
  onNotify,
  snippets,
  selectedInspectIds,
  setSelectedInspectIds,
  inspectCommands,
  setInspectCommands,
  inspectRunning,
  setInspectRunning,
  inspectResults,
  setInspectResults,
  inspectConcurrency,
  setInspectConcurrency,
  inspectProgress,
  setInspectProgress,
}: {
  inspectDevices: InspectDevice[]
  onAddInspectDevice: (device: Omit<InspectDevice, 'id'>) => void
  onUpdateInspectDevice: (id: string, patch: Partial<Omit<InspectDevice, 'id'>>) => void
  onDeleteInspectDevice: (id: string) => void
  onNotify: (message: string) => void
  snippets: Snippet[]
  selectedInspectIds: Set<string>
  setSelectedInspectIds: (value: Set<string> | ((current: Set<string>) => Set<string>)) => void
  inspectCommands: { id: string; name: string; command: string }[]
  setInspectCommands: (value: { id: string; name: string; command: string }[] | ((current: { id: string; name: string; command: string }[]) => { id: string; name: string; command: string }[])) => void
  inspectRunning: boolean
  setInspectRunning: (value: boolean) => void
  inspectResults: InspectExecResult[] | null
  setInspectResults: (value: InspectExecResult[] | null | ((current: InspectExecResult[] | null) => InspectExecResult[] | null)) => void
  inspectConcurrency: number
  setInspectConcurrency: (value: number) => void
  inspectProgress: { current: number; total: number } | null
  setInspectProgress: (value: { current: number; total: number } | null) => void
}) {
  const { t } = useAppLocale()
  const [inspectEditingId, setInspectEditingId] = useState<string | null>(null)
  const [inspectEditorOpen, setInspectEditorOpen] = useState(false)
  const [inspectDraft, setInspectDraft] = useState<Omit<InspectDevice, 'id'>>({
    name: '',
    host: '',
    port: 22,
    username: '',
    password: '',
    vendor: 'linux',
    remark: '',
  })
  const [inspectManualCommand, setInspectManualCommand] = useState('')
  const [inspectTemplatePickerOpen, setInspectTemplatePickerOpen] = useState(false)
  const [inspectTemplateSearch, setInspectTemplateSearch] = useState('')
  // 重置后丢弃本次巡检返回的结果（执行中无法中断，返回时不再写入界面）
  const discardInspectResultRef = useRef(false)
  const [inspectLogDir, setInspectLogDir] = useState('')
  const [inspectLogDirBusy, setInspectLogDirBusy] = useState(false)
  const [inspectView, setInspectView] = useState<InspectWorkspaceView>('workbench')
  const [inspectPlans, setInspectPlans] = useState<InspectPlan[]>(() => {
    try {
      const raw = localStorage.getItem('rain.inspectPlans')
      if (raw) {
        const list: unknown = JSON.parse(raw)
        if (Array.isArray(list)) return list as InspectPlan[]
      }
    } catch {
      /* ignore */
    }
    return []
  })
  const [inspectPlanEditor, setInspectPlanEditor] = useState<InspectPlan | null>(null)
  const [inspectPlanCmdDraft, setInspectPlanCmdDraft] = useState('')
  const [inspectPlanRunning, setInspectPlanRunning] = useState<Set<string>>(new Set())
  const inspectPlanRunningRef = useRef<Set<string>>(new Set())
  function updatePlanRunning(next: Set<string>) {
    inspectPlanRunningRef.current = next
    setInspectPlanRunning(next)
  }
  const [inspectVendors, setInspectVendors] = useState<string[]>(() => readInspectVendors())
  const [inspectVendorsOpen, setInspectVendorsOpen] = useState(false)
  const [inspectVendorInput, setInspectVendorInput] = useState('')
  const [inspectHistory, setInspectHistory] = useState<InspectHistoryMeta[] | null>(null)
  const [inspectHistoryDetail, setInspectHistoryDetail] = useState<InspectHistoryRecord | null>(null)
  const [inspectRules, setInspectRules] = useState<InspectRuleConfig[] | null>(null)
  const [inspectRuleDraft, setInspectRuleDraft] = useState<InspectRuleConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    void invoke<string>('get_inspect_log_dir')
      .then((path) => {
        if (!cancelled) setInspectLogDir(path)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  async function saveInspectLogDir() {
    if (inspectLogDirBusy) return
    setInspectLogDirBusy(true)
    try {
      const saved = await invoke<string>('set_inspect_log_dir', { path: inspectLogDir })
      setInspectLogDir(saved)
      onNotify(t('巡检日志保存路径已更新'))
    } catch (reason) {
      onNotify(String(reason).replace(/^Error:\s*/i, ''))
    } finally {
      setInspectLogDirBusy(false)
    }
  }

  async function browseInspectLogDir() {
    try {
      const picked = await invoke<string | null>('pick_inspect_log_dir')
      if (!picked) return
      // 选中目录后立即校验并写入配置，无需再手动点保存
      const saved = await invoke<string>('set_inspect_log_dir', { path: picked })
      setInspectLogDir(saved)
      onNotify(t('巡检日志保存路径已更新'))
    } catch (reason) {
      onNotify(String(reason).replace(/^Error:\s*/i, ''))
    }
  }

  async function openInspectEditor(device?: InspectDevice) {
    if (device) {
      setInspectEditingId(device.id)
      let password = device.password
      if (device.encryptedPassword) {
        try {
          password = await invoke<string>('decrypt_secret', { cipher: device.encryptedPassword })
        } catch {
          password = ''
        }
      }
      setInspectDraft({
        name: device.name,
        host: device.host,
        port: device.port,
        username: device.username,
        password,
        vendor: device.vendor,
        remark: device.remark,
        encryptedPassword: device.encryptedPassword ?? '',
      })
    } else {
      setInspectEditingId(null)
      setInspectDraft({ name: '', host: '', port: 22, username: '', password: '', vendor: 'linux', remark: '', encryptedPassword: '' })
    }
    setInspectEditorOpen(true)
  }

  async function saveInspectDevice() {
    if (!inspectDraft.name.trim() || !inspectDraft.host.trim()) return
    let encryptedPassword = inspectDraft.encryptedPassword ?? ''
    if (inspectDraft.password) {
      try {
        encryptedPassword = await invoke<string>('encrypt_secret', { plain: inspectDraft.password })
      } catch (reason) {
        onNotify(t('密码加密失败，设备未保存：') + String(reason).replace(/^Error:\s*/i, ''))
        return
      }
    }
    const base = {
      name: inspectDraft.name,
      host: inspectDraft.host,
      port: Number(inspectDraft.port) || 22,
      username: inspectDraft.username,
      password: '',
      vendor: inspectDraft.vendor,
      remark: inspectDraft.remark,
      encryptedPassword,
    }
    if (inspectEditingId) {
      onUpdateInspectDevice(inspectEditingId, base)
      onNotify(t('设备已更新'))
    } else {
      onAddInspectDevice(base)
      onNotify(t('设备已添加'))
    }
    setInspectEditorOpen(false)
  }

  function confirmDeleteInspectDevice(device: InspectDevice) {
    const confirmed = window.confirm(`删除设备「${device.name}」？`)
    if (!confirmed) return
    onDeleteInspectDevice(device.id)
    setSelectedInspectIds((current) => {
      const next = new Set(current)
      next.delete(device.id)
      return next
    })
    onNotify(t('设备已删除'))
  }

  async function runInspectBatch() {
    const selectedDevices = await resolveInspectPasswords(inspectDevices.filter((d) => selectedInspectIds.has(d.id)))
    const commandList = inspectCommands
      .map((item) => ({ name: item.name, command: item.command.trim() }))
      .filter((item) => item.command.length > 0)
    if (selectedDevices.length === 0 || commandList.length === 0) return

    setInspectRunning(true)
    setInspectResults(null)
    setInspectProgress({ current: 0, total: selectedDevices.length })
    try {
      const safeConcurrency = Math.min(200, Math.max(1, Math.floor(inspectConcurrency) || 1))
      if (safeConcurrency !== inspectConcurrency) {
        onNotify(t('并发数最高为 200，已自动调整为 200'))
        setInspectConcurrency(safeConcurrency)
      }
      const results = await invoke<InspectExecResult[]>('batch_execute_inspect', {
        devices: selectedDevices.map((d) => ({
          name: d.name,
          host: d.host,
          port: d.port,
          username: d.username,
          password: d.password,
          vendor: d.vendor,
        })),
        commands: commandList,
        concurrency: safeConcurrency,
      })
      if (discardInspectResultRef.current) return
      setInspectResults(results)
      // P0：执行完成后自动保存到巡检历史（不阻塞界面，失败静默）
      void invoke('save_inspect_history', { results }).catch(() => undefined)
    } catch (reason) {
      if (discardInspectResultRef.current) return
      const message = String(reason).replace(/^Error:\s*/i, '')
      setInspectResults([
        {
          deviceName: t('执行失败'),
          host: '',
          success: false,
          error: message,
          outputs: [],
          durationMs: 0,
          health: 'critical',
        },
      ])
    } finally {
      setInspectRunning(false)
      setInspectProgress(null)
    }
  }

  function toggleInspectDevice(id: string) {
    setSelectedInspectIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  async function openInspectLogDir() {
    try {
      await invoke('open_inspect_log_dir')
    } catch (reason) {
      onNotify(String(reason).replace(/^Error:\s*/i, ''))
    }
  }

  function resetInspectWorkspace() {
    const message = inspectRunning
      ? t('重置将清空巡检工作台（结果、设备勾选、命令列表）；当前巡检仍在执行中，本次返回的结果会被丢弃，但不会中断正在执行的命令。确定继续吗？')
      : t('重置将清空巡检工作台（结果、设备勾选、命令列表）。确定继续吗？')
    if (!window.confirm(message)) return

    // 标记丢弃本次巡检的返回结果（执行中的 invoke 无法中断，返回后不再写入界面）
    discardInspectResultRef.current = true
    setSelectedInspectIds(new Set())
    setInspectCommands([])
    setInspectResults(null)
    setInspectProgress(null)
    setInspectConcurrency(5)
    setInspectRunning(false)
    onNotify(t('巡检工作台已重置'))
  }

  function toggleSelectAll() {
    setSelectedInspectIds(
      selectedInspectIds.size === inspectDevices.length
        ? new Set()
        : new Set(inspectDevices.map((d) => d.id)),
    )
  }

  function addInspectCommand(name: string, command: string) {
    if (!command.trim()) return
    const id = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setInspectCommands((current) => [...current, { id, name: name || t('自定义命令'), command: command.trim() }])
  }

  function removeInspectCommand(id: string) {
    setInspectCommands((current) => current.filter((item) => item.id !== id))
  }

  function moveInspectCommand(id: string, direction: -1 | 1) {
    setInspectCommands((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  function addManualInspectCommand() {
    if (!inspectManualCommand.trim()) return
    addInspectCommand(t('自定义命令'), inspectManualCommand)
    setInspectManualCommand('')
  }

  function addSnippetToInspect(snippet: Snippet) {
    addInspectCommand(snippet.name, snippet.command)
  }

  function escapeCsvCell(value: string): string {
    if (/[",\n\r]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`
    }
    return value
  }

  function healthLabel(health: string): string {
    return health === 'ok' ? t('正常') : health === 'warn' ? t('警告') : health === 'critical' ? t('严重') : health
  }

  function vendorLabel(vendor: string): string {
    const map: Record<string, string> = {
      linux: 'Linux',
      huawei: t('华为'),
      h3c: t('华三'),
      ruijie: t('锐捷'),
      zte: t('中兴'),
      other: t('通用'),
    }
    return map[vendor] ?? vendor
  }

  function openInspectLogPath(path: string) {
    void invoke('open_inspect_log_file', { path }).catch((reason) =>
      onNotify(`打开日志失败：${String(reason).replace(/^Error:\s*/i, '')}`),
    )
  }

  async function exportInspectResultsCsv() {
    if (!inspectResults) {
      onNotify(t('暂无巡检结果，请先执行巡检后再导出'))
      return
    }
    const date = new Date().toISOString().slice(0, 10)
    try {
      const header = ['设备名称', '主机', '健康状态', '执行结果', '耗时(秒)', '命令', '判断依据', '日志文件'].map(escapeCsvCell).join(',')
      const rows = inspectResults.map((result) => {
        const commands = result.outputs.map((output) => output.command).join(' | ')
        const issues = result.outputs.flatMap((output) => output.issues).join('; ') || '-'
        const logFile = result.logPath ?? ''
        return [result.deviceName, result.host, healthLabel(result.health), result.success ? t('成功') : t('失败'), (result.durationMs / 1000).toFixed(1), commands, issues, logFile]
          .map(escapeCsvCell)
          .join(',')
      })
      const savedPath = await invoke<string | null>('save_text_export', {
        suggestedName: `巡检汇总-${date}.csv`,
        content: `\uFEFF${[header, ...rows].join('\r\n')}`,
        filter: 'csv',
      })
      if (savedPath) {
        onNotify(`${t('已导出')}：${savedPath}`)
      }
    } catch (reason) {
      onNotify(`导出失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  async function importInspectTableCsv() {
    try {
      const text = await invoke<string | null>('open_text_import', { filter: 'csv' })
      if (!text) return
      const rows = parseCsvRows(text.replace(/^\uFEFF/, ''))
      if (rows.length === 0) {
        onNotify(t('表格文件为空'))
        return
      }
      const header = rows[0].map((cell) => cell.trim().toLowerCase())
      const nameIndex = header.indexOf('name')
      const hostIndex = header.indexOf('host')
      const portIndex = header.indexOf('port')
      const usernameIndex = header.indexOf('username')
      const passwordIndex = header.indexOf('password')
      const vendorIndex = header.indexOf('vendor')
      const remarkIndex = header.indexOf('remark')
      const commandsIndex = header.indexOf('commands')
      if (hostIndex < 0) {
        onNotify(t('表格缺少 host 列（请先下载模板参考列名）'))
        return
      }

      // 设备（按 host 去重）
      const existingHosts = new Set(inspectDevices.map((d) => d.host))
      let added = 0
      let skipped = 0
      for (const row of rows.slice(1)) {
        const host = (row[hostIndex] ?? '').trim()
        if (!host) continue
        if (existingHosts.has(host)) {
          skipped += 1
          continue
        }
        existingHosts.add(host)
        const vendor = vendorIndex >= 0 ? (row[vendorIndex] ?? '').trim().toLowerCase() : 'linux'
        onAddInspectDevice({
          name: (nameIndex >= 0 ? row[nameIndex] ?? '' : '').trim() || host,
          host,
          port: portIndex >= 0 ? Number(row[portIndex]) || 22 : 22,
          username: (usernameIndex >= 0 ? row[usernameIndex] ?? '' : '').trim(),
          password: (passwordIndex >= 0 ? row[passwordIndex] ?? '' : '').trim(),
          vendor: vendor || 'linux',
          remark: (remarkIndex >= 0 ? row[remarkIndex] ?? '' : '').trim(),
        })
        added += 1
      }

      // 命令（替换当前命令列表；commands 列内多条命令用 | 或换行分隔）
      let commandCount = 0
      const importedCommands: { id: string; name: string; command: string }[] = []
      if (commandsIndex >= 0) {
        for (const row of rows.slice(1)) {
          const raw = (row[commandsIndex] ?? '').replace(/\r\n/g, '\n')
          if (!raw.trim()) continue
          const pieces = raw
            .split('\n')
            .flatMap((line) => line.split('|'))
            .map((piece) => piece.trim())
            .filter((piece) => piece.length > 0)
          for (const command of pieces) {
            importedCommands.push({
              id: `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              name: command.length > 48 ? `${command.slice(0, 48)}…` : command,
              command,
            })
            commandCount += 1
          }
        }
        if (importedCommands.length > 0) {
          setInspectCommands(importedCommands)
        }
      }

      const parts: string[] = [`${t('表格导入成功')}：${added} 台设备、${commandCount} 条命令`]
      if (skipped > 0) parts.push(`${t('跳过已存在设备')} ${skipped} 台`)
      onNotify(parts.join('，'))
    } catch (reason) {
      onNotify(`表格导入失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  async function downloadInspectTemplate() {
    const header = ['name', 'host', 'port', 'username', 'password', 'vendor', 'remark', 'commands'].join(',')
    const example = ['核心交换机', '10.1.1.1', '22', 'admin', 'password', 'huawei', '机房A', 'display version | display device'].map(escapeCsvCell).join(',')
    try {
      await invoke('save_text_export', {
        suggestedName: '巡检导入模板.csv',
        content: `\uFEFF${[header, example].join('\r\n')}`,
        filter: 'csv',
      })
    } catch (reason) {
      onNotify(`模板下载失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }
  function persistInspectVendors(next: string[]) {
    setInspectVendors(next)
    try {
      localStorage.setItem('rain.inspectVendors', JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  function addInspectVendor() {
    const name = inspectVendorInput.trim()
    if (!name) {
      onNotify(t('请输入厂商名称'))
      return
    }
    if (inspectVendors.includes(name)) {
      onNotify(t('厂商已存在'))
      return
    }
    persistInspectVendors([...inspectVendors, name])
    setInspectVendorInput('')
    onNotify(t('厂商已添加'))
  }

  function removeInspectVendor(vendor: string) {
    if (!window.confirm(t('确定删除厂商') + `「${vendor}」吗？` + t('已添加设备的厂商标记保留，但不再出现在下拉选项中'))) {
      return
    }
    persistInspectVendors(inspectVendors.filter((v) => v !== vendor))
    onNotify(t('厂商已删除'))
  }

  function formatDateTime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function planTimeLabel(plan: InspectPlan): string {
    return `${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`
  }

  function planFrequencyLabel(plan: InspectPlan): string {
    if (plan.frequency === 'daily') return `${t('每天')} ${planTimeLabel(plan)}`
    if (plan.frequency === 'weekly') {
      const names = ['日', '一', '二', '三', '四', '五', '六']
      const days = (plan.weekdays ?? []).length ? (plan.weekdays ?? []).map((w) => t('周') + names[w]).join('、') : '-'
      return `${t('每周')} ${days} ${planTimeLabel(plan)}`
    }
    if (plan.frequency === 'monthly') return `${t('每月')} ${plan.monthDay}${t('号')} ${planTimeLabel(plan)}`
    return `${t('每')} ${plan.intervalHours} ${t('小时')}`
  }

  function planNextRun(plan: InspectPlan, from: Date): Date | null {
    if (plan.frequency === 'interval') {
      return new Date(from.getTime() + (plan.intervalHours || 1) * 3600 * 1000)
    }
    if (plan.frequency === 'daily') {
      const d = new Date(from)
      d.setHours(plan.hour, plan.minute, 0, 0)
      if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1)
      return d
    }
    if (plan.frequency === 'weekly') {
      const days = (plan.weekdays ?? []).filter((w) => w >= 0 && w <= 6)
      if (!days.length) return null
      for (let i = 1; i <= 8; i++) {
        const d = new Date(from)
        d.setDate(from.getDate() + i)
        if (days.includes(d.getDay())) {
          d.setHours(plan.hour, plan.minute, 0, 0)
          if (d.getTime() > from.getTime()) return d
        }
      }
      return null
    }
    // monthly
    const day = Math.min(Math.max(plan.monthDay || 1, 1), 28)
    let candidate = new Date(from.getFullYear(), from.getMonth(), day, plan.hour, plan.minute, 0, 0)
    if (candidate.getTime() <= from.getTime()) {
      const nextMonth = new Date(from.getFullYear(), from.getMonth() + 1, 1)
      const maxDay = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate()
      candidate = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), Math.min(day, maxDay), plan.hour, plan.minute, 0, 0)
    }
    return candidate
  }

  function persistInspectPlans(next: InspectPlan[]) {
    setInspectPlans(next)
    try {
      localStorage.setItem('rain.inspectPlans', JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  function openPlanEditor(plan?: InspectPlan) {
    setInspectPlanCmdDraft(plan ? plan.commands.map((c) => c.command).join('\n') : '')
    setInspectPlanEditor(
      plan
        ? { ...plan }
        : {
            id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            name: '',
            deviceIds: [],
            commands: [],
            concurrency: 5,
            frequency: 'daily',
            weekdays: [1, 2, 3, 4, 5],
            monthDay: 1,
            hour: 0,
            minute: 0,
            intervalHours: 24,
            enabled: true,
            lastRunAt: null,
            nextRunAt: null,
          },
    )
  }

  function togglePlanDevice(id: string) {
    setInspectPlanEditor((prev) =>
      prev ? { ...prev, deviceIds: prev.deviceIds.includes(id) ? prev.deviceIds.filter((x) => x !== id) : [...prev.deviceIds, id] } : prev,
    )
  }

  function togglePlanWeekday(day: number) {
    setInspectPlanEditor((prev) =>
      prev
        ? { ...prev, weekdays: prev.weekdays.includes(day) ? prev.weekdays.filter((x) => x !== day) : [...prev.weekdays, day].sort() }
        : prev,
    )
  }

  function savePlanDraft() {
    if (!inspectPlanEditor) return
    if (!inspectPlanEditor.name.trim()) {
      onNotify(t('请输入计划名称'))
      return
    }
    if (inspectPlanEditor.deviceIds.length === 0) {
      onNotify(t('请至少选择一台设备'))
      return
    }
    const commands = inspectPlanCmdDraft
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((cmd) => ({ name: cmd.slice(0, 30), command: cmd }))
    if (commands.length === 0) {
      onNotify(t('请至少输入一条命令'))
      return
    }
    const exists = inspectPlans.some((p) => p.id === inspectPlanEditor.id)
    const now = new Date()
    const next = planNextRun({ ...inspectPlanEditor, commands }, now)
    const draft: InspectPlan = {
      ...inspectPlanEditor,
      commands,
      nextRunAt: next ? formatDateTime(next) : null,
      lastRunAt: exists ? inspectPlanEditor.lastRunAt : null,
    }
    const nextPlans = exists ? inspectPlans.map((p) => (p.id === draft.id ? draft : p)) : [...inspectPlans, draft]
    persistInspectPlans(nextPlans)
    setInspectPlanEditor(null)
    onNotify(t('计划已保存，到点将自动执行'))
  }

  function deletePlan(plan: InspectPlan) {
    if (!window.confirm(t('确定删除计划') + `「${plan.name}」吗？`)) return
    persistInspectPlans(inspectPlans.filter((p) => p.id !== plan.id))
    if (inspectPlanEditor?.id === plan.id) setInspectPlanEditor(null)
    onNotify(t('计划已删除'))
  }

  function togglePlanEnabled(plan: InspectPlan) {
    const enabled = !plan.enabled
    const next: InspectPlan = { ...plan, enabled }
    if (enabled) {
      const nextTime = planNextRun(next, new Date())
      next.nextRunAt = nextTime ? formatDateTime(nextTime) : null
    }
    persistInspectPlans(inspectPlans.map((p) => (p.id === plan.id ? next : p)))
    onNotify(enabled ? t('计划已启用') : t('计划已停用'))
  }

  async function executePlanNow(plan: InspectPlan) {
    const devices = await resolveInspectPasswords(inspectDevices.filter((d) => plan.deviceIds.includes(d.id)))
    const commands = plan.commands.map((c) => ({ name: c.name, command: c.command.trim() })).filter((c) => c.command.length > 0)
    if (devices.length === 0 || commands.length === 0) {
      onNotify(`${t('计划')}「${plan.name}」${t('没有可用设备或命令，请先编辑计划')}`)
      return
    }
    if (inspectPlanRunningRef.current.has(plan.id)) return
    updatePlanRunning(new Set(inspectPlanRunningRef.current).add(plan.id))
    try {
      const safeConcurrency = Math.min(200, Math.max(1, Math.floor(plan.concurrency) || 1))
      const results = await invoke<InspectExecResult[]>('batch_execute_inspect', {
        devices: devices.map((d) => ({
          name: d.name,
          host: d.host,
          port: d.port,
          username: d.username,
          password: d.password,
          vendor: d.vendor,
        })),
        commands,
        concurrency: safeConcurrency,
      })
      if (!discardInspectResultRef.current) {
        setInspectResults(results)
        void invoke('save_inspect_history', { results }).catch(() => undefined)
        const ok = results.filter((r) => r.success).length
        onNotify(`${t('计划')}「${plan.name}」${t('执行完成：')}${ok}/${results.length}${t('台设备成功')}`)
      }
      const now = new Date()
      const next = planNextRun(plan, now)
      const updated = inspectPlans.map((p) =>
        p.id === plan.id ? { ...p, lastRunAt: formatDateTime(now), nextRunAt: next ? formatDateTime(next) : null } : p,
      )
      persistInspectPlans(updated)
    } catch (reason) {
      if (!discardInspectResultRef.current) {
        onNotify(`${t('计划')}「${plan.name}」${t('执行失败：')}${String(reason).replace(/^Error:\s*/i, '')}`)
      }
    } finally {
      const nextSet = new Set(inspectPlanRunningRef.current)
      nextSet.delete(plan.id)
      updatePlanRunning(nextSet)
    }
  }

  // 定时器：每 10 秒检查是否有到点的启用计划
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      for (const plan of inspectPlans) {
        if (!plan.enabled || inspectPlanRunningRef.current.has(plan.id)) continue
        if (plan.nextRunAt && new Date(plan.nextRunAt).getTime() <= now) {
          void executePlanNow(plan)
        }
      }
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [inspectPlans, inspectDevices])

  async function loadInspectHistory() {
    try {
      const list = await invoke<InspectHistoryMeta[]>('list_inspect_history')
      setInspectHistory(list)
    } catch (reason) {
      onNotify(`读取巡检历史失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  async function viewInspectHistory(id: string) {
    try {
      const record = await invoke<InspectHistoryRecord | null>('get_inspect_history', { id })
      if (!record) {
        onNotify(t('历史记录不存在或已被删除'))
        return
      }
      setInspectHistoryDetail(record)
    } catch (reason) {
      onNotify(`读取历史详情失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  async function deleteInspectHistory(id: string) {
    if (!window.confirm(t('确定删除这条巡检历史吗？'))) return
    try {
      const removed = await invoke<boolean>('delete_inspect_history', { id })
      if (removed) onNotify(t('历史记录已删除'))
      setInspectHistoryDetail(null)
      void loadInspectHistory()
    } catch (reason) {
      onNotify(`删除历史失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  async function exportInspectHistoryHtml(record: InspectHistoryRecord) {
    try {
      const html = buildInspectHtmlReport(record)
      const savedPath = await invoke<string | null>('save_text_export', {
        suggestedName: `巡检报告-${record.id}.html`,
        content: html,
        filter: 'html',
      })
      if (savedPath) onNotify(`${t('报告已导出')}：${savedPath}`)
    } catch (reason) {
      onNotify(`导出报告失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  function openRuleEditor(rule?: InspectRuleConfig) {
    setInspectRuleDraft(
      rule
        ? { ...rule }
        : {
            id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            vendor: inspectVendors[0] ?? 'linux',
            commandContains: '',
            severity: 'warn',
            type: 'keyword',
            keyword: '',
            missingKeyword: '',
            threshold: 80,
            percent: true,
            label: '',
            enabled: true,
          },
    )
  }

  function closeRuleEditor() {
    setInspectRuleDraft(null)
  }

  async function loadInspectRules() {
    try {
      const list = await invoke<InspectRuleConfig[]>('get_inspect_rules')
      setInspectRules(list)
    } catch (reason) {
      onNotify(`读取规则失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  async function saveInspectRules(next: InspectRuleConfig[]) {
    try {
      await invoke('save_inspect_rules', { rules: next })
      setInspectRules(next)
      onNotify(`${t('规则已保存')}（${next.length} 条生效）`)
    } catch (reason) {
      onNotify(`保存规则失败：${String(reason).replace(/^Error:\s*/i, '')}`)
    }
  }

  function saveRuleDraft() {
    if (!inspectRuleDraft) return
    if (!inspectRuleDraft.vendor.trim() || !inspectRuleDraft.label.trim()) {
      onNotify(t('厂商与说明不能为空'))
      return
    }
    if (inspectRuleDraft.type === 'threshold' && (inspectRuleDraft.threshold === null || inspectRuleDraft.threshold === undefined || !Number.isFinite(inspectRuleDraft.threshold))) {
      onNotify(t('阈值规则需要填写数值'))
      return
    }
    if ((inspectRuleDraft.type === 'keyword' || inspectRuleDraft.type === 'missing') && !(inspectRuleDraft.keyword ?? '').trim() && !(inspectRuleDraft.missingKeyword ?? '').trim()) {
      onNotify(t('关键词规则需要填写关键词'))
      return
    }
    const next = [...(inspectRules ?? [])]
    const index = next.findIndex((r) => r.id === inspectRuleDraft.id)
    if (index >= 0) {
      next[index] = { ...inspectRuleDraft }
    } else {
      next.push({ ...inspectRuleDraft })
    }
    setInspectRules(next)
    setInspectRuleDraft(null)
    onNotify(t('规则已修改，点击保存后生效'))
  }

  function deleteRule(rule: InspectRuleConfig) {
    if (!inspectRules) return
    const next = inspectRules.filter((r) => r.id !== rule.id)
    setInspectRules(next)
    onNotify(t('规则已移除，点击保存后生效'))
  }

  function toggleRuleEnabled(rule: InspectRuleConfig) {
    if (!inspectRules) return
    const next = inspectRules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r))
    setInspectRules(next)
    onNotify(t('规则状态已修改，点击保存后生效'))
  }



  function parseCsvRows(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let cell = ''
    let inQuotes = false
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            cell += '"'
            i += 1
          } else {
            inQuotes = false
          }
        } else {
          cell += char
        }
      } else if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        row.push(cell)
        cell = ''
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i += 1
        row.push(cell)
        cell = ''
        rows.push(row)
        row = []
      } else {
        cell += char
      }
    }
    if (cell.length > 0 || row.length > 0) {
      row.push(cell)
      rows.push(row)
    }
    return rows
  }

  const allSelected = inspectDevices.length > 0 && selectedInspectIds.size === inspectDevices.length

  return (
    <section className="inspect-workspace">
      <header className="inspect-workspace-header">
        <div className="inspect-workspace-title">
          <Activity size={16} />
          <strong>{t('自动化')}</strong>
          <span>{t('管理巡检设备，批量执行命令并自动判断故障。')}</span>
        </div>
        <div className="inspect-workspace-actions">
          <button
            className="utility-text-button"
            type="button"
            onClick={() => void downloadInspectTemplate()}
            title={t('下载带示例的 CSV 模板，用 Excel 打开填写后导入')}
          >
            <Download size={13} />
            {t('下载模板')}
          </button>
          <button
            className="utility-text-button"
            type="button"
            onClick={() => void importInspectTableCsv()}
            title={t('CSV 表格：name,host,port,username,password,vendor,remark,commands（多条命令用 | 分隔）')}
          >
            <Upload size={13} />
            {t('表格导入')}
          </button>
          <button className="utility-primary-button compact" type="button" onClick={() => openInspectEditor()}>
            <Plus size={13} />
            {t('添加设备')}
          </button>
          <button className="utility-text-button danger compact" type="button" onClick={() => void resetInspectWorkspace()}>
            <RotateCcw size={13} />
            {t('重置')}
          </button>
        </div>
      </header>

      <div className="inspect-tabs">
        <button type="button" className={`inspect-tab${inspectView === 'workbench' ? ' active' : ''}`} onClick={() => setInspectView('workbench')}>
          {t('巡检工作台')}
        </button>
        <button type="button" className={`inspect-tab${inspectView === 'history' ? ' active' : ''}`} onClick={() => { setInspectView('history'); void loadInspectHistory() }}>
          {t('巡检历史')}
        </button>
        <button type="button" className={`inspect-tab${inspectView === 'rules' ? ' active' : ''}`} onClick={() => { setInspectView('rules'); void loadInspectRules() }}>
          {t('故障规则')}
        </button>
        <button type="button" className={`inspect-tab${inspectView === 'plans' ? ' active' : ''}`} onClick={() => setInspectView('plans')}>
          {t('巡检计划')}
        </button>
      </div>
      {inspectView === 'workbench' && (
        <>

      <div className="inspect-workspace-body">
        <div className="inspect-device-pane">
          <div className="inspect-pane-head">
            <strong>{t('设备列表')} ({inspectDevices.length})</strong>
            <button className="utility-text-button" type="button" onClick={() => setInspectVendorsOpen((open) => !open)}>
              <Settings2 size={13} />
              {t('管理厂商')}
            </button>
            {inspectDevices.length > 0 && (
              <button className="utility-text-button" type="button" onClick={toggleSelectAll}>
                {allSelected ? t('取消全选') : t('全选')}
              </button>
            )}
          </div>

          {inspectVendorsOpen && (
            <div className="inspect-vendor-manager">
              <div className="inspect-vendor-manager-row">
                <input
                  value={inspectVendorInput}
                  onChange={(event) => setInspectVendorInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addInspectVendor()
                  }}
                  placeholder={t('输入新厂商，如 深信服，回车或点添加')}
                />
                <button className="utility-primary-button compact" type="button" onClick={addInspectVendor}>
                  <Plus size={13} />
                  {t('添加')}
                </button>
                <button className="utility-text-button compact" type="button" onClick={() => setInspectVendorsOpen(false)}>
                  <X size={13} />
                  {t('收起')}
                </button>
              </div>
              <div className="inspect-vendor-manager-list">
                {inspectVendors.map((vendor) => (
                  <span key={vendor} className="inspect-vendor-chip">
                    {vendor}
                    <button type="button" title={t('删除厂商')} onClick={() => removeInspectVendor(vendor)}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="inspect-vendor-manager-hint">
                {t('厂商列表永久保存；删除后已添加设备的厂商标记保留，仅不再出现在下拉选项中')}
              </div>
            </div>
          )}

          {inspectEditorOpen && (
            <div className="inspect-device-form-card">
              <div className="inspect-pane-head">
                <strong>{inspectEditingId ? t('编辑设备') : t('添加设备')}</strong>
                <button className="utility-text-button" type="button" onClick={() => setInspectEditorOpen(false)}>
                  <X size={13} />
                  {t('收起')}
                </button>
              </div>
              <div className="inspect-device-form">
                <label>
                  <span>{t('名称')}</span>
                  <input value={inspectDraft.name} onChange={(e) => setInspectDraft({ ...inspectDraft, name: e.target.value })} placeholder="Centos-Web-01" />
                </label>
                <label>
                  <span>{t('主机')}</span>
                  <input value={inspectDraft.host} onChange={(e) => setInspectDraft({ ...inspectDraft, host: e.target.value })} placeholder="192.168.1.10" />
                </label>
                <label>
                  <span>{t('端口')}</span>
                  <input type="number" min={1} max={65535} value={inspectDraft.port} onChange={(e) => setInspectDraft({ ...inspectDraft, port: Number(e.target.value) || 22 })} />
                </label>
                <label>
                  <span aria-hidden="true" />
                  <select value={inspectDraft.vendor} onChange={(e) => setInspectDraft({ ...inspectDraft, vendor: e.target.value })}>
                    {inspectVendors.map((vendor) => (
                      <option key={vendor} value={vendor}>{vendor}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t('账号')}</span>
                  <input value={inspectDraft.username} onChange={(e) => setInspectDraft({ ...inspectDraft, username: e.target.value })} placeholder="root" />
                </label>
                <label>
                  <span>{t('密码')}</span>
                  <input type="password" value={inspectDraft.password} onChange={(e) => setInspectDraft({ ...inspectDraft, password: e.target.value })} />
                </label>
                <label className="inspect-device-form-full">
                  <span>{t('备注')}</span>
                  <input value={inspectDraft.remark} onChange={(e) => setInspectDraft({ ...inspectDraft, remark: e.target.value })} />
                </label>
              </div>
              <div className="inspect-device-form-actions">
                <button className="utility-primary-button" type="button" onClick={saveInspectDevice} disabled={!inspectDraft.name.trim() || !inspectDraft.host.trim()}>
                  <Save size={13} />
                  {inspectEditingId ? t('保存修改') : t('保存设备')}
                </button>
              </div>
            </div>
          )}

          <div className="inspect-device-list">
            {inspectDevices.length === 0 && !inspectEditorOpen && (
              <div className="utility-empty">
                <Activity size={18} />
                <strong>{t('还没有巡检设备')}</strong>
                <span>{t('点击"添加设备"录入你的服务器或网络设备。')}</span>
              </div>
            )}
            {inspectDevices.map((device) => (
              <div className="inspect-device-item" key={device.id}>
                <label className="inspect-device-check">
                  <input
                    type="checkbox"
                    checked={selectedInspectIds.has(device.id)}
                    onChange={() => toggleInspectDevice(device.id)}
                  />
                </label>
                <div className="inspect-device-main">
                  <div className="inspect-device-title">
                    <strong>{device.name}</strong>
                    <em className={`inspect-vendor-tag vendor-${device.vendor}`}>{device.vendor}</em>
                  </div>
                  <div className="inspect-device-meta">
                    <span>{device.host}:{device.port}</span>
                    {device.username && <span>{device.username}</span>}
                    {device.remark && <span>{device.remark}</span>}
                  </div>
                </div>
                <div className="inspect-device-actions">
                  <IconButton label={t('编辑设备')} onClick={() => openInspectEditor(device)}>
                    <Edit3 size={14} />
                  </IconButton>
                  <IconButton label={t('删除设备')} onClick={() => confirmDeleteInspectDevice(device)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="inspect-command-pane">
          <div className="inspect-pane-head">
            <strong>{t('命令配置')}</strong>
            <span>{inspectCommands.length > 0 ? `${inspectCommands.length} ${t('条命令')}` : ''}</span>
          </div>

          {inspectCommands.length > 0 && (
            <div className="inspect-command-list">
              {inspectCommands.map((item, index) => (
                <div className="inspect-command-item" key={item.id}>
                  <div className="inspect-command-item-main">
                    <strong>{item.name}</strong>
                    <code>{item.command}</code>
                  </div>
                  <div className="inspect-command-item-actions">
                    <IconButton label={t('上移')} onClick={() => moveInspectCommand(item.id, -1)} disabled={index === 0}>
                      <ArrowUp size={13} />
                    </IconButton>
                    <IconButton label={t('下移')} onClick={() => moveInspectCommand(item.id, 1)} disabled={index === inspectCommands.length - 1}>
                      <ArrowDown size={13} />
                    </IconButton>
                    <IconButton label={t('移除命令')} onClick={() => removeInspectCommand(item.id)}>
                      <X size={13} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="inspect-command-add-row">
            <input
              value={inspectManualCommand}
              onChange={(event) => setInspectManualCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addManualInspectCommand()
                }
              }}
              placeholder={t('输入命令后回车添加')}
            />
            <button className="utility-primary-button compact" type="button" onClick={addManualInspectCommand} disabled={!inspectManualCommand.trim()}>
              <Plus size={13} />
              {t('添加')}
            </button>
            <button className="utility-text-button" type="button" onClick={() => setInspectTemplatePickerOpen((v) => !v)}>
              {t('从模板选择')}
            </button>
          </div>

          {inspectTemplatePickerOpen && (
            <div className="inspect-template-picker">
              <div className="inspect-template-search">
                <input
                  value={inspectTemplateSearch}
                  onChange={(event) => setInspectTemplateSearch(event.target.value)}
                  placeholder={t('搜索命令模板')}
                />
              </div>
              {(() => {
                const recommendedVendors = new Set(
                  inspectDevices
                    .filter((d) => selectedInspectIds.has(d.id))
                    .map((d) => d.vendor),
                )
                const groups = new Map<string, Snippet[]>()
                for (const snippet of snippets) {
                  if (
                    inspectTemplateSearch &&
                    !snippet.name.toLowerCase().includes(inspectTemplateSearch.toLowerCase()) &&
                    !snippet.command.toLowerCase().includes(inspectTemplateSearch.toLowerCase())
                  ) {
                    continue
                  }
                  const category = snippet.category || '未分类'
                  if (!groups.has(category)) groups.set(category, [])
                  groups.get(category)!.push(snippet)
                }
                const addedCommands = new Set(inspectCommands.map((item) => item.command))
                return [...groups.entries()].map(([category, items]) => {
                  const recommended = recommendedVendors.size > 0 && [...recommendedVendors].some((v) => category.includes(v))
                  return (
                    <details className="inspect-template-group" key={category} open={recommended || Boolean(inspectTemplateSearch)}>
                      <summary className={recommended ? 'recommended' : undefined}>
                        {category}
                        <span>{items.length}</span>
                      </summary>
                      {items.map((snippet) => (
                        <div className="inspect-template-item" key={snippet.id}>
                          <div className="inspect-template-item-main">
                            <strong>{snippet.name}</strong>
                            <code>{snippet.command}</code>
                          </div>
                          <button
                            className="inspect-template-add"
                            type="button"
                            disabled={addedCommands.has(snippet.command)}
                            onClick={() => addSnippetToInspect(snippet)}
                          >
                            {addedCommands.has(snippet.command) ? t('已添加') : '+'}
                          </button>
                        </div>
                      ))}
                    </details>
                  )
                })
              })()}
            </div>
          )}

          <div className="inspect-exec-bar">
            <label className="inspect-concurrency">
              <span>{t('并发')}</span>
              <input
                type="number"
                min={1}
                max={200}
                value={inspectConcurrency}
                title={t('最大并发数 200')}
                onChange={(event) => {
                  const raw = Number(event.target.value)
                  if (!Number.isFinite(raw)) return
                  setInspectConcurrency(Math.floor(raw))
                }}
                onBlur={() => {
                  const value = inspectConcurrency
                  if (value > 200) {
                    onNotify(t('并发数最高为 200，已自动调整为 200'))
                    setInspectConcurrency(200)
                  } else if (value < 1) {
                    setInspectConcurrency(1)
                  }
                }}
              />
            </label>
            <button
              className="utility-primary-button"
              type="button"
              onClick={runInspectBatch}
              disabled={inspectRunning || selectedInspectIds.size === 0 || inspectCommands.length === 0}
            >
              <Activity size={14} />
              {inspectRunning
                ? inspectProgress
                  ? `${t('执行中…')} ${inspectProgress.current}/${inspectProgress.total}`
                  : t('执行中…')
                : `${t('执行')} (${selectedInspectIds.size})`}
            </button>
            {inspectRunning && inspectProgress && (
              <div className="inspect-progress-track">
                <div
                  className="inspect-progress-fill"
                  style={{ width: `${(inspectProgress.current / Math.max(1, inspectProgress.total)) * 100}%` }}
                />
              </div>
            )}
            {inspectResults && !inspectRunning && (
              <div className="inspect-export-actions">
                <button className="utility-text-button" type="button" onClick={() => void exportInspectResultsCsv()}>
                  <Download size={13} />
                  {t('导出表格')}
                </button>
              </div>
            )}
          </div>
          <div className="inspect-log-settings">
            <span className="inspect-log-settings-label">
              <FileClock size={13} />
              {t('巡检日志')}
            </span>
            <input
              value={inspectLogDir}
              onChange={(event) => setInspectLogDir(event.target.value)}
              placeholder={t('日志保存路径，默认软件运行目录')}
              title={inspectLogDir}
              spellCheck={false}
            />
            <button className="utility-text-button" type="button" onClick={() => void browseInspectLogDir()}>
              {t('浏览…')}
            </button>
            <button className="utility-text-button" type="button" onClick={() => void saveInspectLogDir()} disabled={inspectLogDirBusy}>
              {t('应用路径')}
            </button>
            <button className="utility-text-button" type="button" onClick={() => void openInspectLogDir()}>
              {t('打开目录')}
            </button>
          </div>
        </div>
      </div>

      {inspectResults && (
        <section className="inspect-results-pane">
          <div className="inspect-results">
            <div className="inspect-results-summary">
              <strong>
                {t('完成')}：{inspectResults.filter((r) => r.success).length}/{inspectResults.length}
              </strong>
              <span>
                {inspectResults.filter((r) => !r.success).length > 0
                  ? `${t('失败')}：${inspectResults.filter((r) => !r.success).length}`
                  : t('全部成功')}
              </span>
              {(() => {
                const critical = inspectResults.filter((r) => r.health === 'critical').length
                const warn = inspectResults.filter((r) => r.health === 'warn').length
                const ok = inspectResults.filter((r) => r.health === 'ok').length
                return (
                  <span className="inspect-results-health">
                    {ok > 0 && <em className="health-ok">{t('正常')} {ok}</em>}
                    {warn > 0 && <em className="health-warn">{t('警告')} {warn}</em>}
                    {critical > 0 && <em className="health-critical">{t('严重')} {critical}</em>}
                  </span>
                )
              })()}
            </div>
            <div className="inspect-results-grid">
              {inspectResults.map((result) => (
                <div className={`inspect-result-item ${result.health === 'ok' ? 'ok' : result.health === 'warn' ? 'warn' : 'fail'}`} key={`${result.host}-${result.deviceName}`}>
                  <div className="inspect-result-header">
                    <span className={`inspect-result-dot ${result.health === 'ok' ? 'ok' : result.health === 'warn' ? 'warn' : 'fail'}`} />
                    <strong>{result.deviceName}</strong>
                    <em>{result.host}</em>
                    <em className={`inspect-health-badge health-${result.health}`}>
                      {healthLabel(result.health)}
                    </em>
                    <span className="inspect-result-time">{(result.durationMs / 1000).toFixed(1)}s</span>
                    {result.logPath && (
                      <button
                        className="inspect-log-open"
                        type="button"
                        title={result.logPath}
                        onClick={() => void openInspectLogDir()}
                      >
                        <FolderOpen size={12} />
                        {t('日志')}
                      </button>
                    )}
                  </div>
                  {!result.success && result.error && <div className="inspect-result-error">{result.error}</div>}
                  {result.outputs.map((output, index) => (
                    <details className="inspect-command-output" key={index} open={!output.success || output.health === 'critical'}>
                      <summary>
                        <span className={`inspect-result-dot ${output.health === 'ok' ? 'ok' : output.health === 'warn' ? 'warn' : 'fail'}`} />
                        {output.command}
                        {output.issues.length > 0 && (
                          <em className="inspect-command-issues">
                            {output.issues.map((issue) => `⚠ ${issue}`).join(' · ')}
                          </em>
                        )}
                      </summary>
                      <pre>{output.output || t('（无输出）')}</pre>
                    </details>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
        </>
      )}

      {inspectView === 'history' && (
        inspectHistoryDetail ? (
          <div className="inspect-history-detail">
            <div className="inspect-history-detail-header">
              <button className="utility-text-button compact" type="button" onClick={() => setInspectHistoryDetail(null)}>
                <ChevronLeft size={13} />
                {t('返回列表')}
              </button>
              <div className="inspect-history-detail-title">
                <strong>{t('巡检历史')} · {inspectHistoryDetail.id}</strong>
                <span>{inspectHistoryDetail.savedAt}</span>
              </div>
              <div className="inspect-workspace-actions">
                <button className="utility-text-button compact" type="button" onClick={() => void exportInspectHistoryHtml(inspectHistoryDetail)}>
                  <Download size={13} />
                  {t('导出报告')}
                </button>
                <button className="utility-text-button danger compact" type="button" onClick={() => void deleteInspectHistory(inspectHistoryDetail.id)}>
                  <Trash2 size={13} />
                  {t('删除')}
                </button>
              </div>
            </div>
            <div className="inspect-history-stats">
              <span className="inspect-stat-chip">{t('设备')} {inspectHistoryDetail.meta.deviceCount}</span>
              <span className="inspect-stat-chip">{t('命令')} {inspectHistoryDetail.meta.commandCount}</span>
              <span className="inspect-stat-chip ok">{t('成功')} {inspectHistoryDetail.meta.successCount}</span>
              <span className="inspect-stat-chip err">{t('失败')} {inspectHistoryDetail.meta.failCount}</span>
              <span className="inspect-stat-chip crit">{t('严重')} {inspectHistoryDetail.meta.criticalCount}</span>
              <span className="inspect-stat-chip warn">{t('警告')} {inspectHistoryDetail.meta.warnCount}</span>
            </div>
            <div className="inspect-history-devices">
              {inspectHistoryDetail.results.map((result) => (
                <details key={result.host + result.deviceName} className="inspect-result-item" open>
                  <summary>
                    <span className={`inspect-health-badge ${result.health}`}>{healthLabel(result.health)}</span>
                    <strong>{result.deviceName}</strong>
                    <span className="inspect-result-meta">
                      {result.host} · {result.success ? t('连接成功') : t('连接失败')} · {(result.durationMs / 1000).toFixed(1)}s
                    </span>
                    {result.logPath && (
                      <button className="utility-text-button compact" type="button" onClick={(event) => { event.preventDefault(); if (result.logPath) void openInspectLogPath(result.logPath) }}>
                        <FolderOpen size={12} />
                        {t('打开日志')}
                      </button>
                    )}
                  </summary>
                  {result.error && <div className="inspect-result-error">{result.error}</div>}
                  <div className="inspect-result-outputs">
                    {result.outputs.map((output, index) => (
                      <div key={index} className="inspect-result-command">
                        <div className="inspect-result-command-head">
                          <code>{output.command}</code>
                          {output.issues.length > 0 && (
                            <em className="inspect-command-issues">{output.issues.map((issue) => `⚠ ${issue}`).join(' · ')}</em>
                          )}
                        </div>
                        <pre>{output.output || t('（无输出）')}</pre>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </div>
        ) : (
          <div className="inspect-history-list">
            <div className="inspect-history-list-header">
              <strong>{t('巡检历史')}</strong>
              <span>{t('每次巡检完成后自动保存，重启软件不丢失')}</span>
              <button className="utility-text-button compact" type="button" onClick={() => void loadInspectHistory()}>
                <RefreshCw size={13} />
                {t('刷新')}
              </button>
            </div>
            {!inspectHistory ? (
              <div className="inspect-empty">{t('加载中…')}</div>
            ) : inspectHistory.length === 0 ? (
              <div className="inspect-empty">{t('暂无巡检历史，执行一次巡检后会自动保存')}</div>
            ) : (
              <table className="inspect-history-table">
                <thead>
                  <tr>
                    <th>{t('记录 ID')}</th>
                    <th>{t('时间')}</th>
                    <th>{t('设备')}</th>
                    <th>{t('命令')}</th>
                    <th>{t('成功/失败')}</th>
                    <th>{t('严重/警告')}</th>
                    <th>{t('操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {inspectHistory.map((meta) => (
                    <tr key={meta.id}>
                      <td className="mono">{meta.id}</td>
                      <td>{meta.savedAt}</td>
                      <td>{meta.deviceCount}</td>
                      <td>{meta.commandCount}</td>
                      <td>{meta.successCount} / {meta.failCount}</td>
                      <td>
                        <span className={`inspect-history-count${meta.criticalCount > 0 ? ' crit' : ''}`}>{meta.criticalCount}</span>
                        <span className={`inspect-history-count${meta.warnCount > 0 ? ' warn' : ''}`}>{meta.warnCount}</span>
                      </td>
                      <td>
                        <button className="utility-text-button compact" type="button" onClick={() => void viewInspectHistory(meta.id)}>{t('查看')}</button>
                        <button className="utility-text-button danger compact" type="button" onClick={() => void deleteInspectHistory(meta.id)}>{t('删除')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      )}

      {inspectView === 'rules' && (
        <div className="inspect-rules-pane">
          <div className="inspect-rules-header">
            <div className="inspect-rules-header-text">
              <strong>{t('故障判断规则')}</strong>
              <span>{t('规则按厂商与命令匹配，支持关键词 / 缺失关键词 / 数值阈值三种判断方式')}</span>
            </div>
            <div className="inspect-workspace-actions">
              <button className="utility-primary-button compact" type="button" onClick={() => openRuleEditor()}>
                <Plus size={13} />
                {t('新增规则')}
              </button>
              <button className="utility-primary-button compact" type="button" onClick={() => void saveInspectRules(inspectRules ?? [])}>
                <Save size={13} />
                {t('保存规则')}
              </button>
            </div>
          </div>
          {inspectRuleDraft && (
            <div className="inspect-rule-editor">
              <div className="inspect-rule-editor-title">
                <strong>{inspectRules?.some((r) => r.id === inspectRuleDraft.id) ? t('编辑规则') : t('新增规则')}</strong>
                <button className="utility-text-button compact" type="button" onClick={closeRuleEditor}>
                  <X size={13} />
                  {t('关闭')}
                </button>
              </div>
              <div className="inspect-rule-form">
                <label>
                  <span>{t('适用厂商')}</span>
                  <select value={inspectRuleDraft.vendor} onChange={(event) => setInspectRuleDraft({ ...inspectRuleDraft, vendor: event.target.value })}>
                    {inspectVendors.map((vendor) => (
                      <option key={vendor} value={vendor}>{vendor}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t('匹配命令包含')}</span>
                  <input value={inspectRuleDraft.commandContains} onChange={(event) => setInspectRuleDraft({ ...inspectRuleDraft, commandContains: event.target.value })} placeholder={t('如 df -h 或 display version')} />
                </label>
                <label>
                  <span>{t('判断方式')}</span>
                  <select value={inspectRuleDraft.type} onChange={(event) => setInspectRuleDraft({ ...inspectRuleDraft, type: event.target.value as InspectRuleType })}>
                    <option value="keyword">{t('输出包含关键词')}</option>
                    <option value="missing">{t('输出缺少关键词')}</option>
                    <option value="threshold">{t('数值超过阈值')}</option>
                  </select>
                </label>
                {(inspectRuleDraft.type === 'keyword' || inspectRuleDraft.type === 'missing') && (
                  <label>
                    <span>{inspectRuleDraft.type === 'keyword' ? t('命中关键词') : t('缺失关键词')}</span>
                    <input
                      value={inspectRuleDraft.type === 'keyword' ? (inspectRuleDraft.keyword ?? '') : (inspectRuleDraft.missingKeyword ?? '')}
                      onChange={(event) =>
                        setInspectRuleDraft(
                          inspectRuleDraft.type === 'keyword'
                            ? { ...inspectRuleDraft, keyword: event.target.value }
                            : { ...inspectRuleDraft, missingKeyword: event.target.value },
                        )
                      }
                    />
                  </label>
                )}
                {inspectRuleDraft.type === 'threshold' && (
                  <>
                    <label>
                      <span>{t('阈值')}</span>
                      <input type="number" value={inspectRuleDraft.threshold ?? 80} onChange={(event) => setInspectRuleDraft({ ...inspectRuleDraft, threshold: Number(event.target.value) })} />
                    </label>
                    <label className="inspect-rule-check">
                      <input type="checkbox" checked={inspectRuleDraft.percent} onChange={(event) => setInspectRuleDraft({ ...inspectRuleDraft, percent: event.target.checked })} />
                      <span>{t('按百分比取值（使用率类规则）')}</span>
                    </label>
                  </>
                )}
                <label>
                  <span>{t('健康等级')}</span>
                  <select value={inspectRuleDraft.severity} onChange={(event) => setInspectRuleDraft({ ...inspectRuleDraft, severity: event.target.value })}>
                    <option value="warn">{t('警告')}</option>
                    <option value="critical">{t('严重')}</option>
                  </select>
                </label>
                <label>
                  <span>{t('判断说明')}</span>
                  <input value={inspectRuleDraft.label} onChange={(event) => setInspectRuleDraft({ ...inspectRuleDraft, label: event.target.value })} placeholder={t('命中后显示的原因，如 磁盘使用率过高')} />
                </label>
                <label className="inspect-rule-check">
                  <input type="checkbox" checked={inspectRuleDraft.enabled} onChange={(event) => setInspectRuleDraft({ ...inspectRuleDraft, enabled: event.target.checked })} />
                  <span>{t('启用该规则')}</span>
                </label>
              </div>
              <div className="inspect-rule-editor-actions">
                <button className="utility-primary-button compact" type="button" onClick={saveRuleDraft}>{t('应用修改')}</button>
                <button className="utility-text-button compact" type="button" onClick={closeRuleEditor}>{t('取消')}</button>
              </div>
            </div>
          )}
          {!inspectRules ? (
            <div className="inspect-empty">{t('加载中…')}</div>
          ) : (
            <div className="inspect-rules-table-wrap">
              <table className="inspect-history-table inspect-rules-table">
                <thead>
                  <tr>
                    <th>{t('厂商')}</th>
                    <th>{t('匹配命令')}</th>
                    <th>{t('判断方式')}</th>
                    <th>{t('条件')}</th>
                    <th>{t('等级')}</th>
                    <th>{t('说明')}</th>
                    <th>{t('启用')}</th>
                    <th>{t('操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {inspectRules.map((rule) => (
                    <tr key={rule.id} className={rule.enabled ? '' : 'rule-disabled'}>
                      <td>{vendorLabel(rule.vendor)}</td>
                      <td className="mono">{rule.commandContains || '-'}</td>
                      <td>{rule.type === 'keyword' ? t('包含关键词') : rule.type === 'missing' ? t('缺失关键词') : t('数值阈值')}</td>
                      <td className="mono">
                        {rule.type === 'keyword' ? (rule.keyword ?? '-') : rule.type === 'missing' ? (rule.missingKeyword ?? '-') : `${rule.threshold ?? '-'}${rule.percent ? '%' : ''}`}
                      </td>
                      <td>
                        <span className={`inspect-health-badge ${rule.severity}`}>{rule.severity === 'critical' ? t('严重') : t('警告')}</span>
                      </td>
                      <td>{rule.label}</td>
                      <td>
                        <input type="checkbox" checked={rule.enabled} onChange={() => toggleRuleEnabled(rule)} />
                      </td>
                      <td>
                        <button className="utility-text-button compact" type="button" onClick={() => openRuleEditor(rule)}>{t('编辑')}</button>
                        <button className="utility-text-button danger compact" type="button" onClick={() => deleteRule(rule)}>{t('删除')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {inspectView === 'plans' && (
        <div className="inspect-plans-pane">
          <div className="inspect-rules-header">
            <div className="inspect-rules-header-text">
              <strong>{t('巡检计划')}</strong>
              <span>{t('设置定时自动巡检，到点自动执行并保存到巡检历史')}</span>
            </div>
            <div className="inspect-workspace-actions">
              <button className="utility-primary-button compact" type="button" onClick={() => openPlanEditor()}>
                <Plus size={13} />
                {t('新建计划')}
              </button>
            </div>
          </div>

          {inspectPlanEditor && (
            <div className="inspect-plan-editor">
              <div className="inspect-rule-editor-title">
                <strong>{inspectPlans.some((p) => p.id === inspectPlanEditor.id) ? t('编辑计划') : t('新建计划')}</strong>
                <button className="utility-text-button compact" type="button" onClick={() => setInspectPlanEditor(null)}>
                  <X size={13} />
                  {t('关闭')}
                </button>
              </div>
              <div className="inspect-plan-form">
                <label>
                  <span>{t('计划名称')}</span>
                  <input value={inspectPlanEditor.name} onChange={(event) => setInspectPlanEditor({ ...inspectPlanEditor, name: event.target.value })} placeholder={t('如：机房核心设备日检')} />
                </label>
                <label>
                  <span>{t('执行频率')}</span>
                  <select value={inspectPlanEditor.frequency} onChange={(event) => setInspectPlanEditor({ ...inspectPlanEditor, frequency: event.target.value as InspectPlanFrequency })}>
                    <option value="daily">{t('每天')}</option>
                    <option value="weekly">{t('每周')}</option>
                    <option value="monthly">{t('每月')}</option>
                    <option value="interval">{t('每 N 小时')}</option>
                  </select>
                </label>
                {inspectPlanEditor.frequency === 'weekly' && (
                  <label className="inspect-plan-check-group">
                    <span>{t('选择星期')}</span>
                    <div>
                      {[
                        ['0', t('日')],
                        ['1', t('一')],
                        ['2', t('二')],
                        ['3', t('三')],
                        ['4', t('四')],
                        ['5', t('五')],
                        ['6', t('六')],
                      ].map(([value, label]) => (
                        <label key={value}>
                          <input type="checkbox" checked={inspectPlanEditor.weekdays.includes(Number(value))} onChange={() => togglePlanWeekday(Number(value))} />
                          {t('周')}{label}
                        </label>
                      ))}
                    </div>
                  </label>
                )}
                {inspectPlanEditor.frequency === 'monthly' && (
                  <label>
                    <span>{t('每月第几天')}</span>
                    <input type="number" min={1} max={31} value={inspectPlanEditor.monthDay} onChange={(event) => setInspectPlanEditor({ ...inspectPlanEditor, monthDay: Number(event.target.value) || 1 })} />
                  </label>
                )}
                {inspectPlanEditor.frequency === 'interval' && (
                  <label>
                    <span>{t('间隔（小时）')}</span>
                    <input type="number" min={1} max={720} value={inspectPlanEditor.intervalHours} onChange={(event) => setInspectPlanEditor({ ...inspectPlanEditor, intervalHours: Number(event.target.value) || 1 })} />
                  </label>
                )}
                {inspectPlanEditor.frequency !== 'interval' && (
                  <label>
                    <span>{t('执行时间')}</span>
                    <input
                      type="time"
                      value={`${String(inspectPlanEditor.hour).padStart(2, '0')}:${String(inspectPlanEditor.minute).padStart(2, '0')}`}
                      onChange={(event) => {
                        const [hour, minute] = event.target.value.split(':').map(Number)
                        setInspectPlanEditor({ ...inspectPlanEditor, hour: hour || 0, minute: minute || 0 })
                      }}
                    />
                  </label>
                )}
                <label>
                  <span>{t('并发数')}</span>
                  <input type="number" min={1} max={200} value={inspectPlanEditor.concurrency} onChange={(event) => setInspectPlanEditor({ ...inspectPlanEditor, concurrency: Number(event.target.value) || 1 })} />
                </label>
                <label className="inspect-plan-check-group inspect-plan-devices">
                  <span>{t('选择设备')}</span>
                  {inspectDevices.length === 0 ? (
                    <div className="inspect-plan-hint">{t('暂无设备，请先在巡检工作台添加设备')}</div>
                  ) : (
                    <div>
                      {inspectDevices.map((d) => (
                        <label key={d.id}>
                          <input type="checkbox" checked={inspectPlanEditor.deviceIds.includes(d.id)} onChange={() => togglePlanDevice(d.id)} />
                          {d.name}（{d.host}）
                        </label>
                      ))}
                    </div>
                  )}
                </label>
                <label className="inspect-plan-commands">
                  <span>{t('执行命令（每行一条）')}</span>
                  <textarea
                    rows={6}
                    value={inspectPlanCmdDraft}
                    onChange={(event) => setInspectPlanCmdDraft(event.target.value)}
                    placeholder={t('每行一条命令，如：\ndisplay version\ndisplay device')}
                  />
                  <span className="inspect-plan-hint">{t('多行命令将按顺序在每台设备上依次执行')}</span>
                </label>
              </div>
              <div className="inspect-rule-editor-actions">
                <button className="utility-primary-button compact" type="button" onClick={savePlanDraft}>
                  <Save size={13} />
                  {t('保存计划')}
                </button>
                <button className="utility-text-button compact" type="button" onClick={() => setInspectPlanEditor(null)}>{t('取消')}</button>
              </div>
            </div>
          )}

          {inspectPlans.length === 0 && !inspectPlanEditor ? (
            <div className="inspect-empty">{t('暂无巡检计划，点击"新建计划"创建定时自动巡检')}</div>
          ) : (
            <div className="inspect-plans-list">
              {inspectPlans.map((plan) => (
                <div className="inspect-plan-card" key={plan.id}>
                  <div className="inspect-plan-card-head">
                    <strong>{plan.name}</strong>
                    <span className="inspect-plan-frequency">{planFrequencyLabel(plan)}</span>
                    {inspectPlanRunning.has(plan.id) && <span className="inspect-plan-running">{t('执行中…')}</span>}
                    <label className="inspect-plan-switch">
                      <input type="checkbox" checked={plan.enabled} onChange={() => togglePlanEnabled(plan)} />
                      {t('启用')}
                    </label>
                    <button className="utility-primary-button compact" type="button" disabled={inspectPlanRunning.has(plan.id)} onClick={() => void executePlanNow(plan)}>
                      {t('立即执行')}
                    </button>
                    <button className="utility-text-button compact" type="button" onClick={() => openPlanEditor(plan)}>{t('编辑')}</button>
                    <button className="utility-text-button danger compact" type="button" onClick={() => deletePlan(plan)}>{t('删除')}</button>
                  </div>
                  <div className="inspect-plan-card-meta">
                    <span>{t('设备')} {plan.deviceIds.length}</span>
                    <span>{t('命令')} {plan.commands.length}</span>
                    <span>{t('并发')} {plan.concurrency}</span>
                    <span>{t('上次执行')} {plan.lastRunAt ?? '-'}</span>
                    <span>{t('下次执行')} {plan.nextRunAt ?? '-'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

type ConnectionImportKind = 'ssh' | 'rdp'

type ImportedConnectionFields = {
  name?: string
  host?: string
  port?: number
  username?: string
  password?: string
  group?: string
  domain?: string
  security?: RemoteDesktopConnection['security']
  viewOnly?: boolean
}

type ConnectionImportResult = {
  values: ImportedConnectionFields
  detected: Array<keyof ImportedConnectionFields>
  error?: string
}

const connectionImportLabels: Record<keyof ImportedConnectionFields, string> = {
  name: '名称',
  host: '主机',
  port: '端口',
  username: '账号',
  password: '密码',
  group: '分组',
  domain: '域',
  security: '安全模式',
  viewOnly: '只看模式',
}

function parseConnectionImport(raw: string, kind: ConnectionImportKind): ConnectionImportResult {
  const input = raw.trim()
  const values: ImportedConnectionFields = {}
  const detected = new Set<keyof ImportedConnectionFields>()
  if (!input) return { values, detected: [], error: '请先粘贴连接信息' }

  const setValue = <K extends keyof ImportedConnectionFields>(key: K, value: ImportedConnectionFields[K]) => {
    if (value === undefined || value === '') return
    values[key] = value
    detected.add(key)
  }
  const setPort = (value: unknown) => {
    const port = Number(String(value).trim())
    if (Number.isInteger(port) && port >= 1 && port <= 65535) setValue('port', port)
  }
  const setUsername = (value: string) => {
    const normalized = stripImportQuotes(value)
    if (!normalized) return
    if (kind === 'rdp' && normalized.includes('\\')) {
      const [domain, ...usernameParts] = normalized.split('\\')
      setValue('domain', domain)
      setValue('username', usernameParts.join('\\'))
      return
    }
    setValue('username', normalized)
  }
  const setAddress = (value: string) => {
    const parsed = parseImportedAddress(value)
    if (!parsed) return
    setValue('host', parsed.host)
    if (parsed.port) setValue('port', parsed.port)
  }
  const applyNamedValue = (rawKey: string, rawValue: unknown) => {
    if (rawValue === null || rawValue === undefined) return
    const key = normalizeImportKey(rawKey)
    const value = typeof rawValue === 'string' ? stripImportQuotes(rawValue) : String(rawValue)
    if (['ip', 'ipaddress', 'host', 'hostname', 'address', 'server', 'serverip', '主机', '地址', '服务器', '服务器ip', '公网ip', 'ip地址'].includes(key)) setAddress(value)
    else if (['user', 'username', 'login', 'account', '账号', '账户', '用户', '用户名', '登录名'].includes(key)) setUsername(kind === 'rdp' ? value.replace(/^s:/i, '') : value)
    else if (['pass', 'password', 'pwd', 'secret', '密码', '口令'].includes(key)) setValue('password', value)
    else if (['port', '端口'].includes(key)) setPort(value)
    else if (['name', 'label', 'alias', '名称', '别名', '备注'].includes(key)) setValue('name', value)
    else if (['group', 'folder', '分组', '组'].includes(key)) setValue('group', value)
    else if (kind === 'rdp' && ['domain', '域', '域名'].includes(key)) setValue('domain', value.replace(/^s:/i, ''))
    else if (kind === 'rdp' && ['security', 'securitymode', '安全', '安全模式'].includes(key)) {
      const security = value.toLowerCase()
      if (security === 'nla' || security === 'tls') setValue('security', security)
      else if (security === 'any' || security === 'auto' || security === '自动') setValue('security', 'any')
    } else if (kind === 'rdp' && ['viewonly', 'readonly', '只读', '只看模式'].includes(key)) {
      setValue('viewOnly', /^(1|true|yes|on|是|开启)$/i.test(value))
    }
  }

  const urlMatch = input.match(kind === 'ssh' ? /ssh:\/\/[^\s]+/i : /rdp:\/\/[^\s]+/i)
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[0].replace(/[),;]+$/, ''))
      setAddress(`${url.hostname}${url.port ? `:${url.port}` : ''}`)
      if (url.username) setUsername(decodeURIComponent(url.username))
      if (url.password) setValue('password', decodeURIComponent(url.password))
    } catch {
      // Continue with command and key-value parsing.
    }
  }

  if (kind === 'ssh') {
    const sshTarget = input.match(/\bssh(?:\.exe)?\b[^\r\n]*?([^\s@]+)@(\[[^\]]+\]|[a-z0-9._:-]+)/i)
    if (sshTarget) {
      setUsername(sshTarget[1])
      setAddress(sshTarget[2])
    }
    const sshPort = input.match(/(?:^|\s)-p\s*(\d{1,5})(?:\s|$)/i)
    if (sshPort) setPort(sshPort[1])
  } else {
    const mstscTarget = input.match(/(?:mstsc(?:\.exe)?\s+)?\/v\s*:\s*([^\s]+)/i)
    if (mstscTarget) setAddress(mstscTarget[1])
    const fullAddress = input.match(/^\s*full address:s:(.+)$/im)
    if (fullAddress) setAddress(fullAddress[1])
    const rdpUsername = input.match(/^\s*username:s:(.+)$/im)
    if (rdpUsername) setUsername(rdpUsername[1])
    const rdpDomain = input.match(/^\s*domain:s:(.+)$/im)
    if (rdpDomain) setValue('domain', stripImportQuotes(rdpDomain[1]))
    const cmdKeyHost = input.match(/\/generic\s*:\s*(?:TERMSRV\/)?([^\s]+)/i)
    if (cmdKeyHost) setAddress(cmdKeyHost[1])
    const cmdKeyUser = input.match(/\/user\s*:\s*([^\s]+)/i)
    if (cmdKeyUser) setUsername(cmdKeyUser[1])
    const cmdKeyPassword = input.match(/\/pass\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/i)
    if (cmdKeyPassword) setValue('password', cmdKeyPassword[1] ?? cmdKeyPassword[2] ?? cmdKeyPassword[3])
  }

  const credentialTarget = input.match(/(?:^|\s)([^\s:@]+):([^\s@]+)@(\[[^\]]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?/i)
  if (credentialTarget) {
    setUsername(credentialTarget[1])
    setValue('password', credentialTarget[2])
    setAddress(`${credentialTarget[3]}${credentialTarget[4] ? `:${credentialTarget[4]}` : ''}`)
  } else {
    const userTarget = input.match(/(?:^|\s)([^\s@:]+)@(\[[^\]]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?/i)
    if (userTarget) {
      setUsername(userTarget[1])
      setAddress(`${userTarget[2]}${userTarget[3] ? `:${userTarget[3]}` : ''}`)
    }
  }

  try {
    const json = JSON.parse(input) as unknown
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const record = json as Record<string, unknown>
      Object.entries(record).forEach(([key, value]) => applyNamedValue(key, value))
      if (record.connection && typeof record.connection === 'object' && !Array.isArray(record.connection)) {
        Object.entries(record.connection as Record<string, unknown>).forEach(([key, value]) => applyNamedValue(key, value))
      }
    }
  } catch {
    // Plain text is the common import format.
  }

  input.split(/\r?\n/).forEach((line) => {
    const pair = line.match(/^\s*([^:=：＝]{1,40})\s*[:=：＝]\s*(.*?)\s*$/)
    if (pair) {
      applyNamedValue(pair[1], pair[2])
      return
    }
    const spacedPair = line.match(/^\s*(\S{1,30})\s+(.+?)\s*$/)
    if (spacedPair) applyNamedValue(spacedPair[1], spacedPair[2])
  })

  if (!values.host) {
    const tokens = input
      .split(/[\s,;|\t]+/)
      .map((token) => stripImportQuotes(token))
      .filter(Boolean)
    const addressIndex = tokens.findIndex((token) => {
      const parsed = parseImportedAddress(token)
      return Boolean(parsed && isLikelyImportedHost(parsed.host))
    })
    if (addressIndex >= 0) {
      setAddress(tokens[addressIndex])
      let cursor = addressIndex + 1
      if (!values.port && /^\d{1,5}$/.test(tokens[cursor] ?? '')) {
        setPort(tokens[cursor])
        cursor += 1
      }
      if (!values.username && tokens[cursor]) {
        setUsername(tokens[cursor])
        cursor += 1
      }
      if (!values.password && tokens[cursor]) setValue('password', tokens[cursor])
    }
  }

  if (!values.host) return { values, detected: [...detected], error: '没有识别到有效的主机或 IP 地址' }
  return { values, detected: [...detected] }
}

function normalizeImportKey(value: string) {
  return value.trim().toLowerCase().replace(/[\s_.-]+/g, '')
}

function stripImportQuotes(value: string) {
  const trimmed = value.trim().replace(/^[,;]+|[,;]+$/g, '')
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseImportedAddress(value: string) {
  const normalized = stripImportQuotes(value)
    .replace(/^s:/i, '')
    .replace(/^TERMSRV\//i, '')
    .replace(/^\/\//, '')
    .replace(/[/?#].*$/, '')
  const bracketed = normalized.match(/^\[([^\]]+)](?::(\d{1,5}))?$/)
  if (bracketed) {
    const port = bracketed[2] ? Number(bracketed[2]) : undefined
    if (port && (port < 1 || port > 65535)) return undefined
    return { host: bracketed[1], port }
  }
  const hostPort = normalized.match(/^([^:\s]+):(\d{1,5})$/)
  const host = (hostPort?.[1] ?? normalized).trim()
  const port = hostPort ? Number(hostPort[2]) : undefined
  if (!host || /[\s@]/.test(host) || (port && (port < 1 || port > 65535))) return undefined
  if (/^\d+(?:\.\d+){3}$/.test(host) && host.split('.').some((part) => Number(part) > 255)) return undefined
  return { host, port }
}

function isLikelyImportedHost(host: string) {
  return host === 'localhost'
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    || host.includes('.')
    || host.includes(':')
}

function ConnectionTextImport({
  kind,
  onImport,
}: {
  kind: ConnectionImportKind
  onImport: (values: ImportedConnectionFields) => void
}) {
  const { t } = useAppLocale()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; fields?: Array<keyof ImportedConnectionFields>; message?: string } | null>(null)

  function applyText(value: string) {
    setText(value)
    const result = parseConnectionImport(value, kind)
    if (result.error) {
      setStatus({ tone: 'error', message: result.error })
      return
    }
    onImport(result.values)
    setStatus({ tone: 'success', fields: result.detected })
  }

  async function readClipboard() {
    try {
      applyText(await navigator.clipboard.readText())
    } catch {
      setStatus({ tone: 'error', message: '无法读取剪贴板，请直接粘贴到输入框' })
    }
  }

  return (
    <section className="connection-text-import">
      <div className="connection-text-import-head">
        <div>
          <ClipboardPaste size={15} />
          <span>
            <strong>{t('格式化导入')}</strong>
            <em>{t('粘贴后自动识别并填入，不会上传连接信息。')}</em>
          </span>
        </div>
        <button className="utility-text-button" type="button" onClick={() => void readClipboard()}>
          <ClipboardPaste size={13} />
          {t('读取剪贴板')}
        </button>
      </div>
      <textarea
        className="connection-import-input"
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setStatus(null)
        }}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData('text')
          if (!pasted) return
          event.preventDefault()
          applyText(pasted)
        }}
        placeholder={t(kind === 'ssh'
          ? '例如：ssh://root:password@192.168.1.10:22，或粘贴 IP、账号、密码等多行信息'
          : '例如：rdp://Administrator:password@192.168.1.10:3389，或粘贴 mstsc / RDP 文件信息')}
        spellCheck={false}
      />
      <div className="connection-import-footer">
        <div className={`connection-import-status ${status?.tone ?? ''}`} aria-live="polite">
          {status?.tone === 'success' && (
            <>
              <CheckCircle2 size={13} />
              <span>{t('已识别并填入')}</span>
              <em>{status.fields?.map((field) => t(connectionImportLabels[field])).join(' · ')}</em>
            </>
          )}
          {status?.tone === 'error' && <span>{t(status.message ?? '无法识别连接信息')}</span>}
        </div>
        <button className="ghost-button compact" type="button" onClick={() => applyText(text)} disabled={!text.trim()}>
          <CheckCircle2 size={13} />
          {t('识别并填入')}
        </button>
      </div>
    </section>
  )
}

function ServerModal({
  draft,
  onCancel,
  onSave,
}: {
  draft: ServerDraft
  onCancel: () => void
  onSave: (draft: ServerDraft) => void
}) {
  const { t } = useAppLocale()
  const [form, setForm] = useState<ServerDraft>(draft)
  const [serialPorts, setSerialPorts] = useState<string[]>([])
  const protocol = form.protocol ?? 'ssh'

  useEffect(() => {
    if (protocol !== 'serial') return
    void invoke<{ name: string; port_type: string }[]>('serial_list_ports')
      .then((ports) => setSerialPorts(ports.map((port) => port.name)))
      .catch(() => setSerialPorts([]))
  }, [protocol])

  const switchProtocol = (next: ServerProtocol) => {
    setForm((current) => ({
      ...current,
      protocol: next,
      port: next === 'telnet' ? 23 : next === 'serial' ? current.port : 22,
      user: next === 'serial' ? '' : current.user || 'root',
      auth: next === 'ssh' ? current.auth : 'Password',
      password: next === 'ssh' ? current.password : '',
    }))
  }

  return (
    <motion.div
      className="modal-backdrop"
      onPointerDown={onCancel}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.form
        className="modal connection-profile-modal"
        onPointerDown={(event) => event.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        onSubmit={(event) => {
          event.preventDefault()
          onSave(form)
        }}
      >
        <div className="modal-header">
          <div>
            <p className="section-title">{t('连接配置')}</p>
            <h2>{t(draft.id ? '编辑设备' : '添加设备')}</h2>
          </div>
          <IconButton label={t('关闭')} onClick={onCancel}>
            <X size={16} />
          </IconButton>
        </div>
        {!draft.id && protocol !== 'serial' && (
          <ConnectionTextImport
            kind="ssh"
            onImport={(values) => setForm((current) => ({
              ...current,
              name: values.name ?? (current.name || values.host || ''),
              host: values.host ?? current.host,
              user: values.username ?? current.user,
              port: values.port ?? current.port,
              group: values.group ?? current.group,
              password: values.password ?? current.password,
              auth: 'Password',
            }))}
          />
        )}
        <label className="field">
          <span>{t('连接类型')}</span>
          <select
            value={protocol}
            onChange={(event) => switchProtocol(event.target.value as ServerProtocol)}
          >
            <option value="ssh">SSH</option>
            <option value="telnet">Telnet</option>
            <option value="serial">{t('串口')} (Serial)</option>
          </select>
        </label>
        <EditableField label={t('名称')} value={form.name} onChange={(name) => setForm({ ...form, name })} />
        {protocol !== 'serial' && (
          <>
            <EditableField
              label={t('主机')}
              value={form.host}
              onChange={(host) => setForm({ ...form, host })}
              required
            />
            <div className="field-grid">
              {protocol === 'ssh' && (
                <EditableField label={t('用户')} value={form.user} onChange={(user) => setForm({ ...form, user })} />
              )}
              <EditableField
                label={t('端口')}
                value={`${form.port}`}
                onChange={(port) => setForm({ ...form, port: Number(port) || (protocol === 'telnet' ? 23 : 22) })}
              />
            </div>
          </>
        )}
        {protocol === 'serial' && (
          <>
            <label className="field">
              <span>{t('串口')}</span>
              <input
                list="serial-port-options"
                value={form.serialPort ?? ''}
                onChange={(event) => setForm({ ...form, serialPort: event.target.value })}
                placeholder={t('选择或输入串口号，如 COM3')}
                autoComplete="off"
              />
              <datalist id="serial-port-options">
                {serialPorts.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <div className="field-grid">
              <EditableField
                label={t('波特率')}
                value={`${form.baudRate ?? 9600}`}
                onChange={(baudRate) => setForm({ ...form, baudRate: Number(baudRate) || 9600 })}
              />
              <label className="field">
                <span>{t('数据位')}</span>
                <select
                  value={`${form.dataBits ?? 8}`}
                  onChange={(event) => setForm({ ...form, dataBits: Number(event.target.value) })}
                >
                  <option value="5">5</option>
                  <option value="6">6</option>
                  <option value="7">7</option>
                  <option value="8">8</option>
                </select>
              </label>
            </div>
            <div className="field-grid">
              <label className="field">
                <span>{t('停止位')}</span>
                <select
                  value={`${form.stopBits ?? 1}`}
                  onChange={(event) => setForm({ ...form, stopBits: Number(event.target.value) })}
                >
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </label>
              <label className="field">
                <span>{t('校验位')}</span>
                <select
                  value={form.parity ?? 'none'}
                  onChange={(event) => setForm({ ...form, parity: event.target.value })}
                >
                  <option value="none">{t('无')}</option>
                  <option value="odd">{t('奇校验')}</option>
                  <option value="even">{t('偶校验')}</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>{t('流控')}</span>
              <select
                value={form.flowControl ?? 'none'}
                onChange={(event) => setForm({ ...form, flowControl: event.target.value })}
              >
                <option value="none">{t('无')}</option>
                <option value="hardware">{t('硬件')}</option>
                <option value="software">{t('软件')}</option>
              </select>
            </label>
          </>
        )}
        {protocol === 'ssh' && (
          <>
            <EditableField label={t('分组')} value={form.group} onChange={(group) => setForm({ ...form, group })} />
            <label className="field">
              <span>{t('认证方式')}</span>
              <select
                value={form.auth}
                onChange={(event) => setForm({
                  ...form,
                  auth: event.target.value as ServerProfile['auth'],
                  password: '',
                })}
              >
                <option value="Password">{t('密码认证')}</option>
                <option value="Key">{t('SSH 私钥')}</option>
                <option value="Agent">SSH Agent</option>
              </select>
            </label>
            {form.auth === 'Key' && (
              <label className="field">
                <span>{t('私钥文件')}</span>
                <div className="private-key-input-row">
                  <input
                    value={form.privateKeyPath ?? ''}
                    onChange={(event) => setForm({ ...form, privateKeyPath: event.target.value })}
                    placeholder="C:\\Users\\name\\.ssh\\id_ed25519"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    aria-label={t('选择私钥文件')}
                    title={t('选择私钥文件')}
                    onClick={() => {
                      void invoke<string | null>('choose_ssh_private_key').then((privateKeyPath) => {
                        if (privateKeyPath) setForm((current) => ({ ...current, privateKeyPath }))
                      })
                    }}
                  >
                    <FolderOpen size={15} />
                  </button>
                </div>
              </label>
            )}
            {form.auth !== 'Agent' && (
              <PasswordField
                label={t(form.auth === 'Key' ? '私钥口令（可选）' : '密码')}
                value={form.password ?? ''}
                onChange={(password) => setForm({ ...form, password })}
                placeholder={t(form.auth === 'Key' ? '未加密私钥可以留空' : '保存到系统凭据保险库')}
              />
            )}
          </>
        )}
        {protocol !== 'ssh' && (
          <EditableField label={t('分组')} value={form.group} onChange={(group) => setForm({ ...form, group })} />
        )}
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            {t('取消')}
          </button>
          <button className="connect-button compact" type="submit">
            <CheckCircle2 size={16} />
            {t('保存')}
          </button>
        </div>
      </motion.form>
    </motion.div>
  )
}

function RemoteDesktopModal({
  draft,
  onCancel,
  onSave,
}: {
  draft: RemoteDesktopDraft
  onCancel: () => void
  onSave: (draft: RemoteDesktopDraft) => void
}) {
  const { t } = useAppLocale()
  const [form, setForm] = useState<RemoteDesktopDraft>(draft)

  return (
    <motion.div className="modal-backdrop" onPointerDown={onCancel} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      <motion.form
        className="modal remote-desktop-profile-modal connection-profile-modal"
        onPointerDown={(event) => event.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        onSubmit={(event) => { event.preventDefault(); onSave(form) }}
      >
        <div className="modal-header">
          <div>
            <p className="section-title">RDP</p>
            <h2>{t(draft.id ? '编辑远程桌面' : '添加远程桌面')}</h2>
          </div>
          <IconButton label={t('关闭')} onClick={onCancel}><X size={16} /></IconButton>
        </div>
        {!draft.id && (
          <ConnectionTextImport
            kind="rdp"
            onImport={(values) => setForm((current) => ({
              ...current,
              name: values.name ?? (current.name || values.host || ''),
              host: values.host ?? current.host,
              username: values.username ?? current.username,
              password: values.password ?? current.password,
              port: values.port ?? current.port,
              group: values.group ?? current.group,
              domain: values.domain ?? current.domain,
              security: values.security ?? current.security,
              viewOnly: values.viewOnly ?? current.viewOnly,
            }))}
          />
        )}
        <EditableField label={t('名称')} value={form.name} onChange={(name) => setForm({ ...form, name })} />
        <EditableField label={t('主机')} value={form.host} onChange={(host) => setForm({ ...form, host })} required />
        <div className="field-grid remote-desktop-profile-grid">
          <EditableField label={t('用户名')} value={form.username} onChange={(username) => setForm({ ...form, username })} required />
          <EditableField label={t('端口')} value={`${form.port}`} onChange={(port) => setForm({ ...form, port: Number(port) || 3389 })} />
        </div>
        <PasswordField label={t('密码')} value={form.password} onChange={(password) => setForm({ ...form, password })} />
        <div className="field-grid remote-desktop-profile-grid">
          <EditableField label={t('域')} value={form.domain} onChange={(domain) => setForm({ ...form, domain })} />
          <label className="field">
            <span>{t('安全模式')}</span>
            <select value={form.security} onChange={(event) => setForm({ ...form, security: event.target.value as RemoteDesktopConnection['security'] })}>
              <option value="any">Auto</option>
              <option value="nla">NLA</option>
              <option value="tls">TLS</option>
            </select>
          </label>
        </div>
        <EditableField label={t('分组')} value={form.group} onChange={(group) => setForm({ ...form, group })} />
        <label className="remote-desktop-profile-check">
          <input type="checkbox" checked={form.viewOnly} onChange={(event) => setForm({ ...form, viewOnly: event.target.checked })} />
          <span>{t('只看模式')}</span>
        </label>
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onCancel}>{t('取消')}</button>
          <button className="connect-button compact" type="submit"><CheckCircle2 size={16} />{t('保存')}</button>
        </div>
      </motion.form>
    </motion.div>
  )
}

function SettingsModal({
  onClose,
  onExport,
  onImport,
  onImportSshConfig,
  onExportDiagnostics,
  onReset,
  appearance,
  onAppearanceChange,
  themePreset,
  onThemePresetChange,
  appBackground,
  backgroundAssetUrl,
  backgroundBusy,
  onBackgroundEnabledChange,
  onBackgroundChoose,
  onBackgroundClear,
  onBackgroundTransparencyChange,
  terminalFontSize,
  onTerminalFontSizeChange,
  remoteAuxConcurrency,
  onRemoteAuxConcurrencyChange,
  displayLanguage,
  onDisplayLanguageChange,
  timeZonePreference,
  onTimeZonePreferenceChange,
  systemTimeZone,
}: {
  onClose: () => void
  onExport: () => void
  onImport: (value: string) => void
  onImportSshConfig: () => void
  onExportDiagnostics: () => void
  onReset: () => void
  appearance: AppAppearance
  onAppearanceChange: (value: AppAppearance) => void
  themePreset: AppThemePresetId
  onThemePresetChange: (value: AppThemePresetId) => void
  appBackground: AppBackgroundSettings
  backgroundAssetUrl: string
  backgroundBusy: boolean
  onBackgroundEnabledChange: (enabled: boolean) => void
  onBackgroundChoose: () => void
  onBackgroundClear: () => void
  onBackgroundTransparencyChange: (transparency: number) => void
  terminalFontSize: number
  onTerminalFontSizeChange: (value: number) => void
  remoteAuxConcurrency: number
  onRemoteAuxConcurrencyChange: (value: number) => void
  displayLanguage: AppLanguage
  onDisplayLanguageChange: (value: AppLanguage) => void
  timeZonePreference: string
  onTimeZonePreferenceChange: (value: string) => void
  systemTimeZone: string
}) {
  const { resolvedLanguage, t } = useAppLocale()
  const reduceMotion = useReducedMotion()
  const [importText, setImportText] = useState('')
  const [section, setSection] = useState<'appearance' | 'language' | 'servers' | 'about'>('appearance')
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateResult, setUpdateResult] = useState<AppUpdateCheckResult | null>(null)
  const [updateDownload, setUpdateDownload] = useState<AppUpdateDownloadState>({
    status: 'idle',
    totalBytes: 0,
    transferredBytes: 0,
    bytesPerSecond: 0,
    copiedFiles: 0,
    totalFiles: 1,
    currentFile: '',
    completed: false,
    installerPath: '',
    error: '',
  })
  const [externalLinkFeedback, setExternalLinkFeedback] = useState('')
  const copyFeedbackTimerRef = useRef<number | null>(null)
  const updateDownloadRef = useRef<{ id: string; cancelled: boolean } | null>(null)

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current)
  }, [])

  async function checkForUpdates() {
    if (updateBusy || updateDownload.status === 'downloading' || updateDownload.status === 'launching') return
    setUpdateBusy(true)
    try {
      const result = await invoke<AppUpdateCheckResult>('check_app_update')
      setUpdateResult(result)
      setUpdateDownload((current) => current.status === 'ready' || current.status === 'launched'
        ? current
        : {
            status: 'idle',
            totalBytes: result.installer?.size ?? 0,
            transferredBytes: 0,
            bytesPerSecond: 0,
            copiedFiles: 0,
            totalFiles: 1,
            currentFile: '',
            completed: false,
            installerPath: '',
            error: '',
          })
    } catch {
      setUpdateResult({
        currentVersion: APP_VERSION,
        latestVersion: null,
        updateAvailable: false,
        status: 'unavailable',
        notes: null,
        releaseUrl: null,
        publishedAt: null,
        installer: null,
      })
    } finally {
      setUpdateBusy(false)
    }
  }

  async function downloadAppUpdate() {
    const installer = updateResult?.installer
    const version = updateResult?.latestVersion
    if (!installer || !version || updateDownloadRef.current) return
    const transferId = crypto.randomUUID()
    const transfer = { id: transferId, cancelled: false }
    updateDownloadRef.current = transfer
    const fileName = installer.url.split('/').filter(Boolean).at(-1) ?? `RainTerminal_${version}_x64-setup.exe`
    const baseProgress: AppUpdateDownloadState = {
      status: 'downloading',
      totalBytes: installer.size,
      transferredBytes: 0,
      bytesPerSecond: 0,
      copiedFiles: 0,
      totalFiles: 1,
      currentFile: fileName,
      completed: false,
      installerPath: '',
      error: '',
    }
    setUpdateDownload(baseProgress)
    upsertTransfer({
      id: transferId,
      protocol: 'local',
      direction: 'download',
      title: `${t('软件更新')} v${version}`,
      source: 'GitHub Releases',
      destination: t('应用更新缓存'),
      status: 'running',
      totalBytes: installer.size,
      transferredBytes: 0,
      bytesPerSecond: 0,
      copiedFiles: 0,
      totalFiles: 1,
      currentFile: fileName,
      message: t('正在下载并校验安装包'),
      resumable: false,
    }, {
      cancel: () => cancelAppUpdateDownload(),
      retry: () => downloadAppUpdate(),
    })
    const onProgress = createMessageChannel<FileDownloadProgress>((progress) => {
      if (updateDownloadRef.current?.id !== transferId) return
      setUpdateDownload((current) => ({ ...current, ...progress }))
      upsertTransfer({
        id: transferId,
        ...progress,
        status: progress.completed ? 'completed' : 'running',
        message: progress.completed ? t('安装包校验完成') : t('正在下载并校验安装包'),
      })
    })
    try {
      const result = await invoke<AppUpdateDownloadResult>('download_app_update', {
        transferId,
        version,
        url: installer.url,
        sha256: installer.sha256,
        size: installer.size,
        onProgress,
      })
      if (updateDownloadRef.current?.id !== transferId) return
      setUpdateDownload((current) => ({
        ...current,
        status: 'ready',
        totalBytes: result.totalBytes,
        transferredBytes: result.totalBytes,
        bytesPerSecond: 0,
        copiedFiles: 1,
        completed: true,
        currentFile: '',
        installerPath: result.installerPath,
        error: '',
      }))
      upsertTransfer({
        id: transferId,
        status: 'completed',
        destination: result.installerPath,
        totalBytes: result.totalBytes,
        transferredBytes: result.totalBytes,
        bytesPerSecond: 0,
        copiedFiles: 1,
        currentFile: '',
        message: t('安装包校验完成'),
      }, { retry: () => downloadAppUpdate() })
    } catch (reason) {
      if (updateDownloadRef.current?.id !== transferId) return
      const detail = String(reason).replace(/^Error:\s*/i, '')
      const cancelled = transfer.cancelled || detail.includes('取消')
      setUpdateDownload((current) => ({
        ...current,
        status: cancelled ? 'cancelled' : 'error',
        bytesPerSecond: 0,
        error: cancelled ? '' : detail,
      }))
      upsertTransfer({
        id: transferId,
        status: cancelled ? 'cancelled' : 'error',
        bytesPerSecond: 0,
        message: cancelled ? t('更新下载已取消') : detail,
      }, { retry: () => downloadAppUpdate() })
    } finally {
      if (updateDownloadRef.current?.id === transferId) updateDownloadRef.current = null
    }
  }

  async function cancelAppUpdateDownload() {
    const transfer = updateDownloadRef.current
    if (!transfer || transfer.cancelled) return
    transfer.cancelled = true
    setUpdateDownload((current) => ({ ...current, bytesPerSecond: 0 }))
    upsertTransfer({ id: transfer.id, bytesPerSecond: 0, message: t('正在取消更新下载…') })
    try {
      await invoke('cancel_file_download', { transferId: transfer.id })
    } catch {
      transfer.cancelled = false
      throw new Error(t('无法取消更新下载'))
    }
  }

  async function launchAppUpdate() {
    if (updateDownload.status !== 'ready' || !updateDownload.installerPath) return
    setUpdateDownload((current) => ({ ...current, status: 'launching', error: '' }))
    try {
      await invoke('launch_app_update', { installerPath: updateDownload.installerPath })
      setUpdateDownload((current) => ({ ...current, status: 'launched' }))
    } catch (reason) {
      setUpdateDownload((current) => ({
        ...current,
        status: 'ready',
        error: String(reason).replace(/^Error:\s*/i, ''),
      }))
    }
  }

  async function openExternalUrl(url: string) {
    setExternalLinkFeedback('')
    try {
      await invoke('open_external_url', { url })
    } catch {
      try {
        await navigator.clipboard.writeText(url)
        setExternalLinkFeedback('无法打开链接，地址已复制。')
      } catch {
        setExternalLinkFeedback('无法打开链接，请稍后重试。')
      }
    }
  }

  return (
    <motion.div
      className="modal-backdrop"
      onPointerDown={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.section
        className="modal settings-modal"
        onPointerDown={(event) => event.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="modal-header">
          <div>
            <p className="section-title">{t('偏好设置')}</p>
            <h2>{t('设置')}</h2>
          </div>
          <IconButton label={t('关闭')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="settings-shell">
          <aside className="settings-nav">
            <button className={section === 'appearance' ? 'active' : ''} type="button" onClick={() => setSection('appearance')}>
              <Palette size={15} />
              {t('外观')}
            </button>
            <button className={section === 'language' ? 'active' : ''} type="button" onClick={() => setSection('language')}>
              <Languages size={15} />
              {t('语言与地区')}
            </button>
            <button className={section === 'servers' ? 'active' : ''} type="button" onClick={() => setSection('servers')}>
              <Server size={15} />
              {t('服务器')}
            </button>
            <button className={section === 'about' ? 'active' : ''} type="button" onClick={() => setSection('about')}>
              <ShieldCheck size={15} />
              {t('关于')}
            </button>
          </aside>
          <section className="settings-pane">
            {section === 'appearance' && (
              <>
                <div className="settings-section-head">
                  <Palette size={16} />
                  <div>
                    <strong>{t('主题预设')}</strong>
                    <span>{t('选择整套工作台与终端配色；RainTerminal 默认主题保持为初始选项。')}</span>
                  </div>
                </div>
                <motion.div
                  className="theme-preset-grid"
                  role="radiogroup"
                  aria-label={t('主题预设')}
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: reduceMotion ? 0 : 0.2 }}
                >
                  {appThemePresets.map((preset, presetIndex) => {
                    const active = preset.id === themePreset
                    return (
                      <motion.button
                        className={`theme-preset-card ${active ? 'active' : ''}`}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        data-skin-id={preset.id}
                        onClick={() => onThemePresetChange(preset.id)}
                        key={preset.id}
                        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: reduceMotion ? 0 : 0.34,
                          delay: reduceMotion ? 0 : 0.035 * presetIndex,
                          ease: [0.16, 1, 0.3, 1],
                        }}
                        whileHover={reduceMotion ? undefined : { y: -2, scale: 1.01 }}
                        whileTap={reduceMotion ? undefined : { scale: 0.985 }}
                      >
                        <span
                          className="theme-preset-visual"
                          aria-hidden="true"
                          style={{
                            '--theme-preview-canvas': preset.preview[0],
                            '--theme-preview-surface': preset.preview[1],
                            '--theme-preview-accent': preset.preview[2],
                          } as CSSProperties}
                        >
                          <i /><i /><i />
                        </span>
                        <span className="theme-preset-copy">
                          <span className="theme-preset-name">
                            <strong>{t(preset.name)}</strong>
                            {preset.badge && <em>{t(preset.badge)}</em>}
                          </span>
                          <small>{t(preset.description)}</small>
                        </span>
                        <AnimatePresence initial={false}>
                          {active && (
                            <motion.span
                              className="theme-preset-check"
                              initial={reduceMotion ? false : { opacity: 0, scale: 0.62, rotate: -18 }}
                              animate={{ opacity: 1, scale: 1, rotate: 0 }}
                              exit={{ opacity: 0, scale: 0.76, transition: { duration: reduceMotion ? 0 : 0.08 } }}
                              transition={reduceMotion
                                ? { duration: 0 }
                                : { type: 'spring', stiffness: 520, damping: 26, mass: 0.62 }}
                            >
                              <CheckCircle2 size={15} aria-hidden="true" />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </motion.button>
                    )
                  })}
                </motion.div>
                <div className="app-appearance-row">
                  <div>
                    <strong>{t(appearance === 'dark' ? '深色主题' : '浅色主题')}</strong>
                    <span>{t('预设与亮暗模式会自动保存，并同步更新终端配色。')}</span>
                  </div>
                  <div className="settings-appearance-switch" role="group" aria-label={t('应用外观')}>
                    <button className={appearance === 'light' ? 'active' : ''} type="button" onClick={() => onAppearanceChange('light')}>
                      <Sun size={14} />
                      {t('浅色')}
                    </button>
                    <button className={appearance === 'dark' ? 'active' : ''} type="button" onClick={() => onAppearanceChange('dark')}>
                      <Moon size={14} />
                      {t('深色')}
                    </button>
                  </div>
                </div>
                <div className="settings-section-head settings-section-spaced">
                  <ImageIcon size={16} />
                  <div>
                    <strong>{t('工作台背景')}</strong>
                    <span>{t('选择背景图片后，可调节界面透明度；默认关闭，不影响现有外观。')}</span>
                  </div>
                </div>
                <div className={`app-background-settings ${appBackground.enabled && appBackground.path ? 'enabled' : ''}`}>
                  <div className={`app-background-preview ${appBackground.path ? 'has-image' : ''}`}>
                    {appBackground.path
                      ? <img src={backgroundAssetUrl} alt="" />
                      : <div className="app-background-preview-empty"><ImageIcon size={24} /><span>{t('尚未选择背景图片')}</span></div>}
                    <div
                      className="app-background-preview-material"
                      style={{
                        backgroundColor: toAlphaColor(
                          appThemePresetMap[themePreset].themes[appearance].surface,
                          Math.max(0.55, 1 - appBackground.transparency / 100),
                        ),
                      }}
                    >
                      <span /><span /><span />
                    </div>
                  </div>
                  <div className="app-background-controls">
                    <div className="app-background-toggle-row">
                      <div>
                        <strong>{t('使用自定义背景')}</strong>
                        <span>{t(appBackground.enabled && appBackground.path ? '背景与透明度已生效' : '当前使用默认纯色背景')}</span>
                      </div>
                      <button
                        className={`settings-switch ${appBackground.enabled && appBackground.path ? 'active' : ''}`}
                        type="button"
                        role="switch"
                        aria-checked={Boolean(appBackground.enabled && appBackground.path)}
                        aria-label={t('启用自定义背景')}
                        disabled={backgroundBusy}
                        onClick={() => onBackgroundEnabledChange(!(appBackground.enabled && appBackground.path))}
                      >
                        <span />
                      </button>
                    </div>
                    <div className="app-background-file-row">
                      <div title={appBackground.path || t('尚未选择背景图片')}>
                        <ImageIcon size={14} />
                        <span>{appBackground.name || t('尚未选择背景图片')}</span>
                      </div>
                      <button type="button" onClick={onBackgroundChoose} disabled={backgroundBusy}>
                        <FolderOpen size={13} />
                        {t(appBackground.path ? '更换图片' : '选择图片')}
                      </button>
                      {appBackground.path && (
                        <button className="danger" type="button" onClick={onBackgroundClear} disabled={backgroundBusy}>
                          <Trash2 size={13} />
                          {t('清除')}
                        </button>
                      )}
                    </div>
                    <label className={`app-transparency-control ${!appBackground.enabled || !appBackground.path ? 'disabled' : ''}`}>
                      <span>{t('整体透明度')}</span>
                      <output>{appBackground.transparency}%</output>
                      <input
                        type="range"
                        min={MIN_APP_BACKGROUND_TRANSPARENCY}
                        max={MAX_APP_BACKGROUND_TRANSPARENCY}
                        step={1}
                        value={appBackground.transparency}
                        disabled={!appBackground.enabled || !appBackground.path || backgroundBusy}
                        onChange={(event) => onBackgroundTransparencyChange(Number(event.target.value))}
                        aria-label={t('整体透明度')}
                      />
                      <em>{t('更清晰')}</em>
                      <em>{t('更通透')}</em>
                    </label>
                  </div>
                </div>
                <div className="settings-section-head settings-section-spaced">
                  <Terminal size={16} />
                  <div>
                    <strong>{t('终端字体')}</strong>
                    <span>{t('调整所有本地和远程终端的显示字号。')}</span>
                  </div>
                </div>
                <label className="terminal-font-size-control">
                  <span>{t('字体大小')}</span>
                  <output>{terminalFontSize}px</output>
                  <input
                    type="range"
                    min={MIN_TERMINAL_FONT_SIZE}
                    max={MAX_TERMINAL_FONT_SIZE}
                    step={1}
                    value={terminalFontSize}
                    onChange={(event) => onTerminalFontSizeChange(normalizeTerminalFontSize(event.target.value))}
                    aria-label={t('终端字体大小')}
                  />
                  <em>{MIN_TERMINAL_FONT_SIZE}px</em>
                  <em>{MAX_TERMINAL_FONT_SIZE}px</em>
                </label>
              </>
            )}
            {section === 'language' && (
              <>
                <div className="settings-section-head">
                  <Languages size={16} />
                  <div>
                    <strong>{t('显示语言')}</strong>
                    <span>{t('选择应用界面使用的语言。')}</span>
                  </div>
                </div>
                <label className="field settings-select-field">
                  <span>{t('显示语言')}</span>
                  <select
                    value={displayLanguage}
                    onChange={(event) => onDisplayLanguageChange(event.target.value as AppLanguage)}
                  >
                    <option value="system">{t('跟随系统')}</option>
                    <option value="zh-CN">简体中文</option>
                    <option value="en-US">English</option>
                  </select>
                </label>
                <div className="locale-detected-row">
                  <Languages size={15} />
                  <span>{t('当前生效')}</span>
                  <strong>{resolvedLanguage === 'zh-CN' ? '简体中文' : 'English'}</strong>
                </div>

                <div className="settings-section-head settings-section-spaced">
                  <Clock3 size={16} />
                  <div>
                    <strong>{t('时区')}</strong>
                    <span>{t('自动读取系统时区，用于历史记录和文件时间。')}</span>
                  </div>
                </div>
                <label className="field settings-select-field">
                  <span>{t('时区')}</span>
                  <select value={timeZonePreference} onChange={(event) => onTimeZonePreferenceChange(event.target.value)}>
                    <option value="system">
                      {t('跟随系统')} - {systemTimeZone} ({getTimeZoneOffsetLabel(systemTimeZone, resolvedLanguage)})
                    </option>
                    {COMMON_TIME_ZONES.filter((zone) => zone !== systemTimeZone).map((zone) => (
                      <option value={zone} key={zone}>{zone} ({getTimeZoneOffsetLabel(zone, resolvedLanguage)})</option>
                    ))}
                  </select>
                </label>
                <div className="locale-detected-row">
                  <Clock3 size={15} />
                  <span>{t('系统检测')}</span>
                  <strong>{systemTimeZone} · {getTimeZoneOffsetLabel(systemTimeZone, resolvedLanguage)}</strong>
                </div>
              </>
            )}
            {section === 'servers' && (
              <>
                <InfoRow icon={<Terminal size={16} />} label="Terminal" value="xterm.js" />
                <InfoRow icon={<Wifi size={16} />} label="SSH" value={t('内置 PTY')} />
                <label className="field">
                  <span>{t('远程辅助并发')}</span>
                  <input
                    type="number"
                    min={MIN_REMOTE_AUX_CONCURRENCY}
                    max={MAX_REMOTE_AUX_CONCURRENCY}
                    value={remoteAuxConcurrency}
                    onChange={(event) => {
                      onRemoteAuxConcurrencyChange(normalizeRemoteAuxConcurrency(event.target.value))
                    }}
                  />
                </label>
                <p className="settings-note">
                  {t('影响远程文件、文件读写和机器监控等辅助 SSH 请求；SSH 终端连接本身不占用这个并发池。')}
                </p>
                <div className="settings-actions">
                  <button className="ghost-button" type="button" onClick={onImportSshConfig}>
                    <FolderOpen size={15} />
                    {t('导入 SSH config')}
                  </button>
                  <button className="ghost-button" type="button" onClick={onExport}>
                    <Download size={15} />
                    {t('复制配置')}
                  </button>
                  <button className="ghost-button" type="button" onClick={onReset}>
                    <RotateCcw size={15} />
                    {t('重置')}
                  </button>
                </div>
                <label className="field import-field">
                  <span>{t('导入服务器 JSON')}</span>
                  <textarea value={importText} onChange={(event) => setImportText(event.target.value)} />
                </label>
                <button className="connect-button compact" type="button" onClick={() => onImport(importText)}>
                  {t('导入配置')}
                </button>
              </>
            )}
            {section === 'about' && (
              <motion.div
                className="about-page"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.34, ease: [0.16, 1, 0.3, 1] }}
              >
                <section className="about-product-card">
                  <img className="about-product-mark" src="/rain-terminal-icon.svg" alt="" />
                  <div className="about-product-copy">
                    <div className="about-product-title">
                      <h3>RainTerminal</h3>
                      <span>v{updateResult?.currentVersion ?? APP_VERSION}</span>
                    </div>
                    <p>{t('面向 Windows 的一体化运维工作台，将终端、文件、监控、进程、远程桌面与自动化巡检集中在可持久化工作区中。')}</p>
                    <div className="about-capabilities" aria-label={t('核心能力')}>
                      <span>{t('SSH 终端')}</span>
                      <span>{t('文件管理')}</span>
                      <span>{t('监控与进程')}</span>
                      <span>{t('远程桌面')}</span>
                    </div>
                  </div>
                </section>

                <section className={`about-update-card ${updateResult?.status ?? 'idle'}`}>
                  <div className="about-card-heading">
                    <span className="about-card-icon"><RefreshCw className={updateBusy ? 'is-spinning' : ''} size={16} /></span>
                    <div>
                      <strong>{t('软件更新')}</strong>
                      <small>{t('当前版本')} v{updateResult?.currentVersion ?? APP_VERSION}</small>
                    </div>
                    <button
                      className="ghost-button compact"
                      type="button"
                      disabled={updateBusy || updateDownload.status === 'downloading' || updateDownload.status === 'launching'}
                      onClick={() => { void checkForUpdates() }}
                    >
                      <RefreshCw className={updateBusy ? 'is-spinning' : ''} size={14} />
                      {t(updateBusy ? '正在检查…' : '检查更新')}
                    </button>
                  </div>
                  <div className="about-update-status" role="status" aria-live="polite">
                    <i />
                    <span>
                      {updateBusy
                        ? t('正在连接更新服务…')
                        : updateResult?.status === 'available'
                          ? <>{t('发现新版本')} v{updateResult.latestVersion ?? ''}</>
                          : t(updateResult?.status === 'current'
                            ? '当前已是最新版本。'
                            : updateResult?.status === 'unavailable'
                              ? '暂时无法连接更新服务；开源后可前往仓库查看最新版本。'
                              : '点击检查更新以获取最新版本信息。')}
                    </span>
                    {updateResult?.status === 'available' && updateResult.releaseUrl && !updateResult.installer && (
                      <button type="button" onClick={() => {
                        if (updateResult.releaseUrl) void openExternalUrl(updateResult.releaseUrl)
                      }}>
                        {t('前往仓库')}<ExternalLink size={13} />
                      </button>
                    )}
                  </div>
                  {updateResult?.notes && <p className="about-update-notes">{updateResult.notes}</p>}
                  {updateResult?.status === 'available' && (
                    <div className="about-update-download">
                      <div className="about-update-package">
                        <span><ShieldCheck size={14} />{t(updateResult.installer ? '官方安装包 · SHA-256 校验' : '当前版本仅提供手动下载')}</span>
                        {updateResult.installer && <em>{formatBytes(updateResult.installer.size)}</em>}
                      </div>
                      {updateResult.installer && updateDownload.status !== 'idle' && (
                        <div className={`about-update-progress status-${updateDownload.status}`}>
                          <div className="about-update-progress-track" aria-label={t('更新下载进度')}>
                            <span style={{ width: `${fileDownloadPercent(updateDownload)}%` }} />
                          </div>
                          <div className="about-update-progress-meta">
                            <span>
                              {t(updateDownload.status === 'downloading'
                                ? '正在下载并校验安装包'
                                : updateDownload.status === 'ready'
                                  ? '安装包校验完成'
                                  : updateDownload.status === 'cancelled'
                                    ? '更新下载已取消'
                                    : updateDownload.status === 'error'
                                      ? '更新下载失败'
                                      : updateDownload.status === 'launching'
                                        ? '正在启动安装程序…'
                                        : '安装程序已启动，请按提示完成更新。')}
                            </span>
                            {updateDownload.status === 'downloading' && (
                              <em>
                                {formatBytes(updateDownload.transferredBytes)} / {formatBytes(updateDownload.totalBytes)}
                                {updateDownload.bytesPerSecond > 0 ? ` · ${formatBytes(updateDownload.bytesPerSecond)}/s` : ''}
                              </em>
                            )}
                          </div>
                        </div>
                      )}
                      {updateDownload.error && <p className="about-update-error" role="alert">{updateDownload.error}</p>}
                      <div className="about-update-download-actions">
                        {updateResult.installer && (updateDownload.status === 'idle' || updateDownload.status === 'error' || updateDownload.status === 'cancelled') && (
                          <button className="connect-button compact" type="button" onClick={() => { void downloadAppUpdate() }}>
                            <Download size={14} />{t(updateDownload.status === 'idle' ? '下载更新' : '重新下载')}
                          </button>
                        )}
                        {updateDownload.status === 'downloading' && (
                          <button className="ghost-button compact" type="button" onClick={() => { void cancelAppUpdateDownload() }}>
                            <X size={14} />{t('取消下载')}
                          </button>
                        )}
                        {(updateDownload.status === 'ready' || updateDownload.status === 'launching') && (
                          <button className="connect-button compact" type="button" disabled={updateDownload.status === 'launching'} onClick={() => { void launchAppUpdate() }}>
                            <PackageOpen size={14} />{t(updateDownload.status === 'launching' ? '正在启动…' : '打开安装程序')}
                          </button>
                        )}
                        {updateResult.releaseUrl && (
                          <button className="ghost-button compact" type="button" onClick={() => {
                            if (updateResult.releaseUrl) void openExternalUrl(updateResult.releaseUrl)
                          }}>
                            <ExternalLink size={14} />{t('查看发布说明')}
                          </button>
                        )}
                      </div>
                      {updateResult.installer && (
                        <small className="about-update-safety-note">{t('下载后会自动核对文件大小与 SHA-256；安装仍需由你确认，不会静默覆盖。')}</small>
                      )}
                    </div>
                  )}
                </section>

                {externalLinkFeedback && <p className="about-inline-feedback" role="status">{t(externalLinkFeedback)}</p>}

                <section className="about-security-card">
                  <InfoRow icon={<ShieldCheck size={16} />} label={t('凭据存储')} value="Windows Credential Manager" />
                  <p className="settings-note">
                    {t('连接密码不会写入浏览器存储或配置导出；诊断日志会轮转并对常见凭据字段脱敏。')}
                  </p>
                  <button className="ghost-button" type="button" onClick={onExportDiagnostics}>
                    <Download size={15} />
                    {t('导出脱敏诊断日志')}
                  </button>
                </section>
              </motion.div>
            )}
          </section>
        </div>
      </motion.section>
    </motion.div>
  )
}

function CommandPalette({
  server,
  connectionState,
  onClose,
  onConnect,
  onDisconnect,
  onCommand,
  onAddServer,
  onSettings,
  onClear,
  onCopy,
  snippets,
}: {
  server: ServerProfile
  connectionState: ConnectionState
  onClose: () => void
  onConnect: () => void
  onDisconnect: () => void
  onCommand: (command: string) => void
  onAddServer: () => void
  onSettings: () => void
  onClear: () => void
  onCopy: () => void
  snippets: Snippet[]
}) {
  const { t } = useAppLocale()
  const [term, setTerm] = useState('')
  const commandSet = getQuickCommands(connectionState)
  const actions = [
    {
      title: connectionState === 'connected' ? '断开当前 SSH' : '连接当前服务器',
      detail: formatServerAddress(server),
      group: '会话',
      run: connectionState === 'connected' ? onDisconnect : onConnect,
    },
    { title: '清空终端', detail: '清除当前屏幕输出', group: '会话', run: onClear },
    { title: '复制终端输出', detail: '复制当前缓冲区文本', group: '会话', run: onCopy },
    { title: '添加服务器', detail: '创建新的 SSH 配置', group: '配置', run: onAddServer },
    { title: '打开设置', detail: '导入、导出、重置配置', group: '配置', run: onSettings },
    ...commandSet.map((item) => ({
      title: item.label,
      detail: item.command,
      group: item.group,
      run: () => onCommand(item.command),
    })),
    ...snippets.map((snippet) => ({
      title: snippet.name,
      detail: snippet.command,
      group: '片段',
      run: () => onCommand(snippet.command),
    })),
  ]

  const normalizedTerm = term.trim().toLowerCase()
  const localizedActions = actions
    .map((action) => {
      const localized = {
        ...action,
        title: t(action.title),
        detail: t(action.detail),
        group: t(action.group),
      }
      return {
        ...localized,
        searchText: [
          action.title,
          action.detail,
          action.group,
          localized.title,
          localized.detail,
          localized.group,
        ].join('\n').toLowerCase(),
      }
    })
    .filter((action) => !normalizedTerm || action.searchText.includes(normalizedTerm))

  function runAndClose(action: () => void) {
    action()
    onClose()
  }

  return (
    <motion.div
      className="modal-backdrop palette-backdrop"
      onPointerDown={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <motion.section
        className="command-palette"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: -12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -8 }}
        transition={{ duration: 0.20, ease: [0.22, 1, 0.36, 1] }}
      >
        <label className="palette-search">
          <Search size={16} />
          <input
            autoFocus
            aria-label={t('搜索命令、片段、设置...')}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={t('搜索命令、片段、设置...')}
          />
          <button className="palette-close" type="button" onClick={onClose} aria-label={t('关闭命令面板')} title={`${t('关闭')} (Esc)`}>
            <X size={14} />
          </button>
        </label>
        <div className="palette-list">
          {localizedActions.map((action) => (
            <button
              type="button"
              className="palette-item"
              onClick={() => runAndClose(action.run)}
              key={`${action.group}-${action.title}-${action.detail}`}
            >
              <span>{action.group}</span>
              <strong>{action.title}</strong>
              <em>{action.detail}</em>
            </button>
          ))}
          {localizedActions.length === 0 && <p className="empty-note">{t('没有匹配的命令。')}</p>}
        </div>
      </motion.section>
    </motion.div>
  )
}

function ContextMenu({
  menu,
  onClose,
}: {
  menu: NonNullable<ContextMenuState>
  onClose: () => void
}) {
  const { t } = useAppLocale()
  return (
    <motion.div
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      initial={{ opacity: 0, scale: 0.96, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 2 }}
      transition={{ duration: 0.1, ease: [0.25, 1, 0.5, 1] }}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
    >
      {menu.items.map((item) => (
        <button
          type="button"
          className={`${item.danger ? 'danger ' : ''}${item.separatorBefore ? 'separator-before' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return
            item.onClick()
            onClose()
          }}
          key={`${item.label}-${item.hint ?? ''}`}
        >
          {item.icon && <i>{item.icon}</i>}
          <span>{t(item.label)}</span>
          {item.hint && <em>{item.hint}</em>}
        </button>
      ))}
    </motion.div>
  )
}

function EditableField({
  label,
  value,
  onChange,
  required,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} required={required} />
    </label>
  )
}

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const { t } = useAppLocale()
  const [focused, setFocused] = useState(false)
  const [visible, setVisible] = useState(false)
  const showToggle = focused || value.length > 0

  return (
    <label className={`field password-field ${showToggle ? 'show-toggle' : ''}`}>
      <span>{label}</span>
      <div className="password-input-wrap">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
        />
        <button
          type="button"
          role="menuitem"
          aria-label={t(visible ? '隐藏密码' : '显示密码')}
          title={t(visible ? '隐藏密码' : '显示密码')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
          tabIndex={showToggle ? 0 : -1}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </label>
  )
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{icon}</span>
      <strong>{label}</strong>
      <em>{value}</em>
    </div>
  )
}

function diag(scope: string, message: string) {
  const line = `${Math.round(performance.now())} ${message}`
  console.debug(`[diag:${scope}] ${line}`)
  void invoke('diag_log_frontend', { scope, message: line }).catch(() => undefined)
}

function isLocalShellStaleError(error: unknown) {
  return /LOCAL_SHELL_STALE|local shell is not running|broken pipe|pipe (?:is being closed|has been ended)|管道.*(?:关闭|结束)|os error (?:109|232)/i
    .test(String(error ?? ''))
}

function getRemoteTerminalPreview(value: string) {
  const normalized = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  const preview = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-5)
    .join('\n')
  return preview || '等待终端输出...'
}

function formatSshHealth(health: SshHealthPayload | null) {
  if (!health) return '会话初始化中'
  if (!health.connected) return 'SSH 已断开'
  const idleSeconds = Math.max(0, Math.round(health.idle_ms / 1000))
  if (idleSeconds <= 3) return '实时接收中'
  if (idleSeconds < 60) return `无输出 ${idleSeconds}s`
  const idleMinutes = Math.floor(idleSeconds / 60)
  const restSeconds = idleSeconds % 60
  return restSeconds ? `无输出 ${idleMinutes}m${restSeconds}s` : `无输出 ${idleMinutes}m`
}

function appendTerminalOutputCache(
  cache: Map<string, string>,
  sessionId: string,
  data: string,
  limit = REMOTE_TERMINAL_REPLAY_LIMIT,
) {
  if (!data) return
  const next = `${cache.get(sessionId) ?? ''}${data}`
  cache.set(sessionId, next.length > limit ? next.slice(-limit) : next)
}

function bufferTerminalWrite(
  terminalRef: MutableRefObject<XTerm | null>,
  queueRef: MutableRefObject<string>,
  frameRef: MutableRefObject<number | null>,
  data: string,
  options: { autoScroll?: boolean; chunkSize?: number; queueLimit?: number; immediateSmallWrites?: boolean } = {},
) {
  if (!data) return
  const terminal = terminalRef.current
  if (
    options.immediateSmallWrites
    && data.length <= 512
    && terminal
    && !queueRef.current
    && frameRef.current === null
  ) {
    terminal.write(data)
    return
  }
  const beforeLength = queueRef.current.length
  queueRef.current += data
  const queueLimit = options.queueLimit ?? TERMINAL_WRITE_QUEUE_LIMIT
  if (queueRef.current.length > queueLimit) {
    diag('xterm-queue', `trim before=${queueRef.current.length} limit=${queueLimit}`)
    queueRef.current = queueRef.current.slice(-queueLimit)
  }
  if (data.length > 64 * 1024 || queueRef.current.length > 512 * 1024) {
    diag('xterm-queue', `push bytes=${data.length} before=${beforeLength} after=${queueRef.current.length}`)
  }
  if (frameRef.current !== null) return

  scheduleTerminalWrite(terminalRef, queueRef, frameRef, options)
}

function scheduleTerminalWrite(
  terminalRef: MutableRefObject<XTerm | null>,
  queueRef: MutableRefObject<string>,
  frameRef: MutableRefObject<number | null>,
  options: { autoScroll?: boolean; chunkSize?: number; queueLimit?: number; immediateSmallWrites?: boolean } = {},
) {
  frameRef.current = window.requestAnimationFrame(() => {
    const started = performance.now()
    const terminal = terminalRef.current
    if (!terminal || !queueRef.current) {
      frameRef.current = null
      return
    }
    const chunkSize = options.chunkSize ?? TERMINAL_WRITE_CHUNK_SIZE
    const output = queueRef.current.slice(0, chunkSize)
    queueRef.current = queueRef.current.slice(output.length)
    terminal.write(output, () => {
      const elapsed = performance.now() - started
      if (elapsed > DIAG_SLOW_MS || queueRef.current.length > 512 * 1024 || output.length > 64 * 1024) {
        diag('xterm-write', `chunk=${output.length} remaining=${queueRef.current.length} elapsed_ms=${elapsed.toFixed(1)} autoScroll=${options.autoScroll ?? true}`)
      }
      if (queueRef.current) {
        scheduleTerminalWrite(terminalRef, queueRef, frameRef, options)
      } else {
        frameRef.current = null
        if (options.autoScroll ?? true) scheduleTerminalScrollToBottom(terminalRef)
      }
    })
  })
}

function scheduleTerminalFit(
  fitAddonRef: MutableRefObject<FitAddon | null>,
  frameRef: MutableRefObject<number | null>,
  onFit?: () => void,
) {
  if (frameRef.current !== null) return
  frameRef.current = window.requestAnimationFrame(() => {
    const started = performance.now()
    frameRef.current = null
    try {
      fitAddonRef.current?.fit()
      onFit?.()
    } catch (error) {
      diag('xterm-fit', `error=${String(error)}`)
    }
    const elapsed = performance.now() - started
    if (elapsed > 16) diag('xterm-fit', `elapsed_ms=${elapsed.toFixed(1)}`)
  })
}

function signalWorkbenchLayoutSettled() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event(WORKBENCH_LAYOUT_SETTLED_EVENT))
    })
  })
}

function scheduleTerminalScrollToBottom(terminalRef: MutableRefObject<XTerm | null>) {
  window.requestAnimationFrame(() => {
    const started = performance.now()
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.scrollToBottom()
    const elapsed = performance.now() - started
    if (elapsed > 16) diag('xterm-scroll', `elapsed_ms=${elapsed.toFixed(1)}`)
  })
}

function normalizeImeAsciiPreedit(value: string) {
  const normalized = value.normalize('NFKC').replace(/['’‘\s]/g, '')
  if (!normalized) return ''
  for (const character of normalized) {
    const code = character.charCodeAt(0)
    if (code < 33 || code > 126) return ''
  }
  return normalized
}

function attachTerminalImeShiftCommit(
  host: HTMLElement,
  terminal: XTerm,
  commitInput: (data: string) => void,
) {
  let composing = false
  let preedit = ''
  let pendingRaw = ''
  let commitTimer: number | null = null
  let compositionLayoutFrame: number | null = null

  const compositionMirror = document.createElement('div')
  compositionMirror.className = 'terminal-composition-mirror'
  compositionMirror.setAttribute('aria-hidden', 'true')

  const hideCompositionMirror = () => {
    compositionMirror.classList.remove('active')
    host.querySelector<HTMLElement>('.composition-view')?.classList.remove('terminal-composition-source-hidden')
  }

  const updateCompositionMirror = () => {
    compositionLayoutFrame = null
    if (!composing || !preedit) {
      hideCompositionMirror()
      return
    }

    const screen = host.querySelector<HTMLElement>('.xterm-screen')
    const compositionView = host.querySelector<HTMLElement>('.composition-view.active')
    if (!screen || !compositionView) return
    if (compositionMirror.parentElement !== screen) screen.appendChild(compositionMirror)

    const cursorLeft = Number.parseFloat(compositionView.style.left) || 0
    const cursorTop = Number.parseFloat(compositionView.style.top) || 0
    const cellHeight = Number.parseFloat(compositionView.style.lineHeight)
      || Number.parseFloat(compositionView.style.height)
      || terminal.options.fontSize
      || 12

    compositionMirror.textContent = preedit
    compositionMirror.style.top = `${cursorTop}px`
    compositionMirror.style.width = `${screen.clientWidth}px`
    compositionMirror.style.minHeight = `${cellHeight}px`
    compositionMirror.style.lineHeight = `${cellHeight}px`
    compositionMirror.style.fontFamily = compositionView.style.fontFamily || String(terminal.options.fontFamily ?? '')
    compositionMirror.style.fontSize = compositionView.style.fontSize || `${terminal.options.fontSize ?? 12}px`
    compositionMirror.style.textIndent = `${cursorLeft}px`
    compositionMirror.classList.add('active')
    compositionView.classList.add('terminal-composition-source-hidden')
  }

  const scheduleCompositionMirror = () => {
    if (compositionLayoutFrame !== null) window.cancelAnimationFrame(compositionLayoutFrame)
    compositionLayoutFrame = window.requestAnimationFrame(updateCompositionMirror)
  }

  const dataListener = terminal.onData((data) => {
    if (!pendingRaw) return
    const submitted = normalizeImeAsciiPreedit(data)
    if (submitted !== pendingRaw) return
    pendingRaw = ''
    clearCommitTimer()
  })

  const clearCommitTimer = () => {
    if (commitTimer === null) return
    window.clearTimeout(commitTimer)
    commitTimer = null
  }

  const flushPendingRaw = () => {
    clearCommitTimer()
    const raw = pendingRaw
    pendingRaw = ''
    if (raw) commitInput(raw)
  }

  const schedulePendingCommit = (delay: number) => {
    clearCommitTimer()
    commitTimer = window.setTimeout(flushPendingRaw, delay)
  }

  const armShiftCommit = () => {
    const raw = normalizeImeAsciiPreedit(preedit)
    if (!raw) return
    pendingRaw = raw
    schedulePendingCommit(700)
  }

  const handleCompositionStart = () => {
    composing = true
    preedit = ''
    pendingRaw = ''
    clearCommitTimer()
    hideCompositionMirror()
  }

  const handleCompositionUpdate = (event: globalThis.CompositionEvent) => {
    composing = true
    preedit = event.data ?? ''
    scheduleCompositionMirror()
  }

  const handleCompositionEnd = () => {
    composing = false
    preedit = ''
    if (compositionLayoutFrame !== null) {
      window.cancelAnimationFrame(compositionLayoutFrame)
      compositionLayoutFrame = null
    }
    hideCompositionMirror()
    if (pendingRaw) schedulePendingCommit(40)
  }

  const handleKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.key !== 'Shift' || (!composing && !event.isComposing)) return
    armShiftCommit()
  }

  const handleKeyUp = (event: globalThis.KeyboardEvent) => {
    if (event.key !== 'Shift') return
    if (!pendingRaw && (composing || event.isComposing)) armShiftCommit()
    if (pendingRaw) schedulePendingCommit(40)
  }

  host.addEventListener('compositionstart', handleCompositionStart, true)
  host.addEventListener('compositionupdate', handleCompositionUpdate, true)
  host.addEventListener('compositionend', handleCompositionEnd, true)
  host.addEventListener('keydown', handleKeyDown, true)
  host.addEventListener('keyup', handleKeyUp, true)

  return () => {
    clearCommitTimer()
    if (compositionLayoutFrame !== null) window.cancelAnimationFrame(compositionLayoutFrame)
    hideCompositionMirror()
    compositionMirror.remove()
    dataListener.dispose()
    host.removeEventListener('compositionstart', handleCompositionStart, true)
    host.removeEventListener('compositionupdate', handleCompositionUpdate, true)
    host.removeEventListener('compositionend', handleCompositionEnd, true)
    host.removeEventListener('keydown', handleKeyDown, true)
    host.removeEventListener('keyup', handleKeyUp, true)
  }
}

async function writeTerminalClipboard(text: string) {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.readOnly = true
    textarea.style.position = 'fixed'
    textarea.style.inset = '0 auto auto -9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      textarea.remove()
    }
  }
}

function attachTerminalContextMenu(
  host: HTMLElement,
  terminal: XTerm,
  setMenu: (menu: ContextMenuState) => void,
) {
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      if (text) terminal.paste(text)
    } catch {
      // Clipboard access can be denied by the system; keep the terminal focused.
    }
  }

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const isCopyShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c'
    if (!isCopyShortcut) return true
    const selection = terminal.getSelection()
    if (!selection) return true

    event.preventDefault()
    event.stopPropagation()
    void writeTerminalClipboard(selection).finally(() => terminal.focus())
    return false
  })

  function openTerminalMenu(event: globalThis.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const selection = terminal.getSelection()
    terminal.focus()
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 300)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 220)),
      items: [
        {
          label: '复制',
          hint: 'Ctrl+C',
          icon: <Copy size={14} />,
          disabled: !selection,
          onClick: () => {
            void writeTerminalClipboard(selection).finally(() => terminal.focus())
          },
        },
        {
          label: '粘贴',
          hint: 'Ctrl+V',
          icon: <ClipboardPaste size={14} />,
          onClick: () => {
            void pasteFromClipboard().finally(() => terminal.focus())
          },
        },
      ],
    })
  }

  host.addEventListener('contextmenu', openTerminalMenu, true)
  return () => host.removeEventListener('contextmenu', openTerminalMenu, true)
}

function getQuickCommands(connectionState: ConnectionState) {
  return connectionState === 'connected' ? remoteQuickCommands : localQuickCommands
}

function createWorkbenchWidget(
  type: WorkbenchWidgetType,
  sameTypeCount: number,
  totalCount = 0,
): WorkbenchWidget {
  const column = totalCount % 3
  const row = Math.floor(totalCount / 3)
  const offsetX = column * 34
  const offsetY = row * 34
  const id = `${type}-${crypto.randomUUID()}`
  const presets: Record<WorkbenchWidgetType, Omit<WorkbenchWidget, 'id' | 'type'>> = {
    'local-terminal': {
      title: `本地终端 ${sameTypeCount + 1}`,
      x: 88 + offsetX,
      y: 86 + offsetY,
      w: 560,
      h: 380,
    },
    'ssh-terminal': {
      title: `SSH 终端 ${sameTypeCount + 1}`,
      x: 88 + offsetX,
      y: 86 + offsetY,
      w: 640,
      h: 420,
    },
    files: {
      title: `文件管理 ${sameTypeCount + 1}`,
      x: 540 + offsetX,
      y: 92 + offsetY,
      w: 620,
      h: 560,
    },
    monitor: {
      title: `机器占用 ${sameTypeCount + 1}`,
      x: 500 + offsetX,
      y: 72 + offsetY,
      w: 380,
      h: 276,
    },
    processes: {
      title: `系统进程 ${sameTypeCount + 1}`,
      x: 450 + offsetX,
      y: 82 + offsetY,
      w: 680,
      h: 480,
    },
    'remote-desktop': {
      title: `远程桌面 ${sameTypeCount + 1}`,
      x: 96 + offsetX,
      y: 72 + offsetY,
      w: 820,
      h: 540,
    },
  }

  return {
    id,
    type,
    ...presets[type],
    ...(type === 'ssh-terminal' ? { sessionId: `ssh-${crypto.randomUUID()}` } : {}),
    ...(type === 'local-terminal' ? { sessionId: `local-${crypto.randomUUID()}` } : {}),
    ...(type === 'remote-desktop' ? { sessionId: `desktop-${crypto.randomUUID()}` } : {}),
  }
}

function getWorkbenchDeckDensityClass(widgetCount: number) {
  if (widgetCount >= 12) return 'deck-ultra-dense'
  if (widgetCount >= 8) return 'deck-dense'
  return ''
}

function getWorkbenchDeckHeight(widgets: WorkbenchWidget[]) {
  if (!widgets.length) return 560
  return Math.max(560, ...widgets.map((widget) => widget.y + widget.h + 14))
}

function getRemoteWidgetSessionId(widget: WorkbenchWidget) {
  return widget.sessionId ?? widget.id
}

function getLocalWidgetSessionId(widget: WorkbenchWidget) {
  return widget.sessionId ?? widget.id
}

function getRemoteDesktopWidgetSessionId(widget: WorkbenchWidget) {
  return widget.sessionId ?? widget.id
}

function widgetIcon(type: WorkbenchWidgetType) {
  const icons: Record<WorkbenchWidgetType, ReactNode> = {
    'local-terminal': <Terminal size={13} />,
    'ssh-terminal': <Terminal size={13} />,
    files: <FolderTree size={13} />,
    monitor: <Activity size={13} />,
    processes: <ListTree size={13} />,
    'remote-desktop': <Monitor size={13} />,
  }

  return icons[type]
}

function getParentPath(path: string) {
  if (!path) return ''
  const normalized = path.replace(/[\\/]+$/, '')
  if (normalized.startsWith('/')) {
    if (!normalized || normalized === '/') return '/'
    const separatorIndex = normalized.lastIndexOf('/')
    return separatorIndex <= 0 ? '/' : normalized.slice(0, separatorIndex)
  }
  const separatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  if (separatorIndex <= 0) return path
  if (/^[A-Za-z]:$/.test(normalized.slice(0, separatorIndex))) {
    return `${normalized.slice(0, separatorIndex)}\\`
  }
  return normalized.slice(0, separatorIndex)
}

function getRemoteParentPath(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  if (normalized === '~' || normalized === '/root') return '/'
  return getParentPath(path)
}

function isWindowsDriveRoot(path: string) {
  return /^[A-Za-z]:[\\/]?$/.test(path.trim())
}

function normalizeSubmittedPath(value: string, remote: boolean) {
  let normalized = value.trim()
  if (normalized.length >= 2) {
    const first = normalized[0]
    const last = normalized[normalized.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      normalized = normalized.slice(1, -1).trim()
    }
  }
  if (!remote && /^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`
  return normalized
}

function applyWorkbenchLayout(
  widgets: WorkbenchWidget[],
  preset: WorkbenchLayoutPreset,
  viewport: WorkbenchViewport,
) {
  if (widgets.length === 0) return widgets

  if (preset === 'local-remote') {
    return applyLocalRemoteLayout(widgets, viewport)
  }

  if (preset === 'groups') {
    return applyServerGroupLayout(widgets, viewport)
  }

  if (preset !== 'wave') {
    const slots = createWorkbenchLayoutSlots(widgets.length, preset, viewport)
    return widgets.map((widget, index) => ({
      ...widget,
      ...slots[index],
      maximized: false,
      restore: undefined,
    }))
  }

  const padding = 10
  const x = padding
  const y = padding
  const width = Math.max(320, viewport.width - padding * 2)
  const height = Math.max(240, viewport.height - padding * 2)
  const layoutRect = (left: number, top: number, w: number, h: number) => ({
    x: Math.round(x + left),
    y: Math.round(y + top),
    w: Math.max(240, Math.round(w)),
    h: Math.max(170, Math.round(h)),
  })

  const slotFor = (index: number) => {
    const count = widgets.length

    if (preset === 'wave') {
      const terminals = widgets.filter((widget) => widget.type === 'local-terminal' || widget.type === 'ssh-terminal')
      const monitors = widgets.filter((widget) => widget.type === 'monitor')
      const files = widgets.filter((widget) => widget.type === 'files')
      const widget = widgets[index]
      const leftWidth = terminals.length ? width * 0.36 : 0
      const middleWidth = monitors.length ? width * 0.24 : 0
      const rightWidth = width - leftWidth - middleWidth

      if (widget.type === 'local-terminal' || widget.type === 'ssh-terminal') {
        const terminalIndex = terminals.findIndex((item) => item.id === widget.id)
        const terminalHeight = height / Math.max(1, terminals.length)
        return layoutRect(0, terminalIndex * terminalHeight, leftWidth, terminalHeight)
      }
      if (widget.type === 'monitor') {
        const monitorIndex = monitors.findIndex((item) => item.id === widget.id)
        const monitorHeight = height / Math.max(1, monitors.length)
        return layoutRect(leftWidth, monitorIndex * monitorHeight, middleWidth, monitorHeight)
      }
      const fileIndex = files.findIndex((item) => item.id === widget.id)
      const fileWidth = rightWidth / Math.max(1, files.length)
      return layoutRect(leftWidth + middleWidth + fileIndex * fileWidth, 0, fileWidth, height)
    }

    if (preset === 'columns') {
      const columnWidth = width / count
      return layoutRect(index * columnWidth, 0, columnWidth, height)
    }

    if (preset === 'rows') {
      const rowHeight = height / count
      return layoutRect(0, index * rowHeight, width, rowHeight)
    }

    if (preset === 'focus-left' || preset === 'focus-right') {
      if (count === 1) return layoutRect(0, 0, width, height)
      const mainWidth = width * 0.62
      const sideWidth = width - mainWidth
      const sideCount = count - 1
      const sideRowHeight = height / sideCount
      if (preset === 'focus-left') {
        if (index === 0) return layoutRect(0, 0, mainWidth, height)
        return layoutRect(mainWidth, (index - 1) * sideRowHeight, sideWidth, sideRowHeight)
      }
      if (index === 0) return layoutRect(sideWidth, 0, mainWidth, height)
      return layoutRect(0, (index - 1) * sideRowHeight, sideWidth, sideRowHeight)
    }

    const columns = Math.ceil(Math.sqrt(count))
    const rows = Math.ceil(count / columns)
    const column = index % columns
    const row = Math.floor(index / columns)
    const columnWidth = width / columns
    const rowHeight = height / rows
    return layoutRect(column * columnWidth, row * rowHeight, columnWidth, rowHeight)
  }

  return widgets.map((widget, index) => ({
    ...widget,
    ...slotFor(index),
    maximized: false,
    restore: undefined,
  }))
}

function moveWorkbenchWidgetToIndex(widgets: WorkbenchWidget[], sourceId: string, targetIndex: number) {
  const sourceIndex = widgets.findIndex((widget) => widget.id === sourceId)
  if (sourceIndex < 0) return widgets

  const next = [...widgets]
  const [movedWidget] = next.splice(sourceIndex, 1)
  const safeIndex = Math.max(0, Math.min(Number.isFinite(targetIndex) ? Math.floor(targetIndex) : 0, next.length))
  next.splice(safeIndex, 0, movedWidget)
  return next
}

type WidgetGroup = {
  id: string
  serverId?: string
  widgets: WorkbenchWidget[]
}

function getDefaultWorkbenchViewport(): WorkbenchViewport {
  if (typeof window === 'undefined') return { width: 1180, height: 680 }
  const stage = document.querySelector<HTMLElement>('.workbench-stage')
  const deck = stage?.querySelector<HTMLElement>('.workspace-layer.active .remote-terminal-deck')
  return measureWorkbenchViewport(stage, deck)
}

function measureWorkbenchViewport(
  stage: HTMLElement | null | undefined,
  deck?: HTMLElement | null,
): WorkbenchViewport {
  return {
    width: Math.max(680, Math.round(deck?.clientWidth ?? stage?.clientWidth ?? window.innerWidth - 110)),
    height: Math.max(420, Math.round(stage?.clientHeight ?? window.innerHeight - 112)),
  }
}

function applyServerGroupLayout(widgets: WorkbenchWidget[], viewport: WorkbenchViewport) {
  if (widgets.length === 0) return widgets

  const groups = createWidgetGroups(widgets)
  const padding = 14
  const gap = 14
  const width = Math.max(560, viewport.width - padding * 2)
  const availableHeight = Math.max(420, viewport.height - padding * 2)
  const hasComplexGroup = groups.some((group) =>
    group.widgets.some((widget) => widget.type === 'files') || group.widgets.length >= 3,
  )
  const columns = hasComplexGroup ? 1 : getWorkbenchGroupColumns(groups.length, width)

  if (columns === 1) {
    const rects = new Map<string, WidgetRect>()
    let y = padding
    groups.forEach((group) => {
      const hasFiles = group.widgets.some((widget) => widget.type === 'files')
      const hasTerminal = group.widgets.some((widget) => widget.type === 'local-terminal' || widget.type === 'ssh-terminal')
      const groupHeight = hasFiles && hasTerminal
        ? Math.max(620, Math.min(760, availableHeight))
        : group.widgets.length > 1
          ? Math.max(440, Math.min(560, availableHeight))
          : Math.max(360, Math.min(520, availableHeight))
      const cell = {
        x: padding,
        y,
        w: width,
        h: groupHeight,
      }
      layoutWidgetsInsideGroup(group.widgets, cell).forEach((rect, widgetId) => {
        rects.set(widgetId, rect)
      })
      y += groupHeight + gap
    })

    return widgets.map((widget) => ({
      ...widget,
      ...(rects.get(widget.id) ?? {}),
      maximized: false,
      restore: undefined,
    }))
  }

  const rows = Math.ceil(groups.length / columns)
  const cellWidth = Math.floor((width - gap * (columns - 1)) / columns)
  const naturalCellHeight = groups.length === 1 ? availableHeight : Math.max(360, Math.floor((availableHeight - gap * (rows - 1)) / rows))
  const compactCellHeight = Math.max(260, Math.min(naturalCellHeight, groups.length > 2 ? 420 : availableHeight))
  const cellHeight = groups.length > 1 && rows * compactCellHeight + gap * (rows - 1) > availableHeight
    ? compactCellHeight
    : naturalCellHeight

  const rects = new Map<string, WidgetRect>()
  groups.forEach((group, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const cell = {
      x: padding + column * (cellWidth + gap),
      y: padding + row * (cellHeight + gap),
      w: cellWidth,
      h: cellHeight,
    }
    layoutWidgetsInsideGroup(group.widgets, cell).forEach((rect, widgetId) => {
      rects.set(widgetId, rect)
    })
  })

  return widgets.map((widget) => ({
    ...widget,
    ...(rects.get(widget.id) ?? {}),
    maximized: false,
    restore: undefined,
  }))
}

function shouldUseLocalRemoteLayout(widgets: WorkbenchWidget[]) {
  const hasLocal = widgets.some((widget) => !widget.serverId)
  const hasRemote = widgets.some((widget) => Boolean(widget.serverId))
  return hasLocal && hasRemote
}

function applyLocalRemoteLayout(widgets: WorkbenchWidget[], viewport: WorkbenchViewport) {
  if (widgets.length === 0) return widgets

  const localWidgets = widgets.filter((widget) => !widget.serverId)
  const remoteWidgets = widgets.filter((widget) => widget.serverId)
  if (localWidgets.length === 0 || remoteWidgets.length === 0) {
    return applyServerGroupLayout(widgets, viewport)
  }

  const padding = 14
  const gap = 14
  const width = Math.max(760, viewport.width - padding * 2)
  const height = Math.max(520, viewport.height - padding * 2)
  const remoteSideWidgets = remoteWidgets.filter((widget) => widget.type === 'monitor' || widget.type === 'files')
  const hasRemoteSide = remoteSideWidgets.length > 0
  let sideWidth = hasRemoteSide ? Math.max(320, Math.min(560, Math.round(width * 0.27))) : 0
  let terminalAreaWidth = hasRemoteSide ? width - sideWidth - gap * 2 : width - gap
  if (hasRemoteSide && terminalAreaWidth < 720) {
    sideWidth = Math.max(280, width - 720 - gap * 2)
    terminalAreaWidth = width - sideWidth - gap * 2
  }
  const localWidth = Math.max(300, Math.round(terminalAreaWidth * 0.48))
  const remoteTerminalWidth = Math.max(300, terminalAreaWidth - localWidth - gap)
  const rects = new Map<string, WidgetRect>()

  layoutLocalWidgets(localWidgets, { x: padding, y: padding, w: localWidth, h: height }).forEach((rect, widgetId) => {
    rects.set(widgetId, rect)
  })

  const remoteGroups = createWidgetGroups(remoteWidgets)
  let remoteY = padding
  remoteGroups.forEach((group, index) => {
    const isLast = index === remoteGroups.length - 1
    const remainingHeight = padding + height - remoteY
    const groupHeight = remoteGroups.length === 1
      ? height
      : Math.max(560, isLast ? remainingHeight : Math.min(700, Math.round(height * 0.72)))
    layoutRemoteServerColumns(group.widgets, {
      x: padding + localWidth + gap,
      y: remoteY,
      w: remoteTerminalWidth + (hasRemoteSide ? sideWidth + gap : 0),
      h: groupHeight,
    }, remoteTerminalWidth, sideWidth).forEach((rect, widgetId) => {
      rects.set(widgetId, rect)
    })
    remoteY += groupHeight + gap
  })

  return widgets.map((widget) => ({
    ...widget,
    ...(rects.get(widget.id) ?? {}),
    maximized: false,
    restore: undefined,
  }))
}

function layoutRemoteServerColumns(
  widgets: WorkbenchWidget[],
  area: WidgetRect,
  terminalWidth: number,
  sideWidth: number,
) {
  const result = new Map<string, WidgetRect>()
  const gap = 10
  const ordered = orderWidgetsForGroup(widgets)
  const terminals = ordered.filter((widget) => widget.type === 'ssh-terminal')
  const monitors = ordered.filter((widget) => widget.type === 'monitor')
  const files = ordered.filter((widget) => widget.type === 'files')
  const others = ordered.filter((widget) => !terminals.includes(widget) && !monitors.includes(widget) && !files.includes(widget))
  const rect = (x: number, y: number, w: number, h: number): WidgetRect => ({
    x: Math.round(x),
    y: Math.round(y),
    w: Math.max(260, Math.round(w)),
    h: Math.max(180, Math.round(h)),
  })

  const terminalWidgets = terminals.length ? terminals : ordered.filter((widget) => widget.type !== 'files' && widget.type !== 'monitor')
  if (terminalWidgets.length) {
    terminalWidgets.forEach((widget, index) => {
      const h = area.h / Math.max(1, terminalWidgets.length)
      result.set(widget.id, rect(area.x, area.y + index * h, terminalWidth, h - (terminalWidgets.length > 1 ? gap / 2 : 0)))
    })
  }

  if (sideWidth <= 0) {
    const remaining = ordered.filter((widget) => !result.has(widget.id))
    remaining.forEach((widget, index) => {
      const h = area.h / Math.max(1, remaining.length)
      result.set(widget.id, rect(area.x + terminalWidth + gap, area.y + index * h, Math.max(300, area.w - terminalWidth - gap), h))
    })
    return result
  }

  layoutSideWidgets(
    { monitors, files, others },
    { x: area.x + terminalWidth + gap, y: area.y, w: sideWidth, h: area.h },
    result,
    rect,
  )

  return result
}

function layoutLocalWidgets(widgets: WorkbenchWidget[], area: WidgetRect) {
  const result = new Map<string, WidgetRect>()
  const gap = 10
  const ordered = orderWidgetsForGroup(widgets)
  const rect = (x: number, y: number, w: number, h: number): WidgetRect => ({
    x: Math.round(x),
    y: Math.round(y),
    w: Math.max(260, Math.round(w)),
    h: Math.max(180, Math.round(h)),
  })

  if (ordered.length === 1) {
    result.set(ordered[0].id, rect(area.x, area.y, area.w, area.h))
    return result
  }

  const terminals = ordered.filter((widget) => widget.type === 'local-terminal')
  const others = ordered.filter((widget) => widget.type !== 'local-terminal')
  const terminalHeight = terminals.length
    ? Math.max(260, Math.round(area.h * (others.length ? 0.62 : 1)))
    : 0

  terminals.forEach((widget, index) => {
    const h = terminalHeight / Math.max(1, terminals.length)
    result.set(widget.id, rect(area.x, area.y + index * h, area.w, h - (terminals.length > 1 ? gap / 2 : 0)))
  })

  const lowerY = area.y + terminalHeight + (terminals.length && others.length ? gap : 0)
  const lowerHeight = Math.max(220, area.y + area.h - lowerY)
  others.forEach((widget, index) => {
    const h = lowerHeight / Math.max(1, others.length)
    result.set(widget.id, rect(area.x, lowerY + index * h, area.w, h - (others.length > 1 ? gap / 2 : 0)))
  })

  return result
}

function createWidgetGroups(widgets: WorkbenchWidget[]): WidgetGroup[] {
  const groups = new Map<string, WidgetGroup>()

  widgets.forEach((widget) => {
    const groupId = widget.serverId ? `server:${widget.serverId}` : 'local'
    const existing = groups.get(groupId)
    if (existing) {
      existing.widgets.push(widget)
      return
    }
    groups.set(groupId, {
      id: groupId,
      serverId: widget.serverId,
      widgets: [widget],
    })
  })

  return Array.from(groups.values())
}

function getWorkbenchGroupColumns(groupCount: number, width: number) {
  if (groupCount <= 1) return 1
  if (width < 1100) return 1
  if (groupCount <= 4) return 2
  return width >= 1680 ? 3 : 2
}

function layoutWidgetsInsideGroup(widgets: WorkbenchWidget[], cell: WidgetRect) {
  const gap = 10
  const result = new Map<string, WidgetRect>()
  const ordered = orderWidgetsForGroup(widgets)
  const terminals = ordered.filter((widget) => widget.type === 'local-terminal' || widget.type === 'ssh-terminal')
  const monitors = ordered.filter((widget) => widget.type === 'monitor')
  const files = ordered.filter((widget) => widget.type === 'files')
  const sideWidgets = [...monitors, ...files]
  const others = ordered.filter((widget) => !terminals.includes(widget) && !sideWidgets.includes(widget))

  const rect = (x: number, y: number, w: number, h: number): WidgetRect => ({
    x: Math.round(x),
    y: Math.round(y),
    w: Math.max(240, Math.round(w)),
    h: Math.max(170, Math.round(h)),
  })

  if (ordered.length === 1) {
    result.set(ordered[0].id, rect(cell.x, cell.y, cell.w, cell.h))
    return result
  }

  if (cell.w < 960) {
    const terminalHeight = terminals.length ? Math.max(260, Math.round(cell.h * 0.50)) : 0
    terminals.forEach((widget, index) => {
      const h = terminalHeight / Math.max(1, terminals.length)
      result.set(widget.id, rect(cell.x, cell.y + index * h, cell.w, h - gap / 2))
    })
    const lowerY = cell.y + terminalHeight + (terminals.length ? gap : 0)
    const lowerHeight = cell.h - terminalHeight - (terminals.length ? gap : 0)
    layoutSideWidgets({ monitors, files, others }, { x: cell.x, y: lowerY, w: cell.w, h: lowerHeight }, result, rect)
    return result
  }

  const hasSide = sideWidgets.length > 0 || others.length > 0
  const sideWidth = hasSide ? Math.max(430, Math.min(660, Math.round(cell.w * 0.42))) : 0
  const terminalWidth = hasSide ? cell.w - sideWidth - gap : cell.w
  const terminalWidgets = terminals.length ? terminals : ordered.slice(0, 1)

  terminalWidgets.forEach((widget, index) => {
    const h = cell.h / Math.max(1, terminalWidgets.length)
    result.set(widget.id, rect(cell.x, cell.y + index * h, terminalWidth, h - (terminalWidgets.length > 1 ? gap / 2 : 0)))
  })

  layoutSideWidgets(
    { monitors, files, others: ordered.filter((widget) => !result.has(widget.id) && !monitors.includes(widget) && !files.includes(widget)) },
    { x: cell.x + terminalWidth + gap, y: cell.y, w: sideWidth, h: cell.h },
    result,
    rect,
  )

  return result
}

function layoutSideWidgets(
  groups: { monitors: WorkbenchWidget[]; files: WorkbenchWidget[]; others: WorkbenchWidget[] },
  area: WidgetRect,
  result: Map<string, WidgetRect>,
  rect: (x: number, y: number, w: number, h: number) => WidgetRect,
) {
  const gap = 10
  const monitorHeight = groups.monitors.length && groups.files.length
    ? Math.max(220, Math.min(280, Math.round(area.h * 0.34)))
    : groups.monitors.length
      ? area.h
      : 0
  let y = area.y

  groups.monitors.forEach((widget, index) => {
    const h = monitorHeight / Math.max(1, groups.monitors.length)
    result.set(widget.id, rect(area.x, y + index * h, area.w, h - (groups.monitors.length > 1 ? gap / 2 : 0)))
  })

  if (groups.monitors.length) y += monitorHeight + (groups.files.length || groups.others.length ? gap : 0)

  const remaining = [...groups.files, ...groups.others]
  const remainingHeight = Math.max(260, area.y + area.h - y)
  remaining.forEach((widget, index) => {
    const h = remainingHeight / Math.max(1, remaining.length)
    result.set(widget.id, rect(area.x, y + index * h, area.w, h - (remaining.length > 1 ? gap / 2 : 0)))
  })
}

function orderWidgetsForGroup(widgets: WorkbenchWidget[]) {
  const weight: Record<WorkbenchWidgetType, number> = {
    'ssh-terminal': 0,
    'local-terminal': 0,
    'remote-desktop': 0,
    monitor: 1,
    processes: 1,
    files: 2,
  }
  return [...widgets].sort((a, b) => weight[a.type] - weight[b.type])
}

function getWorkbenchGroupFrames(widgets: WorkbenchWidget[], servers: ServerProfile[]) {
  const groups = createWidgetGroups(widgets)
  return groups
    .filter((group) => group.widgets.length > 1)
    .map((group) => {
      const left = Math.min(...group.widgets.map((widget) => widget.x))
      const top = Math.min(...group.widgets.map((widget) => widget.y))
      const right = Math.max(...group.widgets.map((widget) => widget.x + widget.w))
      const bottom = Math.max(...group.widgets.map((widget) => widget.y + widget.h))
      const server = group.serverId ? servers.find((item) => item.id === group.serverId) : null
      return {
        id: group.id,
        title: server?.name ?? '本地工作组',
        count: group.widgets.length,
        x: Math.max(6, left - 10),
        y: Math.max(6, top - 10),
        w: right - left + 20,
        h: bottom - top + 20,
      }
    })
}

function createWorkbenchLayoutSlots(
  count: number,
  preset: WorkbenchLayoutPreset,
  viewport: WorkbenchViewport,
): WidgetRect[] {
  if (count <= 0) return []

  const padding = 10
  const x = padding
  const y = padding
  const width = Math.max(320, viewport.width - padding * 2)
  const height = Math.max(240, viewport.height - padding * 2)
  const rect = (left: number, top: number, w: number, h: number): WidgetRect => ({
    x: Math.round(x + left),
    y: Math.round(y + top),
    w: Math.max(240, Math.round(w)),
    h: Math.max(170, Math.round(h)),
  })

  if (count === 1) return [rect(0, 0, width, height)]

  if (preset === 'columns') {
    const columnWidth = width / count
    return Array.from({ length: count }, (_, index) => rect(index * columnWidth, 0, columnWidth, height))
  }

  if (preset === 'rows') {
    const rowHeight = height / count
    return Array.from({ length: count }, (_, index) => rect(0, index * rowHeight, width, rowHeight))
  }

  if (preset === 'focus-left' || preset === 'focus-right') {
    const mainWidth = width * 0.62
    const sideWidth = width - mainWidth
    const sideCount = count - 1
    const sideRowHeight = height / sideCount
    if (preset === 'focus-left') {
      return [
        rect(0, 0, mainWidth, height),
        ...Array.from({ length: sideCount }, (_, index) => rect(mainWidth, index * sideRowHeight, sideWidth, sideRowHeight)),
      ]
    }
    return [
      rect(sideWidth, 0, mainWidth, height),
      ...Array.from({ length: sideCount }, (_, index) => rect(0, index * sideRowHeight, sideWidth, sideRowHeight)),
    ]
  }

  if (preset === 'wave') {
    if (count === 2) {
      const leftWidth = width * 0.48
      return [rect(0, 0, leftWidth, height), rect(leftWidth, 0, width - leftWidth, height)]
    }
    if (count === 3) {
      const leftWidth = width * 0.52
      return [
        rect(0, 0, leftWidth, height),
        rect(leftWidth, 0, width - leftWidth, height / 2),
        rect(leftWidth, height / 2, width - leftWidth, height / 2),
      ]
    }
    if (count === 4) {
      const leftWidth = width * 0.34
      const middleWidth = width * 0.32
      const rightWidth = width - leftWidth - middleWidth
      return [
        rect(0, 0, leftWidth, height),
        rect(leftWidth, 0, middleWidth, height / 2),
        rect(leftWidth, height / 2, middleWidth, height / 2),
        rect(leftWidth + middleWidth, 0, rightWidth, height),
      ]
    }
  }

  const columns = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / columns)
  const columnWidth = width / columns
  const rowHeight = height / rows
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return rect(column * columnWidth, row * rowHeight, columnWidth, rowHeight)
  })
}

function resizeWidgetRect(widget: WorkbenchWidget, direction: ResizeDirection, dx: number, dy: number) {
  const minW = 260
  const minH = 180
  let { x, y, w, h } = widget
  if (direction.includes('e')) w += dx
  if (direction.includes('s')) h += dy
  if (direction.includes('w')) {
    x += dx
    w -= dx
  }
  if (direction.includes('n')) {
    y += dy
    h -= dy
  }
  if (w < minW) {
    if (direction.includes('w')) x -= minW - w
    w = minW
  }
  if (h < minH) {
    if (direction.includes('n')) y -= minH - h
    h = minH
  }
  return { ...widget, x: Math.max(0, x), y: Math.max(0, y), w, h, maximized: false, restore: undefined }
}

function createDragProxy(
  element: HTMLElement | null,
  widget: WorkbenchWidget,
  zIndex: number,
) {
  const host = element?.parentElement
  if (!host) return null

  const proxy = document.createElement('div')
  proxy.className = 'widget-drag-proxy'
  proxy.style.left = `${widget.x}px`
  proxy.style.top = `${widget.y}px`
  proxy.style.width = `${widget.w}px`
  proxy.style.height = `${widget.h}px`
  proxy.style.zIndex = `${zIndex + 80}`

  const title = document.createElement('div')
  title.className = 'widget-drag-proxy-title'
  title.textContent = widget.title
  proxy.appendChild(title)

  host.appendChild(proxy)
  return proxy
}

function clearLayoutDragClasses() {
  document
    .querySelectorAll('.remote-session-panel.layout-armed, .remote-session-panel.layout-dragging, .remote-session-panel.layout-drop-target')
    .forEach((element) => element.classList.remove('layout-armed', 'layout-dragging', 'layout-drop-target'))
  document
    .querySelectorAll('.snap-layout-popover button.drag-active')
    .forEach((element) => element.classList.remove('drag-active'))
  document
    .querySelectorAll('.snap-layout-popover .layout-preview-slot.slot-active')
    .forEach((element) => element.classList.remove('slot-active'))
}

function markLayoutDropTarget(targetId?: string) {
  document
    .querySelectorAll('.remote-session-panel.layout-drop-target')
    .forEach((element) => element.classList.remove('layout-drop-target'))
  if (!targetId) return
  document
    .querySelector<HTMLElement>(`.remote-session-panel[data-workbench-widget-id="${CSS.escape(targetId)}"]`)
    ?.classList.add('layout-drop-target')
}

function markActiveLayoutPreset(preset: WorkbenchLayoutPreset | null, slotIndex = -1) {
  document
    .querySelectorAll('.snap-layout-popover button.drag-active')
    .forEach((element) => element.classList.remove('drag-active'))
  document
    .querySelectorAll('.snap-layout-popover .layout-preview-slot.slot-active')
    .forEach((element) => element.classList.remove('slot-active'))
  if (!preset) return
  const button = document
    .querySelector<HTMLElement>(`.snap-layout-popover button[data-layout-preset="${CSS.escape(preset)}"]`)
  button?.classList.add('drag-active')
  if (slotIndex < 0) return
  button
    ?.querySelector<HTMLElement>(`.layout-preview-slot[data-layout-slot="${slotIndex}"]`)
    ?.classList.add('slot-active')
}

type HoveredLayoutDrop = {
  preset: WorkbenchLayoutPreset
  slotIndex: number
}

function getHoveredLayoutDrop(clientX: number, clientY: number): HoveredLayoutDrop | null {
  const element = document.elementFromPoint(clientX, clientY)
  const slot = element?.closest<HTMLElement>('.snap-layout-popover .layout-preview-slot[data-layout-preset][data-layout-slot]')
  if (slot) {
    const preset = slot.dataset.layoutPreset
    const slotIndex = Number.parseInt(slot.dataset.layoutSlot ?? '0', 10)
    if (layoutPresets.some((item) => item.id === preset)) {
      return {
        preset: preset as WorkbenchLayoutPreset,
        slotIndex: Number.isFinite(slotIndex) ? slotIndex : 0,
      }
    }
  }

  const button = element?.closest<HTMLElement>('.snap-layout-popover button[data-layout-preset]')
  const preset = button?.dataset.layoutPreset
  if (layoutPresets.some((item) => item.id === preset)) {
    return {
      preset: preset as WorkbenchLayoutPreset,
      slotIndex: 0,
    }
  }
  return null
}

function shouldShowDragLayoutHint(deck: HTMLElement | null, clientX: number, clientY: number, dy: number) {
  return isInsideTopCenterSnapZone(deck, clientX, clientY, dy, 96, -10)
}

function shouldOpenDragLayoutChooser(deck: HTMLElement | null, clientX: number, clientY: number, dy: number) {
  return isInsideTopCenterSnapZone(deck, clientX, clientY, dy, 46, -34)
}

function isInsideTopCenterSnapZone(
  deck: HTMLElement | null,
  clientX: number,
  clientY: number,
  dy: number,
  lowerEdgeOffset: number,
  upwardThreshold: number,
) {
  if (!deck) return false
  const rect = deck.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const halfWidth = Math.max(180, Math.min(420, rect.width * 0.28))
  const horizontallyCentered = clientX >= centerX - halfWidth && clientX <= centerX + halfWidth
  const nearTop = clientY >= rect.top - 82 && clientY <= rect.top + lowerEdgeOffset
  return horizontallyCentered && nearTop && dy < upwardThreshold
}

function getLayoutDropTargetId(deck: HTMLElement | null, sourceId: string, clientX: number, clientY: number) {
  if (!deck) return null
  const deckRect = deck.getBoundingClientRect()
  const insideDeck = (
    clientX >= deckRect.left &&
    clientX <= deckRect.right &&
    clientY >= deckRect.top &&
    clientY <= deckRect.bottom
  )
  if (!insideDeck) return null

  const panels = Array.from(deck.querySelectorAll<HTMLElement>('[data-workbench-widget-id]'))
  const candidates = panels
    .map((panel, index) => {
      const id = panel.dataset.workbenchWidgetId
      if (!id || id === sourceId) return null
      const rect = panel.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const distance = Math.hypot(clientX - centerX, clientY - centerY)
      const crossed = clientY > centerY || (Math.abs(clientY - centerY) < rect.height / 2 && clientX > centerX)
      return { id, index, distance, crossed }
    })
    .filter((item): item is { id: string; index: number; distance: number; crossed: boolean } => Boolean(item))

  if (candidates.length === 0) return null
  const nearest = candidates.reduce((best, item) => (item.distance < best.distance ? item : best), candidates[0])

  const visiblePanels = panels.filter((panel) => panel.dataset.workbenchWidgetId !== sourceId)
  const lastPanel = visiblePanels.at(-1)
  if (lastPanel) {
    const lastRect = lastPanel.getBoundingClientRect()
    if (clientY > lastRect.bottom || (clientY > lastRect.top && clientX > lastRect.right)) {
      return lastPanel.dataset.workbenchWidgetId ?? nearest.id
    }
  }

  return nearest.crossed ? nearest.id : nearest.id
}

function createLayoutDragProxy(element: HTMLElement | null, titleText: string) {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  const proxy = document.createElement('div')
  proxy.className = 'remote-session-drag-proxy'
  proxy.style.left = `${rect.left}px`
  proxy.style.top = `${rect.top}px`
  proxy.style.width = `${rect.width}px`
  proxy.style.height = `${rect.height}px`

  const title = document.createElement('div')
  title.className = 'remote-session-drag-proxy-title'
  title.textContent = titleText
  proxy.appendChild(title)
  document.body.appendChild(proxy)
  return proxy
}

function fileIconClass(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension)) return 'image-icon'
  if (['js', 'ts', 'tsx', 'jsx', 'rs', 'py', 'json', 'html', 'css', 'vue'].includes(extension)) return 'code-icon'
  if (['md', 'txt', 'log', 'csv', 'ini', 'yml', 'yaml'].includes(extension)) return 'text-icon'
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(extension)) return 'archive-icon'
  return ''
}

function fileIconLabel(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension)) return 'I'
  if (['js', 'ts', 'tsx', 'jsx', 'rs', 'py', 'json', 'html', 'css', 'vue'].includes(extension)) return 'C'
  if (['md', 'txt', 'log', 'csv', 'ini', 'yml', 'yaml'].includes(extension)) return 'T'
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(extension)) return 'Z'
  return 'F'
}

function isArchiveFile(name: string) {
  const normalized = name.toLowerCase()
  return ['.zip', '.tar', '.tar.gz', '.tgz', '.gz'].some((extension) => normalized.endsWith(extension))
}

function getMonitorCards(stats: LocalSystemStats | null) {
  const memoryPercent = percent(stats?.memory_used ?? 0, stats?.memory_total ?? 0)
  const diskPercent = percent(stats?.disk_used ?? 0, stats?.disk_total ?? 0)
  const networkTotal = (stats?.network_received ?? 0) + (stats?.network_transmitted ?? 0)
  return [
    {
      key: 'cpu' as const,
      label: 'CPU',
      icon: <Activity size={14} />,
      value: `${Math.round(stats?.cpu_usage ?? 0)}%`,
      detail: `${stats?.process_count ?? 0} 进程`,
    },
    {
      key: 'memory' as const,
      label: '内存',
      icon: <Database size={14} />,
      value: `${memoryPercent.toFixed(0)}%`,
      detail: `${formatBytes(stats?.memory_used ?? 0)} / ${formatBytes(stats?.memory_total ?? 0)}`,
    },
    {
      key: 'disk' as const,
      label: '硬盘',
      icon: <HardDrive size={14} />,
      value: `${diskPercent.toFixed(0)}%`,
      detail: `${formatBytes(stats?.disk_used ?? 0)} / ${formatBytes(stats?.disk_total ?? 0)}`,
    },
    {
      key: 'network' as const,
      label: '网络',
      icon: <Wifi size={14} />,
      value: formatBytes(networkTotal),
      detail: `↓ ${formatBytes(stats?.network_received ?? 0)}  ↑ ${formatBytes(stats?.network_transmitted ?? 0)}`,
    },
  ]
}

function smoothPath(pts: { x: number; y: number }[]) {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return d
}

function avgOf(arr: number[]) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
}

function peakOf(arr: number[]) {
  return arr.length ? Math.max(...arr) : 0
}

function formatRateMB(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 MB/s'
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB/s`
  if (value >= 1) return `${value.toFixed(1)} MB/s`
  if (value >= 1 / 1024) return `${(value * 1024).toFixed(0)} KB/s`
  return `${(value * 1024 * 1024).toFixed(0)} B/s`
}

function MiniSpark({ values, lineColor, areaColor }: { values: number[]; lineColor: string; areaColor: string }) {
  const safe = values.length > 1 ? values : [0, values[0] ?? 0]
  const W = 150
  const H = 30
  const pts = safe.map((v, i) => ({
    x: (i / Math.max(1, safe.length - 1)) * W,
    y: H - (Math.max(0, Math.min(100, v)) / 100) * H,
  }))
  const line = smoothPath(pts)
  const area = pts.length > 1 ? `${line} L ${W.toFixed(1)},${H} L 0,${H} Z` : ''
  return (
    <svg className="mini-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {pts.length > 1 && <polygon points={area} style={{ fill: areaColor }} />}
      <path className="ms-line" d={line} style={{ stroke: lineColor }} fill="none" />
      <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={2} className="ms-dot" style={{ fill: lineColor }} />
    </svg>
  )
}

function MiniDualSpark({ up, down, labels }: { up: number[]; down: number[]; labels?: [string, string] }) {
  const maxV = Math.max(1, ...up, ...down)
  const W = 150
  const H = 30
  const make = (arr: number[]) => {
    const safe = arr.length > 1 ? arr : [0, arr[0] ?? 0]
    return safe.map((v, i) => ({
      x: (i / Math.max(1, safe.length - 1)) * W,
      y: H - (Math.max(0, Math.min(1, v / maxV)) * 0.92) * H,
    }))
  }
  const upPts = make(up)
  const downPts = make(down)
  const upLine = smoothPath(upPts)
  const downLine = smoothPath(downPts)
  const upArea = upPts.length > 1 ? `${upLine} L ${W.toFixed(1)},${H} L 0,${H} Z` : ''
  const downArea = downPts.length > 1 ? `${downLine} L ${W.toFixed(1)},${H} L 0,${H} Z` : ''
  return (
    <svg className="mini-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {upPts.length > 1 && <polygon points={upArea} style={{ fill: 'rgba(142,203,255,0.14)' }} />}
      {downPts.length > 1 && <polygon points={downArea} style={{ fill: 'rgba(84,214,180,0.12)' }} />}
      <path className="ms-line" d={upLine} style={{ stroke: '#8ecbff' }} fill="none" />
      <path className="ms-line" d={downLine} style={{ stroke: '#54d6b4' }} fill="none" />
      {labels && (
        <g className="mini-legend">
          <text x={0} y={9}>{labels[0]}</text>
          <text x={W} y={9} textAnchor="end">{labels[1]}</text>
        </g>
      )}
    </svg>
  )
}

function MonitorResourceCard({ title, value, sub, avg, peak, spark }: {
  title: string
  value: string
  sub: string
  avg: number
  peak: number
  spark: number[]
}) {
  return (
    <div className="monitor-res-card">
      <div className="mrc-top">
        <span className="mrc-title">{title}</span>
        <span className="mrc-value">{value}</span>
      </div>
      <div className="mrc-sub">{sub}</div>
      <MiniSpark values={spark} lineColor="var(--accent, #8ecbff)" areaColor="rgba(142,203,255,0.14)" />
      <div className="mrc-stats">
        <span>均值 {avg.toFixed(1)}%</span>
        <span>峰值 {peak.toFixed(1)}%</span>
      </div>
    </div>
  )
}

function percent(used: number, total: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function fileDownloadPercent(progress: FileDownloadProgress) {
  if (progress.completed) return 100
  if (progress.totalBytes <= 0) return progress.copiedFiles > 0 ? 100 : 0
  return Math.min(100, Math.max(0, Math.round(progress.transferredBytes / progress.totalBytes * 100)))
}

function transferPathName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function formatFileModified(value: string, language: ResolvedLanguage, timeZone: string) {
  if (!value || value === '-') return '-'
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return value
  return formatLocalizedDateTime(timestamp * 1000, language, timeZone, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function normalizeRemoteAuxConcurrency(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_REMOTE_AUX_CONCURRENCY
  return Math.min(MAX_REMOTE_AUX_CONCURRENCY, Math.max(MIN_REMOTE_AUX_CONCURRENCY, Math.round(numeric)))
}

function normalizeTerminalFontSize(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_TERMINAL_FONT_SIZE
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(numeric)))
}

function normalizeAppBackgroundTransparency(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_APP_BACKGROUND_TRANSPARENCY
  return Math.min(
    MAX_APP_BACKGROUND_TRANSPARENCY,
    Math.max(MIN_APP_BACKGROUND_TRANSPARENCY, Math.round(numeric)),
  )
}

function applyGlobalThemeTokens(theme: GlobalThemeSettings, interfaceOpacity = 1) {
  const root = document.documentElement.style
  const surface3 = mixColor(theme.surface, theme.text, 0.08)
  const surface4 = mixColor(theme.surface, theme.text, 0.15)
  const translucent = interfaceOpacity < 0.999
  const material = (color: string, offset = 0) => translucent
    ? toAlphaColor(color, Math.min(1, Math.max(0.5, interfaceOpacity + offset)))
    : color
  const terminalOpacity = translucent ? interfaceOpacity : 1
  root.setProperty('--component-material', translucent ? toAlphaColor(theme.surface, Math.max(0.08, interfaceOpacity - 0.58)) : theme.surface)
  root.setProperty('--component-material-soft', translucent ? toAlphaColor(theme.elevatedSurface, Math.max(0.06, interfaceOpacity - 0.66)) : theme.elevatedSurface)
  root.setProperty('--component-terminal-material', translucent ? toAlphaColor(theme.terminalBackground, Math.max(0.04, interfaceOpacity - 0.62)) : theme.terminalBackground)
  root.setProperty('--bg', material(theme.windowBackground, 0.08))
  root.setProperty('--surface-0', material(theme.canvas))
  root.setProperty('--surface-1', material(theme.surface, 0.03))
  root.setProperty('--surface-2', material(theme.elevatedSurface, 0.06))
  root.setProperty('--surface-3', material(surface3, 0.08))
  root.setProperty('--surface-4', material(surface4, 0.1))
  root.setProperty('--glass-chrome', material(theme.surface, 0.08))
  root.setProperty('--glass-panel', material(theme.elevatedSurface, 0.03))
  root.setProperty('--glass-elevated', material(theme.elevatedSurface, 0.08))
  root.setProperty('--glass-popup', translucent ? toAlphaColor(theme.elevatedSurface, Math.max(0.88, interfaceOpacity)) : theme.elevatedSurface)
  root.setProperty('--terminal-surface', translucent ? toAlphaColor(theme.terminalBackground, terminalOpacity) : theme.terminalBackground)
  root.setProperty('--terminal-chrome', material(theme.surface, 0.08))
  root.setProperty('--terminal-hover', material(mixColor(theme.terminalBackground, theme.text, 0.06), 0.08))
  root.setProperty('--terminal-scroll-track', material(mixColor(theme.terminalBackground, theme.text, 0.04), 0.08))
  root.setProperty('--terminal-bg', translucent ? toAlphaColor(theme.terminalBackground, terminalOpacity) : theme.terminalBackground)
  root.setProperty('--terminal-fg', theme.terminalForeground)
  root.setProperty('--text-primary', theme.text)
  root.setProperty('--text-secondary', mixColor(theme.text, theme.mutedText, 0.36))
  root.setProperty('--text-tertiary', theme.mutedText)
  root.setProperty('--text-disabled', mixColor(theme.mutedText, theme.windowBackground, 0.4))
  root.setProperty('--accent', theme.accent)
  root.setProperty('--accent-hover', mixColor(theme.accent, theme.text, 0.28))
  root.setProperty('--accent-dim', toAlphaColor(theme.accent, 0.13))
  root.setProperty('--accent-border', toAlphaColor(theme.accent, 0.42))
  root.setProperty('--accent-glow', `0 0 0 3px ${toAlphaColor(theme.accent, 0.16)}`)
  root.setProperty('--accent-grad', theme.accent)
  root.setProperty('--surface-tint', mixColor(theme.canvas, theme.accent, 0.06))
  root.setProperty('--surface-highlight', mixColor(theme.elevatedSurface, theme.text, 0.04))
}

function applyThemeEffectTokens(effects: AppThemePreset['effects']) {
  const root = document.documentElement.style
  root.setProperty('--theme-glow-primary', effects.glowPrimary)
  root.setProperty('--theme-glow-secondary', effects.glowSecondary)
  root.setProperty('--theme-glow-strength', `${Math.round(effects.glowStrength * 100)}%`)
  root.setProperty('--theme-glow-soft-strength', `${Math.round(effects.glowStrength * 52)}%`)
}

function toAlphaColor(hex: string, alpha: number) {
  const rgb = parseHexColor(hex)
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : hex
}

function mixColor(from: string, to: string, amount: number) {
  const start = parseHexColor(from)
  const end = parseHexColor(to)
  if (!start || !end) return from
  const ratio = Math.max(0, Math.min(1, amount))
  const channel = (startValue: number, endValue: number) => Math.round(startValue + (endValue - startValue) * ratio)
  return `#${[channel(start.r, end.r), channel(start.g, end.g), channel(start.b, end.b)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

function parseHexColor(value: string) {
  const normalized = value.trim().replace('#', '')
  if (!/^[\da-fA-F]{6}$/.test(normalized)) return null
  const numeric = Number.parseInt(normalized, 16)
  return {
    r: (numeric >> 16) & 0xff,
    g: (numeric >> 8) & 0xff,
    b: numeric & 0xff,
  }
}

function formatServerAddress(server: ServerProfile) {
  return server.host ? `${server.user}@${server.host}` : '未选择服务器'
}

function normalizeServerProfile(value: unknown): ServerProfile | null {
  if (!value || typeof value !== 'object') return null

  const source = value as Partial<ServerProfile>
  const protocol = source.protocol === 'telnet' || source.protocol === 'serial' ? source.protocol : 'ssh'
  const host = typeof source.host === 'string' ? source.host.trim() : ''
  const user = typeof source.user === 'string' ? source.user.trim() : 'root'
  const port = Number(source.port) || (protocol === 'telnet' ? 23 : 22)

  if (protocol === 'serial') {
    const serialPort = typeof source.serialPort === 'string' ? source.serialPort.trim() : ''
    if (!serialPort) return null
  } else if (!host || !user || port < 1 || port > 65535) {
    return null
  }

  const name = typeof source.name === 'string' ? source.name.trim() : ''
  const group = typeof source.group === 'string' ? source.group.trim() : ''
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : crypto.randomUUID()
  const password = typeof source.password === 'string' ? source.password : ''
  const auth = source.auth === 'Key' || source.auth === 'Agent' ? source.auth : 'Password'
  const privateKeyPath = typeof source.privateKeyPath === 'string' ? source.privateKeyPath.trim() : ''
  const baudRate = Number(source.baudRate) || 9600
  const dataBits = Number(source.dataBits) || 8
  const stopBits = Number(source.stopBits) || 1
  const parity = typeof source.parity === 'string' ? source.parity : 'none'
  const flowControl = typeof source.flowControl === 'string' ? source.flowControl : 'none'
  const logEnabled = Boolean(source.logEnabled)
  const logPath = typeof source.logPath === 'string' ? source.logPath.trim() : ''

  return {
    id,
    name: name || host || '未命名设备',
    host,
    user,
    port,
    group: group || 'Production',
    auth,
    password,
    privateKeyPath,
    protocol,
    serialPort: typeof source.serialPort === 'string' ? source.serialPort.trim() : '',
    baudRate,
    dataBits,
    stopBits,
    parity,
    flowControl,
    logEnabled,
    logPath,
  }
}

function isLegacyDemoServer(server: ServerProfile) {
  return server.id === 'real-vps' && server.host === '103.146.230.242'
}

function normalizeSnippet(value: unknown): Snippet | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<Snippet>
  const name = typeof source.name === 'string' ? source.name.trim() : ''
  const command = typeof source.command === 'string' ? source.command.trim() : ''
  if (!name || !command) return null
  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id.trim() : crypto.randomUUID(),
    name,
    command,
    category: typeof source.category === 'string' && source.category.trim() ? source.category.trim() : '未分类',
  }
}

function normalizeSessionNote(value: unknown): SessionNote | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<SessionNote>
  const text = typeof source.text === 'string' ? source.text.trim() : ''
  if (!text) return null
  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id.trim() : crypto.randomUUID(),
    text,
    done: Boolean(source.done),
  }
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

function SortGlyph({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) return <span className="sort-glyph-placeholder" aria-hidden="true" />
  return direction === 'asc'
    ? <ArrowUp className="sort-glyph" size={11} aria-hidden="true" />
    : <ArrowDown className="sort-glyph" size={11} aria-hidden="true" />
}

function normalizeRemoteDesktopConnection(source: unknown): RemoteDesktopConnection | undefined {
  if (!source || typeof source !== 'object') return undefined
  const record = source as Partial<RemoteDesktopConnection>
  const protocol = record.protocol === 'vnc' ? 'vnc' : 'rdp'
  const host = typeof record.host === 'string' ? record.host.trim() : ''
  const port = Number(record.port) || (protocol === 'rdp' ? 3389 : 5900)
  if (!host || port < 1 || port > 65535) return undefined
  return {
    protocol,
    host,
    port,
    username: typeof record.username === 'string' ? record.username : '',
    password: typeof record.password === 'string' ? record.password : '',
    domain: typeof record.domain === 'string' ? record.domain : '',
    security: record.security === 'nla' || record.security === 'tls' ? record.security : 'any',
    ignoreCertificate: Boolean(record.ignoreCertificate),
    viewOnly: Boolean(record.viewOnly),
  }
}

function normalizeRemoteDesktopProfile(source: unknown): RemoteDesktopProfile | null {
  const connection = normalizeRemoteDesktopConnection(source)
  if (!connection || !source || typeof source !== 'object') return null
  const record = source as Partial<RemoteDesktopProfile>
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : crypto.randomUUID()
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const group = typeof record.group === 'string' ? record.group.trim() : ''
  return {
    ...connection,
    id,
    name: name || connection.host,
    group: group || 'Production',
  }
}

function normalizeWorkbenchWidget(source: unknown, index: number): WorkbenchWidget | null {
  if (!source || typeof source !== 'object') return null
  const record = source as Record<string, unknown>
  const type = record.type
  if (type !== 'local-terminal' && type !== 'ssh-terminal' && type !== 'files' && type !== 'monitor' && type !== 'processes' && type !== 'remote-desktop') {
    return null
  }
  const id = typeof record.id === 'string' && record.id ? record.id : `widget-${crypto.randomUUID()}`
  const fallbackTitle = type === 'local-terminal'
    ? `本地终端 ${index + 1}`
    : type === 'ssh-terminal'
      ? `SSH 终端 ${index + 1}`
      : type === 'files'
        ? `文件管理 ${index + 1}`
        : type === 'monitor'
          ? `机器监控 ${index + 1}`
          : type === 'processes'
            ? `系统进程 ${index + 1}`
            : `远程桌面 ${index + 1}`
  return {
    id,
    type,
    title: typeof record.title === 'string' && record.title ? record.title : fallbackTitle,
    x: Number.isFinite(Number(record.x)) ? Number(record.x) : 18,
    y: Number.isFinite(Number(record.y)) ? Number(record.y) : 58,
    w: Number.isFinite(Number(record.w)) ? Number(record.w) : 560,
    h: Number.isFinite(Number(record.h)) ? Number(record.h) : 420,
    serverId: typeof record.serverId === 'string' ? record.serverId : undefined,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    remoteDesktop: normalizeRemoteDesktopConnection(record.remoteDesktop),
  }
}

function normalizeWorkbenchWorkspace(source: unknown, index: number): WorkbenchWorkspace | null {
  if (!source || typeof source !== 'object') return null
  const record = source as Record<string, unknown>
  const widgets = Array.isArray(record.widgets)
    ? record.widgets
        .map((widget, widgetIndex) => normalizeWorkbenchWidget(widget, widgetIndex))
        .filter((widget): widget is WorkbenchWidget => Boolean(widget))
    : []
  const widgetIds = widgets.map((widget) => widget.id)
  const focusedWidgetId = typeof record.focusedWidgetId === 'string' && widgetIds.includes(record.focusedWidgetId)
    ? record.focusedWidgetId
    : widgetIds[0] ?? ''
  const magnifiedWidgetId = typeof record.magnifiedWidgetId === 'string' && widgetIds.includes(record.magnifiedWidgetId)
    ? record.magnifiedWidgetId
    : undefined
  return {
    id: typeof record.id === 'string' && record.id ? record.id : `workspace-${crypto.randomUUID()}`,
    name: typeof record.name === 'string' && record.name ? record.name : `W${index + 1} 工作台`,
    widgets,
    focusedWidgetId,
    magnifiedWidgetId,
    layout: parseLayoutNode(record.layout, widgetIds),
    layoutPreset: undefined,
  }
}

function serializeWorkspacesWithoutCredentials(workspaces: WorkbenchWorkspace[]) {
  return JSON.stringify(workspaces.map((workspace) => ({
    ...workspace,
    widgets: workspace.widgets.map((widget) => {
      if (!widget.remoteDesktop) return widget
      const { password: _password, ...remoteDesktop } = widget.remoteDesktop
      return { ...widget, remoteDesktop }
    }),
  })))
}

function getWorkspaceCredentialRecords(workspaces: WorkbenchWorkspace[]): CredentialSecretRecord[] {
  return workspaces.flatMap((workspace) => workspace.widgets.flatMap((widget) => {
    if (!widget.remoteDesktop) return []
    const userName = widget.remoteDesktop.domain
      ? `${widget.remoteDesktop.domain}\\${widget.remoteDesktop.username}`
      : widget.remoteDesktop.username
    return [{ id: widget.id, userName, secret: widget.remoteDesktop.password }]
  }))
}

function hydrateWorkspaceCredentials(
  workspaces: WorkbenchWorkspace[],
  secrets: ReadonlyMap<string, string>,
) {
  return workspaces.map((workspace) => ({
    ...workspace,
    widgets: workspace.widgets.map((widget) => widget.remoteDesktop
      ? {
          ...widget,
          remoteDesktop: {
            ...widget.remoteDesktop,
            password: secrets.get(widget.id) || widget.remoteDesktop.password,
          },
        }
      : widget),
  }))
}

function usePersistentWorkspaces() {
  const initialWorkspacesRef = useRef<WorkbenchWorkspace[] | null>(null)
  if (initialWorkspacesRef.current === null) {
    try {
      const raw = localStorage.getItem('xundu.workspaces.v2') ?? localStorage.getItem('xundu.workspaces')
      if (!raw) initialWorkspacesRef.current = defaultWorkspaces
      else {
        const parsed = JSON.parse(raw) as unknown
        const normalized = Array.isArray(parsed)
          ? parsed
              .map((workspace, index) => normalizeWorkbenchWorkspace(workspace, index))
              .filter((workspace): workspace is WorkbenchWorkspace => Boolean(workspace))
          : []
        initialWorkspacesRef.current = normalized.length > 0 ? normalized : defaultWorkspaces
      }
    } catch {
      initialWorkspacesRef.current = defaultWorkspaces
    }
  }

  const [workspaces, setWorkspaces] = useState<WorkbenchWorkspace[]>(initialWorkspacesRef.current)
  const [credentialState, setCredentialState] = useState<CredentialPersistenceState>({ ready: false })
  const previousCredentialIdsRef = useRef(new Set(
    getWorkspaceCredentialRecords(initialWorkspacesRef.current).map((record) => record.id),
  ))
  const syncRevisionRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const initialWorkspaces = initialWorkspacesRef.current ?? defaultWorkspaces
    const records = getWorkspaceCredentialRecords(initialWorkspaces)
    void migrateAndHydrateCredentials('rdp-widget', records)
      .then((secrets) => {
        if (cancelled) return
        const hydrated = hydrateWorkspaceCredentials(initialWorkspaces, secrets)
        localStorage.setItem('xundu.workspaces.v2', serializeWorkspacesWithoutCredentials(hydrated))
        localStorage.removeItem('xundu.workspaces')
        previousCredentialIdsRef.current = new Set(records.map((record) => record.id))
        setWorkspaces(hydrated)
        setCredentialState({ ready: true })
      })
      .catch((error) => {
        if (!cancelled) setCredentialState({ ready: false, error: String(error) })
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!credentialState.ready) return
    const revision = syncRevisionRef.current + 1
    syncRevisionRef.current = revision
    const records = getWorkspaceCredentialRecords(workspaces)
    const currentIds = new Set(records.map((record) => record.id))
    void syncCredentials('rdp-widget', records, previousCredentialIdsRef.current)
      .then(() => {
        if (syncRevisionRef.current !== revision) return
        localStorage.setItem('xundu.workspaces.v2', serializeWorkspacesWithoutCredentials(workspaces))
        previousCredentialIdsRef.current = currentIds
        setCredentialState({ ready: true })
      })
      .catch((error) => {
        if (syncRevisionRef.current === revision) {
          setCredentialState({ ready: true, error: String(error) })
        }
      })
  }, [credentialState.ready, workspaces])

  return [workspaces, setWorkspaces, credentialState] as const
}

function usePersistentServers() {
  const initialServersRef = useRef<ServerProfile[] | null>(null)
  if (initialServersRef.current === null) {
    try {
      const raw = localStorage.getItem('xundu.servers')
      if (!raw) initialServersRef.current = defaultServers
      else {
        const parsed = JSON.parse(raw) as unknown
        initialServersRef.current = Array.isArray(parsed)
          ? parsed
              .map((server) => normalizeServerProfile(server))
              .filter((server): server is ServerProfile => Boolean(server))
              .filter((server) => !isLegacyDemoServer(server))
          : defaultServers
      }
    } catch {
      initialServersRef.current = defaultServers
    }
  }

  const [servers, setServers] = useState<ServerProfile[]>(initialServersRef.current)
  const [credentialState, setCredentialState] = useState<CredentialPersistenceState>({ ready: false })
  const previousCredentialIdsRef = useRef(new Set(initialServersRef.current.map((server) => server.id)))
  const syncRevisionRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const initialServers = initialServersRef.current ?? defaultServers
    const records = initialServers.map((server) => ({
      id: server.id,
      userName: server.user,
      secret: server.password,
    }))
    void migrateAndHydrateCredentials('ssh', records)
      .then((secrets) => {
        if (cancelled) return
        const hydrated = initialServers.map((server) => ({
          ...server,
          password: secrets.get(server.id) || server.password || '',
        }))
        localStorage.setItem('xundu.servers', JSON.stringify(
          hydrated.map(({ password: _password, ...server }) => server),
        ))
        previousCredentialIdsRef.current = new Set(hydrated.map((server) => server.id))
        setServers(hydrated)
        setCredentialState({ ready: true })
      })
      .catch((error) => {
        if (!cancelled) setCredentialState({ ready: false, error: String(error) })
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!credentialState.ready) return
    const revision = syncRevisionRef.current + 1
    syncRevisionRef.current = revision
    const currentIds = new Set(servers.map((server) => server.id))
    const records = servers.map((server) => ({
      id: server.id,
      userName: server.user,
      secret: server.password,
    }))
    void syncCredentials('ssh', records, previousCredentialIdsRef.current)
      .then(() => {
        if (syncRevisionRef.current !== revision) return
        localStorage.setItem('xundu.servers', JSON.stringify(
          servers.map(({ password: _password, ...server }) => server),
        ))
        previousCredentialIdsRef.current = currentIds
        setCredentialState({ ready: true })
      })
      .catch((error) => {
        if (syncRevisionRef.current === revision) {
          setCredentialState({ ready: true, error: String(error) })
        }
      })
  }, [credentialState.ready, servers])

  return [servers, setServers, credentialState] as const
}

function usePersistentRemoteDesktopProfiles() {
  const initialProfilesRef = useRef<RemoteDesktopProfile[] | null>(null)
  if (initialProfilesRef.current === null) {
    try {
      const raw = localStorage.getItem('xundu.remoteDesktopProfiles')
      if (!raw) initialProfilesRef.current = []
      else {
        const parsed = JSON.parse(raw) as unknown
        initialProfilesRef.current = Array.isArray(parsed)
          ? parsed
              .map((profile) => normalizeRemoteDesktopProfile(profile))
              .filter((profile): profile is RemoteDesktopProfile => Boolean(profile))
          : []
      }
    } catch {
      initialProfilesRef.current = []
    }
  }

  const [profiles, setProfiles] = useState<RemoteDesktopProfile[]>(initialProfilesRef.current)
  const [credentialState, setCredentialState] = useState<CredentialPersistenceState>({ ready: false })
  const previousCredentialIdsRef = useRef(new Set(initialProfilesRef.current.map((profile) => profile.id)))
  const syncRevisionRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const initialProfiles = initialProfilesRef.current ?? []
    const records = initialProfiles.map((profile) => ({
      id: profile.id,
      userName: profile.domain ? `${profile.domain}\\${profile.username}` : profile.username,
      secret: profile.password,
    }))
    void migrateAndHydrateCredentials('rdp-profile', records)
      .then((secrets) => {
        if (cancelled) return
        const hydrated = initialProfiles.map((profile) => ({
          ...profile,
          password: secrets.get(profile.id) || profile.password || '',
        }))
        localStorage.setItem('xundu.remoteDesktopProfiles', JSON.stringify(
          hydrated.map(({ password: _password, ...profile }) => profile),
        ))
        previousCredentialIdsRef.current = new Set(hydrated.map((profile) => profile.id))
        setProfiles(hydrated)
        setCredentialState({ ready: true })
      })
      .catch((error) => {
        if (!cancelled) setCredentialState({ ready: false, error: String(error) })
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!credentialState.ready) return
    const revision = syncRevisionRef.current + 1
    syncRevisionRef.current = revision
    const currentIds = new Set(profiles.map((profile) => profile.id))
    const records = profiles.map((profile) => ({
      id: profile.id,
      userName: profile.domain ? `${profile.domain}\\${profile.username}` : profile.username,
      secret: profile.password,
    }))
    void syncCredentials('rdp-profile', records, previousCredentialIdsRef.current)
      .then(() => {
        if (syncRevisionRef.current !== revision) return
        localStorage.setItem('xundu.remoteDesktopProfiles', JSON.stringify(
          profiles.map(({ password: _password, ...profile }) => profile),
        ))
        previousCredentialIdsRef.current = currentIds
        setCredentialState({ ready: true })
      })
      .catch((error) => {
        if (syncRevisionRef.current === revision) {
          setCredentialState({ ready: true, error: String(error) })
        }
      })
  }, [credentialState.ready, profiles])

  return [profiles, setProfiles, credentialState] as const
}

function usePersistentSnippets() {
  const [snippets, setSnippets] = useState<Snippet[]>(() => {
    try {
      const raw = localStorage.getItem('xundu.snippets')
      const storedVersion = Number(localStorage.getItem('xundu.snippets.version'))
      if (!raw) return defaultSnippets
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return defaultSnippets
      let normalized = parsed
        .map((snippet) => normalizeSnippet(snippet))
        .filter((snippet): snippet is Snippet => Boolean(snippet))
      // 版本不匹配时，用 defaultSnippets 的 category 迁移已有默认命令（保留用户自定义）
      if (storedVersion !== SNIPPETS_VERSION) {
        const defaultMap = new Map(defaultSnippets.map((s) => [s.id, s]))
        normalized = normalized.map((s) => {
          const def = defaultMap.get(s.id)
          return def ? { ...s, category: def.category || s.category } : s
        })
      }
      return normalized.length > 0 ? normalized : defaultSnippets
    } catch {
      return defaultSnippets
    }
  })

  useEffect(() => {
    localStorage.setItem('xundu.snippets', JSON.stringify(snippets))
    localStorage.setItem('xundu.snippets.version', String(SNIPPETS_VERSION))
  }, [snippets])

  return [snippets, setSnippets] as const
}

function usePersistentSnippetCategories() {
  const [categories, setCategories] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('xundu.snippetCategories')
      if (!raw) return [...SNIPPET_CATEGORIES]
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return [...SNIPPET_CATEGORIES]
      const list = parsed.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      // 确保"未分类"始终存在且在末尾
      const withoutUncategorized = list.filter((c) => c !== '未分类')
      return [...new Set([...withoutUncategorized, '未分类'])]
    } catch {
      return [...SNIPPET_CATEGORIES]
    }
  })

  useEffect(() => {
    localStorage.setItem('xundu.snippetCategories', JSON.stringify(categories))
  }, [categories])

  return [categories, setCategories] as const
}

function usePersistentSessionNotes() {  const [notes, setNotes] = useState<SessionNote[]>(() => {
    try {
      const raw = localStorage.getItem('xundu.sessionNotes')
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((note) => normalizeSessionNote(note))
        .filter((note): note is SessionNote => Boolean(note))
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem('xundu.sessionNotes', JSON.stringify(notes))
  }, [notes])

  return [notes, setNotes] as const
}

function normalizeInspectDevice(device: unknown): InspectDevice | null {
  if (!device || typeof device !== 'object') return null
  const d = device as Record<string, unknown>
  if (typeof d.id !== 'string' || typeof d.name !== 'string' || typeof d.host !== 'string') return null
  return {
    id: d.id,
    name: d.name,
    host: d.host,
    port: typeof d.port === 'number' && d.port > 0 ? Math.floor(d.port) : 22,
    username: typeof d.username === 'string' ? d.username : '',
    password: typeof d.password === 'string' ? d.password : '',
    vendor: typeof d.vendor === 'string' ? d.vendor : 'linux',
    remark: typeof d.remark === 'string' ? d.remark : '',
    encryptedPassword: typeof d.encryptedPassword === 'string' ? d.encryptedPassword : '',
  }
}

async function resolveInspectPasswords(list: InspectDevice[]): Promise<InspectDevice[]> {
  return Promise.all(
    list.map(async (d) => {
      if (d.encryptedPassword) {
        try {
          return { ...d, password: await invoke<string>('decrypt_secret', { cipher: d.encryptedPassword }) }
        } catch {
          return { ...d, password: '' }
        }
      }
      return d
    }),
  )
}

function usePersistentInspectDevices() {
  const [devices, setDevices] = useState<InspectDevice[]>(() => {
    try {
      const raw = localStorage.getItem('rain.inspectDevices')
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((d) => normalizeInspectDevice(d))
        .filter((d): d is InspectDevice => Boolean(d))
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem('rain.inspectDevices', JSON.stringify(devices))
  }, [devices])

  return [devices, setDevices] as const
}

function usePersistentAppAppearance() {
  const [appearance, setAppearance] = useState<AppAppearance>(() => {
    try {
      return localStorage.getItem('xundu.appearance') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })

  useEffect(() => {
    localStorage.setItem('xundu.appearance', appearance)
  }, [appearance])

  return [appearance, setAppearance] as const
}

function usePersistentThemePreset() {
  const [preset, setPreset] = useState<AppThemePresetId>(() => {
    try {
      const saved = localStorage.getItem('xundu.themePreset')
      return isAppThemePresetId(saved) ? saved : DEFAULT_THEME_PRESET_ID
    } catch {
      return DEFAULT_THEME_PRESET_ID
    }
  })

  useEffect(() => {
    localStorage.setItem('xundu.themePreset', preset)
  }, [preset])

  return [preset, setPreset] as const
}

function usePersistentAppBackground() {
  const [settings, setSettings] = useState<AppBackgroundSettings>(() => {
    try {
      const raw = localStorage.getItem('xundu.appBackground')
      if (!raw) throw new Error('missing background settings')
      const parsed = JSON.parse(raw) as Partial<AppBackgroundSettings>
      const path = typeof parsed.path === 'string' ? parsed.path : ''
      return {
        enabled: parsed.enabled === true && Boolean(path),
        path,
        name: typeof parsed.name === 'string' ? parsed.name : '',
        transparency: normalizeAppBackgroundTransparency(parsed.transparency),
      }
    } catch {
      return {
        enabled: false,
        path: '',
        name: '',
        transparency: DEFAULT_APP_BACKGROUND_TRANSPARENCY,
      }
    }
  })

  useEffect(() => {
    localStorage.setItem('xundu.appBackground', JSON.stringify(settings))
  }, [settings])

  return [settings, setSettings] as const
}

function usePersistentTerminalFontSize() {
  const [fontSize, setFontSize] = useState(() => {
    try {
      return normalizeTerminalFontSize(
        localStorage.getItem('xundu.terminalFontSize') ?? DEFAULT_TERMINAL_FONT_SIZE,
      )
    } catch {
      return DEFAULT_TERMINAL_FONT_SIZE
    }
  })

  const setNormalizedFontSize = useCallback((value: number) => {
    setFontSize(normalizeTerminalFontSize(value))
  }, [])

  useEffect(() => {
    localStorage.setItem('xundu.terminalFontSize', String(fontSize))
  }, [fontSize])

  return [fontSize, setNormalizedFontSize] as const
}

function usePersistentDisplayLanguage() {
  const [language, setLanguage] = useState<AppLanguage>(() => {
    try {
      const stored = localStorage.getItem('xundu.displayLanguage')
      return stored === 'zh-CN' || stored === 'en-US' ? stored : 'system'
    } catch {
      return 'system'
    }
  })

  useEffect(() => {
    localStorage.setItem('xundu.displayLanguage', language)
  }, [language])

  return [language, setLanguage] as const
}

function usePersistentTimeZonePreference() {
  const [timeZone, setTimeZone] = useState(() => {
    try {
      const stored = localStorage.getItem('xundu.timeZone')
      if (!stored || stored === 'system') return 'system'
      new Intl.DateTimeFormat('en-US', { timeZone: stored }).format()
      return stored
    } catch {
      return 'system'
    }
  })

  useEffect(() => {
    localStorage.setItem('xundu.timeZone', timeZone)
  }, [timeZone])

  return [timeZone, setTimeZone] as const
}

function usePersistentRemoteAuxConcurrency() {
  const [concurrency, setConcurrency] = useState(() => {
    try {
      return normalizeRemoteAuxConcurrency(
        localStorage.getItem('xundu.remoteAuxConcurrency') ?? DEFAULT_REMOTE_AUX_CONCURRENCY,
      )
    } catch {
      return DEFAULT_REMOTE_AUX_CONCURRENCY
    }
  })

  const setNormalizedConcurrency = useCallback((value: number) => {
    setConcurrency(normalizeRemoteAuxConcurrency(value))
  }, [])

  useEffect(() => {
    localStorage.setItem('xundu.remoteAuxConcurrency', String(concurrency))
  }, [concurrency])

  return [concurrency, setNormalizedConcurrency] as const
}

export default App
