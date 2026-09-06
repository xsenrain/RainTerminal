//! 批量巡检：非交互式 SSH 命令执行引擎。
//!
//! 独立于现有交互式终端（ssh_connect / SshWorkerCommand），
//! 通过 ssh2 的 channel.exec 在每台设备上依次执行命令并收集输出。
//! 支持 Linux（EOF 判定）与网络设备（静默期判定 + 分页翻页）。

use crate::connect_interactive_ssh_session;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::time::Instant;

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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectExecResult {
    pub device_name: String,
    pub host: String,
    pub success: bool,
    pub error: Option<String>,
    pub outputs: Vec<InspectCommandOutput>,
    pub duration_ms: u64,
}

/// 批量在设备上依次执行命令（当前串行，单线程足够 MVP；并发在后续阶段加入）。
#[tauri::command]
pub fn batch_execute_inspect(
    devices: Vec<InspectDeviceInput>,
    commands: Vec<InspectCommandInput>,
) -> Vec<InspectExecResult> {
    devices
        .iter()
        .map(|device| {
            let started = Instant::now();
            match execute_device(device, &commands) {
                Ok(outputs) => InspectExecResult {
                    device_name: device.name.clone(),
                    host: device.host.clone(),
                    success: true,
                    error: None,
                    outputs,
                    duration_ms: started.elapsed().as_millis() as u64,
                },
                Err(error) => InspectExecResult {
                    device_name: device.name.clone(),
                    host: device.host.clone(),
                    success: false,
                    error: Some(error),
                    outputs: Vec::new(),
                    duration_ms: started.elapsed().as_millis() as u64,
                },
            }
        })
        .collect()
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
        outputs.push(execute_one_command(&mut session, &command.name, &command.command));
    }
    Ok(outputs)
}

fn execute_one_command(
    session: &mut ssh2::Session,
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
            }
            .note_error(&format!("SSH channel open failed: {error}"))
        }
    };

    if let Err(error) = channel.exec(command) {
        return InspectCommandOutput {
            command: command_name.to_string(),
            output: String::new(),
            success: false,
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

    InspectCommandOutput {
        command: command_name.to_string(),
        output: output.trim_end().to_string(),
        success,
    }
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
