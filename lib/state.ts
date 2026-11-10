import { randomUUID } from "node:crypto";
import { parseAgentName } from "./agent-name.ts";

export const ORIENTATION_ENTRY = "pi-rex.orientation";
export const BOOTSTRAP_ENV = "PI_REX_BOOTSTRAP";
export const LEASE_MS = 20_000;
export const RENEW_MS = 5_000;

export type Role = "main" | "chat" | "review";
export type Placement = "session" | "right" | "down" | "tab";
export interface Identity {
  taskId: string;
  conversationId: string;
  piSessionId: string;
  role: Role;
}
export interface Orientation extends Identity {
  version: 1;
  origin?: Identity;
}
export interface Bootstrap extends Orientation {
  serverInstance: string;
}
export interface Target {
  sessionId: string;
  windowId: string;
  blockId: string;
  owner?: string;
}
export interface Server {
  endpoint: string;
  instanceId: string;
  hostId: string;
}
export interface Binding extends Identity {
  version: 1;
  /** Optional for legacy/wire compatibility; new local bindings always include one. */
  name?: string;
  serverInstance: string;
  hostId: string;
  blockId: string;
  token: string;
  pid: number;
  expiresAt: number;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
export function rexId(value: unknown, kind: "session" | "window" | "block" | "client" | "layer"): value is string {
  return typeof value === "string" && value.startsWith(kind + ":") && uuid(value.slice(kind.length + 1));
}
export function piSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/.test(value);
}
export function identity(value: unknown): Identity {
  const v = record(value);
  if (!uuid(v.taskId) || !uuid(v.conversationId) || !piSessionId(v.piSessionId)
      || !["main", "chat", "review"].includes(String(v.role))) throw new Error("Invalid Pi conversation identity");
  return { taskId: v.taskId, conversationId: v.conversationId, piSessionId: v.piSessionId, role: v.role as Role };
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.taskId === b.taskId && a.conversationId === b.conversationId
    && a.piSessionId === b.piSessionId && a.role === b.role;
}
export function parseOrientation(value: unknown): Orientation {
  const v = record(value);
  if (v.version !== 1) throw new Error("Unsupported Rexpi orientation version");
  return { version: 1, ...identity(v), ...(v.origin === undefined ? {} : { origin: identity(v.origin) }) };
}
export function restoreOrientation(entries: readonly unknown[], owner: string): Orientation | undefined {
  for (const raw of [...entries].reverse()) {
    const entry = record(raw);
    if (entry.type !== "custom" || entry.customType !== ORIENTATION_ENTRY) continue;
    const data = record(entry.data);
    // Forks/clones must not adopt their source conversation's identity.
    if (data.piSessionId !== owner) continue;
    return parseOrientation(data);
  }
}
export function rootOrientation(owner: string): Orientation {
  return parseOrientation({ version: 1, taskId: randomUUID(), conversationId: randomUUID(), piSessionId: owner, role: "main" });
}
export function childBootstrap(parent: Identity, related: boolean, role: "chat" | "review", server: Server): Bootstrap {
  return { version: 1, taskId: related ? parent.taskId : randomUUID(),
    conversationId: randomUUID(), piSessionId: randomUUID(), role,
    origin: identity(parent), serverInstance: server.instanceId };
}
export function encodeBootstrap(seed: Bootstrap): string {
  const value = { ...parseOrientation(seed), serverInstance: seed.serverInstance };
  if (!uuid(value.serverInstance)) throw new Error("Invalid Rex server instance");
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeBootstrap(raw: string): Bootstrap {
  if (raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("Invalid Rexpi bootstrap");
  const value = record(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  if (!uuid(value.serverInstance)) throw new Error("Invalid bootstrap server instance");
  return { ...parseOrientation(value), serverInstance: value.serverInstance };
}
export function cleanTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function isLive(binding: Binding, server: Server, now = Date.now(), alive = pidAlive): boolean {
  return binding.serverInstance === server.instanceId && binding.hostId === server.hostId
    && binding.expiresAt > now && binding.expiresAt <= now + LEASE_MS + 1000 && alive(binding.pid);
}
export function parseBinding(value: unknown): Binding {
  const v = record(value);
  if (v.version !== 1 || !uuid(v.serverInstance) || !uuid(v.hostId) || !rexId(v.blockId, "block")
      || !uuid(v.token) || !Number.isSafeInteger(v.pid) || Number(v.pid) <= 0
      || !Number.isSafeInteger(v.expiresAt)) throw new Error("Invalid Rexpi binding");
  return { version: 1, ...identity(v), ...(v.name === undefined ? {} : { name: parseAgentName(v.name) }),
    serverInstance: v.serverInstance, hostId: v.hostId, blockId: v.blockId, token: v.token,
    pid: Number(v.pid), expiresAt: Number(v.expiresAt) };
}
