import * as path from "path";
import * as fs from "fs/promises";

export interface IconInfo {
  iconSvg?: string;
  iconMono?: boolean;
}

const MAX_ICON_BYTES = 64 * 1024;

/** Strip active content and external references from an SVG document. */
export function sanitizeSvg(svg: string): string | undefined {
  if (!/<svg[\s>]/i.test(svg)) return undefined;
  let s = svg;
  s = s.replace(/<script\b[\s\S]*?(<\/script\s*>|\/>)/gi, "");
  s = s.replace(/<foreignObject\b[\s\S]*?(<\/foreignObject\s*>|\/>)/gi, "");
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\b(?:xlink:)?href\s*=\s*(["'])(?!#)[^"']*\1/gi, "");
  return s;
}

/** True when the SVG only paints with currentColor / none / absent colors. */
export function svgIsMono(svg: string): boolean {
  const ok = (v: string) => !v || v === "currentcolor" || v === "none";
  for (const m of svg.matchAll(/\b(?:fill|stroke)\s*=\s*"([^"]*)"/gi)) {
    if (!ok(m[1].trim().toLowerCase())) return false;
  }
  for (const m of svg.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) {
    for (const d of m[1].matchAll(/(?:^|;)\s*(?:fill|stroke)\s*:\s*([^;]+)/g)) {
      if (!ok(d[1].trim().toLowerCase())) return false;
    }
  }
  return true;
}

function safeName(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}

export class IconService {
  private readonly dir: string;
  private readonly info = new Map<string, IconInfo>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(storageDir: string) {
    this.dir = path.join(storageDir, "icons");
  }

  onDidChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }

  /** Load every cached SVG into memory. */
  async init(): Promise<void> {
    try {
      for (const f of await fs.readdir(this.dir)) {
        if (!f.endsWith(".svg")) continue;
        try {
          const svg = sanitizeSvg(
            await fs.readFile(path.join(this.dir, f), "utf8"),
          );
          if (svg) this.info.set(f.slice(0, -4), this.toInfo(svg));
        } catch {
          /* corrupt cache file */
        }
      }
    } catch {
      /* no icon dir yet */
    }
  }

  private toInfo(svg: string): IconInfo {
    return {
      iconSvg: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
      iconMono: svgIsMono(svg),
    };
  }

  /** Kick off a fetch+cache for `id` if we don't already have its icon. */
  ensure(id: string, source?: string): void {
    if (!source || this.info.has(safeName(id)) || this.pending.has(id)) return;
    this.pending.add(id);
    void this.fetch(id, source).finally(() => this.pending.delete(id));
  }

  get(id: string): IconInfo | undefined {
    return this.info.get(safeName(id));
  }

  private file(id: string): string {
    return path.join(this.dir, `${safeName(id)}.svg`);
  }

  private async fetch(id: string, source: string): Promise<void> {
    try {
      let raw: string | undefined;
      if (/^https?:/i.test(source)) {
        const res = await fetch(source);
        if (!res.ok) return;
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("svg") && !source.toLowerCase().endsWith(".svg")) return;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return;
        raw = buf.toString("utf8");
      } else {
        if (!source.toLowerCase().endsWith(".svg")) return;
        const stat = await fs.stat(source);
        if (stat.size > MAX_ICON_BYTES) return;
        raw = await fs.readFile(source, "utf8");
      }
      const svg = sanitizeSvg(raw);
      if (!svg) return;
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file(id)}.tmp`;
      await fs.writeFile(tmp, svg);
      await fs.rename(tmp, this.file(id));
      this.info.set(safeName(id), this.toInfo(svg));
      this.fire();
    } catch {
      /* icon unavailable — descriptor falls back to the generic mark */
    }
  }
}
