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

## 2026-09-07 · 巡检界面整体重新布局：抽屉+模态框 → 独立全页工作台

- **背景**：用户反馈巡检功能挤在右侧窄抽屉中，设备管理/命令配置/执行控制纵向堆叠，添加设备为模态框，操作不便捷
- **改动文件**：`src/App.tsx`（路由+新组件）、`src/i18n.ts`（文案）、`src/index.css`（全页布局样式）
- **改动内容**：
  - 新增 `mainView` 状态（workbench / inspect）：点击 DockRail「自动化巡检」切换到独立全页视图（不再开抽屉）；点击其他导航项回到工作台/抽屉
  - 新增 `InspectWorkspace` 全页组件：
    - 顶部：标题栏 + 「从 CSV 导入设备」「添加设备」
    - 左栏：设备列表（勾选/全选/编辑/删除）+ 添加/编辑**内联表单**（点击"添加设备"在栏内展开，不再弹模态框）
    - 右栏：命令配置（已选命令列表排序/移除、手动输入、模板选择面板、并发数、执行按钮+进度条、导出）
    - 下方：执行结果区（全宽，设备卡片网格，健康徽章+命中原因）
  - 巡检相关 state/逻辑从 Inspector 迁移至 InspectWorkspace（进度监听、CSV 导入导出等）
- **说明**：旧抽屉内巡检分支保留但不再可达（安全网）；工作台运行状态在切换视图时保留
- **验证**：`npm run build` 通过
- **commit**：待提交

## 2026-09-07 · 巡检工作台：阈值判断修复 + 状态跨视图保留 + 重置按钮

- **背景**：①用户反馈执行 df -h 被误报“磁盘使用率 ≥ 90%”（实际 41%/58%）；②切换页面再回来巡检结果/勾选/命令丢失；③要求添加设备旁增加“重置”按钮（断开所有连接、优化连接池）
- **改动文件**：src-tauri/src/batch_inspect.rs、src-tauri/src/lib.rs、src/App.tsx、src/tauriBridge.ts
- **改动内容**：
  - 后端（batch_inspect.rs）：
    - InspectRule.threshold 由 u64 改为 f64，新增 percent 标记
    - 百分比模式规则（df/CPU/内存）只提取 “NN%” 格式最大值（max_percent），不再把容量（1000M/989M）误当使用率
    - 数值模式规则（负载/温度）提取最大数值且支持小数（max_number），load average: 0.52 不再误报
  - 后端（lib.rs）：
    - 新增 inspect_reset_all 命令：断开全部交互 SSH 会话（发 Disconnect + 置死）、清空远程辅助会话池、终止 SSH 隧道进程、取消全部文件传输任务、终止本地 Shell，返回断开数量；已注册进 generate_handler
  - 前端（App.tsx）：
    - 巡检状态（勾选/命令列表/结果/并发数/进度/运行中）从 InspectWorkspace 提升到 App 层，切视图后保留
    - 头部新增“重置”按钮（添加设备右侧，danger 样式）：confirm 确认 → 调 inspect_reset_all → 清空巡检状态 → toast 提示断开数量
  - tauriBridge.ts：sandbox mock 增加 inspect_reset_all
- **验证**：cargo check 通过（无警告）、npm run build 通过；debug exe 被运行中 dev 实例占用未能链接（正常）
- **commit**：待提交

## 2026-09-07 · 重置按钮收敛为纯巡检级（不影响其他功能）

- **背景**：用户澄清重置只针对自动化巡检，不得影响工作台的终端会话/隧道/传输等其他功能
- **改动**：
  - 后端：删除 inspect_reset_all 命令（其断开全部 SSH 会话/隧道/传输/本地 Shell 的行为超出巡检范围）；巡检引擎本身即连即断、无常驻连接池，无需后端清理命令
  - 前端（App.tsx）：
    - 
esetInspectWorkspace 改为纯前端操作：清空巡检结果、设备勾选、命令列表、进度，并发恢复默认 5，仅 toast 提示，不再调用后端、不动工作台连接
    - 新增 discardInspectResultRef：若重置时巡检仍在执行（invoke 无法中断），返回的结果/错误将被丢弃，不写入界面
  - tauriBridge.ts：移除 inspect_reset_all mock
- **验证**：cargo check（无警告）+ npm run build 通过
- **commit**：待提交

## 2026-09-07 · 巡检并发数改为前端可控（后端仅保留兜底上限）

- **背景**：用户要求并发数不被后端锁死，由前端自行控制
- **改动**：
  - 前端（App.tsx）：并发输入框范围 1-10 → 1-200（两处：旧抽屉分支与新全页工作台，同步修改）
  - 后端（batch_inspect.rs）：concurrency.clamp(1, 10) → clamp(1, 200)，仅作防呆兜底，不再限制用户
  - 实际并发数 = min(前端设置值, 设备总数)
- **验证**：cargo check（无警告）+ npm run build 通过
- **commit**：待提交

## 2026-09-07 · 并发数按填值执行，超上限明确提示

- **背景**：用户要求“填多少就多少台同一批执行”，若有限制需明确提示最高并发数，不能静默夹紧
- **改动**（App.tsx 新全页工作台 + 旧抽屉分支同步）：
  - 并发输入框：允许自由输入任意数值（不再 onChange 即时夹紧），失焦时若 > 200 提示“并发数最高为 200，已自动调整为 200”并修正，< 1 修正为 1；输入框 title 提示“最大并发数 200”
  - 执行时兜底校验：若提交值超上限，toast 提示后按 200 执行，实际并发 = min(填值, 设备总数)
  - 后端 clamp(1,200) 保留作防呆兜底
- **验证**：npm run build 通过
- **commit**：待提交

## 2026-09-07 · 并发输入框加宽

