import { useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "./monacoSlim";
import type { ConfigOption, ToolCall } from "./acp";
import { fileBadge } from "./FileTree";
import { langFor } from "./monaco";
import { lineDiff, stripFence, toolOps, ToolOp } from "./toolOps";
import type { ChatState } from "./useChats";

export type ChatItem =
  | { kind: "user"; text: string; context?: string[]; images?: string[] }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "plan"; entries: { content: string; status: string }[] }
  | { kind: "error"; text: string };

export interface PastedImage {
  mimeType: string;
  data: string;
}

export interface ContextChip {
  label: string;
  path: string;
  text: string;
}

interface Props {
  chat?: ChatState;
  chats: ChatState[];
  onSelectChat: (key: string) => void;
  onNewChat: () => void;
  onCloseChat: (key: string) => void;
  onPermission: (optionId: string | null) => void;
  onSend: (text: string, images: PastedImage[]) => void;
  onCancel: () => void;
  onOpenPath: (path: string, line?: number) => void;
  context: ContextChip[];
  onRemoveContext: (i: number) => void;
  onAttachFile: (path: string) => void;
  workspaceFiles: string[];
  root: string;
  onModel: (v: string) => void;
  onMode: (id: string) => void;
  onEffort: (v: string) => void;
  focusKey: number;
}

const STATUS_ICON: Record<string, string> = { pending: "○", in_progress: "◐", completed: "✓", failed: "✕" };

const LANG_ALIAS: Record<string, string> = {
  py: "python", python3: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  sh: "shell", bash: "shell", zsh: "shell", console: "shell", rs: "rust", yml: "yaml", md: "markdown",
  html: "html", css: "css", json: "json", go: "go", rb: "ruby", kt: "kotlin", cs: "csharp", "c++": "cpp",
};
let themeReady = false;

function normLang(lang: string, path?: string) {
  if (path) return langFor(path);
  const l = (lang || "").toLowerCase();
  const id = LANG_ALIAS[l] ?? l;
  return monaco.languages.getLanguages().some((x) => x.id === id) ? id : "plaintext";
}

function useColorized(code: string, language: string) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    if (!themeReady) {
      monaco.editor.setTheme("vs-dark");
      themeReady = true;
    }
    if (language === "plaintext" || code.length > 60000) {
      setLines(null);
      return;
    }
    const t = setTimeout(() => {
      monaco.editor
        .colorize(code, language, { tabSize: 4 })
        .then((html) => {
          if (!alive) return;
          const parts = html.replace(/<br\/>$/, "").split("<br/>");
          setLines(parts.length === code.split("\n").length ? parts : null);
        })
        .catch(() => alive && setLines(null));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [code, language]);
  return lines;
}

function CodeLines({ code, language, kinds }: { code: string; language: string; kinds?: ("ctx" | "add" | "del")[] }) {
  const html = useColorized(code, language);
  const plain = code.split("\n");
  return (
    <pre className="code-lines">
      {plain.map((text, i) => {
        const k = kinds?.[i];
        return (
          <div key={i} className={"cl" + (k ? " cl-" + k : "")}>
            {kinds && <span className="cl-sign">{k === "add" ? "+" : k === "del" ? "-" : " "}</span>}
            {html ? <span dangerouslySetInnerHTML={{ __html: html[i] || "&nbsp;" }} /> : <span>{text || " "}</span>}
          </div>
        );
      })}
    </pre>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang || "code"}</span>
        <CopyButton text={code} />
      </div>
      <CodeLines code={code} language={normLang(lang)} />
    </div>
  );
}

function Collapsible({ lines, children, limit = 18 }: { lines: number; children: React.ReactNode; limit?: number }) {
  const [full, setFull] = useState(false);
  const clipped = lines > limit && !full;
  return (
    <div className={"collapsible" + (clipped ? " clipped" : "")} style={clipped ? { maxHeight: limit * 18 } : undefined}>
      {children}
      {lines > limit && (
        <button className="show-more" onClick={() => setFull(!full)}>
          {full ? "Show less" : `Show all ${lines} lines`}
        </button>
      )}
    </div>
  );
}

function FileChip({ path, onOpen }: { path: string; onOpen: (p: string) => void }) {
  const name = path.split("/").pop() ?? path;
  const badge = fileBadge(name);
  return (
    <span className="file-chip" title={path} onClick={() => onOpen(path)}>
      <span className="file-badge" style={{ color: badge.color }}>{badge.label}</span>
      {name}
    </span>
  );
}

