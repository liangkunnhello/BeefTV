import { App, Button, Form, Input, Popconfirm, Segmented, Select, Tooltip } from "antd";
import { Bug, Pencil, Plus, RefreshCw, Trash2, Workflow } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { ModelEditorModal } from "@/components/model-editor-modal";
import { ChannelHeadersEditor, validateChannelHeaders } from "@/components/channel-headers-editor";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { PageHeader } from "@/components/layout/workspace-page";
import { mergeFetchedChannelModelProfiles } from "@/lib/channel-model-catalog";
import { seedancePortraitModel } from "@/lib/seedance-portrait";
import { channelAdaptationLabel } from "@/lib/channel-adaptation";
import { ensureModelProfilesWithUiDefaults } from "@/lib/model-protocols";
import { fetchChannelModels, type ChannelModelFetchResult } from "@/services/api/image";
import { channelHasGenerationCredential, channelHasManagedBeefAPICredential, createModelChannel, defaultBaseUrlForApiFormat, filterModelsByCapability, isBuiltinBeefAPIChannel, modelOptionsFromChannels, normalizeConfigSnapshot, useConfigStore, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { ChannelModelSettings } from "./channel-model-settings";
import { ModelServiceEditor } from "./model-service-editor";
import { currentModelConnectionReceipt, useModelConnectionTests } from "@/stores/use-model-connection-tests";
import { ModelLogo } from "@/components/model-logo";
import beefTVAppIcon from "../../../../assets/app-icon.png";
import { MODEL_SERVICE_PRESETS, servicePresetFor } from "@/lib/model-service-presets";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { localWorkspaceConfig } from "@/lib/user-session";
import { getLocalModelConfig } from "@/services/api/workspace";
import { flushModelConfig, getModelConfigPersistenceState, subscribeModelConfigPersistence, type ModelConfigPersistenceState } from "@/services/model-config-repository";
import { beefAPIConnectionLabel, cancelBeefAPIConnection, disconnectBeefAPIConnection, getBeefAPIConnection, openBeefAPIWallet, startBeefAPIConnection, type BeefAPIConnectionSummary } from "@/services/api/beefapi-connection";

type UserChannelConnection = "openai" | "gemini";
type ChannelSettingsPaneProps = {
    onOpenDiagnostics?: () => void;
    onOpenModels?: () => void;
    onOpenRunningHub?: () => void;
};

export function ChannelSettingsPane({ onOpenDiagnostics, onOpenModels, onOpenRunningHub }: ChannelSettingsPaneProps) {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const localMode = workspaceCapabilities().local;
    const persistence = useSyncExternalStore(subscribeModelConfigPersistence, getModelConfigPersistenceState, getModelConfigPersistenceState);
    const [loadingChannelIds, setLoadingChannelIds] = useState<string[]>([]);
    const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
    const [newChannelId, setNewChannelId] = useState<string | null>(null);
    const [serviceEditor, setServiceEditor] = useState<ModelChannel | null | undefined>(undefined);
    const [beefConnection, setBeefConnection] = useState<BeefAPIConnectionSummary | null>(null);
    const [beefBusy, setBeefBusy] = useState(false);
    const appliedConnectionState = useRef<string | undefined>(undefined);
    const catalogSync = useRef<{ state: string; selection: string; adopt: boolean } | null>(null);
    const [catalogSyncFailed, setCatalogSyncFailed] = useState(false);

    const applyBeefConnection = async (summary: BeefAPIConnectionSummary, previousState = beefConnection?.state) => {
        setBeefConnection(summary);
        const retry = catalogSync.current?.state === summary.state ? catalogSync.current : null;
        if (appliedConnectionState.current === summary.state && !retry) return;
        appliedConnectionState.current = summary.state;
        if (!retry && !shouldRefreshBeefAPICatalog(previousState, summary.state)) {
            catalogSync.current = null;
            setCatalogSyncFailed(false);
            return;
        }
        const intent = retry || { state: summary.state, selection: useConfigStore.getState().config.assistantModel, adopt: summary.state === "connected" && Boolean(previousState && previousState !== "connected") };
        catalogSync.current = intent;
        try {
            const result = await getLocalModelConfig();
            if (catalogSync.current !== intent) return;
            const current = useConfigStore.getState().config;
            replaceConfig(localWorkspaceConfig(normalizeConfigSnapshot({
                config: mergeManagedBeefAPICatalog(current, result.config, intent.adopt && current.assistantModel === intent.selection),
            }).config));
            catalogSync.current = null;
            setCatalogSyncFailed(false);
        } catch {
            if (catalogSync.current === intent) setCatalogSyncFailed(true);
            // Keep the connection status even if the catalog refresh fails.
        }
    };

    useEffect(() => {
        let cancelled = false;
        void getBeefAPIConnection()
            .then((summary) => {
                if (!cancelled) void applyBeefConnection(summary, undefined);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (beefConnection?.state !== "pending" && beefConnection?.state !== "connecting") return;
        let active = true;
        const timer = window.setInterval(() => {
            void getBeefAPIConnection()
                .then((summary) => { if (active) void applyBeefConnection(summary, beefConnection?.state); })
                .catch(() => undefined);
        }, 2000);
        return () => { active = false; window.clearInterval(timer); };
    }, [beefConnection?.state]);

    const runBeefAction = async (action: () => Promise<BeefAPIConnectionSummary>, fallback: string) => {
        setBeefBusy(true);
        const previousConnection = beefConnection;
        const previousState = beefConnection?.state;
        try {
            const summary = await action();
            await applyBeefConnection(summary, previousState);
        } catch (error) {
            try {
                await applyBeefConnection(await getBeefAPIConnection(), previousState);
            } catch {
                setBeefConnection(previousConnection);
            }
            message.error(error instanceof Error ? error.message : fallback);
        } finally {
            setBeefBusy(false);
        }
    };
    const beginBeefConnection = () => {
        setBeefConnection({ state: "connecting", hasCredential: beefConnection?.hasCredential || false });
        return startBeefAPIConnection();
    };
    const retryBeefConnection = async () => {
        const state = beefConnection?.state;
        if (state === "expired" || state === "revoked" || state === "rejected") {
            await disconnectBeefAPIConnection();
        }
        return beginBeefConnection();
    };
    const userChannels = config.channels.filter((channel) => channel.scope !== "system");
    const runningHubReady = Boolean(config.runningHub.enabled && config.runningHub.baseUrl.trim() && config.runningHub.apiKey.trim() && config.runningHub.workflowId.trim());

    const updateChannels = (channels: ModelChannel[], baseConfig = config) => {
        replaceConfig(withChannels(baseConfig, channels));
    };

    const updateChannel = (id: string, patch: Partial<ModelChannel>) => {
        updateChannels(
            config.channels.map((channel) => {
                if (channel.id !== id) return channel;
                const models = patch.models ? uniqueModels(patch.models) : channel.models;
                const modelProfiles = patch.modelProfiles !== undefined
                    ? patch.modelProfiles
                    : patch.models && channel.scope !== "system"
                        ? ensureModelProfilesWithUiDefaults(models, channel.modelProfiles, [], channel.apiFormat)
                        : patch.models
                            ? channel.modelProfiles?.filter((item) => models.includes(item.model))
                            : channel.modelProfiles;
                return {
                    ...channel,
                    ...patch,
                    models,
                    modelProfiles,
                };
            }),
        );
    };

    const updateChannelConnection = (channel: ModelChannel, connection: UserChannelConnection) => {
        const apiFormat = connection;
        const defaultBaseUrl = defaultBaseUrlForApiFormat(apiFormat);
        const baseUrl = isKnownDefaultBaseUrl(channel.baseUrl) ? defaultBaseUrl : channel.baseUrl;
        // 渠道只负责连接类型；具体模型能力和请求协议由下方共享能力卡片维护。
        updateChannel(channel.id, { apiFormat, interfaceType: undefined, baseUrl });
    };

    const addChannel = () => {
        setServiceEditor(null);
    };

    const saveService = async (channel: ModelChannel) => {
        const latest = useConfigStore.getState().config;
        const channels = latest.channels.some((item) => item.id === channel.id)
            ? latest.channels.map((item) => item.id === channel.id ? channel : item)
            : [...latest.channels, channel];
        updateChannels(channels, latest);
        await flushModelConfig();
        const saved = getModelConfigPersistenceState();
        if (saved.status === "error" || saved.dirty) throw new Error(saved.error || "模型服务尚未保存，请重试");
        message.success("模型服务已保存，可在创作页选择模型");
    };

    const closeChannelEditor = () => {
        setEditingChannelId(null);
        setNewChannelId(null);
    };

    const deleteChannel = (id: string) => {
        const channel = config.channels.find((item) => item.id === id);
        if (channel?.scope === "system") {
            message.warning("系统渠道由管理员维护");
            return;
        }
        updateChannels(config.channels.filter((item) => item.id !== id));
    };

    const setChannelLoading = (id: string, loading: boolean) => {
        setLoadingChannelIds((items) => (loading ? Array.from(new Set([...items, id])) : items.filter((item) => item !== id)));
    };

    const refreshChannelModels = async (channel: ModelChannel) => {
        const connectionError = channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null);
        if (connectionError) {
            message.error(`${channel.name || "当前渠道"}：${connectionError}`);
            return;
        }
        setChannelLoading(channel.id, true);
        try {
            const result = await fetchChannelModels(channel, true);
            if (!result.models.length) {
                message.warning(`${channel.name || "当前渠道"}未返回模型，已保留现有手工模型`);
                return;
            }
            const latestConfig = useConfigStore.getState().config;
            const latestChannel = latestConfig.channels.find((item) => item.id === channel.id);
            if (!latestChannel) return;
            if (channelConnectionSignature(latestChannel) !== channelConnectionSignature(channel)) {
                message.warning(`${latestChannel.name || "当前渠道"}的连接配置已改变，已忽略旧的拉取结果`);
                return;
            }
            updateChannels(
                latestConfig.channels.map((item) => (item.id === channel.id ? applyFetchedChannelModelCatalog(item, result) : item)),
                latestConfig,
            );
            message.success(`${latestChannel.name || "当前渠道"}模型列表已更新`);
        } catch (error) {
            message.error(channelModelFetchErrorMessage(error));
        } finally {
            setChannelLoading(channel.id, false);
        }
    };

    const refreshAllModels = async () => {
        const runnable = userChannels.filter((channel) => !channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null));
        const skipped = userChannels.filter((channel) => channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null));
        if (!runnable.length) {
            const detail = skipped.map((channel) => `${channel.name || "未命名渠道"}：${channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null)}`).join("；");
            message.error(detail || "没有可拉取的个人模型渠道，请先填写有效 Base URL 和 API Key");
            return;
        }
        setChannelLoading("all", true);
        try {
            const results = await Promise.all(
                runnable.map(async (channel) => {
                    try {
                        const result = await fetchChannelModels(channel, true);
                        return { channel, result, error: "" };
                    } catch (error) {
                        return { channel, result: { models: [], catalog: [] }, error: error instanceof Error ? error.message : "读取失败" };
                    }
                }),
            );
            const latestConfig = useConfigStore.getState().config;
            const successful = results.filter((item) => {
                const latestChannel = latestConfig.channels.find((channel) => channel.id === item.channel.id);
                return Boolean(item.result.models.length && latestChannel && channelConnectionSignature(latestChannel) === channelConnectionSignature(item.channel));
            });
            const stale = results.filter((item) => {
                const latestChannel = latestConfig.channels.find((channel) => channel.id === item.channel.id);
                return Boolean(item.result.models.length && (!latestChannel || channelConnectionSignature(latestChannel) !== channelConnectionSignature(item.channel)));
            });
            const failed = results.filter((item) => !item.result.models.length);
            if (successful.length) {
                const resultMap = new Map(successful.map((item) => [item.channel.id, item.result] as const));
                updateChannels(
                    latestConfig.channels.map((channel) => {
                        const fetched = resultMap.get(channel.id);
                        return fetched ? applyFetchedChannelModelCatalog(channel, fetched) : channel;
                    }),
                    latestConfig,
                );
                message.success(`已更新 ${successful.length} 个渠道的模型`);
            }
            const warnings = [
                ...failed.map((item) => `${item.channel.name || "未命名渠道"}：${item.error || "未返回模型"}`),
                ...stale.map((item) => `${item.channel.name || "未命名渠道"}：连接配置已改变，已忽略旧结果`),
                ...skipped.map((channel) => `${channel.name || "未命名渠道"}：${channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null)}`),
            ];
            if (warnings.length) message.warning(`${warnings.join("；")}。未更新的渠道已保留原有模型列表`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量读取模型失败，原有模型列表未改动");
        } finally {
            setChannelLoading("all", false);
        }
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <PageHeader
                title={localMode ? "本地模型渠道" : "个人渠道"}
                actions={(
                    <div className="settings-pane-header-actions flex w-full gap-2 sm:w-auto sm:shrink-0">
                    {onOpenDiagnostics ? <Button className="h-10 flex-1 sm:h-8 sm:flex-none" icon={<Bug className="size-4" />} onClick={onOpenDiagnostics}>问题诊断</Button> : null}
                    <Button className="h-10 flex-1 sm:h-8 sm:flex-none" icon={<RefreshCw className="size-4" />} loading={loadingChannelIds.includes("all")} disabled={loadingChannelIds.some((id) => id !== "all")} onClick={() => void refreshAllModels()}>
                        更新目录
                    </Button>
                    <Button type="primary" className="h-10 flex-1 sm:h-8 sm:flex-none" icon={<Plus className="size-4" />} onClick={addChannel}>
                        添加模型服务
                    </Button>
                    </div>
                )}
            />
            {onOpenRunningHub ? (
                <section className="settings-section mb-3">
                    <div className="mb-3">
                        <h3 className="text-sm font-semibold">个人工作流渠道</h3>
                        <p className="mt-1 text-xs text-foreground/55">RunningHub 使用独立的云端工作流参数与执行通道。</p>
                    </div>
                    <div className="grid gap-2 lg:grid-cols-2">
                        {onOpenRunningHub ? (
                            <WorkflowChannelEntry
                                icon={<Workflow className="size-4" />}
                                title="RunningHub"
                                description="云端工作流和 RunningHub App"
                                status={runningHubReady ? `${config.runningHub.workflows.length} 个工作流已配置` : config.runningHub.enabled ? "待完成连接和工作流配置" : "未启用"}
                                ready={runningHubReady}
                                onOpen={onOpenRunningHub}
                            />
                        ) : null}
                    </div>
                </section>
            ) : null}
            {userChannels.length ? (
                <div className="settings-channel-list space-y-2">
                    {userChannels.map((channel) => {
                        const editing = editingChannelId === channel.id;
                        const builtinBeefAPI = isBuiltinBeefAPIChannel(channel);
                        const adaptationLabel = builtinBeefAPI ? `内置适配 · v${channel.presetVersion || 1}` : channelAdaptationLabel(channel);
                        return (
                            <section key={channel.id} aria-labelledby={`channel-${channel.id}-title`} className="settings-channel p-2.5 sm:p-3">
                                <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2.5">
                                    <div className="min-w-0 flex-1 basis-52">
                                        <h3 id={`channel-${channel.id}-title`} className="flex items-center gap-2 text-sm font-semibold">
                                            {builtinBeefAPI ? <img src={beefTVAppIcon} alt="" className="size-5 shrink-0 object-contain" draggable={false} /> : <ModelLogo icon={MODEL_SERVICE_PRESETS.find((preset) => preset.id === servicePresetFor(channel))?.icon} size={20} />}
                                            {builtinBeefAPI ? "BeefTV" : channel.name || "未命名渠道"}
                                        </h3>
                                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
                                            {builtinBeefAPI ? (
                                                <>
                                                    <span>已保存 {channel.models.length} 个模型</span>
                                                    <span>BeefTV 官方算力渠道，一键连接、开箱即用</span>
                                                </>
                                            ) : (
                                                <span>{channelProtocolLabel(channel)} · 已保存 {channel.models.length} 个模型</span>
                                            )}
                                            {adaptationLabel ? <span>应用{adaptationLabel}</span> : null}
                                            <ChannelStatus channel={channel} persistence={persistence} connection={builtinBeefAPI ? beefConnection : null} />
                                        </div>
                                    </div>
                                    <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto sm:shrink-0">
                                        {builtinBeefAPI && catalogSyncFailed ? <Button loading={beefBusy} onClick={() => void runBeefAction(getBeefAPIConnection, "无法更新模型列表")}>重试更新模型列表</Button> : null}
                                        {builtinBeefAPI ? (
                                            <BeefAPIConnectionActions
                                                connection={beefConnection}
                                                busy={beefBusy}
                                                onConnect={() => void runBeefAction(beginBeefConnection, "无法开始连接")}
                                                onCancel={() => void runBeefAction(cancelBeefAPIConnection, "无法取消连接")}
                                                onRetry={() => void runBeefAction(retryBeefConnection, "无法重新连接")}
                                                onDisconnect={() => void runBeefAction(disconnectBeefAPIConnection, "无法断开连接")}
                                                onWallet={() => {
                                                    void openBeefAPIWallet().catch((error) => message.error(error instanceof Error ? error.message : "无法打开 BeefTV 账户"));
                                                }}
                                            />
                                        ) : null}
                                        <Button
                                            className="h-10 sm:h-8"
                                            size="small"
                                            icon={<RefreshCw className="size-3.5" />}
                                            loading={loadingChannelIds.includes(channel.id)}
                                            disabled={loadingChannelIds.includes("all") || (builtinBeefAPI && beefConnection?.state !== "connected")}
                                            onClick={() => void refreshChannelModels(channel)}
                                        >
                                            拉取模型
                                        </Button>
                                        <Button
                                            size="small"
                                            icon={<Pencil className="size-3.5" />}
                                            onClick={() => {
                                                if (!builtinBeefAPI) { setServiceEditor(channel); return; }
                                                setNewChannelId(null);
                                                setEditingChannelId(channel.id);
                                            }}
                                        >
                                            编辑
                                        </Button>
                                        {!builtinBeefAPI ? (
                                            <Popconfirm title="删除个人模型渠道？" description="该渠道关联的模型选择会同时移除。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteChannel(channel.id)}>
                                                <Tooltip title="删除渠道">
                                                    <Button
                                                        className="size-10 p-0 sm:size-8"
                                                        aria-label={`删除渠道 ${channel.name || "未命名渠道"}`}
                                                        size="small"
                                                        type="text"
                                                        danger
                                                        disabled={loadingChannelIds.includes(channel.id) || loadingChannelIds.includes("all")}
                                                        icon={<Trash2 className="size-3.5" />}
                                                    />
                                                </Tooltip>
                                            </Popconfirm>
                                        ) : null}
                                    </div>
                                </div>
                                {editing && (
                                    <ModelEditorModal
                                        open
                                        title={channel.id === newChannelId ? "新增自定义渠道" : "编辑自定义渠道"}
                                        subtitle={channel.name}
                                        onClose={closeChannelEditor}
                                        footer={
                                            <div className="model-editor-footer">
                                                <span className="text-xs text-foreground/50">{localMode ? "更改实时保存到本地工作区" : "更改实时保存到云端渠道配置"}</span>
                                                <div className="model-editor-footer-actions">
                                                    <Button loading={loadingChannelIds.includes(channel.id)} onClick={() => void refreshChannelModels(channel)}>
                                                        拉取模型
                                                    </Button>
                                                    <Button onClick={closeChannelEditor}>完成</Button>
                                                </div>
                                            </div>
                                        }
                                    >
                                        <div className="model-editor-panel">
                                            <section className="model-editor-section">
                                                <div>
                                                    <h2>连接信息</h2>
                                                    <p className="mt-1 text-xs text-foreground/50">用于拉取模型目录并向当前渠道发起请求。</p>
                                                </div>
                                                <div className="model-editor-connection-fields grid gap-3 sm:grid-cols-2">
                                                    <Form.Item label="渠道名称" htmlFor={`channel-${channel.id}-name`} className="mb-0 sm:col-span-1">
                                                        <Input
                                                            id={`channel-${channel.id}-name`}
                                                            value={channel.name}
                                                            disabled={builtinBeefAPI}
                                                            placeholder="例如：我的 NewAPI"
                                                            onChange={(event) => updateChannel(channel.id, { name: event.target.value })}
                                                            onBlur={(event) => updateChannel(channel.id, { name: event.target.value.trim() || "未命名渠道" })}
                                                        />
                                                    </Form.Item>
                                                    <Form.Item label="目录连接类型" className="mb-0 sm:col-span-1" extra={builtinBeefAPI ? "应用内置适配" : "仅影响模型目录拉取。"}>
                                                        <Segmented<UserChannelConnection>
                                                            block
                                                            disabled={builtinBeefAPI}
                                                            value={channelConnectionMode(channel)}
                                                            options={[
                                                                { label: "OpenAI", value: "openai" },
                                                                { label: "Gemini", value: "gemini" },
                                                            ]}
                                                            onChange={(value) => updateChannelConnection(channel, value)}
                                                        />
                                                    </Form.Item>
                                                    <Form.Item label="Base URL" htmlFor={`channel-${channel.id}-base-url`} className="mb-0 sm:col-span-1">
                                                        <Input
                                                            id={`channel-${channel.id}-base-url`}
                                                            inputMode="url"
                                                            value={channel.baseUrl}
                                                            disabled={builtinBeefAPI}
                                                            placeholder={localMode ? "填写本地服务 Base URL" : "填写云端渠道 Base URL"}
                                                            onChange={(event) => updateChannel(channel.id, { baseUrl: event.target.value })}
                                                            onBlur={(event) => updateChannel(channel.id, { baseUrl: event.target.value.trim().replace(/\/+$/u, "") })}
                                                        />
                                                    </Form.Item>
                                                    {builtinBeefAPI ? (
                                                        <Form.Item label="账号连接" className="mb-0 sm:col-span-2">
                                                            <p className="m-0 text-sm leading-6 text-foreground/80">{beefAPIConnectionLabel(beefConnection)}</p>
                                                            {beefConnection?.balance === "zero" ? <p className="mt-1 text-xs leading-5 text-foreground/55">余额为 0 时仍可查看模型。生成时会提示余额不足。</p> : null}
                                                        </Form.Item>
                                                    ) : (
                                                        <>
                                                            <Form.Item label="API Key" htmlFor={`channel-${channel.id}-api-key`} className="mb-0 sm:col-span-1">
                                                                <Input.Password
                                                                    id={`channel-${channel.id}-api-key`}
                                                                    autoComplete="new-password"
                                                                    value={channel.apiKey}
                                                                    placeholder={channel.apiFormat === "gemini" ? "填写 Gemini API Key" : "填写当前渠道 API Key"}
                                                                    onChange={(event) => updateChannel(channel.id, { apiKey: event.target.value })}
                                                                    onBlur={(event) => updateChannel(channel.id, { apiKey: event.target.value.trim() })}
                                                                />
                                                            </Form.Item>
                                                            <Form.Item label="Secret Key（可选）" htmlFor={`channel-${channel.id}-secret-key`} className="mb-0 sm:col-span-1" extra="即梦等 AK/SK 协议需要；其他协议留空。">
                                                                <Input.Password
                                                                    id={`channel-${channel.id}-secret-key`}
                                                                    autoComplete="new-password"
                                                                    value={channel.secretKey || ""}
                                                                    placeholder="填写 Secret Key"
                                                                    onChange={(event) => updateChannel(channel.id, { secretKey: event.target.value })}
                                                                    onBlur={(event) => updateChannel(channel.id, { secretKey: event.target.value.trim() })}
                                                                />
                                                            </Form.Item>
                                                        </>
                                                    )}
                                                    <div className="sm:col-span-2">
                                                        <ChannelHeadersEditor value={channel.headers} onChange={(headers) => updateChannel(channel.id, { headers })} />
                                                    </div>
                                                </div>
                                            </section>
                                            <section className="model-editor-section">
                                                <div>
                                                    <h2>模型与能力</h2>
                                                    <p className="mt-1 text-xs text-foreground/50">维护渠道模型，并在单个模型中配置调用协议、能力和定价。</p>
                                                </div>
                                                <Form.Item label="模型列表" htmlFor={`channel-${channel.id}-models`} className="mb-0">
                                                    <Select
                                                        id={`channel-${channel.id}-models`}
                                                        mode="tags"
                                                        showSearch
                                                        allowClear
                                                        maxTagCount="responsive"
                                                        tokenSeparators={[",", "\n"]}
                                                        placeholder="输入模型名，或点击拉取模型"
                                                        value={channel.models}
                                                        onChange={(models) => updateChannel(channel.id, { models: uniqueModels(models) })}
                                                    />
                                                </Form.Item>
                                                <ChannelModelSettings channel={channel} onChange={(modelProfiles) => updateChannel(channel.id, { modelProfiles })} />
                                            </section>
                                        </div>
                                    </ModelEditorModal>
                                )}
                            </section>
                        );
                    })}
                </div>
            ) : (
                <WorkspaceState
                    icon="settings"
                    compact
                    title="连接你的第一个模型服务"
                    action={
                        <Button icon={<Plus className="size-4" />} onClick={addChannel}>
                            添加模型服务
                        </Button>
                    }
                />
            )}
            {serviceEditor !== undefined && <ModelServiceEditor initial={serviceEditor || undefined} onClose={() => setServiceEditor(undefined)} onSave={saveService} />}
        </Form>
    );
}

export function applyFetchedChannelModelCatalog(channel: ModelChannel, result: ChannelModelFetchResult): ModelChannel {
    const profiles = mergeFetchedChannelModelProfiles(channel, result.catalog);
    if (channel.id === "beefapi") return { ...channel, models: uniqueModels(result.models), modelProfiles: profiles };
    const existing = new Map((channel.modelProfiles || []).map((profile) => [profile.model, profile]));
    // Refresh updates the catalog without silently enabling new models or removing manual ones.
    return {
        ...channel,
        models: channel.models.length ? channel.models : uniqueModels(result.models),
        modelProfiles: profiles.map((profile) => {
            const previous = existing.get(profile.model);
            if (!previous) return profile;
            return seedancePortraitModel(profile.model) ? { ...previous, videoPricing: profile.videoPricing ?? null } : previous;
        }).concat((channel.modelProfiles || []).filter((profile) => !profiles.some((item) => item.model === profile.model))
            .map((profile) => seedancePortraitModel(profile.model) ? { ...profile, videoPricing: null } : profile)),
    };
}

function WorkflowChannelEntry({ icon, title, description, status, ready, onOpen }: { icon: ReactNode; title: string; description: string; status: string; ready: boolean; onOpen?: () => void }) {
    return (
        <div className="settings-channel flex min-w-0 items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-[var(--workspace-accent)]" aria-hidden="true">
                    {icon}
                </span>
                <div className="min-w-0">
                    <h4 className="text-sm font-semibold">{title}</h4>
                    <p className="mt-0.5 truncate text-xs text-foreground/55">{description}</p>
                    <span className={`settings-channel-status mt-1.5 ${ready ? "is-ready" : "is-warning"}`}>
                        <i aria-hidden="true" />
                        {status}
                    </span>
                </div>
            </div>
            <Button size="small" onClick={onOpen} disabled={!onOpen}>
                配置
            </Button>
        </div>
    );
}

export function channelValidationError(channel: ModelChannel, connection?: BeefAPIConnectionSummary | null) {
    return channelConnectionError(channel, connection) || validateChannelHeaders(channel.headers) || (!channel.models.length ? "请添加至少一个模型" : "");
}

export function isChannelReady(channel: ModelChannel) {
    return !channelValidationError(channel);
}

export function focusInvalidChannelField(channel: ModelChannel) {
    const baseUrlError = channelConnectionError({ ...channel, apiKey: "valid", secretKey: "valid" });
    const field = baseUrlError ? "base-url" : !channelHasGenerationCredential(channel) ? "api-key" : requiresSecretKey(channel) && !channel.secretKey?.trim() ? "secret-key" : "models";
    requestAnimationFrame(() => {
        const element = document.getElementById(`channel-${channel.id}-${field}`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
        element?.focus({ preventScroll: true });
    });
}

function ChannelStatus({ channel, persistence, connection }: { channel: ModelChannel; persistence: ModelConfigPersistenceState; connection?: BeefAPIConnectionSummary | null }) {
    const receipts = useModelConnectionTests((state) => state.receipts);
    const tested = channel.models.map((model) => currentModelConnectionReceipt(receipts, channel, model));
    const passed = tested.filter((result) => result?.success).length;
    const failed = tested.filter((result) => result && !result.success).length;
    const error = channelValidationError(channel, connection);
    const label = modelConfigChannelStatusLabel(channel, persistence, connection);
    const testLabel = failed ? `${failed} 个模型测试失败` : passed ? `${passed}/${channel.models.length} 个模型测试通过` : label;
    return (
        <span className={`settings-channel-status ${error || failed ? "is-warning" : "is-ready"}`}>
            <i aria-hidden="true" />
            {isBuiltinBeefAPIChannel(channel) ? label : error || (persistence.status === "saving" || persistence.status === "error" ? label : testLabel)}
        </span>
    );
}

export function shouldRefreshBeefAPICatalog(previous: string | undefined, next: string) {
    if (next === "connected" && previous !== "connected") return true;
    return next === "disconnected" && Boolean(previous) && previous !== "disconnected";
}

export function mergeManagedBeefAPICatalog(current: AiConfig, server: AiConfig, adoptAuthorizedAssistant = false): AiConfig {
    const serverBeef = server.channels.find((channel) => channel.id === "beefapi");
    let found = false;
    const channels = current.channels.map((channel) => {
        if (channel.id !== "beefapi") return channel;
        found = true;
        if (!serverBeef) {
            return { ...channel, models: [], modelProfiles: [], apiKey: "", secretKey: "", credentialRef: undefined, hasApiKey: false, hasSecretKey: false };
        }
        return {
            ...channel,
            models: [...(serverBeef.models || [])],
            modelProfiles: (serverBeef.modelProfiles || []).map((item) => ({ ...item })),
            apiKey: "",
            secretKey: "",
            credentialRef: serverBeef.credentialRef,
            hasApiKey: serverBeef.hasApiKey,
            hasSecretKey: serverBeef.hasSecretKey,
            baseUrl: serverBeef.baseUrl || channel.baseUrl,
        };
    });
    if (serverBeef && !found) {
        channels.unshift({
            ...serverBeef,
            apiKey: "",
            secretKey: "",
            models: [...(serverBeef.models || [])],
            modelProfiles: (serverBeef.modelProfiles || []).map((item) => ({ ...item })),
        });
    }
    return withChannels(adoptAuthorizedAssistant ? { ...current, assistantModel: server.assistantModel } : current, channels);
}

export function modelConfigChannelStatusLabel(channel: ModelChannel, persistence: ModelConfigPersistenceState, connection?: BeefAPIConnectionSummary | null) {
    if (isBuiltinBeefAPIChannel(channel)) {
        if (connection?.state === "connected") return beefAPIConnectionLabel(connection);
        if (connection?.state && connection.state !== "disconnected") return beefAPIConnectionLabel(connection);
        if (channelHasManagedBeefAPICredential(channel)) return "待确认连接";
        return "未连接";
    }
    if (!channelHasGenerationCredential(channel)) return "待配置";
    if (persistence.status === "saving") return "保存中";
    if (persistence.status === "error") return "保存失败";
    if (persistence.status === "saved") return "已保存 · 尚未测试";
    return "尚未测试";
}

export function BeefAPIConnectionActions({
    connection,
    busy,
    onConnect,
    onCancel,
    onRetry,
    onDisconnect,
    onWallet,
}: {
    connection: BeefAPIConnectionSummary | null;
    busy: boolean;
    onConnect: () => void;
    onCancel: () => void;
    onRetry: () => void;
    onDisconnect: () => void;
    onWallet: () => void;
}) {
    const state = connection?.state || "disconnected";
    const buttonClass = "h-10 sm:h-8";
    if (state === "connecting") {
        return <Button className={buttonClass} size="small" loading disabled>正在连接</Button>;
    }
    if (state === "pending") {
        return (
            <>
                <Button className={buttonClass} size="small" loading={busy} onClick={onCancel}>
                    取消
                </Button>
            </>
        );
    }
    if (state === "connected") {
        return (
            <>
                <Button className={buttonClass} size="small" onClick={onWallet}>
                    打开 BeefTV 账户
                </Button>
                <Button className={buttonClass} size="small" loading={busy} onClick={onDisconnect}>
                    断开连接
                </Button>
            </>
        );
    }
    if (state === "catalog_failed") {
        return (
            <>
                <Button className={buttonClass} size="small" type="primary" loading={busy} onClick={onRetry}>
                    重新连接
                </Button>
                <Button className={buttonClass} size="small" loading={busy} onClick={onDisconnect}>
                    断开连接
                </Button>
            </>
        );
    }
    if (state === "expired" || state === "revoked" || state === "rejected" || state === "store_error" || state === "connection_error" || state === "cancelled") {
        return (
            <Button className={buttonClass} size="small" type="primary" loading={busy} onClick={onRetry}>
                重新连接
            </Button>
        );
    }
    return (
        <Button className={buttonClass} size="small" type="primary" loading={busy} onClick={onConnect}>
            连接 BeefTV
        </Button>
    );
}

export function modelConfigChannelPresentation(channel: ModelChannel) {
    const builtin = isBuiltinBeefAPIChannel(channel);
    // 适配说明对所有命中适配预设的渠道都展示：BeefAPI 走内置适配，中转网关等走
    // lib/channel-adaptation.ts 里的声明式预设，用户能一眼看到「这条渠道被自动配过」。
    const adaptation = builtin ? `内置适配 · v${channel.presetVersion || 1}` : channelAdaptationLabel(channel);
    return {
        builtin,
        deletable: !builtin,
        adapterLabel: adaptation ? `应用${adaptation}` : "",
    };
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const models = modelOptionsFromChannels(channels);
    const imageModels = filterModelsByCapability(models, "image", channels);
    const videoModels = filterModelsByCapability(models, "video", channels);
    const textModels = filterModelsByCapability(models, "text", channels);
    const audioModels = filterModelsByCapability(models, "audio", channels);
    return {
        ...config,
        channels,
        models,
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: normalizeDefaultModel(config.imageModel, imageModels),
        videoModel: normalizeDefaultModel(config.videoModel, videoModels),
        textModel: normalizeDefaultModel(config.textModel, textModels),
        audioModel: normalizeDefaultModel(config.audioModel, audioModels),
    };
}

function normalizeDefaultModel(value: string, options: string[]) {
    return options.includes(value) ? value : options[0] || "";
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function channelModelFetchErrorMessage(error: unknown) {
    const detail = error instanceof Error ? error.message : "读取模型失败";
    if (detail.includes("不允许访问本机") || detail.includes("不允许访问保留地址")) return `${detail}；可信私网服务需由部署管理员配置 CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS`;
    return `${detail}；也可以直接在模型列表中手动输入模型名`;
}

function channelConnectionMode(channel: ModelChannel): UserChannelConnection {
    return channel.apiFormat === "gemini" ? "gemini" : "openai";
}

function channelConnectionError(channel: ModelChannel, connection?: BeefAPIConnectionSummary | null) {
    const baseUrl = channel.baseUrl.trim();
    if (!baseUrl) return "请填写 Base URL";
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Base URL 只支持 HTTP 或 HTTPS";
    } catch {
        return "Base URL 格式不正确";
    }
    if (isBuiltinBeefAPIChannel(channel)) {
        if (connection?.state === "connected" || channelHasManagedBeefAPICredential(channel)) return "";
        return "请先连接 BeefTV";
    }
    if (!channelHasGenerationCredential(channel)) return "请填写 API Key / Access Key";
    if (requiresSecretKey(channel) && !channel.secretKey?.trim()) return "当前协议需要填写 Secret Key";
    return "";
}

function channelConnectionSignature(channel: ModelChannel) {
    return [channel.baseUrl.trim(), channel.referenceAssetOrigin?.trim() || "", channel.apiKey.trim(), channel.secretKey?.trim() || "", channel.apiFormat, JSON.stringify(channel.headers || [])].join("\n");
}

function channelProtocolLabel(channel: ModelChannel) {
    return channelConnectionMode(channel) === "gemini" ? "Gemini 原生" : "OpenAI 兼容";
}

function isKnownDefaultBaseUrl(value: string) {
    const normalized = value.trim().replace(/\/+$/, "");
    if (!normalized) return true;
    return [defaultBaseUrlForApiFormat("openai"), defaultBaseUrlForApiFormat("gemini")].some((candidate) => candidate.replace(/\/+$/, "") === normalized);
}

function requiresSecretKey(channel: ModelChannel) {
    return channel.modelProfiles?.some((item) => item.protocol?.startsWith("volcengine-jimeng-")) === true;
}