- **背景**：用户反馈并发编辑框宽度过窄，200 显示不全
- **改动**：index.css .inspect-concurrency input 宽度 46px → 68px
- **验证**：npm run build 通过
- **commit**：待提交

## 2026-09-07 · 左侧菜单改名：自动化巡检 → 自动化

- **背景**：用户要求左侧导航"自动化巡检"改为"自动化"；并规划巡检全链路日志系统（命令/判断关键词/执行回显写日志，路径可控）
- **改动**：App.tsx（DockRail 菜单项、抽屉面板标题、巡检工作台页头）与 i18n.ts（新增'自动化'映射）同步改名
- **验证**：npm run build 通过
- **commit**：待提交

## 2026-09-07 · 巡检日志系统：Xshell式流水日志 + 路径可控

- **背景**：用户规划——除底层核心外，巡检命令、判断关键词、执行过程所有回显通过日志输出，日志保存路径可控；形式类似 Xshell 日志（连接 SSH 后到执行完命令的完整记录）
- **后端**（batch_inspect.rs / lib.rs / Cargo.toml）：
  - 新增 chrono 依赖（本地可读时间戳）
  - batch_execute_inspect：每台设备生成一个日志文件 inspect_设备名_YYYYMMDD_HHMMSS.log，内容为连接→执行→断开全程流水：连接成功/失败、每条命令完整回显（去 ANSI 色码）、故障判断结果与命中依据、健康等级、结束汇总；单命令回显 512KB 截断保护；失败自动重试共用同一日志文件
  - InspectExecResult 新增 logPath 字段（每台设备日志文件路径）
  - 新增命令：get_inspect_log_dir（默认 <应用数据目录>/logs/inspect）、set_inspect_log_dir（自定义路径持久化到 inspect_config.json）、open_inspect_log_dir（explorer 打开）、pick_inspect_log_dir（目录选择框）
- **前端**（App.tsx / tauriBridge.ts / index.css）：
  - 巡检结果卡片新增“日志”按钮（FolderOpen 图标，悬停显示完整路径，点击打开日志目录）
  - 设置页“服务器”分组新增“巡检日志”配置：路径输入框 + 浏览…/保存路径/打开日志目录 按钮，加载时读取当前配置
  - tauriBridge mock 补齐日志相关命令
- **验证**：cargo check（无警告）+ npm run build 通过
- **commit**：待提交

### 2026-09-07 · 巡检日志设置调整（按用户要求）
- 巡检日志设置从"设置页 → 服务器"移至**自动化页面**（执行按钮下方新增"巡检日志"行：路径输入框 + 浏览…/保存/打开目录）
- 默认日志路径改为**软件运行目录**（exe 所在目录，不再用 %LOCALAPPDATA% 下的 logs/inspect）
- 移除设置页相关配置块与 onNotify prop
- 验证：cargo check（无警告）+ npm run build 通过

### 2026-09-07 · 修复两个问题（按用户反馈）
1. **执行连接失败/超时导致主界面卡住**：batch_execute_inspect 原为同步 command，SSH 阻塞直接占用 IPC 线程，设备超时期间 UI 交互排队卡死。改为 async command + spawn_blocking，阻塞工作移入独立线程池，执行期间界面可正常操作。
2. **保存日志目录报"系统找不到指定的路径 (os error 3)"**：set_inspect_log_dir 写 inspect_config.json 前未创建 app_data_dir 父目录，首次保存必失败。已补 create_dir_all(config 父目录)。
3. 顺带优化：连接失败（TCP 超时/握手失败）不再盲目重试一次，单设备最多等一轮超时（约 10s，原来 20s）。
- 验证：cargo check（无警告）+ npm run build 通过

### 2026-09-07 · 巡检日志调整（按用户反馈）
1. **"保存"按钮含义澄清**：改为"应用路径"——手动输入路径后点此按钮才写入配置；浏览选目录则自动校验并保存，无需再点。
2. **目录存在性校验**：set_inspect_log_dir 不再自动创建目录，要求路径已存在且是目录，否则报错并拒绝写入配置（避免误填无效路径）。
3. **日志文件名加 IP**：inspect_设备名_时间戳.log → inspect_IP_设备名_时间戳.log（IP 中的点保留，非法字符替换为下划线）。
4. **去掉日志标题行**：删除"RainTerminal 巡检日志（连接 → 执行 → 断开 全程流水）"这一行，日志直接从分隔线+设备信息开始。
- 验证：cargo check（无警告）+ npm run build 通过

### 2026-09-07 · 批量导入功能（JSON 巡检任务文件）
- 自动化页面新增"批量导入"按钮（在"从 CSV 导入设备"左侧）
- 导入 JSON 任务文件，一个文件同时包含：
  - devices：设备列表（name/host/port/username/password/vendor/remark），按 host 去重，已存在跳过
  - commands：要执行的命令列表（name/command），导入后替换当前命令列表
  - concurrency：并发数（可选，1-200 自动夹取）
  - logDir：日志保存路径（可选，目录无效提示但不中断导入）
- 导入完成提示汇总：设备数/命令数/跳过数/并发/日志路径应用情况
- 验证：npm run build 通过（纯前端功能，无后端改动）

### 2026-09-07 · 表格导入替代 JSON + 日志文件名调整（按用户反馈）
1. **表格导入**（按钮"批量导入"→"表格导入"）：移除 JSON 批量导入，改为 CSV 表格导入，支持 commands 列：
   - 列：name,host,port,username,password,vendor,remark,commands
   - commands 列内多条命令用半角 | 或换行分隔；命令名称自动取命令文本（超48字符截断）
   - 设备按 host 去重；命令导入后替换当前列表；不填 commands 列则只导设备
   - 移除新组件内旧的"从 CSV 导入设备"按钮（功能被表格导入覆盖）
