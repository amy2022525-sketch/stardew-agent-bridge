/**
 * “AI 任务助手”面板（§19）。
 *
 * 设计约束：
 * - 只用 textContent / DOM 节点，绝不把目标、记忆、模型回答或错误拼进 innerHTML。
 * - 进度只展示服务端已给出的数字：有计划的步骤才显示“已核对 N / M 步”，
 *   没有数据就显示“尚未核对”，不伪造百分比或“已浇 N 格”。
 * - 按钮可用状态来自服务端状态与 revision；不使用浏览器定时器猜测。
 * - 密钥只以 password 输入并在保存后清空，不写入任何浏览器持久层。
 */
import type {
    DecisionConfigView,
    DecisionStatusView,
    MemoryRecord,
    ProviderPublicView,
    TaskView
} from '@sab/contracts';
import { createDecisionApi, type ApiFn, type DecisionApiClient } from './decision-api.js';

const el = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`缺少面板元素 #${id}`);
    return node as T;
};

const STATE_LABEL: Record<string, string> = {
    queued: '正在检查游戏与权限',
    running: '执行模型正在工作',
    pausing: '正在停止',
    paused: '任务已暂停',
    waiting_main: '需要主模型处理 / 达到本次限制',
    needs_review: '游戏结果需要核对',
    completed: '任务已完成',
    failed: '本次任务失败',
    cancelled: '任务已取消'
};

const PHASE_LABEL: Record<string, string> = {
    preflight: '启动检查',
    planning: '拟定短计划',
    observing: '观察',
    thinking: '执行模型正在决定下一步',
    validating: '校验决策',
    acting: '正在执行游戏操作',
    verifying: '核对结果',
    reporting: '汇报',
    idle: '空闲'
};

export interface DecisionPanel {
    refresh(): Promise<void>;
}

