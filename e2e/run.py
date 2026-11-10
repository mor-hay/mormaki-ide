#!/usr/bin/env python3
"""End-to-end tests for MorMaki IDE.

Drives the real release binary (real WKWebView, real Rust backend, real `maki acp`)
through the env-gated automation port (MORMAKI_E2E_PORT). Run: python3 e2e/run.py
"""
import json, os, shutil, subprocess, sys, time, urllib.request

HOME = os.path.expanduser("~")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "src-tauri/target/release/maki-ide")
WS = os.path.join(HOME, ".cache/mormaki-e2e/ws")
PORT = int(os.environ.get("MORMAKI_E2E_PORT", "17777"))
MODEL = os.environ.get("MORMAKI_E2E_MODEL", "anthropic/claude-haiku-4-5")
ONLY = [a for a in sys.argv[1:] if not a.startswith("-")]

HELPERS = r"""
if (!window.__t) {
  window.__t = {
    errors: [],
    q: (s) => document.querySelector(s),
    qa: (s) => [...document.querySelectorAll(s)],
    set(el, v) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    key(el, key, o = {}) { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o })); },
    md(el) { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); },
    ctx(el) {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 6 }));
    },
    need(s) { const el = document.querySelector(s); if (!el) throw new Error('missing element: ' + s); return el; },
    activeTab: () => document.querySelector('[data-testid=chat-tab].active'),
    agentText: () => [...document.querySelectorAll('[data-testid=msg-agent]')].map((e) => e.innerText).join('\n---\n'),
  };
  window.addEventListener('error', (e) => __t.errors.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => __t.errors.push('rejection: ' + String(e.reason)));
  const ce = console.error;
  console.error = (...a) => { __t.errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)); ce(...a); };
}
"""


class Fail(Exception):
    pass


def js(body, timeout=70):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/", data=(HELPERS + body).encode(), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode())
    if not out.get("ok"):
        raise Fail(f"JS failed: {out.get('error')}\n  in: {body.strip()[:200]}")
    return out.get("value")


def wait(cond, timeout=20, desc=None, interval=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = js(f"return ({cond});")
            if last:
                return last
        except Fail as e:
            last = str(e)
        time.sleep(interval)
    raise Fail(f"timeout after {timeout}s waiting for: {desc or cond} (last={str(last)[:200]})")


def check(cond, msg):
    if not cond:
        raise Fail(msg)


def read(rel):
    with open(os.path.join(WS, rel)) as f:
        return f.read()


def sh(cmd, cwd=WS):
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True).stdout.strip()


def click(sel):
    js(f"__t.need({json.dumps(sel)}).click();")


def set_input(sel, value):
    js(f"__t.set(__t.need({json.dumps(sel)}), {json.dumps(value)});")


def palette(command_id):
    js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'P', metaKey:true, shiftKey:true, bubbles:true}));")
    wait("!!__t.q('[data-testid=command-palette]')", 5, "command palette opens")
    click(f"[data-testid=palette-item][data-command={command_id}]")
    wait("!__t.q('[data-testid=command-palette]')", 5, "command palette closes")


def dialog_ok(text=None):
    wait("!!__t.q('[data-testid=dialog]')", 5, "dialog opens")
    if text is not None:
        set_input("[data-testid=dialog-input]", text)
    click("[data-testid=dialog-ok]")
    wait("!__t.q('[data-testid=dialog]')", 5, "dialog closes")


def tree_row(rel):
    return f"[data-testid=tree-row][data-path={json.dumps(os.path.join(WS, rel))}]"


def editor_value():
    return js("return window.__mormaki.editor.getModel().getValue();")


def chat_ready(timeout=60):
    wait(
        "(() => { const i = __t.q('[data-testid=chat-input]'); return i && !i.placeholder.startsWith('Connecting'); })()",
        timeout, "chat connected to maki",
    )


def send(text):
    set_input("[data-testid=chat-input]", text)
    click("[data-testid=chat-send]")


