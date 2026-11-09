import "./monaco";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor, OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AcpClient, ConfigOption, ContentBlock, PermissionRequest, SessionUpdate, ToolCall } from "./acp";
import Chat, { ChatItem, ContextChip, PastedImage } from "./Chat";
import FileTree, { fileBadge } from "./FileTree";
import TerminalPanel, { TermSession } from "./TerminalPanel";
import { langFor } from "./monaco";
import "./App.css";

interface Tab {
  path: string;
  saved: string;
  value: string;
}

interface Change {
  before: string | null;
}

const rel = (root: string, p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
const readOrNull = (path: string) => invoke<string>("read_file", { path }).catch(() => null);

declare global {
  interface Window {
    __INITIAL_WORKSPACE__?: string;
  }
}

export default function App() {
  const [root, setRoot] = useState<string | null>(() => window.__INITIAL_WORKSPACE__ || localStorage.getItem("workspace"));
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);

  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem("sidebarW")) || 240);
  const [chatWidth, setChatWidth] = useState(() => Number(localStorage.getItem("chatW")) || 410);
  const [termHeight, setTermHeight] = useState(() => Number(localStorage.getItem("termH")) || 240);
  const [termVisible, setTermVisible] = useState(false);
  const [termSessions, setTermSessions] = useState<TermSession[]>([]);
  const [activeTermKey, setActiveTermKey] = useState<string>();

  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickIdx, setQuickIdx] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [model, setModel] = useState<ConfigOption>();
  const [modes, setModes] = useState<{ id: string; name: string }[]>([]);
  const [mode, setMode] = useState<string>();
  const [usage, setUsage] = useState<any>();
  const [context, setContext] = useState<ContextChip[]>([]);
  const [chatFocus, setChatFocus] = useState(0);
  const [effort, setEffort] = useState(() => localStorage.getItem("mormaki_effort") ?? "");
  const resumeRef = useRef<{ root: string; sessionId: string } | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);

  const [changes, setChanges] = useState<Record<string, Change>>({});
  const [review, setReview] = useState<{ path: string; before: string; after: string } | null>(null);
  const [inline, setInline] = useState<{ path: string; startLine: number; endLine: number; text: string } | null>(null);

  const acpRef = useRef<AcpClient>(undefined);
  const permResolve = useRef<(id: string | null) => void>(undefined);
  const toolKinds = useRef<Record<string, string | undefined>>({});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>(undefined);
  const pendingLineRef = useRef<number | undefined>(undefined);
  const termCounter = useRef(1);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 3200);
  }, []);

  const push = useCallback((item: ChatItem) => setItems((xs) => [...xs, item]), []);

  const appendText = useCallback((kind: "agent" | "thought" | "user", text: string) => {
    setItems((xs) => {
      const last = xs[xs.length - 1];
      if (last?.kind === kind) return [...xs.slice(0, -1), { kind, text: last.text + text }];
      return [...xs, { kind, text }];
    });
  }, []);

  const openTerminalInDir = useCallback(
    (dir?: string) => {
      const target = dir || root || "/";
      const key = `term-${Date.now()}-${termCounter.current++}`;
      const title = target.split("/").filter(Boolean).pop() || "zsh";
      setTermSessions((xs) => [...xs, { key, title, cwd: target }]);
      setActiveTermKey(key);
      setTermVisible(true);
    },
    [root],
  );

  const toggleTerminalPanel = useCallback(() => {
    if (!termVisible && termSessions.length === 0) {
      openTerminalInDir(root ?? "/");
    } else {
      setTermVisible((v) => !v);
    }
  }, [termVisible, termSessions.length, openTerminalInDir, root]);

  const closeTerminalSession = useCallback(
    (key: string) => {
      setTermSessions((xs) => {
        const next = xs.filter((s) => s.key !== key);
        if (activeTermKey === key) {
          setActiveTermKey(next[next.length - 1]?.key);
        }
        if (next.length === 0) {
          setTermVisible(false);
        }
        return next;
      });
    },
    [activeTermKey],
  );

  const refreshFiles = useCallback(async (dir: string) => {
    const files = await invoke<string[]>("walk_files", { root: dir, limit: 2500 }).catch(() => []);
    setWorkspaceFiles(files);
  }, []);

  useEffect(() => {
    invoke<string | null>("get_initial_workspace")
      .then((w) => {
        if (w) {
          localStorage.setItem("workspace", w);
          setRoot(w);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (root) refreshFiles(root);
  }, [root, treeRefresh, refreshFiles]);

  const snapshot = useCallback(async (path: string, before?: string | null) => {
    if (path in changesRef.current) return;
    const tab = tabsRef.current.find((t) => t.path === path);
    const base = before !== undefined ? before : tab ? tab.saved : await readOrNull(path);
    if (path in changesRef.current) return;
    changesRef.current = { ...changesRef.current, [path]: { before: base } };
    setChanges(changesRef.current);
  }, []);

  const reloadFromDisk = useCallback(async (path: string) => {
    const content = await readOrNull(path);
    if (content === null) {
      setTabs((ts) => ts.filter((t) => t.path !== path || t.value !== t.saved));
      return;
    }
    setTabs((ts) => ts.map((t) => (t.path === path && t.value === t.saved ? { ...t, saved: content, value: content } : t)));
  }, []);

  const upsertTool = useCallback((u: ToolCall) => {
    setItems((xs) => {
      const i = xs.findIndex((x) => x.kind === "tool" && x.call.toolCallId === u.toolCallId);
      if (i < 0) return [...xs, { kind: "tool", call: u }];
      const prev = (xs[i] as { kind: "tool"; call: ToolCall }).call;
      const next = [...xs];
      next[i] = {
        kind: "tool",
        call: { ...prev, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) },
      };
      return next;
    });
  }, []);

  const onUpdate = useCallback(
    (u: SessionUpdate) => {
      switch (u.sessionUpdate) {
        case "user_message_chunk":
          if (u.content?.type === "text") appendText("user", u.content.text);
          break;
        case "agent_message_chunk":
          if (u.content?.type === "text") appendText("agent", u.content.text);
          break;
        case "agent_thought_chunk":
          if (u.content?.type === "text") appendText("thought", u.content.text);
          break;
        case "tool_call":
        case "tool_call_update": {
          const call = u as unknown as ToolCall;
          if (call.kind) toolKinds.current[call.toolCallId] = call.kind;
          upsertTool(call);
          const isEdit = toolKinds.current[call.toolCallId] === "edit";
          for (const c of call.content ?? []) {
            if (c.type === "diff") snapshot(c.path as string, (c.oldText as string | null) ?? null);
          }
          if (isEdit && call.status !== "completed" && call.status !== "failed") {
            call.locations?.forEach((l) => snapshot(l.path));
          }
          if (call.status === "completed") {
            setTreeRefresh((n) => n + 1);
            call.locations?.forEach((l) => reloadFromDisk(l.path));
            tabsRef.current.forEach((t) => reloadFromDisk(t.path));
          }
          break;
        }
        case "plan":
          setItems((xs) => {
            const rest = xs.filter((x) => x.kind !== "plan");
            return [...rest, { kind: "plan", entries: u.entries }];
          });
          break;
        case "usage_update":
          setUsage(u);
          break;
        case "current_mode_update":
          setMode(u.currentModeId);
          break;
        case "config_option_update":
          setModel(u.configOptions?.find((o: ConfigOption) => o.id === "model"));
          break;
      }
    },
    [appendText, upsertTool, snapshot, reloadFromDisk],
  );

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    const client = new AcpClient({
      onUpdate,
      onPermission: (req) =>
        new Promise((resolve) => {
          setPermission(req);
          permResolve.current = resolve;
        }),
      onStderr: (line) => console.debug("[maki]", line),
      onExit: () => !cancelled && push({ kind: "error", text: "maki acp exited" }),
    });
    acpRef.current = client;
    const resume = resumeRef.current?.root === root ? resumeRef.current.sessionId : undefined;
    resumeRef.current = null;
    setItems([]);
    setSessionId(undefined);
    (async () => {
      try {
        await client.start(root, effort);
        let s: { sessionId?: string; modes?: any; configOptions?: ConfigOption[] } | null = null;
        if (resume) {
          try {
            s = (await client.loadSession(resume, root)) ?? {};
            s.sessionId = resume;
          } catch (e) {
            if (!cancelled) push({ kind: "error", text: `Could not resume chat, started a new one: ${String(e)}` });
          }
        }
        if (!s) s = await client.newSession(root);
        if (cancelled) return;
        setSessionId(s.sessionId);
        if (s.modes) {
          setModes(s.modes.availableModes ?? []);
          setMode(s.modes.currentModeId);
        }
        const m = s.configOptions?.find((o) => o.id === "model");
        if (m) setModel(m);
      } catch (e) {
        if (!cancelled) {
          const msg = String(e);
          if (msg.includes("workspace directory does not exist")) {
            localStorage.removeItem("workspace");
            setRoot(null);
            showToast("Workspace folder no longer exists");
          } else {
            push({ kind: "error", text: msg });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      client.dispose();
    };
  }, [root, effort, onUpdate, push, showToast]);

  sessionIdRef.current = sessionId;
  const changeEffort = useCallback(
    (next: string) => {
      if (next === effort || busy) return;
      if (root && sessionIdRef.current) resumeRef.current = { root, sessionId: sessionIdRef.current };
      localStorage.setItem("mormaki_effort", next);
      setEffort(next);
    },
    [effort, busy, root],
  );

  const startNewChat = useCallback(async () => {
    const client = acpRef.current;
    if (!client || !root || busy) return;
    try {
      const s = await client.newSession(root);
      setSessionId(s.sessionId);
      setItems([]);
      setUsage(undefined);
      setContext([]);
      if (s.modes) {
        setModes(s.modes.availableModes ?? []);
        setMode(s.modes.currentModeId);
      }
      const m = s.configOptions?.find((o) => o.id === "model");
      if (m) setModel(m);
    } catch (e) {
      push({ kind: "error", text: String(e) });
    }
  }, [root, busy, push]);

  const revealLine = useCallback((line?: number) => {
    if (!line || !editorRef.current) return;
    editorRef.current.revealLineInCenter(line);
    editorRef.current.setPosition({ lineNumber: line, column: 1 });
    editorRef.current.focus();
  }, []);

  const openFile = useCallback(
    async (path: string, line?: number) => {
      setReview(null);
      if (!tabsRef.current.some((t) => t.path === path)) {
        try {
          const content = await invoke<string>("read_file", { path });
          setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, saved: content, value: content }]));
        } catch (e) {
          showToast(`Cannot open ${path.split("/").pop()}: ${String(e)}`);
          return;
        }
      }
      setActive(path);
      if (line) {
        pendingLineRef.current = line;
        setTimeout(() => {
          if (pendingLineRef.current) {
            revealLine(pendingLineRef.current);
            pendingLineRef.current = undefined;
          }
        }, 60);
      }
    },
    [showToast, revealLine],
  );

  const closeTab = useCallback(
    (path: string) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (tab && tab.value !== tab.saved) {
        if (!window.confirm(`Discard unsaved changes in ${path.split("/").pop()}?`)) return;
      }
      setTabs((ts) => ts.filter((t) => t.path !== path));
      if (active === path) {
        const remaining = tabsRef.current.filter((t) => t.path !== path);
        setActive(remaining[remaining.length - 1]?.path);
      }
    },
    [active],
  );

  const save = useCallback(async () => {
    const uriPath = editorRef.current?.getModel()?.uri.path;
    const path = tabsRef.current.find((t) => t.path === uriPath)?.path ?? active;
    const t = tabsRef.current.find((x) => x.path === path);
    if (!t) return;
    try {
      await invoke("write_file", { path: t.path, content: t.value });
      setTabs((ts) => ts.map((x) => (x.path === t.path ? { ...x, saved: x.value } : x)));
      showToast(`Saved ${t.path.split("/").pop()}`);
    } catch (e) {
      showToast(`Failed to save: ${String(e)}`);
    }
  }, [active, showToast]);

  const attachFileToContext = useCallback(
    async (path: string) => {
      if (!root) return;
      const openTab = tabsRef.current.find((t) => t.path === path);
      const text = openTab ? openTab.value : await readOrNull(path);
      if (text === null) {
        showToast(`Could not attach ${path.split("/").pop()}`);
        return;
      }
      const label = rel(root, path);
      setContext((c) => (c.some((x) => x.label === label) ? c : [...c, { label, path, text }]));
      showToast(`Attached @${label} to chat`);
    },
    [root, showToast],
  );

  const send = useCallback(
    async (text: string, extra: ContextChip[] = context, images: PastedImage[] = []) => {
      const client = acpRef.current;
      if (!client || !sessionId || !root) return;
      const blocks: ContentBlock[] = [
        ...extra.map((c) => ({
          type: "resource" as const,
          resource: { uri: "file://" + c.path, text: c.text, mimeType: "text/plain" },
        })),
        ...images.map((im) => ({ type: "image" as const, mimeType: im.mimeType, data: im.data })),
        { type: "text" as const, text },
      ];
      push({
        kind: "user",
        text,
        context: extra.map((c) => c.label),
        images: images.map((im) => `data:${im.mimeType};base64,${im.data}`),
      });
      setContext([]);
      setBusy(true);
      try {
        const r = await client.prompt(sessionId, blocks);
        if (r.stopReason && r.stopReason !== "end_turn" && r.stopReason !== "cancelled") {
          push({ kind: "error", text: `stopped: ${r.stopReason}` });
        }
      } catch (e) {
        push({ kind: "error", text: String(e) });
      } finally {
        setBusy(false);
        setPermission(null);
      }
    },
    [context, sessionId, root, push],
  );

  const cancel = () => {
    if (sessionId) acpRef.current?.cancel(sessionId);
    permResolve.current?.(null);
    setPermission(null);
  };

  const answerPermission = (id: string | null) => {
    permResolve.current?.(id);
    setPermission(null);
  };

  const addSelectionToChat = useCallback(() => {
    const ed = editorRef.current;
    const path = ed?.getModel()?.uri.path;
    if (!ed || !path || !root) return;
    const sel = ed.getSelection();
    const m = ed.getModel()!;
    if (sel && !sel.isEmpty()) {
      const label = `${rel(root, path)}:${sel.startLineNumber}-${sel.endLineNumber}`;
      setContext((c) => [...c, { label, path, text: m.getValueInRange(sel) }]);
    } else {
      const label = rel(root, path);
      setContext((c) => (c.some((x) => x.label === label) ? c : [...c, { label, path, text: m.getValue() }]));
    }
    setChatFocus((n) => n + 1);
  }, [root]);

  const openInline = useCallback(() => {
    const ed = editorRef.current;
    const path = ed?.getModel()?.uri.path;
    if (!ed || !path) return;
    const sel = ed.getSelection()!;
    const startLine = sel.startLineNumber;
    const endLine = sel.isEmpty() ? sel.startLineNumber : sel.endLineNumber;
    const text = ed
      .getModel()!
      .getValueInRange(new monaco.Range(startLine, 1, endLine, ed.getModel()!.getLineMaxColumn(endLine)));
    setInline({ path, startLine, endLine, text });
  }, []);

  const submitInline = async (instruction: string) => {
    if (!inline || !root || !instruction.trim()) return;
    const { path, startLine, endLine, text } = inline;
    setInline(null);
    await save();
    await snapshot(path);
    const label = `${rel(root, path)}:${startLine}-${endLine}`;
    await send(
      `Edit ${path} lines ${startLine}-${endLine} (shown in the attached context) according to this instruction. ` +
        `Change only what is needed, then stop without a long explanation.\n\nInstruction: ${instruction}`,
      [{ label, path, text }],
    );
  };

  const handlers = useRef({ save, addSelectionToChat, openInline, toggleTerminalPanel });
  handlers.current = { save, addSelectionToChat, openInline, toggleTerminalPanel };

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.save());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => handlers.current.addSelectionToChat());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => handlers.current.openInline());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => handlers.current.toggleTerminalPanel());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => {
      setQuickQuery("");
      setQuickIdx(0);
      setQuickOpen(true);
    });
    if (pendingLineRef.current) {
      revealLine(pendingLineRef.current);
      pendingLineRef.current = undefined;
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickQuery("");
        setQuickIdx(0);
        setQuickOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        handlers.current.toggleTerminalPanel();
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        handlers.current.toggleTerminalPanel();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handlers.current.save();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w" && active) {
        e.preventDefault();
        closeTab(active);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, closeTab]);

  const openReview = async (path: string) => {
    const after = (await readOrNull(path)) ?? "";
    setReview({ path, before: changes[path]?.before ?? "", after });
  };

  const resolveChange = async (path: string, accept: boolean) => {
    const ch = changesRef.current[path];
    if (!accept && ch) {
      if (ch.before === null) {
        await invoke("remove_file", { path }).catch(() => {});
        setTabs((ts) => ts.filter((t) => t.path !== path));
        if (active === path) setActive(tabsRef.current.find((t) => t.path !== path)?.path);
      } else {
        await invoke("write_file", { path, content: ch.before });
        setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, saved: ch.before!, value: ch.before! } : t)));
      }
      setTreeRefresh((n) => n + 1);
    }
    const { [path]: _, ...rest } = changesRef.current;
    changesRef.current = rest;
    setChanges(rest);
    if (review?.path === path) setReview(null);
  };

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true });
    if (typeof dir === "string") {
      localStorage.setItem("workspace", dir);
      setTabs([]);
      setActive(undefined);
      changesRef.current = {};
      setChanges({});
      setReview(null);
      setRoot(dir);
    }
  };

  const startResize = (side: "left" | "right", startX: number) => {
    const initW = side === "left" ? sidebarWidth : chatWidth;
    const onMove = (e: MouseEvent) => {
      if (side === "left") {
        const w = Math.min(480, Math.max(160, initW + (e.clientX - startX)));
        setSidebarWidth(w);
        localStorage.setItem("sidebarW", String(w));
      } else {
        const w = Math.min(720, Math.max(280, initW - (e.clientX - startX)));
        setChatWidth(w);
        localStorage.setItem("chatW", String(w));
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startTermResize = (startY: number) => {
    const initH = termHeight;
    const onMove = (e: MouseEvent) => {
      const h = Math.min(window.innerHeight * 0.75, Math.max(110, initH - (e.clientY - startY)));
      setTermHeight(h);
      localStorage.setItem("termH", String(h));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const quickMatches = useMemo(() => {
    if (!root) return [];
    const q = quickQuery.trim().toLowerCase();
    return workspaceFiles
      .map((full) => ({ full, rel: rel(root, full) }))
      .filter((x) => !q || x.rel.toLowerCase().includes(q))
      .slice(0, 20);
  }, [quickQuery, workspaceFiles, root]);

  if (!root) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <h1>MorMaki IDE</h1>
          <p>Cursor-like AI code editor powered by maki ACP</p>
          <button className="primary lg" onClick={pickFolder}>
            Open Workspace Folder…
          </button>
        </div>
      </div>
    );
  }

  const tab = tabs.find((t) => t.path === active);
  const changedPaths = Object.keys(changes);
  const dirtyPaths = tabs.filter((t) => t.value !== t.saved).map((t) => t.path);

  return (
    <div className="layout" style={{ gridTemplateColumns: `${sidebarWidth}px 4px minmax(0, 1fr) 4px ${chatWidth}px` }}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <span className="brand-pill">MorMaki</span>
          <button className="folder-btn" onClick={pickFolder}>
            📁 Switch Folder…
          </button>
        </div>
        <FileTree
          root={root}
          onOpen={(p) => openFile(p)}
          onOpenTerminal={(dir) => openTerminalInDir(dir)}
          onAttachChat={(p) => attachFileToContext(p)}
          onRefresh={() => setTreeRefresh((n) => n + 1)}
          onQuickOpen={() => {
            setQuickQuery("");
            setQuickIdx(0);
            setQuickOpen(true);
          }}
          active={active}
          refresh={treeRefresh}
          changedPaths={changedPaths}
          dirtyPaths={dirtyPaths}
        />
      </aside>

      <div className="sash" onMouseDown={(e) => startResize("left", e.clientX)} />

      <main className="center">
        <div className="tabs-bar">
          <div className="tabs">
            {tabs.map((t) => {
              const name = t.path.split("/").pop() ?? t.path;
              const badge = fileBadge(name);
              return (
                <div
                  key={t.path}
                  className={"tab" + (t.path === active && !review ? " active" : "")}
                  title={rel(root, t.path)}
                  onClick={() => openFile(t.path)}
                >
                  <span className="file-badge" style={{ color: badge.color }}>
                    {badge.label}
                  </span>
                  <span>{name}</span>
                  {t.value !== t.saved && <span className="dirty-dot">●</span>}
                  <span
                    className="close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.path);
                    }}
                  >
                    ×
                  </span>
                </div>
              );
            })}
            {review && (
              <div className="tab active review-tab">
                <span>⇄ Diff: {review.path.split("/").pop()}</span>
                <span className="close" onClick={() => setReview(null)}>
                  ×
                </span>
              </div>
            )}
          </div>
          <div className="tabs-right">
            <button
              className={"ghost-btn" + (termVisible ? " primary-text" : "")}
              onClick={toggleTerminalPanel}
              title="Toggle Terminal Panel (⌘J or Ctrl+`)"
            >
              $_ Terminal {termSessions.length > 0 ? `(${termSessions.length})` : ""}
            </button>
          </div>
        </div>

        {(tab || review) && (
          <div className="breadcrumbs">
            <span>{rel(root, review ? review.path : tab!.path)}</span>
            {!review && tab && (
              <div className="editor-actions">
                <button
                  className="ghost-btn"
                  onClick={() => {
                    const idx = tab.path.lastIndexOf("/");
                    openTerminalInDir(idx > 0 ? tab.path.slice(0, idx) : root);
                  }}
                  title="Open Terminal in File Folder"
                >
                  $_ Term Here
                </button>
                <button className="ghost-btn" onClick={openInline} title="Inline Edit (⌘K)">
                  ⌘K Edit
                </button>
                <button className="ghost-btn" onClick={addSelectionToChat} title="Add to Chat (⌘L)">
                  ⌘L Chat
                </button>
                {tab.value !== tab.saved && (
                  <button className="ghost-btn primary-text" onClick={save} title="Save (⌘S)">
                    ⌘S Save
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {changedPaths.length > 0 && (
          <div className="changes-bar">
            <span className="changes-label">✦ {changedPaths.length} file(s) modified</span>
            <div className="changes-list">
              {changedPaths.map((p) => (
                <span key={p} className={"change" + (review?.path === p ? " active" : "")}>
                  <a onClick={() => openReview(p)} title="Click to view diff">
                    {rel(root, p)}
                  </a>
                  <button className="xs ok" onClick={() => resolveChange(p, true)} title="Keep changes">
                    ✓
                  </button>
                  <button className="xs" onClick={() => resolveChange(p, false)} title="Revert changes">
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="changes-bulk">
              <button className="primary xs" onClick={() => changedPaths.forEach((p) => resolveChange(p, true))}>
                Accept all
              </button>
              <button className="xs" onClick={() => changedPaths.forEach((p) => resolveChange(p, false))}>
                Reject all
              </button>
            </div>
          </div>
        )}

        <div className="editor-wrap">
          {inline && (
            <form
              className="inline-edit"
              onSubmit={(e) => {
                e.preventDefault();
                submitInline((e.currentTarget.elements.namedItem("q") as HTMLInputElement).value);
              }}
            >
              <span className="inline-badge">
                ⌘K {inline.path.split("/").pop()}:{inline.startLine}-{inline.endLine}
              </span>
              <input
                name="q"
                autoFocus
                placeholder="Describe how to edit these lines… (Enter to run, Esc to cancel)"
                onKeyDown={(e) => e.key === "Escape" && setInline(null)}
              />
              <button type="submit" className="primary xs">
                Run
              </button>
              <button type="button" className="xs" onClick={() => setInline(null)}>
                Esc
              </button>
            </form>
          )}
          {review ? (
            <DiffEditor
              theme="vs-dark"
              original={review.before}
              modified={review.after}
              language={langFor(review.path)}
              options={{ readOnly: true, renderSideBySide: false, automaticLayout: true, fontSize: 13 }}
            />
          ) : tab ? (
            <Editor
              theme="vs-dark"
              path={tab.path}
              value={tab.value}
              language={langFor(tab.path)}
              onMount={onMount}
              onChange={(v) => setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, value: v ?? "" } : t)))}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineHeight: 20,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                padding: { top: 8 },
              }}
            />
          ) : (
            <div className="empty">
              <div className="empty-card">
                <div className="empty-logo">MorMaki IDE</div>
                <div className="empty-shortcuts">
                  <div>
                    <kbd>⌘P</kbd> Quick Open File
                  </div>
                  <div>
                    <kbd>⌘J</kbd> Toggle Integrated Terminal
                  </div>
                  <div>
                    <kbd>⌘K</kbd> Inline AI Edit
                  </div>
                  <div>
                    <kbd>⌘L</kbd> Add Code to Chat
                  </div>
                  <div>
                    <kbd>Right-Click</kbd> Open Folder/File in Terminal
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {termVisible && <div className="sash-h" onMouseDown={(e) => startTermResize(e.clientY)} />}

        <div style={{ height: termVisible ? termHeight : 0, flexShrink: 0, overflow: "hidden" }}>
          <TerminalPanel
            sessions={termSessions}
            activeKey={activeTermKey}
            visible={termVisible}
            onSelect={setActiveTermKey}
            onClose={closeTerminalSession}
            onNew={() => {
              const activeSession = termSessions.find((s) => s.key === activeTermKey);
              openTerminalInDir(activeSession?.cwd ?? root);
            }}
            onToggle={() => setTermVisible(false)}
          />
        </div>
      </main>

      <div className="sash" onMouseDown={(e) => startResize("right", e.clientX)} />

      <Chat
        items={items}
        busy={busy}
        ready={!!sessionId}
        permission={permission}
        onPermission={answerPermission}
        onSend={(t, imgs) => send(t, context, imgs)}
        onCancel={cancel}
        onNewChat={startNewChat}
        onOpenPath={openFile}
        context={context}
        onRemoveContext={(i) => setContext((c) => c.filter((_, j) => j !== i))}
        onAttachFile={attachFileToContext}
        workspaceFiles={workspaceFiles}
        root={root}
        model={model}
        onModel={(v) =>
          sessionId &&
          acpRef.current?.setConfigOption(sessionId, "model", v).then(
            (r: any) => setModel(r?.configOptions?.find((o: ConfigOption) => o.id === "model") ?? { ...model!, currentValue: v }),
            (e) => push({ kind: "error", text: String(e) }),
          )
        }
        mode={mode}
        modes={modes}
        onMode={(id) =>
          sessionId &&
          acpRef.current?.setMode(sessionId, id).then(
            () => setMode(id),
            (e) => push({ kind: "error", text: String(e) }),
          )
        }
        usage={usage}
        effort={effort}
        onEffort={changeEffort}
        focusKey={chatFocus}
      />

      {quickOpen && (
        <div className="modal-backdrop" onClick={() => setQuickOpen(false)}>
          <div className="quick-open" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={quickQuery}
              placeholder="Search files by name… (↑↓ to navigate, Enter to open)"
              onChange={(e) => {
                setQuickQuery(e.target.value);
                setQuickIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuickOpen(false);
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setQuickIdx((i) => (quickMatches.length ? (i + 1) % quickMatches.length : 0));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setQuickIdx((i) => (quickMatches.length ? (i - 1 + quickMatches.length) % quickMatches.length : 0));
                } else if (e.key === "Enter" && quickMatches[quickIdx]) {
                  e.preventDefault();
                  openFile(quickMatches[quickIdx].full);
                  setQuickOpen(false);
                }
              }}
            />
            <div className="quick-list">
              {quickMatches.length === 0 ? (
                <div className="quick-empty">No matching files</div>
              ) : (
                quickMatches.map((m, idx) => {
                  const name = m.rel.split("/").pop() ?? m.rel;
                  const badge = fileBadge(name);
                  return (
                    <div
                      key={m.full}
                      className={"quick-item" + (idx === quickIdx ? " active" : "")}
                      onMouseEnter={() => setQuickIdx(idx)}
                      onClick={() => {
                        openFile(m.full);
                        setQuickOpen(false);
                      }}
                    >
                      <span className="file-badge" style={{ color: badge.color }}>
                        {badge.label}
                      </span>
                      <span className="quick-name">{name}</span>
                      <span className="quick-rel">{m.rel}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
