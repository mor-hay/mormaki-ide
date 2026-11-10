export type ToolOp =
  | { type: "edit"; path: string; oldText: string; newText: string }
  | { type: "write"; path: string; content: string }
  | { type: "bash"; command: string; cwd?: string }
  | { type: "read"; path: string; line?: number }
  | { type: "other"; tool: string; params: unknown };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function opsFor(tool: string, p: any): ToolOp[] {
  if (!p || typeof p !== "object") return [];
  const path = str(p.path) ?? str(p.file_path) ?? "";
  switch (tool) {
    case "edit":
      return [{ type: "edit", path, oldText: str(p.old_string) ?? "", newText: str(p.new_string) ?? "" }];
    case "multiedit":
      return (Array.isArray(p.edits) ? p.edits : []).map((e: any) => ({
        type: "edit" as const,
        path,
        oldText: str(e?.old_string) ?? "",
        newText: str(e?.new_string) ?? "",
      }));
    case "edit_lines":
      return [{ type: "edit", path, oldText: "", newText: str(p.new_string) ?? "" }];
    case "write":
      return [{ type: "write", path, content: str(p.content) ?? "" }];
    case "bash":
      return [{ type: "bash", command: str(p.command) ?? "", cwd: str(p.workdir) }];
    case "read":
      return [{ type: "read", path, line: typeof p.offset === "number" && p.offset > 1 ? p.offset : undefined }];
    case "batch":
      return (Array.isArray(p.tool_calls) ? p.tool_calls : []).flatMap((c: any) =>
        opsFor(str(c?.tool) ?? "", c?.parameters ?? c),
      );
    default:
      return [{ type: "other", tool, params: p }];
  }
}

export function toolOps(toolName: string | undefined, rawInput: unknown): ToolOp[] {
  if (!rawInput) return [];
  const p = rawInput as any;
  let tool = toolName ?? "";
  if (!tool) {
    if (Array.isArray(p.tool_calls)) tool = "batch";
    else if (typeof p.old_string === "string") tool = "edit";
    else if (Array.isArray(p.edits)) tool = "multiedit";
    else if (typeof p.content === "string" && p.path) tool = "write";
    else if (typeof p.command === "string") tool = "bash";
  }
  return opsFor(tool, p);
}

export function editedPaths(ops: ToolOp[]): string[] {
  const out = new Set<string>();
  for (const o of ops) if ((o.type === "edit" || o.type === "write") && o.path) out.add(o.path);
  return [...out];
}

export type DiffLine = { t: "ctx" | "add" | "del"; text: string };

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText ? oldText.replace(/\n$/, "").split("\n") : [];
  const b = newText ? newText.replace(/\n$/, "").split("\n") : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [
    ...a.slice(0, pre).map((text) => ({ t: "ctx" as const, text })),
    ...a.slice(pre, a.length - suf).map((text) => ({ t: "del" as const, text })),
    ...b.slice(pre, b.length - suf).map((text) => ({ t: "add" as const, text })),
    ...a.slice(a.length - suf).map((text) => ({ t: "ctx" as const, text })),
  ];
}

export function stripFence(text: string) {
  return text.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```\s*$/, "");
}
