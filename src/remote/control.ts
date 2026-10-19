import { randomUUID } from "node:crypto";
import type { WechatCatalog, WechatModelRow } from "./catalog";
import { shortId } from "./catalog";
import { parseApprovalReply, parseWechatCommand } from "./commands";
import { type WechatLocale, wechatCopy, wechatLocale } from "./copy";
import {
  browseFor,
  chatTitle,
  moveBrowseUp,
  projectName,
  renderBrowse,
  selectBrowseRow,
  teamName,
} from "./navigate";
import type { WechatChannelState } from "./state";

export type WechatPending =
  | {
      kind: "permission";
      interactionId: string;
      projectId: string;
      chatId: string;
      allowOptionId: string;
      denyOptionId: string;
      toolName: string;
    }
  | {
      kind: "form";
      interactionId: string;
      projectId: string;
      chatId: string;
      message: string;
    };

export type WechatHost = {
  ownerUserId(): Promise<string | null>;
  locale(): Promise<string | null>;
  catalog(input: {
    teamId: string | null;
    projectId: string | null;
    chatId: string | null;
  }): Promise<WechatCatalog>;
  createChat(projectId: string, title?: string): Promise<string>;
  submitTurn(input: {
    projectId: string;
    chatId: string;
    canvasId?: string;
    text: string;
    requestId: string;
    modelSelector?: string;
    thinkingLevel?: string;
  }): Promise<{ reply: string }>;
  cancelActive(projectId: string, chatId: string): Promise<void>;
  setModel(projectId: string, chatId: string, selector: string): Promise<void>;
  answerPermission(input: {
    interactionId: string;
    projectId: string;
    chatId: string;
    optionId: string;
  }): Promise<"accepted" | "settled">;
  answerForm(input: {
    interactionId: string;
    projectId: string;
    chatId: string;
    text: string;
  }): Promise<"accepted" | "settled">;
  saveInbound(input: {
    projectId: string;
    chatId: string;
    name: string;
    bytes: Uint8Array;
  }): Promise<string>;
};

export type RemoteControl = {
  /** False when the desktop owner is missing or has changed. */
  handleText(text: string): Promise<boolean>;
  present(pending: WechatPending): Promise<void>;
};

