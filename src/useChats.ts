import { useCallback, useEffect, useRef, useState } from "react";
import { AcpClient, ConfigOption, ContentBlock, PermissionRequest, SessionUpdate, ToolCall } from "./acp";
import type { ChatItem } from "./Chat";

export interface ChatState {
  key: string;
  root: string;
  sessionId?: string;
  title: string;
  items: ChatItem[];
  busy: boolean;
  ready: boolean;
  restoring: boolean;
  permission: PermissionRequest | null;
  usage?: { used: number; size: number; cost?: { amount: number } };
  model?: ConfigOption;
  mode?: string;
  modes: { id: string; name: string }[];
  effort: string;
  unread: boolean;
}

interface Saved {
  sessionId: string;
  title: string;
  effort: string;
}

export interface ChatHooks {
  onToolCall(call: ToolCall, replaying: boolean): void;
}

const NEW_TITLE = "New chat";
const storeKey = (root: string) => `mormaki_chats:${root}`;
const activeStoreKey = (root: string) => `mormaki_active_chat:${root}`;
const newKey = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const defaultEffort = () => localStorage.getItem("mormaki_effort") ?? "";

const blank = (root: string, effort: string): ChatState => ({
  key: newKey(),
  root,
  title: NEW_TITLE,
  items: [],
  busy: false,
  ready: false,
  restoring: true,
  permission: null,
  modes: [],
  effort,
  unread: false,
});

