/**
 * @sab/decision-core 公开出口：只导出业务类型与服务类，不导出任何 secret store 实例。
 * apps/server 是唯一装配处（组合根）；control-core 不得依赖本包。
 */
export { BudgetMeter, BUDGET_DEFAULTS, MODEL_REQUEST_MS_RANGE, conservativeTokenReserve, synthesizeBudget } from './budget.js';
export type { BudgetCheck, BudgetDimension, BudgetSettlement, EffectiveBudget } from './budget.js';
export { systemClock } from './clock.js';
export type { Clock } from './clock.js';
export { ContextTokenStore, contextTokenHash } from './context-token.js';
export { evaluateCriteria, hasManualCriterion } from './completion.js';
export type { CompletionContext, CompletionEvaluation, FreshObservation } from './completion.js';
export { buildDecisionContext } from './context-builder.js';
export type { BuildContextInput, BuildContextResult } from './context-builder.js';
export { parseDecisionText } from './decision-parser.js';
export type { ParseResult, ParsedDecision as ParsedDecisionText } from './decision-parser.js';
export { validateDecisionEnvelope } from './decision-schema.js';
export { DecisionRunner } from './runner.js';
export type { RunnerDeps } from './runner.js';
export { MemoryStore } from './memory-store.js';
export type { AddMemoryInput, UpdateMemoryInput } from './memory-store.js';
export { recentMemories, searchMemories } from './memory-search.js';
export type { MemorySearchHit, MemorySearchRequest, MemorySearchResult } from './memory-search.js';
export { DecisionStore } from './store.js';
export type { DecisionEventRow, DecisionLogger, ObservationRow, RunRow, SlotInfo } from './store.js';
export { TaskService } from './task-service.js';
export type { Principal, RunnerControl, SubmitInput, TaskServiceOptions, UpdateInput } from './task-service.js';
export { TaskQueryService } from './task-query.js';
export type { TaskQueryOptions } from './task-query.js';
export {
    canTransitionStep,
    failureFingerprint,
    hasObservableProgress,
    StallDetector,
    STALL_FINGERPRINT_LIMIT,
    summarizeResidualWork
} from './progress.js';
export type { ProgressSignals, ResidualWork } from './progress.js';
export { internalOf, runPreflight } from './preflight.js';
export type { PreflightInput, PreflightOutcome } from './preflight.js';
export { EXECUTOR_SYSTEM_PROMPT, PLANNING_SYSTEM_PROMPT, PROMPT_VERSION, correctionSystemPrompt, promptPackHash } from './prompts.js';
export { createDecisionProvider } from './providers/factory.js';
export { ChatCompatibleProvider } from './providers/chat-compatible.js';
export { ResponsesProvider } from './providers/responses.js';
export { postJson, parseProviderBaseUrl, isAddressAllowed, PROVIDER_RESPONSE_MAX_BYTES } from './providers/http-client.js';
export type { JsonPostResponse, ProviderEndpointConfig } from './providers/http-client.js';
export { ProviderCallError } from './providers/types.js';
export type {
    DecisionFormat,
    DecisionProvider,
    MaxOutputParameter,
    ProviderCallRequest,
    ProviderCallResult,
    ProviderProfileConfig,
    ProviderProtocol,
    ProviderSecretAccess,
    ProviderUsage
} from './providers/types.js';
export {
    CUSTOM_POLICY_DENIED_TOOLS,
    NEVER_FOR_EXECUTOR,
    checkLocationAllowed,
    checkToolGuard,
    computeEffectiveTools,
    detectPolicyChanges,
    intersectPolicies,
    isWriteTool,
    rejectInjectedIdentityFields,
    tightenWithTask,
    validateCustomPolicyTools
} from './tool-policy.js';
export type { CustomPolicyCheck, EffectiveToolSet, GuardContext, GuardResult } from './tool-policy.js';
export {
    buildScopeKey,
    compareGameDate,
    isTransientEntityRef,
    issueTokenRecord,
    scopeFromWorldIdentity,
    snapshotMatchesScope,
    tokenIsUsable
} from './world-scope.js';
export type { ContextTokenRecord, DateChangeVerdict, ScopeInputs, TaskScopeRecord } from './world-scope.js';
export type {
    AuthzPort,
    DecisionEvent,
    DecisionPolicyView,
    DispatchWriteRequest,
    DispatchWriteResult,
    EventSinkPort,
    GamePort,
    ProviderResolverPort,
    ReadOnlyResult,
    ReceiptLookupPort,
    StartControlResult,
    ToolArgumentGuard
} from './ports.js';
export { canonicalHash, decodeCursor, encodeCursor, newActionId, newContextToken, newDecisionId, sha256Hex } from './ids.js';
export { hasLiveCrop, refreshActionArgs, toolForSlot, wateringTargets } from './game-observation.js';
