import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { post, removeAttachment, removeAttachments, addAttachment, mentionSearch, attachUris, onPromptAck } from "../store";
import type { Attachment, ConfigOptionInfo, ModeInfo, UsageInfo } from "../../src/types";
import { attachmentError, attachmentFromBytes, attachmentSizeError, imageMimeType } from "../../src/attachments";
import { getComposerConfig, type PlanToggle } from "../configOptions";
import { useStoreSlice } from "../useStoreSlice";
import { ActivityStrip } from "./Activity";
import { FileContextBadges } from "./FileContextBadges";
import { AgentLogo } from "./AgentLogo";
import { ModelPicker, ModelPickerTrigger } from "./ModelPicker";
import { Popover, PopHead, PopItem, Tooltip } from "./Popover";
import { TraitsMenu, TraitsTrigger, optionName } from "./TraitsMenu";
import {
  IconChevronDown,
  IconCircle,
  IconEdit,
  IconFolder,
  IconGitBranch,
  IconHand,
  IconLightning,
  IconListChecks,
  IconPackage,
  IconPaperclip,
  IconPlus,
  IconSelection,
  IconSend,
  IconTerminal,
  IconFile,
  IconStop,
  IconWarningCircle,
  IconX,
} from "../icons";

function fmtCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** One mode control, whether the agent sent legacy session modes or a "mode" config option. */
interface ModeControl {
  title: string;
  choices: ModeInfo[];
  current: ModeInfo;
  pick: (id: string) => void;
}

type ModeKind = "full" | "plan" | "manual" | "auto" | "edit" | "other";

// First match wins, so "agent-full-access" is full and "read-only" is manual.
const MODE_KINDS: readonly (readonly [Exclude<ModeKind, "other">, RegExp])[] = [
  ["full", /yolo|full|bypass|danger|sudo|unrestricted/],
  ["plan", /plan|architect|design/],
  ["manual", /read|ask|manual|chat|suggest|default/],
  ["auto", /auto|agent|orchestr/],
  ["edit", /edit|write|code|build|accept/],
];

function modeKind(m: ModeInfo): ModeKind {
  const s = `${m.id} ${m.name}`.toLowerCase();
  return MODE_KINDS.find(([, re]) => re.test(s))?.[0] ?? "other";
}

function modeIcon(kind: ModeKind, size = 15): React.JSX.Element {
  switch (kind) {
    case "full":
      return <IconWarningCircle size={size} />;
    case "plan":
      return <IconListChecks size={size} />;
    case "manual":
      return <IconHand size={size} />;
    case "auto":
      return <IconLightning size={size} />;
    case "edit":
      return <IconEdit size={size} />;
    case "other":
      return <IconCircle size={size} />;
  }
}

function modeControl(
  cfg: ReturnType<typeof getComposerConfig>,
  modes: { currentModeId: string; availableModes: ModeInfo[] } | null | undefined,
  useLegacyModes: boolean,
): ModeControl | undefined {
  const opt = cfg.primaryMode;
  if (opt) {
    const choices = (opt.options ?? []).map((o) => ({
      id: String(o.value),
      name: o.name,
      description: o.description,
    }));
    const current = choices.find((c) => c.id === String(opt.currentValue));
    if (!current) return undefined;
    return {
      title: opt.name,
      choices,
      current,
      pick: (id) => post({ type: "setConfigOption", configId: opt.id, value: id }),
    };
  }
  if (!useLegacyModes || !modes) return undefined;
  const current = modes.availableModes.find((m) => m.id === modes.currentModeId);
  if (!current) return undefined;
  return {
    title: "Mode",
    choices: modes.availableModes,
    current,
    pick: (id) => post({ type: "setMode", modeId: id }),
  };
}

/* ---------- popover bodies ---------- */

