import { http } from "@/services/api/request";
import type { ModelProtocolDefinition, ProtocolCapability } from "@/lib/model-protocols";

type PluginProviderCatalogItem = {
    id: string;
    version: string;
    name: string;
    vendor: string;
    categories: string[];
    scopes: string[];
    create?: string;
    poll?: string;
    contentType?: string;
    enabled: boolean;
    unavailableReason?: string;
    baseUrl?: string;
    workflows?: Array<{
        id: string;
        label: string;
        providerId: string;
        capability: ProtocolCapability;
        parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>;
        defaults?: Record<string, string | number | boolean>;
    }>;
};

export async function fetchPluginProviderCatalog(scope: string, capability?: ProtocolCapability) {
    const builtinProtocols = () => BUILTIN_OPENAI_PROTOCOLS.filter((item) => !capability || item.capability === capability);
    // 协议目录来自后端插件运行时（含 Ark Task Gateway 等声明式协议）。
    // 本地桌面档同样必须问后端：后端会按可执行文件旁边的 plugin-packages/ 导入官方插件，
    // 早期版本在这里直接返回内置协议，导致插件协议在「模型与请求协议」里永远选不到。
    try {
        const result = await http.get<{ providers: PluginProviderCatalogItem[] }>("/plugins/catalog", { params: { scope, capability } });
        const providers = result.providers.filter((item) => item.enabled && !item.unavailableReason).map(toProviderDefinition);
        if (providers.length || scope !== "user.custom-channel") return providers;
    } catch (error) {
        // The local desktop profile can run without the optional plugin center.
        // Keep the built-in OpenAI-compatible protocols available so a custom
        // channel remains usable even when protocol metadata is unavailable.
        if (scope !== "user.custom-channel") throw error;
    }
    return builtinProtocols();
}

const BUILTIN_OPENAI_PROTOCOLS: ModelProtocolDefinition[] = [
    { value: "chat-completion", label: "OpenAI Chat Completions", vendor: "OpenAI", capability: "text", create: "POST /v1/chat/completions", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "openai-response", label: "OpenAI Responses", vendor: "OpenAI", capability: "text", create: "POST /v1/responses", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "openai-image", label: "OpenAI Images", vendor: "OpenAI", capability: "image", create: "POST /v1/images/generations", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "newapi", label: "OpenAI Videos", vendor: "OpenAI compatible", capability: "video", create: "POST /v1/videos", poll: "GET /v1/videos/{task_id}", contentType: "multipart/form-data", media: "内置协议", enabled: true },
];

function toProviderDefinition(item: PluginProviderCatalogItem): ModelProtocolDefinition {
    return {
        value: item.id,
        label: item.name,
        vendor: item.vendor,
        capability: (item.categories[0] || "text") as ProtocolCapability,
        create: item.create || "",
        poll: item.poll,
        contentType: item.contentType || "application/json",
        media: `${item.vendor} · ${item.version}`,
        enabled: item.enabled && !item.unavailableReason,
        baseUrl: item.baseUrl,
        workflows: item.workflows || [],
    };
}
