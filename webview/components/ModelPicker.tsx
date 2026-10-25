import React, { useEffect, useMemo, useRef, useState } from "react";
import { getPref, post, setPref } from "../store";
import { useStoreSlice } from "../useStoreSlice";
import {
  buildPickerAgents, currentModelName, favKey, FAVORITES_PREF, searchModels,
  type Favorite, type PickerAgent, type PickerModel,
} from "../modelCatalog";
import { getComposerConfig } from "../configOptions";
import { AgentLogo } from "./AgentLogo";
import { Popover, PopHead, PopItem, Tooltip } from "./Popover";
import { optionName } from "./TraitsMenu";
import {
  IconChevronDown, IconChevronLeft, IconChevronRight, IconSearch,
  IconSpinner, IconSquaresFour, IconStar,
} from "../icons";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const PICKER_KBD = IS_MAC ? "⌘'" : "Ctrl+'";

function usePickerAgents(): {
  list: PickerAgent[];
  activeAgentId?: string;
} {
  const { agents, agentModels, session, activeAgentId } = useStoreSlice((s) => ({
    agents: s.agents,
    agentModels: s.agentModels,
    session: s.session,
    activeAgentId: s.activeAgentId ?? undefined,
  }));
  const list = useMemo(
    () => buildPickerAgents(agents, agentModels, session, activeAgentId),
    [agents, agentModels, session, activeAgentId],
  );
  return { list, activeAgentId };
}

/* ---------- trigger ---------- */

export const ModelPickerTrigger = React.memo(function ModelPickerTrigger({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  buttonRef: React.RefObject<HTMLButtonElement>;
}): React.JSX.Element | null {
  const { agents, agentModels, session, activeAgentId, status } = useStoreSlice((s) => ({
    agents: s.agents,
    agentModels: s.agentModels,
    session: s.session,
    activeAgentId: s.activeAgentId ?? undefined,
    status: s.connection.status,
  }));
  const pa = useMemo(() => {
    const active = agents.find((a) => a.id === activeAgentId);
    if (!active) return undefined;
    return buildPickerAgents([{ ...active, installed: true }], agentModels, session, activeAgentId)[0];
  }, [agents, agentModels, session, activeAgentId]);
  if (!pa && !agents.some((a) => a.installed)) return null;
  const model = currentModelName(pa);
  const thought = getComposerConfig(session?.configOptions ?? [], false).primaryThought;
  const effort = session?.agentId === activeAgentId && thought
    ? optionName(thought)
    : undefined;
  const label = pa ? (model ?? pa.agent.name) : "Choose agent";
  const aria = pa
    ? `Agent and model: ${pa.agent.name}${model ? ` · ${model}` : ""}`
    : "Choose agent";
  return (
    <Tooltip
      label={pa ? `${pa.agent.name}${model ? ` · ${model}` : ""}` : "Choose agent"}
      kbd={PICKER_KBD}
      className="config-trigger mp-trigger-wrap"
    >
      <button
        ref={buttonRef}
        className="pill mp-trigger"
        aria-label={aria}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {status === "connecting" && <IconSpinner size={12} className="busy" />}
        <span className="pill-label ellipsis">{label}</span>
        {effort && <span className="mp-effort">{effort}</span>}
        <IconChevronDown size={10} className="pill-caret" />
      </button>
    </Tooltip>
  );
});

type PickerView = { kind: "models"; agentId?: string } | { kind: "agents" };

type ModelRow = { pa: PickerAgent; model?: PickerModel };
type ModelSection = { key: string; label?: string; rows: ModelRow[] };

function modelSections(
  list: PickerAgent[],
  shown: PickerAgent | undefined,
  query: string,
  favorites: Favorite[],
): ModelSection[] {
  if (query.trim()) {
    return searchModels(list, query).map(({ pa, hits }) => ({
      key: pa.agent.id,
      label: pa.agent.name,
      rows: hits.map((model) => ({ pa, model })),
    }));
  }
  const saved = favorites.flatMap((f) => {
    const pa = list.find((p) => p.agent.id === f.agentId);
    const model = pa?.models.find((m) => m.value === f.value);
    return pa?.hasChoice && model ? [{ pa, model }] : [];
  });
  const sections: ModelSection[] = saved.length
    ? [{ key: "favorites", label: "Favorites", rows: saved }]
    : [];
  if (!shown) return sections;
  if (!shown.hasChoice) {
    if (shown.status === "ready" || shown.status === "unknown") {
      sections.push({ key: "agent", rows: [{ pa: shown }] });
    }
    return sections;
  }
  let previous: string | undefined;
  let section: ModelSection | undefined;
  for (const model of shown.models) {
    if (saved.some((r) => r.pa.agent.id === shown.agent.id && r.model.value === model.value)) continue;
    if (!section || model.groupKey !== previous) {
      section = { key: `models:${sections.length}`, label: model.group ?? (saved.length ? "Models" : undefined), rows: [] };
      sections.push(section);
      previous = model.groupKey;
    }
    section.rows.push({ pa: shown, model });
  }
  return sections;
}

