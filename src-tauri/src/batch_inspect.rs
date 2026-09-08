//! 批量巡检：非交互式 SSH 命令执行引擎。
//!
//! 独立于现有交互式终端（ssh_connect / SshWorkerCommand），
//! 通过 ssh2 的 channel.exec 在每台设备上依次执行命令并收集输出。
//! 支持 Linux（EOF 判定）与网络设备（静默期判定 + 分页翻页）。

use crate::connect_interactive_ssh_session;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 读取静默期：网络设备 exec 通道不会 EOF，连续多久无数据视为命令输出结束。
const READ_QUIET_PERIOD_MS: u64 = 800;
/// 打开通道 / 执行命令的 API 超时（慢速设备或虚拟机上通道打开可能超过 800ms）。
const EXEC_API_TIMEOUT_MS: u64 = 10_000;
/// 单条命令最大输出字节数，超出截断防止内存膨胀。
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectDeviceInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// 厂商类型：linux / huawei / h3c / ruijie / zte / other（预留，后续按厂商优化命令处理）
    #[allow(dead_code)]
    pub vendor: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectCommandInput {
    pub name: String,
    pub command: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InspectCommandOutput {
    pub command: String,
    pub output: String,
    pub success: bool,
    /// 健康等级：ok / warn / critical
    pub health: String,
    /// 命中的故障原因（已翻译为中文描述）
    pub issues: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InspectExecResult {
    pub device_name: String,
    pub host: String,
    pub success: bool,
    pub error: Option<String>,
    pub outputs: Vec<InspectCommandOutput>,
    pub duration_ms: u64,
    /// 设备整体健康等级：ok / warn / critical（取全部命令最差）
    pub health: String,
    /// 本次巡检生成的 Xshell 式流水日志文件路径（连接后到执行完的完整记录）
    pub log_path: Option<String>,
}

/// 单台设备完成时通过 `inspect-progress` 事件推送。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InspectProgress {
    current: usize,
    total: usize,
    device_name: String,
}

/// 批量在设备上并发执行命令。
/// - `concurrency`：并发设备数（1-10，自动收敛）
/// - 每完成一台设备推送 `inspect-progress` 事件
/// - 单设备失败自动重试一次
#[tauri::command]
pub async fn batch_execute_inspect(
    app: AppHandle,
    devices: Vec<InspectDeviceInput>,
    commands: Vec<InspectCommandInput>,
    concurrency: u32,
) -> Result<Vec<InspectExecResult>, String> {
    let total = devices.len();
    if total == 0 {
        return Ok(Vec::new());
    }
    let log_dir = resolve_inspect_log_dir(&app);
    let _ = fs::create_dir_all(&log_dir);
    ensure_rules_loaded(&app);
    let workers = (concurrency.clamp(1, 200) as usize).min(total);

    // 将阻塞的 SSH 连接/执行工作移出 IPC 线程，避免设备连接超时期间阻塞主界面交互。
    tauri::async_runtime::spawn_blocking(move || {
        let results: Mutex<Vec<Option<InspectExecResult>>> = Mutex::new(vec![None; total]);
        let next_index = AtomicUsize::new(0);
        let done_count = AtomicUsize::new(0);
        let worker_apps: Vec<AppHandle> = (0..workers).map(|_| app.clone()).collect();
        let worker_log_dirs: Vec<PathBuf> = (0..workers).map(|_| log_dir.clone()).collect();

        thread::scope(|scope| {
            for (worker_app, worker_log_dir) in worker_apps.iter().zip(worker_log_dirs.iter()) {
                scope.spawn(|| loop {
                    let index = next_index.fetch_add(1, Ordering::SeqCst);
                    if index >= total {
                        break;
                    }
                    let device = &devices[index];
                    let started = Instant::now();
                    let (result, log_path) =
                        execute_device_with_retry(device, &commands, worker_log_dir);
                    let result = match result {
                        Ok(outputs) => {
                            let health = aggregate_health(&outputs);
                            InspectExecResult {
                                device_name: device.name.clone(),
                                host: device.host.clone(),
                                success: true,
                                error: None,
                                outputs,
                                duration_ms: started.elapsed().as_millis() as u64,
                                health,
                                log_path,
                            }
                        }
                        Err(error) => InspectExecResult {
                            device_name: device.name.clone(),
                            host: device.host.clone(),
                            success: false,
                            error: Some(error),
                            outputs: Vec::new(),
                            duration_ms: started.elapsed().as_millis() as u64,
                            health: "critical".to_string(),
                            log_path,
                        },
                    };
                    results.lock().unwrap()[index] = Some(result);
                    let done = done_count.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = worker_app.emit(
                        "inspect-progress",
                        InspectProgress {
                            current: done,
                            total,
                            device_name: device.name.clone(),
                        },
                    );
                });
            }
        });

        results
            .into_inner()
            .unwrap()
            .into_iter()
            .map(|result| result.unwrap())
            .collect()
    })
    .await
    .map_err(|error| format!("巡检执行线程调度失败: {error}"))
}

/// 连接失败时自动重试一次（网络抖动 / 首连慢的常见场景），两次共用同一日志文件。
/// 返回（执行结果, 日志文件路径）。
fn execute_device_with_retry(
    device: &InspectDeviceInput,
    commands: &[InspectCommandInput],
    log_dir: &Path,
) -> (Result<Vec<InspectCommandOutput>, String>, Option<String>) {
    let file_path = inspect_log_file_path(log_dir, device);
    let mut log: Vec<String> = Vec::new();
    log.push("================================================================".to_string());
    log.push(format!(
        "设备: {} | 地址: {}:{} | 厂商: {}",
        device.name, device.host, device.port, device.vendor
    ));
    log.push(format!("开始: {}", Local::now().format("%Y-%m-%d %H:%M:%S")));
    log.push("----------------------------------------------------------------".to_string());

    let first = execute_device(device, commands, &mut log);
    // 连接阶段失败（TCP 超时/握手失败/解析失败）说明目标当前不可达，重试只会再等一轮超时，
    // 因此仅在“已连接但执行失败”（会话抖动/命令异常）时重试一次。
    let is_connect_failure = matches!(
        &first,
        Err(error)
            if error.contains("TCP connect failed")
                || error.contains("SSH handshake failed")
                || error.contains("resolve SSH host")
    );
    if first.is_err() && !is_connect_failure {
        log.push(format!("[{}] 首次执行失败，自动重试一次", now_time()));
        log.push("----------------------------------------------------------------".to_string());
    }
    let result = if first.is_err() && !is_connect_failure {
        execute_device(device, commands, &mut log)
    } else {
        first
    };

    match &result {
        Ok(outputs) => {
            let health = aggregate_health(outputs);
            log.push("----------------------------------------------------------------".to_string());
            log.push(format!(
                "[{}] 巡检结束: 共执行 {} 条命令, 健康等级: {}",
                now_time(),
                outputs.len(),
                health_label(&health)
            ));
        }
        Err(error) => {
            log.push("----------------------------------------------------------------".to_string());
            log.push(format!("[{}] 巡检失败: {}", now_time(), error));
        }
    }
    log.push("================================================================".to_string());
    let _ = fs::create_dir_all(log_dir);
    let written = fs::write(&file_path, log.join("\n"))
        .map(|_| file_path.display().to_string())
        .ok();
    (result, written)
}

/// 设备健康 = 全部命令中最差等级。
fn aggregate_health(outputs: &[InspectCommandOutput]) -> String {
    let mut health = "ok";
    for output in outputs {
        match output.health.as_str() {
            "critical" => return "critical".to_string(),
            "warn" => health = "warn",
            _ => {}
        }
    }
    health.to_string()
}

/// 执行单台设备：连接 → 顺序执行命令 → 记录到日志流水。返回结果，日志由调用方落盘。
fn execute_device(
    device: &InspectDeviceInput,
    commands: &[InspectCommandInput],
    log: &mut Vec<String>,
) -> Result<Vec<InspectCommandOutput>, String> {
    let mut session = match connect_interactive_ssh_session(
        &device.host,
        &device.username,
        &device.password,
        device.port,
    ) {
        Ok(session) => {
            log.push(format!("[{}] SSH 连接成功 ({})", now_time(), device.host));
            session
        }
        Err(error) => {
            log.push(format!("[{}] SSH 连接失败: {}", now_time(), error));
            return Err(error);
        }
    };

    let mut outputs = Vec::with_capacity(commands.len());
    for command in commands {
        log.push(format!(
            "[{}] >>> 执行命令: {}",
            now_time(),
            strip_ansi(&command.command)
        ));
        let output = execute_one_command(
            &mut session,
            &device.vendor,
            &command.name,
            &command.command,
        );
        let clean_output = strip_ansi(&output.output);
        if !clean_output.trim().is_empty() {
            log.push(clean_output);
        }
        let issue_text = if output.issues.is_empty() {
            "-".to_string()
        } else {
            output.issues.join("; ")
        };
        log.push(format!(
            "[{}] 判断: {} | 依据: {}",
            now_time(),
            health_label(&output.health),
            issue_text
        ));
        log.push("----------------------------------------------------------------".to_string());
        outputs.push(output);
    }
    Ok(outputs)
}

fn health_label(health: &str) -> &'static str {
    match health {
        "critical" => "严重",
        "warn" => "警告",
        _ => "正常",
    }
}