2. **下载模板**：新增"下载模板"按钮，导出带示例行的 CSV 模板（UTF-8 BOM，Excel 可直接打开），非专业人员按示例填即可
3. **日志文件名**：去掉 inspect_ 前缀，改为 IP_设备名_时间戳.log
4. 已知说明：命令 | 分隔选择理由——Excel 单元格内输入 | 直观且不依赖引号换行，比 CSV 单元格内换行（需引号包裹、Excel 输入麻烦）更适合非专业用户
- 验证：cargo check（无警告）+ npm run build 通过

### 2026-09-07 · 巡检结果导出简化（按用户反馈）
- 执行工具条只保留"导出表格"（CSV），移除"导出 JSON"
- CSV 列扩展明确结果：设备名称、主机、健康状态、执行结果、耗时(秒)、命令、判断依据、日志文件
  - 命令列：该设备执行的全部命令用 | 连接
  - 判断依据列：命中规则的说明（无则 -）
  - 日志文件列：对应流水日志完整路径
- 验证：npm run build 通过

### 2026-09-07 · 导出表格反馈完善（按用户反馈）
- 无巡检结果时点击"导出表格"：提示"暂无巡检结果，请先执行巡检后再导出"（原来静默无反应）
- 导出成功后：提示"已导出：<完整保存路径>"（save_text_export 返回路径此前被忽略）
- 导出流程：点击导出表格 → 弹出系统保存框（默认文件名 巡检汇总-日期.csv）→ 选择位置保存 → toast 显示保存路径
- 验证：npm run build 通过


---

## 2026-09-07 · 全局改名：服务器工作台 → 一体化运维工作台

- **改动文件**：`src/App.tsx`（顶部副标题、关于页描述）、`src/i18n.ts`（2 处中英文）、`package.json`（description）
- **改动内容**：
  - 顶部副标题：服务器工作台 → **一体化运维工作台**
  - 关于页描述：面向 Windows 的一体化服务器工作台… → 面向 Windows 的一体化**运维**工作台，将终端、文件、监控、进程、远程桌面与**自动化巡检**集中在可持久化工作区中
  - package.json description 同步更新（集成 SSH、文件管理、监控、进程、远程桌面与自动化巡检）
- **验证**：npm run build 通过；dev 版界面截图确认顶部副标题与关于页文案生效

---

## 2026-09-07 · P0：巡检历史 + HTML 报告

- **改动文件**：`src-tauri/src/batch_inspect.rs`（历史存储后端）、`src-tauri/src/lib.rs`（命令注册 + save_text_export 支持 html filter）、`src/App.tsx`（历史 Tab / 详情 / HTML 报告生成）、`src/index.css`、`src/i18n.ts`、`src/tauriBridge.ts`（sandbox mock）
- **后端**：
  - 新增 `save_inspect_history` / `list_inspect_history` / `get_inspect_history` / `delete_inspect_history` 四个命令
  - 存储位置：`%LOCALAPPDATA%/RainTerminal/inspect_history/YYYYMMDD_HHMMSS.json`（每条历史一个文件，含元信息 + 全部设备结果）
  - 元信息：记录 ID / 保存时间 / 设备数 / 命令数 / 成功数 / 失败数 / 严重数 / 警告数
  - ID 白名单校验（仅数字与下划线），防路径穿越
  - `save_text_export` 新增 `filter: 'html'` 支持导出 .html
  - 新增 `open_inspect_log_file`（资源管理器定位单个日志文件）
- **前端**：
  - 自动化页新增三个 Tab：**巡检工作台 / 巡检历史 / 故障规则**
  - 巡检执行完成后自动调用 save_inspect_history 入库（失败静默，不阻塞界面）
  - 巡检历史 Tab：记录列表（时间/设备/命令/成功失败/严重警告/查看/删除）+ 刷新；空状态提示
  - 详情视图：汇总统计条 + 每台设备卡片（健康徽标/命令回显/判断依据/一键打开日志）
  - 导出报告：生成内联 CSS 的 HTML 报告（健康色标 + 统计卡片 + 明细表），系统保存框导出 .html
  - 删除历史：confirm 确认后删除并刷新列表
- **验证**：npm run build 通过；cargo check 通过；dev 版截图确认 Tab / 历史空状态 / 规则列表 / 规则编辑器正常渲染

---

## 2026-09-07 · P2：故障规则自定义（静态规则 → 配置驱动）

- **改动文件**：`src-tauri/src/batch_inspect.rs`（规则引擎改造）、`src-tauri/src/lib.rs`（命令注册）、`src/App.tsx`（规则编辑器）、`src/index.css`、`src/tauriBridge.ts`（sandbox mock）
- **后端**：
  - 新增 `InspectRuleConfig`（可序列化：id/vendor/commandContains/severity/type/keyword/missingKeyword/threshold/percent/label/enabled），原静态 `InspectRule` 表保留为内置默认源
  - 规则存储：`%LOCALAPPDATA%/RainTerminal/inspect_rules.json`；首次启动自动写入内置规则（~35 条全量迁移）
  - 全局规则缓存 `RULES_CACHE`（Mutex）：巡检启动时加载一次，保存规则时同步更新，评估不再每次读盘
  - `assess_output` 改为遍历启用规则，按 type 分派（keyword 包含 / missing 缺失 / threshold 阈值+percent 百分比取值）
  - 新增 `get_inspect_rules` / `save_inspect_rules`（保存时校验：厂商/等级/说明非空、等级仅 warn|critical、规则 ID 不重复）
- **前端**：
  - 故障规则 Tab：规则表格（厂商/匹配命令/判断方式/条件/等级/说明/启用/编辑/删除）+ 新增规则 + 保存规则
  - 规则编辑器：适用厂商（Linux/华为/华三/锐捷/中兴/通用）、匹配命令包含、判断方式（关键词/缺失关键词/阈值）、阈值+按百分比、健康等级、判断说明、启用开关；应用修改先落本地列表，点"保存规则"一次性写盘生效
  - 启用/停用、删除均为本地编辑，保存后生效并即时生效于下一次巡检
