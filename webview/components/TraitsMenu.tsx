import React, { useState } from "react";
import { post } from "../store";
import type { ConfigOptionInfo } from "../../src/types";
import { Popover, PopHead, PopItem, Tooltip } from "./Popover";
import { IconBrain, IconChevronDown, IconChevronLeft, IconChevronRight, IconSliders } from "../icons";

type SelectOpt = NonNullable<ConfigOptionInfo["options"]>[number];

/** A thinking level longer than this opens as its own list instead of inline. */
const INLINE_CHOICES = 8;
/** Choice lists longer than this get a search box. */
const SEARCHABLE = 6;

export function optionName(opt: ConfigOptionInfo): string {
  return opt.options?.find((o) => String(o.value) === String(opt.currentValue))?.name ??
    String(opt.currentValue);
}

function groupOptions(opts: SelectOpt[]): { key: string; label?: string; options: SelectOpt[] }[] {
  const groups: { key: string; label?: string; options: SelectOpt[] }[] = [];
  const byGroup = new Map<string, { label?: string; options: SelectOpt[] }>();
  for (const o of opts) {
    const key = o.groupId ?? (o.group ? `name:${o.group}` : "");
    if (!key) {
      groups.push({ key: `__opt:${o.value}`, options: [o] });
      continue;
    }
    let g = byGroup.get(key);
    if (!g) {
      g = { label: o.group, options: [] };
      byGroup.set(key, g);
      groups.push({ key, ...g });
    }
    g.options.push(o);
  }
  return groups;
}

function OptionLabel({ option }: { option: ConfigOptionInfo }): React.JSX.Element {
  return (
    <span className="pop-text">
      <span className="pop-label">{option.name}</span>
      {option.description && <span className="pop-desc dim clamp-2">{option.description}</span>}
    </span>
  );
}