def wait_idle(timeout=180, allow=True):
    """Wait for the active chat to finish, answering permission prompts with 'allow'."""
    end = time.time() + timeout
    saw_permission = False
    time.sleep(0.4)
    while time.time() < end:
        st = js("""
          const t = __t.activeTab();
          const perm = __t.q('[data-testid=permission]');
          if (perm) {
            const b = __t.qa('[data-testid=perm-option]').find((x) => (x.dataset.kind || '').startsWith(%s));
            if (b) { b.click(); return 'permission'; }
          }
          return t && t.dataset.busy === '0' && !__t.q('[data-testid=queued]') ? 'idle' : 'busy';
        """ % json.dumps("allow" if allow else "reject"))
        if st == "permission":
            saw_permission = True
        if st == "idle":
            return saw_permission
        time.sleep(0.4)
    raise Fail(f"chat still busy after {timeout}s")


def acp_procs():
    out = sh("ps -axo pid=,ppid=,command= | grep 'maki acp' | grep -v grep", cwd="/")
    return [l for l in out.splitlines() if f" {APP.pid} " in l] if APP else []


def proc_env(pid):
    return sh(f"ps eww -o command= -p {pid}", cwd="/")


# ---------------------------------------------------------------- setup

APP = None


def setup_workspace():
    shutil.rmtree(WS, ignore_errors=True)
    os.makedirs(os.path.join(WS, "src/pkg"))
    files = {
        "hello.py": 'def greet(name):\n    return "Hello, " + name\n\n\nprint(greet("world"))\n',
        "src/util.ts": "export function add(a: number, b: number) {\n  return a + b; // needle_xyz\n}\n",
        "src/pkg/notes.md": "# Notes\n\nneedle_xyz appears here too.\nSecond line.\n",
        "README.md": "# E2E workspace\n\nUsed by MorMaki IDE tests.\n",
        "data.json": '{"name": "e2e", "items": [1, 2, 3]}\n',
    }
    for rel, content in files.items():
        with open(os.path.join(WS, rel), "w") as f:
            f.write(content)
    with open(os.path.join(WS, "blob.bin"), "wb") as f:
        f.write(b"\x00\x01\x02binary\x00")
    sh("git init -q -b main && git config user.email e2e@example.com && git config user.name E2E && git add -A && git commit -qm init")


def launch():
    global APP
    env = dict(os.environ, MORMAKI_E2E_PORT=str(PORT))
    log = open("/tmp/mormaki-e2e-app.log", "w")
    APP = subprocess.Popen([BIN, WS], env=env, stdout=log, stderr=subprocess.STDOUT)
    end = time.time() + 30
    while time.time() < end:
        try:
            js("return 1;", timeout=5)
            return
        except Exception:
            time.sleep(0.5)
    raise SystemExit("app did not start its automation port; see /tmp/mormaki-e2e-app.log")


def shutdown():
    if APP and APP.poll() is None:
        try:
            js(f"localStorage.removeItem('mormaki_chats:' + {json.dumps(WS)}); localStorage.removeItem('mormaki_active_chat:' + {json.dumps(WS)}); return 1;")
        except Exception:
            pass
        APP.terminate()
        try:
            APP.wait(8)
        except Exception:
            APP.kill()


# ---------------------------------------------------------------- tests

def t01_boot_and_layout():
    wait("!!__t.q('[data-testid=chat]') && !!__t.q('[data-testid=statusbar]')", 30, "main UI renders")
    wait(f"!!__t.q({json.dumps(tree_row('hello.py'))})", 15, "file tree lists hello.py")
    check(not js(f"return !!__t.q({json.dumps(tree_row('.git'))});"), ".git should be hidden in the tree")
    wait("__t.need('[data-testid=statusbar]').innerText.includes('main')", 10, "status bar shows git branch 'main'")
    m = js("""
      const r = (s) => { const b = __t.need(s).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
      return { w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
               side: r('.sidebar'), center: r('.center'), chat: r('[data-testid=chat]'), status: r('[data-testid=statusbar]'),
               input: r('[data-testid=chat-input]') };
    """)
    check(m["sw"] <= m["w"] and m["sh"] <= m["h"], f"page overflows the window: {m}")
    check(m["side"][0] == 0 and m["side"][2] > 150, f"sidebar not visible: {m['side']}")
    check(m["chat"][2] <= m["w"] + 1 and m["chat"][2] - m["chat"][0] >= 280, f"chat panel off-screen: {m['chat']}")
    check(m["center"][2] - m["center"][0] > 200, f"editor area too narrow: {m['center']}")
    check(m["status"][3] <= m["h"] + 1 and m["status"][1] > m["h"] - 40, f"status bar misplaced: {m['status']}")
    check(m["input"][3] <= m["status"][1] + 1, f"chat input hidden behind status bar: {m['input']}")
    return f"window {m['w']}x{m['h']}, no overflow"


