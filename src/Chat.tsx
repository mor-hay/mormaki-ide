import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigOption, PermissionRequest, ToolCall } from "./acp";
import { fileBadge } from "./FileTree";

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
  items: ChatItem[];
  busy: boolean;
  ready: boolean;
  permission: PermissionRequest | null;
  onPermission: (optionId: string | null) => void;
  onSend: (text: string, images: PastedImage[]) => void;
  onCancel: () => void;
  onNewChat: () => void;
  onOpenPath: (path: string, line?: number) => void;
  context: ContextChip[];
  onRemoveContext: (i: number) => void;
  onAttachFile: (path: string) => void;
  workspaceFiles: string[];
  root: string;
  model?: ConfigOption;
  onModel: (v: string) => void;
  mode?: string;
  modes: { id: string; name: string }[];
  onMode: (id: string) => void;
  usage?: { used: number; size: number; cost?: { amount: number } };
  focusKey: number;
}

const STATUS_ICON: Record<string, string> = { pending: "○", in_progress: "◐", completed: "✓", failed: "✕" };

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang || "code"}</span>
        <button className="copy-btn" onClick={copy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
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

function ToolCard({
  call,
  onOpenPath,
  onReviewDiff,
}: {
  call: ToolCall;
  onOpenPath: (p: string, line?: number) => void;
  onReviewDiff?: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const text = (call.content ?? [])
    .map((c: any) => (c.type === "content" ? c.content?.text : c.type === "diff" ? `diff ${c.path}` : ""))
    .filter(Boolean)
    .join("\n")
    .replace(/^```\n?|\n?```$/g, "");

  const status = call.status ?? "pending";
  return (
    <div className={"tool " + status}>
      <div className="tool-head" onClick={() => text && setOpen(!open)}>
        <span className={"tool-status-icon " + status}>{STATUS_ICON[status]}</span>
        <span className="tool-kind">{call.kind ?? "tool"}</span>
        <span className="tool-title" title={call.title}>
          {call.title}
        </span>
        {text && <span className="tool-expand">{open ? "▾" : "▸"}</span>}
      </div>
      {call.locations && call.locations.length > 0 && (
        <div className="tool-locs">
          {call.locations.map((l, idx) => {
            const name = l.path.split("/").pop() ?? l.path;
            const badge = fileBadge(name);
            return (
              <span
                key={l.path + idx}
                className="tool-loc"
                title={l.path}
                onClick={() => (onReviewDiff && call.kind === "edit" ? onReviewDiff(l.path) : onOpenPath(l.path, l.line))}
              >
                <span style={{ color: badge.color, fontSize: 10 }}>{badge.label}</span>
                <span>
                  {l.path.split("/").slice(-2).join("/")}
                  {l.line ? `:${l.line}` : ""}
                </span>
              </span>
            );
          })}
        </div>
      )}
      {open && text && <pre className="tool-out">{text}</pre>}
    </div>
  );
}

export default function Chat(p: Props) {
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

  return (
    <div className="chat">
      <div className="pane-title chat-head">
        <span className="chat-brand">
          <span className={"status-dot " + (p.ready ? (p.busy ? "busy" : "ready") : "offline")} />
          maki
        </span>
        <select value={p.mode ?? ""} onChange={(e) => p.onMode(e.target.value)} disabled={!p.ready} title="Mode">
          {p.modes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {p.model && (
          <select
            value={p.model.currentValue}
            onChange={(e) => p.onModel(e.target.value)}
            disabled={!p.ready}
            title={p.model.currentValue}
          >
            {p.model.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.name.replace(/^anthropic\/|^google\/|^openai\//, "")}
              </option>
            ))}
          </select>
        )}
        <button className="icon-btn" title="New Chat Session" onClick={p.onNewChat} disabled={!p.ready || p.busy}>
          ＋
        </button>
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
        {p.items.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">Ask maki anything</div>
            <div className="chat-empty-tips">
              <div><kbd>⌘L</kbd> Add selected code to chat</div>
              <div><kbd>⌘K</kbd> Inline edit selected lines</div>
              <div><kbd>⌘P</kbd> Quick open file</div>
              <div><kbd>@</kbd> Mention a file · <kbd>⌘V</kbd> Paste screenshot</div>
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