/// 本地时间 [HH:MM:SS]。
fn now_time() -> String {
    Local::now().format("%H:%M:%S").to_string()
}

/// 日志文件名：IP_设备名_YYYYMMDD_HHMMSS.log（IP 与设备名清洗非法字符）。
fn inspect_log_file_path(log_dir: &Path, device: &InspectDeviceInput) -> PathBuf {
    let safe_host: String = device
        .host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe_host = if safe_host.trim().is_empty() {
        "unknown".to_string()
    } else {
        safe_host
    };
    let safe_name: String = device
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe_name = if safe_name.trim().is_empty() {
        "device".to_string()
    } else {
        safe_name
    };
    log_dir.join(format!(
        "{}_{}_{}.log",
        safe_host,
        safe_name,
        Local::now().format("%Y%m%d_%H%M%S")
    ))
}

/// 去除 ANSI 转义序列（颜色码等），保持日志纯净。
fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            // 跳过 ESC [ ... 字母 或 ESC ] ... BEL 序列
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            } else if chars.peek() == Some(&']') {
                chars.next();
                for next in chars.by_ref() {
                    if next == '\u{07}' {
                        break;
                    }
                }
            }
        } else {
            output.push(ch);
        }
    }
    output
}

fn execute_one_command(
    session: &mut ssh2::Session,
    vendor: &str,
    command_name: &str,
    command: &str,
) -> InspectCommandOutput {
    let mut output = String::new();

    // 打开通道与执行命令使用长 API 超时（慢速设备/虚拟机可能超过静默期）。
    session.set_timeout(EXEC_API_TIMEOUT_MS as u32);
    let channel_result = session.channel_session();
    let mut channel = match channel_result {
        Ok(channel) => channel,
        Err(error) => {
            return InspectCommandOutput {
                command: command_name.to_string(),
                output: String::new(),
                success: false,
                health: "critical".to_string(),
                issues: vec!["SSH 通道打开失败".to_string()],
            }
            .note_error(&format!("SSH channel open failed: {error}"))
        }
    };

    if let Err(error) = channel.exec(command) {
        return InspectCommandOutput {
            command: command_name.to_string(),
            output: String::new(),
            success: false,
            health: "critical".to_string(),
            issues: vec!["命令执行失败".to_string()],
        }
        .note_error(&format!("Command exec failed: {error}"));
    }

    // 命令已开始执行，把 API 超时缩短为静默期，用于网络设备输出结束判定。
    session.set_timeout(READ_QUIET_PERIOD_MS as u32);

    let mut buffer = [0u8; 8192];
    loop {
        match channel.read(&mut buffer) {
            Ok(0) => break, // EOF（Linux 命令执行结束）
            Ok(read) => {
                let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                output.push_str(&text);
                // 网络设备分页：检测到分页标记时发送空格翻页
                if text.contains("---- More ----") || text.contains("--More--") {
                    let _ = channel.write(b" ");
                }
                if output.len() > MAX_OUTPUT_BYTES {
                    break;
                }
            }
            // 静默期超时 / WouldBlock：网络设备输出结束
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut
                    || error.kind() == std::io::ErrorKind::Interrupted =>
            {
                break;
            }
            Err(_) => break,
        }
    }

    let _ = channel.send_eof();
    let _ = channel.wait_close();
    let exit_status = channel.exit_status().unwrap_or(-1);

    let has_error_marker = output_contains_error_marker(&output);
    let success = (exit_status == 0 || exit_status < 0) && !has_error_marker;
    let trimmed = output.trim_end().to_string();

    if !success {
        return InspectCommandOutput {
            command: command_name.to_string(),
            output: trimmed,
            success,
            health: "critical".to_string(),
            issues: vec!["命令执行失败或返回错误".to_string()],
        };
    }

    let (health, issues) = assess_output(vendor, command, &trimmed);
    InspectCommandOutput {
        command: command_name.to_string(),
        output: trimmed,
        success,
        health,
        issues,
    }
}

/* ============ 故障判断规则引擎 ============ */

struct InspectRule {
    vendor: &'static str,
    command_contains: &'static str,
    severity: &'static str,           // "warn" | "critical"
    keyword: Option<&'static str>,    // 输出包含该关键字 → 命中
    missing_keyword: Option<&'static str>, // 输出不包含该关键字 → 命中
    threshold: Option<f64>,           // 数值阈值 → 命中
    percent: bool,                    // true=只取"NN%"格式的最大值；false=取输出中最大数值（含小数）
    label: &'static str,              // 命中原因（中文）
}