def t02_open_file_and_highlight():
    click(tree_row("hello.py"))
    wait(f"__t.q('[data-testid=editor-tab].active')?.dataset.path === {json.dumps(os.path.join(WS, 'hello.py'))}", 10, "hello.py tab active")
    wait("window.__mormaki?.editor?.getModel()?.getValue().includes('def greet')", 10, "editor shows file content")
    lang = js("return window.__mormaki.editor.getModel().getLanguageId();")
    check(lang == "python", f"expected python language, got {lang}")
    wait("__t.qa('.monaco-editor .view-line span[class*=mtk]').length > 3", 10, "syntax tokens rendered")
    wait("__t.need('[data-testid=statusbar]').innerText.includes('python')", 5, "status bar shows language")
    return "python highlighted"


def t03_binary_file_refused():
    click(tree_row("blob.bin"))
    wait("(__t.q('[data-testid=toast]')?.innerText || '').includes('binary')", 5, "toast explains binary file")
    check(js("return __t.qa('[data-testid=editor-tab]').length;") == 1, "binary file must not open a tab")
    return "binary file rejected with a toast"


def t04_edit_save_via_palette():
    js("""const ed = window.__mormaki.editor; const m = ed.getModel();
          ed.executeEdits('e2e', [{ range: m.getFullModelRange(), text: m.getValue() + '# saved by e2e\\n' }]);""")
    wait("!!__t.q('[data-testid=editor-tab].active .dirty-dot')", 5, "dirty marker appears")
    check("# saved by e2e" not in read("hello.py"), "file changed on disk before save")
    palette("file-save")
    wait("!__t.q('[data-testid=editor-tab].active .dirty-dot')", 5, "dirty marker clears after save")
    check("# saved by e2e" in read("hello.py"), "save did not reach disk")
    wait("__t.need('[data-testid=view-git]').innerText.includes('1')", 10, "git badge counts the modified file")
    return "edit -> dirty -> save (command palette) -> on disk"


def t05_quick_open():
    js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', metaKey:true, bubbles:true}));")
    wait("!!__t.q('[data-testid=quick-open]')", 5, "quick open appears")
    set_input("[data-testid=quick-open] input", "util")
    wait("__t.qa('[data-testid=quick-open] .quick-item').length === 1", 5, "one match for 'util'")
    js("__t.key(__t.need('[data-testid=quick-open] input'), 'Enter');")
    wait(f"__t.q('[data-testid=editor-tab].active')?.dataset.path === {json.dumps(os.path.join(WS, 'src/util.ts'))}", 5, "util.ts opened")
    wait("window.__mormaki.editor.getModel().getLanguageId() === 'typescript'", 5, "typescript language")
    return "Cmd+P -> util.ts"


def t06_search_in_files():
    js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'f', metaKey:true, shiftKey:true, bubbles:true}));")
    wait("!!__t.q('[data-testid=search-input]') && __t.q('[data-testid=search-panel]').offsetParent !== null", 5, "search panel visible")
    set_input("[data-testid=search-input]", "needle_xyz")
    wait("__t.qa('[data-testid=search-hit]').length === 2", 10, "2 hits for needle_xyz")
    summary = js("return __t.need('[data-testid=search-summary]').innerText;")
    check("2 results in 2 files" in summary, f"unexpected summary: {summary}")
    js("__t.qa('[data-testid=search-hit]').find((h) => h.title.includes('notes.md')).click();")
    wait(f"__t.q('[data-testid=editor-tab].active')?.dataset.path === {json.dumps(os.path.join(WS, 'src/pkg/notes.md'))}", 5, "hit opens notes.md")
    wait("window.__mormaki.editor.getPosition().lineNumber === 3", 5, "cursor jumps to the hit line (3)")
    set_input("[data-testid=search-input]", "NEEDLE_XYZ")
    wait("__t.qa('[data-testid=search-hit]').length === 2", 10, "case-insensitive by default")
    click("[data-testid=search-panel] .icon-btn")
    wait("__t.need('[data-testid=search-summary]').innerText.startsWith('0 results')", 10, "match-case finds nothing for upper-case")
    click("[data-testid=view-files]")
    return "search, jump to line, match-case"


