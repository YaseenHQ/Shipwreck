import type * as acp from "@agentclientprotocol/sdk";
import type { Attachment, Part } from "./types";
import { attachmentError } from "./attachments";

export async function buildPrompt(
  text: string,
  attachments: Attachment[],
  capabilities: { image?: boolean; embeddedContext?: boolean },
  readText: (att: Attachment) => Promise<string | null>,
): Promise<{ blocks: acp.ContentBlock[]; parts: Part[]; warnings: string[] }> {
  const blocks: acp.ContentBlock[] = [];
  const parts: Part[] = [];
  const warnings: string[] = [];
  if (text.trim()) {
    blocks.push({ type: "text", text });
    parts.push({ type: "text", text });
  }
  for (const att of attachments) {
    const error = attachmentError(att, !!capabilities.image);
    if (error) {
      warnings.push(`${att.name}: ${error}`);
      continue;
    }
    if (att.kind === "rejected") continue;
    if (att.kind === "image") {
      const image = { type: "image" as const, data: att.data, mimeType: att.mimeType };
      blocks.push(image);
      parts.push(image);
      continue;
    }
    const uri = att.range ? `${att.uri}#L${att.range.startLine}-${att.range.endLine}` : att.uri;
    const name = att.range ? `${att.name}:${att.range.startLine}-${att.range.endLine}` : att.name;
    const diagnostics = att.fileContext?.diagnostics;
    if (diagnostics?.items.length) {
      const lines = diagnostics.items.map((d) => `L${d.line} ${d.severity}${d.code ? ` ${d.code}` : ""} ${d.message}`);
      const omitted = diagnostics.error + diagnostics.warning - diagnostics.items.length;
      if (omitted > 0) lines.push(`${omitted} more problems omitted.`);
      const problems = `Problems in ${att.name}:\n${lines.join("\n")}`;
      blocks.push({ type: "text", text: problems });
    }
    if (att.kind === "text-file") {
      if (capabilities.embeddedContext) {
        blocks.push({ type: "resource", resource: { uri, mimeType: att.mimeType, text: att.text } });
      } else {
        let fenceLength = 3;
        for (const match of att.text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
        const fence = "`".repeat(fenceLength);
        blocks.push({ type: "text", text: `File: ${att.name}\n${fence}\n${att.text}\n${fence}` });
      }
      parts.push({ type: "resource", uri, text: att.text, mimeType: att.mimeType, fileContext: att.fileContext });
      continue;
    }
    if (att.kind === "folder" || (att.contextSource === "active-editor" && !att.range)) {
      blocks.push({ type: "resource_link", uri: att.uri, name: att.name });
    } else if (capabilities.embeddedContext) {
      const content = att.text ?? await readText(att);
      blocks.push(content != null
        ? { type: "resource", resource: { uri, mimeType: att.mimeType ?? "text/plain", text: content } }
        : { type: "resource_link", uri, name: att.name, mimeType: att.mimeType });
    } else {
      blocks.push({ type: "resource_link", uri, name: att.name, mimeType: att.mimeType });
      if (att.text != null && (att.kind === "selection" || att.kind === "terminal")) {
        blocks.push({ type: "text", text: att.text });
      }
    }
    parts.push({ type: "resource_link", uri, name, mimeType: att.mimeType, fileContext: att.fileContext });
  }
  return { blocks, parts, warnings };
}
