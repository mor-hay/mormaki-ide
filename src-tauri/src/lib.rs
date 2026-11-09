use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct Acp {
    generation: u64,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

type AcpState = Mutex<Acp>;

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct PtyManager {
    next_id: u32,
    sessions: HashMap<u32, PtyInstance>,
}

type PtyState = Mutex<PtyManager>;

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: u32,
    data: String,
}

fn find_maki() -> PathBuf {
    if let Ok(p) = std::env::var("MAKI_BIN") {
        return p.into();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(PathBuf::from)
        .collect();
    for extra in [".local/bin", ".cargo/bin"] {
        dirs.push(Path::new(&home).join(extra));
    }
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    dirs.into_iter()
        .map(|d| d.join("maki"))
        .find(|p| p.is_file())
        .unwrap_or_else(|| "maki".into())
}

#[tauri::command]
fn acp_start(
    app: AppHandle,
    state: State<AcpState>,
    cwd: String,
    thinking: Option<String>,
) -> Result<u64, String> {
    if !Path::new(&cwd).is_dir() {
        return Err(format!("workspace directory does not exist: {cwd}"));
    }
    let mut acp = state.lock().unwrap();
    acp.stdin.take();
    if let Some(mut old) = acp.child.take() {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Ok(Some(_)) = old.try_wait() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = old.kill();
        let _ = old.wait();
    }
    let mut cmd = Command::new(find_maki());
    cmd.arg("acp").current_dir(&cwd);
    match thinking.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => {
            cmd.env("MORMAKI_THINKING", t);
        }
        _ => {
            cmd.env_remove("MORMAKI_THINKING");
        }
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start maki acp: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    acp.stdin = child.stdin.take();
    acp.child = Some(child);
    acp.generation += 1;
    let generation = acp.generation;

    let out_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = out_app.emit("acp://message", line);
        }
        eprintln!("[maki acp #{generation}] stdout closed");
        let _ = out_app.emit("acp://exit", generation);
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[maki acp #{generation}] {line}");
            let _ = app.emit("acp://stderr", line);
        }
    });
    Ok(generation)
}

#[tauri::command]
fn acp_send(state: State<AcpState>, line: String) -> Result<(), String> {
    let mut acp = state.lock().unwrap();
    let stdin = acp.stdin.as_mut().ok_or("maki acp is not running")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    let target_dir = if Path::new(&cwd).is_dir() {
        PathBuf::from(&cwd)
    } else {
        Path::new(&cwd)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("/"))
    };
    cmd.cwd(target_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let mut mgr = state.lock().unwrap();
    mgr.next_id += 1;
    let id = mgr.next_id;
    mgr.sessions.insert(
        id,
        PtyInstance {
            writer,
            master: pair.master,
            child,
        },
    );
    drop(mgr);

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app.emit("pty://data", PtyOutput { id, data });
                }
            }
        }
        let _ = app.emit("pty://exit", id);
    });

    Ok(id)
}

#[tauri::command]
fn pty_write(state: State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    if let Some(inst) = mgr.sessions.get_mut(&id) {
        inst.writer
            .write_all(data.as_bytes())
            .and_then(|_| inst.writer.flush())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let mgr = state.lock().unwrap();
    if let Some(inst) = mgr.sessions.get(&id) {
        let _ = inst.master.resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(state: State<PtyState>, id: u32) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    if let Some(mut inst) = mgr.sessions.remove(&id) {
        let _ = inst.child.kill();
        let _ = inst.child.wait();
    }
    Ok(())
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

const HIDDEN: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".DS_Store",
    "dist",
    "build",
    ".next",
    ".turbo",
    "__pycache__",
    ".venv",
];

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| !HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()))
        .map(|e| {
            let p = e.path();
            Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                is_dir: p.is_dir(),
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
fn walk_files(root: String, limit: Option<usize>) -> Result<Vec<String>, String> {
    let max = limit.unwrap_or(2500);
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from(&root)];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .filter(|e| !HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()))
            .map(|e| e.path())
            .collect();
        children.sort();
        for p in children.into_iter().rev() {
            if p.is_symlink() {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                out.push(p.to_string_lossy().into_owned());
                if out.len() >= max {
                    return Ok(out);
                }
            }
        }
    }
    Ok(out)
}

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("path is a directory".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "file is too large ({:.1} MB > 5 MB limit)",
            meta.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("binary file cannot be opened as text".into());
    }
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".into())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn get_initial_workspace() -> Option<String> {
    std::env::var("MORMAKI_WORKSPACE")
        .ok()
        .or_else(|| std::env::args().nth(1))
        .filter(|p| Path::new(p).is_dir())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AcpState::default())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            acp_start,
            acp_send,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            list_dir,
            walk_files,
            read_file,
            write_file,
            remove_file,
            get_initial_workspace
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let state = app.state::<AcpState>();
                let mut acp = state.lock().unwrap();
                acp.stdin.take();
                if let Some(mut c) = acp.child.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                let pty_state = app.state::<PtyState>();
                let mut ptys = pty_state.lock().unwrap();
                for (_, mut inst) in ptys.sessions.drain() {
                    let _ = inst.child.kill();
                }
            }
        });
}
