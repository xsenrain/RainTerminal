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