/// 可持久化规则（JSON 配置驱动，P2 可自定义）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InspectRuleConfig {
    pub id: String,
    pub vendor: String,
    pub command_contains: String,
    /// 健康等级：warn / critical
    pub severity: String,
    /// 判断类型：keyword（包含关键词）/ missing（缺少关键词）/ threshold（数值阈值）
    #[serde(rename = "type")]
    pub rule_type: String,
    pub keyword: Option<String>,
    pub missing_keyword: Option<String>,
    pub threshold: Option<f64>,
    /// 阈值规则是否按"NN%"百分比取值（使用率类规则避免误取容量数字）
    pub percent: bool,
    pub label: String,
    pub enabled: bool,
}

impl InspectRuleConfig {
    fn from_builtin(index: usize, rule: &InspectRule) -> Self {
        let rule_type = if rule.keyword.is_some() {
            "keyword"
        } else if rule.missing_keyword.is_some() {
            "missing"
        } else {
            "threshold"
        };
        InspectRuleConfig {
            id: format!("builtin-{index}"),
            vendor: rule.vendor.to_string(),
            command_contains: rule.command_contains.to_string(),
            severity: rule.severity.to_string(),
            rule_type: rule_type.to_string(),
            keyword: rule.keyword.map(|v| v.to_string()),
            missing_keyword: rule.missing_keyword.map(|v| v.to_string()),
            threshold: rule.threshold,
            percent: rule.percent,
            label: rule.label.to_string(),
            enabled: true,
        }
    }
}

/// 预设规则库：按厂商 + 命令内容子串匹配。
const DEFAULT_INSPECT_RULES: &[InspectRule] = &[
    // ---- Linux ----
    InspectRule { vendor: "linux", command_contains: "df", severity: "critical", keyword: Some("100%"), missing_keyword: None, threshold: None, percent: false, label: "磁盘使用率已达 100%" },
    InspectRule { vendor: "linux", command_contains: "df", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "磁盘使用率 ≥ 90%" },
    InspectRule { vendor: "linux", command_contains: "load", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(4.0), percent: false, label: "系统负载 ≥ 4" },
    InspectRule { vendor: "linux", command_contains: "load", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(8.0), percent: false, label: "系统负载 ≥ 8" },
    InspectRule { vendor: "linux", command_contains: "ping", severity: "critical", keyword: Some("100% packet loss"), missing_keyword: None, threshold: None, percent: false, label: "ping 丢包率 100%" },
    InspectRule { vendor: "linux", command_contains: "systemctl", severity: "warn", keyword: Some("failed"), missing_keyword: None, threshold: None, percent: false, label: "存在 failed 状态的系统单元" },
    InspectRule { vendor: "linux", command_contains: "journalctl", severity: "warn", keyword: Some("error"), missing_keyword: None, threshold: None, percent: false, label: "日志中存在 error" },
    // ---- 华为 ----
    InspectRule { vendor: "huawei", command_contains: "display device", severity: "critical", keyword: Some("abnormal"), missing_keyword: None, threshold: None, percent: false, label: "板卡存在 Abnormal 状态" },
    InspectRule { vendor: "huawei", command_contains: "display device", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, percent: false, label: "板卡存在 Fault 状态" },
    InspectRule { vendor: "huawei", command_contains: "display alarm", severity: "warn", keyword: Some("alarm"), missing_keyword: None, threshold: None, percent: false, label: "存在活动告警" },
    InspectRule { vendor: "huawei", command_contains: "display interface brief", severity: "warn", keyword: Some("down"), missing_keyword: None, threshold: None, percent: false, label: "存在 DOWN 接口" },
    InspectRule { vendor: "huawei", command_contains: "display cpu", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70.0), percent: true, label: "CPU 使用率 ≥ 70%" },
    InspectRule { vendor: "huawei", command_contains: "display cpu", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "CPU 使用率 ≥ 90%" },
    InspectRule { vendor: "huawei", command_contains: "display memory", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "内存使用率 ≥ 90%" },
    InspectRule { vendor: "huawei", command_contains: "display temperature", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70.0), percent: false, label: "温度 ≥ 70℃" },
    InspectRule { vendor: "huawei", command_contains: "display health", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, percent: false, label: "健康检查存在 Fault" },
    // ---- 华三 ----
    InspectRule { vendor: "h3c", command_contains: "display device", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, percent: false, label: "板卡存在 Fault 状态" },
    InspectRule { vendor: "h3c", command_contains: "display alarm", severity: "warn", keyword: Some("alarm"), missing_keyword: None, threshold: None, percent: false, label: "存在活动告警" },
    InspectRule { vendor: "h3c", command_contains: "display interface brief", severity: "warn", keyword: Some("down"), missing_keyword: None, threshold: None, percent: false, label: "存在 DOWN 接口" },
    InspectRule { vendor: "h3c", command_contains: "display cpu", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70.0), percent: true, label: "CPU 使用率 ≥ 70%" },
    InspectRule { vendor: "h3c", command_contains: "display cpu", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "CPU 使用率 ≥ 90%" },
    InspectRule { vendor: "h3c", command_contains: "display memory", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "内存使用率 ≥ 90%" },
    InspectRule { vendor: "h3c", command_contains: "display environment", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, percent: false, label: "环境监控存在 Fault" },
    // ---- 锐捷 ----
    InspectRule { vendor: "ruijie", command_contains: "show device", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, percent: false, label: "板卡存在 Fault 状态" },
    InspectRule { vendor: "ruijie", command_contains: "show alarm", severity: "warn", keyword: Some("alarm"), missing_keyword: None, threshold: None, percent: false, label: "存在活动告警" },
    InspectRule { vendor: "ruijie", command_contains: "show interface", severity: "warn", keyword: Some("down"), missing_keyword: None, threshold: None, percent: false, label: "存在 DOWN 接口" },
    InspectRule { vendor: "ruijie", command_contains: "show cpu", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70.0), percent: true, label: "CPU 使用率 ≥ 70%" },
    InspectRule { vendor: "ruijie", command_contains: "show cpu", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "CPU 使用率 ≥ 90%" },
    InspectRule { vendor: "ruijie", command_contains: "show memory", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "内存使用率 ≥ 90%" },
    InspectRule { vendor: "ruijie", command_contains: "show environment", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, percent: false, label: "环境监控存在 Fault" },
    // ---- 中兴 ----
    InspectRule { vendor: "zte", command_contains: "show environment", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, percent: false, label: "环境监控存在 Fault" },
    InspectRule { vendor: "zte", command_contains: "show interface", severity: "warn", keyword: Some("down"), missing_keyword: None, threshold: None, percent: false, label: "存在 DOWN 接口" },
    InspectRule { vendor: "zte", command_contains: "show cpu", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70.0), percent: true, label: "CPU 使用率 ≥ 70%" },
    InspectRule { vendor: "zte", command_contains: "show cpu", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "CPU 使用率 ≥ 90%" },
    InspectRule { vendor: "zte", command_contains: "show memory", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90.0), percent: true, label: "内存使用率 ≥ 90%" },
];