/* One compact row: a switch for booleans, a drill-in button for selects. */
function OptionRow({
  option,
  onOpen,
}: {
  option: ConfigOptionInfo;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  if (option.type === "boolean") {
    return (
      <label className="cfg-row">
        <OptionLabel option={option} />
        <input
          type="checkbox"
          role="switch"
          data-popitem
          className="cfg-switch"
          aria-label={option.name}
          checked={!!option.currentValue}
          onChange={(e) =>
            post({ type: "setConfigOption", configId: option.id, value: e.target.checked })
          }
        />
      </label>
    );
  }
  return (
    <button
      data-popitem
      className="cfg-row cfg-row-btn"
      aria-haspopup="menu"
      aria-label={`${option.name}: ${optionName(option)}`}
      onClick={() => onOpen(option.id)}
    >
      <OptionLabel option={option} />
      <span className="cfg-value ellipsis">{optionName(option)}</span>
      <IconChevronRight size={11} className="dim" />
    </button>
  );
}

function ChoiceSection({
  option,
  onClose,
}: {
  option: ConfigOptionInfo;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="traits-section" role="group" aria-label={option.name}>
      <PopHead>{option.name}</PopHead>
      {(option.options ?? []).map((o) => {
        const selected = String(o.value) === String(option.currentValue);
        return (
          <PopItem
            key={o.value}
            role="menuitemradio"
            aria-checked={selected}
            label={o.name}
            description={o.description ?? undefined}
            checked={selected}
            onClick={() => {
              if (!selected) post({ type: "setConfigOption", configId: option.id, value: o.value });
              onClose();
            }}
          />
        );
      })}
    </div>
  );
}

/* Every choice of one select, replacing the menu body until Back. */
function ChoiceList({
  option,
  onBack,
  onClose,
}: {
  option: ConfigOptionInfo;
  onBack: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [q, setQ] = useState("");
  const opts = option.options ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? opts.filter((o) => [o.name, o.description, o.group].some((s) => s?.toLowerCase().includes(needle)))
    : opts;
  return (
    <div className="traits-section" role="group" aria-label={option.name}>
      <div className="pop-sticky">
        <button className="pop-back" data-popitem onClick={onBack} aria-label="Back">
          <IconChevronLeft size={12} />
          <span className="pop-label">{option.name}</span>
        </button>
        {opts.length > SEARCHABLE && (
          <div className="pop-search-wrap">
            <input
              className="pop-search"
              autoFocus
              aria-label={`Search ${option.name}`}
              placeholder={`Search ${option.name.toLowerCase()}…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        )}
      </div>
      {groupOptions(shown).map((g) => (
        <React.Fragment key={g.key}>
          {g.label && <PopHead>{g.label}</PopHead>}
          {g.options.map((o) => {
            const selected = String(o.value) === String(option.currentValue);
            return (
              <PopItem
                key={o.value}
                role="menuitemradio"
                aria-checked={selected}
                title={o.name}
                label={o.name}
                description={o.description ? <span className="clamp-2">{o.description}</span> : undefined}
                checked={selected}
                onClick={() => {
                  if (!selected) post({ type: "setConfigOption", configId: option.id, value: o.value });
                  onClose();
                }}
              />
            );
          })}
        </React.Fragment>
      ))}
      {!shown.length && <div className="dim small pad">No matches.</div>}
    </div>
  );
}

function hasInlineChoices(o: ConfigOptionInfo): boolean {
  return o.type === "select" && (o.options?.length ?? 0) <= INLINE_CHOICES;
}

/**
 * Everything the composer doesn't give its own control. The thinking level
 * lists its choices; every other option is one compact row so the menu stays
 * short however many options the agent sends.
 */
export function TraitsMenu({
  traits,
  thought,
  onClose,
  anchor,
}: {
  traits: ConfigOptionInfo[];
  thought?: ConfigOptionInfo;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = traits.find((o) => o.id === openId && o.type === "select");
  const rows = traits.filter((o) => o !== thought);
  const sections: React.ReactNode[] = [];
  if (open) {
    sections.push(
      <ChoiceList key={open.id} option={open} onBack={() => setOpenId(null)} onClose={onClose} />,
    );
  } else {
    if (thought) {
      sections.push(
        hasInlineChoices(thought) ? (
          <ChoiceSection key={thought.id} option={thought} onClose={onClose} />
        ) : (
          <div key={thought.id} className="traits-section">
            <OptionRow option={thought} onOpen={setOpenId} />
          </div>
        ),
      );
    }
    if (rows.length) {
      sections.push(
        <div key="__rows" className="traits-section">
          {thought && <PopHead>Options</PopHead>}
          {rows.map((o) => (
            <OptionRow key={o.id} option={o} onOpen={setOpenId} />
          ))}
        </div>,
      );
    }
  }
  return (
    <Popover onClose={onClose} className="pop-list traits-menu" anchor={anchor} returnFocus={anchor}>
      {sections.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 && <div className="pop-sep" />}
          {s}
        </React.Fragment>
      ))}
    </Popover>
  );
}

export function traitsSummary(traits: ConfigOptionInfo[]): string {
  return traits
    .map((o) =>
      o.type === "boolean" ? `${o.name}: ${o.currentValue ? "On" : "Off"}` : `${o.name}: ${optionName(o)}`,
    )
    .join(" · ");
}

export function TraitsTrigger({
  traits,
  thought,
  open,
  onToggle,
  buttonRef,
}: {
  traits: ConfigOptionInfo[];
  thought?: ConfigOptionInfo;
  open: boolean;
  onToggle: () => void;
  buttonRef: React.RefObject<HTMLButtonElement>;
}): React.JSX.Element | null {
  if (!traits.length) return null;
  const level = thought ? optionName(thought) : undefined;
  const aria = level !== undefined ? `Thinking: ${level}` : "Model options";
  return (
    <Tooltip label={traitsSummary(traits)} className="config-trigger traits-trigger-wrap">
      <button
        ref={buttonRef}
        className={`pill traits-pill ${level !== undefined ? "" : "icon-only"}`}
        aria-label={aria}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {level !== undefined ? <IconBrain size={13} /> : <IconSliders size={14} />}
        {level !== undefined && <span className="pill-label ellipsis">{level}</span>}
        <IconChevronDown size={10} className="pill-caret" />
      </button>
    </Tooltip>
  );
}
