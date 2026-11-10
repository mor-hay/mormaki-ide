import { useEffect, useRef, useState } from "react";

interface Req {
  kind: "prompt" | "confirm";
  title: string;
  message?: string;
  initial?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (v: string | boolean | null) => void;
}

let present: ((r: Req) => void) | null = null;

export function askText(title: string, initial = "", confirmLabel = "OK"): Promise<string | null> {
  return new Promise((resolve) => {
    if (!present) return resolve(null);
    present({ kind: "prompt", title, initial, confirmLabel, resolve: (v) => resolve(typeof v === "string" ? v : null) });
  });
}

export function askConfirm(
  title: string,
  message?: string,
  opts: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!present) return resolve(false);
    present({ kind: "confirm", title, message, ...opts, resolve: (v) => resolve(v === true) });
  });
}

export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    present = (r) => {
      setValue(r.initial ?? "");
      setReq(r);
    };
    return () => {
      present = null;
    };
  }, []);

  useEffect(() => {
    if (req?.kind === "prompt") {
      const el = inputRef.current;
      el?.focus();
      const dot = (req.initial ?? "").lastIndexOf(".");
      el?.setSelectionRange(0, dot > 0 ? dot : (req.initial ?? "").length);
    }
  }, [req]);

  if (!req) return null;
  const done = (v: string | boolean | null) => {
    req.resolve(v);
    setReq(null);
  };
  const ok = () => done(req.kind === "prompt" ? (value.trim() ? value.trim() : null) : true);

  return (
    <div className="modal-backdrop" onMouseDown={() => done(req.kind === "prompt" ? null : false)}>
      <div
        className="dialog"
        data-testid="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") done(req.kind === "prompt" ? null : false);
          if (e.key === "Enter") ok();
        }}
      >
        <div className="dialog-title">{req.title}</div>
        {req.message && <div className="dialog-msg">{req.message}</div>}
        {req.kind === "prompt" && (
          <input ref={inputRef} data-testid="dialog-input" value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        <div className="dialog-btns">
          <button data-testid="dialog-cancel" onClick={() => done(req.kind === "prompt" ? null : false)}>
            Cancel
          </button>
          <button
            data-testid="dialog-ok"
            className={req.danger ? "danger" : "primary"}
            autoFocus={req.kind === "confirm"}
            onClick={ok}
          >
            {req.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