- **验证**：npm run build 通过；cargo check 通过；dev 版截图确认规则列表与新增规则表单正常


---

## 2026-09-07 · 设备厂商：去前缀 + 厂商列表可自主管理（永久增删）

- **改动文件**：`src/App.tsx`、`src/index.css`、`src/i18n.ts`
- **改动内容**：
  - 设备列表厂商标签去掉"厂商."前缀，直接显示厂商值（linux / huawei / 深信服 等）
  - 添加设备下拉框去掉"厂商类型/厂商"标题，选项直接显示厂商值
  - **厂商列表可自主管理（用户否决"临时自定义输入"方案）**：
    - 厂商列表持久化存储到 `localStorage rain.inspectVendors`，永久保存；首次使用写入内置 6 个（linux/huawei/h3c/ruijie/zte/other）
    - 设备列表标题行新增"管理厂商"按钮，展开内联管理面板：输入框+添加（回车或按钮）、厂商 chip 列表逐个删除（confirm 确认）
    - 删除厂商后：已添加设备的厂商标记保留，仅不再出现在下拉选项中（不影响历史设备与规则）
    - 设备添加表单 / 规则编辑器厂商下拉均从该列表动态读取
  - CSV 表格导入不再把非内置厂商强制回退为 linux，保留导入的原厂商值
  - 规则编辑器新增规则默认厂商取列表第一个
- **验证**：npm run build 通过（无 TS 错误）


---

## 2026-09-07 · 修复：编辑设备表单布局错乱

- **改动文件**：`src/App.tsx`、`src/index.css`
- **改动内容**：
  - 编辑设备表单两列宽窄不一（左列被内容撑窄、右列过宽）、厂商下拉挤在端口行、输入框不对齐
  - 修复：`.inspect-device-form` 改用 `repeat(2, minmax(0, 1fr))` 强制等宽两列；label 加 `min-width: 0`；input/select 加 `width: 100%; min-width: 0`，杜绝内容撑破列宽
  - 厂商下拉 label 加空 span 占位（`::before` 填充空格保持行高），与其他字段顶部文字对齐；不显示"厂商"文字（符合上轮要求）
- **验证**：npm run build 通过


---

## 2026-09-07 · P1：定时自动巡检（巡检计划）

- **改动文件**：`src/App.tsx`、`src/index.css`、`src/i18n.ts`
- **改动内容**：
  - 自动化页新增第四个 Tab：**巡检计划**
  - 计划配置：名称、执行频率（每天 / 每周多选星期 / 每月第 N 天 / 每 N 小时）、执行时间（HH:MM）、并发数、勾选设备（多选）、执行命令（多行文本框每行一条，按顺序执行）
  - 计划列表：名称 / 频率描述 / 启用开关 / 立即执行 / 编辑 / 删除 / 上次执行时间 / 下次执行时间
  - 定时器：应用运行期间每 10 秒检查一次到点计划，自动触发执行（复用 batch_execute_inspect 引擎，结果自动写入巡检历史 + toast 汇总 + 更新 lastRunAt/nextRunAt）
  - 下次执行时间计算：daily=次日同刻、weekly=下个匹配星期、monthly=下月同日（超 28 天自动收敛）、interval=当前+N 小时
  - 防重复触发：执行中集合用 ref 同步（长任务期间定时器不会重复拉起同一计划）
  - 计划持久化 `localStorage rain.inspectPlans`，启用状态与执行时间重启不丢
  - 执行结果写入工作台结果区（不影响其他功能），也可在巡检历史查看
- **说明**：仅应用运行期间生效（软件关闭不执行）——个人运维工具定位，非后台服务
- **验证**：npm run build 通过（无 TS 错误）


---

## 2026-09-08 · 修复：计划命令输入无法空格/换行 + P3 凭据安全（DPAPI 加密）

- **改动文件**：`src/App.tsx`、`src/index.css`、`src/tauriBridge.ts`、`src-tauri/Cargo.toml`、`src-tauri/src/batch_inspect.rs`、`src-tauri/src/lib.rs`、`docs/RAIN_DEV_LOG.md`
- **修复：计划命令输入**：文本框 onChange 时逐字符 trim+重建导致输入过程中空格/换行被吞（`df -h` 变 `df-h`）。改为独立 draft state，输入期间不做任何清洗，保存计划时才按行解析
- **P3 凭据安全**：
  - 新增 Rust 命令 `encrypt_secret` / `decrypt_secret`：Windows DPAPI（CryptProtectData/CryptUnprotectData，CRYPTPROTECT_UI_FORBIDDEN），仅当前 Windows 用户可解密，输出 hex；非 Windows 退化为 hex 编码（仅开发用）
  - 设备密码不再明文存储：保存/编辑设备时密码经 DPAPI 加密后存 `encryptedPassword` 字段，password 字段清空；编辑时打开表单自动解密显示原密码
  - 启动时自动迁移：检测到旧数据中的明文密码，一次性加密后重存，无需手动处理
  - 执行链路（手动巡检 / 定时计划）在执行前批量解密密码，不影响使用
  - tauriBridge 沙箱 mock 增加 encrypt/decrypt（hex 模拟，真实加密在 Rust 端）
- **验证**：npm run build 通过、cargo check 通过


---

## 2026-09-08 · P3 补充：网段发现（批量生成设备清单）

