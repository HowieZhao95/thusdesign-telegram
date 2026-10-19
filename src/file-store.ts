import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeTelegramState, type TelegramChannelState } from "./state";

export async function readTelegramStateFile(
  path: string
): Promise<TelegramChannelState> {
  try {
    const raw = await readFile(path, "utf8");
    return normalizeTelegramState(JSON.parse(raw) as unknown);
  } catch {
    return normalizeTelegramState(null);
  }
}

/** Atomic replace. Mode 0600 so the bot token is not group-readable. */
export async function writeTelegramStateFile(
  path: string,
  state: TelegramChannelState
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
}
