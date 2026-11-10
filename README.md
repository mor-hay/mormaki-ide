# MorMaki IDE

A Cursor-like AI code editor and [Maki](https://maki.sh) Lua plugin powered by `maki acp` (Agent Client Protocol), built with **Tauri 2 (Rust) + React + Monaco Editor + xterm.js**.

## Features

- **Editor**: Monaco with tabs, syntax highlighting, quick open (`⌘P`), command palette (`⇧⌘P`), status bar.
- **Explorer**: new file/folder, rename, move to Trash, open a terminal in any folder (right-click).
- **Search in files** (`⇧⌘F`) with jump-to-line and match-case.
- **Source Control**: changed files, diff against `HEAD`, stage, unstage, discard, commit.
- **Integrated terminal** (`⌘J`): real PTY shells, multiple tabs.
- **AI chat on `maki acp`**:
  - several chats in parallel, each with its own maki process, model, mode and reasoning effort
  - code edits shown as diffs; new files and shell commands shown inline; highlighted code blocks with Insert/Copy
  - review bar to Accept or Reject every file maki changed (Reject restores the exact previous content)
  - message queue while maki is working, Stop, auto-run toggle (`--yolo`), permission prompts
  - chat history: reopen any past session for the folder; open chats survive restarts
  - `@file` mentions, `⌘L` add selection to chat, `⌘K` inline edit, paste or drop images
- **Maki plugin**: `/ide` and `/mormaki` commands and the `open_mormaki_ide` tool.

Not included: Cursor-style Tab autocomplete, and language-server features (errors, go-to-definition).

Reasoning effort is applied through the `MORMAKI_THINKING` environment variable. To make it take effect, add to `~/.config/maki/init.lua`:

```lua
local effort = maki.uv.os_getenv("MORMAKI_THINKING")
if effort and effort ~= "" then
  maki.setup({ always_thinking = tonumber(effort) or effort })
end
```

## Install as a Maki Plugin

Add `mormaki-ide` to `~/.config/maki/init.lua`:

```lua
maki.pack.add({
  "https://github.com/mor-hay/mormaki-ide",
})
```

Then run `/ide` (or `/mormaki`) inside Maki to open the current workspace in **MorMaki IDE**.

## Development & Standalone Build

```bash
npm install
npm run tauri dev
```

To build a standalone native `.app` / binary:

```bash
npm run tauri build
```

## End-to-end tests

```bash
npm run tauri build -- --bundles app
python3 e2e/run.py            # all tests
python3 e2e/run.py t08 t13    # only matching tests
```

The suite launches the real release binary on a throwaway git repo and drives the real webview
through an automation port that only exists when `MORMAKI_E2E_PORT` is set (loopback only).
Chat tests talk to real `maki acp`, so they need a logged-in maki and spend a few cents
(model: `MORMAKI_E2E_MODEL`, default `anthropic/claude-haiku-4-5`).
