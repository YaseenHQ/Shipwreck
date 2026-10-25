import * as vscode from "vscode";
import * as path from "path";

export interface FileRef {
  path: string;
  line?: number;
  column?: number;
}

/** Splits `file:///a/b.ts#L12C3`, `src/b.ts:12:3` or `src/b.ts#L12` into path and position. */
export function parseFileRef(raw: string): FileRef {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    // fsPath drops the fragment, which is where a #L12 position lives.
    const hash = p.indexOf("#");
    const fragment = hash >= 0 ? p.slice(hash) : "";
    const url = hash >= 0 ? p.slice(0, hash) : p;
    try {
      p = (vscode.Uri.parse(url).fsPath || decodeURIComponent(url.replace(/^file:\/\//i, ""))) + fragment;
    } catch {
      p = decodeURIComponent(url.replace(/^file:\/\//i, "")) + fragment;
    }
  } else {
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep as written */
    }
  }
  let m = /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(p);
  if (m) {
    return { path: p.slice(0, m.index), line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined };
  }
  // A drive letter's colon ("C:\x") is not a line suffix: require digits at the end.
  m = /:(\d+)(?::(\d+))?$/.exec(p);
  if (m && m.index > 1) {
    return { path: p.slice(0, m.index), line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined };
  }
  return { path: p };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    const s = await vscode.workspace.fs.stat(uri);
    return s.type !== vscode.FileType.Directory;
  } catch {
    return false;
  }
}

/** Absolute path, else relative to the session folder or a workspace root, else a workspace search. */
export async function resolveFileRef(p: string, roots: string[]): Promise<vscode.Uri | undefined> {
  if (!p) return undefined;
  if (path.isAbsolute(p)) {
    const uri = vscode.Uri.file(p);
    return (await exists(uri)) ? uri : undefined;
  }
  const clean = p.replace(/^\.[\\/]/, "");
  for (const root of roots) {
    const uri = vscode.Uri.file(path.join(root, clean));
    if (await exists(uri)) return uri;
  }
  if (clean.includes("..")) return undefined;
  const glob = `**/${clean.replace(/\\/g, "/")}`;
  const found = await vscode.workspace.findFiles(glob, "**/node_modules/**", 1);
  return found[0];
}
