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
