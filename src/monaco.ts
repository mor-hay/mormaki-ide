import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label)) return new HtmlWorker();
    if (["typescript", "javascript"].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  json: "json", css: "css", scss: "scss", html: "html", md: "markdown", rs: "rust", py: "python",
  go: "go", lua: "lua", toml: "ini", yaml: "yaml", yml: "yaml", sh: "shell", java: "java",
  c: "c", h: "c", cpp: "cpp", swift: "swift", kt: "kotlin", rb: "ruby", sql: "sql",
};

export function langFor(path: string) {
  return EXT_LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}
