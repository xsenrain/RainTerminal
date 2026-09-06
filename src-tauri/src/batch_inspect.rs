//! 批量巡检：非交互式 SSH 命令执行引擎。
//!
//! 独立于现有交互式终端（ssh_connect / SshWorkerCommand），
//! 通过 ssh2 的 channel.exec 在每台设备上依次执行命令并收集输出。
//! 支持 Linux（EOF 判定）与网络设备（静默期判定 + 分页翻页）。

use crate::connect_interactive_ssh_session;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

/// 读取静默期：网络设备 exec 通道不会 EOF，连续多久无数据视为命令输出结束。
const READ_QUIET_PERIOD_MS: u64 = 800;
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

#[derive(Serialize, Clone)]
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

#[derive(Serialize, Clone)]
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
pub fn batch_execute_inspect(
    app: AppHandle,
    devices: Vec<InspectDeviceInput>,
    commands: Vec<InspectCommandInput>,
    concurrency: u32,
) -> Vec<InspectExecResult> {
    let total = devices.len();
    if total == 0 {
        return Vec::new();
    }
    let workers = (concurrency.clamp(1, 10) as usize).min(total);
    let results: Mutex<Vec<Option<InspectExecResult>>> = Mutex::new(vec![None; total]);
    let next_index = AtomicUsize::new(0);
    let done_count = AtomicUsize::new(0);
    let worker_apps: Vec<AppHandle> = (0..workers).map(|_| app.clone()).collect();

    thread::scope(|scope| {
        for worker_app in &worker_apps {
            scope.spawn(|| loop {
                let index = next_index.fetch_add(1, Ordering::SeqCst);
                if index >= total {
                    break;
                }
                let device = &devices[index];
                let started = Instant::now();
                let result = match execute_device_with_retry(device, &commands) {
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
}

/// 连接失败时自动重试一次（网络抖动 / 首连慢的常见场景）。
fn execute_device_with_retry(
    device: &InspectDeviceInput,
    commands: &[InspectCommandInput],
) -> Result<Vec<InspectCommandOutput>, String> {
    match execute_device(device, commands) {
        Ok(outputs) => Ok(outputs),
        Err(_) => execute_device(device, commands),
    }
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

fn execute_device(
    device: &InspectDeviceInput,
    commands: &[InspectCommandInput],
) -> Result<Vec<InspectCommandOutput>, String> {
    let mut session = connect_interactive_ssh_session(
        &device.host,
        &device.username,
        &device.password,
        device.port,
    )?;
    // 认证完成后，把 IO 超时缩短为静默期，用于网络设备输出结束判定。
    session.set_timeout(READ_QUIET_PERIOD_MS as u32);

    let mut outputs = Vec::with_capacity(commands.len());
    for command in commands {
        outputs.push(execute_one_command(
            &mut session,
            &device.vendor,
            &command.name,
            &command.command,
        ));
    }
    Ok(outputs)
}

fn execute_one_command(
    session: &mut ssh2::Session,
    vendor: &str,
    command_name: &str,
    command: &str,
) -> InspectCommandOutput {
    let mut output = String::new();

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
    threshold: Option<u64>,           // 输出中最大数字 ≥ 阈值 → 命中（百分比/负载等）
    label: &'static str,              // 命中原因（中文）
}

/// 预设规则库：按厂商 + 命令内容子串匹配。
const DEFAULT_INSPECT_RULES: &[InspectRule] = &[
    // ---- Linux ----
    InspectRule { vendor: "linux", command_contains: "df", severity: "critical", keyword: Some("100%"), missing_keyword: None, threshold: None, label: "磁盘使用率已达 100%" },
    InspectRule { vendor: "linux", command_contains: "df", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(90), label: "磁盘使用率 ≥ 90%" },
    InspectRule { vendor: "linux", command_contains: "load", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(4), label: "系统负载 ≥ 4" },
    InspectRule { vendor: "linux", command_contains: "load", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(8), label: "系统负载 ≥ 8" },
    InspectRule { vendor: "linux", command_contains: "ping", severity: "critical", keyword: Some("100% packet loss"), missing_keyword: None, threshold: None, label: "ping 丢包率 100%" },
    InspectRule { vendor: "linux", command_contains: "systemctl", severity: "warn", keyword: Some("failed"), missing_keyword: None, threshold: None, label: "存在 failed 状态的系统单元" },
    InspectRule { vendor: "linux", command_contains: "journalctl", severity: "warn", keyword: Some("error"), missing_keyword: None, threshold: None, label: "日志中存在 error" },
    // ---- 华为 ----
    InspectRule { vendor: "huawei", command_contains: "display device", severity: "critical", keyword: Some("abnormal"), missing_keyword: None, threshold: None, label: "板卡存在 Abnormal 状态" },
    InspectRule { vendor: "huawei", command_contains: "display device", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, label: "板卡存在 Fault 状态" },
    InspectRule { vendor: "huawei", command_contains: "display alarm", severity: "warn", keyword: Some("alarm"), missing_keyword: None, threshold: None, label: "存在活动告警" },
    InspectRule { vendor: "huawei", command_contains: "display interface brief", severity: "warn", keyword: Some("down"), missing_keyword: None, threshold: None, label: "存在 DOWN 接口" },
    InspectRule { vendor: "huawei", command_contains: "display cpu", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70), label: "CPU 使用率 ≥ 70%" },
    InspectRule { vendor: "huawei", command_contains: "display cpu", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90), label: "CPU 使用率 ≥ 90%" },
    InspectRule { vendor: "huawei", command_contains: "display memory", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90), label: "内存使用率 ≥ 90%" },
    InspectRule { vendor: "huawei", command_contains: "display temperature", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70), label: "温度 ≥ 70℃" },
    InspectRule { vendor: "huawei", command_contains: "display health", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, label: "健康检查存在 Fault" },
    // ---- 华三 ----
    InspectRule { vendor: "h3c", command_contains: "display device", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, label: "板卡存在 Fault 状态" },
    InspectRule { vendor: "h3c", command_contains: "display alarm", severity: "warn", keyword: Some("alarm"), missing_keyword: None, threshold: None, label: "存在活动告警" },
    InspectRule { vendor: "h3c", command_contains: "display interface brief", severity: "warn", keyword: Some("down"), missing_keyword: None, threshold: None, label: "存在 DOWN 接口" },
    InspectRule { vendor: "h3c", command_contains: "display cpu", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70), label: "CPU 使用率 ≥ 70%" },
    InspectRule { vendor: "h3c", command_contains: "display cpu", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90), label: "CPU 使用率 ≥ 90%" },
    InspectRule { vendor: "h3c", command_contains: "display memory", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90), label: "内存使用率 ≥ 90%" },
    InspectRule { vendor: "h3c", command_contains: "display environment", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, label: "环境监控存在 Fault" },
    // ---- 锐捷 ----
    InspectRule { vendor: "ruijie", command_contains: "show device", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, label: "板卡存在 Fault 状态" },
    InspectRule { vendor: "ruijie", command_contains: "show alarm", severity: "warn", keyword: Some("alarm"), missing_keyword: None, threshold: None, label: "存在活动告警" },
    InspectRule { vendor: "ruijie", command_contains: "show interface", severity: "warn", keyword: Some("down"), missing_keyword: None, threshold: None, label: "存在 DOWN 接口" },
    InspectRule { vendor: "ruijie", command_contains: "show cpu", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70), label: "CPU 使用率 ≥ 70%" },
    InspectRule { vendor: "ruijie", command_contains: "show cpu", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90), label: "CPU 使用率 ≥ 90%" },
    InspectRule { vendor: "ruijie", command_contains: "show memory", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90), label: "内存使用率 ≥ 90%" },
    InspectRule { vendor: "ruijie", command_contains: "show environment", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, label: "环境监控存在 Fault" },
    // ---- 中兴 ----
    InspectRule { vendor: "zte", command_contains: "show environment", severity: "critical", keyword: Some("fault"), missing_keyword: None, threshold: None, label: "环境监控存在 Fault" },
    InspectRule { vendor: "zte", command_contains: "show interface", severity: "warn", keyword: Some("down"), missing_keyword: None, threshold: None, label: "存在 DOWN 接口" },
    InspectRule { vendor: "zte", command_contains: "show cpu", severity: "warn", keyword: None, missing_keyword: None, threshold: Some(70), label: "CPU 使用率 ≥ 70%" },
    InspectRule { vendor: "zte", command_contains: "show cpu", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90), label: "CPU 使用率 ≥ 90%" },
    InspectRule { vendor: "zte", command_contains: "show memory", severity: "critical", keyword: None, missing_keyword: None, threshold: Some(90), label: "内存使用率 ≥ 90%" },
];

