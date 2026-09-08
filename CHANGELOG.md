# Changelog

All notable changes to RainTerminal will be documented here. The project follows Semantic Versioning after the first stable release.

## [Unreleased]

## [1.0.4] - 2026-09-08

### Added

- MTR 路由追踪小工具：逐跳解析、实时上屏、可停止，支持任意目标（域名 / IP）。
- 密码生成器小工具：长度/数量/字符集可控，排除易混淆字符，支持单条复制、复制全部、导出 txt 与清空。
- 运维小工具布局统一：无数据时保持矮卡片，有数据（运行中/有结果）自动铺满到底并在内部滚动。
- 设备列表支持自定义厂商：可自主新增、永久删除厂商，不再局限于内置列表。

### Fixed

- 启动时因存在密码为空的设备而弹出"SSH 认证配置未应用"，改为尽力注册、跳过无效条目。
- 密码生成器 / MTR 页面在切换 tab 后丢失内容，状态保留。
- 小工具页面组件越界、滚动条影响布局、未分类分组无法删除等布局与交互问题。

## [1.0.3] - 2026-09-08

### Added

- Telnet / Serial 手动连接支持（网络设备与 Linux 通用），默认端口 23，支持任意端口。
- 连接后按需保存会话日志：系统"另存为"对话框，文件名可自定义（默认 IP-时间戳.log），支持开始/停止。
- 会话日志自动剥离 ANSI 颜色/光标/标题控制序列；输入编辑（退格重输）自动消化为最终命令，服务端输出原样完整记录。

### Fixed

- SSH 输入命令名不匹配导致点"保存会话日志"即断开（ssh_session_write not found）。
- 会话日志文件名重复追加时间戳、动态开启后日志为空。
- Telnet 连接事件字段与前端不匹配导致一直"正在连接"。
- Telnet ECHO 协商：登录输入用户名不可见（telnet-server 安全机制）。
- 三个协议连接失败时日志条目泄漏；串口枚举支持手动输入 COM 号。

## [1.0.1] - 2026-09-06

### Added

- Group reordering via right-click context menu: move up, move down, move to top, move to bottom.
- Reorder state persists across restarts.

### Fixed

- Context menus clipped by drawer overflow; now rendered via React Portal to document body.
- Context menus not closing when clicking outside; global mousedown listener added.
- Removed leftover drag handle icons after switching from HTML5 drag-and-drop to right-click reordering.

## [1.0.0] - 2026-09-06

### Added

- Network device command template library with built-in query commands for Huawei, H3C, Ruijie, ZTE and other mainstream vendors.
- Dynamic category management: create, delete, and rename command categories; right-click to move commands between groups.
- Command search with auto-expand groups and keyword matching across name, command, and category.
- Persistent snippet categories with versioned localStorage migration.

### Changed

- Rebranded from XunDuTerminal to RainTerminal; all user-facing strings, identifiers, and data directories updated.
- Update source pointed to xsenrain/RainTerminal repository.
- Removed enterprise server and technical QQ group sections from the About page.

### Fixed

- New command category not persisting after save (state reset to "未分类" while dropdown showed first category).
- Search results hidden because groups remained collapsed after filtering.
- Category operation notice overlapping with drawer title due to stacking context.

## [0.2.2] - 2026-08-06

### Fixed

- Restore the parent-directory action in the remote file manager when the current directory is `/root` or `~`.
- Allow direct navigation to the Unix root directory `/` while keeping its parent action disabled.

## [0.2.1] - 2026-08-04

### Fixed

- Recover the local terminal automatically after a closed ConPTY pipe or Windows error 232.
- Prevent failed input from being replayed into the replacement shell and deduplicate concurrent recovery attempts.
- Clear stale local-terminal session state and suppress obsolete close events from replaced processes.
- Record local-terminal start, close, write failure, stop, and recovery diagnostics.

## [0.2.0] - 2026-07-22

### Added

- Secure in-app update downloads with progress, cancellation, retry, exact-size checks, and SHA-256 verification.
- Verified installer handoff that still requires explicit user confirmation before installation.
- Windows Credential Manager storage and plaintext credential migration.
- SSH password, private-key, and Agent authentication foundations.
- OpenSSH config import and known-host verification for helper connections.
- Open-source governance, security, and CI scaffolding.

### Changed

- Update downloads now appear in the unified file transfer manager.
- Stable GitHub Releases automatically publish a client update manifest; prereleases remain opt-in.

## [0.1.0] - 2026-07-20

- Initial public preview baseline.
