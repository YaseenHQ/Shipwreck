import type { Attachment } from "./types";

export const IMAGE_LIMIT = 5 * 1024 * 1024;
export const TEXT_LIMIT = 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp",
};

export function imageMimeType(name: string, mimeType = ""): string | undefined {
  return Object.values(IMAGE_TYPES).includes(mimeType)
    ? mimeType
    : IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""];
}

export function attachmentSizeError(size: number, image: boolean): string | undefined {
  return size > (image ? IMAGE_LIMIT : TEXT_LIMIT)
    ? image ? "Image exceeds 5 MB." : "Text file exceeds 1 MB."
    : undefined;
}

export function attachmentFromBytes(
  uri: string,
  name: string,
  bytes: Uint8Array,
  mimeType = "",
): Attachment {
  const image = imageMimeType(name, mimeType);
  const error = attachmentSizeError(bytes.byteLength, !!image);
  if (error) return { uri, name, kind: "rejected", error };
  if (image) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }
    return { uri, name, kind: "image", data: btoa(binary), mimeType: image };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error("Binary");
    return { uri, name, kind: "text-file", text, mimeType: mimeType || "text/plain" };
  } catch {
    return { uri, name, kind: "rejected", error: "Binary files aren't supported." };
  }
}

export function attachmentError(att: Attachment, images: boolean): string | undefined {
  if (att.kind === "rejected") return att.error;
  if (att.kind === "image") {
    const size = Math.floor(att.data.length * 3 / 4) - (att.data.endsWith("==") ? 2 : att.data.endsWith("=") ? 1 : 0);
    return attachmentSizeError(size, true) ?? (!images ? "This agent doesn't support images." : undefined);
  }
  if (att.kind === "text-file") {
    return attachmentSizeError(new TextEncoder().encode(att.text).byteLength, false);
  }
  return undefined;
}
