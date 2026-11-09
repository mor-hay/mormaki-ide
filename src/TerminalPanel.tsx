import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

export interface TermSession {
  key: string;
  title: string;
  cwd: string;
}

interface Props {
  sessions: TermSession[];
  activeKey?: string;
  visible: boolean;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
  onToggle: () => void;
}

function TermInstance({
  session,
  active,
  visible,
  onExited,
}: {
  session: TermSession;
  active: boolean;
  visible: boolean;
  onExited: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon>(undefined);
  const termRef = useRef<Terminal>(undefined);
  const ptyIdRef = useRef<number>(undefined);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.25,
      theme: {
        background: "#121215",
        foreground: "#e4e4e7",
        cursor: "#3b82f6",
        selectionBackground: "rgba(59, 130, 246, 0.3)",
        black: "#18181b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e4e4e7",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    (async () => {
      try {
        const id = await invoke<number>("pty_spawn", {
          cwd: session.cwd,
          cols: term.cols || 80,
          rows: term.rows || 24,
        });
        if (disposed) {
          invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        ptyIdRef.current = id;

        unlistenData = await listen<{ id: number; data: string }>("pty://data", (ev) => {
          if (ev.payload.id === id) term.write(ev.payload.data);
        });
        unlistenExit = await listen<number>("pty://exit", (ev) => {
          if (ev.payload === id) {
            term.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
            onExited();
          }
        });

        term.onData((data) => {
          invoke("pty_write", { id, data }).catch(() => {});
        });

        term.onResize(({ cols, rows }) => {
          invoke("pty_resize", { id, cols, rows }).catch(() => {});
        });
      } catch (e) {
        term.writeln(`\x1b[31mFailed to spawn shell: ${String(e)}\x1b[0m`);
      }
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore layout race
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      if (ptyIdRef.current !== undefined) {
        invoke("pty_kill", { id: ptyIdRef.current }).catch(() => {});
      }
      term.dispose();
    };
  }, [session.key]);

  useEffect(() => {
    if (active && visible) {
      setTimeout(() => {
        try {
          fitRef.current?.fit();
          termRef.current?.focus();
        } catch {
          // ignore
        }
      }, 20);
    }
  }, [active, visible]);

  return (
    <div
      ref={hostRef}
      className="term-instance"
      style={{ display: active ? "block" : "none" }}
    />
  );
}

export default function TerminalPanel(p: Props) {
  return (
    <div className="term-panel" style={{ display: p.visible ? "flex" : "none" }}>
      <div className="term-bar">
        <span className="term-bar-label">TERMINAL</span>
        <div className="term-tabs">
          {p.sessions.map((s, idx) => (
            <div
              key={s.key}
              className={"term-tab" + (s.key === p.activeKey ? " active" : "")}
              title={s.cwd}
              onClick={() => p.onSelect(s.key)}
            >
              <span className="term-tab-icon">$</span>
              <span>
                {idx + 1}: {s.title}
              </span>
              <span
                className="term-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  p.onClose(s.key);
                }}
              >
                ×
              </span>
            </div>
          ))}
          <button className="icon-btn" title="New Terminal (+)" onClick={p.onNew}>
            ＋
          </button>
        </div>
        <div className="term-actions">
          <button className="icon-btn" title="Hide Terminal Panel (⌘J)" onClick={p.onToggle}>
            ✕
          </button>
        </div>
      </div>
      <div className="term-body">
        {p.sessions.map((s) => (
          <TermInstance
            key={s.key}
            session={s}
            active={s.key === p.activeKey}
            visible={p.visible}
            onExited={() => {}}
          />
        ))}
      </div>
    </div>
  );
}