export function useChats(root: string | null, hooks: ChatHooks) {
  const [chats, setChats] = useState<ChatState[]>([]);
  const [activeKey, setActiveKeyRaw] = useState<string>();
  const clients = useRef<Record<string, AcpClient>>({});
  const perms = useRef<Record<string, (id: string | null) => void>>({});
  const replaying = useRef<Record<string, boolean>>({});
  const toolNames = useRef<Record<string, string>>({});
  const rawInputs = useRef<Record<string, unknown>>({});
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const activeRef = useRef(activeKey);
  activeRef.current = activeKey;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  const update = useCallback((key: string, fn: (c: ChatState) => ChatState) => {
    setChats((cs) => cs.map((c) => (c.key === key ? fn(c) : c)));
  }, []);

  const pushItem = useCallback(
    (key: string, item: ChatItem) => update(key, (c) => ({ ...c, items: [...c.items, item] })),
    [update],
  );

  const setActiveKey = useCallback(
    (key: string) => {
      setActiveKeyRaw(key);
      update(key, (c) => (c.unread ? { ...c, unread: false } : c));
    },
    [update],
  );

  const applyUpdate = useCallback(
    (key: string, u: SessionUpdate) => {
      const appendText = (kind: "agent" | "thought" | "user", text: string) =>
        update(key, (c) => {
          const last = c.items[c.items.length - 1] as any;
          const items: ChatItem[] =
            last?.kind === kind
              ? [...c.items.slice(0, -1), { ...last, text: last.text + text }]
              : [...c.items, { kind, text } as ChatItem];
          return { ...c, items };
        });

      switch (u.sessionUpdate) {
        case "user_message_chunk":
          if (u.content?.type === "text") appendText("user", u.content.text);
          break;
        case "agent_message_chunk":
          if (u.content?.type === "text") appendText("agent", u.content.text);
          break;
        case "agent_thought_chunk":
          if (u.content?.type === "text") appendText("thought", u.content.text);
          break;
        case "tool_call":
        case "tool_call_update": {
          const raw = u as unknown as ToolCall;
          const tk = `${key}:${raw.toolCallId}`;
          if (u.sessionUpdate === "tool_call" && raw.title) toolNames.current[tk] = raw.title;
          if (raw.rawInput !== undefined) rawInputs.current[tk] = raw.rawInput;
          const call: ToolCall = { ...raw, toolName: toolNames.current[tk] };
          update(key, (c) => {
            const i = c.items.findIndex((x) => x.kind === "tool" && x.call.toolCallId === call.toolCallId);
            if (i < 0) return { ...c, items: [...c.items, { kind: "tool", call }] };
            const prev = (c.items[i] as { kind: "tool"; call: ToolCall }).call;
            const merged = { ...prev, ...Object.fromEntries(Object.entries(call).filter(([, v]) => v !== undefined)) };
            const items = [...c.items];
            items[i] = { kind: "tool", call: merged as ToolCall };
            return { ...c, items };
          });
          hooksRef.current.onToolCall(
            { ...call, rawInput: rawInputs.current[tk] },
            !!replaying.current[key],
          );
          break;
        }
        case "plan":
          update(key, (c) => ({
            ...c,
            items: [...c.items.filter((x) => x.kind !== "plan"), { kind: "plan", entries: u.entries }],
          }));
          break;
        case "usage_update":
          update(key, (c) => ({ ...c, usage: u as any }));
          break;
        case "current_mode_update":
          update(key, (c) => ({ ...c, mode: u.currentModeId }));
          break;
        case "config_option_update": {
          const m = u.configOptions?.find((o: ConfigOption) => o.id === "model");
          if (m) update(key, (c) => ({ ...c, model: m }));
          break;
        }
      }
    },
    [update],
  );

  const startChat = useCallback(
    async (key: string, dir: string, effort: string, resumeId?: string) => {
      const client = new AcpClient({
        onUpdate: (u) => applyUpdate(key, u),
        onPermission: (req) =>
          new Promise((resolve) => {
            perms.current[key] = resolve;
            update(key, (c) => ({ ...c, permission: req, unread: c.unread || activeRef.current !== key }));
          }),
        onStderr: (line) => console.debug(`[maki ${key}]`, line),
        onExit: () =>
          update(key, (c) => ({
            ...c,
            ready: false,
            busy: false,
            items: [...c.items, { kind: "error", text: "maki acp exited. Change effort or open a new chat to restart." }],
          })),
      });
      clients.current[key] = client;
      try {
        await client.start(dir, effort);
        let s: { sessionId?: string; modes?: any; configOptions?: ConfigOption[] } | null = null;
        if (resumeId) {
          replaying.current[key] = true;
          try {
            s = (await client.loadSession(resumeId, dir)) ?? {};
            s.sessionId = resumeId;
          } catch (e) {
            if (clients.current[key] === client) {
              pushItem(key, { kind: "error", text: `Could not resume this chat, started fresh: ${String(e)}` });
            }
          } finally {
            replaying.current[key] = false;
          }
        }
        if (!s) s = await client.newSession(dir);
        if (clients.current[key] !== client) return;
        const model = s.configOptions?.find((o) => o.id === "model");
        update(key, (c) => ({
          ...c,
          sessionId: s!.sessionId,
          ready: true,
          restoring: false,
          modes: s!.modes?.availableModes ?? c.modes,
          mode: s!.modes?.currentModeId ?? c.mode,
          model: model ?? c.model,
        }));
      } catch (e) {
        if (clients.current[key] !== client || String(e).includes("disposed")) return;
        update(key, (c) => ({ ...c, restoring: false, items: [...c.items, { kind: "error", text: String(e) }] }));
      }
    },
    [applyUpdate, update, pushItem],
  );

  useEffect(() => {
    if (!root) return;
    let saved: Saved[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(storeKey(root)) ?? "[]");
    } catch {
      saved = [];
    }
    const initial = saved.length
      ? saved.map((s) => ({ ...blank(root, s.effort ?? defaultEffort()), title: s.title || "Chat", sessionId: s.sessionId }))
      : [blank(root, defaultEffort())];
    const lastActive = localStorage.getItem(activeStoreKey(root));
    setChats(initial);
    setActiveKeyRaw((initial.find((c) => c.sessionId && c.sessionId === lastActive) ?? initial[0]).key);
    initial.forEach((c) => startChat(c.key, root, c.effort, c.sessionId));
    return () => {
      Object.values(perms.current).forEach((r) => r(null));
      perms.current = {};
      Object.values(clients.current).forEach((c) => c.dispose());
      clients.current = {};
    };
  }, [root, startChat]);

  useEffect(() => {
    if (!root) return;
    const mine = chats.filter((c) => c.root === root);
    if (mine.length === 0) return;
    const saved: Saved[] = mine
      .filter((c) => c.sessionId)
      .map((c) => ({ sessionId: c.sessionId!, title: c.title, effort: c.effort }));
    localStorage.setItem(storeKey(root), JSON.stringify(saved));
    const active = mine.find((c) => c.key === activeKey);
    if (active?.sessionId) localStorage.setItem(activeStoreKey(root), active.sessionId);
  }, [chats, activeKey, root]);

  const newChat = useCallback(() => {
    if (!root) return;
    const cur = chatsRef.current.find((c) => c.key === activeRef.current);
    const c = blank(root, cur?.effort ?? defaultEffort());
    if (cur?.model) c.model = cur.model;
    setChats((cs) => [...cs, c]);
    setActiveKeyRaw(c.key);
    startChat(c.key, root, c.effort).then(() => {
      const wanted = cur?.model?.currentValue;
      const chat = chatsRef.current.find((x) => x.key === c.key);
      if (wanted && chat?.sessionId && chat.model?.currentValue !== wanted) {
        clients.current[c.key]
          ?.setConfigOption(chat.sessionId, "model", wanted)
          .then((r: any) => {
            const m = r?.configOptions?.find((o: ConfigOption) => o.id === "model");
            if (m) update(c.key, (x) => ({ ...x, model: m }));
          })
          .catch(() => {});
      }
    });
  }, [root, startChat, update]);

  const closeChat = useCallback(
    (key: string) => {
      perms.current[key]?.(null);
      delete perms.current[key];
      clients.current[key]?.dispose();
      delete clients.current[key];
      const rest = chatsRef.current.filter((c) => c.key !== key);
      setChats(rest);
      if (activeRef.current === key) {
        const idx = chatsRef.current.findIndex((c) => c.key === key);
        const next = rest[Math.min(idx, rest.length - 1)];
        if (next) setActiveKey(next.key);
      }
      if (rest.length === 0) newChat();
    },
    [newChat, setActiveKey],
  );

  const send = useCallback(
    async (key: string, blocks: ContentBlock[], userItem: ChatItem & { kind: "user" }) => {
      const chat = chatsRef.current.find((c) => c.key === key);
      const client = clients.current[key];
      if (!chat?.sessionId || !client || chat.busy) return;
      update(key, (c) => ({
        ...c,
        busy: true,
        items: [...c.items, userItem],
        title: c.title === NEW_TITLE ? userItem.text.replace(/\s+/g, " ").slice(0, 40) || NEW_TITLE : c.title,
      }));
      try {
        const r = await client.prompt(chat.sessionId, blocks);
        if (r.stopReason && r.stopReason !== "end_turn" && r.stopReason !== "cancelled") {
          pushItem(key, { kind: "error", text: `stopped: ${r.stopReason}` });
        }
      } catch (e) {
        if (!String(e).includes("disposed")) pushItem(key, { kind: "error", text: String(e) });
      } finally {
        delete perms.current[key];
        update(key, (c) => ({ ...c, busy: false, permission: null, unread: activeRef.current !== key }));
      }
    },
    [update, pushItem],
  );

  const cancel = useCallback(
    (key: string) => {
      const chat = chatsRef.current.find((c) => c.key === key);
      if (chat?.sessionId) clients.current[key]?.cancel(chat.sessionId);
      perms.current[key]?.(null);
      delete perms.current[key];
      update(key, (c) => ({ ...c, permission: null }));
    },
    [update],
  );

  const answerPermission = useCallback(
    (key: string, optionId: string | null) => {
      perms.current[key]?.(optionId);
      delete perms.current[key];
      update(key, (c) => ({ ...c, permission: null }));
    },
    [update],
  );

  const setModel = useCallback(
    (key: string, value: string) => {
      const chat = chatsRef.current.find((c) => c.key === key);
      if (!chat?.sessionId) return;
      clients.current[key]
        ?.setConfigOption(chat.sessionId, "model", value)
        .then((r: any) => {
          const m = r?.configOptions?.find((o: ConfigOption) => o.id === "model");
          update(key, (c) => ({ ...c, model: m ?? (c.model ? { ...c.model, currentValue: value } : c.model) }));
        })
        .catch((e) => pushItem(key, { kind: "error", text: String(e) }));
    },
    [update, pushItem],
  );

  const setMode = useCallback(
    (key: string, modeId: string) => {
      const chat = chatsRef.current.find((c) => c.key === key);
      if (!chat?.sessionId) return;
      clients.current[key]
        ?.setMode(chat.sessionId, modeId)
        .then(() => update(key, (c) => ({ ...c, mode: modeId })))
        .catch((e) => pushItem(key, { kind: "error", text: String(e) }));
    },
    [update, pushItem],
  );

  const setEffort = useCallback(
    async (key: string, effort: string) => {
      const chat = chatsRef.current.find((c) => c.key === key);
      if (!chat || chat.busy || chat.effort === effort || !root) return;
      localStorage.setItem("mormaki_effort", effort);
      update(key, (c) => ({ ...c, effort, ready: false, restoring: true, items: c.sessionId ? [] : c.items }));
      const old = clients.current[key];
      delete clients.current[key];
      await old?.dispose();
      if (!chatsRef.current.some((c) => c.key === key) || clients.current[key]) return;
      await startChat(key, root, effort, chat.sessionId);
    },
    [root, startChat, update],
  );

  const active = chats.find((c) => c.key === activeKey);

  return {
    chats,
    active,
    activeKey,
    setActiveKey,
    newChat,
    closeChat,
    send,
    cancel,
    answerPermission,
    setModel,
    setMode,
    setEffort,
  };
}