/// 对单个命令输出执行故障判断，返回（健康等级, 命中原因列表）。
/// 规则来自全局缓存（batch_execute_inspect 启动时已加载配置文件）。
fn assess_output(vendor: &str, command: &str, output: &str) -> (String, Vec<String>) {
    let command_lower = command.to_ascii_lowercase();
    let output_lower = output.to_ascii_lowercase();
    let mut hits: Vec<(&str, String)> = Vec::new();

    let rules = RULES_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(rule_list) = rules.as_deref() else {
        return ("ok".to_string(), Vec::new());
    };
    for rule in rule_list.iter() {
        if !rule.enabled {
            continue;
        }
        if rule.vendor != vendor {
            continue;
        }
        if !command_lower.contains(&rule.command_contains.to_ascii_lowercase()) {
            continue;
        }
        let hit = match rule.rule_type.as_str() {
            "keyword" => rule
                .keyword
                .as_deref()
                .map(|keyword| output_lower.contains(&keyword.to_ascii_lowercase()))
                .unwrap_or(false),
            "missing" => rule
                .missing_keyword
                .as_deref()
                .map(|keyword| !output_lower.contains(&keyword.to_ascii_lowercase()))
                .unwrap_or(false),
            "threshold" => rule.threshold.map(|threshold| {
                let value = if rule.percent {
                    max_percent(output)
                } else {
                    max_number(output)
                };
                value >= threshold
            }).unwrap_or(false),
            _ => false,
        };
        if hit {
            hits.push((&rule.severity, rule.label.clone()));
        }
    }

    let mut health = "ok";
    for (severity, _) in &hits {
        match *severity {
            "critical" => {
                health = "critical";
                break;
            }
            "warn" => health = "warn",
            _ => {}
        }
    }
    let issues = hits.into_iter().map(|(_, label)| label).collect();
    (health.to_string(), issues)
}

/* ============ 规则配置存储（P2 自定义） ============ */

const INSPECT_RULES_FILE: &str = "inspect_rules.json";

/// 规则全局缓存：巡检启动时加载一次，保存规则时同步更新。
static RULES_CACHE: Mutex<Option<Vec<InspectRuleConfig>>> = Mutex::new(None);

fn inspect_rules_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(INSPECT_RULES_FILE)
}

/// 生成内置默认规则（硬编码表 → 配置格式）。
fn default_inspect_rules() -> Vec<InspectRuleConfig> {
    DEFAULT_INSPECT_RULES
        .iter()
        .enumerate()
        .map(|(index, rule)| InspectRuleConfig::from_builtin(index, rule))
        .collect()
}

/// 加载规则：优先读取配置文件；不存在则写入内置默认规则。
fn load_inspect_rules(app: &AppHandle) -> Vec<InspectRuleConfig> {
    let path = inspect_rules_path(app);
    let loaded = fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<Vec<InspectRuleConfig>>(&content).ok());
    let rules = loaded.unwrap_or_else(|| {
        let defaults = default_inspect_rules();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(content) = serde_json::to_string_pretty(&defaults) {
            let _ = fs::write(&path, content);
        }
        defaults
    });
    if let Ok(mut cache) = RULES_CACHE.lock() {
        *cache = Some(rules.clone());
    }
    rules
}

/// 获取全部故障判断规则。
#[tauri::command]
pub fn get_inspect_rules(app: AppHandle) -> Result<Vec<InspectRuleConfig>, String> {
    Ok(load_inspect_rules(&app))
}

/// 保存故障判断规则（覆盖全量并立即生效）。
#[tauri::command]
pub fn save_inspect_rules(app: AppHandle, rules: Vec<InspectRuleConfig>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for rule in &rules {
        if rule.vendor.trim().is_empty() {
            return Err("规则厂商不能为空".into());
        }
        if !matches!(rule.severity.as_str(), "warn" | "critical") {
            return Err("规则等级只能是 warn 或 critical".into());
        }
        if rule.label.trim().is_empty() {
            return Err("规则说明不能为空".into());
        }
        if rule.command_contains.trim().is_empty() && rule.rule_type != "keyword" {
            return Err("规则的匹配命令不能为空".into());
        }
        if !seen.insert(rule.id.clone()) {
            return Err(format!("规则 ID 重复: {}", rule.id));
        }
    }
    let path = inspect_rules_path(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建规则目录失败: {e}"))?;
    }
    let content = serde_json::to_string_pretty(&rules).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("保存规则失败: {e}"))?;
    if let Ok(mut cache) = RULES_CACHE.lock() {
        *cache = Some(rules);
    }
    Ok(())
}

/// 巡检启动时确保规则缓存已加载。
fn ensure_rules_loaded(app: &AppHandle) {
    if RULES_CACHE.lock().map(|c| c.is_none()).unwrap_or(true) {
        let _ = load_inspect_rules(app);
    }
}

/// 提取输出中"NN% / NN.N%"格式的最大值（用于使用率类规则，避免把容量数字误当百分比）。
fn max_percent(output: &str) -> f64 {
    let bytes = output.as_bytes();
    let mut max = 0.0f64;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'%' {
                if let Ok(value) = output[start..i].parse::<f64>() {
                    if value > max {
                        max = value;
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    max
}

/// 提取输出中最大的数值（支持小数，用于负载/温度等非百分比规则）。
fn max_number(output: &str) -> f64 {
    let bytes = output.as_bytes();
    let mut max = 0.0f64;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            if let Ok(value) = output[start..i].parse::<f64>() {
                if value > max {
                    max = value;
                }
            }
        } else {
            i += 1;
        }
    }
    max
}

/// 输出中常见的命令错误标记（网络设备与 Linux 通用）。
fn output_contains_error_marker(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("% unrecognized command")
        || lower.contains("% unknown command")
        || lower.contains("% ambiguous command")
        || lower.contains("% incomplete command")
        || lower.contains("command not found")
        || lower.contains("no such file or directory")
        || lower.contains("permission denied")
}

trait NoteError {
    fn note_error(self, error: &str) -> Self;
}

impl NoteError for InspectCommandOutput {
    fn note_error(mut self, error: &str) -> Self {
        self.output = if self.output.trim().is_empty() {
            error.to_string()
        } else {
            format!("{}\n{}", self.output.trim_end(), error)
        };
        self
    }
}

/* ============ 巡检日志目录配置 ============ */

const INSPECT_CONFIG_FILE: &str = "inspect_config.json";

fn inspect_config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(INSPECT_CONFIG_FILE)
}

/// 解析巡检日志目录：优先使用用户自定义路径（持久化于 inspect_config.json），
/// 否则默认使用软件运行目录（exe 所在目录）。
fn resolve_inspect_log_dir(app: &AppHandle) -> PathBuf {
    if let Ok(content) = fs::read_to_string(inspect_config_path(app)) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(dir) = config.get("log_dir").and_then(|v| v.as_str()) {
                let trimmed = dir.trim();
                if !trimmed.is_empty() {
                    return PathBuf::from(trimmed);
                }
            }
        }
    }
    app.path()
        .executable_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 获取当前巡检日志保存路径。
#[tauri::command]
pub fn get_inspect_log_dir(app: AppHandle) -> Result<String, String> {
    Ok(resolve_inspect_log_dir(&app).display().to_string())
}

