import React, { useEffect, useMemo, useState } from "react";
import { post, useStore } from "../store";
import type { AgentDescriptor } from "../../src/types";
import { AgentLogo } from "./AgentLogo";
import {
  IconChevronLeft,
  IconDownload,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from "../icons";

function AgentIcon({ agent }: { agent: AgentDescriptor }): React.JSX.Element {
  return (
    <span className="agent-card-icon">
      <AgentLogo agent={agent} size={18} />
    </span>
  );
}

export function AgentCard({
  agent,
  onSelect,
}: {
  agent: AgentDescriptor;
  onSelect?: () => void;
}): React.JSX.Element {
  const installing = !!agent.installing && !agent.installed;
  return (
    <div className={`agent-card ${agent.installed ? "installed" : ""}`}>
      <AgentIcon agent={agent} />
      <div className="agent-card-main">
        <div className="agent-card-top">
          <span className="agent-card-name" title={agent.name}>
            {agent.name}
          </span>
          {agent.installed && <span className="agent-card-installed">Installed</span>}
        </div>
        {agent.description ? (
          <div className="agent-card-desc" title={agent.description}>
            {agent.description}
          </div>
        ) : (
          <div className="agent-card-desc none">No description</div>
        )}
        <div className="agent-card-kind">
          {agent.installKind ?? agent.source}
          {agent.version ? ` · ${agent.version}` : ""}
        </div>
      </div>
      <div className="agent-card-foot">
        {agent.installed ? (
          <>
            <button
              className="agent-card-btn danger"
              title={`Uninstall ${agent.name}`}
              aria-label={`Uninstall ${agent.name}`}
              onClick={() => post({ type: "uninstallAgent", agentId: agent.id })}
            >
              <IconTrash size={12} />
            </button>
            <button
              className="agent-card-btn primary"
              onClick={() => {
                post({ type: "selectAgent", agentId: agent.id });
                onSelect?.();
              }}
            >
              Open
            </button>
          </>
        ) : (
          <button
            className="agent-card-btn"
            disabled={installing}
            onClick={() => post({ type: "installAgent", agentId: agent.id })}
          >
            {installing ? (
              "Installing…"
            ) : (
              <>
                <IconDownload size={11} /> Install
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
export function Catalog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { agents } = useStore();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "installed">("all");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!refreshing) return;
    const timer = setTimeout(() => setRefreshing(false), 10000);
    const h = (e: Event) => {
      const type = (e as MessageEvent).data?.type;
      if (type === "agents" || type === "snapshot") setRefreshing(false);
    };
    window.addEventListener("message", h);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", h);
    };
  }, [refreshing]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter(
      (a) =>
        (!q ||
          a.name.toLowerCase().includes(q) ||
          (a.description ?? "").toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q)) &&
        (tab === "all" || a.installed),
    );
  }, [agents, query, tab]);

  return (
    <div className="catalog">
      <div className="catalog-top">
        <div className="catalog-title">
          <button className="icon-btn ghost" onClick={onClose} title="Back to chat" aria-label="Back to chat">
            <IconChevronLeft size={14} />
          </button>
          <span>Agents</span>
          <span className="dim small">{filtered.length}</span>
          <button
            className="icon-btn ghost catalog-refresh"
            title="Refresh registry"
            aria-label="Refresh registry"
            onClick={() => {
              setRefreshing(true);
              post({ type: "refreshRegistry" });
            }}
          >
            <IconRefresh size={14} className={refreshing ? "acp-spin" : ""} />
          </button>
        </div>
        <div className="catalog-search">
          <IconSearch size={13} className="search-ic" />
          <input
            aria-label="Search agents"
            placeholder="Search agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {query && (
            <button className="chip-x" onClick={() => setQuery("")} title="Clear" aria-label="Clear search">
              <IconX size={11} />
            </button>
          )}
        </div>
        <div className="catalog-tabs" role="group" aria-label="Filter agents">
          <button
            className={`catalog-tab ${tab === "all" ? "active" : ""}`}
            aria-pressed={tab === "all"}
            onClick={() => setTab("all")}
          >
            All
          </button>
          <button
            className={`catalog-tab ${tab === "installed" ? "active" : ""}`}
            aria-pressed={tab === "installed"}
            onClick={() => setTab("installed")}
          >
            Installed
          </button>
        </div>
      </div>

      <div className="catalog-grid">
        {filtered.map((a) => (
          <AgentCard key={a.id} agent={a} onSelect={onClose} />
        ))}
      </div>
      {!filtered.length &&
        (query.trim() ? (
          <div className="dim small pad center">
            No agents match “{query}”.{" "}
            <button className="link-btn" onClick={() => setQuery("")}>
              Clear search
            </button>
          </div>
        ) : tab === "installed" ? (
          <div className="dim small pad center">
            No installed agents yet.{" "}
            <button className="link-btn" onClick={() => setTab("all")}>
              Browse agents
            </button>
          </div>
        ) : (
          <div className="dim small pad center">No agents available.</div>
        ))}
    </div>
  );
}
