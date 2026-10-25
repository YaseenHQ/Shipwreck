import { Marked, type Token, type TokensList } from "marked";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* Insertion-ordered Map as an LRU: a hit is re-inserted at the end. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }
}

function highlight(text: string, lang: string): string {
  // highlightAuto runs every grammar over the text; an unlabeled block is
  // escaped instead.
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

function renderCode(text: string, lang: string | undefined): string {
  const l = escapeHtml((lang ?? "").trim().split(/\s+/)[0] ?? "");
  return `<div class="codeblock"><div class="codeblock-head"><span class="codeblock-lang">${l || "text"}</span><span class="codeblock-copy" role="button" tabindex="0" title="Copy code" aria-label="Copy code">Copy</span></div><pre><code class="hljs language-${l}">${highlight(text, l)}</code></pre></div>`;
}

const SOURCE_EXT = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx css scss sass less html htm vue svelte astro " +
    "py pyi rs go java kt kts scala swift c h cc cpp cxx hpp hh m mm cs fs vb rb php pl lua dart ex exs erl " +
    "zig nim r jl sh bash zsh fish ps1 psm1 bat cmd yml yaml toml ini cfg conf xml svg txt lock sql graphql gql " +
    "proto tf hcl gradle ipynb csv tsv log env"
  ).split(" "),
);

/* Library names that read like file names but are not paths. */
const LIBRARY_NAME = /^(node|next|nuxt|vue|react|three|d3|express|deno|chart|socket\.io|ember|backbone)\.js$/i;

const PATH_LIKE = /^((?:[A-Za-z]:)?[\w.\-@+~\\/]+?\.([A-Za-z0-9]{1,8}))(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/;

/** Whether an inline code span reads as a file path (optionally with :line[:col] or #Lline). */
export function isFilePath(s: string): boolean {
  if (s.length === 0 || s.length >= 200 || /\s/.test(s)) return false;
  const m = PATH_LIKE.exec(s);
  if (!m) return false;
  const [, path, ext] = m;
  if (!/[A-Za-z]/.test(ext)) return false;
  const base = path.split(/[\\/]/).pop() ?? "";
  const stem = base.slice(0, base.length - ext.length - 1);
  if (!stem || stem.endsWith(".")) return false;
  if (/[\\/]/.test(path)) return true;
  return SOURCE_EXT.has(ext.toLowerCase()) && !LIBRARY_NAME.test(base);
}

/** The local path a markdown link points at, or undefined for web and other-scheme links. */
export function linkPath(href: string): string | undefined {
  const h = href.trim();
  if (!h || h.startsWith("#")) return undefined;
  let p: string;
  if (/^file:/i.test(h)) {
    p = h.replace(/^file:(\/\/)?/i, "");
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(h)) {
    // http(s), mailto and any other scheme; a single letter is a drive.
    return undefined;
  } else {
    p = h;
  }
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

const options = { breaks: true, gfm: true } as const;

const plain = new Marked({
  ...options,
  renderer: {
    code({ text, lang }) {
      return renderCode(text, lang);
    },
  },
});

/* Agent text: local links and path-like code spans open in the editor. */
const linked = new Marked({
  ...options,
  renderer: {
    code({ text, lang }) {
      return renderCode(text, lang);
    },
    codespan({ text }) {
      if (!isFilePath(text)) return false;
      const t = escapeHtml(text);
      return `<code class="file-link" data-path="${t}" role="link" tabindex="0" title="Open ${t}">${t}</code>`;
    },
    link({ href, title, tokens }) {
      const p = linkPath(href);
      if (p === undefined) return false;
      const inner = this.parser.parseInline(tokens);
      return `<a href="#" class="file-link" data-path="${escapeHtml(p)}" title="${escapeHtml(title || p)}">${inner}</a>`;
    },
  },
});

const purifier = DOMPurify();

function sanitize(html: string): string {
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["tabindex"],
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
  });
}

const blockCache = new Lru<string>(2000);
const docCache = new Lru<string[]>(300);

export type MarkdownLinks = "plain" | "files";

/**
 * Markdown -> sanitized HTML, one string per top-level block. Blocks are
 * cached by their source, so while a message streams only its growing tail
 * is parsed, highlighted and sanitized again.
 */
export function renderMarkdownBlocks(md: string, links: MarkdownLinks = "plain"): string[] {
  // The two renderers share the caches; the prefix keeps their output apart.
  const prefix = links === "files" ? "f\u0000" : "p\u0000";
  const docKey = prefix + md;
  const hit = docCache.get(docKey);
  if (hit) return hit;
  const marked = links === "files" ? linked : plain;
  const tokens = marked.lexer(md);
  const out: string[] = [];
  for (const tok of tokens as Token[]) {
    if (tok.type === "space") continue;
    const key = prefix + tok.raw;
    let html = blockCache.get(key);
    if (html === undefined) {
      // Reference links are resolved while lexing, so a block parses alone.
      const one = Object.assign([tok], { links: tokens.links }) as TokensList;
      html = sanitize(marked.parser(one) as string);
      blockCache.set(key, html);
    }
    out.push(html);
  }
  docCache.set(docKey, out);
  return out;
}

/** Render trusted structure: markdown -> sanitized HTML string. */
export function renderMarkdown(md: string): string {
  return renderMarkdownBlocks(md).join("");
}
