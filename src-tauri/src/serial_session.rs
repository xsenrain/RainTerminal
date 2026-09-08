// Serial 串口终端会话：本地设备 console 口连接
use crate::session_log::{session_log_close, session_log_open, session_log_write_bytes};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

const READ_TIMEOUT: Duration = Duration::from_millis(200);
const TERMINAL_EVENT_FLUSH_BYTES: usize = 32 * 1024;
const TERMINAL_EVENT_FLUSH_MS: u64 = 16;
const TERMINAL_INTERACTIVE_FLUSH_BYTES: usize = 512;

#[derive(Clone)]
pub struct SerialSessionHandle {
    writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    alive: Arc<AtomicBool>,
    health: Arc<SerialSessionStats>,
}

pub struct SerialSessionStats {
    connected_at_ms: u64,
    last_read_ms: AtomicU64,
    last_write_ms: AtomicU64,
    total_read: AtomicUsize,
    total_written: AtomicUsize,
}

#[derive(Default)]
pub struct SerialSessions {
    pub sessions: Arc<Mutex<HashMap<String, SerialSessionHandle>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConnectRequest {
    pub session_id: String,
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub flow_control: String,
    pub log_enabled: bool,
    pub log_path: Option<String>,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialPayload {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialStatusPayload {
    session_id: String,
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    name: String,
    port_type: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialHealthPayload {
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

fn map_data_bits(value: u8) -> Result<serialport::DataBits, String> {
    match value {
        5 => Ok(serialport::DataBits::Five),
        6 => Ok(serialport::DataBits::Six),
        7 => Ok(serialport::DataBits::Seven),
        8 => Ok(serialport::DataBits::Eight),
        _ => Err("数据位仅支持 5/6/7/8".into()),
    }
}

fn map_stop_bits(value: u8) -> Result<serialport::StopBits, String> {
    match value {
        1 => Ok(serialport::StopBits::One),
        2 => Ok(serialport::StopBits::Two),
        _ => Err("停止位仅支持 1/2".into()),
    }
}

fn map_parity(value: &str) -> Result<serialport::Parity, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" | "" => Ok(serialport::Parity::None),
        "odd" => Ok(serialport::Parity::Odd),
        "even" => Ok(serialport::Parity::Even),
        _ => Err("校验位仅支持 none/odd/even".into()),
    }
}

fn map_flow_control(value: &str) -> Result<serialport::FlowControl, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" | "" => Ok(serialport::FlowControl::None),
        "hardware" => Ok(serialport::FlowControl::Hardware),
        "software" => Ok(serialport::FlowControl::Software),
        _ => Err("流控仅支持 none/hardware/software".into()),
    }
}

#[tauri::command]
pub fn serial_list_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("枚举串口失败: {e}"))?;
    Ok(ports
        .into_iter()
        .map(|info| SerialPortInfo {
            name: info.port_name,
            port_type: format!("{:?}", info.port_type),
        })
        .collect())
}

#[tauri::command]
pub async fn serial_connect(
    app: AppHandle,
    state: State<'_, SerialSessions>,
    request: SerialConnectRequest,
) -> Result<(), String> {
    validate_id(&request.session_id)?;
    if request.port_name.trim().is_empty() {
        return Err("串口号不能为空".into());
    }
    if request.baud_rate == 0 {
        return Err("波特率不能为 0".into());
    }
    if let Err(error) = session_log_open(
        &request.session_id,
        request.log_enabled,
        request.log_path.as_deref(),
        &request.name,
    ) {
        let _ = app.emit(
            "serial:error",
            SerialStatusPayload {
                session_id: request.session_id.clone(),
                message: error,
            },
        );
    }

    let sessions = state.sessions.clone();
    let app_clone = app.clone();
    thread::spawn(move || {
        if let Err(message) = serial_session_run(
            app_clone.clone(),
            sessions,
            request.session_id.clone(),
            request.port_name,
            request.baud_rate,
            request.data_bits,
            request.stop_bits,
            request.parity,
            request.flow_control,
            request.log_enabled,
        ) {
            let _ = app_clone.emit(
                "serial:error",
                SerialStatusPayload {
                    session_id: request.session_id,
                    message,
                },
            );
        }
    });
    Ok(())
}

