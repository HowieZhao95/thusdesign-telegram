import {
  createRemoteControl,
  emptyWechatState,
  type WechatChannelState,
  type WechatHost,
  type WechatPending,
  type WechatPushScope,
  wechatLocale,
} from "./remote/index.ts";
import {
  emptyTelegramState,
  normalizeTelegramState,
  type TelegramChannelState,
} from "./state";
import type { TelegramPublicStatus } from "./status";

const API = "https://api.telegram.org";
const TEXT_LIMIT = 4000;
const START = /^\/start(?:@\S+)?(?:\s+(\S+))?$/i;

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
  };
};

export type TelegramRuntime = {
  status(): TelegramPublicStatus;
  state(): TelegramChannelState;
  replaceState(state: TelegramChannelState): void;
  setPushScope(scope: WechatPushScope): void;
  connect(token: string): Promise<void>;
  present(pending: WechatPending): Promise<void>;
  ingest(update: TelegramUpdate): Promise<void>;
  pollOnce(timeoutSeconds?: number): Promise<void>;
  start(): void;
  stop(): void;
};

type TelegramApiResult = {
  ok?: boolean;
  error_code?: number;
  result?: unknown;
};

export function createTelegramRuntime(options: {
  host: WechatHost;
  readState: () => Promise<TelegramChannelState>;
  writeState: (state: TelegramChannelState) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  createCode?: () => string;
  onState?: (state: TelegramChannelState) => void;
}): TelegramRuntime {
  let state = emptyTelegramState();
  let lastErrorCode: string | null = null;
  let polling = false;
  let abort: AbortController | null = null;
  const fetchImpl = options.fetch ?? fetch;

  async function persist() {
    await options.writeState(state);
    options.onState?.(state);
  }

  function productOf(current: TelegramChannelState): WechatChannelState {
    return {
      ...emptyWechatState(),
      ownerUserId: current.ownerUserId,
      binding: current.binding,
      pushScope: current.pushScope,
      thinkingLevel: current.thinkingLevel,
      browse: current.browse,
    };
  }

  const control = createRemoteControl({
    host: options.host,
    say,
    getState: () => productOf(state),
    setState: async (next) => {
      state = {
        ...state,
        ownerUserId: next.ownerUserId,
        binding: next.binding,
        pushScope: next.pushScope,
        thinkingLevel: next.thinkingLevel,
        browse: next.browse,
      };
      await persist();
    },
    ...(options.now ? { now: options.now } : {}),
    setError: (code) => {
      lastErrorCode = code;
    },
  });

  function phase(): TelegramPublicStatus["phase"] {
    if (!state.token || lastErrorCode === "telegram-token-rejected") {
      return "disconnected";
    }
    return state.chatId == null ? "pairing" : "connected";
  }

  function publicStatus(): TelegramPublicStatus {
    const current = phase();
    return {
      phase: current,
      pairingCode: current === "pairing" ? state.pairingCode : null,
      chatId: state.chatId,
      pushScope: state.pushScope,
      binding: state.binding,
      desktopOnline: true,
      lastErrorCode,
    };
  }

  async function say(text: string) {
    const token = state.token;
    const chatId = state.chatId;
    if (!(token && chatId != null && text.trim())) {
      return;
    }
    for (let start = 0; start < text.length; start += TEXT_LIMIT) {
      await call(token, "sendMessage", {
        chat_id: chatId,
        text: text.slice(start, start + TEXT_LIMIT),
      });
    }
  }

  async function call(
    token: string,
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<TelegramApiResult> {
    const response = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    return (await response.json()) as TelegramApiResult;
  }

  return {
    status: publicStatus,
    state: () => state,
    replaceState(next) {
      state = normalizeTelegramState(next);
    },
    setPushScope(scope) {
      state = { ...state, pushScope: scope };
      void persist();
    },
    async connect(token) {
      const trimmed = token.trim();
      if (!trimmed) {
        throw new Error("telegram-token-invalid");
      }
      lastErrorCode = null;
      state = {
        ...state,
        token: trimmed,
        pairingCode:
          state.chatId == null
            ? (options.createCode?.() ?? createPairingCode())
            : null,
      };
      await persist();
    },
    present: (pending) => control.present(pending),
    async ingest(update) {
      if (
        !Number.isInteger(update.update_id) ||
        update.update_id < state.offset
      ) {
        return;
      }
      state = { ...state, offset: update.update_id + 1 };
      await persist();
      const message = update.message;
      const text = message?.text?.trim();
      if (!(message && text) || message.chat.type !== "private") {
        return;
      }
      if (state.chatId == null) {
        const code = pairingArgument(text);
        if (code && code === state.pairingCode) {
          state = { ...state, chatId: message.chat.id, pairingCode: null };
          await persist();
          const locale = wechatLocale(await options.host.locale());
          await say(
            locale === "en"
              ? "Telegram is connected. Use /list to choose a chat."
              : "Telegram 已连接。用 /list 选择会话。"
          );
        }
        return;
      }
      if (message.chat.id !== state.chatId || pairingArgument(text)) {
        return;
      }
      await control.handleText(text);
    },
    async pollOnce(timeoutSeconds = 0) {
      const token = state.token;
      if (!token) {
        return;
      }
      const payload = await call(token, "getUpdates", {
        offset: state.offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message"],
      });
      if (payload.ok !== true) {
        if (payload.error_code === 401) {
          lastErrorCode = "telegram-token-rejected";
        }
        return;
      }
      if (!Array.isArray(payload.result)) {
        return;
      }
      for (const update of payload.result) {
        if (isUpdate(update)) {
          await this.ingest(update);
        }
      }
    },
    start() {
      if (polling) {
        return;
      }
      polling = true;
      abort = new AbortController();
      const signal = abort.signal;
      void (async () => {
        while (!signal.aborted) {
          try {
            await this.pollOnce(25);
            if (lastErrorCode === "telegram-token-rejected") {
              this.stop();
              return;
            }
            if (lastErrorCode === "telegram-unreachable") {
              lastErrorCode = null;
            }
          } catch {
            if (signal.aborted) {
              return;
            }
            lastErrorCode = "telegram-unreachable";
            await delay(1000, signal);
          }
        }
      })();
    },
    stop() {
      abort?.abort();
      abort = null;
      polling = false;
    },
  };
}

function pairingArgument(text: string): string | null {
  const match = START.exec(text);
  return match?.[1] ?? null;
}

function createPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function isUpdate(value: unknown): value is TelegramUpdate {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof (value as { update_id?: unknown }).update_id === "number";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