function OpView({ op, onOpenPath }: { op: ToolOp; onOpenPath: (p: string, line?: number) => void }) {
  if (op.type === "edit") {
    const d = lineDiff(op.oldText, op.newText);
    const add = d.filter((x) => x.t === "add").length;
    const del = d.filter((x) => x.t === "del").length;
    return (
      <div className="op">
        <div className="op-head">
          <span className="op-verb">Edited</span>
          <FileChip path={op.path} onOpen={onOpenPath} />
          <span className="stat-add">+{add}</span>
          <span className="stat-del">-{del}</span>
        </div>
        <Collapsible lines={d.length}>
          <CodeLines code={d.map((x) => x.text).join("\n")} language={normLang("", op.path)} kinds={d.map((x) => x.t)} />
        </Collapsible>
      </div>
    );
  }
  if (op.type === "write") {
    const n = op.content.replace(/\n$/, "").split("\n").length;
    return (
      <div className="op">
        <div className="op-head">
          <span className="op-verb">Wrote</span>
          <FileChip path={op.path} onOpen={onOpenPath} />
          <span className="stat-add">+{n}</span>
          <CopyButton text={op.content} />
        </div>
        <Collapsible lines={n}>
          <CodeLines
            code={op.content.replace(/\n$/, "")}
            language={normLang("", op.path)}
            kinds={Array(n).fill("add")}
          />
        </Collapsible>
      </div>
    );
  }
  if (op.type === "bash") {
    return (
      <div className="op">
        <div className="op-cmd">
          <span className="prompt">$</span>
          <code>{op.command}</code>
        </div>
      </div>
    );
  }
  if (op.type === "read") {
    return (
      <div className="op op-inline">
        <span className="op-verb">Read</span>
        <FileChip path={op.path} onOpen={(p) => onOpenPath(p, op.line)} />
      </div>
    );
  }
  return null;
}

