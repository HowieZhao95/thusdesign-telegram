import type {
  WechatBinding,
  WechatBrowse,
  WechatPushScope,
} from "./remote/index.ts";

export type TelegramChannelState = {
  version: 1;
  token: string | null;
  chatId: number | null;
  offset: number;
  pairingCode: string | null;
  ownerUserId: string | null;
  binding: WechatBinding | null;
  pushScope: WechatPushScope;
  thinkingLevel: string | null;
  browse: WechatBrowse | null;
};

export function emptyTelegramState(): TelegramChannelState {
  return {
    version: 1,
    token: null,
    chatId: null,
    offset: 0,
    pairingCode: null,
    ownerUserId: null,
    binding: null,
    pushScope: "bound-chat",
    thinkingLevel: null,
    browse: null,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : null;
}

function binding(value: unknown): WechatBinding | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const teamId = text(row.teamId);
  const projectId = text(row.projectId);
  const chatId = text(row.chatId);
  if (!(teamId && projectId && chatId)) {
    return null;
  }
  const canvasId = text(row.canvasId);
  return {
    teamId,
    projectId,
    chatId,
    ...(canvasId ? { canvasId } : {}),
  };
}

function browse(value: unknown): WechatBrowse | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const level = row.level;
  if (level !== "teams" && level !== "projects" && level !== "chats") {
    return null;
  }
  if (
    typeof row.at !== "number" ||
    typeof row.page !== "number" ||
    !Number.isInteger(row.page) ||
    row.page < 0
  ) {
    return null;
  }
  return {
    level,
    teamId: text(row.teamId),
    projectId: text(row.projectId),
    page: row.page,
    at: row.at,
  };
}

/** Whitelist restore. The bot token stays in the state file and never in public status. */
export function normalizeTelegramState(value: unknown): TelegramChannelState {
  const base = emptyTelegramState();
  if (!value || typeof value !== "object") {
    return base;
  }
  const row = value as Record<string, unknown>;
  const chatId =
    typeof row.chatId === "number" && Number.isInteger(row.chatId)
      ? row.chatId
      : null;
  const offset =
    typeof row.offset === "number" &&
    Number.isInteger(row.offset) &&
    row.offset >= 0
      ? row.offset
      : 0;
  return {
    version: 1,
    token: text(row.token),
    chatId,
    offset,
    pairingCode: text(row.pairingCode),
    ownerUserId: text(row.ownerUserId),
    binding: binding(row.binding),
    pushScope: row.pushScope === "same-project" ? "same-project" : "bound-chat",
    thinkingLevel: text(row.thinkingLevel),
    browse: browse(row.browse),
  };
}
