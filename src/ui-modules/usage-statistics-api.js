import logger from '../utils/logger.js';
import { getRuntimeStorage } from '../storage/runtime-storage-registry.js';
import { getRequestBody } from '../utils/common.js';

const DEFAULT_EVENTS_PAGE_SIZE = 50;
const MAX_EVENTS_PAGE_SIZE = 500;
const MAX_EXPORT_EVENTS = 5000;

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function parseOptionalBoolean(value) {
    if (value === true || value === false) {
        return value;
    }

    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
        return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no') {
        return false;
    }

    return null;
}

function writeJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function writeError(res, statusCode, message, detail = null) {
    const payload = {
        error: {
            message
        }
    };

    if (detail) {
        payload.error.detail = detail;
    }

    writeJson(res, statusCode, payload);
    return true;
}

function resolveRuntimeStorage() {
    const runtimeStorage = getRuntimeStorage();
    if (!runtimeStorage) {
        throw new Error('Runtime storage is not initialized');
    }
    return runtimeStorage;
}

function parseUsageStatisticsQuery(req) {
    const host = req?.headers?.host || '127.0.0.1';
    const requestUrl = new URL(req?.url || '/', `http://${host}`);

    return {
        from: requestUrl.searchParams.get('from') || null,
        to: requestUrl.searchParams.get('to') || null,
        bucket: requestUrl.searchParams.get('bucket') || null,
        provider: requestUrl.searchParams.get('provider') || null,
        model: requestUrl.searchParams.get('model') || null,
        authType: requestUrl.searchParams.get('authType') || null,
        authSubjectHash: requestUrl.searchParams.get('authSubjectHash') || null,
        requestStatus: requestUrl.searchParams.get('status') || requestUrl.searchParams.get('requestStatus') || null,
        endpointType: requestUrl.searchParams.get('endpointType') || null,
        keyword: requestUrl.searchParams.get('keyword') || null,
        isStream: parseOptionalBoolean(requestUrl.searchParams.get('isStream')),
        sort: requestUrl.searchParams.get('sort') || 'desc',
        limit: parsePositiveInt(
            requestUrl.searchParams.get('limit'),
            DEFAULT_EVENTS_PAGE_SIZE,
            { min: 1, max: MAX_EVENTS_PAGE_SIZE }
        ),
        page: parsePositiveInt(requestUrl.searchParams.get('page'), 1, { min: 1, max: 100000 })
    };
}

function buildEventQueryOptions(query = {}) {
    const limit = parsePositiveInt(query.limit, DEFAULT_EVENTS_PAGE_SIZE, {
        min: 1,
        max: MAX_EVENTS_PAGE_SIZE
    });
    const page = parsePositiveInt(query.page, 1, { min: 1, max: 100000 });

    return {
        ...query,
        limit,
        offset: (page - 1) * limit
    };
}

