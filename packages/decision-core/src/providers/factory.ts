/** Provider 工厂：按配置的 protocol 选择适配器；未知协议显式失败，不静默兜底。 */
import type { DecisionProvider, ProviderProfileConfig, ProviderSecretAccess } from "./types.js";
import { ResponsesProvider } from "./responses.js";
import { ChatCompatibleProvider } from "./chat-compatible.js";

export function createDecisionProvider(cfg: ProviderProfileConfig, secrets: ProviderSecretAccess): DecisionProvider {
    switch (cfg.protocol) {
        case "openai-responses":
            return new ResponsesProvider(cfg, secrets);
        case "openai-chat-compatible":
            return new ChatCompatibleProvider(cfg, secrets);
        default:
            throw new Error("unsupported provider protocol: " + String((cfg as { protocol?: string }).protocol));
    }
}
