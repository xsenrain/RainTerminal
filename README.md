<div align="center">
  <img src="public/rain-terminal-icon.svg" width="104" alt="RainTerminal 图标" />
  <h1>RainTerminal</h1>
  <p><strong>一站式 Windows 服务器与网络设备工作台</strong></p>
  <p>把 SSH 终端、SFTP 文件管理、系统监控、进程查看、原生远程桌面与网络设备命令模板，放进一套可持久化的多工作区。</p>
  <p>
    <a href="https://github.com/xsenrain/RainTerminal/releases"><img src="https://img.shields.io/github/v/release/xsenrain/RainTerminal?include_prereleases&style=flat-square&label=Release" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/xsenrain/RainTerminal?style=flat-square" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=flat-square&logo=windows11&logoColor=white" alt="Windows 10 / 11" />
  </p>
  <p>
    <a href="https://github.com/xsenrain/RainTerminal/releases/tag/v1.0.0"><strong>下载正式版</strong></a>
    · <a href="#功能概览">功能概览</a>
    · <a href="#开发与构建">本地开发</a>
    · <a href="https://github.com/xsenrain/RainTerminal/issues">问题反馈</a>
  </p>
  <p><strong>简体中文</strong> · <a href="README_EN.md">English</a></p>
</div>

<br />

## 功能概览

RainTerminal 面向需要频繁管理多台 Windows / Linux 服务器及网络设备的开发者和运维人员。常用能力集中在同一窗口，连接配置、窗口布局与外观偏好可以持续保留。

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>终端与连接</strong><br /><br />
      本地终端与 SSH 终端；支持密码、私钥和 SSH Agent，并可从连接文本或 <code>~/.ssh/config</code> 导入配置。
    </td>
    <td width="50%" valign="top">
      <strong>文件与传输</strong><br /><br />
      SFTP 目录浏览、文本编辑、拖放上传、下载进度与统一传输管理；上传和下载任务集中可见。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>监控与进程</strong><br /><br />
      在工作区查看 CPU、内存、磁盘、网络与系统进程，无需在终端和独立监控工具之间反复切换。
    </td>
    <td width="50%" valign="top">
      <strong>远程桌面与工作区</strong><br /><br />
      原生 RDP、动态分辨率、剪贴板文本和文件传输；多工作区支持面板拖动、缩放、排列与恢复。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>网络设备命令模板</strong><br /><br />
      内置华为、华三、锐捷、中兴等主流网络设备查询命令；支持自定义分类分组、搜索过滤、右键移动与动态分类管理。
    </td>
    <td width="50%" valign="top">
      <strong>凭据与连接安全</strong><br /><br />
      密钥信息存储于 Windows 凭据管理器；SSH 主机密钥变更会阻止连接，并通过确认流程安全更新。
    </td>
  </tr>
</table>

## 下载并开始使用

> **当前版本：[`v1.0.0` 正式版](https://github.com/xsenrain/RainTerminal/releases/tag/v1.0.0)**

| 文件 | 用途 |
| --- | --- |
| [`RainTerminal_1.0.0_x64-setup.exe`](https://github.com/xsenrain/RainTerminal/releases/download/v1.0.0/RainTerminal_1.0.0_x64-setup.exe) | 推荐，大多数用户选择此 NSIS 安装包 |
| [`SHA256SUMS.txt`](https://github.com/xsenrain/RainTerminal/releases/download/v1.0.0/SHA256SUMS.txt) | 校验安装包完整性 |

> [!WARNING]
> 当前安装包尚未进行 Authenticode 签名，Windows SmartScreen 可能显示安全提示。测试前请备份重要连接配置，并从本仓库 Releases 下载文件。

使用 PowerShell 校验安装包：

```powershell
Get-FileHash .\RainTerminal_1.0.0_x64-setup.exe -Algorithm SHA256
```

将输出与 `SHA256SUMS.txt` 中对应文件的哈希值进行比较。

## 支持平台

| 平台 | 当前状态 |
| --- | --- |
| **Windows 10 / 11 x64** | 已支持，提供 NSIS EXE 安装包 |
| iOS / iPadOS | 规划中，当前版本不可用 |
| macOS / Linux / Android | 尚未提供正式构建 |

RainTerminal 当前包含 Windows Credential Manager、ConPTY、本地进程管理和原生 RDP 剪贴板等桌面能力。移动端需要单独完成交互、原生能力和签名适配，不能只通过切换 CI runner 生成。

## 安全设计

- SSH 与 RDP 密钥信息存储在 Windows 凭据管理器中。
- 浏览器存储、工作区快照和导出的服务器 JSON 不包含密码。
- 旧版明文浏览器凭据会先迁移，再删除明文副本。
- SSH 辅助连接遵循用户的 OpenSSH `known_hosts`；首次连接可接受新密钥，密钥不匹配时会阻止连接并要求确认。
- 诊断内容会尽量移除凭据、服务器地址和本地路径。

漏洞报告与当前支持策略请查看 [`SECURITY.md`](SECURITY.md)。

## 开发与构建

<details>
  <summary><strong>展开开发环境、验证与打包命令</strong></summary>

### 环境要求

- Windows 10 或 Windows 11
- Node.js 24+
- Rust 1.89+
- Microsoft WebView2 Runtime
- Windows OpenSSH Client

### 运行

```powershell
npm ci
npm run desktop:dev
```

### 验证

```powershell
npm run lint
npm run build
npm run test:native
npx playwright install chromium
npm run test:sandbox
```

### 打包

```powershell
npm run desktop:build
```

Tauri 原生构建产物位于 `src-tauri/target/release/bundle/`。

</details>

<details>
  <summary><strong>查看项目结构</strong></summary>

- `src/`：React 界面、工作区、xterm 渲染器、持久化和沙箱桥接。
- `Skin/`：自动发现的纯数据主题与 JSON Schema；自制主题请查看 [`Skin/README.md`](Skin/README.md)。
- `src-tauri/src/`：本地终端、SSH/SFTP、系统监控、凭据存储和 RDP 命令。
- `src-tauri/vendor/`：项目内维护的 IronRDP 剪贴板适配。
- `tools/`：Playwright 沙箱回归与性能辅助脚本。
- `docs/`：架构与功能专项文档。
- `docs/UPDATES.md`：更新清单格式和官方发布链接规则。

</details>

## 参与贡献

提交 Pull Request 前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。Issue、日志和截图中请勿包含密码、私钥、访问令牌或未经脱敏的服务器信息。

## 开源许可

RainTerminal 基于 [MIT License](LICENSE) 开源。基于 [XunDuTerminal](https://github.com/KaiGe7384/XunDuTerminal) 二次开发。第三方组件保留各自许可，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

<p align="center"><sub>为更顺手、更透明的服务器与网络设备管理体验而构建。</sub></p>
