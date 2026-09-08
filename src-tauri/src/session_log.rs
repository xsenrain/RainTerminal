// 通用终端会话日志（SSH / Telnet / Serial 共用）
// 可选启用：session_log_open 时传 enabled=false 则关闭；文件名为 名称_时间戳.log
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

struct SessionLogEntry {
    file: Option<File>,
    path: Option<PathBuf>,
    /// 当前未完成行缓冲：退格/回车在此消化，遇换行才落盘
    pending: Vec<u8>,
    /// 刚收到 \r，等待下一字节判定是 CRLF 换行还是回行首覆盖
    after_cr: bool,
    /// 是否处于"用户输入行"：仅输入行做退格/回车消化，服务端输出原样全记录
    input_active: bool,
    /// 最近一次用户输入时刻（超时自动结束输入行）
    last_input_at: Option<Instant>,
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

/// 剥离终端 ANSI 转义序列（颜色/光标定位/标题等），保留纯文本字节。
/// 支持 CSI（ESC [ ... final）、OSC（ESC ] ... BEL/ST）、两字节 ESC 序列（ESC M 等）。
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
                        i = j + 1;
                        consumed = true;
                        break;
                    }
                    j += 1;
                }
                if !consumed {
                    i = data.len();
                }
            } else if i + 1 < data.len() && data[i + 1] == b']' {
                // OSC 终端标题等：丢弃直到 BEL(0x07) 或 ST(ESC \)
                let mut j = i + 2;
                let mut consumed = false;
                while j < data.len() {
                    if data[j] == 0x07 {
                        i = j + 1;
                        consumed = true;
                        break;
                    }
                    if data[j] == 0x1b && j + 1 < data.len() && data[j + 1] == b'\\' {
                        i = j + 2;
                        consumed = true;
                        break;
                    }
                    j += 1;
                }
                if !consumed {
                    i = data.len();
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
            pending: Vec::new(),
            after_cr: false,
            input_active: false,
            last_input_at: None,
        },
    );
    Ok(())
}

/// 用户输入发生时调用：标记当前会话进入"输入行"模式
pub fn session_log_note_input(session_id: &str) {
    if let Ok(mut guard) = registry().lock() {
        if let Some(entry) = guard.get_mut(session_id) {
            entry.input_active = true;
            entry.last_input_at = Some(Instant::now());
        }
    }
}

/// 按 UTF-8 字符边界删除行缓冲末尾一个字符（退格语义）
fn pop_pending_char(pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let last = pending[pending.len() - 1];
    if last < 0x80 {
        pending.pop();
    } else if last < 0xc0 {
        // 续字节：向前找到首字节，按字符长度整体删除
        let mut idx = pending.len().saturating_sub(2);
        while idx > 0 && pending[idx] & 0xc0 == 0x80 {
            idx -= 1;
        }
        let first = pending[idx];
        let char_len = if first >= 0xf0 {
            4
        } else if first >= 0xe0 {
            3
        } else if first >= 0xc0 {
            2
        } else {
            1
        };
        let remaining = pending.len() - idx;
        pending.truncate(pending.len() - remaining.min(char_len));
    } else {
        pending.pop();
    }
}