/// 设置巡检日志保存路径（要求目录已存在，不存在则拒绝写入配置）。
#[tauri::command]
pub fn set_inspect_log_dir(app: AppHandle, path: String) -> Result<String, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("日志保存路径不能为空".to_string());
    }
    let dir = PathBuf::from(&trimmed);
    let metadata = fs::metadata(&dir).map_err(|error| format!("目录不存在或无法访问: {error}"))?;
    if !metadata.is_dir() {
        return Err("指定路径不是目录".to_string());
    }
    let config = serde_json::json!({ "log_dir": dir.display().to_string() });
    let config_path = inspect_config_path(&app);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    }
    fs::write(config_path, serde_json::to_string_pretty(&config).unwrap_or_default())
        .map_err(|error| format!("保存日志配置失败: {error}"))?;
    Ok(dir.display().to_string())
}

/// 在资源管理器中打开当前巡检日志目录。
#[tauri::command]
pub fn open_inspect_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = resolve_inspect_log_dir(&app);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建日志目录: {error}"))?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|error| format!("打开日志目录失败: {error}"))?;
    }
    Ok(())
}

/// 在资源管理器中定位并打开单个巡检日志文件（默认关联程序）。
#[tauri::command]
pub fn open_inspect_log_file(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("日志文件不存在: {path}"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|error| format!("打开日志文件失败: {error}"))?;
    }
    Ok(())
}

/// 弹出目录选择框，返回用户选择的日志保存目录（取消时返回 None）。
#[tauri::command]
pub fn pick_inspect_log_dir() -> Result<Option<String>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("选择巡检日志保存目录")
        .pick_folder();
    Ok(picked.map(|path| path.display().to_string()))
}

/* ============ 巡检历史存储 ============ */

const INSPECT_HISTORY_DIR: &str = "inspect_history";

/// 历史记录元信息（列表展示用）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InspectHistoryMeta {
    pub id: String,
    pub saved_at: String,
    pub device_count: usize,
    pub command_count: usize,
    pub success_count: usize,
    pub fail_count: usize,
    pub critical_count: usize,
    pub warn_count: usize,
    pub ok_count: usize,
}

/// 完整历史记录（含全部设备结果）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InspectHistoryRecord {
    pub id: String,
    pub saved_at: String,
    pub meta: InspectHistoryMeta,
    pub results: Vec<InspectExecResult>,
}

fn inspect_history_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(INSPECT_HISTORY_DIR)
}

/// 保存一次巡检结果到历史，返回历史记录 ID。
#[tauri::command]
pub fn save_inspect_history(
    app: AppHandle,
    results: Vec<InspectExecResult>,
) -> Result<String, String> {
    let dir = inspect_history_dir(&app);
    fs::create_dir_all(&dir).map_err(|error| format!("创建历史目录失败: {error}"))?;
    let id = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let saved_at = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let device_count = results.len();
    let command_count = results.iter().map(|r| r.outputs.len()).sum();
    let success_count = results.iter().filter(|r| r.success).count();
    let fail_count = device_count - success_count;
    let critical_count = results.iter().filter(|r| r.health == "critical").count();
    let warn_count = results.iter().filter(|r| r.health == "warn").count();
    let ok_count = results.iter().filter(|r| r.health == "ok").count();
    let meta = InspectHistoryMeta {
        id: id.clone(),
        saved_at: saved_at.clone(),
        device_count,
        command_count,
        success_count,
        fail_count,
        critical_count,
        warn_count,
        ok_count,
    };
    let record = InspectHistoryRecord {
        id: id.clone(),
        saved_at,
        meta,
        results,
    };
    let path = dir.join(format!("{id}.json"));
    let content = serde_json::to_string_pretty(&record).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("保存历史失败: {e}"))?;
    Ok(id)
}

/// 列出全部巡检历史（按时间倒序）。
#[tauri::command]
pub fn list_inspect_history(app: AppHandle) -> Result<Vec<InspectHistoryMeta>, String> {
    let dir = inspect_history_dir(&app);
    let mut metas: Vec<InspectHistoryMeta> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut files: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|e| e == "json").unwrap_or(false))
            .collect();
        files.sort();
        for file in files {
            if let Ok(content) = fs::read_to_string(&file) {
                if let Ok(record) = serde_json::from_str::<InspectHistoryRecord>(&content) {
                    metas.push(record.meta);
                }
            }
        }
    }
    metas.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(metas)
}

/// 读取单条巡检历史完整内容。
#[tauri::command]
pub fn get_inspect_history(
    app: AppHandle,
    id: String,
) -> Result<Option<InspectHistoryRecord>, String> {
    let safe_id: String = id.chars().filter(|c| c.is_ascii_digit() || *c == '_').collect();
    if safe_id != id {
        return Err("非法的历史记录 ID".into());
    }
    let path = inspect_history_dir(&app).join(format!("{safe_id}.json"));
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| format!("读取历史失败: {error}")),
        Err(_) => Ok(None),
    }
}

/// 删除单条巡检历史。
#[tauri::command]
pub fn delete_inspect_history(app: AppHandle, id: String) -> Result<bool, String> {
    let safe_id: String = id.chars().filter(|c| c.is_ascii_digit() || *c == '_').collect();
    if safe_id != id {
        return Err("非法的历史记录 ID".into());
    }
    let path = inspect_history_dir(&app).join(format!("{safe_id}.json"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("删除历史失败: {error}")),
    }
}

// ==================== P3 凭据安全（Windows DPAPI） ====================

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err("密文 hex 长度不合法".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("非法 hex: {e}")))
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 用 Windows DPAPI 加密一段明文（输出 hex），仅当前 Windows 用户可解密。
/// 非 Windows 平台退化为 hex 编码（不加密），仅用于开发调试。
#[tauri::command]
pub fn encrypt_secret(plain: String) -> Result<String, String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let res = unsafe {
            CryptProtectData(
                &input,
                w!("RainTerminal 设备凭据"),
                None,
                None,
                Some(std::ptr::null()),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if res.is_err() {
            return Err(format!("DPAPI 加密失败: {res:?}"));
        }
        let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        let hex = encode_hex(bytes);
        let _ = unsafe { LocalFree(Some(HLOCAL(output.pbData as *mut _))) };
        Ok(hex)
    }
    #[cfg(not(windows))]
    {
        Ok(encode_hex(plain.as_bytes()))
    }
}

/// 解密 encrypt_secret 的输出。仅当前 Windows 用户、当前系统可解密。
#[tauri::command]
pub fn decrypt_secret(cipher: String) -> Result<String, String> {
    if cipher.is_empty() {
        return Ok(String::new());
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
        let bytes = decode_hex(&cipher)?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let res = unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                Some(std::ptr::null()),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if res.is_err() {
            return Err(format!("DPAPI 解密失败: {res:?}"));
        }
        let out = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        let _ = unsafe { LocalFree(Some(HLOCAL(output.pbData as *mut _))) };
        String::from_utf8(out).map_err(|e| format!("解密结果不是合法 UTF-8: {e}"))
    }
    #[cfg(not(windows))]
    {
        decode_hex(&cipher).and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()))
    }
}

