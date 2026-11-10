import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { askConfirm } from "./dialogs";
import { fileBadge } from "./FileTree";

export interface GitFile {
  path: string;
  index: string;
  worktree: string;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string;
  files: GitFile[];
}

const LABEL: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", "?": "Untracked", U: "Conflict" };

export default function GitPanel({
  root,
  status,
  onRefresh,
  onOpenDiff,
  onToast,
}: {
  root: string;
  status: GitStatus | null;
  onRefresh: () => void;
  onOpenDiff: (path: string) => void;
  onToast: (msg: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) onToast(okMsg);
    } catch (e) {
      onToast(`Git: ${String(e)}`);
    } finally {
      setBusy(false);
      onRefresh();
    }
  };

  if (!status) {
    return (
      <div className="side-panel" data-testid="git-panel">
        <div className="pane-title">Source Control</div>
        <div className="side-empty">Loading…</div>
      </div>
    );
  }
  if (!status.is_repo) {
    return (
      <div className="side-panel" data-testid="git-panel">
        <div className="pane-title">Source Control</div>
        <div className="side-empty">This folder is not a Git repository.</div>
      </div>
    );
  }

  const staged = status.files.filter((f) => f.index !== " " && f.index !== "?");
  const unstaged = status.files.filter((f) => f.worktree !== " ");

  const row = (f: GitFile, isStaged: boolean) => {
    const code = isStaged ? f.index : f.worktree;
    const name = f.path.split("/").pop() ?? f.path;
    const badge = fileBadge(name);
    return (
      <div
        key={(isStaged ? "s:" : "w:") + f.path}
        className="git-row"
        data-testid={isStaged ? "git-staged-row" : "git-change-row"}
        title={`${rel(f.path)} · ${LABEL[code] ?? code}`}
        onClick={() => onOpenDiff(f.path)}
      >
        <span className="file-badge" style={{ color: badge.color }}>{badge.label}</span>
        <span className="git-name">{name}</span>
        <span className="git-dir">{rel(f.path).split("/").slice(0, -1).join("/")}</span>
        <span className="git-actions" onClick={(e) => e.stopPropagation()}>
          {!isStaged && (
            <button
              className="icon-btn"
              title="Discard changes"
              data-testid="git-discard"
              onClick={async () => {
                const untracked = f.worktree === "?";
                const ok = await askConfirm(
                  `Discard changes to ${name}?`,
                  untracked ? "This untracked file will be moved to the Trash." : "This restores the file to the last commit. It cannot be undone.",
                  { confirmLabel: "Discard", danger: true },
                );
                if (ok) run(() => invoke("git_discard", { root, path: f.path }));
              }}
            >
              ↩
            </button>
          )}
          <button
            className="icon-btn"
            title={isStaged ? "Unstage" : "Stage"}
            data-testid={isStaged ? "git-unstage" : "git-stage"}
            onClick={() => run(() => invoke("git_stage", { root, paths: [f.path], stage: !isStaged }))}
          >
            {isStaged ? "−" : "+"}
          </button>
        </span>
        <span className={"git-code git-" + (code === "?" ? "U" : code)}>{code === "?" ? "U" : code}</span>
      </div>
    );
  };

  return (
    <div className="side-panel" data-testid="git-panel">
      <div className="pane-title tree-header">
        <span>Source Control</span>
        <span className="tree-actions">
          <span className="branch-pill" data-testid="git-branch" title="Current branch">⎇ {status.branch || "detached"}</span>
          <button className="icon-btn" title="Refresh" onClick={onRefresh}>↻</button>
        </span>
      </div>
      <div className="git-commit">
        <textarea
          data-testid="git-message"
          value={message}
          rows={2}
          placeholder="Commit message"
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          className="primary"
          data-testid="git-commit"
          disabled={busy || !message.trim() || staged.length === 0}
          title={staged.length === 0 ? "Stage changes first" : "Commit staged changes"}
          onClick={() =>
            run(async () => {
              await invoke("git_commit", { root, message });
              setMessage("");
            }, "Committed")
          }
        >
          ✓ Commit {staged.length > 0 ? `(${staged.length})` : ""}
        </button>
      </div>
      <div className="git-lists">
        {staged.length > 0 && (
          <>
            <div className="git-section">
              <span>Staged Changes</span>
              <span className="count-pill">{staged.length}</span>
              <button
                className="icon-btn"
                title="Unstage all"
                onClick={() => run(() => invoke("git_stage", { root, paths: staged.map((f) => f.path), stage: false }))}
              >
                −
              </button>
            </div>
            {staged.map((f) => row(f, true))}
          </>
        )}
        <div className="git-section">
          <span>Changes</span>
          <span className="count-pill" data-testid="git-change-count">{unstaged.length}</span>
          {unstaged.length > 0 && (
            <button
              className="icon-btn"
              title="Stage all"
              data-testid="git-stage-all"
              onClick={() => run(() => invoke("git_stage", { root, paths: unstaged.map((f) => f.path), stage: true }))}
            >
              +
            </button>
          )}
        </div>
        {unstaged.map((f) => row(f, false))}
        {status.files.length === 0 && <div className="side-empty">No changes. Working tree is clean.</div>}
      </div>
    </div>
  );
}
