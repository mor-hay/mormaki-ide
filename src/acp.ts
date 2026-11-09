import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string } }
  | { type: string; [k: string]: unknown };

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: string; [k: string]: unknown };

export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  locations?: { path: string; line?: number }[];
  content?: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
}

export interface ConfigOption {
  id: string;
  name: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

export interface SessionInfo {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: { id: string; name: string }[] };
  configOptions?: ConfigOption[];
}

export type SessionUpdate = { sessionUpdate: string; [k: string]: any };

export interface AcpHandlers {
  onUpdate(update: SessionUpdate): void;
  onPermission(req: PermissionRequest): Promise<string | null>;
  onStderr?(line: string): void;
  onExit?(): void;
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

export class AcpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private unlisten: UnlistenFn[] = [];
  private generation = -1;
  private disposed = false;

  constructor(private handlers: AcpHandlers) {}

  async start(cwd: string, thinking?: string) {
    this.dispose();
    this.disposed = false;
    this.unlisten.push(
      await listen<string>("acp://message", (e) => !this.disposed && this.onLine(e.payload)),
      await listen<string>("acp://stderr", (e) => !this.disposed && this.handlers.onStderr?.(e.payload)),
      await listen<number>("acp://exit", (e) => {
        if (this.disposed || e.payload !== this.generation) return;
        for (const p of this.pending.values()) p.reject(new Error("maki acp exited"));
        this.pending.clear();
        this.handlers.onExit?.();
      }),
    );
    this.generation = await invoke<number>("acp_start", { cwd, thinking: thinking || null });
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    });
  }

  dispose() {
    this.disposed = true;
    for (const p of this.pending.values()) p.reject(new Error("ACP client disposed"));
    this.pending.clear();
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
  }

  newSession(cwd: string): Promise<SessionInfo> {
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  loadSession(sessionId: string, cwd: string): Promise<SessionInfo | null> {
    return this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  prompt(sessionId: string, prompt: ContentBlock[]): Promise<{ stopReason: string }> {
    return this.request("session/prompt", { sessionId, prompt });
  }

  cancel(sessionId: string) {
    return this.notify("session/cancel", { sessionId });
  }

  setMode(sessionId: string, modeId: string) {
    return this.request("session/set_mode", { sessionId, modeId });
  }

  setConfigOption(sessionId: string, configId: string, value: string) {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  private send(msg: object) {
    if (this.disposed) return Promise.reject(new Error("ACP client disposed"));
    return invoke("acp_send", { line: JSON.stringify({ jsonrpc: "2.0", ...msg }) });
  }

  request<T = any>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  notify(method: string, params: object) {
    return this.send({ method, params });
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      this.handleAgentRequest(msg.id, msg.method, msg.params);
    } else if (msg.method === "session/update" && msg.params?.update) {
      this.handlers.onUpdate(msg.params.update);
    }
  }

  private async handleAgentRequest(id: number | string, method: string, params: any) {
    try {
      let result: unknown = null;
      switch (method) {
        case "session/request_permission": {
          const optionId = await this.handlers.onPermission(params);
          result = optionId
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } };
          break;
        }
        case "fs/read_text_file": {
          let content: string = await invoke("read_file", { path: params.path });
          if (params.line || params.limit) {
            const lines = content.split("\n");
            const start = Math.max((params.line ?? 1) - 1, 0);
            content = lines.slice(start, params.limit ? start + params.limit : undefined).join("\n");
          }
          result = { content };
          break;
        }
        case "fs/write_text_file":
          await invoke("write_file", { path: params.path, content: params.content });
          break;
        default:
          await this.send({ id, error: { code: -32601, message: `method not found: ${method}` } });
          return;
      }
      await this.send({ id, result });
    } catch (e) {
      await this.send({ id, error: { code: -32603, message: String(e) } });
    }
  }
}