def t07_file_operations():
    click("[data-testid=tree-new-file]")
    dialog_ok("fresh_e2e.txt")
    wait(f"!!__t.q({json.dumps(tree_row('fresh_e2e.txt'))})", 5, "new file appears in tree")
    check(os.path.isfile(os.path.join(WS, "fresh_e2e.txt")), "new file missing on disk")
    wait(f"__t.q('[data-testid=editor-tab].active')?.dataset.path === {json.dumps(os.path.join(WS, 'fresh_e2e.txt'))}", 5, "new file opened")

    click("[data-testid=tree-new-file]")
    dialog_ok("fresh_e2e.txt")
    wait("(__t.q('[data-testid=toast]')?.innerText || '').includes('already exists')", 5, "duplicate name is refused")

    js(f"__t.ctx(__t.need({json.dumps(tree_row('fresh_e2e.txt'))}));")
    wait("!!__t.q('[data-testid=ctx-menu]')", 5, "context menu opens")
    click("[data-testid=ctx-rename]")
    dialog_ok("renamed_e2e.txt")
    wait(f"!!__t.q({json.dumps(tree_row('renamed_e2e.txt'))})", 5, "renamed file in tree")
    check(os.path.isfile(os.path.join(WS, "renamed_e2e.txt")) and not os.path.exists(os.path.join(WS, "fresh_e2e.txt")), "rename not on disk")
    wait(f"__t.q('[data-testid=editor-tab].active')?.dataset.path === {json.dumps(os.path.join(WS, 'renamed_e2e.txt'))}", 5, "open tab follows the rename")

    js(f"__t.ctx(__t.need({json.dumps(tree_row('src'))}));")
    click("[data-testid=ctx-new-folder]")
    dialog_ok("newdir_e2e")
    time.sleep(0.5)
    check(os.path.isdir(os.path.join(WS, "src/newdir_e2e")), "new folder missing on disk")

    js(f"__t.ctx(__t.need({json.dumps(tree_row('renamed_e2e.txt'))}));")
    click("[data-testid=ctx-delete]")
    dialog_ok()
    wait(f"!__t.q({json.dumps(tree_row('renamed_e2e.txt'))})", 5, "deleted file leaves the tree")
    check(not os.path.exists(os.path.join(WS, "renamed_e2e.txt")), "delete not on disk")
    check(js("return __t.qa('[data-testid=editor-tab]').every((t) => !t.dataset.path.endsWith('renamed_e2e.txt'));"), "tab of deleted file still open")
    trashed = os.path.join(HOME, ".Trash/renamed_e2e.txt")
    check(os.path.exists(trashed), "deleted file should be in the Trash, not destroyed")
    os.remove(trashed)
    os.rmdir(os.path.join(WS, "src/newdir_e2e"))
    return "create, duplicate refused, rename (tab follows), new folder, delete to Trash"


def t08_git_panel():
    click("[data-testid=view-git]")
    wait("__t.need('[data-testid=git-branch]').innerText.includes('main')", 10, "branch shown")
    wait("__t.qa('[data-testid=git-change-row]').length === 1", 10, "one changed file (hello.py)")
    click("[data-testid=git-change-row]")
    wait("!!__t.q('.review-tab') && __t.qa('.monaco-diff-editor').length > 0", 10, "diff view opens")
    wait("__t.qa('.monaco-diff-editor .line-insert, .monaco-diff-editor .char-insert').length > 0", 10, "diff shows the inserted line")
    check(js("return __t.need('[data-testid=git-commit]').disabled;"), "commit must be disabled with nothing staged")
    click("[data-testid=git-stage]")
    wait("__t.qa('[data-testid=git-staged-row]').length === 1 && __t.qa('[data-testid=git-change-row]').length === 0", 10, "file staged")
    check("M  hello.py" in sh("git status --porcelain"), "git index does not show the staged file")
    set_input("[data-testid=git-message]", "e2e: commit from MorMaki")
    click("[data-testid=git-commit]")
    wait("__t.qa('[data-testid=git-staged-row]').length === 0", 10, "staged list empties after commit")
    check("e2e: commit from MorMaki" in sh("git log -1 --format=%s"), "commit not in git log")
    check(sh("git status --porcelain") == "", "working tree should be clean after commit")
    wait("!__t.need('[data-testid=view-git]').innerText.match(/\\d/)", 10, "git badge clears")
    click("[data-testid=view-files]")
    return "status, diff, stage, commit (verified with git log)"


