// Telnet 终端会话：标准 IAC 协商（NAWS/TTYPE/ECHO/SGA），适用于网络设备与 Linux
use crate::session_log::{session_log_close, session_log_open, session_log_write_bytes};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

// Telnet 协议常量
const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_millis(200);
const TERMINAL_EVENT_FLUSH_BYTES: usize = 32 * 1024;
const TERMINAL_EVENT_FLUSH_MS: u64 = 16;
const TERMINAL_INTERACTIVE_FLUSH_BYTES: usize = 512;

#[derive(Clone)]
pub struct TelnetSessionHandle {
    writer: Arc<Mutex<TcpStream>>,
    alive: Arc<AtomicBool>,
    health: Arc<TelnetSessionStats>,
}

pub struct TelnetSessionStats {
    connected_at_ms: u64,
    last_read_ms: AtomicU64,
    last_write_ms: AtomicU64,
    total_read: AtomicUsize,
    total_written: AtomicUsize,
}

#[derive(Default)]
pub struct TelnetSessions {
    pub sessions: Arc<Mutex<HashMap<String, TelnetSessionHandle>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelnetConnectRequest {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub cols: u32,
    pub rows: u32,
    pub log_enabled: bool,
    pub log_path: Option<String>,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TelnetPayload {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TelnetStatusPayload {
    session_id: String,
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TelnetHealthPayload {
    session_id: String,
    connected: bool,
    idle_ms: u64,
    write_idle_ms: u64,
    connected_ms: u64,
    total_read: usize,
    total_written: usize,
}

fn epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.contains(['/', '\\', '\0']) {
        return Err("非法的会话标识".into());
    }
    Ok(())
}

/// 发送 Telnet 子协商：NAWS（窗口尺寸）
fn send_naws(stream: &mut TcpStream, cols: u32, rows: u32) {
    let c = cols.clamp(20, 65535) as u16;
    let r = rows.clamp(8, 65535) as u16;
    let msg = vec![IAC, SB, NAWS, (c >> 8) as u8, (c & 0xff) as u8, (r >> 8) as u8, (r & 0xff) as u8, IAC, SE];
    let _ = stream.write_all(&msg);
}

/// 解析服务器协商并生成响应字节。返回 (是否需要重绘, 是否应继续)。
/// data 为不含 IAC 的普通数据会累积进 out。
fn handle_telnet_bytes(
    buf: &[u8],
    out: &mut Vec<u8>,
    response: &mut Vec<u8>,
    cols: u32,
    rows: u32,
    resize_requested: &mut bool,
) {
    let mut i = 0;
    while i < buf.len() {
        let b = buf[i];
        if b != IAC {
            out.push(b);
            i += 1;
            continue;
        }
        // IAC 序列
        if i + 1 >= buf.len() {
            break; // 不完整，留给下轮（简化：丢弃）
        }
        let cmd = buf[i + 1];
        match cmd {
            IAC => {
                out.push(IAC); // IAC IAC → 字面 0xFF
                i += 2;
            }
            DO | DONT | WILL | WONT => {
                if i + 2 >= buf.len() {
                    break;
                }
                let opt = buf[i + 2];
                if cmd == DO {
                    match opt {
                        ECHO => {
                            // 接受本地回显（部分网络设备拒绝 WONT 会异常，接受更兼容）
                            response.extend_from_slice(&[IAC, WILL, ECHO]);
                        }
                        SGA => {
                            response.extend_from_slice(&[IAC, WILL, SGA]);
                        }
                        NAWS => {
                            response.extend_from_slice(&[IAC, WILL, NAWS]);
                            let c = cols.clamp(20, 65535) as u16;
                            let r = rows.clamp(8, 65535) as u16;
                            response.extend_from_slice(&[
                                IAC,
                                SB,
                                NAWS,
                                (c >> 8) as u8,
                                (c & 0xff) as u8,
                                (r >> 8) as u8,
                                (r & 0xff) as u8,
                                IAC,
                                SE,
                            ]);
                        }
                        TTYPE => {
                            response.extend_from_slice(&[IAC, WILL, TTYPE]);
                            let ttype = b"xterm-256color";
                            response.push(IAC);
                            response.push(SB);
                            response.push(TTYPE);
                            response.push(0);
                            response.extend_from_slice(ttype);
                            response.push(IAC);
                            response.push(SE);
                        }
                        _ => {
                            response.extend_from_slice(&[IAC, WONT, opt]);
                        }
                    }
                } else if cmd == WILL {
                    // 服务器要开启选项：SGA 接受，其余一律禁止
                    if opt == SGA {
                        response.extend_from_slice(&[IAC, DO, SGA]);
                    } else {
                        response.extend_from_slice(&[IAC, DONT, opt]);
                    }
                }
                // DONT / WONT：无响应
                i += 3;
            }
            SB => {
                // 跳至 IAC SE
                let mut j = i + 2;
                while j + 1 < buf.len() {
                    if buf[j] == IAC && buf[j + 1] == SE {
                        break;
                    }
                    j += 1;
                }
                if j + 1 >= buf.len() {
                    break;
                }
                i = j + 2;
            }
            _ => {
                i += 2;
            }
        }
    }
    let _ = resize_requested;
}

#[tauri::command]
pub async fn telnet_connect(
    app: AppHandle,
    state: State<'_, TelnetSessions>,
    request: TelnetConnectRequest,
) -> Result<(), String> {
    validate_id(&request.session_id)?;
    if request.host.trim().is_empty() {
        return Err("主机地址不能为空".into());
    }
    if request.port == 0 {
        return Err("端口不能为 0".into());
    }
    // 日志打开失败也要能连接：仅记录错误不阻断
    if let Err(error) = session_log_open(
        &request.session_id,
        request.log_enabled,
        request.log_path.as_deref(),
        &request.name,
    ) {
        let _ = app.emit(
            "telnet:error",
            TelnetStatusPayload {
                session_id: request.session_id.clone(),
                message: error,
            },
        );
    }

    let sessions = state.sessions.clone();
    let app_clone = app.clone();
    thread::spawn(move || {
        if let Err(message) = telnet_session_run(
            app_clone.clone(),
            sessions,
            request.session_id.clone(),
            request.host,
            request.port,
            request.cols,
            request.rows,
            request.log_enabled,
        ) {
            let _ = app_clone.emit(
                "telnet:error",
                TelnetStatusPayload {
                    session_id: request.session_id,
                    message,
                },
            );
        }
    });
    Ok(())
}

fn telnet_session_run(
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, TelnetSessionHandle>>>,
    session_id: String,
    host: String,
    port: u16,
    cols: u32,
    rows: u32,
    log_enabled: bool,
) -> Result<(), String> {
    let addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("无法解析主机 {host}:{port} - {e}"))?
        .collect::<Vec<_>>();
    let mut stream = None;
    let mut last_error = String::new();
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last_error = format!("连接 {addr} 失败: {e}"),
        }
    }
    let mut stream = stream.ok_or_else(|| {
        if last_error.is_empty() {
            format!("连接 {host}:{port} 失败")
        } else {
            last_error
        }
    })?;
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_nodelay(true);