export function createRemoteControl(options: {
  host: WechatHost;
  say(text: string): Promise<void>;
  getState(): WechatChannelState;
  setState(state: WechatChannelState): Promise<void>;
  now?: () => number;
  setError?(code: string): void;
}): RemoteControl {
  let pending: WechatPending | null = null;
  const now = options.now ?? Date.now;

  function localeOf(value: string | null): WechatLocale {
    return wechatLocale(value);
  }

  async function ensureOwner(): Promise<boolean> {
    const owner = await options.host.ownerUserId();
    const state = options.getState();
    if (!owner) {
      await options.setState({ ...state, binding: null, ownerUserId: null });
      return false;
    }
    if (state.ownerUserId && state.ownerUserId !== owner) {
      await options.setState({
        ...options.getState(),
        binding: null,
        ownerUserId: owner,
        browse: null,
      });
      const copy = wechatCopy(localeOf(await options.host.locale()));
      await options.say(copy.ownerChanged);
      return false;
    }
    if (!state.ownerUserId) {
      await options.setState({ ...options.getState(), ownerUserId: owner });
    }
    return true;
  }

  async function handleCommand(text: string) {
    const copy = wechatCopy(localeOf(await options.host.locale()));
    const command = parseWechatCommand(text);
    if (pending?.kind === "permission") {
      const decision = parseApprovalReply(text);
      if (decision && command.type === "prompt") {
        const optionId =
          decision === "allow" ? pending.allowOptionId : pending.denyOptionId;
        const current = pending;
        pending = null;
        await options.host.answerPermission({
          interactionId: current.interactionId,
          projectId: current.projectId,
          chatId: current.chatId,
          optionId,
        });
        return;
      }
    }
    if (pending?.kind === "form" && command.type === "prompt") {
      const current = pending;
      pending = null;
      await options.host.answerForm({
        interactionId: current.interactionId,
        projectId: current.projectId,
        chatId: current.chatId,
        text,
      });
      return;
    }
    const state = options.getState();
    const browse = browseFor(state, now());
    const catalog = await options.host.catalog({
      teamId: browse.teamId,
      projectId: browse.projectId,
      chatId: state.binding?.chatId ?? null,
    });
    if (command.type === "help") {
      await options.say(copy.help);
      return;
    }
    if (command.type === "current") {
      if (!state.binding) {
        await options.say(copy.needBinding);
        return;
      }
      await options.say(
        copy.current(
          teamName(catalog.teams, state.binding.teamId),
          projectName(catalog.projects, state.binding.projectId),
          chatTitle(catalog.chats, state.binding.chatId)
        )
      );
      return;
    }
    if (command.type === "cancel") {
      if (!state.binding) {
        await options.say(copy.needBinding);
        return;
      }
      await options.host.cancelActive(
        state.binding.projectId,
        state.binding.chatId
      );
      await options.say(copy.cancelled);
      return;
    }
    if (command.type === "new") {
      const projectId = browse.projectId ?? state.binding?.projectId;
      const teamId = browse.teamId ?? state.binding?.teamId;
      if (!(projectId && teamId)) {
        await options.say(copy.needBinding);
        return;
      }
      const chatId = await options.host.createChat(projectId, command.title);
      await options.setState({
        ...options.getState(),
        binding: { teamId, projectId, chatId },
      });
      await options.say(copy.created(command.title ?? shortId(chatId)));
      return;
    }
    if (command.type === "list-up") {
      const next = moveBrowseUp(browse, now());
      await options.setState({ ...options.getState(), browse: next });
      await options.say(formatScreen(next, catalog, copy));
      return;
    }
    if (command.type === "list" || command.type === "page-next") {
      const next =
        command.type === "page-next"
          ? { ...browse, page: browse.page + 1, at: now() }
          : { ...browse, page: 0, at: now() };
      await options.setState({ ...options.getState(), browse: next });
      await options.say(formatScreen(next, catalog, copy));
      return;
    }
    if (command.type === "select") {
      const selected = selectBrowseRow(
        browse,
        catalog,
        command.raw,
        state.binding,
        now()
      );
      await options.setState({
        ...options.getState(),
        browse: selected.browse,
        binding: selected.binding,
      });
      if (selected.rebound && selected.binding) {
        await options.say(
          copy.switched(chatTitle(catalog.chats, selected.binding.chatId))
        );
        return;
      }
      await options.say(formatScreen(selected.browse, catalog, copy));
      return;
    }
    if (command.type === "model" || command.type === "model-pick") {
      await handleModel(command, catalog, copy);
      return;
    }
    if (!state.binding) {
      const selected = selectBrowseRow(
        browse,
        catalog,
        text.trim(),
        state.binding,
        now()
      );
      if (selected.browse !== browse || selected.rebound) {
        await options.setState({
          ...options.getState(),
          browse: selected.browse,
          binding: selected.binding,
        });
        await options.say(
          selected.rebound && selected.binding
            ? copy.switched(chatTitle(catalog.chats, selected.binding.chatId))
            : formatScreen(selected.browse, catalog, copy)
        );
        return;
      }
      await options.say(copy.needBinding);
      return;
    }
    try {
      const current = options.getState();
      if (!current.binding) {
        await options.say(copy.needBinding);
        return;
      }
      const result = await options.host.submitTurn({
        projectId: current.binding.projectId,
        chatId: current.binding.chatId,
        ...(current.binding.canvasId
          ? { canvasId: current.binding.canvasId }
          : {}),
        text: command.text,
        requestId: randomUUID(),
        ...(catalog.currentModelId
          ? { modelSelector: catalog.currentModelId }
          : {}),
        ...(current.thinkingLevel
          ? { thinkingLevel: current.thinkingLevel }
          : {}),
      });
      if (result.reply.trim()) {
        await options.say(result.reply);
      }
    } catch {
      options.setError?.("sourceUnavailable");
      await options.say(copy.unavailable);
    }
  }

  async function handleModel(
    command: Extract<
      ReturnType<typeof parseWechatCommand>,
      { type: "model" | "model-pick" }
    >,
    catalog: WechatCatalog,
    copy: ReturnType<typeof wechatCopy>
  ) {
    const state = options.getState();
    if (!state.binding) {
      await options.say(copy.needBinding);
      return;
    }
    if (command.type === "model") {
      const lines = catalog.models.map(
        (model, index) =>
          `${index + 1}. ${model.name}${model.id === catalog.currentModelId ? " *" : ""}`
      );
      const current =
        catalog.models.find((model) => model.id === catalog.currentModelId)
          ?.name ??
        catalog.currentModelId ??
        "—";
      await options.say(`${copy.model(current)}\n${lines.join("\n")}`.trim());
      return;
    }
    const picked = command.index
      ? catalog.models[command.index - 1]
      : undefined;
    if (picked) {
      await options.host.setModel(
        state.binding.projectId,
        state.binding.chatId,
        picked.id
      );
    }
    if (command.level) {
      await options.setState({
        ...options.getState(),
        thinkingLevel: command.level,
      });
    }
    const name = picked?.name ?? catalog.currentModelId ?? command.level ?? "";
    await options.say(copy.modelSet(name));
  }

  return {
    async handleText(text) {
      if (!(await ensureOwner())) {
        return false;
      }
      await handleCommand(text);
      return true;
    },
    async present(next) {
      pending = next;
      const copy = wechatCopy(localeOf(await options.host.locale()));
      await options.say(
        next.kind === "permission"
          ? copy.approval(next.toolName)
          : copy.question(next.message)
      );
    },
  };
}

function formatScreen(
  browse: ReturnType<typeof browseFor>,
  catalog: WechatCatalog,
  copy: ReturnType<typeof wechatCopy>
): string {
  const screen = renderBrowse(browse, catalog);
  if (screen.rows.length === 0) {
    return copy.empty;
  }
  const lines = screen.rows.map(
    (row) => `${row.n}. ${row.label} ${shortId(row.id)}`
  );
  lines.push(screen.hasMore ? copy.more : copy.end);
  return lines.join("\n");
}

export function modelLabel(
  models: readonly WechatModelRow[],
  id: string | null
) {
  return models.find((model) => model.id === id)?.name ?? id ?? "";
}
