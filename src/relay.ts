import { createHash } from "node:crypto";
import type { MessageRow } from "./store.js";
import { MessageStore } from "./store.js";

export type GatewayMethod = "chat.send" | "agent.wait" | "chat.history";
export type GatewayCall = (method: GatewayMethod, params: Record<string, unknown>, timeoutMs: number, scope: "operator.read" | "operator.write", signal: AbortSignal) => Promise<unknown>;
export type RelayLogger = { warn(message: string): void };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function sessionKey(agentId: string, deviceId: string, conversationId: string): string {
  return `agent:${agentId}:message-relay-${digest(`${deviceId}:${conversationId}`)}`;
}
export function idempotencyKey(deviceId: string, messageId: string): string {
  return digest(`${deviceId}:${messageId}`);
}

function visibleText(entry: Record<string, unknown>): string {
  if (typeof entry.text === "string" && entry.text.trim()) return entry.text;
  const content = entry.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).filter(Boolean).join("\n");
}

export function replyForRun(history: unknown, runId: string): string | null {
  const messages = (history as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return null;
  const match = [...messages].reverse().find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Record<string, unknown>;
    const metadata = row.__openclaw as { runId?: unknown } | undefined;
    return row.role === "assistant" && metadata?.runId === runId;
  }) as Record<string, unknown> | undefined;
  return match ? visibleText(match) || null : null;
}

export class RelayService {
  static readonly maxConcurrentRuns = 4;
  private readonly active = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private readonly store: MessageStore, private readonly gateway: GatewayCall,
    private readonly agentId: string, private readonly logger: RelayLogger) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 5000);
    this.timer.unref();
    this.pump();
  }

  pump(): void {
    if (this.closed) return;
    for (const row of this.store.work()) {
      if (this.active.size >= RelayService.maxConcurrentRuns) break;
      const key = `${row.device_id}:${row.conversation_id}`;
      if (this.active.has(key)) continue;
      const job = this.deliver(row).finally(() => this.active.delete(key));
      this.active.set(key, job);
    }
  }

  private async deliver(initial: MessageRow): Promise<void> {
    let row = initial;
    const key = sessionKey(this.agentId, row.device_id, row.conversation_id);
    try {
      let runId = row.run_id;
      if (!runId) {
        const admitted = await this.gateway("chat.send", {
          sessionKey: key, message: row.text,
          idempotencyKey: idempotencyKey(row.device_id, row.message_id),
        }, 30_000, "operator.write", this.abort.signal) as { runId?: unknown };
        if (typeof admitted?.runId !== "string" || !admitted.runId) {
          throw new Error("chat.send did not return a run ID");
        }
        runId = admitted.runId;
        row = this.store.markAdmitted(row, runId);
      }
      const result = await this.gateway("agent.wait", { runId, timeoutMs: 90_000 },
        100_000, "operator.write", this.abort.signal) as { status?: unknown };
      if (result?.status === "timeout") {
        this.store.markRetry(row);
        return;
      }
      if (result?.status !== "ok") {
        this.store.markFailed(row, "Agent run did not complete successfully");
        return;
      }
      const history = await this.gateway("chat.history", { sessionKey: key, limit: 50 },
        30_000, "operator.read", this.abort.signal);
      const reply = replyForRun(history, runId);
      if (!reply) {
        this.store.markFailed(row, "Agent completed without a visible reply");
        return;
      }
      this.store.markDone(row, reply);
    } catch (error) {
      if (!this.closed) this.logger.warn(`Message Relay delivery retry scheduled for row ${row.seq}`);
      try { this.store.markRetry(row); }
      catch (storeError) { this.logger.warn(`Message Relay could not persist retry for row ${row.seq}: ${String(storeError)}`); }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await Promise.allSettled([...this.active.values()]);
    this.store.close();
  }
}
