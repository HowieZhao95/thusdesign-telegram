# thusdesign-telegram

Pair one Telegram private chat with a desktop agent session.

A phone message enters the agent that is already running on your computer. The reply, and a permission prompt, come back to that same chat. The library does not start a second agent and does not open a public webhook.

## What you implement

`createTelegramRuntime` needs a host:

- who is signed in on the desktop
- the team, project, and chat catalog
- `submitTurn` into the already bound agent session
- `answerPermission` / `answerForm` for the tool confirmation that is already waiting

Ordinary text becomes a prompt on the bound chat. `/list`, `/switch`, `/new`, `/model`, `/cancel`, and `/help` select that chat. Reply `允许` or `allow` to approve a tool, and `拒绝` or `deny` to reject it.

## Pairing

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Call `connect(token)`. Public status returns a pairing code and never includes the token.
3. In a private chat with the bot, send `/start <code>`.
4. Messages from any other chat are ignored. The update offset is stored, so a restart does not send the same prompt twice.

```ts
import { createTelegramRuntime } from "thusdesign-telegram";

const runtime = createTelegramRuntime({
  host,
  readState: () => readTelegramStateFile(statePath),
  writeState: (state) => writeTelegramStateFile(statePath, state),
});
await runtime.connect(token);
runtime.start();
```

Long polling stays inside the desktop process. When that process exits, Telegram control stops.

## Not in this release

Groups, forum topics, inline keyboards, voice, and media. Text only.

## License

MIT
