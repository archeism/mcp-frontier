import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseDocument } from "yaml";
import { z } from "zod/v4";
import { Type } from "typebox";
import { ResourceSchema } from "@modelcontextprotocol/core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMcpProtocol, type McpProtocolSession } from "./runtime-protocol.ts";
import type { ResourceReadPolicy } from "./types.ts";
import { rememberVerifiedSkillResource } from "./tool-registrar.ts";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export const SKILLS_PROTOCOL = {
  namespace: "skills",
  requests: ["skills/list", "skills/get", "resources/read", "resources/directory/read"],
  streams: [], notifications: [],
};
const record = z.record(z.string(), z.unknown());
const resource = z.object({
  uri: z.string(), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
const entrySchema = z.object({
  uri: z.string(),
  frontmatter: record.and(z.object({
    name: z.string().min(1).refine(value => [...value].length <= 64),
    description: z.string().min(1).refine(value => [...value].length <= 1024),
    license: z.string().optional(),
    compatibility: z.string().min(1).refine(value => [...value].length <= 500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().optional(),
  })),
  resources: z.union([z.array(resource).min(1).max(512), z.literal("dynamic")]),
}).passthrough();
export type SkillEntry = z.infer<typeof entrySchema>;
type StaticEntry = SkillEntry & { resources: z.infer<typeof resource>[] };
const resultSchema = z.object({
  resultType: z.literal("complete").optional(), // SDK codecs can lift the complete discriminator.
  ttlMs: z.number().nonnegative().nullable(),
  cacheScope: z.enum(["public", "private"]),
}).passthrough();

function normalizeAuthority(url: URL): void {
  // RFC 3986 generic reg-name syntax: ASCII case and unreserved escapes only.
  // Opaque URL hosts must not acquire DNS, IDNA, or Unicode case-folding semantics.
  if (!url.hostname.startsWith("[")) url.hostname = url.hostname.replace(/%[0-9a-f]{2}|[A-Z]/gi, token => {
    if (!token.startsWith("%")) return token.toLowerCase();
    const character = String.fromCharCode(parseInt(token.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character.toLowerCase() : token.toUpperCase();
  });
}
function safeUri(uri: string): string {
  const url = new URL(uri);
  if (url.search || url.hash || url.username || url.password || !uri.includes("://")) throw new Error("Invalid skill URI");
  const decoded = uri.split("/").slice(2).map(s => decodeURIComponent(s));
  if (decoded.some(s => s === "." || s === ".." || s.includes("/") || s.includes("\\") || /[\x00-\x1f]/.test(s)))
    throw new Error("Invalid skill path");
  normalizeAuthority(url);
  url.pathname = url.pathname.split("/").map(s => encodeURIComponent(decodeURIComponent(s))).join("/");
  return url.href;
}
function rootOf(uri: string): string {
  uri = safeUri(uri);
  if (!uri.endsWith("/SKILL.md")) throw new Error("Skill URI must end in /SKILL.md");
  return uri.slice(0, -"/SKILL.md".length);
}
function resolveSkillPath(root: string, path: string): string {
  // Validate before URL resolution can erase dot segments or reinterpret separators.
  safeUri(path.includes("://") ? path : root + "/" + path);
  return safeUri(new URL(path, root + "/").href);
}
function wireSkillPath(skillUri: string, path: string): string {
  return path.includes("://") ? path : new URL(path, new URL(".", skillUri)).href;
}
export function validateSkill(raw: unknown): SkillEntry {
  const entry = entrySchema.parse(raw);
  const root = rootOf(entry.uri);
  const name = decodeURIComponent(root.slice(root.lastIndexOf("/") + 1));
  if (name !== entry.frontmatter.name || !/^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u.test(name))
    throw new Error("Skill name does not match its directory");
  if (entry.resources !== "dynamic") {
    const seen = new Set<string>();
    let total = 0;
    for (const item of entry.resources) {
      const canonical = safeUri(item.uri);
      if (!canonical.startsWith(root + "/") || seen.has(canonical)) throw new Error("Invalid or duplicate manifest resource");
      seen.add(canonical);
      total += item.size;
    }
    if (!seen.has(safeUri(entry.uri))) throw new Error("Manifest omits SKILL.md");
    if (total > 16 * 1024 * 1024) throw new Error("Skill exceeds 16 MiB");
  }
  return entry;
}
function contentBytes(raw: unknown, uri: string): Buffer {
  const result = resultSchema.parse(raw);
  const contents = z.array(z.object({ uri: z.string(), text: z.string().optional(), blob: z.string().optional() }).passthrough()).length(1).parse(result.contents);
  const item = contents[0]!;
  if (safeUri(item.uri) !== safeUri(uri) || (item.text === undefined) === (item.blob === undefined)) throw new Error("Invalid skill resource content");
  if (item.text !== undefined) return Buffer.from(item.text, "utf8");
  const blob = item.blob!;
  const padding = blob.endsWith("==") ? 2 : blob.endsWith("=") ? 1 : 0;
  if (blob.length % 4 || /[^A-Za-z0-9+/]/.test(blob.slice(0, blob.length - padding))) throw new Error("Invalid base64");
  return Buffer.from(item.blob!, "base64");
}
export function verifyContent(entry: StaticEntry, uri: string, bytes: Buffer): void {
  const item = entry.resources.find(r => safeUri(r.uri) === safeUri(uri));
  if (!item || item.size !== bytes.length || item.digest !== "sha256:" + createHash("sha256").update(bytes).digest("hex"))
    throw new Error("Skill integrity verification failed; refresh and approve the changed skill");
  if (safeUri(uri) === safeUri(entry.uri)) verifyFrontmatter(entry, bytes);
}
function verifyFrontmatter(entry: SkillEntry, bytes: Buffer): void {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new Error("Missing skill frontmatter");
    const document = parseDocument(match[1]!, { uniqueKeys: true });
    if (document.errors.length || !isDeepStrictEqual(document.toJS({ maxAliasCount: 20 }), entry.frontmatter))
      throw new Error("Skill frontmatter disagrees with its entry");
}
function fingerprint(entry: StaticEntry): string {
  return JSON.stringify(entry.resources.map(r => [safeUri(r.uri), r.digest, r.size]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
export interface SkillsResourceReadPolicy {
  readResource: ResourceReadPolicy;
  /** Remember verification metadata without approving or activating the skill. */
  observe(server: string, entry: SkillEntry): void;
  /** Internal verified Skills reads; this scope never includes user approval callbacks. */
  readSkill<T>(server: string, uri: string, read: () => Promise<T>): Promise<T>;
  hold(server: string, entry: SkillEntry, revoke: () => void): void;
  revoke(server: string, uri: string): void;
  restore(server: string, uri?: string): void;
  reset(): void;
}

/** Create once per Pi installation and share with the adapter and installSkills. */
export function createSkillsResourceReadPolicy(): SkillsResourceReadPolicy {
  type Held = { entry?: SkillEntry; activated?: boolean; revoke?: () => void };
  const servers = new Map<string, Map<string, Held>>();
  const legacy = new Set<string>();
  const verifiedRead = new AsyncLocalStorage<{ server: string; uri: string }>();
  let generation = 0;
  const roots = (server: string) => {
    let value = servers.get(server);
    if (!value) { value = new Map(); servers.set(server, value); }
    return value;
  };
  const matches = (server: string, uri: string) => [...(servers.get(server) ?? [])]
    .filter(([root]) => uri === root || uri.startsWith(root + "/"));
  const identity = (server: string, uri: string) => {
    try { return safeUri(uri); }
    catch (error) {
      // Skill path restrictions must not change unrelated Resources URI semantics.
      const candidates = [uri];
      try { candidates.push(decodeURIComponent(uri)); } catch {}
      try {
        const url = new URL(uri);
        normalizeAuthority(url);
        // Keep the original path: URL parsing may already have erased traversal segments.
        const unresolved = uri.replace(/^[^:]+:\/\/[^/]*/, url.protocol + "//" + url.host);
        candidates.push(unresolved);
        try { candidates.push(decodeURIComponent(unresolved)); } catch {}
        candidates.push(url.href, url.protocol + "//" + url.host + url.pathname);
      } catch {}
      for (const root of servers.get(server)?.keys() ?? []) {
        if (candidates.some(value => [root, decodeURIComponent(root)].some(r => value === r || value.startsWith(r + "/")))) throw error;
      }
      return uri;
    }
  };
  const revoke = (server: string, uri: string) => {
    const root = rootOf(uri), old = roots(server).get(root);
    roots(server).set(root, {}); old?.revoke?.();
  };
  return {
    async readResource(server, uri, read, signal) {
      signal?.throwIfAborted();
      const scope = verifiedRead.getStore();
      if (scope?.server === server && scope.uri === safeUri(uri)) return read();
      if (legacy.has(server)) throw new Error("Restored skill approval must be refreshed before generic resource reads");
      // Ordinary resource schemes are unrestricted unless this server has protected skill roots.
      if (!servers.has(server)) {
        const before = generation, result = await read();
        signal?.throwIfAborted();
        if (before !== generation || servers.has(server) || legacy.has(server)) throw new Error("Skill approval changed while reading");
        return result;
      }
      const canonical = identity(server, uri), held = matches(server, canonical), before = generation;
      for (const [, value] of held) {
        if (!value.entry) throw new Error("Skill is not activated or approval was revoked; refresh and approve again");
        if (value.activated && value.entry.resources === "dynamic") throw new Error("Unpinned skill content requires fresh per-read approval through mcp_skills");
        if (value.activated && value.entry.resources !== "dynamic" && !value.entry.resources.some(r => safeUri(r.uri) === canonical))
          throw new Error("Unlisted skill file or path outside skill root");
      }
      const verified = held.filter(([, value]) => value.entry?.resources !== "dynamic" &&
        value.entry?.resources.some(r => safeUri(r.uri) === canonical));
      try {
        const result = await read();
        signal?.throwIfAborted();
        const current = matches(server, canonical);
        if (before !== generation || legacy.has(server) || current.length !== held.length ||
            current.some(([root, value], i) => root !== held[i]?.[0] || value !== held[i]?.[1]))
          throw new Error("Skill approval was revoked or changed while reading");
        if (result && typeof result === "object" && "contents" in result && Array.isArray(result.contents)) {
          for (const item of result.contents) {
            if (item && typeof item.uri === "string" && matches(server, identity(server, item.uri)).length &&
                identity(server, item.uri) !== canonical) throw new Error("Invalid skill resource content: server substituted a protected skill URI");
          }
        }
        for (const [, value] of verified) verifyContent(value.entry as StaticEntry, canonical, contentBytes(result, canonical));
        if (verified.length && result && typeof result === "object" && "contents" in result && Array.isArray(result.contents)) {
          const entry = verified[0]![1].entry as StaticEntry;
          const resource = entry.resources.find(r => safeUri(r.uri) === canonical)!;
          for (const item of result.contents) rememberVerifiedSkillResource(item, { server, ...resource });
        }
        return result;
      } catch (error) {
        for (const [root, value] of held) if (value.activated && servers.get(server)?.get(root) === value) revoke(server, value.entry!.uri);
        throw error;
      }
    },
    observe(server, entry) {
      const root = rootOf(entry.uri), old = roots(server).get(root);
      // Metadata cannot reopen a revoked/restored acting window or replace its held entry.
      if (old && !old.entry) return;
      if (old?.activated) {
        if (old.entry!.resources === "dynamic" || entry.resources === "dynamic" ||
            fingerprint(old.entry as StaticEntry) !== fingerprint(entry as StaticEntry)) revoke(server, entry.uri);
        return;
      }
      roots(server).set(root, { entry: structuredClone(entry), activated: false });
    },
    readSkill: (server, uri, read) => verifiedRead.run({ server, uri: safeUri(uri) }, read),
    hold(server, entry, onRevoke) { roots(server).set(rootOf(entry.uri), { entry, activated: true, revoke: onRevoke }); },
    revoke,
    restore(server, uri) {
      if (!uri) { legacy.add(server); return; }
      try { revoke(server, uri); } catch { legacy.add(server); }
    },
    reset() {
      generation++;
      for (const values of servers.values()) for (const value of values.values()) value.revoke?.();
      servers.clear(); legacy.clear();
    },
  };
}
export class SkillsClient {
  private held = new Map<string, SkillEntry>();
  private dynamicBytes = new Map<string, Map<string, number>>();
  private revisions = new Map<string, number>();
  private activations = new Map<string, number>();
  constructor(readonly session: McpProtocolSession, private readonly policy?: { server: string; resourceReadPolicy: SkillsResourceReadPolicy }) {
    session.signal.addEventListener("abort", () => {
      for (const uri of this.held.keys()) this.revoke(uri);
    }, { once: true });
  }
  private revoke(uri: string) {
    this.held.delete(uri); this.dynamicBytes.delete(uri);
    this.policy?.resourceReadPolicy.revoke(this.policy.server, uri);
  }
  private readResource(uri: string, signal?: AbortSignal) {
    const read = () => this.request("resources/read", { uri }, signal);
    return this.policy ? this.policy.resourceReadPolicy.readSkill(this.policy.server, uri, read) : read();
  }
  private declaration(): { directoryRead?: boolean } {
    const caps = this.session.serverCapabilities;
    const ext = (caps.extensions as Record<string, unknown> | undefined)?.[SKILLS_EXTENSION];
    if (this.session.protocolVersion !== "2026-07-28" || !caps.resources || !ext || typeof ext !== "object" || Array.isArray(ext))
      throw new Error("Server does not declare the MCP Skills extension on 2026-07-28");
    return ext as { directoryRead?: boolean };
  }
  private async request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
    this.declaration();
    return resultSchema.parse(await this.session.request(method, params, signal));
  }
  async list(signal?: AbortSignal): Promise<SkillEntry[]> {
    const entries: SkillEntry[] = [], cursors = new Set<string>(), uris = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = await this.request("skills/list", cursor ? { cursor } : {}, signal);
      for (const raw of z.array(z.unknown()).parse(result.skills)) {
        const entry = validateSkill(raw);
        if (uris.has(safeUri(entry.uri))) throw new Error("Duplicate skill URI in listing");
        uris.add(safeUri(entry.uri)); entries.push(entry); this.observe(entry);
      }
      if (result.nextCursor === undefined) return entries;
      cursor = z.string().min(1).parse(result.nextCursor);
      if (cursors.has(cursor)) throw new Error("Repeated skills cursor");
      cursors.add(cursor);
    }
    throw new Error("Skills listing exceeded pagination limit; listing may be incomplete");
  }
  private observe(entry: SkillEntry) {
    const uri = safeUri(entry.uri);
    this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + 1);
    const old = this.held.get(uri);
    if (old && (old.resources === "dynamic" || entry.resources === "dynamic" || fingerprint(old as StaticEntry) !== fingerprint(entry as StaticEntry)))
      this.revoke(uri);
    this.policy?.resourceReadPolicy.observe(this.policy.server, entry);
  }
  async get(uri: string, signal?: AbortSignal): Promise<SkillEntry> {
    rootOf(uri);
    try {
      const result = await this.request("skills/get", { uri }, signal);
      const entry = validateSkill(result.skill);
      if (safeUri(entry.uri) !== safeUri(uri)) throw new Error("Server substituted another skill URI");
      this.observe(entry); return entry;
    } catch (error) {
      uri = safeUri(uri);
      this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + 1);
      this.revoke(uri); throw error;
    }
  }
  async load(uri: string, approve: (entry: SkillEntry) => Promise<boolean>, signal?: AbortSignal, allowDynamic = false): Promise<string> {
    signal?.throwIfAborted();
    const requestedUri = uri;
    uri = safeUri(uri);
    const activation = (this.activations.get(uri) ?? 0) + 1;
    this.activations.set(uri, activation);
    this.revoke(uri);
    this.dynamicBytes.delete(uri);
    this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + 1);
    const entry = await this.get(requestedUri, signal);
    if (this.activations.get(uri) !== activation) throw new Error("Skill activation was superseded by a newer request");
    const revision = this.revisions.get(uri);
    if (entry.resources === "dynamic" && !allowDynamic) throw new Error("Dynamic skills cannot be content-verified; explicit unpinned activation is required");
    if (!await approve(structuredClone(entry))) throw new Error("Skill activation declined");
    if (this.activations.get(uri) !== activation) throw new Error("Skill activation was superseded by a newer request");
    signal?.throwIfAborted();
    const wireUri = entry.resources === "dynamic" ? entry.uri : entry.resources.find(r => safeUri(r.uri) === uri)!.uri;
    const bytes = contentBytes(await this.readResource(wireUri, signal), uri);
    if (bytes.length > 16 * 1024 * 1024) throw new Error("Skill exceeds 16 MiB");
    if (entry.resources === "dynamic") verifyFrontmatter(entry, bytes);
    else verifyContent(entry as StaticEntry, uri, bytes);
    if (this.activations.get(uri) !== activation || this.revisions.get(uri) !== revision)
      throw new Error("Skill metadata changed while loading; refresh and approve again");
    signal?.throwIfAborted();
    const held = structuredClone(entry);
    this.held.set(uri, held);
    this.policy?.resourceReadPolicy.hold(this.policy.server, held, () => {
      if (this.held.get(uri) === held) { this.held.delete(uri); this.dynamicBytes.delete(uri); }
    });
    if (entry.resources === "dynamic") this.dynamicBytes.set(uri, new Map([[uri, bytes.length]]));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  async read(skillUri: string, relativeOrAbsolute: string, signal?: AbortSignal, approveDynamic?: (uri: string) => Promise<boolean>): Promise<{ uri: string; text?: string; blob?: string }> {
    skillUri = safeUri(skillUri);
    const held = this.held.get(skillUri);
    if (!held) throw new Error("Skill is not activated or approval was revoked");
    const root = rootOf(skillUri);
    const canonical = resolveSkillPath(root, relativeOrAbsolute);
    const item = held.resources === "dynamic" ? undefined : held.resources.find(r => safeUri(r.uri) === canonical);
    if (!canonical.startsWith(root + "/") || (held.resources !== "dynamic" && !item)) throw new Error("Unlisted skill file or path outside skill root");
    const uri = item?.uri ?? wireSkillPath(held.uri, relativeOrAbsolute);
    if (held.resources === "dynamic" && !await approveDynamic?.(uri)) throw new Error("Unpinned skill content requires fresh per-read approval");
    let bytes: Buffer;
    try {
      bytes = contentBytes(await this.readResource(uri, signal), uri);
      if (this.held.get(skillUri) !== held) throw new Error("Skill approval was revoked while reading");
      if (bytes.length > 16 * 1024 * 1024) throw new Error("Skill file exceeds 16 MiB");
      if (held.resources !== "dynamic") verifyContent(held as StaticEntry, uri, bytes);
      else {
        const sizes = this.dynamicBytes.get(skillUri) ?? new Map<string, number>();
        sizes.set(canonical, bytes.length);
        if ([...sizes.values()].reduce((sum, size) => sum + size, 0) > 16 * 1024 * 1024)
          throw new Error("Dynamic skill exceeds total 16 MiB");
        this.dynamicBytes.set(skillUri, sizes);
        if (canonical === safeUri(held.uri)) verifyFrontmatter(held, bytes);
      }
    } catch (error) {
      if (this.held.get(skillUri) === held) {
        this.revoke(skillUri);
      }
      throw error;
    }
    try { return { uri, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
    catch { return { uri, blob: bytes.toString("base64") }; }
  }
  async directory(skillUri: string, relative = "", signal?: AbortSignal): Promise<unknown[]> {
    skillUri = safeUri(skillUri);
    const held = this.held.get(skillUri);
    if (!held) throw new Error("Skill is not activated or approval was revoked");
    const root = rootOf(skillUri);
    const uri = relative ? resolveSkillPath(root, relative).replace(/\/$/, "") : root;
    if (uri !== root && !uri.startsWith(root + "/")) throw new Error("Directory outside skill root");
    // A complete held manifest can answer without an optional directory RPC.
    const fromManifest = () => {
      const children = new Map<string, { uri: string; name: string; mimeType?: string }>();
      if (held.resources === "dynamic") throw new Error("Dynamic directory discovery requires directoryRead capability");
      for (const file of held.resources) {
        const canonical = safeUri(file.uri);
        if (!canonical.startsWith(uri + "/")) continue;
        const tail = canonical.slice(uri.length + 1), name = decodeURIComponent(tail.split("/")[0]!);
        const childUri = file.uri.split("/").slice(0, uri.split("/").length + 1).join("/");
        children.set(name, { uri: childUri, name, ...(tail.includes("/") ? { mimeType: "inode/directory" } : {}) });
      }
      return [...children.values()];
    };
    if (this.declaration().directoryRead !== true) return fromManifest();
    const resources: unknown[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const wireUri = wireSkillPath(held.uri, relative || ".").replace(/\/$/, "");
      const result = await this.request("resources/directory/read", { uri: wireUri, ...(cursor ? { cursor } : {}) }, signal);
      signal?.throwIfAborted();
      if (this.held.get(skillUri) !== held) throw new Error("Skill approval was revoked while reading directory");
      for (const child of z.array(ResourceSchema).parse(result.resources)) {
        const childUri = safeUri(child.uri);
        // A live listing must never extend the approved manifest.
        if ((held.resources === "dynamic" || held.resources.some(r => safeUri(r.uri) === childUri || safeUri(r.uri).startsWith(childUri + "/"))) &&
            childUri.startsWith(uri + "/") && !childUri.slice(uri.length + 1).includes("/")) resources.push(child);
      }
      if (result.nextCursor === undefined) return resources;
      cursor = z.string().min(1).parse(result.nextCursor);
      if (cursors.has(cursor)) throw new Error("Repeated directory cursor");
      cursors.add(cursor);
    }
    throw new Error("Directory pagination limit");
  }
}
export function installSkills(pi: ExtensionAPI, options: { resourceReadPolicy?: SkillsResourceReadPolicy | undefined } = {}): void {
  let protocol: ReturnType<typeof registerMcpProtocol> | undefined;
  const clients = new Map<string, SkillsClient>();
  const pending = new Map<string, Promise<SkillsClient>>();
  let generation = 0;
  // Retain acting windows conservatively until session replacement; unloading text cannot be guaranteed.
  const origins = new Set<string>();
  const known = new Map<string, Map<string, { uri: string; name: string }>>();
  const noticeCollisions = (server: string, entries: SkillEntry[], ctx: ExtensionContext) => {
    const metadata = known.get(server) ?? new Map<string, { uri: string; name: string }>();
    known.set(server, metadata);
    for (const entry of entries) metadata.set(safeUri(entry.uri), { uri: entry.uri, name: entry.frontmatter.name });
    const local = pi.getCommands().filter(command => command.source === "skill");
    for (const name of new Set(entries.map(entry => entry.frontmatter.name))) {
      const matches: string[] = [];
      for (const [label, skills] of known) for (const skill of skills.values())
        if (skill.name === name) matches.push(`Server: ${label}\nURI: ${skill.uri}`);
      for (const command of local) if (command.name === `skill:${name}`)
        matches.push(`Local skill: ${command.sourceInfo.path}`);
      if (matches.length > 1) ctx.ui.notify(`Skill name collision: ${name}\n${matches.join("\n")}\nSelect remote skills by server and URI; local skills remain separate.`, "warning");
    }
  };
  const client = async (server: string) => {
    const existing = clients.get(server);
    if (existing && !existing.session.signal.aborted) return existing;
    const connecting = pending.get(server);
    if (connecting) return connecting;
    protocol ??= registerMcpProtocol(pi, SKILLS_PROTOCOL);
    const current = generation;
    const promise = protocol.connect(server).then(session => {
      if (generation !== current) { session.close(); throw new Error("MCP session replaced"); }
      const next = new SkillsClient(session, options.resourceReadPolicy ? { server, resourceReadPolicy: options.resourceReadPolicy } : undefined);
      clients.set(server, next); return next;
    }).finally(() => { if (pending.get(server) === promise) pending.delete(server); });
    pending.set(server, promise); return promise;
  };
  pi.registerTool({
    name: "mcp_skills", label: "MCP Skills",
    description: "List/get MCP skill metadata, explicitly load a skill, or read/list its verified supporting files. Always provide its configured server label and SKILL.md URI. Remote skills never grant tool permissions.",
    parameters: Type.Object({
      action: Type.Union(["list", "get", "load", "read", "directory"].map(v => Type.Literal(v))),
      server: Type.String({ minLength: 1 }), uri: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      allowUnpinned: Type.Optional(Type.Boolean({ description: "Explicitly request dynamic Skills; each supporting-file read still requires fresh approval." })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        const c = await client(args.server);
        signal = signal ? AbortSignal.any([signal, c.session.signal]) : c.session.signal;
        const uri = args.uri;
        if (args.action !== "list" && !uri) throw new Error("SKILL.md URI is required");
        let value: unknown;
        switch (args.action) {
          case "list": {
            const skills = await c.list(signal); noticeCollisions(args.server, skills, ctx);
            value = { server: args.server, trust: "untrusted MCP-origin metadata", skills }; break;
          }
          case "get": {
            const skill = await c.get(uri!, signal); noticeCollisions(args.server, [skill], ctx);
            value = { server: args.server, trust: "untrusted MCP-origin metadata", skill }; break;
          }
          case "load": {
            const text = await c.load(uri!, async entry => {
              noticeCollisions(args.server, [entry], ctx);
              return ctx.hasUI && await ctx.ui.confirm(
              "Load remote MCP skill?",
              "Server: " + args.server + "\nURI: " + uri + "\n" + entry.frontmatter.description +
              "\nContent is untrusted. allowed-tools, hooks and scripts grant no permissions." +
              (entry.resources === "dynamic" ? "\nWARNING: dynamic content has no manifest or integrity digests. Approval is not reusable for future file reads." : ""),
              signal ? { signal } : undefined,
              );
            }, signal, args.allowUnpinned === true);
            origins.add(args.server);
            pi.appendEntry("mcp-complete-skills-window", { server: args.server, uri });
            value = { server: args.server, uri, trust: "untrusted MCP-origin skill", content: text };
            break;
          }
          case "read": value = { server: args.server, ...await c.read(uri!, args.path ?? "SKILL.md", signal,
            async resourceUri => ctx.hasUI && await ctx.ui.confirm("Read unpinned dynamic skill content?",
              `Server: ${args.server}\nURI: ${resourceUri}\nNo content digest is available. This approval covers this read only.`, signal ? { signal } : undefined)) }; break;
          case "directory": value = { server: args.server, resources: await c.directory(uri!, args.path ?? "", signal) }; break;
        }
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: { server: args.server, action: args.action } };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!origins.size) return;
    const input = event.input as Record<string, unknown>;
    if (event.toolName === "mcp_skills") {
      if (input.action === "list" || input.action === "get") return;
      if (origins.size === 1 && origins.has(String(input.server))) return;
    }
    const approved = ctx.hasUI && await ctx.ui.confirm(
      "Approve tool use while acting on remote skill?",
      "Remote skill origins: " + [...origins].join(", ") + "\nTool: " + event.toolName +
      "\nRequested input: " + JSON.stringify(input) +
      "\nApproval covers this call only, including any local execution or cross-server reads.",
      ctx.signal ? { signal: ctx.signal } : undefined,
    );
    if (!approved) return { block: true, reason: "Remote skills do not authorize local execution or cross-origin tool calls" };
  });
  let sessionManager: ExtensionContext["sessionManager"] | undefined;
  const resetClients = () => {
    generation++;
    for (const client of clients.values()) client.session.close();
    protocol?.dispose(); protocol = undefined; clients.clear(); pending.clear();
  };
  const reset = () => { options.resourceReadPolicy?.reset(); resetClients(); origins.clear(); known.clear(); };
  const restoreWindows = (ctx: ExtensionContext) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "mcp-complete-skills-window" &&
          typeof (entry.data as { server?: unknown } | undefined)?.server === "string")
        {
          const data = entry.data as { server: string; uri?: string };
          origins.add(data.server);
          options.resourceReadPolicy?.restore(data.server, data.uri);
        }
    }
  };
  pi.on("session_start", (_event, ctx) => {
    reset(); sessionManager = ctx.sessionManager; restoreWindows(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    if (ctx.sessionManager !== sessionManager) return;
    // Navigation cannot restore content-bound consent. Keep old root tombstones and origin gates.
    resetClients(); restoreWindows(ctx);
  });
  pi.on("session_shutdown", reset);
}

