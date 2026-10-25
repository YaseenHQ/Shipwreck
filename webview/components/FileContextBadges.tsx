import React from "react";
import type { FileContext } from "../../src/types";
import { IconWarningCircle } from "../icons";

export function FileContextBadges({ context }: { context?: FileContext }): React.JSX.Element | null {
  if (!context) return null;
  const { diagnostics, git } = context;
  return <>
    {git && <span className={`file-git file-git-${git}`} title={git === "M" ? "Modified" : git === "A" ? "Added" : "Untracked"}>{git}</span>}
    {(diagnostics.error > 0 || diagnostics.warning > 0) && (
      <span className="file-problems" title={`${diagnostics.error} errors, ${diagnostics.warning} warnings`}
        aria-label={`${diagnostics.error} errors, ${diagnostics.warning} warnings`}>
        <IconWarningCircle size={11} />{diagnostics.error + diagnostics.warning}
      </span>
    )}
  </>;
}