function statusHint(pa: PickerAgent): string | undefined {
  switch (pa.status) {
    case "probing":
      return "Loading models…";
    case "auth_required":
      return "Sign in needed";
    case "error":
      return "Couldn't list models";
    case "ready":
    case "unknown":
      return undefined;
  }
}

export function ModelPicker({
  anchor,
  onClose,
  onBrowse,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onBrowse: () => void;
}): React.JSX.Element {
  const { list, activeAgentId } = usePickerAgents();
  const { prefs, session } = useStoreSlice((s) => ({ prefs: s.prefs, session: s.session }));
  const favorites = useMemo(() => getPref<Favorite[]>(FAVORITES_PREF, []), [prefs]);
  const activeAgent = list.find((pa) => pa.agent.id === activeAgentId);
  const homeAgentId = activeAgent?.agent.id ?? list[0]?.agent.id;
  const [view, setView] = useState<PickerView>(() => ({
    kind: "models",
    agentId: homeAgentId,
  }));
  const [query, setQuery] = useState("");
  const [showHints, setShowHints] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = view.kind === "models" ? list.find((pa) => pa.agent.id === view.agentId) : undefined;
  const sections = useMemo(() => modelSections(list, shown, query, favorites), [list, shown, query, favorites]);
  const rows = sections.flatMap((s) => s.rows);
  const thought = shown?.agent.id === activeAgentId && session?.agentId === activeAgentId
    ? getComposerConfig(session?.configOptions ?? [], false).primaryThought
    : undefined;
  const viewKey = view.kind === "agents" ? "agents" : view.agentId;

  useEffect(() => post({ type: "probeAgents" }), []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const menu = menuRef.current;
      const item = menu?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        menu?.querySelector<HTMLElement>("[data-popitem]");
      item?.focus({ preventScroll: true });
      item?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => clearTimeout(timer);
  }, [viewKey]);

  const showModels = (agentId?: string) => {
    setQuery("");
    setView({ kind: "models", agentId });
  };
  const pick = (pa: PickerAgent, model?: PickerModel) => {
    if (pa.agent.id !== activeAgentId || (model && model.value !== pa.current)) {
      post(model
        ? { type: "pickModel", agentId: pa.agent.id, value: model.value }
        : { type: "pickModel", agentId: pa.agent.id });
    }
    onClose();
  };
  const shortcutRows = useRef(rows);
  shortcutRows.current = view.kind === "models" ? rows : [];
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      setShowHints(mod && !e.altKey && !e.shiftKey);
      if (!mod || e.altKey || e.shiftKey) return;
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? /^[1-9]$/.exec(e.key)?.[0];
      const row = digit && shortcutRows.current[Number(digit) - 1];
      if (!row) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      pickRef.current(row.pa, row.model);
    };
    const up = (e: KeyboardEvent) => setShowHints(IS_MAC ? e.metaKey : e.ctrlKey);
    const blur = () => setShowHints(false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const star = (pa: PickerAgent, model: PickerModel) => {
    const key = favKey(pa.agent.id, model.value);
    setPref(FAVORITES_PREF, favorites.some((f) => favKey(f.agentId, f.value) === key)
      ? favorites.filter((f) => favKey(f.agentId, f.value) !== key)
      : [...favorites, { agentId: pa.agent.id, value: model.value }]);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) {
      const options = menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-model]');
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        options?.[e.key === "ArrowDown" ? 0 : options.length - 1]?.focus();
      } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        options?.[0]?.click();
      }
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-popitem]") ?? []);
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (e.key.length === 1 && e.key !== " ") {
      e.preventDefault();
      if (view.kind === "models") {
        setQuery((q) => q + e.key);
        inputRef.current?.focus();
      }
    }
  };

  let rowIndex = 0;
  return (
    <Popover
      onClose={onClose}
      className="pop-list model-picker"
      anchor={anchor}
      returnFocus={anchor}
      autoFocusFirst={false}
    >
      <div ref={menuRef} role="menu" aria-label={view.kind === "agents" ? "Switch agent" : `${shown?.agent.name ?? "Agent"} models`} onKeyDown={onKeyDown}>
        {view.kind === "agents" ? (
          <>
            <div className="pop-sticky">
              <button className="pop-back" data-popitem role="menuitem" aria-label="Back" onClick={() => showModels(homeAgentId)}>
                <IconChevronLeft size={12} />
                <span className="pop-label">Switch agent</span>
              </button>
            </div>
            <div className="mp-content">
              {list.map((pa) => (
                <PopItem
                  key={pa.agent.id}
                  role="menuitemradio"
                  aria-label={pa.agent.name}
                  aria-checked={pa.agent.id === activeAgentId}
                  icon={<AgentLogo agent={pa.agent} size={14} />}
                  label={pa.agent.name}
                  description={statusHint(pa)}
                  checked={pa.agent.id === activeAgentId}
                  onClick={() => {
                    if (!pa.hasChoice && (pa.status === "ready" || pa.status === "unknown")) pick(pa);
                    else showModels(pa.agent.id);
                  }}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <PopItem
              role="menuitem"
              aria-label="Switch agent"
              aria-haspopup="menu"
              label="Agent"
              right={<><span className="mp-agent-name">{shown?.agent.name ?? "Choose agent"}</span><IconChevronRight size={11} /></>}
              onClick={() => { setQuery(""); setView({ kind: "agents" }); }}
            />
            <div className="mp-search-wrap">
              <IconSearch size={12} />
              <input
                ref={inputRef}
                className="mp-search"
                aria-label="Search models"
                placeholder="Search models…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="mp-content">
              {!query.trim() && shown && <Notice pa={shown} onClose={onClose} />}
              {sections.map((section) => (
                <React.Fragment key={section.key}>
                  {section.label && <PopHead>{section.label}</PopHead>}
                  {section.rows.map(({ pa, model: m }) => {
                    const index = rowIndex++;
                    const selected = pa.agent.id === activeAgentId && (!m || m.value === pa.current);
                    const favorited = !!m && favorites.some((f) => f.agentId === pa.agent.id && f.value === m.value);
                    const label = m?.name ?? `Use ${pa.agent.name}`;
                    return (
                      <div className="mp-model-row" key={favKey(pa.agent.id, m?.value ?? "")}>
                        <PopItem
                          data-model
                          role="menuitemradio"
                          aria-label={label}
                          aria-checked={selected}
                          aria-keyshortcuts={index < 9 ? `${IS_MAC ? "Meta" : "Control"}+${index + 1}` : undefined}
                          label={label}
                          description={!query.trim() && pa.agent.id !== shown?.agent.id ? pa.agent.name : undefined}
                          title={[label, m?.description].filter(Boolean).join("\n")}
                          checked={selected}
                          right={<>
                            {showHints && index < 9 && <kbd className="mp-hint">{index + 1}</kbd>}
                            {m && <span className="mp-star-slot" aria-hidden="true" />}
                          </>}
                          onClick={() => pick(pa, m)}
                        />
                        {m && (
                          <button
                            className={`mp-star${favorited ? " on" : ""}`}
                            aria-label={`${favorited ? "Unstar" : "Star"} ${label}`}
                            aria-pressed={favorited}
                            onClick={() => star(pa, m)}
                          >
                            <IconStar size={12} filled={favorited} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
              {!query.trim() && shown?.status === "probing" && !shown.hasChoice && (
                <div className="dim small pad" role="status">Loading models…</div>
              )}
              {!!query.trim() && !rows.length && <div className="dim small pad" role="status">No models match.</div>}
              {!query.trim() && thought && (
                <div role="group" aria-label={thought.name} className="mp-thought">
                  <PopHead>{thought.name}</PopHead>
                  {(thought.options ?? []).map((o) => {
                    const selected = String(o.value) === String(thought.currentValue);
                    return (
                      <PopItem
                        key={o.value}
                        role="menuitemradio"
                        aria-label={o.name}
                        aria-checked={selected}
                        label={o.name}
                        checked={selected}
                        onClick={() => {
                          if (!selected) post({ type: "setConfigOption", configId: thought.id, value: o.value });
                          onClose();
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
        <div className="mp-footer">
          <PopItem
            role="menuitem"
            label="Browse agents…"
            icon={<IconSquaresFour size={14} />}
            onClick={() => { onClose(); onBrowse(); }}
          />
        </div>
      </div>
    </Popover>
  );
}

function Notice({ pa, onClose }: { pa: PickerAgent; onClose: () => void }): React.JSX.Element | null {
  if (pa.status === "auth_required") {
    return (
      <div className="mp-notice" role="status">
        <span>{pa.agent.name} needs you to sign in.</span>
        <button
          data-popitem role="menuitem" className="mp-notice-btn primary"
          onClick={() => {
            post({ type: "pickModel", agentId: pa.agent.id });
            onClose();
          }}
        >
          Sign in
        </button>
      </div>
    );
  }
  if (pa.status === "error") {
    return (
      <div className="mp-notice" role="status">
        <span>{pa.message || `${pa.agent.name} couldn't list its models.`}</span>
        <button data-popitem role="menuitem" className="mp-notice-btn" onClick={() => post({ type: "probeAgents" })}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}