/// 对单个命令输出执行故障判断，返回（健康等级, 命中原因列表）。
fn assess_output(vendor: &str, command: &str, output: &str) -> (String, Vec<String>) {
    let command_lower = command.to_ascii_lowercase();
    let output_lower = output.to_ascii_lowercase();
    let mut hits: Vec<(&'static str, String)> = Vec::new();

    for rule in DEFAULT_INSPECT_RULES {
        if rule.vendor != vendor {
            continue;
        }
        if !command_lower.contains(rule.command_contains) {
            continue;
        }
        let hit = if let Some(keyword) = rule.keyword {
            output_lower.contains(&keyword.to_ascii_lowercase())
        } else if let Some(missing) = rule.missing_keyword {
            !output_lower.contains(&missing.to_ascii_lowercase())
        } else if let Some(threshold) = rule.threshold {
            max_number(output) >= threshold
        } else {
            false
        };
        if hit {
            hits.push((rule.severity, rule.label.to_string()));
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

/// 提取输出中最大的整数（用于阈值规则）。
fn max_number(output: &str) -> u64 {
    let mut max = 0u64;
    let mut current = 0u64;
    let mut in_number = false;
    for byte in output.bytes() {
        if byte.is_ascii_digit() {
            current = current.saturating_mul(10).saturating_add((byte - b'0') as u64);
            in_number = true;
        } else {
            if in_number {
                if current > max {
                    max = current;
                }
                current = 0;
                in_number = false;
            }
        }
    }
    if in_number && current > max {
        max = current;
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