    // 主动请求服务器抑制前进（通用终端行为）
    let _ = stream.write_all(&[IAC, DO, SGA]);

    let writer = Arc::new(Mutex::new(stream.try_clone().map_err(|e| format!("会话克隆失败: {e}"))?));
    let alive = Arc::new(AtomicBool::new(true));
    let health = Arc::new(TelnetSessionStats {
        connected_at_ms: epoch_millis(),
        last_read_ms: AtomicU64::new(epoch_millis()),
        last_write_ms: AtomicU64::new(epoch_millis()),
        total_read: AtomicUsize::new(0),
        total_written: AtomicUsize::new(0),
    });

    let handle = TelnetSessionHandle {
        writer: writer.clone(),
        alive: alive.clone(),
        health: health.clone(),
    };
    {
        let mut guard = sessions
            .lock()
            .map_err(|_| "Telnet 会话存储锁定失败".to_string())?;
        guard.insert(session_id.clone(), handle);
    }

    let _ = app.emit(
        "telnet:connected",
        TelnetStatusPayload {
            session_id: session_id.clone(),
            message: "connected".into(),
        },
    );

    let mut buffer = [0_u8; 32768];
    let mut output_buffer = String::with_capacity(TERMINAL_EVENT_FLUSH_BYTES);
    let mut last_output_flush = Instant::now();
    let mut close_message = "Telnet 会话已关闭".to_string();

    loop {
        if !alive.load(Ordering::SeqCst) {
            close_message = "Telnet 会话已断开".into();
            break;
        }
        let size = match stream.read(&mut buffer) {
            Ok(0) => {
                close_message = "Telnet 远端已关闭连接".into();
                break;
            }
            Ok(size) => size,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                if !output_buffer.is_empty() {
                    flush_telnet_output(&app, &session_id, &mut output_buffer, &mut last_output_flush, &health);
                }
                continue;
            }
            Err(e) => {
                if !alive.load(Ordering::SeqCst) {
                    break;
                }
                close_message = format!("Telnet 读取失败: {e}");
                break;
            }
        };

        health.total_read.fetch_add(size, Ordering::Relaxed);
        health.last_read_ms.store(epoch_millis(), Ordering::Relaxed);

        let mut plain = Vec::with_capacity(size);
        let mut response = Vec::new();
        let mut resize_requested = false;
        handle_telnet_bytes(&buffer[..size], &mut plain, &mut response, cols, rows, &mut resize_requested);

        if !response.is_empty() {
            let mut w = writer.lock().map_err(|_| "Telnet 写入锁定失败".to_string())?;
            let _ = w.write_all(&response);
            let _ = w.flush();
            drop(w);
        }