export function setupDecisionPanel(request: ApiFn): DecisionPanel {
    const api: DecisionApiClient = createDecisionApi(request);
    let status: DecisionStatusView | null = null;
    let config: DecisionConfigView | null = null;
    let tasks: TaskView[] = [];
    let current: TaskView | null = null;
    let busy = false;
    let notice: string | null = null;
    let formInitialized = false;
    let selectedTaskId: string | null = null;
    let draftProfiles: { id: string; label: string }[] = [];
    let lastBootId: string | null = null;
    let refreshing = false;

    const nodes = {
        pill: el<HTMLElement>('decision-pill'),
        summary: el<HTMLElement>('decision-summary'),
        toggle: el<HTMLButtonElement>('btn-decision-toggle'),
        arm: el<HTMLButtonElement>('btn-decision-arm'),
        settingsOpen: el<HTMLButtonElement>('btn-decision-settings'),
        notice: el<HTMLElement>('decision-notice'),
        title: el<HTMLElement>('decision-task-title'),
        state: el<HTMLElement>('decision-task-state'),
        progress: el<HTMLElement>('decision-task-progress'),
        step: el<HTMLElement>('decision-task-step'),
        last: el<HTMLElement>('decision-task-last'),
        blocker: el<HTMLElement>('decision-blocker'),
        usage: el<HTMLElement>('decision-usage'),
        resume: el<HTMLButtonElement>('btn-task-resume'),
        pause: el<HTMLButtonElement>('btn-task-pause'),
        cancel: el<HTMLButtonElement>('btn-task-cancel'),
        takeover: el<HTMLButtonElement>('btn-task-takeover'),
        events: el<HTMLButtonElement>('btn-task-events'),
        eventsBox: el<HTMLElement>('decision-events'),
        tasks: el<HTMLElement>('decision-tasks'),
        memories: el<HTMLElement>('decision-memories'),
        resolveNote: el<HTMLInputElement>('decision-resolve-note'),
        accept: el<HTMLButtonElement>('btn-task-accept'),
        reject: el<HTMLButtonElement>('btn-task-reject'),
        profile: el<HTMLSelectElement>('decision-profile'),
        profileId: el<HTMLInputElement>('decision-profile-id'),
        profileLabel: el<HTMLInputElement>('decision-profile-label'),
        addProfile: el<HTMLButtonElement>('btn-decision-add-profile'),
        sharing: el<HTMLInputElement>('decision-sharing'),
        form: el<HTMLFormElement>('decision-form'),
        formNotice: el<HTMLElement>('decision-form-notice'),
        protocol: el<HTMLSelectElement>('decision-protocol'),
        baseUrl: el<HTMLInputElement>('decision-base-url'),
        model: el<HTMLInputElement>('decision-model'),
        authMode: el<HTMLSelectElement>('decision-auth-mode'),
        secret: el<HTMLInputElement>('decision-secret'),
        format: el<HTMLSelectElement>('decision-format'),
        policy: el<HTMLSelectElement>('decision-policy'),
        clients: el<HTMLInputElement>('decision-clients'),
        privateNet: el<HTMLInputElement>('decision-private'),
        http: el<HTMLInputElement>('decision-http'),
        budgetCalls: el<HTMLInputElement>('decision-budget-calls'),
        budgetActions: el<HTMLInputElement>('decision-budget-actions'),
        budgetMs: el<HTMLInputElement>('decision-budget-ms'),
        budgetTokens: el<HTMLInputElement>('decision-budget-tokens'),
        probe: el<HTMLButtonElement>('btn-decision-probe'),
        clearSecret: el<HTMLButtonElement>('btn-decision-clear-secret'),
        save: el<HTMLButtonElement>('btn-decision-save')
    };

    function setNotice(text: string | null): void {
        notice = text;
        nodes.notice.textContent = text ?? '';
    }

    function formNotice(text: string | null): void {
        nodes.formNotice.textContent = text ?? '';
    }

    function providerOf(view: DecisionConfigView): ProviderPublicView | null {
        return view.providers.find((provider) => provider.id === view.defaultProviderId) ?? view.providers[0] ?? null;
    }

    function fillKeyValues(target: HTMLElement, pairs: [string, string][]): void {
        target.replaceChildren();
        for (const [key, value] of pairs) {
            const dt = document.createElement('dt');
            dt.textContent = key;
            const dd = document.createElement('dd');
            dd.textContent = value;
            target.append(dt, dd);
        }
    }

    function renderProfileOptions(selected?: string): void {
        nodes.profile.replaceChildren();
        for (const profile of draftProfiles) {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = `${profile.label}（${profile.id}）`;
            nodes.profile.append(option);
        }
        const target = selected ?? nodes.profile.value;
        if (target && draftProfiles.some((profile) => profile.id === target)) nodes.profile.value = target;
    }

    function fillForm(): void {
        const cfg = config;
        if (!cfg) return;
        const provider = providerOf(cfg);
        nodes.protocol.value = provider?.protocol ?? 'openai-chat-compatible';
        nodes.baseUrl.value = provider?.baseUrl ?? '';
        nodes.model.value = provider?.model ?? '';
        nodes.authMode.value = provider?.authMode ?? 'none';
        nodes.format.value = provider?.decisionFormat ?? 'json_schema';
        nodes.privateNet.checked = provider?.allowPrivateNetwork ?? true;
        nodes.http.checked = provider?.allowPlainHttp ?? true;
        // 政策下拉以服务端返回的列表为准（含 cfg.json 手写的 custom 政策）。
        nodes.policy.replaceChildren();
        for (const policy of cfg.policies) {
            const option = document.createElement('option');
            option.value = policy.id;
            option.textContent = policy.builtin ? policy.label : `${policy.label}（自定义）`;
            nodes.policy.append(option);
        }
        if (cfg.policies.some((policy) => policy.id === cfg.defaultPolicyId)) {
            nodes.policy.value = cfg.defaultPolicyId;
        }
        draftProfiles = cfg.profiles.map((profile) => ({ ...profile }));
        renderProfileOptions(cfg.activeProfileId);
        nodes.sharing.checked = cfg.sharing.sharedTaskReadAcrossClients;
        nodes.clients.value = cfg.authorizedClientIds.join(',');
        nodes.budgetCalls.value = String(cfg.limits.maxModelCalls ?? 60);
        nodes.budgetActions.value = String(cfg.limits.maxWriteActions ?? 80);
        nodes.budgetMs.value = String(cfg.limits.maxActiveMs ?? 600000);
        nodes.budgetTokens.value = String(cfg.limits.maxAccountedTokens ?? 120000);
        nodes.secret.value = '';
    }

    function renderStatus(): void {
        const s = status;
        if (!s) return;
        nodes.pill.textContent = s.enabled ? '已启用' : '未启用';
        nodes.pill.classList.toggle('online', s.enabled);
        const provider = config ? providerOf(config) : null;
        fillKeyValues(nodes.summary, [
            ['执行模型', provider ? `${provider.label}（${provider.model}）` : '尚未配置'],
            ['配置状态', s.providerConfigured ? '已配置' : '待配置'],
            ['允许派单', config && config.authorizedClientIds.length > 0 ? config.authorizedClientIds.join('、') : '（无）'],
            ['操作范围', config?.policies.find((policy) => policy.id === s.defaultPolicyId)?.label ?? s.defaultPolicyId],
            ['存档分组', s.activeProfileId],
            ['人工停止锁', s.stopLatched ? `生效${s.stopReason ? `：${s.stopReason}` : ''}` : '未生效'],
            ['健康状态', s.health === 'ok' ? '正常' : s.health === 'disabled' ? '未启用' : `降级：${s.healthReason ?? '未知原因'}`]
        ]);
        nodes.toggle.textContent = s.enabled ? '停用' : '启用';
        nodes.toggle.disabled = busy;
        nodes.arm.disabled = busy || !s.stopLatched;
        nodes.settingsOpen.disabled = busy;
    }

    function renderTask(): void {
        const view = current;
        if (!view) {
            nodes.title.textContent = '没有进行中的自动任务。';
            nodes.state.textContent = '—';
            nodes.progress.textContent = '—';
            nodes.step.textContent = '—';
            nodes.last.textContent = '—';
            nodes.blocker.textContent = '';
            nodes.usage.textContent = '';
            nodes.resume.disabled = true;
            nodes.pause.disabled = true;
            nodes.cancel.disabled = true;
            nodes.takeover.disabled = true;
            nodes.events.disabled = true;
            nodes.accept.disabled = true;
            nodes.reject.disabled = true;
            nodes.eventsBox.classList.add('hidden');
            return;
        }
        const task = view.task;
        // 明确区分“哪个 Agent 派单”与“执行器在底层调用”，不伪称主模型完成了所有动作。
        const originLabel = view.origin.kind === 'web' ? 'Web 控制台' : view.origin.clientId;
        nodes.title.textContent = `${task.definition.title}（来源：${originLabel}）`;
        nodes.state.textContent = `${STATE_LABEL[task.state] ?? task.state}（${PHASE_LABEL[task.phase] ?? task.phase}）`;
        // Task criteria have machine evidence; natural-language plan steps do not.
        const plan = task.plan ?? [];
        const criteria = task.completion?.criterionResults ?? [];
        nodes.progress.textContent = criteria.length > 0
            ? `目标条件已核对 ${String(criteria.filter(result => result.status === 'met').length)} / ${String(criteria.length)} 条`
            : plan.length > 0 ? `计划共 ${String(plan.length)} 步（子步骤未单独核验）` : '尚未核对（无短计划）';
        const active = task.state === 'completed' || task.state === 'cancelled' ? undefined
            : plan.find((step) => step.status === 'active') ?? plan.find((step) => step.status === 'pending');
        nodes.step.textContent = active ? `${active.title}（${active.doneWhen}）` : '—';
        nodes.last.textContent = task.lastEvidenceSummary ?? '—';
        const blocker = task.blocker;
        nodes.blocker.textContent = blocker ? `卡点 ${blocker.code}：${blocker.summary}${view.unresolvedActionIds.length > 0 ? `；未决动作 ${view.unresolvedActionIds.join('、')}` : ''}` : '';
        const usage = task.budgetUsed;
        nodes.usage.textContent = [
            `模型请求 ${String(usage.modelCalls)} 次`,
            `写动作 ${String(usage.writeActions)} 次`,
            `用量 ${String(usage.accountedTokens)} token${usage.usageUnknown ? '（含未知用量保守预留，不是精确账单）' : ''}`,
            `运行 ${Math.round(usage.activeMs / 1000)} 秒`
        ].join(' | ');
        const live = task.state === 'running' || task.state === 'queued' || task.state === 'pausing';
        const canResume = (task.state === 'paused' || task.state === 'waiting_main')
            && view.unresolvedActionIds.length === 0 && status?.stopLatched !== true;
        nodes.resume.disabled = busy || !canResume;
        nodes.pause.disabled = busy || !live;
        nodes.cancel.disabled = busy || task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled';
        nodes.takeover.disabled = busy || !live;
        nodes.events.disabled = false;
        // 只有存在完成候选且没有未决动作时才能“接受完成”；拒绝只要求处于待处理状态。
        const actionable = task.state === 'needs_review' || task.state === 'waiting_main';
        nodes.accept.disabled = busy || !actionable || view.task.completion === null || view.unresolvedActionIds.length > 0;
        nodes.reject.disabled = busy || !actionable;
        if (view.task.completion) {
            nodes.blocker.textContent = `${nodes.blocker.textContent}${nodes.blocker.textContent ? '；' : ''}完成证据：${view.task.completion.evidenceLevel === 'verified_observation' ? '已用机器观察核对' : view.task.completion.evidenceLevel === 'main_reviewed' ? '主模型/玩家已审核' : '无'}（存档已写盘：${view.task.completion.worldSaved === 'saved' ? '是' : '未知'}）`;
        }
    }

    function renderList(): void {
        nodes.tasks.replaceChildren();
        if (tasks.length === 0) {
            const li = document.createElement('li');
            li.textContent = '（尚无任务记录）';
            nodes.tasks.append(li);
        }
        for (const view of tasks.slice(0, 12)) {
            const li = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'link-button';
            button.textContent = `${view.task.definition.title} · ${STATE_LABEL[view.task.state] ?? view.task.state}`;
            button.addEventListener('click', () => {
                selectedTaskId = view.task.taskId;
                current = view;
                renderTask();
            });
            li.append(button);
            nodes.tasks.append(li);
        }
    }

    function renderMemories(memories: MemoryRecord[]): void {
        nodes.memories.replaceChildren();
        if (memories.length === 0) {
            const li = document.createElement('li');
            li.textContent = '（当前作用域没有记忆）';
            nodes.memories.append(li);
            return;
        }
        for (const memory of memories) {
            const li = document.createElement('li');
            const title = document.createElement('strong');
            title.textContent = `${memory.title} `;
            const meta = document.createElement('span');
            meta.className = 'hint';
            meta.textContent = `[${memory.kind} / ${memory.sourceType} / ${memory.confidenceLabel}${memory.status === 'expired' ? ' / 已过期（历史）' : ''}] `;
            const body = document.createElement('span');
            body.textContent = memory.content.length > 160 ? `${memory.content.slice(0, 160)}…` : memory.content;
            li.append(title, meta, body);
            nodes.memories.append(li);
        }
    }

    async function refresh(): Promise<void> {
        // SSE、定时轮询与按钮回调可能同时触发刷新：只允许一个在途，避免旧响应覆盖新状态。
        if (busy || refreshing) return;
        refreshing = true;
        try {
            status = await api.status();
            if (lastBootId !== null && status.bootId !== lastBootId) {
                // Bridge 已重启：进程内 seq 不可比较，放弃旧选择并重新填表，靠全量状态恢复。
                selectedTaskId = null;
                formInitialized = false;
            }
            lastBootId = status.bootId;
            config = await api.config();
            const page = await api.listTasks(null, 20);
            tasks = page.tasks;
            const activeId = status.activeTaskId;
            const activeView = activeId ? await api.getTask(activeId).catch(() => null) : null;
            // 用户手选的历史任务在轮询期间保持不变；没有选择时才跟随活动任务。
            const selected = selectedTaskId ? tasks.find((item) => item.task.taskId === selectedTaskId) ?? null : null;
            current = activeView ?? selected ?? tasks[0] ?? null;
            if (current) selectedTaskId = current.task.taskId;
            renderStatus();
            renderTask();
            renderList();
            // 表单只在首次加载时填充：避免每 5 秒覆盖用户正在输入的内容。
            if (!formInitialized) {
                fillForm();
                formInitialized = true;
            }
            try {
                const memory = await api.listMemories(current?.task.taskId ?? null);
                renderMemories(memory.memories);
            } catch {
                renderMemories([]);
            }
            if (notice === null) nodes.notice.textContent = status.healthReason ?? '';
        } catch (error) {
            nodes.notice.textContent = `读取 AI 任务助手失败：${messageOf(error)}`;
        } finally {
            refreshing = false;
        }
    }

    async function withBusy(action: () => Promise<void>): Promise<void> {
        if (busy) return;
        busy = true;
        renderStatus();
        renderTask();
        try {
            await action();
        } catch (error) {
            setNotice(messageOf(error));
        } finally {
            busy = false;
            await refresh();
        }
    }

    function currentConfigPayload(enabled: boolean): Record<string, unknown> {
        if (!config) throw new Error('配置尚未加载。');
        const existing = providerOf(config);
        // 全新安装、尚未配置任何 provider 时，“停用”不应因为空地址而失败。
        if (!existing && !enabled && !nodes.baseUrl.value.trim() && !nodes.model.value.trim()) {
            return {
                enabled: false,
                defaultProviderId: null,
                providers: [],
                defaultPolicyId: config.defaultPolicyId,
                authorizedClientIds: config.authorizedClientIds,
                profiles: draftProfiles.length > 0 ? draftProfiles : config.profiles,
                activeProfileId: nodes.profile.value || config.activeProfileId,
                customPolicies: config.customPolicies ?? []
            };
        }
        const providerId = existing?.id ?? 'local-executor';
        const base: Record<string, unknown> = {
            id: providerId,
            label: existing?.label ?? '我的执行模型',
            protocol: nodes.protocol.value,
            baseUrl: nodes.baseUrl.value.trim(),
            model: nodes.model.value.trim(),
            authMode: nodes.authMode.value,
            secretRef: nodes.authMode.value === 'bearer' ? (existing?.secretRef ?? providerId) : null,
            decisionFormat: nodes.format.value,
            timeoutMs: existing?.timeoutMs ?? 30000,
            maxOutputTokens: existing?.maxOutputTokens ?? 2048,
            allowPrivateNetwork: nodes.privateNet.checked,
            allowPlainHttp: nodes.http.checked,
            // 未在表单中编辑的高级项原样保留，避免保存一次就丢配置。
            maxOutputParameter: existing?.maxOutputParameter ?? 'max_completion_tokens',
            supportsTemperature: existing?.supportsTemperature ?? false,
            temperature: existing?.temperature,
            supportsReasoning: existing?.supportsReasoning ?? false,
            reasoningEffort: existing?.reasoningEffort,
            secretFile: existing?.secretFile ?? null
        };
        const providers = existing
            ? config.providers.map((item) => (item.id === providerId ? { ...base } : stripProvider(item)))
            : [{ ...base }];
        return {
            enabled,
            defaultProviderId: providerId,
            defaultPolicyId: nodes.policy.value,
            providers,
            authorizedClientIds: nodes.clients.value.split(/[,，\s]+/).map((item) => item.trim()).filter((item) => item.length > 0),
            maxConcurrentTasks: 1,
            multiplayerAutomation: 'disabled',
            resumeAfterRestart: false,
            profiles: draftProfiles,
            activeProfileId: nodes.profile.value || config.activeProfileId,
            customPolicies: config.customPolicies ?? [],
            limits: {
                maxModelCalls: Number(nodes.budgetCalls.value) || config.limits.maxModelCalls,
                maxWriteActions: Number(nodes.budgetActions.value) || config.limits.maxWriteActions,
                maxActiveMs: Number(nodes.budgetMs.value) || config.limits.maxActiveMs,
                maxAccountedTokens: Number(nodes.budgetTokens.value) || config.limits.maxAccountedTokens,
                maxHttpAttempts: config.limits.maxHttpAttempts
            },
            sharing: { sharedTaskReadAcrossClients: nodes.sharing.checked },
            memory: config.memory
        };
    }

    function stripProvider(provider: ProviderPublicView): Record<string, unknown> {
        return {
            id: provider.id,
            label: provider.label,
            protocol: provider.protocol,
            // 视图已包含 baseUrl（Web 管理接口专用）：原样回写，避免保存一次就丢掉地址。
            baseUrl: provider.baseUrl,
            model: provider.model,
            authMode: provider.authMode,
            secretRef: provider.secretRef,
            decisionFormat: provider.decisionFormat,
            timeoutMs: provider.timeoutMs,
            maxOutputTokens: provider.maxOutputTokens,
            allowPrivateNetwork: provider.allowPrivateNetwork,
            allowPlainHttp: provider.allowPlainHttp,
            maxOutputParameter: provider.maxOutputParameter,
            supportsTemperature: provider.supportsTemperature,
            temperature: provider.temperature,
            supportsReasoning: provider.supportsReasoning,
            reasoningEffort: provider.reasoningEffort,
            secretFile: provider.secretFile
        };
    }

    function wire(): void {
        nodes.toggle.addEventListener('click', () => {
            void withBusy(async () => {
                if (!status || !config) return;
                const nextEnabled = !status.enabled;
                const provider = providerOf(config);
                if (nextEnabled && provider?.authMode === 'bearer' && !provider.hasSecret) {
                    setNotice('执行模型使用 Bearer 鉴权但尚未写入密钥：请先在设置中填写并保存密钥，再启用。');
                    return;
                }
                const view = await api.saveConfig(currentConfigPayload(nextEnabled), config.configRevision);
                setNotice(nextEnabled
                    ? '已启用。请确认执行模型与允许派单的 Agent 均正确；打开网页不会自动执行任务。'
                    : '已停用。历史任务与证据仍可查询，进行中的任务已暂停。');
                config = view;
            });
        });
        nodes.arm.addEventListener('click', () => {
            void withBusy(async () => {
                await api.arm();
                setNotice('已允许自动执行。旧任务仍需显式“继续”才会新开一轮。');
            });
        });
        nodes.settingsOpen.addEventListener('click', () => {
            const details = document.getElementById('decision-settings') as HTMLDetailsElement | null;
            if (details) details.open = true;
            nodes.baseUrl.focus();
        });
        nodes.form.addEventListener('submit', (event) => {
            event.preventDefault();
            void withBusy(async () => {
                if (!config) return;
                formNotice('正在保存…');
                if (nodes.authMode.value === 'bearer' && nodes.secret.value.trim().length > 0) {
                    const providerId = providerOf(config)?.id ?? 'local-executor';
                    await api.setSecret(providerId, nodes.secret.value.trim());
                    nodes.secret.value = '';
                }
                try {
                    const view = await api.saveConfig(currentConfigPayload(status?.enabled === true), config.configRevision);
                    config = view;
                    formNotice('已保存。保存设置本身没有调用模型服务。');
                    setNotice(null);
                } catch (error) {
                    const message = messageOf(error);
                    // 版本冲突时明确提示“未覆盖”，避免用户以为已保存。
                    if (/冲突|REVISION_CONFLICT/.test(message)) {
                        throw new Error('另一页已修改配置，请刷新后重试；本次没有覆盖对方的改动。');
                    }
                    throw error;
                }
            });
        });
        nodes.probe.addEventListener('click', () => {
            void withBusy(async () => {
                if (!config) return;
                const providerId = providerOf(config)?.id ?? 'local-executor';
                formNotice('正在检测（会真实发起一次模型请求，可能产生费用）…');
                const result = await api.probe(providerId);
                formNotice(result.ok
                    ? `检测通过：协议 ${result.protocol}，耗时 ${String(result.latencyMs)} ms，模型返回了有效 JSON。`
                    : `检测未通过：${result.error?.code ?? '未知错误'} ${result.error?.message ?? ''}（未执行任何游戏动作）`);
            });
        });
        nodes.clearSecret.addEventListener('click', () => {
            void withBusy(async () => {
                if (!config) return;
                const provider = providerOf(config);
                if (!provider) throw new Error('尚未配置执行模型。');
                await api.clearSecret(provider.id);
                nodes.secret.value = '';
                formNotice('已清除该 provider 的密钥，进行中的任务已暂停。');
            });
        });
        nodes.addProfile.addEventListener('click', () => {
            const id = nodes.profileId.value.trim();
            const label = nodes.profileLabel.value.trim() || id;
            if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id)) {
                formNotice('分组 ID 需以字母或数字开头，只能包含字母、数字、点、下划线、冒号或横线。');
                return;
            }
            if (draftProfiles.some((profile) => profile.id === id)) {
                formNotice('该分组 ID 已存在。');
                return;
            }
            draftProfiles.push({ id, label });
            renderProfileOptions(id);
            nodes.profileId.value = '';
            nodes.profileLabel.value = '';
            formNotice('已加入本地列表；点击“保存设置”后才会写入配置。');
        });
        nodes.accept.addEventListener('click', () => {
            void withBusy(async () => {
                if (!current) return;
                const note = nodes.resolveNote.value.trim() || '玩家在 Web 审核';
                const evidenceIds = current.task.completion?.criterionResults.flatMap((item) => item.evidenceIds) ?? [];
                await api.taskOperation(current.task.taskId, 'resolve', {
                    expectedRevision: current.task.definitionRevision,
                    resolution: 'accept_completion',
                    note,
                    evidenceIds
                });
                setNotice('已接受完成候选（证据级别 main_reviewed）；原动作收据未修改。');
            });
        });
        nodes.reject.addEventListener('click', () => {
            void withBusy(async () => {
                if (!current) return;
                const note = nodes.resolveNote.value.trim() || '玩家在 Web 拒绝完成候选';
                await api.taskOperation(current.task.taskId, 'resolve', {
                    expectedRevision: current.task.definitionRevision,
                    resolution: 'reject_completion',
                    note
                });
                setNotice('已拒绝完成候选；任务回到 waiting_main，可由主模型继续处理。');
            });
        });
        nodes.resume.addEventListener('click', () => {
            void withBusy(async () => {
                if (!current) return;
                await api.taskOperation(current.task.taskId, 'resume', { expectedRevision: current.task.definitionRevision });
                setNotice('已恢复：将使用新上下文重新观察，累计预算不会清零。');
            });
        });
        nodes.pause.addEventListener('click', () => {
            void withBusy(async () => {
                if (!current) return;
                await api.taskOperation(current.task.taskId, 'pause', { reason: 'web' });
                setNotice('已请求暂停：迟到的模型回答不会再派发动作。');
            });
        });
        nodes.cancel.addEventListener('click', () => {
            void withBusy(async () => {
                if (!current) return;
                await api.taskOperation(current.task.taskId, 'cancel', { reason: 'web' });
                setNotice('已取消后续执行；已经发生的动作不会被撤销。');
            });
        });
        nodes.takeover.addEventListener('click', () => {
            void withBusy(async () => {
                await request('/api/v1/control/takeover', { method: 'POST', body: JSON.stringify({ reason: 'web' }) });
                setNotice('已停止执行并接管控制权；请在“控制权”卡片继续人工操作。');
            });
        });
        nodes.events.addEventListener('click', () => {
            void withBusy(async () => {
                if (!current) return;
                const page = await api.events(current.task.taskId, 0);
                nodes.eventsBox.replaceChildren();
                const lines = page.events.map((event) => {
                    const payload = event.payload ? JSON.stringify(event.payload) : '';
                    return `${new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })} ${event.kind} ${payload}`;
                });
                nodes.eventsBox.textContent = lines.length > 0 ? lines.join('\n') : '（尚无事件）';
                nodes.eventsBox.classList.remove('hidden');
            });
        });
    }

    wire();
    return { refresh };
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