/// 行消化：仅"用户输入行"做退格/回车消化（输错重输只留最终命令），
/// 服务端输出原样全部记录。输入行超时 3 秒无新输入则自动结束。
fn digest_line_bytes(entry: &mut SessionLogEntry, clean: &[u8]) {
    let file = match entry.file.as_mut() {
        Some(file) => file,
        None => return,
    };
    let mut out = Vec::with_capacity(clean.len() + 32);

    // 输入行超时自动结束，未换行的残留内容按原样落盘
    if entry.input_active {
        let expired = entry
            .last_input_at
            .map(|t| t.elapsed() > Duration::from_secs(3))
            .unwrap_or(false);
        if expired {
            if !entry.pending.is_empty() {
                out.extend_from_slice(&entry.pending);
                entry.pending.clear();
            }
            entry.input_active = false;
            entry.after_cr = false;
        }
    }

    if !entry.input_active {
        // 服务端输出：原样全部记录（ANSI 控制序列已在 strip 阶段清理）
        if !clean.is_empty() {
            out.extend_from_slice(clean);
        }
    } else {
        // 用户输入行：退格删字符、回车换行落地，最终只保留净命令行
        let mut i = 0;
        while i < clean.len() {
            let b = clean[i];
            if entry.after_cr {
                entry.after_cr = false;
                if b == b'\n' {
                    if !entry.pending.is_empty() {
                        out.extend_from_slice(&entry.pending);
                        entry.pending.clear();
                    }
                    out.push(b'\n');
                    entry.input_active = false; // 回车结束输入行
                    i += 1;
                    continue;
                }
                entry.pending.clear(); // 单独 CR：回行首覆盖当前行
            }
            match b {
                0x08 => pop_pending_char(&mut entry.pending),
                0x0d => entry.after_cr = true,
                0x0a => {
                    if !entry.pending.is_empty() {
                        out.extend_from_slice(&entry.pending);
                        entry.pending.clear();
                    }
                    out.push(b'\n');
                    entry.input_active = false; // 回车结束输入行
                }
                _ => entry.pending.push(b),
            }
            i += 1;
        }
    }

    if !out.is_empty() {
        let _ = file.write_all(&out);
        let _ = file.flush();
    }
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
            digest_line_bytes(entry, &clean);
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
            digest_line_bytes(entry, &clean);
        }
    }
}

pub fn session_log_close(session_id: &str) {
    if let Ok(mut guard) = registry().lock() {
        if let Some(mut entry) = guard.remove(session_id) {
            // 冲刷未换行的最后一行
            if !entry.pending.is_empty() {
                if let Some(file) = entry.file.as_mut() {
                    let _ = file.write_all(&entry.pending);
                    let _ = file.flush();
                }
            }
        }
    }
}

/// 查询日志文件路径（供前端提示"日志已保存到…"）
pub fn session_log_path(session_id: &str) -> Option<PathBuf> {
    registry()
        .lock()
        .ok()
        .and_then(|guard| guard.get(session_id).and_then(|entry| entry.path.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(tag: &str) -> (SessionLogEntry, PathBuf) {
        let dir = std::env::temp_dir().join(format!("raintest_{}_{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        let file = OpenOptions::new().create(true).append(true).open(&path).unwrap();
        (
            SessionLogEntry {
                file: Some(file),
                path: Some(path.clone()),
                pending: Vec::new(),
                after_cr: false,
                input_active: false,
                last_input_at: None,
            },
            dir,
        )
    }

    fn entry_content(dir: &PathBuf) -> String {
        std::fs::read_to_string(dir.join("t.log")).unwrap()
    }

    #[test]
    fn input_backspace_retry() {
        // 用户输入行：输错退格重输只留最终命令
        let (mut entry, dir) = make_entry("ib");
        entry.input_active = true;
        digest_line_bytes(
            &mut entry,
            b"swap-s\x08\x08\x08\x08\x08\x08swapon --show\r\n",
        );
        assert_eq!(entry_content(&dir), "swapon --show\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn server_output_kept_verbatim() {
        // 服务端输出：含 \r 与 \x08 也原样全记录
        let (mut entry, dir) = make_entry("sv");
        digest_line_bytes(&mut entry, b"progress 50%\rprogress 100%\r\n");
        digest_line_bytes(&mut entry, b"odd\x08byte\r\n");
        assert_eq!(
            entry_content(&dir),
            "progress 50%\rprogress 100%\r\nodd\x08byte\r\n"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn server_output_crlf_split_chunks() {
        let (mut entry, dir) = make_entry("sc");
        digest_line_bytes(&mut entry, b"total 116\r");
        digest_line_bytes(&mut entry, b"\n");
        assert_eq!(entry_content(&dir), "total 116\r\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn input_utf8_backspace() {
        let (mut entry, dir) = make_entry("iu");
        entry.input_active = true;
        digest_line_bytes(&mut entry, "中文\x08文\r\n".as_bytes());
        assert_eq!(entry_content(&dir), "中文\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn input_expire_flushes_then_verbatim() {
        // 输入行超时后：残留落盘，后续按服务端输出原样记录
        let (mut entry, dir) = make_entry("ie");
        entry.input_active = true;
        entry.last_input_at = Some(Instant::now() - Duration::from_secs(10));
        digest_line_bytes(&mut entry, b"ls");
        digest_line_bytes(&mut entry, b"-al\r\n");
        assert_eq!(entry_content(&dir), "ls-al\r\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
