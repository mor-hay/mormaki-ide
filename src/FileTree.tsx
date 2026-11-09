import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

const EXT_BADGE: Record<string, { label: string; color: string }> = {
  ts: { label: "TS", color: "#3178c6" },
  tsx: { label: "TSX", color: "#38bdf8" },
  js: { label: "JS", color: "#facc15" },
  jsx: { label: "JSX", color: "#fbbf24" },
  rs: { label: "RS", color: "#f97316" },
  py: { label: "PY", color: "#60a5fa" },
  go: { label: "GO", color: "#22d3ee" },
  json: { label: "{}", color: "#eab308" },
  md: { label: "MD", color: "#94a3b8" },
  css: { label: "#", color: "#a855f7" },
  scss: { label: "S#", color: "#ec4899" },
  html: { label: "<>", color: "#f97316" },
  toml: { label: "⚙", color: "#9ca3af" },
  yaml: { label: "Y!", color: "#f43f5e" },
  yml: { label: "Y!", color: "#f43f5e" },
  lua: { label: "🌙", color: "#6366f1" },
  sh: { label: "$", color: "#4ade80" },
  sql: { label: "DB", color: "#38bdf8" },
};

export function fileBadge(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_BADGE[ext] ?? { label: "📄", color: "#8a8a8a" };
}

interface CtxMenu {
  x: number;
  y: number;
  path: string;
  is_dir: boolean;
  name: string;
}

function Dir({
  path,
  depth,
  onOpen,
  onContextMenu,
  active,
  refresh,
  collapseKey,
  changedSet,
  dirtySet,
}: {
  path: string;
  depth: number;
  onOpen: (p: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: Entry) => void;
  active?: string;
  refresh: number;
  collapseKey: number;
  changedSet: Set<string>;
  dirtySet: Set<string>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    invoke<Entry[]>("list_dir", { path })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [path, refresh]);

  useEffect(() => {
    if (collapseKey > 0) setOpen({});
  }, [collapseKey]);

  return (
    <>
      {entries.map((e) => {
        const badge = e.is_dir ? null : fileBadge(e.name);
        const isChanged = changedSet.has(e.path);
        const isDirty = dirtySet.has(e.path);
        return (
          <div key={e.path}>
            <div
              className={"tree-row" + (e.path === active ? " active" : "") + (isChanged ? " changed" : "")}
              style={{ paddingLeft: 10 + depth * 13 }}
              title={`${e.path} (Right-click for options)`}
              onClick={() => (e.is_dir ? setOpen((o) => ({ ...o, [e.path]: !o[e.path] })) : onOpen(e.path))}
              onContextMenu={(ev) => onContextMenu(ev, e)}
            >
              {e.is_dir ? (
                <span className="tree-chevron">{open[e.path] ? "▾" : "▸"}</span>
              ) : (
                <span className="file-badge" style={{ color: badge?.color }}>
                  {badge?.label}
                </span>
              )}
              <span className="tree-name">{e.name}</span>
              {isChanged && <span className="tree-dot mod" title="Modified by maki">M</span>}
              {!isChanged && isDirty && <span className="tree-dot dirty" title="Unsaved changes">●</span>}
            </div>
            {e.is_dir && open[e.path] && (
              <Dir
                path={e.path}
                depth={depth + 1}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
                active={active}
                refresh={refresh}
                collapseKey={collapseKey}
                changedSet={changedSet}
                dirtySet={dirtySet}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export default function FileTree(props: {
  root: string;
  onOpen: (p: string) => void;
  onOpenTerminal: (dir: string) => void;
  onAttachChat: (p: string) => void;
  onRefresh: () => void;
  onQuickOpen: () => void;
  active?: string;
  refresh: number;
  changedPaths: string[];
  dirtyPaths: string[];
}) {
  const [collapseKey, setCollapseKey] = useState(0);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const changedSet = new Set(props.changedPaths);
  const dirtySet = new Set(props.dirtyPaths);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [menu]);

  const handleCtx = (ev: React.MouseEvent, entry: Entry) => {
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({
      x: Math.min(ev.clientX, window.innerWidth - 210),
      y: Math.min(ev.clientY, window.innerHeight - 140),
      path: entry.path,
      is_dir: entry.is_dir,
      name: entry.name,
    });
  };

  const parentDir = (p: string) => {
    const idx = p.lastIndexOf("/");
    return idx > 0 ? p.slice(0, idx) : "/";
  };

  return (
    <div
      className="tree"
      onContextMenu={(ev) => {
        ev.preventDefault();
        setMenu({
          x: Math.min(ev.clientX, window.innerWidth - 210),
          y: Math.min(ev.clientY, window.innerHeight - 140),
          path: props.root,
          is_dir: true,
          name: props.root.split("/").pop() ?? "workspace",
        });
      }}
    >
      <div className="pane-title tree-header">
        <span className="tree-root-name" title={props.root}>
          {props.root.split("/").pop()}
        </span>
        <div className="tree-actions">
          <button
            className="icon-btn"
            title="Open Terminal in Workspace (⌘J)"
            onClick={() => props.onOpenTerminal(props.root)}
          >
            $_
          </button>
          <button className="icon-btn" title="Quick Open (⌘P)" onClick={props.onQuickOpen}>
            🔍
          </button>
          <button className="icon-btn" title="Collapse All" onClick={() => setCollapseKey((k) => k + 1)}>
            ⊟
          </button>
          <button className="icon-btn" title="Refresh Explorer" onClick={props.onRefresh}>
            ↻
          </button>
        </div>
      </div>
      <div className="tree-body">
        <Dir
          path={props.root}
          depth={0}
          onOpen={props.onOpen}
          onContextMenu={handleCtx}
          active={props.active}
          refresh={props.refresh}
          collapseKey={collapseKey}
          changedSet={changedSet}
          dirtySet={dirtySet}
        />
      </div>

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-head">{menu.name}</div>
          <div
            className="ctx-item"
            onClick={() => {
              const dir = menu.is_dir ? menu.path : parentDir(menu.path);
              props.onOpenTerminal(dir);
              setMenu(null);
            }}
          >
            <span>$_</span>
            <span>Open in Integrated Terminal</span>
          </div>
          {!menu.is_dir && (
            <>
              <div
                className="ctx-item"
                onClick={() => {
                  props.onOpen(menu.path);
                  setMenu(null);
                }}
              >
                <span>📄</span>
                <span>Open File</span>
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  props.onAttachChat(menu.path);
                  setMenu(null);
                }}
              >
                <span>@</span>
                <span>Add File to Chat Context</span>
              </div>
            </>
          )}
          <div
            className="ctx-item"
            onClick={() => {
              navigator.clipboard.writeText(menu.path);
              setMenu(null);
            }}
          >
            <span>📋</span>
            <span>Copy Path</span>
          </div>
        </div>
      )}
    </div>
  );
}
