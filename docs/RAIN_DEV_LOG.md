# RainTerminal 二开开发日志

> 每次改动均通过独立 git commit 留档，可通过 commit hash 回退。
> 回滚方式：`git revert <hash>`（保留历史）或 `git reset --hard <hash>`（直接回退）。

---

## 2026-09-06 · 阶段 1：网络设备查询命令模板

- **改动文件**：`src/App.tsx`（`defaultSnippets` 常量，仅数据层）
- **改动内容**：在原有 3 条 Linux 常用命令基础上，新增 55 条网络设备**查询类**命令模板：
  - 通用查询 2 条（设备时间）
  - 华为 VRP（display 系）14 条：版本 / 当前配置 / 接口状态 / IP 接口 / CPU / 内存 / 设备健康 / 光模块 / 风扇 / 电源 / ARP / MAC / LLDP / 日志
  - 华三 Comware（display 系）14 条：版本 / 当前配置 / 接口状态 / IP 接口 / CPU / 内存 / 设备信息 / 光模块诊断 / 风扇 / 电源 / ARP / MAC / LLDP / 设备序列号
  - 锐捷 RGOS（show 系）12 条：版本 / 运行配置 / 接口状态 / IP 接口 / CPU / 内存 / ARP / MAC / VLAN / LLDP / 路由表 / 序列号
  - 中兴 ZXR10（show 系）12 条：版本 / 运行配置 / 接口状态 / IP 接口 / CPU / 内存 / ARP / MAC / VLAN / 日志 / 路由表 / 光模块
- **命名规范**：`厂商·用途` 前缀（华为· / 华三· / 锐捷· / 中兴· / 通用·），便于列表识别与后续分组
- **验证**：`npm run build` 通过（无 TS 错误，产物正常生成）
- **使用方式**：SSH 连接设备后，打开「常用命令」面板（snippets）点击条目，命令填入执行框，确认后执行
- **commit**：`d80934c`（feat(snippets): 添加华为/华三/锐捷/中兴网络设备查询命令模板（55 条）+ 开发日志）

---

## 2026-09-06 · 阶段 1 增强：命令分类分组 + 搜索框

- **改动文件**：`src/App.tsx`（类型/数据/面板）、`src/i18n.ts`（文案）、`src/index.css`（样式）
- **改动内容**：
  - `Snippet` 类型新增 `category?: string` 字段
  - 58 条默认模板全部标注分类：Linux 服务器(3) / 华为(14) / 华三(14) / 锐捷(12) / 中兴(12) / 通用(2)
  - `normalizeSnippet` 兼容旧数据：无 category 自动归为「未分类」，localStorage 已有数据不丢失
  - 「常用命令」面板重构：
    - 顶部新增搜索框，匹配名称 / 命令 / 分类
    - 按分类分组渲染，每组标题可点击折叠/展开，右侧显示该组命令数
    - 分类顺序固定：Linux 服务器 → 华为 → 华三 → 锐捷 → 中兴 → 通用 → 未分类
  - 新建命令表单新增「分类」下拉选择
  - 新增 i18n 文案：搜索命令 / 未分类 / 分类（中英文）
- **验证**：`npm run build` 通过（无 TS 错误；CSS +1.3KB，JS +2.6KB）
- **使用方式**：打开「常用命令」面板，点击分类标题折叠/展开；搜索框输入厂商名或命令关键字过滤
- **回滚**：`git revert <本次 commit hash>`（可用 `git log --oneline` 查看）

---

## 2026-09-06 · 阶段 1 修复：数据迁移 BUG + 动态分类 + 右键移动

- **BUG 修复**：
  - 旧版 localStorage 数据（无 category）覆盖了带分类的默认模板，导致所有命令显示「未分类」→ 新增 `SNIPPETS_VERSION=2` 版本号，启动时版本不匹配则用 defaultSnippets 的 category 迁移已有默认命令（保留用户自定义）
  - `addSnippet` 保存新命令时丢失 category 字段 → 已修复，保存时带上 `snippet.category || '未分类'`
- **动态分类管理**：
  - 新增 `usePersistentSnippetCategories` hook，分类列表持久化到 localStorage（`xundu.snippetCategories`）
  - 面板顶部新增「分类」按钮，展开分类管理区：输入名称新建分类、列出所有分类可删除（「未分类」不可删，删除分类后该分类下命令自动归为「未分类」）
  - 新建命令表单的分类下拉改为动态读取现有分类
- **右键菜单移动命令**：
  - 每条命令支持右键 → 弹出「移动到分类」菜单 → 选择目标分类即移动
  - 菜单点击外部/滚动自动关闭
- **改动文件**：`src/App.tsx`、`src/i18n.ts`、`src/index.css`
- **验证**：`npm run build` 通过（修复 1 处 TS 类型错误）
- **回滚**：`git revert <本次 commit hash>`（可用 `git log --oneline` 查看）

---

## 2026-09-06 · 阶段 1 修复：布局规范 + 分组默认折叠持久化