- **改动文件**：`src/App.tsx`、`src/index.css`、`src/tauriBridge.ts`、`src-tauri/src/batch_inspect.rs`、`src-tauri/src/lib.rs`、`docs/RAIN_DEV_LOG.md`
- **后端**：新增 `scan_inspect_network(cidr)` 命令——解析 CIDR（支持 /16~30，防超大网段），逐 IP 并行探测 22(SSH)/23(Telnet) 端口（600ms 超时，64 并发线程），返回在线设备 IP + 开放端口
- **前端**：巡检工作台设备列表头部新增「网段发现」按钮，展开面板：
  - 输入网段（如 192.168.1.0/24）→ 开始扫描 → 显示在线设备（IP + SSH/Telnet 标签 + 厂商下拉，默认：23 开无 22 → other，其余 linux，可手动改）
  - 勾选后「添加勾选设备」批量生成设备清单（名称/主机=IP，端口取 22 或 23，备注"网段发现"，账号密码留空待填）
- **沙箱 mock**：模拟返回网段前 5 个 IP
- **验证**：npm run build 通过、cargo check 通过


---

## 2026-09-08 · 新增"小工具"菜单：网段发现迁移为独立小工具

- **改动文件**：`src/App.tsx`、`src/index.css`、`docs/RAIN_DEV_LOG.md`
- **改动内容**：
  - 左侧菜单新增「小工具」入口（Wrench 图标，独立全页视图，与自动化/工作台平级）
  - 新增 `InspectToolbox` 组件：卡片式布局，当前含「网段发现」工具（CIDR 输入 → 并行探测 22/23 端口 → 在线设备列表 → 勾选批量生成巡检设备清单，厂商下拉默认推断可改）
  - 网段发现从巡检工作台设备列表头部移除（不再挂靠在自动化模块）
  - 小工具页设计为可扩展集合：后续新工具（端口扫描、ping、子网计算等）在网格中加卡片即可
- **说明**：厂商列表复用巡检模块的持久化配置（读取 localStorage rain.inspectVendors）
- **验证**：npm run build 通过


---

## 2026-09-08 · 网段发现 V2：修复主界面卡死 + 参照 MobaXterm 重做扫描界面

- **改动文件**：`src/App.tsx`、`src/index.css`、`src/tauriBridge.ts`、`src-tauri/Cargo.toml`、`src-tauri/src/batch_inspect.rs`、`docs/RAIN_DEV_LOG.md`
- **修复卡死**：`scan_inspect_network` 由同步命令改为 async + `spawn_blocking`，扫描在后台线程执行，不再阻塞 Tauri 主线程（主界面不会未响应）
- **界面重做（参考 MobaXterm 网络扫描工具）**：
  - 输入改为 IP 起止范围（起始 IP → 结束 IP，最多 8192 个 IP）
  - 结果改为服务探测表格：IP 地址 | 名称 | SSH | RDP | VNC | FTP | Telnet | HTTP | HTTPS | 厂商 | 操作，开放端口 ✓ 绿色、关闭 ✗ 灰色
  - 每行独立「添加」按钮 + 顶部「添加勾选设备」批量按钮
  - 名称列自动反向 DNS 解析主机名（dns-lookup，解析不到显示 -）
- **进度反馈**：后端每处理 64 个 IP 推送 `inspect-scan-progress` 事件，前端显示进度条（扫描中 x/y）
- **探测端口**：22/23/3389/5900/21/80/443，500ms 超时，64 IP/线程分片并行
- **验证**：npm run build 通过、cargo check 通过（新增 dns-lookup 依赖）

---

## 2026-09-08 · 网段发现 V3：两阶段流式扫描（先存活 → 再端口）

- **改动文件**：src/App.tsx、src/index.css、src/tauriBridge.ts、src-tauri/src/batch_inspect.rs
- **新流程（参考 MobaXterm 快速性）**：
  1. 阶段一·存活检测：快速探测 22/23/445/80/443（200ms 超时，128 IP/批并发），命中的设备**立即**推送 inspect-scan-alive 事件上屏（含反向解析名称）
  2. 阶段二·端口探测：仅对存活 IP 探测 22/23/3389/5900/21/80/443（500ms 超时，64 IP/批并发），逐台推送 inspect-scan-port 事件，端口结果实时刷新
- **前端**：结果表格改为行级流式填充——设备出现即显示（端口列显示 … 检测中），逐台刷新 ✓/✗；进度条区分"检测在线设备 / 探测服务端口"两阶段；开始按钮扫描中禁用
- **性能**：/24 段存活检测约 1-2 秒（旧版 7 端口全扫需十几秒），端口探测只针对在线设备
- **验证**：npm run build 通过、cargo check 通过

---

## 2026-09-08 · 网段发现 V4：端口全并行探测 + 结果区精简（去掉汇入巡检/厂商/添加）

- **速度根因**：阶段2 端口探测原先每台设备串行 7 端口（最多 7×500ms=3.5s/台），存活设备多时要排队 20s+，端口列长时间显示检测中
- **优化**：
  - 存活检测：每 IP 5 端口并行（200ms 超时），单 IP 最坏 200ms
  - 端口探测：每台 7 端口并行（300ms 超时），单台最坏 300ms，64 台/批
  - 结论：/24 段存活检测约 1s，端口探测按存活台数每台 0.3s 并行推进
- **界面精简**：结果不再汇入巡检设备清单——去掉勾选列、厂商列、操作（添加）列、添加勾选按钮；纯结果表格：IP | 名称 | SSH | RDP | VNC | FTP | Telnet | HTTP | HTTPS
- **验证**：npm run build 通过、cargo check 通过

---

## 2026-09-08 · 网段发现 V5：每 IP 一线程全并行，存活检测瞬间完成

- **真正根因**：此前"128 IP/批并发"实现是批内串行（254 个 IP 排队逐个探测 200ms ≈ 50 秒），从未真并行
- **修复**：
  - 每个 IP 一个线程全并行（≤512 台），254 台同时探测：存活检测一个超时周期（约 0.2s）内完成，设备几乎同时上屏
  - 存活设备每台一线程并行探测 7 端口（0.3s），通即 √
  - 超过 512 台按 256/批推进，防止线程爆炸
- **验证**：npm run build 通过、cargo check 通过