function ToolCard({ call, onOpenPath }: { call: ToolCall; onOpenPath: (p: string, line?: number) => void }) {
  const ops = useMemo(() => toolOps(call.toolName, call.rawInput), [call.toolName, call.rawInput]);
  const output = stripFence(
    (call.content ?? [])
      .map((c: any) => (c.type === "content" ? c.content?.text ?? "" : ""))
      .filter(Boolean)
      .join("\n"),
  ).trim();
  const hasCode = ops.some((o) => o.type === "edit" || o.type === "write" || o.type === "bash");
  const onlyReads = ops.length > 0 && ops.every((o) => o.type === "read");
  const isBash = ops.some((o) => o.type === "bash");
  const [showOut, setShowOut] = useState(false);
  const status = call.status ?? "pending";
  const name = call.toolName ?? call.kind ?? "tool";
  const title = call.title && call.title !== name ? call.title : "";

  if (onlyReads) {
    return (
      <div className={"tool tool-compact " + status}>
        <span className={"tool-status-icon " + status}>{STATUS_ICON[status]}</span>
        {ops.map((o, i) => <OpView key={i} op={o} onOpenPath={onOpenPath} />)}
      </div>
    );
  }

  return (
    <div className={"tool " + status}>
      <div className="tool-head" onClick={() => output && setShowOut(!showOut)}>
        <span className={"tool-status-icon " + status}>{STATUS_ICON[status]}</span>
        <span className="tool-kind">{name}</span>
        {title && <span className="tool-title" title={call.title}>{title}</span>}
        {output && <span className="tool-expand">{showOut ? "▾ output" : "▸ output"}</span>}
      </div>
      {hasCode && (
        <div className="ops">
          {ops.map((o, i) => <OpView key={i} op={o} onOpenPath={onOpenPath} />)}
        </div>
      )}
      {!hasCode && call.locations && call.locations.length > 0 && (
        <div className="tool-locs">
          {call.locations.map((l, idx) => (
            <FileChip key={l.path + idx} path={l.path} onOpen={(p) => onOpenPath(p, l.line)} />
          ))}
        </div>
      )}
      {output && (showOut || (isBash && status === "failed")) && (
        <Collapsible lines={output.split("\n").length}>
          <pre className="tool-out">{output}</pre>
        </Collapsible>
      )}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return (
        <code key={i} className="md-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function MarkdownView({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: ({ type: "code"; lang: string; code: string } | { type: "text"; content: string })[] = [];
    const regex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) {
        out.push({ type: "text", content: text.slice(last, match.index) });
      }
      out.push({ type: "code", lang: match[1] ?? "", code: match[2].replace(/\n$/, "") });
      last = regex.lastIndex;
    }
    if (last < text.length) {
      const rem = text.slice(last);
      const unclosed = rem.match(/```([a-zA-Z0-9_-]*)\n([\s\S]*)$/);
      if (unclosed && unclosed.index !== undefined) {
        if (unclosed.index > 0) out.push({ type: "text", content: rem.slice(0, unclosed.index) });
        out.push({ type: "code", lang: unclosed[1] ?? "", code: unclosed[2] });
      } else {
        out.push({ type: "text", content: rem });
      }
    }
    return out;
  }, [text]);

  return (
    <div className="md-root">
      {blocks.map((b, idx) =>
        b.type === "code" ? (
          <CodeBlock key={idx} lang={b.lang} code={b.code} />
        ) : (
          <div key={idx} className="md-prose">
            {b.content.split("\n").map((line, lIdx) => {
              const h3 = line.match(/^###\s+(.*)/);
              if (h3) return <h4 key={lIdx}>{renderInline(h3[1])}</h4>;
              const h2 = line.match(/^##\s+(.*)/);
              if (h2) return <h3 key={lIdx}>{renderInline(h2[1])}</h3>;
              const h1 = line.match(/^#\s+(.*)/);
              if (h1) return <h2 key={lIdx}>{renderInline(h1[1])}</h2>;
              const bullet = line.match(/^\s*[-*]\s+(.*)/);
              if (bullet) {
                return (
                  <div key={lIdx} className="md-li">
                    <span>•</span>
                    <div>{renderInline(bullet[1])}</div>
                  </div>
                );
              }
              if (!line.trim()) return <div key={lIdx} className="md-spacer" />;
              return (
                <div key={lIdx} className="md-line">
                  {renderInline(line)}
                </div>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}

function ChatTabs({
  chats,
  activeKey,
  onSelect,
  onNew,
  onClose,
}: {
  chats: ChatState[];
  activeKey?: string;
  onSelect: (k: string) => void;
  onNew: () => void;
  onClose: (k: string) => void;
}) {
  return (
    <div className="chat-tabs">
      {chats.map((c) => (
        <div
          key={c.key}
          className={"chat-tab" + (c.key === activeKey ? " active" : "")}
          title={c.title}
          onClick={() => onSelect(c.key)}
          onAuxClick={(e) => e.button === 1 && onClose(c.key)}
        >
          {c.busy || c.restoring ? (
            <span className="spinner sm" />
          ) : c.permission ? (
            <span className="chat-tab-dot warn" />
          ) : c.unread ? (
            <span className="chat-tab-dot" />
          ) : null}
          <span className="chat-tab-title">{c.title}</span>
          <span
            className="chat-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(c.key);
            }}
          >
            ×
          </span>
        </div>
      ))}
      <button className="icon-btn chat-tab-new" title="New chat (runs in parallel)" onClick={onNew}>
        ＋
      </button>
    </div>
  );
}

const shortName = (v: string) => v.replace(/^[^/]+\//, "").replace(/^claude-/, "").replace(/-1m$/, "");

export const EFFORTS = [
  { value: "", label: "Default", hint: "maki's last /thinking level" },
  { value: "off", label: "Off", hint: "No thinking, fastest" },
  { value: "low", label: "Low", hint: "Light reasoning" },
  { value: "medium", label: "Medium", hint: "Balanced" },
  { value: "high", label: "High", hint: "Deep reasoning" },
  { value: "max", label: "Max", hint: "Maximum reasoning, slowest" },
];

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return { open, setOpen, ref };
}

function EffortPicker({ value, disabled, onPick }: { value: string; disabled: boolean; onPick: (v: string) => void }) {
  const { open, setOpen, ref } = usePopover();
  const cur = EFFORTS.find((e) => e.value === value) ?? EFFORTS[0];
  return (
    <div className="model-picker" ref={ref}>
      <button
        className={"model-btn effort-btn effort-" + (cur.value || "default")}
        disabled={disabled}
        title="Reasoning effort (restarts maki and resumes this chat)"
        onClick={() => setOpen(!open)}
      >
        🧠 {cur.label}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="model-pop effort-pop">
          <div className="model-group">Reasoning effort</div>
          {EFFORTS.map((e) => (
            <div
              key={e.value}
              className={"model-item" + (e.value === value ? " current" : "")}
              onMouseDown={(ev) => {
                ev.preventDefault();
                setOpen(false);
                onPick(e.value);
              }}
            >
              <span className={"effort-bars effort-" + (e.value || "default")} />
              <span>{e.label}</span>
              <span className="effort-hint">{e.hint}</span>
              {e.value === value && <span className="check">✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelPicker({ model, disabled, onPick }: { model: ConfigOption; disabled: boolean; onPick: (v: string) => void }) {
  const { open, setOpen, ref } = usePopover();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const list = useMemo(() => {
    const values = model.options.map((o) => o.value);
    if (!values.includes(model.currentValue)) values.unshift(model.currentValue);
    const terms = q.toLowerCase().replace(/\./g, "-").split(/\s+/).filter(Boolean);
    return values
      .filter((v) => terms.every((t) => v.toLowerCase().includes(t)))
      .sort((a, b) => {
        const pa = a.split("/")[0], pb = b.split("/")[0];
        if (pa !== pb) return pa.localeCompare(pb);
        return b.localeCompare(a, undefined, { numeric: true });
      });
  }, [model, q]);

  const pick = (v: string) => {
    setOpen(false);
    setQ("");
    if (v !== model.currentValue) onPick(v);
  };

  const cur = model.currentValue;
  return (
    <div className="model-picker" ref={ref}>
      <button className="model-btn" disabled={disabled} title={cur} onClick={() => { setOpen(!open); setIdx(0); }}>
        {shortName(cur)}
        {cur.endsWith("-1m") && <span className="badge-1m">1M</span>}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="model-pop">
          <input
            autoFocus
            value={q}
            placeholder={`Search ${model.options.length} models… (e.g. opus 5.5 1m)`}
            onChange={(e) => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, list.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
              else if (e.key === "Enter" && list[idx]) pick(list[idx]);
            }}
          />
          <div className="model-list">
            {list.length === 0 && <div className="quick-empty">No matching models</div>}
            {list.map((v, i) => {
              const provider = v.split("/")[0];
              const header = i === 0 || list[i - 1].split("/")[0] !== provider;
              return (
                <div key={v}>
                  {header && <div className="model-group">{provider}</div>}
                  <div
                    className={"model-item" + (i === idx ? " active" : "") + (v === cur ? " current" : "")}
                    onMouseEnter={() => setIdx(i)}
                    onMouseDown={(e) => { e.preventDefault(); pick(v); }}
                  >
                    <span>{shortName(v)}</span>
                    {v.endsWith("-1m") && <span className="badge-1m">1M</span>}
                    {v === cur && <span className="check">✓</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Chat(props: Props) {
  const ch = props.chat;
  const p = {
    ...props,
    items: ch?.items ?? [],
    busy: !!ch?.busy,
    ready: !!ch?.ready,
    permission: ch?.permission ?? null,
    model: ch?.model,
    mode: ch?.mode,
    modes: ch?.modes ?? [],
    usage: ch?.usage,
    effort: ch?.effort ?? "",
  };
  const [input, setInput] = useState("");
  const [images, setImages] = useState<PastedImage[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [stickToBottom, setStickToBottom] = useState(true);

  const msgsRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const relPath = (full: string) => (full.startsWith(p.root + "/") ? full.slice(p.root.length + 1) : full);

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return p.workspaceFiles
      .map((full) => ({ full, rel: relPath(full) }))
      .filter((x) => !q || x.rel.toLowerCase().includes(q))
      .slice(0, 8);
  }, [mentionQuery, p.workspaceFiles, p.root]);

  const addFiles = (files: Iterable<File>) => {
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const r = new FileReader();
      r.onload = () => {
        const url = r.result as string;
        setImages((xs) => [...xs, { mimeType: f.type, data: url.slice(url.indexOf(",") + 1) }]);
      };
      r.readAsDataURL(f);
    }
  };

  useEffect(() => {
    if (stickToBottom && msgsRef.current) {
      msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
    }
  }, [p.items, p.permission, p.busy, stickToBottom]);

  useEffect(() => {
    if (p.focusKey > 0) taRef.current?.focus();
  }, [p.focusKey]);

  useEffect(() => {
    setStickToBottom(true);
    requestAnimationFrame(() => {
      if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
    });
    taRef.current?.focus();
  }, [ch?.key]);

  const handleInputChange = (val: string, cursor?: number) => {
    setInput(val);
    const pos = cursor ?? val.length;
    const before = val.slice(0, pos);
    const atMatch = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionIdx(0);
    } else {
      setMentionQuery(null);
    }
  };

  const applyMention = (fullPath: string) => {
    p.onAttachFile(fullPath);
    if (taRef.current) {
      const pos = taRef.current.selectionStart ?? input.length;
      const before = input.slice(0, pos).replace(/(?:^|\s)@([^\s@]*)$/, (m) => (m.startsWith(" ") ? " " : ""));
      const after = input.slice(pos);
      setInput(before + after);
    }
    setMentionQuery(null);
    taRef.current?.focus();
  };

  const submit = () => {
    if ((!input.trim() && images.length === 0) || p.busy || !p.ready) return;
    setStickToBottom(true);
    p.onSend(input.trim() || "Analyze the attached image(s) and tell me what needs to be done.", images);
    setInput("");
    setImages([]);
    setMentionQuery(null);
  };

  const pct = p.usage && p.usage.size > 0 ? Math.min(100, Math.round((p.usage.used / p.usage.size) * 100)) : 0;

  const modelVariants = useMemo(() => {
    if (!p.model) return null;
    const cur = p.model.currentValue;
    const base = cur.replace(/-1m$/, "");
    const oneM = `${base}-1m`;
    const hasBase = p.model.options.some((o) => o.value === base);
    const has1M = p.model.options.some((o) => o.value === oneM);
    if (hasBase && has1M) {
      return { base, oneM, is1M: cur === oneM };
    }
    return null;
  }, [p.model]);

  return (
    <div className="chat">
      <ChatTabs
        chats={p.chats}
        activeKey={ch?.key}
        onSelect={p.onSelectChat}
        onNew={p.onNewChat}
        onClose={p.onCloseChat}
      />
      <div className="pane-title chat-head">
        <span className="chat-brand">
          <span className={"status-dot " + (p.ready ? (p.busy ? "busy" : "ready") : "offline")} />
          maki
        </span>
        <select value={p.mode ?? ""} onChange={(e) => p.onMode(e.target.value)} disabled={!p.ready || p.busy} title="Mode">
          {p.modes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {p.model && <ModelPicker model={p.model} disabled={!p.ready || p.busy} onPick={p.onModel} />}
        <EffortPicker value={p.effort} disabled={!p.ready || p.busy} onPick={p.onEffort} />
        {modelVariants && (
          <button
            className={"ctx-toggle-btn" + (modelVariants.is1M ? " active" : "")}
            title={
              modelVariants.is1M
                ? "Using 1M token context window (click to switch to 200K)"
                : "Using standard 200K context window (click to switch to 1M tokens)"
            }
            disabled={!p.ready || p.busy}
            onClick={() => p.onModel(modelVariants.is1M ? modelVariants.base : modelVariants.oneM)}
          >
            {modelVariants.is1M ? "1M" : "200K"}
          </button>
        )}
      </div>

      <div
        className="messages"
        ref={msgsRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 45;
          setStickToBottom(nearBottom);
        }}
      >
        {p.items.length === 0 && ch?.restoring && (
          <div className="chat-empty">
            <span className="spinner" /> {ch.sessionId ? "Restoring chat…" : "Starting maki…"}
          </div>
        )}
        {p.items.length === 0 && !ch?.restoring && (
          <div className="chat-empty">
            <div className="chat-empty-title">Ask maki anything</div>
            <div className="chat-empty-tips">
              <div><kbd>⌘L</kbd> Add selected code to chat</div>
              <div><kbd>⌘K</kbd> Inline edit selected lines</div>
              <div><kbd>⌘P</kbd> Quick open file</div>
              <div><kbd>@</kbd> Mention a file · <kbd>⌘V</kbd> Paste screenshot</div>
              <div><kbd>＋</kbd> New chat, chats run in parallel</div>
            </div>
          </div>
        )}
        {p.items.map((it, i) => {
          switch (it.kind) {
            case "user":
              return (
                <div key={i} className="msg user">
                  {it.context && it.context.length > 0 && (
                    <div className="msg-chips">
                      {it.context.map((c, ci) => (
                        <span key={ci} className="chip">
                          @{c}
                        </span>
                      ))}
                    </div>
                  )}
                  {it.images && it.images.length > 0 && (
                    <div className="thumbs">
                      {it.images.map((src, j) => (
                        <img key={j} src={src} alt="attached" />
                      ))}
                    </div>
                  )}
                  <div className="user-text">{it.text}</div>
                </div>
              );
            case "agent":
              return (
                <div key={i} className="msg agent">
                  <MarkdownView text={it.text} />
                </div>
              );
            case "thought":
              return (
                <details key={i} className="msg thought">
                  <summary>Thinking…</summary>
                  <div className="thought-body">{it.text}</div>
                </details>
              );
            case "tool":
              return <ToolCard key={i} call={it.call} onOpenPath={p.onOpenPath} />;
            case "plan":
              return (
                <div key={i} className="plan">
                  <div className="plan-title">Plan</div>
                  {it.entries.map((e, j) => (
                    <div key={j} className={"plan-item plan-" + e.status}>
                      <span>{e.status === "completed" ? "☑" : e.status === "in_progress" ? "◐" : "☐"}</span>
                      <span>{e.content}</span>
                    </div>
                  ))}
                </div>
              );
            case "error":
              return (
                <div key={i} className="msg error">
                  <span>⚠</span> {it.text}
                </div>
              );
          }
        })}
        {p.permission && (
          <div className="permission">
            <div className="perm-title">
              Permission required: <b>{p.permission.toolCall.title ?? p.permission.toolCall.kind}</b>
            </div>
            <div className="perm-btns">
              {p.permission.options.map((o) => (
                <button
                  key={o.optionId}
                  className={o.kind.startsWith("allow") ? "primary" : ""}
                  onClick={() => p.onPermission(o.optionId)}
                >
                  {o.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {p.busy && !p.permission && (
          <div className="working">
            <span className="spinner" /> maki is working…
          </div>
        )}
      </div>

      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        {mentionMatches.length > 0 && (
          <div className="mention-popup">
            {mentionMatches.map((m, idx) => {
              const badge = fileBadge(m.rel);
              return (
                <div
                  key={m.full}
                  className={"mention-item" + (idx === mentionIdx ? " active" : "")}
                  onMouseEnter={() => setMentionIdx(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(m.full);
                  }}
                >
                  <span className="file-badge" style={{ color: badge.color }}>
                    {badge.label}
                  </span>
                  <span className="mention-rel">{m.rel}</span>
                </div>
              );
            })}
          </div>
        )}

        {images.length > 0 && (
          <div className="thumbs">
            {images.map((im, i) => (
              <div
                key={i}
                className="thumb"
                title="Click to remove"
                onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))}
              >
                <img src={`data:${im.mimeType};base64,${im.data}`} alt="preview" />
                <span>×</span>
              </div>
            ))}
          </div>
        )}

        {p.context.length > 0 && (
          <div className="chips">
            {p.context.map((c, i) => (
              <span key={i} className="chip" onClick={() => p.onRemoveContext(i)} title="Click to remove">
                @{c.label} ×
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          value={input}
          rows={Math.min(8, Math.max(3, input.split("\n").length))}
          placeholder={p.ready ? "Ask maki… (@ to mention file, ⌘V paste image)" : "Connecting to maki…"}
          onChange={(e) => handleInputChange(e.target.value, e.target.selectionStart ?? undefined)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.items)
              .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (mentionMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % mentionMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                applyMention(mentionMatches[mentionIdx].full);
                return;
              }
              if (e.key === "Escape") {
                setMentionQuery(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <div className="composer-bar">
          <div className="composer-left">
            <button
              className="icon-btn"
              title="Attach image"
              onClick={() => fileInputRef.current?.click()}
              disabled={!p.ready}
            >
              🖼
            </button>
            <button
              className="icon-btn"
              title="Mention file (@)"
              onClick={() => {
                const next = input + (input.endsWith(" ") || !input ? "@" : " @");
                handleInputChange(next, next.length);
                taRef.current?.focus();
              }}
              disabled={!p.ready}
            >
              @
            </button>
            {p.usage && (
              <span className="usage" title={`${p.usage.used.toLocaleString()} / ${p.usage.size.toLocaleString()} tokens`}>
                <span className="ctx-meter">
                  <span style={{ width: `${pct}%` }} />
                </span>
                {pct}%{p.usage.cost ? ` · $${p.usage.cost.amount.toFixed(3)}` : ""}
              </span>
            )}
          </div>
          {p.busy ? (
            <button className="danger" onClick={p.onCancel}>
              ■ Stop
            </button>
          ) : (
            <button
              className="primary"
              onClick={submit}
              disabled={!p.ready || (!input.trim() && images.length === 0)}
            >
              Send ↵
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