def term_text(key_expr="Object.keys(window.__mormaki.terms).slice(-1)[0]"):
    return js(f"""const t = window.__mormaki.terms[{key_expr}]; const b = t.buffer.active; let s = '';
                 for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s;""")


def t09_terminal():
    palette("terminal-toggle")
    wait("__t.qa('[data-testid=term-tab]').length === 1 && Object.keys(window.__mormaki.terms || {}).length === 1", 10, "terminal opens")
    time.sleep(1.5)
    js("const k = Object.keys(window.__mormaki.terms)[0]; window.__mormaki.terms[k].input('echo E2E_$((6*7)) && pwd\\r');")
    end = time.time() + 15
    out = ""
    while time.time() < end and "E2E_42" not in out:
        time.sleep(0.5)
        out = term_text()
    check("E2E_42" in out, f"shell did not run the command. terminal shows: {out[-300:]!r}")
    check(WS in out, "terminal did not start in the workspace folder")
    click("[data-testid=term-new]")
    wait("__t.qa('[data-testid=term-tab]').length === 2", 10, "second terminal tab")
    js(f"__t.ctx(__t.need({json.dumps(tree_row('src'))}));")
    js("__t.qa('[data-testid=ctx-menu] .ctx-item').find((x) => x.innerText.includes('Terminal')).click();")
    wait("__t.qa('[data-testid=term-tab]').length === 3 && Object.keys(window.__mormaki.terms).length === 3", 10, "terminal opened from the explorer context menu")
    time.sleep(1.5)
    js("const k = Object.keys(window.__mormaki.terms).slice(-1)[0]; window.__mormaki.terms[k].input('pwd\\r');")
    end = time.time() + 15
    out = ""
    while time.time() < end and (WS + "/src") not in out:
        time.sleep(0.5)
        out = term_text()
    check((WS + "/src") in out, f"context-menu terminal is not in the src folder: {out[-200:]!r}")
    m = js("const r = __t.need('.term-panel').getBoundingClientRect(); const s = __t.need('[data-testid=statusbar]').getBoundingClientRect(); return [r.height, r.bottom, s.top];")
    check(m[0] > 100 and m[1] <= m[2] + 1, f"terminal panel layout wrong: {m}")
    palette("terminal-toggle")
    wait("__t.need('.term-panel').offsetParent === null", 5, "terminal panel hides")
    return "shell runs commands, multiple tabs, 'Open in Terminal' uses the clicked folder"


def t10_chat_basic():
    chat_ready()
    wait("!!__t.q('[data-testid=model-btn]')", 30, "model picker loads")
    wait(f"""(async () => {{ __t.need('[data-testid=model-btn]').click(); await new Promise((r) => setTimeout(r, 150));
            const ok = !!__t.q('[data-testid=model-item][data-value="{MODEL}"]'); __t.need('[data-testid=model-btn]').click(); return ok; }})()""",
         40, f"{MODEL} appears in the model list", interval=1.5)
    click("[data-testid=model-btn]")
    set_input("[data-testid=model-search]", "opus 5.5 1m")
    n = js("return __t.qa('[data-testid=model-item]').map((x) => x.dataset.value);")
    check(n == ["anthropic/claude-opus-5-5-1m"], f"search 'opus 5.5 1m' should find exactly that model, got {n}")
    set_input("[data-testid=model-search]", MODEL.split("/")[-1])
    js(f"""__t.md(__t.need('[data-testid=model-item][data-value="{MODEL}"]'));""")
    wait(f"__t.need('[data-testid=model-btn]').title === {json.dumps(MODEL)}", 20, "model switched")
    send("Reply with exactly this text and nothing else: PONG_E2E")
    wait("__t.qa('[data-testid=msg-user]').length === 1", 5, "user message shown")
    wait_idle(90)
    text = js("return __t.agentText();")
    check("PONG_E2E" in text, f"unexpected reply: {text[:200]!r}")
    title = js("return __t.activeTab().innerText;")
    check("Reply with exactly" in title, f"chat tab should be titled from the first message, got {title!r}")
    return f"model picker search + switch to {MODEL.split('/')[-1]}, reply received"