// ==================== 网段发现（ICMP ping 存活 + TCP 端口并行，10 秒循环窗口） ====================

#[derive(serde::Serialize, Clone)]
pub struct InspectScanHit {
    pub ip: String,
    pub name: String,
    pub open_ports: Vec<u16>,
}

fn tcp_probe(ip: std::net::Ipv4Addr, port: u16, timeout: Duration) -> bool {
    let addr = std::net::SocketAddr::new(std::net::IpAddr::V4(ip), port);
    std::net::TcpStream::connect_timeout(&addr, timeout).is_ok()
}

/// 对同一 IP 的多个端口并行探测（每端口一个短线程），返回开放的端口。
fn probe_ports_parallel(ip: std::net::Ipv4Addr, ports: &[u16], timeout: Duration) -> Vec<u16> {
    let handles: Vec<_> = ports
        .iter()
        .map(|&port| {
            let ip = ip;
            std::thread::spawn(move || tcp_probe(ip, port, timeout))
        })
        .collect();
    ports
        .iter()
        .zip(handles)
        .filter_map(|(&port, handle)| {
            if handle.join().unwrap_or(false) {
                Some(port)
            } else {
                None
            }
        })
        .collect()
}

/// ICMP ping 存活检测（Windows 系统 API IcmpSendEcho，普通权限可用，即 ping.exe 底层实现）。
/// 返回 Some(rtt_ms) 表示通，None 表示不通/超时。
#[cfg(windows)]
fn ping_host(ip: std::net::Ipv4Addr, timeout_ms: u32) -> Option<u32> {
    use std::ffi::c_void;

    #[repr(C)]
    struct IcmpEchoReply {
        address: u32,
        status: u32,
        rtt: u32,
        data_size: u16,
        reserved: u16,
        data: *mut u8,
        options: [u8; 20],
    }

    unsafe extern "system" {
        fn IcmpCreateFile() -> *mut c_void;
        fn IcmpSendEcho(
            handle: *mut c_void,
            dest: u32,
            data: *const u8,
            size: u16,
            options: *const u8,
            reply: *mut u8,
            reply_size: u32,
            timeout: u32,
        ) -> u32;
        fn IcmpCloseHandle(handle: *mut c_void) -> i32;
    }

    unsafe {
        let handle = IcmpCreateFile();
        if handle.is_null() {
            return None;
        }
        let ip_net = u32::from_le_bytes(ip.octets()); // IPAddr=网络字节序, x86小端须 from_le_bytes 使内存为大端排列
        let data: [u8; 16] = *b"RainTerminalPing";
        let reply_size = std::mem::size_of::<IcmpEchoReply>() + data.len() + 8;
        let mut reply: Vec<u8> = vec![0u8; reply_size];
        let sent = IcmpSendEcho(
            handle,
            ip_net,
            data.as_ptr(),
            data.len() as u16,
            std::ptr::null(),
            reply.as_mut_ptr(),
            reply_size as u32,
            timeout_ms,
        );
        IcmpCloseHandle(handle);
        // 关键：必须同时满足 返回了回复 且 回复的 Status == IP_SUCCESS(0)。
        // 仅凭 sent > 0 会把 ICMP "Destination Unreachable"（不存在的 IP 由网关回包）误判为在线。
        if sent == 0 {
            return None;
        }
        // ICMP_ECHO_REPLY.Status 在缓冲区偏移 4（ULONG, little-endian），RTT 在偏移 8
        let status = u32::from_le_bytes([reply[4], reply[5], reply[6], reply[7]]);
        if status != 0 {
            return None;
        }
        let rtt = u32::from_le_bytes([reply[8], reply[9], reply[10], reply[11]]);
        Some(rtt)
    }
}

#[cfg(not(windows))]
fn ping_host(_ip: std::net::Ipv4Addr, _timeout_ms: u32) -> Option<u32> {
    None
}

/// 与 ping_host 同逻辑，额外返回 TTL（ICMP_ECHO_REPLY.Options[0] 偏移 24）。
/// 返回 Some((rtt_ms, ttl)) 表示通。
#[cfg(windows)]
fn ping_host_detailed(ip: std::net::Ipv4Addr, timeout_ms: u32) -> Option<(u32, u8)> {
    use std::ffi::c_void;

    #[repr(C)]
    struct IcmpEchoReply {
        address: u32,
        status: u32,
        rtt: u32,
        data_size: u16,
        reserved: u16,
        data: *mut u8,
        options: [u8; 20],
    }

    unsafe extern "system" {
        fn IcmpCreateFile() -> *mut c_void;
        fn IcmpSendEcho(
            handle: *mut c_void,
            dest: u32,
            data: *const u8,
            size: u16,
            options: *const u8,
            reply: *mut u8,
            reply_size: u32,
            timeout: u32,
        ) -> u32;
        fn IcmpCloseHandle(handle: *mut c_void) -> i32;
    }

    unsafe {
        let handle = IcmpCreateFile();
        if handle.is_null() {
            return None;
        }
        let ip_net = u32::from_le_bytes(ip.octets());
        let data: [u8; 16] = *b"RainTerminalPing";
        let reply_size = std::mem::size_of::<IcmpEchoReply>() + data.len() + 8;
        let mut reply: Vec<u8> = vec![0u8; reply_size];
        let sent = IcmpSendEcho(
            handle,
            ip_net,
            data.as_ptr(),
            data.len() as u16,
            std::ptr::null(),
            reply.as_mut_ptr(),
            reply_size as u32,
            timeout_ms,
        );
        IcmpCloseHandle(handle);
        if sent == 0 {
            return None;
        }
        let status = u32::from_le_bytes([reply[4], reply[5], reply[6], reply[7]]);
        if status != 0 {
            return None;
        }
        let rtt = u32::from_le_bytes([reply[8], reply[9], reply[10], reply[11]]);
        let ttl = reply[24];
        Some((rtt, ttl))
    }
}

#[cfg(not(windows))]
fn ping_host_detailed(_ip: std::net::Ipv4Addr, _timeout_ms: u32) -> Option<(u32, u8)> {
    None
}

/// 反向域名解析，带 600ms 超时兜底（DNS 慢时不阻塞扫描）。
fn reverse_hostname(ip: std::net::Ipv4Addr) -> String {
    let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<String>>();
    let ip_clone = ip;
    std::thread::spawn(move || {
        let _ = tx.send(dns_lookup::lookup_addr(&std::net::IpAddr::V4(ip_clone)));
    });
    match rx.recv_timeout(Duration::from_millis(600)) {
        Ok(Ok(name)) => {
            let name = name.trim_end_matches('.').to_string();
            if name.is_empty() || name == ip.to_string() {
                String::new()
            } else {
                name
            }
        }
        _ => String::new(),
    }
}

/// 并行执行 jobs 个任务：把 range 切成 per_batch 个一批，批内每项一个线程同时跑。
fn run_parallel_batches<F>(jobs: usize, per_batch: usize, job: F)
where
    F: Fn(usize) + Send + Sync + Clone + 'static,
{
    let mut idx = 0usize;
    while idx < jobs {
        let len = per_batch.min(jobs - idx);
        let start = idx;
        let mut handles = Vec::with_capacity(len);
        for j in 0..len {
            let job = job.clone();
            handles.push(std::thread::spawn(move || job(start + j)));
        }
        for handle in handles {
            let _ = handle.join();
        }
        idx += len;
    }
}

