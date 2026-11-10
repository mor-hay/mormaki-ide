use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct AcpProc {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct Acp {
    next_id: u64,
    procs: HashMap<u64, AcpProc>,
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

#[derive(Serialize, Clone)]
struct AcpLine {
    id: u64,
    line: String,
}

fn stop_gracefully(mut child: Child, stdin: Option<ChildStdin>) {
    drop(stdin);
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    });
}

#[tauri::command]
fn acp_start(
    app: AppHandle,
    state: State<AcpState>,
    cwd: String,
    thinking: Option<String>,
    yolo: Option<bool>,
) -> Result<u64, String> {
    if !Path::new(&cwd).is_dir() {
        return Err(format!("workspace directory does not exist: {cwd}"));
    }
    let mut cmd = Command::new(find_maki());
    cmd.arg("acp").current_dir(&cwd);
    if yolo.unwrap_or(false) {
        cmd.arg("--yolo");
    }
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
    let stdin = child.stdin.take();

    let mut acp = state.lock().unwrap();
    acp.next_id += 1;
    let id = acp.next_id;
    acp.procs.insert(id, AcpProc { child, stdin });
    drop(acp);

    let out_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = out_app.emit("acp://message", AcpLine { id, line });
        }
        eprintln!("[maki acp #{id}] stdout closed");
        let _ = out_app.emit("acp://exit", id);
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[maki acp #{id}] {line}");
            let _ = app.emit("acp://stderr", AcpLine { id, line });
        }
    });
    Ok(id)
}