def t11_chat_edit_review_reject():
    click(tree_row("hello.py"))
    before = read("hello.py")
    send("In hello.py rename the function `greet` to `greet_user` (definition and the call). Use your edit tools on the file. Do not run any command.")
    asked = wait_idle(180)
    after = read("hello.py")
    check("greet_user" in after, f"maki did not edit the file on disk: {after!r}")
    wait("__t.qa('[data-testid=op-edit], [data-testid=op-write]').length > 0", 5, "chat shows the edit as a code card")
    diff = js("return { add: __t.qa('[data-testid=tool-card] .cl-add').length, del: __t.qa('[data-testid=tool-card] .cl-del').length, text: __t.qa('[data-testid=tool-card] .cl-add').map((x) => x.innerText).join('|') };")
    check(diff["add"] > 0 and "greet_user" in diff["text"], f"diff lines missing in chat: {diff}")
    wait("(__t.q('[data-testid=changes-bar]')?.innerText || '').includes('hello.py')", 10, "review bar lists hello.py")
    wait("window.__mormaki.editor.getModel().getValue().includes('greet_user')", 10, "open editor tab reloads the edited file")
    js("__t.qa('[data-testid=changes-bar] .change a').find((a) => a.innerText.includes('hello.py')).click();")
    wait("!!__t.q('.review-tab') && __t.qa('.monaco-diff-editor').length > 0", 10, "review diff opens")
    js("__t.qa('[data-testid=changes-bar] .change').find((c) => c.innerText.includes('hello.py')).querySelectorAll('button')[1].click();")
    wait("!__t.q('[data-testid=changes-bar]')", 10, "review bar clears after reject")
    check(read("hello.py") == before, "Reject did not restore the original file content")
    return f"edit shown as diff (+{diff['add']}/-{diff['del']}), review bar, Reject restored the file" + (" (permission prompt answered)" if asked else "")


def t12_code_block_insert():
    click(tree_row("README.md"))
    wait("window.__mormaki.editor.getModel().getValue().includes('E2E workspace')", 10, "README open")
    send("Reply with only a fenced python code block containing exactly: print('INSERT_E2E')")
    wait_idle(90)
    wait("__t.qa('[data-testid=code-block]').length > 0", 5, "code block rendered")
    hl = js("return __t.qa('[data-testid=code-block] .cl span[class*=mtk]').length;")
    js("const b = __t.qa('[data-testid=code-block]').slice(-1)[0]; b.querySelector('[data-testid=code-insert]').click();")
    wait("window.__mormaki.editor.getModel().getValue().includes(\"INSERT_E2E\")", 5, "code inserted at cursor")
    js("window.__mormaki.editor.trigger('e2e', 'undo', null);")
    wait("!window.__mormaki.editor.getModel().getValue().includes('INSERT_E2E')", 5, "undo removes it")
    return f"code block rendered ({'highlighted' if hl else 'PLAIN TEXT, highlighting fell back'}), Insert works"


def t13_parallel_chats():
    first = js("return __t.activeTab().dataset.key;")
    click("[data-testid=chat-new]")
    wait("__t.qa('[data-testid=chat-tab]').length === 2", 5, "second chat tab")
    chat_ready()
    wait(f"__t.q('[data-testid=model-btn]')?.title === {json.dumps(MODEL)}", 30, "new chat inherits the model")
    second = js("return __t.activeTab().dataset.key;")
    check(len(acp_procs()) == 2, f"expected 2 maki acp processes, found {len(acp_procs())}")
    js(f"""__t.need('[data-testid=chat-tab][data-key="{first}"]').click();""")
    wait(f"__t.activeTab().dataset.key === {json.dumps(first)}", 5, "switch to chat 1")
    send("Write the numbers from 1 to 120 in English words, one per line. No tools.")
    js(f"""__t.need('[data-testid=chat-tab][data-key="{second}"]').click();""")
    wait(f"__t.activeTab().dataset.key === {json.dumps(second)}", 5, "switch to chat 2")
    check(js("return __t.qa('[data-testid=msg-user]').length;") == 0, "chat 2 must not show chat 1's messages")
    send("Write the numbers from 1 to 120 in English words, one per line. No tools. Then end with the line B_DONE.")
    both = wait("__t.qa('[data-testid=chat-tab]').every((t) => t.dataset.busy === '1')", 20, "both chats busy at the same time", interval=0.15)
    wait("__t.qa('[data-testid=chat-tab]').every((t) => t.dataset.busy === '0')", 180, "both chats finish")
    check("B_DONE" in js("return __t.agentText();"), "chat 2 reply missing")
    js(f"""__t.need('[data-testid=chat-tab][data-key="{first}"]').click();""")
    wait(f"__t.activeTab().dataset.key === {json.dumps(first)}", 5, "back to chat 1")
    t1 = js("return __t.agentText();").lower()
    check("one hundred" in t1 and "b_done" not in t1, "chat 1 reply wrong or mixed with chat 2")
    return "two chats streamed at the same time, replies stayed separate"


