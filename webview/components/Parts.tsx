import React, { memo, useMemo } from "react";
import { renderMarkdownBlocks, type MarkdownLinks } from "../markdown";
import type { Part } from "../../src/types";
import { IconFile, IconLink } from "../icons";
import { post } from "../store";
import { FileContextBadges } from "./FileContextBadges";

const MdBlock = memo(function MdBlock({ html }: { html: string }): React.JSX.Element {
  return <div className="mdb" dangerouslySetInnerHTML={{ __html: html }} />;
});

function copyCode(btn: HTMLElement): void {
  const pre = btn.closest(".codeblock")?.querySelector("pre");
  void navigator.clipboard.writeText(pre?.textContent ?? "");
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = "Copy"), 1200);
}

/* Each top-level block is its own element, so a streaming message only
   replaces the DOM of the block that grew. */
export const Markdown = memo(function Markdown({
  text,
  links = "plain",
}: {
  text: string;
  links?: MarkdownLinks;
}): React.JSX.Element {
  const blocks = useMemo(() => renderMarkdownBlocks(text, links), [text, links]);
  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const copy = target.closest?.(".codeblock-copy") as HTMLElement | null;
    if (copy) {
      copyCode(copy);
      return;
    }
    const file = target.closest?.(".file-link[data-path]") as HTMLElement | null;
    if (file) {
      e.preventDefault();
      post({ type: "openFile", path: file.dataset.path! });
      return;
    }
    const a = target.closest?.("a[href]") as HTMLAnchorElement | null;
    if (a && /^https?:/i.test(a.getAttribute("href") ?? "")) {
      e.preventDefault();
      post({ type: "openExternal", url: a.getAttribute("href")! });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // Anchors open through their native click; code spans need the key.
    if (e.key === "Enter" && target.matches?.("code.file-link[data-path]")) {
      e.preventDefault();
      post({ type: "openFile", path: target.dataset.path! });
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    const copy = (e.target as HTMLElement).closest?.(".codeblock-copy") as HTMLElement | null;
    if (copy) {
      e.preventDefault();
      copyCode(copy);
    }
  };
  return (
    <div className="md" onClick={onClick} onKeyDown={onKeyDown}>
      {blocks.map((html, i) => (
        <MdBlock key={i} html={html} />
      ))}
    </div>
  );
});

function baseName(uri: string): string {
  try {
    const u = new URL(uri);
    const seg = decodeURIComponent(u.pathname).split("/").filter(Boolean);
    return seg[seg.length - 1] ?? uri;
  } catch {
    const parts = uri.split(/[\\/]/);
    return parts[parts.length - 1] || uri;
  }
}

function uriToPath(uri: string): string | undefined {
  try {
    const u = new URL(uri);
    if (u.protocol !== "file:") return undefined;
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return undefined;
  }
}

export const PartView = memo(function PartView({
  part,
  links,
}: {
  part: Part;
  links?: MarkdownLinks;
}): React.JSX.Element {
  switch (part.type) {
    case "text":
      return <Markdown text={part.text} links={links} />;
    case "image":
      return (
        <img
          className="part-image"
          src={`data:${part.mimeType};base64,${part.data}`}
          alt="embedded content"
        />
      );
    case "resource_link": {
      const p = uriToPath(part.uri);
      return (
        <button
          className="chip link"
          title={part.uri}
          onClick={() => p && post({ type: "openFile", path: p })}
        >
          <IconLink size={12} /> {part.name || baseName(part.uri)}
          <FileContextBadges context={part.fileContext} />
        </button>
      );
    }
    case "resource":
      return (
        <div className="part-resource">
          <div className="chip">
            <IconFile size={12} /> {baseName(part.uri)}
            <FileContextBadges context={part.fileContext} />
          </div>
          {part.text != null && <Markdown text={part.text} />}
        </div>
      );
    case "audio":
      return <audio controls src={`data:${part.mimeType};base64,${part.data}`} />;
    default:
      return <div className="dim">[unsupported content]</div>;
  }
});

export const PartsView = memo(function PartsView({
  parts,
  links,
}: {
  parts: Part[];
  links?: MarkdownLinks;
}): React.JSX.Element {
  return (
    <>
      {parts.map((p, i) => (
        <PartView key={i} part={p} links={links} />
      ))}
    </>
  );
});