#[tauri::command]
fn acp_send(state: State<AcpState>, id: u64, line: String) -> Result<(), String> {
    let mut acp = state.lock().unwrap();
    let proc_ = acp.procs.get_mut(&id).ok_or("maki acp is not running")?;
    let stdin = proc_.stdin.as_mut().ok_or("maki acp is not running")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn acp_stop(state: State<AcpState>, id: u64) {
    if let Some(p) = state.lock().unwrap().procs.remove(&id) {
        stop_gracefully(p.child, p.stdin);
    }
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

#[derive(Serialize)]
struct InitialWorkspace {
    path: Option<String>,
    e2e: bool,
}

#[tauri::command]
fn get_initial_workspace() -> InitialWorkspace {
    InitialWorkspace {
        path: std::env::var("MORMAKI_WORKSPACE")
            .ok()
            .or_else(|| std::env::args().nth(1))
            .filter(|p| Path::new(p).is_dir()),
        e2e: std::env::var("MORMAKI_E2E_PORT").is_ok(),
    }
}

#[derive(Serialize)]
struct FileMeta {
    exists: bool,
    created_ms: f64,
    modified_ms: f64,
}

fn to_ms(t: std::io::Result<std::time::SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[tauri::command]
fn file_meta(path: String) -> FileMeta {
    match std::fs::metadata(&path) {
        Ok(m) => FileMeta { exists: true, created_ms: to_ms(m.created()), modified_ms: to_ms(m.modified()) },
        Err(_) => FileMeta { exists: false, created_ms: 0.0, modified_ms: 0.0 },
    }
}

/// Called when the UI (re)loads: a page reload never runs JS cleanup, so stop whatever
/// the previous page left behind. maki only saves a session on a clean exit, so wait for it.
#[tauri::command(async)]
fn reset_backend(acp: State<AcpState>, pty: State<PtyState>) {
    for (_, mut inst) in pty.lock().unwrap().sessions.drain() {
        let _ = inst.child.kill();
    }
    let mut children: Vec<Child> = acp
        .lock()
        .unwrap()
        .procs
        .drain()
        .map(|(_, mut p)| {
            p.stdin.take();
            p.child
        })
        .collect();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while std::time::Instant::now() < deadline
        && children.iter_mut().any(|c| !matches!(c.try_wait(), Ok(Some(_))))
    {
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    for c in children.iter_mut() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err("a file or folder with that name already exists".into());
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("a file or folder with that name already exists".into());
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("a file or folder with that name already exists".into());
    }
    if let Some(parent) = Path::new(&to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Moves to the user's Trash instead of deleting, so a mistaken delete is recoverable.
#[tauri::command]
fn trash_path(path: String) -> Result<String, String> {
    let src = Path::new(&path);
    if !src.exists() {
        return Err("path does not exist".into());
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let trash = Path::new(&home).join(".Trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "item".into());
    let mut dest = trash.join(&name);
    let mut n = 1;
    while dest.exists() {
        n += 1;
        dest = trash.join(format!("{name} {n}"));
    }
    std::fs::rename(src, &dest).map_err(|e| format!("could not move to Trash: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct SearchHit {
    path: String,
    line: usize,
    col: usize,
    text: String,
}

#[derive(Serialize)]
struct SearchResult {
    hits: Vec<SearchHit>,
    files_scanned: usize,
    truncated: bool,
}

#[tauri::command(async)]
fn search_text(root: String, query: String, case_sensitive: Option<bool>, limit: Option<usize>) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult { hits: vec![], files_scanned: 0, truncated: false });
    }
    let cs = case_sensitive.unwrap_or(false);
    let needle = if cs { query.clone() } else { query.to_lowercase() };
    let max = limit.unwrap_or(500);
    let files = walk_files(root, Some(20000))?;
    let mut hits = Vec::new();
    let mut scanned = 0;
    for f in files {
        let Ok(meta) = std::fs::metadata(&f) else { continue };
        if meta.len() > 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&f) else { continue };
        if bytes.iter().take(8000).any(|&b| b == 0) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else { continue };
        scanned += 1;
        for (i, line) in text.lines().enumerate() {
            let hay = if cs { std::borrow::Cow::Borrowed(line) } else { std::borrow::Cow::Owned(line.to_lowercase()) };
            if let Some(byte_col) = hay.find(&needle) {
                let col = hay[..byte_col].chars().count() + 1;
                let shown: String = line.trim_end().chars().take(240).collect();
                hits.push(SearchHit { path: f.clone(), line: i + 1, col, text: shown });
                if hits.len() >= max {
                    return Ok(SearchResult { hits, files_scanned: scanned, truncated: true });
                }
            }
        }
    }
    Ok(SearchResult { hits, files_scanned: scanned, truncated: false })
}

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err })
    }
}

#[derive(Serialize)]
struct GitFile {
    path: String,
    index: String,
    worktree: String,
}

#[derive(Serialize, Default)]
struct GitStatus {
    is_repo: bool,
    branch: String,
    files: Vec<GitFile>,
}

#[tauri::command(async)]
fn git_status(root: String) -> GitStatus {
    let Ok(out) = git(&root, &["status", "--porcelain=v1", "-b", "-uall", "-z"]) else {
        return GitStatus::default();
    };
    let mut st = GitStatus { is_repo: true, ..Default::default() };
    let mut parts = out.split('\0');
    while let Some(entry) = parts.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(b) = entry.strip_prefix("## ") {
            let b = b.strip_prefix("No commits yet on ").unwrap_or(b);
            st.branch = b.split("...").next().unwrap_or(b).to_string();
            continue;
        }
        if entry.len() < 4 {
            continue;
        }
        let (xy, path) = entry.split_at(3);
        let mut chars = xy.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        if x == 'R' || x == 'C' {
            parts.next();
        }
        st.files.push(GitFile {
            path: Path::new(&root).join(path).to_string_lossy().into_owned(),
            index: x.to_string(),
            worktree: y.to_string(),
        });
    }
    st
}

