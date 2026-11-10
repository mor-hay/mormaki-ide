import { useMemo, useState } from "react";

export interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

export default function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const list = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => terms.every((t) => c.title.toLowerCase().includes(t)));
  }, [q, commands]);

  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="quick-open" data-testid="command-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          data-testid="palette-input"
          value={q}
          placeholder="Type a command…"
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => (list.length ? (i + 1) % list.length : 0));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => (list.length ? (i - 1 + list.length) % list.length : 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(list[idx]);
            }
          }}
        />
        <div className="quick-list">
          {list.length === 0 && <div className="quick-empty">No matching commands</div>}
          {list.map((c, i) => (
            <div
              key={c.id}
              data-testid="palette-item"
              data-command={c.id}
              className={"quick-item" + (i === idx ? " active" : "")}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(c)}
            >
              <span className="quick-name">{c.title}</span>
              {c.hint && <kbd className="quick-rel">{c.hint}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
