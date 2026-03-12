import { createHash, randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import { getRuntimeStorage } from '../storage/runtime-storage-registry.js';

const DEFAULT_FLUSH_BATCH_SIZE = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 1500;
const MAX_ERROR_MESSAGE_LENGTH = 500;

let queuedEvents = [];
let flushTimer = null;
let flushPromise = null;

function nowIso() {
    return new Date().toISOString();
}

function toSafeInt(value, fallback = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.max(0, Math.floor(numeric));
}

function normalizeString(value, fallback = null) {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
}

function sanitizeErrorMessage(message) {
    const normalized = normalizeString(message, null);
    if (!normalized) {
        return null;
    }

    const sanitized = normalized
        .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
        .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, 'sk-***')
        .replace(/\b(maki_[A-Za-z0-9]{8,})\b/g, 'maki_***')
        .replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=***');

    return sanitized.length > MAX_ERROR_MESSAGE_LENGTH
        ? sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH)
        : sanitized;
}

function buildMaskedSubject(subject) {
    const normalized = normalizeString(subject, null);
    if (!normalized) {
        return null;
    }

    if (normalized.length <= 10) {
        return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
    }

    return `${normalized.slice(0, 6)}***${normalized.slice(-4)}`;
}

function buildHashedSubject(subject) {
    const normalized = normalizeString(subject, null);
    if (!normalized) {
        return null;
    }

    return createHash('sha256').update(normalized).digest('hex');
}

function pickFirstDefinedNumber(candidates = []) {
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null || candidate === '') {
            continue;
        }
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric >= 0) {
            return Math.floor(numeric);
        }
    }
    return null;
}

function extractUsageMetricsFromUsageObject(usage = null) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    const promptTokens = pickFirstDefinedNumber([
        usage.prompt_tokens,
        usage.promptTokens,
        usage.input_tokens,
        usage.inputTokens,
        usage.prompt_token_count,
        usage.input_token_count,
        usage.promptTokenCount,
        usage.inputTokenCount
    ]);

    const completionTokens = pickFirstDefinedNumber([
        usage.completion_tokens,
        usage.completionTokens,
        usage.output_tokens,
        usage.outputTokens,
        usage.candidates_token_count,
        usage.output_token_count,
        usage.completionTokenCount,
        usage.outputTokenCount,
        usage.candidatesTokenCount
    ]);

    const totalTokens = pickFirstDefinedNumber([
        usage.total_tokens,
        usage.totalTokens,
        usage.total_token_count,
        usage.totalTokenCount
    ]);

    const cachedTokens = pickFirstDefinedNumber([
        usage.cached_tokens,
        usage.cachedTokens,
        usage.cached_token_count,
        usage.cachedContentTokenCount,
        usage.input_cached_tokens,
        usage.inputCachedTokens
    ]);

    const reasoningTokens = pickFirstDefinedNumber([
        usage.reasoning_tokens,
        usage.reasoningTokens,
        usage.thoughts_token_count,
        usage.thoughtsTokenCount,
        usage.output_tokens_details?.reasoning_tokens,
        usage.outputTokenDetails?.reasoningTokens
    ]);

    const hasAnyValue = [
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        reasoningTokens
    ].some((value) => value !== null);

    if (!hasAnyValue) {
        return null;
    }

    return {
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
        totalTokens: totalTokens ?? Math.max(0, (promptTokens ?? 0) + (completionTokens ?? 0)),
        cachedTokens: cachedTokens ?? 0,
        reasoningTokens: reasoningTokens ?? 0
    };
}

export function extractUsageMetricsFromPayload(payload = null) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const candidates = [
        payload.usage,
        payload.usageMetadata,
        payload.response?.usage,
        payload.response?.usageMetadata
    ];

    for (const usageCandidate of candidates) {
        const metrics = extractUsageMetricsFromUsageObject(usageCandidate);
        if (metrics) {
            return metrics;
        }
    }

    return null;
}

export function createUsageMetricsAccumulator() {
    return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        hasUsage: false
    };
}

export function mergeUsageMetrics(aggregate, metrics) {
    if (!aggregate || !metrics) {
        return aggregate;
    }

    aggregate.promptTokens += toSafeInt(metrics.promptTokens, 0);
    aggregate.completionTokens += toSafeInt(metrics.completionTokens, 0);
    aggregate.totalTokens += toSafeInt(metrics.totalTokens, 0);
    aggregate.cachedTokens += toSafeInt(metrics.cachedTokens, 0);
    aggregate.reasoningTokens += toSafeInt(metrics.reasoningTokens, 0);
    aggregate.hasUsage = true;
    return aggregate;
}