        if log_enabled {
            session_log_write_bytes(&session_id, &plain);
        }

        if !plain.is_empty() {
            let text = String::from_utf8_lossy(&plain).into_owned();
            output_buffer.push_str(&text);
            if terminal_output_should_flush(&output_buffer, &last_output_flush) {
                flush_telnet_output(&app, &session_id, &mut output_buffer, &mut last_output_flush, &health);
            }
        }
    }

    if !output_buffer.is_empty() {
        flush_telnet_output(&app, &session_id, &mut output_buffer, &mut last_output_flush, &health);
    }

    if log_enabled {
        session_log_close(&session_id);
    }
    {
        let mut guard = sessions.lock().map_err(|_| "Telnet 会话存储锁定失败".to_string())?;
        guard.remove(&session_id);
    }
    let _ = app.emit(
        "telnet:closed",
        TelnetStatusPayload {
            session_id,
            message: close_message,
        },
    );
    Ok(())
}

fn terminal_output_should_flush(output: &str, last_flush: &Instant) -> bool {
    output.len() >= TERMINAL_EVENT_FLUSH_BYTES
        || output.len() <= TERMINAL_INTERACTIVE_FLUSH_BYTES
        || last_flush.elapsed() >= Duration::from_millis(TERMINAL_EVENT_FLUSH_MS)
}

fn flush_telnet_output(
    app: &AppHandle,
    session_id: &str,
    output: &mut String,
    last_flush: &mut Instant,
    health: &TelnetSessionStats,
) {
    if output.is_empty() {
        return;
    }
    let data = std::mem::take(output);
    let bytes = data.len();
    let _ = app.emit(
        "telnet:data",
        TelnetPayload {
            session_id: session_id.to_string(),
            data,
        },
    );
    let _ = bytes;
    let _ = health;
    *last_flush = Instant::now();
}

#[tauri::command]
pub fn telnet_session_write(
    state: State<'_, TelnetSessions>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let handle = {
        let guard = state
            .sessions
            .lock()
            .map_err(|_| "Telnet 会话存储锁定失败".to_string())?;
        guard.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return Err("TELNET_STALE: Telnet 会话未在运行".into());
    };
    let mut writer = handle
        .writer
        .lock()
        .map_err(|_| "Telnet 写入锁定失败".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("Telnet 写入失败: {e}"))?;
    drop(writer);
    handle.health.last_write_ms.store(epoch_millis(), Ordering::Relaxed);
    handle
        .health
        .total_written
        .fetch_add(data.len(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn telnet_session_resize(
    state: State<'_, TelnetSessions>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let handle = {
        let guard = state
            .sessions
            .lock()
            .map_err(|_| "Telnet 会话存储锁定失败".to_string())?;
        guard.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return Err("TELNET_STALE: Telnet 会话未在运行".into());
    };
    let mut writer = handle
        .writer
        .lock()
        .map_err(|_| "Telnet 写入锁定失败".to_string())?;
    send_naws(&mut writer, cols, rows);
    let _ = writer.flush();
    Ok(())
}

#[tauri::command]
pub fn telnet_session_stop(
    state: State<'_, TelnetSessions>,
    session_id: String,
) -> Result<(), String> {
    let handle = {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|_| "Telnet 会话存储锁定失败".to_string())?;
        guard.remove(&session_id)
    };
    if let Some(handle) = handle {
        handle.alive.store(false, Ordering::SeqCst);
        // 唤醒阻塞的 read
        if let Ok(writer) = handle.writer.lock() {
            let _ = writer.shutdown(std::net::Shutdown::Both);
        }
        session_log_close(&session_id);
    }
    Ok(())
}

#[tauri::command]
pub fn telnet_session_health(
    state: State<'_, TelnetSessions>,
    session_id: String,
) -> Result<TelnetHealthPayload, String> {
    let handle = {
        let guard = state
            .sessions
            .lock()
            .map_err(|_| "Telnet 会话存储锁定失败".to_string())?;
        guard.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return Ok(TelnetHealthPayload {
            session_id,
            connected: false,
            idle_ms: 0,
            write_idle_ms: 0,
            connected_ms: 0,
            total_read: 0,
            total_written: 0,
        });
    };
    let now = epoch_millis();
    let connected = handle.alive.load(Ordering::SeqCst);
    let last_read = handle.health.last_read_ms.load(Ordering::Relaxed);
    let last_write = handle.health.last_write_ms.load(Ordering::Relaxed);
    let connected_at = handle.health.connected_at_ms;
    Ok(TelnetHealthPayload {
        session_id,
        connected,
        idle_ms: now.saturating_sub(last_read),
        write_idle_ms: now.saturating_sub(last_write),
        connected_ms: now.saturating_sub(connected_at),
        total_read: handle.health.total_read.load(Ordering::Relaxed),
        total_written: handle.health.total_written.load(Ordering::Relaxed),
    })
}