- **布局修复**：
  - 分类管理区输入框过窄、加号按钮过大 → 输入框 `flex:1` 占满剩余宽度，加号按钮固定 32×32px
  - 顶部「分类」「新建」按钮超出面板被截断 → 按钮容器加 `flexShrink:0` 防压缩
  - 面板滚动条过粗 → 统一细化为 6px 圆角滚动条（分类列表/侧边栏/抽屉）
- **分组折叠持久化**：
  - 新增 `usePersistentExpandedCategories` hook，展开状态存 localStorage（`xundu.snippets.expanded`）
  - 启动时默认**全部折叠**（展开集合为空），用户展开的分类下次启动保持展开
  - 新分类默认折叠
- **改动文件**：`src/App.tsx`、`src/index.css`
- **验证**：`npm run build` 通过
- **回滚**：`git revert <本次 commit hash>`（可用 `git log --oneline` 查看）

---

## 2026-09-06 · 阶段 1 修复：面板背景透出终端 + 滚动条布局抖动

- **背景透出修复**：
  - 根因：`.inspector` 背景被全局规则设为 `transparent`，外层抽屉是半透明毛玻璃（`--glass-panel`，浅色下 74% 不透明），终端命令回显透过面板显示
  - 修复：给 `.inspector` 加不透明背景（深色 `#14151a` / 浅色 `#f7f8fa`），完全遮挡后方终端
- **滚动条修复**：
  - 根因：实际滚动容器是 `.inspector`（`overflow: hidden auto`），但细滚动条样式错加到了 `.drawer-body`；Firefox `scrollbar-color` 写死深色 `#252630`
  - 修复：webkit 滚动条样式改加到 `.inspector`（6px 细条 + 主题适配色 `--scroll-thumb`）；Firefox 同步改主题色；加 `scrollbar-gutter: stable` 预留滚动条空间，防止出现时挤压内容宽度
- **未分类分组**：确认默认存在且不可删除（分类管理区不显示删除按钮，右键菜单仍可移动到未分类）
- **改动文件**：`src/index.css`
- **验证**：`npm run build` 通过
- **回滚**：`git revert <本次 commit hash>`（可用 `git log --oneline` 查看）

---

## 2026-09-06 · 阶段 1 修复：新建分类后空分组不可见

- **BUG 根因**：
  - `visibleGroups` 过滤了空分组（`list.length > 0`），新建分类下无命令，导致命令列表里不显示新分类，用户感知不到添加成功
  - `saveCategory` 添加后自动关闭分类管理面板（`setCategoryEditorOpen(false)`），且无空态提示
- **修复**：
  - 去掉空分组过滤，所有分类（包括空的）都显示在命令列表中
  - 新建分类后自动展开该分类（`setExpandedCategories`）
  - 分类管理面板添加后不自动关闭，方便连续添加
  - 空分组展开后显示提示「暂无命令，右键其他命令可移动到此分类」
- **改动文件**：`src/App.tsx`、`src/i18n.ts`、`src/index.css`
- **验证**：`npm run build` 通过；已启动 `npm run desktop:dev` 供用户手动验证（GUI 自动化工具初始化失败，未能自动截图）
- **回滚**：`git revert <本次 commit hash>`（可用 `git log --oneline` 查看）

---

## 2026-09-06 · 阶段 2 起步：自动化巡检 Tab + 设备管理（v1.1.0-dev）

- **改动文件**：`src/App.tsx`（类型/持久化 hook/CRUD/Inspector 渲染/DockRail 入口）、`src/i18n.ts`（文案）、`src/index.css`（样式）、`package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`（版本号）
- **版本号**：1.0.1 → 1.1.0-dev
- **改动内容**：
  - 新增 `InspectDevice` 类型：id / name / host / port / username / password / vendor / remark
  - 新增厂商枚举 `INSPECT_VENDORS`：linux / huawei / h3c / ruijie / zte / other
  - 新增 `usePersistentInspectDevices` hook（localStorage key `rain.inspectDevices`，独立于旧 xundu 前缀）
  - 新增 `normalizeInspectDevice` 数据清洗
  - App 层新增设备 CRUD：addInspectDevice / updateInspectDevice / deleteInspectDevice（含 toast 提示）
  - `InspectorTab` 扩展 `'inspect'`；DockRail「活动」区新增「自动化巡检」入口（Activity 图标）
  - Inspector 新增 inspect 分支：设备列表 + 添加/编辑表单（名称/IP/端口/厂商/用户名/密码/备注）+ 删除确认
- **说明**：本步仅设备管理（规划第 1 步），批量执行命令在下一步实现
- **验证**：`npm run build` 通过（无 TS 错误）
- **commit**：`e9ed17f`

---

## 2026-09-06 · 阶段 2：批量命令执行引擎（后端 + 前端）

