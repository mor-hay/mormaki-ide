import { loader } from "@monaco-editor/react";
import * as monaco from "./monacoSlim";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco: monaco as any });

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  json: "json", css: "css", scss: "scss", html: "html", md: "markdown", rs: "rust", py: "python",
  go: "go", lua: "lua", toml: "ini", yaml: "yaml", yml: "yaml", sh: "shell", java: "java",
  c: "c", h: "c", cpp: "cpp", swift: "swift", kt: "kotlin", rb: "ruby", sql: "sql",
};

export function langFor(path: string) {
  return EXT_LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}
