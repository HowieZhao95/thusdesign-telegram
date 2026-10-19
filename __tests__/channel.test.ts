import type { WechatHost } from "../src/remote/index.ts";
import { describe, expect, it } from "vitest";
import { createTelegramRuntime, type TelegramUpdate } from "../src/runtime";

const TOKEN = "123456:secret-bot-token";

describe("telegram channel", () => {
  it("keeps the bot token out of public status and pairs one private chat", async () => {
    const prompts: string[] = [];
    const runtime = createTelegramRuntime({
      host: fakeHost(prompts),
      readState: async () => runtime.state(),
      writeState: async () => {},
      fetch: captureSend([]),
      createCode: () => "PAIR01",
    });
    await runtime.connect(TOKEN);
    expect(JSON.stringify(runtime.status())).not.toContain(TOKEN);
    expect(runtime.status().phase).toBe("pairing");
    expect(runtime.status().pairingCode).toBe("PAIR01");

    await runtime.ingest(message(1, 9, "hello"));
    expect(prompts).toEqual([]);
    expect(runtime.state().chatId).toBeNull();

    await runtime.ingest(message(2, 9, "/start PAIR01"));
    expect(runtime.state().chatId).toBe(9);
    expect(runtime.status().phase).toBe("connected");
    expect(runtime.status().pairingCode).toBeNull();

    await runtime.ingest(message(3, 8, "/start PAIR01"));
    expect(runtime.state().chatId).toBe(9);
    expect(prompts).toEqual([]);
  });

  it("advances the offset so the same update cannot prompt twice", async () => {
    const prompts: string[] = [];
    const runtime = boundRuntime(prompts);
    const update = message(5, 9, "你好");
    await runtime.ingest(update);
    await runtime.ingest(update);
    expect(prompts).toEqual(["你好"]);
    expect(runtime.state().offset).toBe(6);
  });

  it("asks for a binding before prompting, then returns the assistant reply", async () => {
    const prompts: string[] = [];
    const sent: string[] = [];
    const runtime = createTelegramRuntime({
      host: fakeHost(prompts, "回复"),
      readState: async () => runtime.state(),
      writeState: async () => {},
      fetch: captureSend(sent),
      createCode: () => "PAIR01",
    });
    await runtime.connect(TOKEN);
    await runtime.ingest(message(1, 9, "/start PAIR01"));
    sent.length = 0;
    await runtime.ingest(message(2, 9, "你好"));
    expect(prompts).toEqual([]);
    expect(sent.join("\n")).toContain("还没有绑定会话");

    runtime.replaceState({
      ...runtime.state(),
      ownerUserId: "user",
      binding: { teamId: "team-a", projectId: "project", chatId: "chat" },
    });
    await runtime.ingest(message(3, 9, "画一张"));
    expect(prompts).toEqual(["画一张"]);
    expect(sent).toContain("回复");
  });

  it("turns allow and deny into the pending permission answer", async () => {
    const prompts: string[] = [];
    const answers: string[] = [];
    const host = fakeHost(prompts);
    host.answerPermission = async (input) => {
      answers.push(input.optionId);
      return "accepted";
    };
    const runtime = boundRuntime(prompts, host);
    await runtime.present({
      kind: "permission",
      interactionId: "ix",
      projectId: "project",
      chatId: "chat",
      allowOptionId: "yes",
      denyOptionId: "no",
      toolName: "bash",
    });
    await runtime.ingest(message(2, 9, "允许"));
    await runtime.present({
      kind: "permission",
      interactionId: "ix-2",
      projectId: "project",
      chatId: "chat",
      allowOptionId: "yes",
      denyOptionId: "no",
      toolName: "bash",
    });
    await runtime.ingest(message(3, 9, "拒绝"));
    expect(answers).toEqual(["yes", "no"]);
    expect(prompts).toEqual([]);
  });

  it("polls with the saved offset and does not replay an ingested update", async () => {
    const prompts: string[] = [];
    const urls: string[] = [];
    let served = false;
    const runtime = boundRuntime(prompts, undefined, async (input) => {
      urls.push(String(input));
      if (!served && String(input).includes("getUpdates")) {
        served = true;
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              message(5, 9, "你好").message
                ? {
                    update_id: 5,
                    message: {
                      message_id: 1,
                      chat: { id: 9, type: "private" },
                      text: "你好",
                    },
                  }
                : {},
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
      });
    });
    await runtime.pollOnce();
    await runtime.pollOnce();
    expect(prompts).toEqual(["你好"]);
    expect(urls.some((url) => url.includes("/getUpdates"))).toBe(true);
    expect(runtime.state().offset).toBe(6);
  });
});

function boundRuntime(
  prompts: string[],
  host = fakeHost(prompts, "回复"),
  fetchImpl?: typeof fetch
) {
  const runtime = createTelegramRuntime({
    host,
    readState: async () => runtime.state(),
    writeState: async () => {},
    ...(fetchImpl ? { fetch: fetchImpl } : { fetch: captureSend([]) }),
    createCode: () => "PAIR01",
  });
  runtime.replaceState({
    version: 1,
    token: TOKEN,
    chatId: 9,
    offset: 0,
    pairingCode: null,
    ownerUserId: "user",
    binding: { teamId: "team-a", projectId: "project", chatId: "chat" },
    pushScope: "bound-chat",
    thinkingLevel: null,
    browse: null,
  });
  return runtime;
}

function message(
  updateId: number,
  chatId: number,
  text: string
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: "private" },
      text,
    },
  };
}

function captureSend(sent: string[]): typeof fetch {
  return (async (_input, init) => {
    if (init?.body) {
      const body = JSON.parse(String(init.body)) as { text?: string };
      if (body.text) {
        sent.push(body.text);
      }
    }
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      {
        status: 200,
      }
    );
  }) as typeof fetch;
}

function fakeHost(prompts: string[], reply = ""): WechatHost {
  return {
    ownerUserId: async () => "user",
    locale: async () => "zh",
    catalog: async () => ({
      teams: [{ id: "team-a", name: "A" }],
      projects: [
        { id: "project", teamId: "team-a", name: "P", origin: "cloud" },
      ],
      chats: [{ id: "chat", projectId: "project", title: "Chat" }],
      models: [{ id: "openai/gpt", name: "GPT" }],
      currentModelId: "openai/gpt",
    }),
    createChat: async () => "chat-new",
    submitTurn: async (input) => {
      prompts.push(input.text);
      return { reply };
    },
    cancelActive: async () => {},
    setModel: async () => {},
    answerPermission: async () => "accepted",
    answerForm: async () => "accepted",
    saveInbound: async () => "telegram-inbox/file.png",
  };
}
