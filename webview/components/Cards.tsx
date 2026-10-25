import React, { memo, useMemo, useState } from "react";
import type { ChatEntry, PlanItem } from "../../src/types";
import { post } from "../store";
import { IconCheck, IconKey, IconPlan, IconShieldCheck, IconX } from "../icons";
import { Markdown } from "./Parts";
import { kindIcon, shortPath } from "./ToolCall";

/* ---------------- permission ---------------- */

function permButtonClass(kind: string): string {
  if (kind === "allow_once") return "btn primary small";
  if (kind.startsWith("reject")) return "btn ghost small";
  return "btn small";
}

export const PermissionCard = memo(function PermissionCard({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "permission" }>;
}): React.JSX.Element {
  const title = entry.toolCall.title ?? entry.toolCall.name ?? "Tool call";
  const path = entry.toolCall.locations?.[0]?.path;

  if (entry.state !== "pending") {
    const selected =
      entry.state === "selected"
        ? entry.options.find((o) => o.optionId === entry.selectedOptionId)
        : undefined;
    const allowed = !!selected?.kind.startsWith("allow");
    return (
      <div className="row-head perm-resolved">
        <span className={`row-ic ${allowed ? "ok" : ""}`}>
          {allowed ? <IconCheck size={13} /> : <IconX size={13} />}
        </span>
        <span className="truncate">
          {allowed ? selected!.name : selected ? "Rejected" : "Dismissed"}
          <span className="perm-resolved-title"> · {title}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="panel permission pending" role="group" aria-label="Permission required">
      <div className="panel-head">
        <IconShieldCheck size={13} className="perm-ic" />
        <span>Permission required</span>
      </div>
      <div className="perm-tool">
        <span className="perm-kind">{kindIcon(entry.toolCall.kind, 13)}</span>
        <span className="perm-title">{title}</span>
        {path && (
          <span className="perm-path mono truncate" title={path}>
            {shortPath(path)}
          </span>
        )}
      </div>
      {entry.description && <div className="perm-description">{entry.description}</div>}
      {entry.command && <pre className="perm-command mono">{entry.command}</pre>}
      <div className="panel-actions">
        {entry.options.map((o) => (
          <button
            key={o.optionId}
            className={permButtonClass(o.kind)}
            onClick={() =>
              post({ type: "permissionResponse", entryId: entry.id, optionId: o.optionId })
            }
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
});

/* ---------------- elicitation ---------------- */

export const ElicitationCard = memo(function ElicitationCard({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "elicitation" }>;
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const host = useMemo(() => {
    try {
      return entry.url ? new URL(entry.url).host : "";
    } catch {
      return "";
    }
  }, [entry.url]);
  const pending = entry.state === "pending";

  const respond = (action: "accept" | "decline" | "cancel") => {
    post({
      type: "elicitationResponse",
      entryId: entry.id,
      action,
      content: action === "accept" && entry.mode === "form" ? values : undefined,
    });
  };

  const openUrl = () => {
    if (entry.url) {
      post({ type: "openExternal", url: entry.url });
      respond("accept");
    }
  };

  return (
    <div className={`panel elicitation ${entry.state}`}>
      <div className="panel-title">
        <IconKey size={14} className="elic-ic" />
        <span>{entry.message}</span>
      </div>

      {entry.mode === "url" && entry.url && (
        <div className="elic-url">
          <div className="elic-host mono">{host}</div>
          <div className="elic-full mono">{entry.url}</div>
        </div>
      )}

      {entry.mode === "form" && entry.schema?.properties && (
        <div className="elic-form">
          {Object.entries(entry.schema.properties).map(([key, prop]) => (
            <label key={key} className="elic-field">
              <span className="elic-label">
                {prop.title ?? key}
                {entry.schema?.required?.includes(key) ? " *" : ""}
              </span>
              {prop.description && <span className="elic-desc">{prop.description}</span>}
              <FormField
                propKey={key}
                prop={prop}
                value={values[key] ?? prop.default}
                onChange={(v) => setValues({ ...values, [key]: v })}
                disabled={!pending}
              />
            </label>
          ))}
        </div>
      )}

      {pending ? (
        <div className="panel-actions">
          {entry.mode === "url" ? (
            <button className="btn primary small" onClick={openUrl}>
              Open in browser
            </button>
          ) : (
            <button className="btn primary small" onClick={() => respond("accept")}>
              Submit
            </button>
          )}
          <button className="btn small" onClick={() => respond("decline")}>
            Decline
          </button>
          <button className="btn ghost small" onClick={() => respond("cancel")}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="panel-outcome">
          {entry.state === "accepted" ? "Submitted" : entry.state === "declined" ? "Declined" : "Cancelled"}
        </div>
      )}
    </div>
  );
});
type FormProp = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: { type?: string; enum?: unknown[] };
};

function FormField({
  propKey,
  prop,
  value,
  onChange,
  disabled,
}: {
  propKey: string;
  prop: FormProp;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}): React.JSX.Element {
  if (prop.enum?.length) {
    return (
      <select
        value={String(value ?? "")}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {prop.enum.map((v: unknown) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  }
  switch (prop.type) {
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={!!value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "integer":
    case "number":
      return (
        <input
          type="number"
          value={value == null ? "" : Number(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "array":
      // string multiselect
      if (prop.items?.enum?.length) {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        return (
          <select
            multiple
            disabled={disabled}
            value={selected}
            onChange={(e) =>
              onChange([...e.target.selectedOptions].map((o) => o.value))
            }
          >
            {prop.items.enum.map((v: unknown) => (
              <option key={String(v)} value={String(v)}>
                {String(v)}
              </option>
            ))}
          </select>
        );
      }
      return (
        <input
          type="text"
          value={Array.isArray(value) ? value.join(", ") : String(value ?? "")}
          disabled={disabled}
          placeholder="comma separated"
          onChange={(e) =>
            onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))
          }
        />
      );
    default:
      return (
        <input
          type="text"
          value={value == null ? "" : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          name={propKey}
        />
      );
  }
}

/* ---------------- plan ---------------- */

function PlanMark({ status }: { status?: string }): React.JSX.Element {
  if (status === "completed") {
    return (
      <span className="plan-mark done" aria-label="Done">
        <IconCheck size={9} />
      </span>
    );
  }
  if (status === "in_progress") return <span className="plan-mark active" aria-label="In progress" />;
  return <span className="plan-mark" aria-label="Pending" />;
}

export const PlanCard = memo(function PlanCard({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "plan" }>;
}): React.JSX.Element {
  const done = entry.entries.filter((e) => e.status === "completed").length;
  return (
    <div className="plan">
      <div className="row-head plan-head">
        <span className="row-ic">
          <IconPlan size={14} />
        </span>
        <span className="plan-title">Plan</span>
        <span className="plan-count">
          {done} of {entry.entries.length} done
        </span>
      </div>
      <ul className="row-body plan-list">
        {entry.entries.map((item: PlanItem, i: number) => (
          <li
            key={i}
            className={`plan-item ${item.status ?? "pending"} prio-${item.priority ?? "medium"}`}
          >
            <PlanMark status={item.status} />
            <span className="plan-text">
              <Markdown text={item.content} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});