fn serial_session_run(
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, SerialSessionHandle>>>,
    session_id: String,
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: String,
    flow_control: String,
    log_enabled: bool,
) -> Result<(), String> {
    let mut builder = serialport::new(port_name.as_str(), baud_rate);
    builder = builder
        .data_bits(map_data_bits(data_bits)?)
        .stop_bits(map_stop_bits(stop_bits)?)
        .parity(map_parity(&parity)?)
        .flow_control(map_flow_control(&flow_control)?)
        .timeout(READ_TIMEOUT);
    let mut port = builder
        .open()
        .map_err(|e| format!("打开串口 {port_name} 失败: {e}"))?;

    let writer = Arc::new(Mutex::new(port.try_clone().map_err(|e| format!("串口克隆失败: {e}"))?));
    let alive = Arc::new(AtomicBool::new(true));
    let health = Arc::new(SerialSessionStats {
        connected_at_ms: epoch_millis(),
        last_read_ms: AtomicU64::new(epoch_millis()),
        last_write_ms: AtomicU64::new(epoch_millis()),
        total_read: AtomicUsize::new(0),
        total_written: AtomicUsize::new(0),
    });

    let handle = SerialSessionHandle {
        writer: writer.clone(),
        alive: alive.clone(),
        health: health.clone(),
    };
    {
        let mut guard = sessions
            .lock()
            .map_err(|_| "Serial 会话存储锁定失败".to_string())?;
        guard.insert(session_id.clone(), handle);
    }

    let _ = app.emit(
        "serial:connected",
        SerialStatusPayload {
            session_id: session_id.clone(),
            message: "connected".into(),
        },
    );

    let mut buffer = [0_u8; 32768];
    let mut output_buffer = String::with_capacity(TERMINAL_EVENT_FLUSH_BYTES);
    let mut last_output_flush = Instant::now();
    let mut close_message = "串口会话已关闭".to_string();

    loop {
        if !alive.load(Ordering::SeqCst) {
            close_message = "串口会话已断开".into();
            break;
        }
        let size = match port.read(&mut buffer) {
            Ok(0) => {
                close_message = "串口读取返回空".into();
                break;
            }
            Ok(size) => size,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if !output_buffer.is_empty() {
                    flush_serial_output(&app, &session_id, &mut output_buffer, &mut last_output_flush);
                }
                continue;
            }
            Err(e) => {
                if !alive.load(Ordering::SeqCst) {
                    break;
                }
                close_message = format!("串口读取失败: {e}");
                break;
            }
        };

        health.total_read.fetch_add(size, Ordering::Relaxed);
        health.last_read_ms.store(epoch_millis(), Ordering::Relaxed);

        if log_enabled {
            session_log_write_bytes(&session_id, &buffer[..size]);
        }

        let text = String::from_utf8_lossy(&buffer[..size]).into_owned();
        output_buffer.push_str(&text);
        if terminal_output_should_flush(&output_buffer, &last_output_flush) {
            flush_serial_output(&app, &session_id, &mut output_buffer, &mut last_output_flush);
        }
    }

    if !output_buffer.is_empty() {
        flush_serial_output(&app, &session_id, &mut output_buffer, &mut last_output_flush);
    }

    if log_enabled {
        session_log_close(&session_id);
    }
    {
        let mut guard = sessions
            .lock()
            .map_err(|_| "Serial 会话存储锁定失败".to_string())?;
        guard.remove(&session_id);
    }
    let _ = app.emit(
        "serial:closed",
        SerialStatusPayload {
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

fn flush_serial_output(
    app: &AppHandle,
    session_id: &str,
    output: &mut String,
    last_flush: &mut Instant,
) {
    if output.is_empty() {
        return;
    }
    let data = std::mem::take(output);
    let _ = app.emit(
        "serial:data",
        SerialPayload {
            session_id: session_id.to_string(),
            data,
        },
    );
    *last_flush = Instant::now();
}

#[tauri::command]
pub fn serial_session_write(
    state: State<'_, SerialSessions>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let handle = {
        let guard = state
            .sessions
            .lock()
            .map_err(|_| "Serial 会话存储锁定失败".to_string())?;
        guard.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return Err("SERIAL_STALE: 串口会话未在运行".into());
    };
    let mut writer = handle
        .writer
        .lock()
        .map_err(|_| "Serial 写入锁定失败".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("串口写入失败: {e}"))?;
    drop(writer);
    handle.health.last_write_ms.store(epoch_millis(), Ordering::Relaxed);
    handle
        .health
        .total_written
        .fetch_add(data.len(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn serial_session_stop(
    state: State<'_, SerialSessions>,
    session_id: String,
) -> Result<(), String> {
    let handle = {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|_| "Serial 会话存储锁定失败".to_string())?;
        guard.remove(&session_id)
    };
    if let Some(handle) = handle {
        handle.alive.store(false, Ordering::SeqCst);
        if let Ok(writer) = handle.writer.lock() {
            let _ = writer.clear(serialport::ClearBuffer::All);
        }
        session_log_close(&session_id);
    }
    Ok(())
}

#[tauri::command]
pub fn serial_session_health(
    state: State<'_, SerialSessions>,
    session_id: String,
) -> Result<SerialHealthPayload, String> {
    let handle = {
        let guard = state
            .sessions
            .lock()
            .map_err(|_| "Serial 会话存储锁定失败".to_string())?;
        guard.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return Ok(SerialHealthPayload {
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
    Ok(SerialHealthPayload {
        session_id,
        connected,
        idle_ms: now.saturating_sub(last_read),
        write_idle_ms: now.saturating_sub(last_write),
        connected_ms: now.saturating_sub(connected_at),
        total_read: handle.health.total_read.load(Ordering::Relaxed),
        total_written: handle.health.total_written.load(Ordering::Relaxed),
    })
}