function escapeCsvCell(value) {
    if (value === null || value === undefined) {
        return '';
    }

    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    if (!/[",\n]/.test(stringValue)) {
        return stringValue;
    }

    return `"${stringValue.replace(/"/g, '""')}"`;
}

function buildEventsCsv(rows = []) {
    const columns = [
        'occurredAt',
        'requestStatus',
        'toProvider',
        'providerUuid',
        'model',
        'endpointType',
        'isStream',
        'totalTokens',
        'promptTokens',
        'completionTokens',
        'estimatedCost',
        'currency',
        'latencyMs',
        'statusCode',
        'errorCode',
        'errorMessage',
        'authType',
        'authSubjectMask',
        'requestPath'
    ];

    const lines = [columns.join(',')];
    for (const row of rows) {
        lines.push(columns.map((column) => escapeCsvCell(row?.[column])).join(','));
    }

    return lines.join('\n');
}

export async function handleGetUsageStatisticsOverview(req, res) {
    try {
        const query = parseUsageStatisticsQuery(req);
        const runtimeStorage = resolveRuntimeStorage();

        if (typeof runtimeStorage.queryUsageStatisticsOverview !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const overview = await runtimeStorage.queryUsageStatisticsOverview(query);
        writeJson(res, 200, {
            data: overview
        });
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to load overview:', error);
        return writeError(res, 500, 'Failed to load usage statistics overview', error.message);
    }
}

export async function handleGetUsageStatisticsTrends(req, res) {
    try {
        const query = parseUsageStatisticsQuery(req);
        const runtimeStorage = resolveRuntimeStorage();

        if (typeof runtimeStorage.queryUsageStatisticsTrends !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const trends = await runtimeStorage.queryUsageStatisticsTrends(query);
        writeJson(res, 200, {
            data: trends
        });
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to load trends:', error);
        return writeError(res, 500, 'Failed to load usage statistics trends', error.message);
    }
}

export async function handleGetUsageStatisticsHeatmap(req, res) {
    try {
        const query = parseUsageStatisticsQuery(req);
        const runtimeStorage = resolveRuntimeStorage();

        if (typeof runtimeStorage.queryUsageStatisticsHeatmap !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const heatmap = await runtimeStorage.queryUsageStatisticsHeatmap(query);
        writeJson(res, 200, {
            data: heatmap
        });
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to load heatmap:', error);
        return writeError(res, 500, 'Failed to load usage statistics heatmap', error.message);
    }
}

export async function handleGetUsageStatisticsModelDimensions(req, res) {
    try {
        const query = parseUsageStatisticsQuery(req);
        const runtimeStorage = resolveRuntimeStorage();

        if (typeof runtimeStorage.queryUsageStatisticsDimensions !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const dimensions = await runtimeStorage.queryUsageStatisticsDimensions({
            ...query,
            dimension: 'models'
        });
        writeJson(res, 200, {
            data: dimensions
        });
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to load model dimensions:', error);
        return writeError(res, 500, 'Failed to load model statistics', error.message);
    }
}

export async function handleGetUsageStatisticsCredentialDimensions(req, res) {
    try {
        const query = parseUsageStatisticsQuery(req);
        const runtimeStorage = resolveRuntimeStorage();

        if (typeof runtimeStorage.queryUsageStatisticsDimensions !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const dimensions = await runtimeStorage.queryUsageStatisticsDimensions({
            ...query,
            dimension: 'credentials'
        });
        writeJson(res, 200, {
            data: dimensions
        });
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to load credential dimensions:', error);
        return writeError(res, 500, 'Failed to load credential statistics', error.message);
    }
}

export async function handleGetUsageStatisticsEvents(req, res) {
    try {
        const query = parseUsageStatisticsQuery(req);
        const runtimeStorage = resolveRuntimeStorage();

        if (typeof runtimeStorage.queryUsageStatisticsEvents !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const events = await runtimeStorage.queryUsageStatisticsEvents(buildEventQueryOptions(query));
        writeJson(res, 200, {
            data: events
        });
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to load events:', error);
        return writeError(res, 500, 'Failed to load usage statistics events', error.message);
    }
}

export async function handleExportUsageStatistics(req, res) {
    try {
        const host = req?.headers?.host || '127.0.0.1';
        const requestUrl = new URL(req?.url || '/', `http://${host}`);
        const format = String(requestUrl.searchParams.get('format') || 'csv').trim().toLowerCase();

        if (format !== 'csv' && format !== 'json') {
            return writeError(res, 400, 'Unsupported export format. Use csv or json.');
        }

        const query = parseUsageStatisticsQuery(req);
        const runtimeStorage = resolveRuntimeStorage();
        if (typeof runtimeStorage.queryUsageStatisticsEvents !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const exportLimit = parsePositiveInt(
            requestUrl.searchParams.get('exportLimit'),
            2000,
            { min: 1, max: MAX_EXPORT_EVENTS }
        );

        const events = await runtimeStorage.queryUsageStatisticsEvents({
            ...buildEventQueryOptions(query),
            limit: exportLimit,
            offset: 0,
            sort: 'desc'
        });

        const nowKey = new Date().toISOString().replace(/[:.]/g, '-');
        if (format === 'json') {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="usage-statistics-${nowKey}.json"`
            });
            res.end(JSON.stringify(events, null, 2));
            return true;
        }

        const csvContent = buildEventsCsv(events.items || []);
        res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="usage-statistics-${nowKey}.csv"`
        });
        res.end(csvContent);
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to export events:', error);
        return writeError(res, 500, 'Failed to export usage statistics', error.message);
    }
}

export async function handleGetUsageStatisticsPrices(req, res) {
    try {
        const runtimeStorage = resolveRuntimeStorage();
        if (typeof runtimeStorage.listUsageStatisticsModelPrices !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const prices = await runtimeStorage.listUsageStatisticsModelPrices();
        writeJson(res, 200, {
            data: prices
        });
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to list prices:', error);
        return writeError(res, 500, 'Failed to load model prices', error.message);
    }
}

export async function handlePutUsageStatisticsPrices(req, res) {
    try {
        const runtimeStorage = resolveRuntimeStorage();
        if (typeof runtimeStorage.upsertUsageStatisticsModelPrices !== 'function') {
            return writeError(res, 503, 'Usage statistics storage is unavailable');
        }

        const body = await getRequestBody(req);
        const inputPrices = Array.isArray(body)
            ? body
            : (Array.isArray(body?.prices) ? body.prices : []);
        const updatedBy = typeof body?.updatedBy === 'string' && body.updatedBy.trim()
            ? body.updatedBy.trim()
            : 'ui';

        if (inputPrices.length === 0) {
            return writeError(res, 400, 'Prices payload is required');
        }

        const prices = inputPrices.map((price) => ({
            ...price,
            updatedBy: price?.updatedBy || updatedBy
        }));

        const result = await runtimeStorage.upsertUsageStatisticsModelPrices(prices);
        writeJson(res, 200, {
            data: result
        });
        return true;
    } catch (error) {
        logger.error('[Usage Statistics API] Failed to update prices:', error);
        return writeError(res, 500, 'Failed to update model prices', error.message);
    }
}
