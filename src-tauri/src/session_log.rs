// 通用终端会话日志（SSH / Telnet / Serial 共用）
// 可选启用：session_log_open 时传 enabled=false 则关闭；文件名为 名称_时间戳.log
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

struct SessionLogEntry {
    file: Option<File>,
    path: Option<PathBuf>,
}

static SESSION_LOGS: OnceLock<Mutex<HashMap<String, SessionLogEntry>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, SessionLogEntry>> {
    SESSION_LOGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn safe_log_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ', '_']);
    if cleaned.is_empty() {
        "session".to_string()
    } else {
        cleaned.to_string()
    }
}

/// 剥离终端 ANSI 转义序列（颜色/光标定位等），保留纯文本字节。
/// 支持 CSI（ESC [ ... final）与两字节 ESC 序列（ESC M 等）。
fn strip_ansi_bytes(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if b == 0x1b {
            if i + 1 < data.len() && data[i + 1] == b'[' {
                let mut j = i + 2;
                let mut consumed = false;
                while j < data.len() {
                    let c = data[j];
                    if (0x40..=0x7e).contains(&c) {
                        i = j + 1;
                        consumed = true;
                        break;
                    }
                    if !c.is_ascii_digit()
                        && c != b';'
                        && c != b'?'
                        && c != b'>'
                        && c != b'!'
                        && c != b'='
                        && c != b' '
                    {
                        // 参数区出现非法字节：整段视为异常，丢弃到该字节
                        i = j + 1;
                        consumed = true;
                        break;
                    }
                    j += 1;
                }
                if !consumed {
                    i = data.len(); // 未闭合，丢弃剩余
                }
            } else if i + 1 < data.len() && (0x40..=0x5f).contains(&data[i + 1]) {
                i += 2;
            } else {
                i += 1; // 孤立 ESC
            }
        } else if b == 0x07 {
            i += 1; // 丢弃响铃
        } else {
            out.push(b);
            i += 1;
        }
    }
    out
}

/// 打开/关闭会话日志。enabled=false 时关闭并移除已有日志。
/// dir 为空时默认使用程序运行目录下的 logs 目录。
pub fn session_log_open(
    session_id: &str,
    enabled: bool,
    dir: Option<&str>,
    name: &str,
) -> Result<(), String> {
    if !enabled {
        session_log_close(session_id);
        return Ok(());
    }
    let base = dir
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("logs")
        });
    std::fs::create_dir_all(&base).map_err(|e| format!("日志目录创建失败: {e}"))?;
    let file_name = format!("{}.log", safe_log_name(name));
    let path = base.join(file_name);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("日志文件创建失败: {e}"))?;
    let mut guard = registry().lock().map_err(|_| "日志存储锁定失败".to_string())?;
    guard.insert(
        session_id.to_string(),
        SessionLogEntry {
            file: Some(file),
            path: Some(path.clone()),
        },
    );
    Ok(())
}

pub fn session_log_write(session_id: &str, data: &str) {
    if data.is_empty() {
        return;
    }
    let clean = strip_ansi_bytes(data.as_bytes());
    if clean.is_empty() {
        return;
    }
    if let Ok(mut guard) = registry().lock() {
        if let Some(entry) = guard.get_mut(session_id) {
            if let Some(file) = entry.file.as_mut() {
                let _ = file.write_all(&clean);
                let _ = file.flush();
            }
        }
    }
}

pub fn session_log_write_bytes(session_id: &str, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    let clean = strip_ansi_bytes(data);
    if clean.is_empty() {
        return;
    }
    if let Ok(mut guard) = registry().lock() {
        if let Some(entry) = guard.get_mut(session_id) {
            if let Some(file) = entry.file.as_mut() {
                let _ = file.write_all(&clean);
                let _ = file.flush();
            }
        }
    }
}

pub fn session_log_close(session_id: &str) {
    if let Ok(mut guard) = registry().lock() {
        guard.remove(session_id);
    }
}

/// 查询日志文件路径（供前端提示"日志已保存到…"）
pub fn session_log_path(session_id: &str) -> Option<PathBuf> {
    registry()
        .lock()
        .ok()
        .and_then(|guard| guard.get(session_id).and_then(|entry| entry.path.clone()))
}
