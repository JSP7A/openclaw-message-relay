import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { ErrorCodes, errorShape, callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { RelayService } from "./relay.js";
import { MessageStore, publicMessage } from "./store.js";
const identifier = /^[a-zA-Z0-9_-]{1,80}$/;
function requireIdentifier(value, name) {
    if (typeof value !== "string" || !identifier.test(value))
        throw new Error(`Invalid ${name}`);
    return value;
}
function requireCursor(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("Invalid cursor");
    return value;
}
export default definePluginEntry({
    id: "message-relay", name: "Message Relay",
    description: "Durable, device-scoped messaging for OpenClaw clients",
    register(api) {
        const config = api.pluginConfig;
        const agentId = config?.agentId === undefined ? "main" : config.agentId;
        if (typeof agentId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
            throw new Error("message-relay agentId must be an agent identifier");
        }
        const allowed = config?.allowedDeviceIds;
        if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)))) {
            throw new Error("message-relay allowedDeviceIds must be 64-hex device IDs");
        }
        const allowlist = allowed === undefined ? null : new Set(allowed);
        const store = new MessageStore(path.join(resolveStateDir(), "message-relay", "messages.sqlite"));
        const gateway = (method, params, timeoutMs, scope, signal) => callGatewayFromCli(method, { timeout: String(timeoutMs) }, params, { scopes: [scope], signal });
        const service = new RelayService(store, gateway, agentId, api.logger);
        service.start();
        api.lifecycle.registerRuntimeLifecycle({
            id: "message-relay-close", cleanup: () => service.close(),
        });
        const register = (method, scope, handler) => {
            api.registerGatewayMethod(method, async ({ client, params, respond }) => {
                const deviceId = client?.connect.device?.id;
                if (!deviceId || client?.invalidated || (allowlist && !allowlist.has(deviceId))) {
                    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Message Relay device not authorized"));
                    return;
                }
                try {
                    respond(true, handler(deviceId, params));
                }
                catch (error) {
                    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error instanceof Error ? error.message : "Invalid Message Relay request"));
                }
            }, { scope });
        };
        register("message-relay.capabilities", "operator.read", () => ({
            protocolVersion: 1, maxTextLength: 32_000, maxSyncPageSize: 100,
            features: ["durable-send", "device-isolation", "incremental-sync"],
        }));
        register("message-relay.send", "operator.write", (deviceId, params) => {
            const conversationId = requireIdentifier(params.conversationId, "conversationId");
            const messageId = requireIdentifier(params.messageId, "messageId");
            const text = params.text;
            if (typeof text !== "string" || !text.trim() || text.length > 32_000) {
                throw new Error("Message text must contain 1–32000 characters");
            }
            const row = store.enqueue(deviceId, conversationId, messageId, text);
            queueMicrotask(() => service.pump());
            return { message: publicMessage(row) };
        });
        register("message-relay.sync", "operator.read", (deviceId, params) => {
            const conversationId = requireIdentifier(params.conversationId, "conversationId");
            const after = requireCursor(params.after ?? 0);
            const limit = params.limit === undefined ? 100 : requireCursor(params.limit);
            if (limit < 1 || limit > 100)
                throw new Error("limit must be 1–100");
            return store.sync(deviceId, conversationId, after, limit);
        });
    },
});
