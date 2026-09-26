import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export function publicMessage(row) {
    return {
        conversationId: row.conversation_id, messageId: row.message_id, text: row.text,
        status: row.status, reply: row.reply, error: row.error,
        createdAt: row.created_at, updatedAt: row.updated_at,
    };
}
export class MessageStore {
    db;
    static maxPendingPerDevice = 1000;
    constructor(databasePath) {
        mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(databasePath);
        this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        reply TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(device_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_seq INTEGER NOT NULL REFERENCES messages(seq),
        device_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS changes_sync ON changes(device_id, conversation_id, seq);
      CREATE INDEX IF NOT EXISTS messages_queue ON messages(status, next_attempt_at, seq);
    `);
    }
    close() { this.db.close(); }
    transaction(run) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const value = run();
            this.db.exec("COMMIT");
            return value;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    get(deviceId, messageId) {
        return this.db.prepare("SELECT * FROM messages WHERE device_id=? AND message_id=?")
            .get(deviceId, messageId);
    }
    enqueue(deviceId, conversationId, messageId, text, now = Date.now()) {
        return this.transaction(() => {
            const existing = this.get(deviceId, messageId);
            if (existing) {
                if (existing.conversation_id !== conversationId || existing.text !== text) {
                    throw new Error("messageId already used with different content");
                }
                return existing;
            }
            const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM messages
        WHERE device_id=? AND status IN ('queued','running','retry')`).get(deviceId);
            if (pending.count >= MessageStore.maxPendingPerDevice) {
                throw new Error("Device outbox is full; retry after earlier messages complete");
            }
            const inserted = this.db.prepare(`INSERT INTO messages
        (device_id,conversation_id,message_id,text,status,created_at,updated_at)
        VALUES (?,?,?,?,'queued',?,?)`).run(deviceId, conversationId, messageId, text, now, now);
            this.db.prepare("INSERT INTO changes(message_seq,device_id,conversation_id) VALUES (?,?,?)")
                .run(Number(inserted.lastInsertRowid), deviceId, conversationId);
            return this.get(deviceId, messageId);
        });
    }
    update(row, fields, now = Date.now()) {
        return this.transaction(() => {
            this.db.prepare(`UPDATE messages SET status=?, run_id=?, reply=?, error=?, attempts=?, next_attempt_at=?, updated_at=? WHERE seq=?`)
                .run(fields.status, fields.runId === undefined ? row.run_id : fields.runId, fields.reply === undefined ? row.reply : fields.reply, fields.error === undefined ? row.error : fields.error, fields.attempts ?? row.attempts, fields.nextAttemptAt ?? row.next_attempt_at, now, row.seq);
            this.db.prepare("INSERT INTO changes(message_seq,device_id,conversation_id) VALUES (?,?,?)")
                .run(row.seq, row.device_id, row.conversation_id);
            return this.get(row.device_id, row.message_id);
        });
    }
    markAdmitted(row, runId, now = Date.now()) {
        return this.update(row, { status: "running", runId, error: null, nextAttemptAt: now }, now);
    }
    markDone(row, reply, now = Date.now()) {
        return this.update(row, { status: "done", reply, error: null }, now);
    }
    markFailed(row, error, now = Date.now()) {
        return this.update(row, { status: "failed", error }, now);
    }
    markRetry(row, now = Date.now()) {
        const attempts = row.attempts + 1;
        const delay = Math.min(300_000, 5_000 * 2 ** Math.min(attempts - 1, 6));
        return this.update(row, { status: "retry", error: "Delivery temporarily unavailable", attempts, nextAttemptAt: now + delay }, now);
    }
    work(limit = 50, now = Date.now()) {
        return this.db.prepare(`SELECT m.* FROM messages m
      WHERE m.status IN ('queued','running','retry') AND m.next_attempt_at <= ?
        AND NOT EXISTS (SELECT 1 FROM messages earlier
          WHERE earlier.device_id=m.device_id AND earlier.conversation_id=m.conversation_id
            AND earlier.seq < m.seq AND earlier.status IN ('queued','running','retry'))
      ORDER BY m.seq LIMIT ?`).all(now, limit);
    }
    sync(deviceId, conversationId, after, limit = 100) {
        const rows = this.db.prepare(`SELECT c.seq AS cursor, m.* FROM changes c
      JOIN messages m ON m.seq=c.message_seq
      WHERE c.device_id=? AND c.conversation_id=? AND c.seq>?
      ORDER BY c.seq LIMIT ?`).all(deviceId, conversationId, after, limit + 1);
        const page = rows.slice(0, limit);
        return {
            changes: page.map((row) => ({ cursor: row.cursor, message: publicMessage(row) })),
            nextCursor: page.at(-1)?.cursor ?? after,
            hasMore: rows.length > limit,
        };
    }
}