def t14_queue_and_stop():
    send("Write the numbers from 1 to 60 in English words, one per line. No tools.")
    wait("__t.activeTab().dataset.busy === '1'", 10, "chat busy")
    send("Reply with exactly: QUEUED_OK")
    wait("(__t.q('[data-testid=queued]')?.innerText || '').includes('QUEUED_OK')", 5, "second message is queued")
    wait_idle(180)
    check("QUEUED_OK" in js("return __t.agentText();"), "queued message was not sent after the first finished")
    send("Write the numbers from 1 to 400 in English words, one per line. No tools.")
    wait("__t.activeTab().dataset.busy === '1' && __t.qa('[data-testid=msg-agent]').length > 0", 30, "long reply streaming")
    time.sleep(1.5)
    click("[data-testid=chat-stop]")
    wait("__t.activeTab().dataset.busy === '0'", 15, "Stop ends the turn")
    return "queue while busy, then Stop cancels a running turn"


def t15_effort_restart_resume():
    orig = js("return localStorage.getItem('mormaki_effort');")
    n_before = js("return __t.qa('[data-testid=msg-user]').length;")
    click("[data-testid=effort-btn]")
    js("""__t.md(__t.need('[data-testid=effort-item][data-value="low"]'));""")
    wait("__t.need('[data-testid=effort-btn]').dataset.value === 'low'", 5, "effort shows Low")
    chat_ready(60)
    wait(f"__t.qa('[data-testid=msg-user]').length === {n_before}", 30, "conversation restored after restart")
    envs = [proc_env(l.split()[0]) for l in acp_procs()]
    check(any("MORMAKI_THINKING=low" in e for e in envs), "no maki process has MORMAKI_THINKING=low")
    check(sum("MORMAKI_THINKING=low" in e for e in envs) == 1, "effort should apply to one chat only")
    send("Reply with exactly: AFTER_EFFORT")
    wait_idle(90)
    check("AFTER_EFFORT" in js("return __t.agentText();"), "chat unusable after effort change")
    js(f"const v = {json.dumps(orig)}; if (v === null) localStorage.removeItem('mormaki_effort'); else localStorage.setItem('mormaki_effort', v);")
    return f"effort Low restarts maki with the env var, {n_before} earlier messages restored"


def t16_auto_run():
    click("[data-testid=yolo-btn]")
    wait("__t.need('[data-testid=yolo-btn]').dataset.on === '1'", 5, "auto-run on")
    chat_ready(60)
    check(any("--yolo" in l for l in acp_procs()), "maki was not restarted with --yolo")
    send("Use your write tool to create the file e2e_auto.txt containing exactly AUTO_OK. Do not run commands.")
    asked = wait_idle(120)
    check(not asked, "auto-run chat still asked for permission")
    check(os.path.isfile(os.path.join(WS, "e2e_auto.txt")) and "AUTO_OK" in read("e2e_auto.txt"), "file not created")
    wait("__t.qa('[data-testid=op-write]').length > 0", 5, "write shown as code card")
    wait("(__t.q('[data-testid=changes-bar]')?.innerText || '').includes('e2e_auto.txt')", 10, "new file is in the review bar")
    js("__t.qa('[data-testid=changes-bar] .change').find((c) => c.innerText.includes('e2e_auto.txt')).querySelectorAll('button')[1].click();")
    wait("!__t.q('[data-testid=changes-bar]')", 10, "review bar clears")
    check(not os.path.exists(os.path.join(WS, "e2e_auto.txt")), "Reject of a new file should delete it")
    return "auto-run: no prompt, file created, Reject removed the new file"