function ModeMenu({
  control,
  plan,
  onClose,
  anchor,
}: {
  control?: ModeControl;
  plan?: PlanToggle;
  onClose: () => void;
  anchor?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  return (
    <Popover onClose={onClose} className="pop-list mode-menu" anchor={anchor} returnFocus={anchor}>
      {control && (
        <>
          <PopHead>{control.title}</PopHead>
          {control.choices.map((m) => {
            const kind = modeKind(m);
            return (
              <PopItem
                key={m.id}
                role="menuitemradio"
                aria-checked={m.id === control.current.id}
                icon={modeIcon(kind)}
                label={m.name}
                description={m.description ?? undefined}
                checked={m.id === control.current.id}
                danger={kind === "full"}
                onClick={() => {
                  if (m.id !== control.current.id) control.pick(m.id);
                  onClose();
                }}
              />
            );
          })}
        </>
      )}
      {plan && (
        <>
          {control && <div className="pop-sep" />}
          <label className="cfg-row plan-row">
            <span className="pop-ic">
              <IconListChecks size={15} />
            </span>
            <span className="pop-text">
              <span className="pop-label">Plan first</span>
              <span className="pop-desc dim">
                {plan.option.options?.find((o) => o.value === plan.planValue)?.description ??
                  "Make a plan before changing anything"}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              data-popitem
              className="cfg-switch"
              aria-label="Plan first"
              checked={plan.on}
              onChange={(e) =>
                post({
                  type: "setConfigOption",
                  configId: plan.option.id,
                  value: e.target.checked ? plan.planValue : plan.offValue,
                })
              }
            />
          </label>
        </>
      )}
    </Popover>
  );
}

/* ---------- composer ---------- */

export function Composer({
  onBrowse,
  onHistory,
  onThreads,
}: {
  onBrowse: () => void;
  onHistory: () => void;
  onThreads?: () => void;
}): React.JSX.Element {
  const {
    session,
    connection,
    attachments,
    agents,
    activeAgentId,
    workspace,
    pendingAgentId,
    editorContext,
    editorContextEnabled,
    mentionResults,
    activity,
    threads,
    activeThreadId,
    showCost,
    promptCapabilities,
  } = useStoreSlice((s) => ({
    showCost: s.showCost,
    promptCapabilities: s.promptCapabilities,
    session: s.session,
    connection: s.connection,
    attachments: s.attachments,
    agents: s.agents,
    activeAgentId: s.activeAgentId,
    workspace: s.workspace,
    pendingAgentId: s.pendingAgentId,
    editorContext: s.editorContext,
    editorContextEnabled: s.editorContextEnabled,
    mentionResults: s.mentionResults,
    activity: s.activity,
    threads: s.threads,
    activeThreadId: s.activeThreadId,
  }));
  const [text, setText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [menu, setMenu] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const traitsRef = useRef<HTMLButtonElement>(null);
  const busy = !!session?.busy;
  const commands = session?.availableCommands ?? [];
  const active = agents.find((a) => a.id === activeAgentId);
  const pendingAgent = pendingAgentId
    ? agents.find((a) => a.id === pendingAgentId)
    : undefined;

  const configOptions = session?.configOptions ?? [];
  const modes = session?.modes;
  const multiMode = (modes?.availableModes.length ?? 0) > 1;
  const cfg = getComposerConfig(configOptions, multiMode);
  const useLegacyModes = cfg.useLegacyModes && multiMode;
  const mode = modeControl(cfg, modes, useLegacyModes);
  const plan = cfg.planToggle;
  const modeKindNow = plan?.on ? "plan" : mode ? modeKind(mode.current) : "other";

  /* ---------- slash menu ---------- */

  const slash = useMemo(() => {
    const m = /^\/([a-zA-Z0-9_-]*)$/.exec(text.split(/\s/)[0] ?? "");
    if (!m || !text.startsWith("/") || text.includes(" ")) return null;
    const q = m[1].toLowerCase();
    const match = (...s: (string | undefined | null)[]) =>
      s.some((x) => x?.toLowerCase().includes(q));

    type Item =
      | { t: "cmd"; name: string; desc?: string | null }
      | { t: "action"; name: string; desc?: string; run: () => void }
      | { t: "bool"; opt: ConfigOptionInfo }
      | { t: "sel"; opt: ConfigOptionInfo }
      | { t: "mode" };

    const groups: { title: string; items: Item[] }[] = [];

    const cmds = commands
      .filter((c) => match(c.name, c.description))
      .map((c) => ({ t: "cmd" as const, name: c.name, desc: c.description }));
    if (cmds.length) groups.push({ title: "Commands", items: cmds });

    const chatItems: Item[] = [
      { t: "action" as const, name: "New chat", run: () => post({ type: "newSession" }) },
      { t: "action" as const, name: "Threads", run: onHistory },
      { t: "action" as const, name: "Agents…", run: onBrowse },
    ].filter((i) => match(i.name));
    if (chatItems.length) groups.push({ title: "Chat", items: chatItems });

    const settings: Item[] = [
      ...(useLegacyModes && match("mode", "switch mode")
        ? [{ t: "mode" as const }]
        : []),
      ...configOptions
        .filter((o) => match(o.name))
        .map((opt) =>
          opt.type === "boolean"
            ? ({ t: "bool" as const, opt } as Item)
            : ({ t: "sel" as const, opt } as Item),
        ),
    ];
    if (settings.length) groups.push({ title: "Settings", items: settings });

    const flat = groups.flatMap((g) => g.items);
    return flat.length ? { query: q, groups, flat } : null;
  }, [text, commands, configOptions, useLegacyModes, onBrowse, onHistory]);

  useEffect(() => setSlashIndex(0), [slash?.query]);
  useEffect(() => {
    setSlashIndex((i) => Math.min(i, Math.max(0, (slash?.flat.length ?? 1) - 1)));
  }, [slash?.flat.length]);

  /* ---------- @-mentions + active-editor chip ---------- */

  const editorChipVisible = !!editorContext;
  const watchedFiles = JSON.stringify(attachments.filter((a) => a.kind !== "folder" && a.uri.startsWith("file:")).map((a) => a.uri));
  useEffect(() => {
    post({ type: "watchFiles", uris: JSON.parse(watchedFiles) });
    return () => post({ type: "watchFiles", uris: [] });
  }, [watchedFiles]);

  useEffect(() => {
    if (!mention) return;
    const t = setTimeout(() => mentionSearch(mention.query), 120);
    return () => clearTimeout(t);
  }, [mention?.query, !!mention]);
  useEffect(() => setMentionIndex(0), [mentionResults]);

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([\w./-]*)$/.exec(before);
    setMention(m ? { start: caret - m[2].length, end: caret, query: m[2] } : null);
  };

  const pickMention = (i: number) => {
    const r = mentionResults[i];
    if (!mention || !r) return;
    setText(text.slice(0, mention.start - 1) + text.slice(mention.end));
    attachUris([r.uri]);
    setMention(null);
    taRef.current?.focus();
  };

  const attachFiles = async (files: File[]) => {
    for (const file of files) {
      const uri = `attachment:${crypto.randomUUID()}/${encodeURIComponent(file.name)}`;
      const error = attachmentSizeError(file.size, !!imageMimeType(file.name, file.type));
      if (error) {
        addAttachment({ uri, name: file.name, kind: "rejected", error });
        continue;
      }
      try {
        addAttachment(attachmentFromBytes(uri, file.name, new Uint8Array(await file.arrayBuffer()), file.type));
      } catch {
        addAttachment({ uri, name: file.name, kind: "rejected", error: "Couldn't read this file." });
      }
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    void attachFiles(files);
  };
  const onDrop = (e: React.DragEvent) => {
    const raw =
      e.dataTransfer.getData("text/uri-list") ||
      e.dataTransfer.getData("application/vnd.code.uri-list");
    const files = Array.from(e.dataTransfer.files);
    if (!raw && !files.length) return;
    e.preventDefault();
    if (raw) {
      attachUris(raw.split(/\r?\n/).filter((u) => u && !u.startsWith("#")));
    } else {
      void attachFiles(files);
    }
  };
  const onDragOver = (e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("Files") ||
      e.dataTransfer.types.includes("text/uri-list") ||
      e.dataTransfer.types.includes("application/vnd.code.uri-list")
    ) {
      e.preventDefault();
    }
  };

  useEffect(() => {
    const focus = () => taRef.current?.focus();
    window.addEventListener("acp:focus-composer", focus);
    return () => window.removeEventListener("acp:focus-composer", focus);
  }, []);

  useEffect(() => {
    taRef.current?.focus();
  }, [session?.sessionId]);

  const toggleModelPicker = useCallback(
    () => setMenu((m) => (m === "model" ? null : "model")),
    [],
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  const toggleTraits = useCallback(() => setMenu((m) => (m === "traits" ? null : "traits")), []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey || e.key !== "'") return;
      e.preventDefault();
      toggleModelPicker();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [toggleModelPicker]);

  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  // The submitted draft clears only when the host accepts the prompt —
  // a rejected preflight (auth/context change) keeps text + attachments.
  const [sendPending, setSendPending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const pendingSend = useRef<{
    requestId: string;
    text: string;
    atts: typeof attachments;
    off: () => void;
  } | null>(null);
  // Unmounting mid-flight must not let a late ack clear a remounted draft.
  useEffect(
    () => () => {
      pendingSend.current?.off();
      pendingSend.current = null;
    },
    [],
  );
  const send = () => {
    // Send the raw text verbatim — trim is only the emptiness check.
    const raw = taRef.current?.value ?? text;
    const atts = attachments;
    const sent: Attachment[] = [];
    let warning: string | null = null;
    for (const att of atts) {
      const error = attachmentError(att, !!promptCapabilities?.image);
      if (error) warning ??= error;
      else sent.push(att);
    }
    if (!raw.trim() && !sent.length && !(editorContext && editorContextEnabled)) {
      setSendErr(warning ?? "Nothing to send.");
      return;
    }
    if (pendingSend.current) return;
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: {
      requestId: string;
      text: string;
      atts: typeof attachments;
      off: () => void;
    } = {
      requestId,
      text: raw,
      atts,
      off: () => undefined,
    };
    record.off = onPromptAck(requestId, (ok, reason) => {
      // Only the exact request that registered this ack may settle —
      // a stale/duplicate ack for an older requestId does nothing.
      if (pendingSend.current !== record) return;
      pendingSend.current = null;
      record.off();
      setSendPending(false);
      if (!ok) {
        if (reason) setSendErr(reason);
        return;
      }
      setSendErr(warning);
      // Clear only what was actually submitted — edits made since stay.
      // Compare raw values: a resend of identical text is distinguished by
      // requestId, not content equality.
      if (taRef.current && taRef.current.value === record.text) {
        setText("");
      }
      removeAttachments(record.atts);
      setMention(null);
      requestAnimationFrame(autosize);
    });
    pendingSend.current = record;
    setSendPending(true);
    setSendErr(null);
    post({ type: "sendPrompt", text: raw, attachments: sent, requestId });
  };

  const runSlashItem = (item: NonNullable<typeof slash>["flat"][number]) => {
    if (item.t === "cmd") {
      setText(`/${item.name} `);
    } else if (item.t === "action") {
      setText("");
      item.run();
    } else if (item.t === "bool") {
      post({
        type: "setConfigOption",
        configId: item.opt.id,
        value: !item.opt.currentValue,
      });
    } else if (item.t === "sel") {
      setText("");
      setMenu(
        item.opt === cfg.primaryModel || item.opt === cfg.primaryThought
          ? "model"
          : item.opt === cfg.primaryMode || item.opt === plan?.option
            ? "mode"
            : "traits",
      );
    } else if (item.t === "mode") {
      setText("");
      setMenu("mode");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (mention) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i + (e.key === "ArrowDown" ? 1 : -1) + mentionResults.length) % Math.max(1, mentionResults.length),
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickMention(mentionIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (slash) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(
          (i) => (i + (e.key === "ArrowDown" ? 1 : -1) + slash.flat.length) % slash.flat.length,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const item = slash.flat[slashIndex];
        if (item) runSlashItem(item);
        return;
      }
      if (e.key === "Escape") {
        setText(text.replace(/^\/\S*/, ""));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (busy) return;
      send();
    }
  };

  const disabled = !active;
  const canSend =
    connection.status === "connected" &&
    !busy &&
    !sendPending &&
    (!!text.trim() || !!attachments.length || (editorChipVisible && editorContextEnabled));

  // Close a popover whose options were removed by a full-set update.
  useEffect(() => {
    if (menu === "mode" && !mode && !plan) setMenu(null);
    if (menu === "traits" && !cfg.traits.length) setMenu(null);
  }, [menu, !!mode, !!plan, cfg.traits.length]);

  let slashItemIndex = -1;
  const modelTrigger = (
    <ModelPickerTrigger
      open={menu === "model"}
      onToggle={toggleModelPicker}
      buttonRef={modelRef}
    />
  );

  return (
    <div className="composer" ref={menuRef} onDrop={onDrop} onDragOver={onDragOver}>
      {slash && (
        <div className="popover slash-menu">
          {slash.groups.map((g) => (
            <React.Fragment key={g.title}>
              <PopHead>{g.title}</PopHead>
              {g.items.map((item) => {
                slashItemIndex++;
                const i = slashItemIndex;
                const cls = `pop-item ${i === slashIndex ? "active" : ""}`;
                const act = (e: React.MouseEvent) => {
                  e.preventDefault();
                  runSlashItem(item);
                  taRef.current?.focus();
                };
                if (item.t === "cmd") {
                  return (
                    <button key={`c${item.name}`} className={cls} onMouseDown={act}>
                      <span className="pop-text">
                        <span className="pop-label mono">/{item.name}</span>
                        {item.desc && <span className="pop-desc dim">{item.desc}</span>}
                      </span>
                    </button>
                  );
                }
                if (item.t === "action") {
                  return (
                    <button key={`a${item.name}`} className={cls} onMouseDown={act}>
                      <span className="pop-text">
                        <span className="pop-label">{item.name}</span>
                      </span>
                    </button>
                  );
                }
                if (item.t === "bool") {
                  const on = !!item.opt.currentValue;
                  return (
                    <button key={`b${item.opt.id}`} className={cls} onMouseDown={act}>
                      <span className="pop-text">
                        <span className="pop-label">{item.opt.name}</span>
                      </span>
                      <span className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on}>
                        <span className="switch-knob" />
                      </span>
                    </button>
                  );
                }
                if (item.t === "sel") {
                  return (
                    <button key={`s${item.opt.id}`} className={cls} onMouseDown={act}>
                      <span className="pop-text">
                        <span className="pop-label">Switch {item.opt.name}…</span>
                      </span>
                      <span className="dim small nowrap">{optionName(item.opt)}</span>
                    </button>
                  );
                }
                return (
                  <button key="mode" className={cls} onMouseDown={act}>
                    <span className="pop-text">
                      <span className="pop-label">Switch mode…</span>
                    </span>
                    <span className="dim small nowrap">
                      {modes?.availableModes.find((m) => m.id === modes.currentModeId)?.name}
                    </span>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      )}

      {menu === "plus" && (
        <Popover onClose={() => setMenu(null)} className="pop-list" anchor={plusRef} returnFocus={plusRef}>
          <PopItem
            icon={<IconPaperclip size={14} />}
            label="Attach files…"
            onClick={() => {
              post({ type: "attach" });
              setMenu(null);
            }}
          />
          <PopItem
            icon={<IconPackage size={14} />}
            label="Browse agents…"
            onClick={() => {
              setMenu(null);
              onBrowse();
            }}
          />
        </Popover>
      )}

      {menu === "model" && (
        <ModelPicker
          anchor={modelRef}
          onClose={closeMenu}
          onBrowse={onBrowse}
        />
      )}

      {menu === "mode" && (mode || plan) && (
        <ModeMenu control={mode} plan={plan} onClose={() => setMenu(null)} anchor={modeRef} />
      )}
      {menu === "traits" && cfg.traits.length > 0 && (
        <TraitsMenu
          traits={cfg.traits}
          onClose={closeMenu}
          anchor={traitsRef}
        />
      )}

      <ActivityStrip
        activity={activity}
        threads={threads}
        activeThreadId={activeThreadId}
        onOpen={onHistory}
      />
      <div className="composer-box">
        {sendErr && (
          <div className="dim small send-err" role="status">
            {sendErr}
          </div>
        )}
        {pendingAgent && (
          <div className="continue-chip">
            <AgentLogo agent={pendingAgent} size={14} />
            <span>
              Continuing this thread with <b>{pendingAgent.name}</b>
            </span>
            <button
              className="chip-x"
              title="Start a new chat instead"
              onClick={() => post({ type: "newSession" })}
            >
              <IconX size={10} />
            </button>
          </div>
        )}
        {(!!attachments.length || editorChipVisible) && (
          <div className="attach-row">
            {attachments.map((a) => (
              <AttachmentChip key={`${a.uri}#${a.range?.startLine ?? ""}`} att={a} error={attachmentError(a, !!promptCapabilities?.image)} onRemove={() => removeAttachment(a.uri)} />
            ))}
            {editorContext && (
              <button
                className={`chip editor-context-chip${editorContextEnabled ? "" : " context-disabled"}`}
                aria-pressed={editorContextEnabled}
                aria-label={`${editorContextEnabled ? "Exclude" : "Include"} ${editorContext.name} as context`}
                title={`${editorContext.uri}\n${editorContextEnabled ? "Included in this message. Click to exclude." : "Excluded from this message. Click to include."}`}
                onClick={() => post({ type: "setEditorContext", uri: editorContext.uri, enabled: !editorContextEnabled })}
              >
                <IconFile size={11} />
                <span className="ellipsis">{editorContext.name}{editorContext.selection
                  ? `:${editorContext.selection.range.startLine}-${editorContext.selection.range.endLine}` : ""}</span>
                <FileContextBadges context={editorContext} />
                {editorContextEnabled ? <IconX size={10} /> : <IconPlus size={10} />}
              </button>
            )}
          </div>
        )}
        {mention && mentionResults.length > 0 && (
          <div className="popover mention-menu" role="listbox" aria-label="Files">
            <PopHead>Files</PopHead>
            {mentionResults.slice(0, 10).map((r, i) => (
              <button
                key={r.uri}
                role="option"
                aria-selected={i === mentionIndex}
                className={`pop-item mention-item ${i === mentionIndex ? "active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(i)}
              >
                <IconFile size={13} className="dim" />
                <span className="ellipsis">{r.name}</span>
                <span className="dim ellipsis mention-path">{r.path}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          placeholder={
            connection.status === "connecting"
              ? `Starting ${active?.name ?? "agent"}…`
              : connection.status === "auth_required"
                ? `Sign in to message ${active?.name ?? "the agent"}`
                : connection.status === "error"
                  ? `${active?.name ?? "The agent"} isn't running`
                  : disabled
                ? "Select an agent to start…"
                : session
                  ? `Message ${active?.name ?? "the agent"} — / for commands`
                  : "Starting session…"
          }
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            detectMention(e.target.value, e.target.selectionStart);
            autosize();
          }}
          onSelect={(e) =>
            detectMention(e.currentTarget.value, e.currentTarget.selectionStart)
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-foot">
          <div className="composer-foot-left">
            <Tooltip label="Add context" kbd="/">
              <button
                ref={plusRef}
                className="icon-btn ghost"
                aria-label="Add context"
                onClick={() => setMenu(menu === "plus" ? null : "plus")}
              >
                <IconPlus size={15} />
              </button>
            </Tooltip>
            {(mode || plan) && (
              <Tooltip
                label={[mode && `${mode.title}: ${mode.current.name}`, plan?.on && "Plan first"]
                  .filter(Boolean)
                  .join(" · ")}
                className="config-trigger cat-mode-trigger"
              >
                <button
                  ref={modeRef}
                  className={`pill mode-pill ${modeKindNow === "full" ? "warn" : ""}`}
                  aria-label={`Mode: ${[plan?.on && "Plan first", mode?.current.name].filter(Boolean).join(", ")}`}
                  aria-haspopup="menu"
                  aria-expanded={menu === "mode"}
                  onClick={() => setMenu(menu === "mode" ? null : "mode")}
                >
                  {modeIcon(modeKindNow, 13)}
                  <span className="pill-label ellipsis">
                    {plan?.on ? "Plan" : (mode?.current.name ?? "Default")}
                  </span>
                  <IconChevronDown size={10} className="pill-caret" />
                </button>
              </Tooltip>
            )}
            {modelTrigger}
            <TraitsTrigger
              traits={cfg.traits}
              open={menu === "traits"}
              onToggle={toggleTraits}
              buttonRef={traitsRef}
            />
          </div>
          <div className="composer-foot-right">
            {busy ? (
              <button
                className="send-btn stop"
                title="Stop generating"
                aria-label="Stop generating"
                onClick={() => post({ type: "cancel" })}
              >
                <IconStop size={13} />
              </button>
            ) : (
              <button className="send-btn" title="Send" aria-label="Send" disabled={!canSend} onClick={send}>
                <IconSend size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      <ContextLine workspace={workspace} usage={session?.usage} showCost={showCost} onThreads={onThreads} />
    </div>
  );
}

function ContextLine({
  workspace,
  usage,
  showCost,
  onThreads,
}: {
  workspace?: { folders: { name: string; path: string }[]; branch?: string };
  usage?: UsageInfo | null;
  showCost: boolean;
  onThreads?: () => void;
}): React.JSX.Element | null {
  const folders = workspace?.folders ?? [];
  if (!folders.length && !workspace?.branch && !usage) return null;
  return (
    <div className="ctx-line dim">
      <span className="ctx-left">
        {folders.length > 0 && (
          <button
            className="ctx-item ctx-branch"
            title={`${folders.map((f) => f.path).join("\n")}\nThreads in this folder`}
            onClick={onThreads}
          >
            <IconFolder size={12} />
            {folders[0].name}
            {folders.length > 1 && <span className="dim"> +{folders.length - 1}</span>}
          </button>
        )}
        {workspace?.branch && (
          <button
            className="ctx-item ctx-branch"
            title="Switch git branch"
            onClick={() => post({ type: "gitCheckout" })}
          >
            <IconGitBranch size={12} />
            {workspace.branch}
          </button>
        )}
      </span>
      {usage && <ContextMeter usage={usage} showCost={showCost} />}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

const RING_R = 6;
const RING_C = 2 * Math.PI * RING_R;

function ContextMeter({ usage, showCost }: { usage: UsageInfo; showCost: boolean }): React.JSX.Element {
  const frac = Math.min(1, usage.used / Math.max(1, usage.size));
  const pct = Math.round(frac * 100);
  const cost = showCost && usage.cost ? fmtCost(usage.cost.amount, usage.cost.currency) : "";
  const label = `${pct}% context used · ${fmtTokens(usage.used)} / ${fmtTokens(usage.size)} tokens${cost ? ` · ${cost}` : ""}`;
  const tone = frac >= 0.9 ? " crit" : frac >= 0.75 ? " warn" : "";
  return (
    <Tooltip label={label} className="tip-end">
      <span className={`usage-inline${tone}`} tabIndex={0} aria-label={label}>
        <svg className="ctx-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="ctx-ring-track" cx="7" cy="7" r={RING_R} />
          <circle
            className="ctx-ring-fill"
            cx="7"
            cy="7"
            r={RING_R}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - frac)}
            transform="rotate(-90 7 7)"
          />
        </svg>
        {cost && <span>{cost}</span>}
      </span>
    </Tooltip>
  );
}

function AttachmentChip({
  att,
  error,
  onRemove,
}: {
  att: Attachment;
  error?: string;
  onRemove: () => void;
}) {
  const kindIcon =
    att.kind === "folder" ? (
      <IconFolder size={11} />
    ) : att.kind === "terminal" ? (
      <IconTerminal size={11} />
    ) : att.kind === "diagnostic" ? (
      <IconWarningCircle size={11} />
    ) : att.kind === "selection" ? (
      <IconSelection size={11} />
    ) : (
      <IconFile size={11} />
    );
  const range = att.range ? `:${att.range.startLine}-${att.range.endLine}` : "";
  return (
    <span className={`chip attach-chip${error ? " attach-error" : ""}`} title={error ?? `${att.uri}${range}`}>
      {att.kind === "image"
        ? <img className="attach-thumb" src={`data:${att.mimeType};base64,${att.data}`} alt="" />
        : kindIcon}
      <span className="ellipsis">{att.name}</span>
      {range}
      <FileContextBadges context={att.fileContext} />
      {error && <span className="attach-error-text">{error}</span>}
      <button className="chip-x" onClick={onRemove} aria-label={`Remove ${att.name}`}>
        <IconX size={10} />
      </button>
    </span>
  );
}
