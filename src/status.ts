import type { WechatBinding, WechatPushScope } from "./remote/index.ts";

export type TelegramConnectionPhase = "disconnected" | "pairing" | "connected";

/** Safe for renderer. The bot token never appears here. */
export type TelegramPublicStatus = {
  phase: TelegramConnectionPhase;
  pairingCode: string | null;
  chatId: number | null;
  pushScope: WechatPushScope;
  binding: WechatBinding | null;
  desktopOnline: boolean;
  lastErrorCode: string | null;
};

export function disconnectedTelegramStatus(): TelegramPublicStatus {
  return {
    phase: "disconnected",
    pairingCode: null,
    chatId: null,
    pushScope: "bound-chat",
    binding: null,
    desktopOnline: false,
    lastErrorCode: null,
  };
}
