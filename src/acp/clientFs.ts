import * as vscode from "vscode";
import * as path from "path";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function samePath(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return caseInsensitive ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** The open editor buffer for a file, which may hold unsaved edits. */
export function openDocument(filePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === "file" && samePath(d.uri.fsPath, filePath),
  );
}

/** Current text of a file: the editor buffer when open, else the file on disk. */
export async function currentText(filePath: string): Promise<string> {
  const doc = openDocument(filePath);
  if (doc) return doc.getText();
  const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  return Buffer.from(raw).toString("utf8");
}

/** Text if the file exists (open or on disk), else undefined. */
export async function currentTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await currentText(filePath);
  } catch {
    return undefined;
  }
}

export async function readTextFile(
  filePath: string,
  line?: number | null,
  limit?: number | null,
): Promise<string> {
  const content = await currentText(filePath);
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit != null ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}

/**
 * Writes through the editor buffer when the file is open, so the edit lands
 * on its undo stack and the editor never sees a conflicting on-disk change,
 * then saves so tools the agent runs next read the new content.
 */
export async function writeTextFile(filePath: string, content: string): Promise<void> {
  const doc = openDocument(filePath);
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      content,
    );
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not edit ${filePath}`);
    if (!(await doc.save())) throw new Error(`Could not save ${filePath}`);
    return;
  }
  await writeDisk(filePath, Buffer.from(content, "utf8"));
}

/** Exact bytes for a closed file; an open one is written as text through its buffer. */
export async function writeFileBytes(filePath: string, bytes: Uint8Array): Promise<void> {
  if (openDocument(filePath)) return writeTextFile(filePath, Buffer.from(bytes).toString("utf8"));
  await writeDisk(filePath, bytes);
}

async function writeDisk(filePath: string, bytes: Uint8Array): Promise<void> {
  const parent = vscode.Uri.file(path.dirname(filePath));
  await vscode.workspace.fs.createDirectory(parent).then(
    () => undefined,
    () => undefined,
  );
  await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), bytes);
}

/** Removes a file the agent created; closes nothing, the editor shows it as deleted. */
export async function deleteFile(filePath: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(vscode.Uri.file(filePath), { ignoreIfNotExists: true });
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not delete ${filePath}`);
}