export function finalizeUsageMetrics(aggregate) {
    const source = aggregate && typeof aggregate === 'object' ? aggregate : createUsageMetricsAccumulator();
    const fallbackTotal = Math.max(0, source.promptTokens + source.completionTokens);
    const normalizedTotal = source.totalTokens > 0 ? source.totalTokens : fallbackTotal;

    return {
        promptTokens: toSafeInt(source.promptTokens, 0),
        completionTokens: toSafeInt(source.completionTokens, 0),
        totalTokens: toSafeInt(normalizedTotal, 0),
        cachedTokens: toSafeInt(source.cachedTokens, 0),
        reasoningTokens: toSafeInt(source.reasoningTokens, 0),
        usageIncomplete: source.hasUsage ? 0 : 1
    };
}

function normalizeUsageMetrics(metrics = null) {
    if (!metrics || typeof metrics !== 'object') {
        return finalizeUsageMetrics(createUsageMetricsAccumulator());
    }

    return {
        promptTokens: toSafeInt(metrics.promptTokens, 0),
        completionTokens: toSafeInt(metrics.completionTokens, 0),
        totalTokens: toSafeInt(metrics.totalTokens, 0),
        cachedTokens: toSafeInt(metrics.cachedTokens, 0),
        reasoningTokens: toSafeInt(metrics.reasoningTokens, 0),
        usageIncomplete: toSafeInt(metrics.usageIncomplete, 0) > 0 ? 1 : 0
    };
}

export function buildUsageStatisticsEvent(raw = {}) {
    const occurredAt = normalizeString(raw.occurredAt, null) || nowIso();
    const createdAt = normalizeString(raw.createdAt, null) || nowIso();
    const requestStatus = normalizeString(raw.requestStatus, 'error') || 'error';
    const usage = normalizeUsageMetrics(raw.usage);

    return {
        id: normalizeString(raw.id, null) || `usg_evt_${randomUUID().replace(/-/g, '')}`,
        occurredAt,
        createdAt,
        requestPath: normalizeString(raw.requestPath, null),
        endpointType: normalizeString(raw.endpointType, null),
        isStream: raw.isStream === true ? 1 : 0,
        fromProvider: normalizeString(raw.fromProvider, null),
        toProvider: normalizeString(raw.toProvider, null),
        providerUuid: normalizeString(raw.providerUuid, null),
        providerCustomName: normalizeString(raw.providerCustomName, null),
        model: normalizeString(raw.model, null),
        authType: normalizeString(raw.authType, null),
        authSubjectHash: normalizeString(raw.authSubjectHash, null),
        authSubjectMask: normalizeString(raw.authSubjectMask, null),
        requestStatus,
        statusCode: Number.isFinite(Number(raw.statusCode)) ? Number(raw.statusCode) : null,
        errorCode: normalizeString(raw.errorCode, null),
        errorMessage: sanitizeErrorMessage(raw.errorMessage),
        latencyMs: toSafeInt(raw.latencyMs, 0),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cachedTokens: usage.cachedTokens,
        reasoningTokens: usage.reasoningTokens,
        usageIncomplete: usage.usageIncomplete,
        metaJson: raw.meta && typeof raw.meta === 'object' ? JSON.stringify(raw.meta) : null
    };
}

export function buildUsageStatisticsAuthIdentity(config = {}) {
    const potluckApiKey = normalizeString(config?.potluckApiKey, null);
    if (potluckApiKey) {
        return {
            authType: 'potluck_api_key',
            authSubjectHash: buildHashedSubject(potluckApiKey),
            authSubjectMask: buildMaskedSubject(potluckApiKey)
        };
    }

    return {
        authType: null,
        authSubjectHash: null,
        authSubjectMask: null
    };
}

function scheduleFlush() {
    if (flushTimer) {
        return;
    }

    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushUsageStatisticsQueue();
    }, DEFAULT_FLUSH_INTERVAL_MS);

    if (typeof flushTimer.unref === 'function') {
        flushTimer.unref();
    }
}

export function enqueueUsageStatisticsEvent(event = {}) {
    const normalizedEvent = buildUsageStatisticsEvent(event);
    queuedEvents.push(normalizedEvent);

    if (queuedEvents.length >= DEFAULT_FLUSH_BATCH_SIZE) {
        void flushUsageStatisticsQueue();
        return;
    }

    scheduleFlush();
}

export async function flushUsageStatisticsQueue() {
    if (flushPromise) {
        return await flushPromise;
    }

    flushPromise = (async () => {
        if (queuedEvents.length === 0) {
            return { insertedCount: 0 };
        }

        const pending = queuedEvents;
        queuedEvents = [];

        const runtimeStorage = getRuntimeStorage();
        if (!runtimeStorage || typeof runtimeStorage.appendUsageStatisticsEvents !== 'function') {
            return { insertedCount: 0 };
        }

        try {
            const result = await runtimeStorage.appendUsageStatisticsEvents(pending);
            return {
                insertedCount: Number(result?.insertedCount || pending.length)
            };
        } catch (error) {
            logger.warn('[UsageStatistics] Failed to persist usage statistics batch:', error.message);
            return { insertedCount: 0 };
        }
    })();

    try {
        return await flushPromise;
    } finally {
        flushPromise = null;
    }
}

export function resetUsageStatisticsQueueForTests() {
    queuedEvents = [];
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    flushPromise = null;
}
