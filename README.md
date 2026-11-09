# MorMaki IDE

A Cursor-like AI code editor and [Maki](https://maki.sh) Lua plugin powered by `maki acp` (Agent Client Protocol), built with **Tauri 2 (Rust) + React + Monaco Editor + xterm.js**.

## Features

- **Monaco Code Editor** — Multi-tab editing, syntax highlighting, dirty indicators, and line-number jumps.
- **Maki ACP Chat Panel** — Streaming responses, collapsible thinking blocks, Markdown + code-block copy, live tool-call cards, plan checklists, model & mode (`Build` / `Plan`) switching, and context usage meter.
- **Inline Edit (`⌘K`) & Add to Chat (`⌘L`)** — Highlight code and press `⌘K` for inline AI edits or `⌘L` to attach code ranges to chat.
- **Visual Diff Review** — Accept or Reject AI file edits (including automatic cleanup of newly created files on Reject).
- **Quick Open (`⌘P`) & `@file` Mentions** — Fuzzy file search modal and `@` file autocomplete directly in the chat composer.
- **Vision Support (`⌘V` / Drag & Drop)** — Paste screenshots or drop images directly into the chat for visual analysis.
- **Integrated Multi-Tab Terminal (`⌘J` / Right-Click)** — Full interactive PTY shell (`xterm.js` + `portable-pty`). Right-click any folder or file in the explorer and choose **Open in Integrated Terminal**, or open multiple terminal tabs with `＋`.
- **Maki Plugin Integration** — Adds `/ide` and `/mormaki` slash commands and the `open_mormaki_ide` tool inside `maki`.

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