---

## 2026-09-08 · 网段发现 V6：自定义端口 + 单阶段全并行（准确性增强）

- **自定义端口**：输入框支持逗号分隔多个端口（如 8080,8443），表格新增"自定义"列逐端口显示 ✓/✗；后端并入探测列表（1-65535 校验去重）
- **准确性增强（重要）**：旧逻辑存活检测只看 5 端口（22/23/445/80/443），只开 3389/5900 等端口的设备会被漏掉；现改为**单阶段一次并行探测全部目标端口**（7 固定+自定义，200ms），有任一端口开放即判定在线——不再漏报
- **判定标准**：TCP connect 成功 = 三次握手完成 = 端口确实监听，通即 ✓（与 MobaXterm 同原理）
- **速度**：每 IP 一线程并行探测全部端口，单 IP 最坏一个超时周期，254 台约 0.2-0.5s
- **验证**：npm run build 通过、cargo check 通过

---

## 2026-09-08 · 网段发现 V7：ICMP ping 存活检测（对齐 MobaXterm，网络通即上屏）

- **对比差异根因**：MobaXterm 用 ICMP ping 判存活——网络通就显示（哪怕端口全 ✗）；此前我们以目标端口开放判存活，ping 通但没开目标端口的设备被漏掉（对比时少了 3 台）
- **修复**：每个 IP 一线程内并行执行——ICMP ping（Windows IcmpSendEcho 系统 API，普通权限，即 ping.exe 底层）300ms + TCP 并行探测全部目标端口 200ms；ping 通或有端口开放即上屏，端口全关设备也显示（全 ✗），与 MobaXterm 一致
- **验证**：npm run build 通过、cargo check 通过

---

## 2026-09-08 · 网段发现 V8：10 秒循环检测窗口

- **需求**：检测过程最长 10 秒——10 秒内循环探测，打通即停止该 IP；10 秒未通自动放弃，整体扫描最长 10 秒自动停止
- **实现**：每 IP 一线程，10 秒窗口内循环（每轮 ping 300ms + TCP 全端口 200ms 并行，轮间间隔 200ms，约 15-20 轮）；一轮内打通立即上屏；提高慢启动/偶发丢包设备的捕获率
- **UI**：描述文案标注"单次扫描最长 10 秒自动停止"
- **验证**：npm run build 通过、cargo check 通过

---

## 2026-09-08 · 网段发现 V8.1：修复 ICMP 假阳性（与 MobaXterm 对齐）

- **问题**：扫描结果多出大量 MobaXterm 不显示的 IP（对比 13 台 vs 3 台），系统 ping.exe 验证这些 IP 实为超时
- **根因（两个叠加 bug）**：
  1. IcmpSendEcho 对"Destination Unreachable"回复也返回 1，未检查 reply 的 Status 字段（须 == IP_SUCCESS(0)），不存在的 IP 被网关回包误判为在线
  2. DestinationAddress 字节序错误：IPAddr 为网络字节序，x86 小端须 from_le_bytes 使内存大端排列，from_be_bytes 导致探测到错误地址
- **修复**：检查 Status==0 + 修正字节序
- **验证（真实运行）**：
  - 用户网络对照测试：192.168.1.3/.5/.1 判在线、192.168.1.4/.20/.23/.24 判不在线，与系统 ping.exe 100% 一致
  - 保留回归测试（cargo test）：127.0.0.1 通、192.0.2.1 不通，2 passed
  - npm run build 通过

---

## 2026-09-08 · 网段发现 V9：进度条改为时间线性（修复进度卡住观感）

- **问题**：在线设备秒级完成（进度+5），249 台离线设备要等满 10 秒窗口才逐台结束，中间 8 秒进度条"卡在 5/254 不动"，观感像死机（扫描结果本身正确：5 台与 MobaXterm 一致）
- **修复**：进度条改为时间线性——扫描中每秒平滑推进（0→10 秒），文案显示"扫描中… x.xs/10s · 已发现 n 台"；设备仍实时上屏；10 秒后端自动停止
- **验证**：npm run build 通过

---

## 2026-09-08 · 小工具扩展（方向A）：端口扫描 + Ping + 子网计算器

- **小工具页重构**：InspectToolbox 改为「工具选择条 + 内容区」（网段发现/端口扫描/Ping 工具/子网计算器），为后续工具扩展铺路
- **端口扫描**：
  - 输入 IP/域名 + 端口（列表或范围如 1-1024,8080,8443），预设：常用端口/Web/1-1024/全端口
  - 后端 scan_ports_tool：DNS 解析 → 256 端口/批并行 TCP 探测（300ms 超时）→ 流式 port-scan-hit/progress
  - 表格：端口 | 服务名（20+ 常见服务映射）| 状态（✓开放/✗关闭），开放端口实时上屏
- **Ping 工具**：
  - 连续探测 1-100 次（默认 10），每次实时推送（seq/ok/rttMs），结束统计发送/接收/丢包率/平均/最小/最大延迟
  - 后端 ping_probe_tool：ping_host 改造为返回 RTT（读 IcmpEchoReply 偏移 8），网段发现调用处兼容
- **子网计算器**（纯前端）：CIDR 输入 → 网络地址/广播地址/子网掩码/掩码二进制/通配符掩码/可用主机数/可用 IP 范围
- **验证**：npm run build 通过；cargo test 2 passed（ICMP 回归不受影响）；i18n 中英文词条补充

---

## 2026-09-08 · 小工具迭代 V2：批量 Ping + 端口扫描精简 + 页头美化