fn rel_to(root: &str, path: &str) -> String {
    Path::new(path)
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

#[tauri::command(async)]
fn git_show_head(root: String, path: String) -> Option<String> {
    git(&root, &["show", &format!("HEAD:{}", rel_to(&root, &path))]).ok()
}

#[tauri::command(async)]
fn git_stage(root: String, paths: Vec<String>, stage: bool) -> Result<(), String> {
    let rels: Vec<String> = paths.iter().map(|p| rel_to(&root, p)).collect();
    let mut args: Vec<&str> = if stage { vec!["add", "-A", "--"] } else { vec!["reset", "-q", "--"] };
    args.extend(rels.iter().map(String::as_str));
    match git(&root, &args) {
        Ok(_) => Ok(()),
        Err(_) if !stage => {
            let mut a = vec!["rm", "-r", "-q", "--cached", "--"];
            a.extend(rels.iter().map(String::as_str));
            git(&root, &a).map(|_| ())
        }
        Err(e) => Err(e),
    }
}

#[tauri::command(async)]
fn git_commit(root: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
    git(&root, &["commit", "-m", &message])
}

#[tauri::command(async)]
fn git_discard(root: String, path: String) -> Result<(), String> {
    let rel = rel_to(&root, &path);
    if git(&root, &["ls-files", "--error-unmatch", "--", &rel]).is_ok() {
        git(&root, &["checkout", "HEAD", "--", &rel]).map(|_| ())
    } else {
        trash_path(path).map(|_| ())
    }
}

#[derive(Default)]
struct E2eState {
    next_id: u64,
    waiting: HashMap<u64, std::sync::mpsc::Sender<String>>,
}

#[tauri::command]
fn e2e_result(state: State<Mutex<E2eState>>, id: u64, json: String) {
    if let Some(tx) = state.lock().unwrap().waiting.remove(&id) {
        let _ = tx.send(json);
    }
}

/// Test-only automation port. Off unless MORMAKI_E2E_PORT is set; bound to loopback.
/// Each request body is the body of an async JS function run in the real webview.
fn start_e2e_server(app: AppHandle, port: u16) {
    use tauri::Manager;
    std::thread::spawn(move || {
        let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) else {
            eprintln!("[e2e] could not bind port {port}");
            return;
        };
        eprintln!("[e2e] automation server on 127.0.0.1:{port}");
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut len = 0usize;
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; len];
                if reader.read_exact(&mut body).is_err() {
                    return;
                }
                let js = String::from_utf8_lossy(&body);
                let (tx, rx) = std::sync::mpsc::channel();
                let id = {
                    let state = app.state::<Mutex<E2eState>>();
                    let mut st = state.lock().unwrap();
                    st.next_id += 1;
                    let id = st.next_id;
                    st.waiting.insert(id, tx);
                    id
                };
                let script = format!(
                    "(async()=>{{let r;try{{r={{ok:true,value:await (async()=>{{{js}\n}})()}}}}catch(e){{r={{ok:false,error:String((e&&e.stack)||e)}}}}\
                     let j;try{{j=JSON.stringify(r)}}catch(e){{j=JSON.stringify({{ok:false,error:'unserializable result'}})}}\
                     window.__TAURI_INTERNALS__.invoke('e2e_result',{{id:{id},json:j===undefined?'{{\"ok\":true}}':j}})}})()"
                );
                let reply = match app.get_webview_window("main") {
                    Some(w) if w.eval(&script).is_ok() => rx
                        .recv_timeout(std::time::Duration::from_secs(60))
                        .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"timeout waiting for webview\"}".into()),
                    _ => "{\"ok\":false,\"error\":\"no main window\"}".into(),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.len(),
                    reply
                );
            });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AcpState::default())
        .manage(PtyState::default())
        .manage(Mutex::new(E2eState::default()))
        .setup(|app| {
            if let Some(port) = std::env::var("MORMAKI_E2E_PORT").ok().and_then(|p| p.parse().ok()) {
                start_e2e_server(app.handle().clone(), port);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            acp_start,
            acp_send,
            acp_stop,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            list_dir,
            walk_files,
            read_file,
            write_file,
            remove_file,
            get_initial_workspace,
            create_file,
            create_dir,
            rename_path,
            trash_path,
            search_text,
            git_status,
            git_show_head,
            git_stage,
            git_commit,
            git_discard,
            e2e_result,
            file_meta,
            reset_backend
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let state = app.state::<AcpState>();
                let mut acp = state.lock().unwrap();
                let mut children: Vec<Child> = acp
                    .procs
                    .drain()
                    .map(|(_, mut p)| {
                        p.stdin.take();
                        p.child
                    })
                    .collect();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                while std::time::Instant::now() < deadline
                    && children.iter_mut().any(|c| !matches!(c.try_wait(), Ok(Some(_))))
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                for c in children.iter_mut() {
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
