import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { fileBadge } from "./FileTree";

interface Hit {
  path: string;
  line: number;
  col: number;
  text: string;
}

interface Result {
  hits: Hit[];
  files_scanned: number;
  truncated: boolean;
}

export default function SearchPanel({
  root,
  focusKey,
  onOpen,
}: {
  root: string;
  focusKey: number;
  onOpen: (path: string, line: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  useEffect(() => {
    const q = query;
    if (!q) {
      setResult(null);
      setError(null);
      return;
    }
    const id = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      invoke<Result>("search_text", { root, query: q, caseSensitive, limit: 500 })
        .then((r) => {
          if (id !== seq.current) return;
          setResult(r);
          setError(null);
        })
        .catch((e) => id === seq.current && setError(String(e)))
        .finally(() => id === seq.current && setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, caseSensitive, root]);

  const groups = useMemo(() => {
    const m = new Map<string, Hit[]>();
    for (const h of result?.hits ?? []) {
      if (!m.has(h.path)) m.set(h.path, []);
      m.get(h.path)!.push(h);
    }
    return [...m.entries()];
  }, [result]);

  const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

  const highlight = (text: string) => {
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const i = hay.indexOf(needle);
    if (i < 0) return text.trimStart();
    const lead = text.length - text.trimStart().length;
    const start = Math.max(lead, i - 30);
    return (
      <>
        {start > lead ? "…" : ""}
        {text.slice(start, i)}
        <mark>{text.slice(i, i + query.length)}</mark>
        {text.slice(i + query.length)}
      </>
    );
  };

  return (
    <div className="side-panel" data-testid="search-panel">
      <div className="pane-title">Search</div>
      <div className="search-box">
        <input
          ref={inputRef}
          data-testid="search-input"
          value={query}
          placeholder="Search in files…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={"icon-btn" + (caseSensitive ? " on" : "")}
          title="Match case"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
      </div>
      <div className="search-summary" data-testid="search-summary">
        {error
          ? error
          : busy
            ? "Searching…"
            : result
              ? `${result.hits.length}${result.truncated ? "+" : ""} results in ${groups.length} files`
              : "Type to search the workspace"}
      </div>
      <div className="search-results">
        {groups.map(([path, hits]) => {
          const name = path.split("/").pop() ?? path;
          const badge = fileBadge(name);
          return (
            <div key={path} className="search-group">
              <div className="search-file" title={rel(path)} onClick={() => onOpen(path, hits[0].line)}>
                <span className="file-badge" style={{ color: badge.color }}>{badge.label}</span>
                <span className="search-file-name">{name}</span>
                <span className="search-file-dir">{rel(path).split("/").slice(0, -1).join("/")}</span>
                <span className="count-pill">{hits.length}</span>
              </div>
              {hits.map((h, i) => (
                <div
                  key={i}
                  className="search-hit"
                  data-testid="search-hit"
                  title={`${rel(path)}:${h.line}`}
                  onClick={() => onOpen(path, h.line)}
                >
                  <span className="search-line">{h.line}</span>
                  <span className="search-text">{highlight(h.text)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