- **端口扫描**：只显示开放的端口（不再显示关闭端口行），结果更清爽
- **Ping 工具 → 批量 Ping**（对标 PingInfoView）：
  - 主机列表输入：每行一个 IP/域名，支持范围（如 192.168.1.1-10），最多 128 台
  - 多主机并行探测（每主机一线程，独立 1-100 次），流式推送 ping-batch-row 实时更新主表
  - 主表汇总：IP | 主机名 | 成功次数 | 失败次数 | 丢包率 | 平均用时 | 最后状态；点击任意行选中 → 下方显示该主机逐次明细（时间/状态/往返时间/TTL）
  - 后端 ping_host_detailed：新增 TTL 读取（ICMP reply options 偏移 24）
- **页头美化**：小工具页标题加图标徽标，更精致
- **验证**：npm run build 通过；cargo test 2 passed

---

## 2026-09-08 · 小工具迭代 V3：界面铺满 + 切页不中断 + 事件缓冲防卡死

- **界面铺满**：移除小工具卡片 860px 限宽，内容区铺满整个工作区
- **切换不中断**：
  - 小工具内部页签：四个工具面板常驻渲染（display 控制显隐），切走再回来执行继续、结果保留
  - 主菜单切换：InspectToolbox / InspectWorkspace 改为 App 层常驻渲染，切到服务器/自动化等再回来，扫描/巡检状态不丢
- **事件缓冲防卡死**（端口扫描 + 批量 Ping）：
  - 后端并行探测事件可达数百条/秒（全端口 6 万+ 条），逐条 setState 会导致 UI 卡死
  - 前端改为事件入队 ref buffer → 200ms 批量合并一次 state 更新，明细仍近实时（200ms 粒度）
- **验证**：npm run build 通过；cargo test 2 passed

---

## 2026-09-08 · 小工具迭代 V4：三工具高度铺满 + 批量 Ping 持续监控（对标 PingInfoView）

- **高度铺满**：网段发现 / 端口扫描 / 批量 Ping 内容区高度撑满工作区到底，表格自动滚动
- **批量 Ping 持续监控**（对标 PingInfoView）：
  - 新增「持续监控」开关：开启后每 1 秒对所有主机探测一轮（每台 1 次），点击「停止」结束；关闭时保留原一次性 count 次模式
  - 主表字段补全：IP 地址 | 主机名 | 应答 IP | 成功次数 | 失败次数 | 连续失败 | 最大连续失败 | 失败百分比 | 最后状态 | 最后成功时间 | 最后失败时间 | 平均用时
  - 明细表补全：时间 | 应答 IP | 状态 | 往返时间 | TTL；每台最多保留最近 500 条防内存膨胀
  - 统计改为累计 rttSum/count，持续监控下无数组无限增长
- **验证**：npm run build 通过；cargo test 2 passed

---

## 2026-09-08 · 小工具迭代 V5：Ping 数据修复 + 高度自适应 + 端口扫描可停止

- **修复 Ping 数据不准确（NaN/undefined）**：后端事件字段为 rtt_ms，前端误读 rttMs 导致往返时间 undefined、平均用时 NaN；统一字段名后计数/RTT/平均用时准确
- **修复统计重复**：统计与明细一律以实时事件为准，invoke 返回仅补充主机名，杜绝每轮重复计数
- **平均用时显示**：无成功时显示 - 而非 -ms
- **高度自适应**：网段发现/端口扫描/批量 Ping 卡片高度按内容增长，无数据不撑高，最高封顶到界面底部（表格内部滚动）
- **端口扫描可停止**：后端新增 stop_port_scan 命令（原子取消标志），扫描中按钮变「停止」，点击立即中断
- **清除 Rust 编译警告**：移除 u16 类型恒真比较（p <= 65535）2 处
- **验证**：npm run build 通过（0 警告）；cargo check 通过（0 警告）；cargo test 2 passed
---

## 2026-09-08 · 小工具迭代 V6：卡片高度修正（有数据撑满到底、无数据保持矮）

- 上一版卡片 flex:0（高度=内容）导致有数据时下方仍留白
- 改为按数据量切换：有数据时卡片 flex:1 撑满工作区、表格区域填充剩余空间（行多内部滚动）；无数据时卡片保持内容高度（不撑高）
- 网段发现 / 端口扫描 / 批量 Ping 三处均生效
- 验证：npm run build 通过
---

## 2026-09-08 · 小工具迭代 V7：表格高度严格随内容（最终修正）

- 彻底移除撑满逻辑：卡片与表格区域高度 = 内容行数，无数据保持矮，行多时最高封顶界面底部、表格内部滚动
- 卡片封顶时仅表格区收缩滚动，头部/输入区不压缩
- 网段发现 / 端口扫描 / 批量 Ping 三处统一生效
- 验证：npm run build 通过
---

## 2026-09-08 · 批量 Ping 持续监控修正：严格每秒一轮 + 按钮文案

- 持续监控间隔从 2 秒修正为 1 秒：原实现是探测完成后再等 1s（不通主机探测需 1s → 2s 间隔）；改为以轮开始为基准固定 1s 周期，探测耗时从等待中扣除
- 停止按钮文案：去掉 /总数，显示「停止 + 累计 ping 次数」（成功+失败总和）
- 移除废弃 doneCount/hostTotal 状态
- 验证：npm run build 通过

---

## 2026-09-08 · 修复：自动化界面宽度收缩 + Ping 停止计数语义

- 自动化界面宽度缩小根因：inspect-workspace 用 CSS Grid grid-column:2 定位，上一轮为切页不丢状态包进常驻 div 后不再是 Grid 直接子项导致定位失效、宽度收缩；常驻 div 改为 flex-direction:column + 交叉轴拉伸恢复满宽
- Ping 停止按钮计数改为轮数（持续监控每 1 秒一轮 = 每秒 +1），与"每秒一次"语义一致；每台成功/失败次数仍由主表准确累计
- 验证：npm run build 通过

---

## 2026-09-08 · Ping 功能效率优化

