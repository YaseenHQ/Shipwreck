import React from "react";
import type { AgentDescriptor } from "../../src/types";
import { IconAgent } from "../icons";

export function AgentLogo({
  agent,
  size = 16,
  className,
}: {
  agent: AgentDescriptor;
  size?: number;
  className?: string;
}): React.JSX.Element {
  const cls = `agent-logo${className ? ` ${className}` : ""}`;
  if (agent.iconSvg && agent.iconMono) {
    // Mask: the glyph picks up currentColor so it follows the theme.
    return (
      <span
        className={cls}
        style={{
          width: size,
          height: size,
          backgroundColor: "currentColor",
          maskImage: `url(${agent.iconSvg})`,
          WebkitMaskImage: `url(${agent.iconSvg})`,
        }}
      />
    );
  }
  if (agent.iconSvg) {
    return (
      <img
        src={agent.iconSvg}
        width={size}
        height={size}
        alt=""
        className={`agent-logo-img${className ? ` ${className}` : ""}`}
      />
    );
  }
  return <IconAgent size={size} className={className} />;
}