/// 扫描 [start_ip, end_ip] 范围内设备（async + spawn_blocking，不阻塞主线程）：
/// 每个 IP 一个线程全并行，在 10 秒窗口内循环检测：
/// - 每轮并行执行 ICMP ping（300ms）+ TCP 探测全部目标端口（7 固定 + 自定义，200ms）
/// - 一轮内 ping 通 或 有端口开放 → 立即判定在线并上屏（inspect-scan-alive + inspect-scan-port）
/// - 10 秒后仍未通 → 放弃该 IP（判不在线），整体扫描最长 10 秒自动停止
/// 进度：每台设备判定结束推送 inspect-scan-progress（scanned/total）。
#[tauri::command]
pub async fn scan_inspect_network(
    app: tauri::AppHandle,
    start_ip: String,
    end_ip: String,
    custom_ports: Vec<u16>,
) -> Result<Vec<InspectScanHit>, String> {
    let spawned = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<InspectScanHit>, String> {
        let start: std::net::Ipv4Addr = start_ip.trim().parse().map_err(|_| "起始 IP 无效".to_string())?;
        let end: std::net::Ipv4Addr = end_ip.trim().parse().map_err(|_| "结束 IP 无效".to_string())?;
        let start_u = u32::from(start);
        let end_u = u32::from(end);
        if end_u < start_u {
            return Err("结束 IP 不能小于起始 IP".into());
        }
        let count = (end_u - start_u + 1) as usize;
        if count > 8192 {
            return Err("扫描范围过大，最多支持 8192 个 IP（如 /19）".into());
        }

        let mut all_ports: Vec<u16> = vec![22, 23, 3389, 5900, 21, 80, 443];
        for p in custom_ports {
            if p > 0 && p <= 65535 && !all_ports.contains(&p) {
                all_ports.push(p);
            }
        }

        let hits: Arc<std::sync::Mutex<Vec<InspectScanHit>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let processed = Arc::new(AtomicUsize::new(0));
        let total = count;
        let batch = if count <= 512 { count } else { 256 };
        let scan_window = Duration::from_secs(10);

        run_parallel_batches(count, batch, {
            let all_ports = all_ports.clone();
            let hits = Arc::clone(&hits);
            let processed = Arc::clone(&processed);
            let app = app.clone();
            move |i| {
                let ip = std::net::Ipv4Addr::from(start_u + i as u32);
                let deadline = std::time::Instant::now() + scan_window;
                let mut up = false;
                let mut open: Vec<u16> = Vec::new();
                // 10 秒窗口内循环检测，通了立即跳出
                while std::time::Instant::now() < deadline {
                    let ping_handle = std::thread::spawn(move || ping_host(ip, 300));
                    open = probe_ports_parallel(ip, &all_ports, Duration::from_millis(200));
                    let ping_up = ping_handle.join().unwrap_or(None).is_some();
                    if ping_up || !open.is_empty() {
                        up = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                if up {
                    let name = reverse_hostname(ip);
                    hits.lock().unwrap().push(InspectScanHit {
                        ip: ip.to_string(),
                        name: name.clone(),
                        open_ports: open.clone(),
                    });
                    let _ = app.emit(
                        "inspect-scan-alive",
                        serde_json::json!({ "ip": ip.to_string(), "name": name }),
                    );
                    let _ = app.emit(
                        "inspect-scan-port",
                        serde_json::json!({ "ip": ip.to_string(), "open_ports": open }),
                    );
                }
                let done = processed.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app.emit(
                    "inspect-scan-progress",
                    serde_json::json!({ "phase": "scan", "scanned": done, "total": total }),
                );
            }
        });

        let mut result = hits.lock().unwrap().clone();
        result.sort_by_key(|hit| {
            hit.ip
                .parse::<std::net::Ipv4Addr>()
                .unwrap_or(std::net::Ipv4Addr::UNSPECIFIED)
        });
        Ok(result)
    });
    spawned
        .await
        .map_err(|e| format!("扫描线程异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icmp_loopback_is_up() {
        assert!(ping_host(std::net::Ipv4Addr::LOCALHOST, 3000).is_some());
    }

    #[test]
    fn icmp_test_net_is_down() {
        let ip: std::net::Ipv4Addr = "192.0.2.1".parse().unwrap();
        assert!(ping_host(ip, 1500).is_none());
    }

}

// ==================== 小工具：端口扫描（单主机并行探测一组端口，流式） ====================

/// 端口扫描：host 可为 IP 或域名（自动解析 IPv4）；ports 为待探测端口列表。
/// 每端口一个短线程并行探测（256 端口/批），逐个推送 port-scan-hit（port/open），
/// 进度推送 port-scan-progress（scanned/total），返回全部开放端口（升序）。
#[tauri::command]
pub async fn scan_ports_tool(
    app: tauri::AppHandle,
    host: String,
    ports: Vec<u16>,
) -> Result<Vec<u16>, String> {
    let spawned = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u16>, String> {
        let host = host.trim().to_string();
        if host.is_empty() {
            return Err("主机不能为空".to_string());
        }
        let ips = dns_lookup::lookup_host(&host).map_err(|e| format!("主机解析失败: {e}"))?;
        let ip = ips
            .into_iter()
            .find(|ip| ip.is_ipv4())
            .ok_or_else(|| "未找到该主机的 IPv4 地址".to_string())?;
        let ip = match ip {
            std::net::IpAddr::V4(v4) => v4,
            _ => unreachable!(),
        };
        let mut ports: Vec<u16> = ports.into_iter().filter(|&p| p >= 1 && p <= 65535).collect();
        ports.sort_unstable();
        ports.dedup();
        if ports.is_empty() {
            return Err("端口列表为空".to_string());
        }
        let open: Arc<std::sync::Mutex<Vec<u16>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let scanned = Arc::new(AtomicUsize::new(0));
        let total = ports.len();
        run_parallel_batches(total, 256, {
            let ip = ip;
            let ports = ports.clone();
            let open = Arc::clone(&open);
            let scanned = Arc::clone(&scanned);
            let app = app.clone();
            move |i| {
                let port = ports[i];
                let ok = tcp_probe(ip, port, Duration::from_millis(300));
                if ok {
                    open.lock().unwrap().push(port);
                }
                let _ = app.emit(
                    "port-scan-hit",
                    serde_json::json!({ "port": port, "open": ok }),
                );
                let done = scanned.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app.emit(
                    "port-scan-progress",
                    serde_json::json!({ "scanned": done, "total": total }),
                );
            }
        });
        let mut result = open.lock().unwrap().clone();
        result.sort_unstable();
        Ok(result)
    });
    spawned
        .await
        .map_err(|e| format!("端口扫描线程异常: {e}"))?
}

// ==================== 小工具：Ping（连续探测 + RTT/丢包统计，流式） ====================

#[derive(serde::Serialize, Clone)]
pub struct PingProbeStats {
    pub host: String,
    pub ip: String,
    pub sent: u32,
    pub received: u32,
    pub loss_pct: f64,
    pub avg_ms: f64,
    pub min_ms: u32,
    pub max_ms: u32,
}

/// 连续 ping：对 host（IP/域名）探测 count 次（1-100，默认 10），每次间隔 300ms。
/// 每次结果推送 ping-probe-result（seq/ok/rttMs），最后返回统计。
#[tauri::command]
pub async fn ping_probe_tool(
    app: tauri::AppHandle,
    host: String,
    count: u32,
) -> Result<PingProbeStats, String> {
    let spawned = tauri::async_runtime::spawn_blocking(move || -> Result<PingProbeStats, String> {
        let host = host.trim().to_string();
        if host.is_empty() {
            return Err("主机不能为空".to_string());
        }
        let ips = dns_lookup::lookup_host(&host).map_err(|e| format!("主机解析失败: {e}"))?;
        let ip = ips
            .into_iter()
            .find(|ip| ip.is_ipv4())
            .ok_or_else(|| "未找到该主机的 IPv4 地址".to_string())?;
        let ip = match ip {
            std::net::IpAddr::V4(v4) => v4,
            _ => unreachable!(),
        };
        let count = count.clamp(1, 100);
        let mut received = 0u32;
        let mut times: Vec<u32> = Vec::new();
        for seq in 1..=count {
            let started = std::time::Instant::now();
            let rtt = ping_host(ip, 1000);
            let elapsed_ms = started.elapsed().as_millis() as u32;
            if let Some(r) = rtt {
                received += 1;
                times.push(r);
            }
            let _ = app.emit(
                "ping-probe-result",
                serde_json::json!({ "seq": seq, "ok": rtt.is_some(), "rtt_ms": rtt.unwrap_or(elapsed_ms) }),
            );
            if seq < count {
                std::thread::sleep(Duration::from_millis(300));
            }
        }
        let sent = count;
        let loss_pct = if sent > 0 {
            (sent - received) as f64 / sent as f64 * 100.0
        } else {
            0.0
        };
        let avg_ms = if times.is_empty() {
            0.0
        } else {
            times.iter().sum::<u32>() as f64 / times.len() as f64
        };
        let min_ms = times.iter().copied().min().unwrap_or(0);
        let max_ms = times.iter().copied().max().unwrap_or(0);
        Ok(PingProbeStats {
            host: host.clone(),
            ip: ip.to_string(),
            sent,
            received,
            loss_pct,
            avg_ms,
            min_ms,
            max_ms,
        })
    });
    spawned
        .await
        .map_err(|e| format!("ping 线程异常: {e}"))?
}

// ==================== 小工具：批量 Ping（对标 PingInfoView：多主机并行，主表汇总 + 选中明细） ====================

#[derive(serde::Serialize, Clone)]
pub struct PingBatchRow {
    pub seq: u32,
    pub ok: bool,
    pub rtt_ms: u32,
    pub ttl: u8,
    pub time: String,
}

#[derive(serde::Serialize, Clone)]
pub struct PingHostDetail {
    pub ip: String,
    pub hostname: String,
    pub rows: Vec<PingBatchRow>,
}

/// 批量 ping：hosts 为 IP/域名列表，每个主机独立线程并行探测 count 次（1-100，间隔 300ms）。
/// 每次结果推送 ping-batch-row（ip/seq/ok/rttMs/ttl），全部结束后返回每个主机的完整明细。
#[tauri::command]
pub async fn ping_batch_tool(
    app: tauri::AppHandle,
    hosts: Vec<String>,
    count: u32,
) -> Result<Vec<PingHostDetail>, String> {
    let spawned = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PingHostDetail>, String> {
        let mut hosts: Vec<String> = hosts
            .into_iter()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .collect();
        hosts.sort();
        hosts.dedup();
        if hosts.is_empty() {
            return Err("主机列表为空".to_string());
        }
        if hosts.len() > 128 {
            return Err("最多支持 128 个主机同时探测".to_string());
        }
        let count = count.clamp(1, 100);
        let results: Arc<std::sync::Mutex<Vec<PingHostDetail>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let remaining = Arc::new(AtomicUsize::new(hosts.len()));
        let mut handles = Vec::with_capacity(hosts.len());
        for host in hosts {
            let app = app.clone();
            let results = Arc::clone(&results);
            let remaining = Arc::clone(&remaining);
            handles.push(std::thread::spawn(move || {
                let ips = match dns_lookup::lookup_host(&host) {
                    Ok(ips) => ips,
                    Err(_) => {
                        let _ = app.emit(
                            "ping-batch-error",
                            serde_json::json!({ "host": host, "message": "主机解析失败" }),
                        );
                        return;
                    }
                };
                let Some(ip) = ips.into_iter().find(|ip| ip.is_ipv4()) else {
                    let _ = app.emit(
                        "ping-batch-error",
                        serde_json::json!({ "host": host, "message": "未找到 IPv4 地址" }),
                    );
                    return;
                };
                let ip = match ip {
                    std::net::IpAddr::V4(v4) => v4,
                    _ => unreachable!(),
                };
                let hostname = reverse_hostname(ip);
                let mut rows = Vec::with_capacity(count as usize);
                for seq in 1..=count {
                    let started = std::time::Instant::now();
                    let detail = ping_host_detailed(ip, 1000);
                    let elapsed_ms = started.elapsed().as_millis() as u32;
                    let (ok, rtt_ms, ttl) = match detail {
                        Some((r, tt)) => (true, r, tt),
                        None => (false, elapsed_ms, 0u8),
                    };
                    let time = chrono::Local::now().format("%H:%M:%S").to_string();
                    rows.push(PingBatchRow {
                        seq,
                        ok,
                        rtt_ms,
                        ttl,
                        time: time.clone(),
                    });
                    let _ = app.emit(
                        "ping-batch-row",
                        serde_json::json!({ "ip": ip.to_string(), "seq": seq, "ok": ok, "rtt_ms": rtt_ms, "ttl": ttl }),
                    );
                    if seq < count {
                        std::thread::sleep(Duration::from_millis(300));
                    }
                }
                results.lock().unwrap().push(PingHostDetail {
                    ip: ip.to_string(),
                    hostname,
                    rows,
                });
                let left = remaining.fetch_sub(1, Ordering::SeqCst) - 1;
                let _ = app.emit(
                    "ping-batch-done",
                    serde_json::json!({ "ip": ip.to_string(), "left": left }),
                );
            }));
        }
        for handle in handles {
            let _ = handle.join();
        }
        let mut result = results.lock().unwrap().clone();
        result.sort_by_key(|d| {
            d.ip
                .parse::<std::net::Ipv4Addr>()
                .unwrap_or(std::net::Ipv4Addr::UNSPECIFIED)
        });
        Ok(result)
    });
    spawned
        .await
        .map_err(|e| format!("批量 ping 线程异常: {e}"))?
}