- **改动文件**：`src-tauri/src/batch_inspect.rs`（新增）、`src-tauri/src/lib.rs`（mod/command 注册/pub(crate)）、`src/App.tsx`（inspect 分支扩展）、`src/i18n.ts`（文案）、`src/index.css`（样式）、`src/tauriBridge.ts`（sandbox mock）
- **改动内容**：
  - 后端新增 `batch_inspect.rs`：非交互式 SSH 批量执行引擎
    - `batch_execute_inspect` command：设备列表 + 命令列表 → 逐设备串行执行
    - 复用 `connect_interactive_ssh_session`（密码/密钥/agent 认证），认证后 set_timeout(800ms) 作为静默期
    - Linux：read EOF 判定命令结束；网络设备：静默期判定 + `---- More ----`/`--More--` 分页自动翻页
    - 错误标记检测：`% Unrecognized command` / `command not found` 等 → success=false
    - 单条命令输出上限 512KB 防内存膨胀
  - 前端 inspect 分支新增：设备勾选（全选/取消全选）、多行命令输入、执行按钮（显示选中数）、结果区（每设备结果卡片 + 命令输出折叠展示）
  - sandbox mock 支持 `batch_execute_inspect`（返回模拟结果，方便无设备时验证 UI）
- **说明**：当前串行执行（MVP），并发在后续阶段加入；凭据仍从 localStorage 读取（明文），后续迁移 Credential Manager
- **验证**：`npm run build` 通过；后端编译因 app.exe 被 Defender 临时锁定待重试
- **commit**：待提交

## 2026-09-06 · 阶段 2 进阶：命令模板联动

- **改动文件**：`src/App.tsx`（inspect 分支命令区重构）、`src/i18n.ts`（文案）、`src/index.css`（样式）
- **改动内容**：
  - 命令列表从多行 textarea 升级为结构化列表：每条命令显示名称 + 内容，支持上移/下移排序、移除
  - 手动输入：单行输入框，回车或点击"添加"加入列表
  - 新增"从模板选择"面板（内联展开）：
    - 按命令模板分类（Linux/华为/华三/锐捷/中兴/通用/自定义分类）分组展示
    - 顶部搜索框可过滤命令
    - 每个模板带"+"按钮，点击加入命令列表；已添加的显示"已添加"并禁用（按命令内容去重）
    - **厂商推荐**：根据已勾选设备的厂商类型，自动展开对应分类并标注"推荐"
  - IconButton 组件支持 disabled 属性
- **说明**：命令执行顺序 = 列表顺序；后端无需改动（commands 结构一致）
- **验证**：`npm run build` 通过
- **commit**：待提交

## 2026-09-06 · 阶段 2 进阶：故障判断引擎

- **改动文件**：`src-tauri/src/batch_inspect.rs`（规则引擎）、`src/App.tsx`（结果展示）、`src/i18n.ts`（文案）、`src/index.css`（样式）、`src/tauriBridge.ts`（mock）
- **改动内容**：
  - 后端新增故障判断规则引擎（内置规则库，按厂商+命令内容子串匹配）：
    - 关键字规则：输出包含关键字即命中（如 display device 含 Fault/Abnormal → 严重）
    - 阈值规则：输出最大数字 ≥ 阈值（CPU/内存/负载/磁盘使用率）
    - 覆盖 Linux / 华为 / 华三 / 锐捷 / 中兴，约 30 条预设规则
    - 每条命令输出返回 health（ok/warn/critical）+ 命中原因列表（中文）
    - 设备健康 = 全部命令最差等级；命令执行失败/SSH 失败直接判严重
  - 前端结果区：设备卡片显示健康徽章（正常/警告/严重）、汇总行按等级计数、命令行显示命中原因（⚠ 磁盘使用率 ≥ 90%…），critical 命令自动展开
- **说明**：规则为内置预设，自定义规则编辑器规划在后续版本
- **验证**：`cargo check` + `npm run build` 通过
- **commit**：待提交

## 2026-09-07 · 阶段 2 完成：并发执行 / 进度 / 失败重试 / 导出导入

- **改动文件**：`src-tauri/src/batch_inspect.rs`（并发+进度+重试）、`src-tauri/src/lib.rs`（导出/导入 filter 参数）、`src/App.tsx`（前端）、`src/i18n.ts`（文案）、`src/index.css`（样式）
- **改动内容**：
  - 后端：
    - `batch_execute_inspect` 支持并发（1-10，默认 5，按设备数收敛），thread::scope 多线程执行
    - 每台设备完成推送 `inspect-progress` 事件（current/total/deviceName）
    - 设备连接失败自动重试一次
    - `save_text_export` / `open_text_import` 新增可选 filter 参数（json/csv/txt），文件对话框过滤器随之变化
  - 前端：
    - 执行区新增并发数输入（1-10）+ 进度条（执行中显示 current/total）
    - 结果导出：JSON 全量报告 / CSV 设备汇总（含 BOM，Excel 打开不乱码）
    - CSV 导入设备：选择 CSV（name,host,port,username,password,vendor,remark），自动校验 vendor、解析引号转义，导入结果 toast 提示
  - Inspector 新增 onNotify prop（接入全局 toast）
- **说明**：自动化巡检五步（设备管理/批量执行/模板联动/故障判断/增强导出）至此全部完成
- **验证**：`cargo check` + `npm run build` 通过，后端完整编译通过
- **commit**：待提交