def t16b_reject_unopened_uncommitted_file():
    """Hardest Reject case: file not open in a tab, with local changes git does not know about."""
    local = '{"name": "local-uncommitted", "items": [1, 2, 3], "extra": true}\n'
    with open(os.path.join(WS, "data.json"), "w") as f:
        f.write(local)
    check(js("return __t.qa('[data-testid=editor-tab]').every((t) => !t.dataset.path.endsWith('data.json'));"), "data.json must not be open")
    send('In data.json change the value of "name" to "changed-by-ai" using your edit tool. Do not run commands.')
    wait_idle(120)
    check("changed-by-ai" in read("data.json"), "maki did not edit data.json")
    wait("(__t.q('[data-testid=changes-bar]')?.innerText || '').includes('data.json')", 10, "data.json in review bar")
    js("__t.qa('[data-testid=changes-bar] .change').find((c) => c.innerText.includes('data.json')).querySelectorAll('button')[1].click();")
    wait("!__t.q('[data-testid=changes-bar]')", 10, "review bar clears")
    got = read("data.json")
    check(got == local, f"Reject must restore the uncommitted local version, got: {got!r}")
    sh("git checkout -- data.json")
    return "Reject restored the exact pre-edit content, including uncommitted changes"


def t17_history_reopen():
    click("[data-testid=history-btn]")
    wait("__t.qa('[data-testid=history-item]').length >= 2", 20, "history lists past chats")
    click("[data-testid=history-btn]")
    second = js("return __t.qa('[data-testid=chat-tab]')[1].dataset.key;")
    js(f"""__t.need('[data-testid=chat-tab][data-key="{second}"]').click();""")
    wait(f"__t.activeTab().dataset.key === {json.dumps(second)}", 5, "chat 2 active")
    title = js("return __t.activeTab().innerText.trim().replace(/×$/, '').trim();")
    js(f"""__t.need('[data-testid=chat-tab][data-key="{second}"] .chat-tab-close').click();""")
    wait("__t.qa('[data-testid=chat-tab]').length === 1", 10, "chat 2 closed")
    time.sleep(4)
    check(len(acp_procs()) == 1, f"closed chat left its maki process running ({len(acp_procs())} alive)")
    click("[data-testid=history-btn]")
    wait("__t.qa('[data-testid=history-item]').length >= 2", 20, "history loads")
    js(f"""const it = __t.qa('[data-testid=history-item]').find((x) => !x.classList.contains('current') && x.innerText.includes({json.dumps(title[:20])}));
          if (!it) throw new Error('closed chat not in history: ' + __t.qa('[data-testid=history-item]').map((x) => x.innerText).join(' | '));
          __t.md(it);""")
    wait("__t.qa('[data-testid=chat-tab]').length === 2", 10, "reopened as a tab")
    wait("__t.agentText().includes('B_DONE')", 40, "old conversation replayed from history")
    return "closed chat stops its process and can be reopened from history with its messages"


def t18_reload_restores():
    tabs = js("return __t.qa('[data-testid=chat-tab]').length;")
    js("setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(2.5)
    wait("!!__t.q('[data-testid=chat]')", 30, "UI back after reload")
    wait(f"__t.qa('[data-testid=chat-tab]').length === {tabs}", 30, "chat tabs restored")
    chat_ready(60)
    wait("__t.qa('[data-testid=msg-user]').length > 0", 40, "messages restored after reload")
    time.sleep(3)
    check(len(acp_procs()) == tabs, f"expected {tabs} maki processes after reload, found {len(acp_procs())} (leak or missing)")
    return f"{tabs} chats and their messages restored, no leaked processes"


def t19_no_js_errors():
    errs = js("return __t.errors;")
    errs = [e for e in errs if "ResizeObserver" not in e]
    check(not errs, "JS errors during the session: " + " || ".join(errs[:5]))
    return "no uncaught JS errors since last reload"


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("t") and k[1:3].isdigit() and callable(v)]


def main():
    if not os.path.isfile(BIN):
        raise SystemExit("release binary missing; run: npm run tauri build -- --bundles app")
    setup_workspace()
    launch()
    results = []
    try:
        for t in TESTS:
            name = t.__name__
            if ONLY and not any(o in name for o in ONLY):
                continue
            t0 = time.time()
            try:
                note = t()
                results.append((name, True, note or "", time.time() - t0))
                print(f"PASS {name} ({time.time() - t0:.1f}s) {note or ''}", flush=True)
            except Exception as e:
                results.append((name, False, str(e), time.time() - t0))
                print(f"FAIL {name} ({time.time() - t0:.1f}s)\n     {e}", flush=True)
    finally:
        shutdown()
    ok = sum(1 for r in results if r[1])
    print(f"\n{ok}/{len(results)} passed")
    sys.exit(0 if ok == len(results) else 1)


if __name__ == "__main__":
    main()