- 后端 ping_batch_tool 新增 timeout_ms 参数（clamp 200-3000，默认前端传 500），单次探测超时从硬编码 1000ms 降至默认 500ms，不通主机探测时间减半
- 移除每次探测间的 300ms 固定间隔：一次性模式 count=10 由约 3s（通）/13s（不通）提速至约 0.1s（通）/5s（不通）
- 前端批量 Ping 新增「超时(ms)」输入框（默认 500，范围 200-3000），可自行调节
- tauriBridge mock 同步 timeoutMs；i18n 增加超时(ms) 键
- 验证：npm run build + cargo check + cargo test --lib icmp（2 passed）通过

---

## 2026-09-08 · 批量 Ping 输入区布局优化

- 右侧控件（次数/超时/持续监控/开始探测）收进 300px 带背景面板，视觉成组不再孤零零挤在右侧
- 次数与超时(ms) 并排两列 grid，持续监控与开始按钮通栏
- 验证：npm run build 通过

---

## 2026-09-08 · 发布 v1.0.2 正式版

- 版本号由 1.1.0-dev 调整为 1.0.2（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）
- 发布正式版安装包（NSIS exe）

---

## 2026-09-08 · 修复检查更新仍显示 1.0.1

- 根因：检查更新读取仓库 deploy/rainterminal/latest.json（raw.githubusercontent.com），该清单未随 v1.0.2 发布更新，仍指向 1.0.1
- 更新 latest.json：version 1.0.2、安装包 URL（v1.0.2 下载直链）、SHA-256 e5e1ff10…、size 5997814
- 验证：raw.githubusercontent 200 可访问，字段与 AppUpdateInstaller 校验逻辑（sha256 64 位 hex / https github.com / size 校验）一致

---

## 2026-09-08 · 修复 v1.0.2 安装包界面仍显示 1.1.0-dev（用户反馈属实）

- 根因：src/App.tsx 前端 APP_VERSION 为源码硬编码 '1.1.0-dev'，发布时仅改了 package.json / tauri.conf.json / Cargo.toml，漏改该常量，导致 1.0.2 安装包界面始终显示 1.1.0-dev
- 修复：APP_VERSION 改为 '1.0.2'，重新构建安装包（SHA-256 cd1a8344…，6,000,762 B）
- 同步：latest.json 更新新 SHA-256；GitHub Release v1.0.2 资产替换为新安装包；dist 验证无 dev 版本字符串

---

## 2026-09-08 · 阶段B：监控实时刷新（2 秒）

- 机器监控刷新间隔：远程 60s / 本地 20s → 2s
- 系统进程刷新间隔：远程 45s / 本地 15s → 2s
- 后端 remote_system_stats 缓存 TTL：10s → 2s（会话复用 + 缓存去重，同主机多窗口 2s 内只采集一次）
- 用户反馈 1s 过频，最终定为 2s
- 验证：npm run build + cargo check 通过

---

## 2026-09-08 · 监控折线图增强（更详细）

- 历史采样点 24 → 60（2 秒间隔 ≈ 2 分钟曲线）
- 折线图重写：
  - Catmull-Rom 平滑曲线（原直折线）
  - 纵轴刻度 0/25/50/75/100% 带标签
  - 当前值圆点 + 「当前 xx.x%」标注
  - 最高/最低点圆点与数值标注
  - 面积填充保留，底部显示采样次数
- 验证：npm run build 通过

---

## 2026-09-08 · 监控面板专业重设计（对标资源监控面板）

- 后端 LocalSystemStats 新增字段：swap_used/swap_total、cpu_cores、cpu_freq_mhz、tcp_connections/udp_connections
  - 远程 Linux：/proc/meminfo Swap、/proc/cpuinfo MHz、ss -tan/-uan 连接数
  - 本地 Windows：sysinfo swap/cores/frequency + netstat -ano 连接数
- 前端重设计（移除原 InfoRow 列表，新增概览卡片区）：
  - 4 资源卡（CPU/内存/交换空间/存储）：大数字 + 副信息 + 均值/峰值 + 迷你折线
  - 网络卡：↑上传/↓下载实时速率 + 网卡峰值/均值 + 已发送/已接收总量 + 蓝/青双线图
  - 连接数卡：TCP/UDP 套接字数 + 双线图
  - 保留顶部指标切换 + 大图（含当前值/最值/刻度）
- history 扩展：swap/networkUp/networkDown/tcp/udp 各 60 点
- 验证：npm build + cargo check + cargo test(2 passed)

---

## 2026-09-08 · 监控面板 v3 修复与美化（用户反馈）

- 修复网络速率显示 "undefined"：formatRate 将 MB 值当字节导致 index=-1，重写为 formatRateMB（B/KB/MB/GB/s 分级）
- 删除连接数卡（用户明确不需要）
- 大图重做：
  - readout 大数字移出图表，改为图表上方头部行（指标名+大数值+详情+近N分钟）
  - 图表纯曲线全幅展示，网格/标签/文字全部改用主题 CSS 变量（深色/浅色皮肤自适应）
  - 悬停交互：垂直虚线 + 圆点 + tooltip（该点数值 + 时间 HH:MM:SS，2 秒/点）
  - 底部时间轴：-2:00 → 现在
  - 面积渐变填充（linearGradient），曲线更精致
- 卡片背景主题化（var(--surface-1)）
- 验证：npm build 通过

---

## 2026-09-08 · 监控 v5：浅色主题适配 + 25 分钟历史 + 大图尺寸封顶

- 浅色外观白字不可见修复：监控卡片/图表全部硬编码 rgba(255,255,255) 文字改为主题 CSS 变量（--text-secondary/tertiary/disabled、--border-soft），深浅皮肤自适应
- 历史采样点 60 → 750（2 秒/点 × 25 分钟，用户要求）
- 大图尺寸封顶：svg 宽度 min(100%, 560px) 居中，宽屏下不再等比放大到 400px 高
- 验证：npm build 通过
