import { showToast } from './utils.js';
import { getAuthHeaders } from './auth.js';

const DEFAULT_EVENTS_PAGE_SIZE = 20;
const HEALTH_HEATMAP_DAYS = 10;
const HEALTH_HEATMAP_VISIBLE_ROWS = 7;
const HEALTH_SLOT_MINUTES = 30;
const HEALTH_SLOTS_PER_HOUR = 60 / HEALTH_SLOT_MINUTES;
const HEALTH_SLOTS_PER_DAY = 24 * HEALTH_SLOTS_PER_HOUR;
const TOOLTIP_ELEMENT_ID = 'usageStatsTooltip';
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const usageStatsState = {
    initialized: false,
    active: false,
    loading: false,
    eventsPage: 1,
    eventsPageSize: DEFAULT_EVENTS_PAGE_SIZE,
    trendBucket: 'hour',
    tooltipBound: false,
    prices: []
};

function byId(id) {
    return document.getElementById(id);
}

function setText(element, text) {
    if (!element) {
        return;
    }
    element.textContent = text;
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('zh-CN');
}

function formatCompactNumber(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric)) {
        return '0';
    }

    if (Math.abs(numeric) >= 1000000) {
        return `${(numeric / 1000000).toFixed(Math.abs(numeric) >= 10000000 ? 0 : 1)}M`;
    }

    if (Math.abs(numeric) >= 1000) {
        return `${(numeric / 1000).toFixed(Math.abs(numeric) >= 10000 ? 0 : 1)}K`;
    }

    return `${Math.round(numeric)}`;
}

function formatPercent(value) {
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function formatCurrency(value, currency = 'USD') {
    const amount = Number(value || 0);
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency || 'USD',
            maximumFractionDigits: 4
        }).format(amount);
    } catch {
        return `${currency || 'USD'} ${amount.toFixed(4)}`;
    }
}

function formatDateTime(value) {
    if (!value) {
        return '--';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return '--';
    }

    return parsed.toLocaleString();
}

function formatDateShort(value) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return "--";
    }

    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return month + "/" + day;
}

function formatMonthDayTime(value) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return "--";
    }

    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    const hour = String(parsed.getHours()).padStart(2, "0");
    const minute = String(parsed.getMinutes()).padStart(2, "0");
    return month + "/" + day + " " + hour + ":" + minute;
}

function formatHourMinute(value) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return "--";
    }

    const hour = String(parsed.getHours()).padStart(2, "0");
    const minute = String(parsed.getMinutes()).padStart(2, "0");
    return hour + ":" + minute;
}

function formatDateKey(value) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatHeatmapInterval(startAt, endAt) {
    const start = startAt instanceof Date ? startAt : new Date(startAt);
    const end = endAt instanceof Date ? endAt : new Date(endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return "--";
    }

    const sameDay = formatDateKey(start) === formatDateKey(end);
    if (sameDay) {
        return formatMonthDayTime(start) + " - " + formatHourMinute(end);
    }

    return formatMonthDayTime(start) + " - " + formatMonthDayTime(end);
}

function formatBucketLabel(value, bucket = usageStatsState.trendBucket) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return String(value || '--');
    }

    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    const hour = String(parsed.getHours()).padStart(2, '0');

    if (bucket === 'day') {
        return `${month}/${day}`;
    }

    return `${month}/${day} ${hour}:00`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

function escapeAttribute(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function setCustomRangeVisibility() {
    const rangeSelect = byId('usageStatsRange');
    const customRange = byId('usageStatsCustomRange');
    if (!rangeSelect || !customRange) {
        return;
    }

    customRange.style.display = rangeSelect.value === 'custom' ? 'flex' : 'none';
}

function syncBucketSwitchUI() {
    const bucketSelect = byId('usageStatsBucket');
    const currentBucket = bucketSelect?.value === 'day' ? 'day' : 'hour';
    usageStatsState.trendBucket = currentBucket;

    const buttons = byId('usageStatsBucketSwitch')?.querySelectorAll('button[data-bucket]') || [];
    buttons.forEach((button) => {
        const isActive = button.dataset.bucket === currentBucket;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

function setTrendBucket(bucket) {
    const normalizedBucket = bucket === 'day' ? 'day' : 'hour';
    const bucketSelect = byId('usageStatsBucket');
    if (bucketSelect) {
        bucketSelect.value = normalizedBucket;
    }
    usageStatsState.trendBucket = normalizedBucket;
    syncBucketSwitchUI();
}

function resolveTimeRange() {
    const rangeSelect = byId('usageStatsRange');
    const customFrom = byId('usageStatsFrom');
    const customTo = byId('usageStatsTo');
    const selectedRange = rangeSelect?.value || '24h';

    const now = new Date();
    let from = null;
    let to = now.toISOString();

    if (selectedRange === '7d') {
        from = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000)).toISOString();
    } else if (selectedRange === '30d') {
        from = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000)).toISOString();
    } else if (selectedRange === 'custom') {
        const fromValue = customFrom?.value ? new Date(customFrom.value).toISOString() : null;
        const toValue = customTo?.value ? new Date(customTo.value).toISOString() : null;
        if (fromValue && toValue) {
            from = fromValue;
            to = toValue;
        } else {
            from = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();
        }
    } else {
        from = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();
    }

    return { from, to };
}

function buildCommonParams(includeBucket = true, includeEventFilters = true) {
    const params = new URLSearchParams();
    const { from, to } = resolveTimeRange();
    const bucket = byId('usageStatsBucket')?.value || usageStatsState.trendBucket || 'hour';

    params.set('from', from);
    params.set('to', to);
    if (includeBucket) {
        params.set('bucket', bucket);
    }

    if (includeEventFilters) {
        const statusFilter = byId('usageStatsEventsStatus')?.value || '';
        const keywordFilter = byId('usageStatsEventsKeyword')?.value?.trim() || '';
        if (statusFilter) {
            params.set('status', statusFilter);
        }
        if (keywordFilter) {
            params.set('keyword', keywordFilter);
        }
    }

    return params;
}

function buildServiceHealthParams() {
    const params = new URLSearchParams();
    const to = new Date();
    const from = new Date(to);
    from.setDate(to.getDate() - (HEALTH_HEATMAP_DAYS - 1));
    from.setHours(0, 0, 0, 0);

    params.set('from', from.toISOString());
    params.set('to', to.toISOString());

    return params;
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...getAuthHeaders(),
            ...(options.headers || {})
        }
    });

    if (response.status === 401) {
        window.location.href = '/login.html';
        throw new Error('未授权');
    }

    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
            const errorPayload = await response.json();
            if (errorPayload?.error?.message) {
                message = errorPayload.error.message;
            }
        } catch {
            // ignore parse failure
        }
        throw new Error(message);
    }

    const payload = await response.json();
    return payload?.data ?? payload;
}

function setUsageStatsLoading(loading) {
    usageStatsState.loading = loading;
    const loadingElement = byId('usageStatsLoading');
    const refreshBtn = byId('usageStatsRefreshBtn');

    if (loadingElement) {
        loadingElement.style.display = loading ? 'flex' : 'none';
    }

    if (refreshBtn) {
        refreshBtn.disabled = loading;
        refreshBtn.classList.toggle('is-loading', loading);
    }
}

function showUsageStatsError(message) {
    const errorElement = byId('usageStatsError');
    if (!errorElement) {
        return;
    }

    if (!message) {
        errorElement.style.display = 'none';
        errorElement.textContent = '';
        return;
    }

    errorElement.style.display = 'block';
    errorElement.textContent = message;
}

function ensureUsageStatsTooltip() {
    let tooltip = byId(TOOLTIP_ELEMENT_ID);
    if (tooltip) {
        return tooltip;
    }

    tooltip = document.createElement('div');
    tooltip.id = TOOLTIP_ELEMENT_ID;
    tooltip.className = 'usage-stats-tooltip';
    document.body.appendChild(tooltip);
    return tooltip;
}

function hideUsageStatsTooltip() {
    const tooltip = byId(TOOLTIP_ELEMENT_ID);
    if (!tooltip) {
        return;
    }

    tooltip.classList.remove('visible');
}

function showUsageStatsTooltip(target, event) {
    if (!target || !(event instanceof MouseEvent || event instanceof PointerEvent)) {
        return;
    }

    const interval = target.getAttribute('data-tooltip-interval');
    if (interval) {
        const success = target.getAttribute('data-tooltip-success') || '0';
        const error = target.getAttribute('data-tooltip-error') || '0';
        const rate = target.getAttribute('data-tooltip-rate') || '0.0';
        const logInfo = target.getAttribute('data-tooltip-log') || '';
        const tooltip = ensureUsageStatsTooltip();

        const logHtml = logInfo
            ? `<div class="usage-stats-tooltip-log">日志: ${escapeHtml(logInfo)}</div>`
            : '';

        tooltip.innerHTML = `
            <div class="usage-stats-tooltip-title">${escapeHtml(interval)}</div>
            <div class="usage-stats-tooltip-row">
                <span class="usage-stats-tooltip-icon success">✓</span>
                <span class="usage-stats-tooltip-value">${escapeHtml(success)}</span>
                <span class="usage-stats-tooltip-icon error">✕</span>
                <span class="usage-stats-tooltip-value">${escapeHtml(error)}</span>
                <span class="usage-stats-tooltip-rate">${escapeHtml(rate)}%</span>
            </div>
            ${logHtml}
        `;
        tooltip.style.left = `${event.clientX}px`;
        tooltip.style.top = `${event.clientY - 8}px`;
        tooltip.classList.add('visible');
        return;
    }
    const raw = target.getAttribute('data-tooltip');
    if (!raw) {
        hideUsageStatsTooltip();
        return;
    }

    const tooltip = ensureUsageStatsTooltip();
    tooltip.innerHTML = escapeHtml(raw).replace(/\n/g, '<br>');
    tooltip.style.left = `${event.clientX}px`;
    tooltip.style.top = `${event.clientY - 8}px`;
    tooltip.classList.add('visible');
}

function bindUsageStatsTooltip() {
    if (usageStatsState.tooltipBound) {
        return;
    }

    const section = byId('usage-statistics');
    if (!section) {
        return;
    }

    ensureUsageStatsTooltip();

    section.addEventListener('pointermove', (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-tooltip], [data-tooltip-interval]') : null;
        if (!target) {
            hideUsageStatsTooltip();
            return;
        }
        showUsageStatsTooltip(target, event);
    });

    section.addEventListener('pointerleave', () => {
        hideUsageStatsTooltip();
    });

    section.addEventListener('scroll', () => {
        hideUsageStatsTooltip();
    }, true);

    usageStatsState.tooltipBound = true;
}

function renderOverview(overview = {}) {
    const container = byId('usageStatsOverviewCards');
    if (!container) {
        return;
    }

    const cards = [
        { label: '总请求数', value: formatNumber(overview.totalRequests) },
        { label: '总 Token 数', value: formatNumber(overview.totalTokens) },
        { label: '错误率', value: formatPercent(overview.errorRate) },
        { label: '预估成本', value: formatCurrency(overview.totalCost) },
        { label: 'RPM', value: Number(overview.rpm || 0).toFixed(2) },
        { label: 'TPM', value: Number(overview.tpm || 0).toFixed(2) },
        { label: '平均延迟', value: `${Number(overview.avgLatencyMs || 0).toFixed(0)} ms` },
        { label: '用量缺失数', value: formatNumber(overview.usageIncompleteCount) }
    ];

    container.innerHTML = cards.map((card) => `
        <div class="usage-stats-overview-item">
            <div class="label">${escapeHtml(card.label)}</div>
            <div class="value">${escapeHtml(card.value)}</div>
        </div>
    `).join('');
}

function buildLinearTrendPath(points = []) {
    return points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
        .join(' ');
}

function buildSmoothTrendPath(points = []) {
    if (!Array.isArray(points) || points.length < 3) {
        return buildLinearTrendPath(points);
    }

    const tension = 1;
    let path = `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;

    for (let index = 0; index < points.length - 1; index += 1) {
        const prev = points[index - 1] || points[index];
        const current = points[index];
        const next = points[index + 1];
        const afterNext = points[index + 2] || next;

        const cp1x = current.x + (((next.x - prev.x) / 6) * tension);
        const cp1y = current.y + (((next.y - prev.y) / 6) * tension);
        const cp2x = next.x - (((afterNext.x - current.x) / 6) * tension);
        const cp2y = next.y - (((afterNext.y - current.y) / 6) * tension);

        path += ` C${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
    }

    return path;
}

function collectTrendTimeTicks(minMs, maxMs, bucket = usageStatsState.trendBucket) {
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
        return [];
    }

    const range = Math.max(0, maxMs - minMs);
    const intervalMs = bucket === 'hour'
        ? 2 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;

    const ticks = [];
    const firstTick = Math.ceil(minMs / intervalMs) * intervalMs;

    for (let tick = firstTick; tick <= maxMs; tick += intervalMs) {
        ticks.push(tick);
    }

    const allTicks = [...new Set([minMs, ...ticks, maxMs])].sort((a, b) => a - b);
    return allTicks.map((timeMs) => ({
        timeMs,
        ratio: range > 0 ? (timeMs - minMs) / range : 0
    }));
}

function formatTrendTickLabel(timeMs, bucket, previousMs = null) {
    const parsed = new Date(timeMs);
    if (Number.isNaN(parsed.getTime())) {
        return '--';
    }

    if (bucket === 'day') {
        return formatDateShort(parsed);
    }

    const hourText = `${String(parsed.getHours()).padStart(2, '0')}:00`;

    if (!Number.isFinite(previousMs)) {
        return `${formatDateShort(parsed)} ${hourText}`;
    }

    const previous = new Date(previousMs);
    const isDifferentDay = previous.getFullYear() !== parsed.getFullYear()
        || previous.getMonth() !== parsed.getMonth()
        || previous.getDate() !== parsed.getDate();

    return isDifferentDay ? `${formatDateShort(parsed)} ${hourText}` : hourText;
}

function buildTrendChartSvg(points = [], config = {}) {
    const chartWidth = 760;
    const chartHeight = 220;
    const padding = {
        top: 16,
        right: 14,
        bottom: 30,
        left: 44
    };
    const plotWidth = chartWidth - padding.left - padding.right;
    const plotHeight = chartHeight - padding.top - padding.bottom;

    const normalizedPoints = points
        .map((point) => {
            const bucketTime = new Date(point?.bucketTime || '').getTime();
            if (!Number.isFinite(bucketTime)) {
                return null;
            }

            return {
                ...point,
                bucketTimeMs: bucketTime
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.bucketTimeMs - b.bucketTimeMs);

    if (normalizedPoints.length === 0) {
        return '';
    }

    const dedupedMap = new Map();
    for (const point of normalizedPoints) {
        dedupedMap.set(point.bucketTimeMs, point);
    }
    const dedupedPoints = Array.from(dedupedMap.values()).sort((a, b) => a.bucketTimeMs - b.bucketTimeMs);

    const minTimeMs = dedupedPoints[0].bucketTimeMs;
    const maxTimeMs = dedupedPoints[dedupedPoints.length - 1].bucketTimeMs;
    const timeSpan = Math.max(1, maxTimeMs - minTimeMs);

    const values = dedupedPoints.map((point) => Math.max(0, Number(point?.[config.valueKey] || 0)));
    const maxValue = Math.max(...values, 1);

    const coordinates = dedupedPoints.map((point) => {
        const xRatio = (point.bucketTimeMs - minTimeMs) / timeSpan;
        const x = padding.left + (xRatio * plotWidth);
        const rawValue = Math.max(0, Number(point?.[config.valueKey] || 0));
        const y = padding.top + ((1 - (rawValue / maxValue)) * plotHeight);

        return {
            x,
            y,
            point,
            value: rawValue
        };
    });

    if (coordinates.length === 0) {
        return '';
    }

    const linePath = coordinates.length >= 3
        ? buildSmoothTrendPath(coordinates)
        : buildLinearTrendPath(coordinates);
    const firstPoint = coordinates[0];
    const lastPoint = coordinates[coordinates.length - 1];
    const areaPath = `${linePath} L${lastPoint.x.toFixed(2)} ${(padding.top + plotHeight).toFixed(2)} L${firstPoint.x.toFixed(2)} ${(padding.top + plotHeight).toFixed(2)} Z`;

    const horizontalTicks = 4;
    const gridRows = Array.from({ length: horizontalTicks + 1 }, (_, index) => {
        const ratio = index / horizontalTicks;
        const y = padding.top + (ratio * plotHeight);
        const value = maxValue * (1 - ratio);

        return `
            <line class="usage-stats-line-grid" x1="${padding.left}" y1="${y.toFixed(2)}" x2="${(padding.left + plotWidth).toFixed(2)}" y2="${y.toFixed(2)}"></line>
            <text class="usage-stats-axis-label" x="${padding.left - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeHtml(formatCompactNumber(value))}</text>
        `;
    }).join('');

    const xTicks = collectTrendTimeTicks(minTimeMs, maxTimeMs, usageStatsState.trendBucket);
    const xLabels = xTicks.map((tick, index) => {
        const x = padding.left + (tick.ratio * plotWidth);
        const previousTick = index > 0 ? xTicks[index - 1].timeMs : null;
        const label = formatTrendTickLabel(tick.timeMs, usageStatsState.trendBucket, previousTick);
        const anchor = index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle';

        return `<text class="usage-stats-axis-label" x="${x.toFixed(2)}" y="${(padding.top + plotHeight + 18).toFixed(2)}" text-anchor="${anchor}">${escapeHtml(label)}</text>`;
    }).join('');

    const circles = coordinates.map((coordinate) => {
        const label = formatBucketLabel(coordinate.point.bucketTime, usageStatsState.trendBucket);
        const tooltip = `${label}\n${config.metricLabel}: ${formatNumber(coordinate.value)}`;

        return `<circle class="usage-stats-line-point ${config.pointClass}" cx="${coordinate.x.toFixed(2)}" cy="${coordinate.y.toFixed(2)}" r="3" data-tooltip="${escapeAttribute(tooltip)}"></circle>`;
    }).join('');

    return `
        <svg class="usage-stats-line-svg" viewBox="0 0 ${chartWidth} ${chartHeight}" preserveAspectRatio="none" role="img" aria-label="${escapeAttribute(config.metricLabel)}趋势图">
            ${gridRows}
            <line class="usage-stats-line-axis" x1="${padding.left}" y1="${(padding.top + plotHeight).toFixed(2)}" x2="${(padding.left + plotWidth).toFixed(2)}" y2="${(padding.top + plotHeight).toFixed(2)}"></line>
            <path class="${config.areaClass}" d="${areaPath}"></path>
            <path class="${config.lineClass}" d="${linePath}"></path>
            ${circles}
            ${xLabels}
        </svg>
    `;
}

function renderTrendCard(containerId, trends = {}, config = {}) {
    const container = byId(containerId);
    if (!container) {
        return;
    }

    const points = Array.isArray(trends.points) ? trends.points : [];
    if (points.length === 0) {
        container.innerHTML = '<div class="usage-stats-chart-empty">当前范围暂无趋势数据。</div>';
        return;
    }

    const pointWindowSize = usageStatsState.trendBucket === 'day' ? 45 : 72;
    const displayPoints = points.slice(-pointWindowSize);

    if (displayPoints.length === 0) {
        container.innerHTML = '<div class="usage-stats-chart-empty">当前范围暂无趋势数据。</div>';
        return;
    }

    container.innerHTML = buildTrendChartSvg(displayPoints, config);
}

function renderTrendCharts(trends = {}) {
    renderTrendCard('usageStatsRequestTrendChart', trends, {
        valueKey: 'requestCount',
        metricLabel: '请求数',
        lineClass: 'usage-stats-line-path-request',
        areaClass: 'usage-stats-line-area-request',
        pointClass: 'usage-stats-line-point-request'
    });

    renderTrendCard('usageStatsTokenTrendChart', trends, {
        valueKey: 'totalTokens',
        metricLabel: 'Token',
        lineClass: 'usage-stats-line-path-token',
        areaClass: 'usage-stats-line-area-token',
        pointClass: 'usage-stats-line-point-token'
    });
}

function resolveHealthLevel(requestCount, errorCount) {
    const total = Math.max(0, Number(requestCount || 0));
    if (total <= 0) {
        return 0;
    }

    const errors = Math.max(0, Number(errorCount || 0));
    const successRate = Math.max(0, Math.min(1, (total - errors) / total));

    if (successRate < 0.75) {
        return 1;
    }
    if (successRate < 0.9) {
        return 2;
    }
    if (successRate < 0.97) {
        return 3;
    }
    return 4;
}

function buildRecentDays(endDate, days = HEALTH_HEATMAP_DAYS) {
    const anchor = endDate instanceof Date ? new Date(endDate) : new Date();
    anchor.setHours(0, 0, 0, 0);

    const result = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const day = new Date(anchor);
        day.setDate(anchor.getDate() - offset);
        result.push(day);
    }

    return result;
}

function renderServiceHealthHeatmap(heatmap = {}) {
    const container = byId('usageStatsHealthHeatmap');
    const healthScoreLabel = byId('usageStatsHealthScore');

    if (!container) {
        return;
    }

    const cells = Array.isArray(heatmap.cells) ? heatmap.cells : [];
    const endDate = heatmap.to ? new Date(heatmap.to) : new Date();
    const visibleThrough = Number.isNaN(endDate.getTime()) ? new Date() : endDate;
    const days = buildRecentDays(visibleThrough, HEALTH_HEATMAP_DAYS);

    setText(byId('usageStatsHealthSummaryLabel'), `最近 ${HEALTH_HEATMAP_DAYS} 天`);

    if (cells.length === 0) {
        container.innerHTML = `<div class="usage-stats-empty">近 ${HEALTH_HEATMAP_DAYS} 天暂无服务健康数据。</div>`;
        setText(healthScoreLabel, '--');
        healthScoreLabel?.classList?.remove('is-good', 'is-medium', 'is-bad');
        return;
    }

    const cellMap = new Map();
    for (const cell of cells) {
        const dateKey = typeof cell.dateKey === 'string' ? cell.dateKey : null;
        const hour = Number(cell.hour || 0);
        const minute = Number(cell.minute || 0);

        if (dateKey) {
            const key = `${dateKey}-${hour}-${minute}`;
            cellMap.set(key, {
                requestCount: Number(cell.requestCount || 0),
                errorCount: Number(cell.errorCount || 0),
                totalTokens: Number(cell.totalTokens || 0),
                logInfo: typeof cell.logInfo === 'string' ? cell.logInfo : ''
            });
            continue;
        }

        const weekday = Number(cell.weekday || 0);
        const fallbackKey = `${weekday}-${hour}`;
        cellMap.set(fallbackKey, {
            requestCount: Number(cell.requestCount || 0),
            errorCount: Number(cell.errorCount || 0),
            totalTokens: Number(cell.totalTokens || 0),
            logInfo: typeof cell.logInfo === 'string' ? cell.logInfo : ''
        });
    }

    let totalRequests = 0;
    let totalErrors = 0;

    for (const day of days) {
        const weekday = day.getDay();
        const dateKey = formatDateKey(day);

        for (let slot = 0; slot < HEALTH_SLOTS_PER_DAY; slot += 1) {
            const hour = Math.floor(slot / HEALTH_SLOTS_PER_HOUR);
            const minute = (slot % HEALTH_SLOTS_PER_HOUR) * HEALTH_SLOT_MINUTES;
            const exactKey = `${dateKey}-${hour}-${minute}`;
            const data = cellMap.get(exactKey) || cellMap.get(`${weekday}-${hour}`);
            if (data) {
                totalRequests += Number(data.requestCount || 0);
                totalErrors += Number(data.errorCount || 0);
            }
        }
    }

    if (healthScoreLabel) {
        const successRate = totalRequests > 0
            ? ((totalRequests - totalErrors) / totalRequests) * 100
            : 0;
        const normalizedRate = Math.max(0, successRate);
        healthScoreLabel.textContent = `${normalizedRate.toFixed(1)}%`;
        healthScoreLabel.classList.remove('is-good', 'is-medium', 'is-bad');
        if (normalizedRate >= 90) {
            healthScoreLabel.classList.add('is-good');
        } else if (normalizedRate >= 70) {
            healthScoreLabel.classList.add('is-medium');
        } else {
            healthScoreLabel.classList.add('is-bad');
        }
    }

    const rowCount = Math.max(1, Math.min(HEALTH_HEATMAP_VISIBLE_ROWS, HEALTH_HEATMAP_DAYS));
    const timelineSlots = [];

    for (const day of days) {
        const weekday = day.getDay();
        const dateKey = formatDateKey(day);

        for (let slot = 0; slot < HEALTH_SLOTS_PER_DAY; slot += 1) {
            const hour = Math.floor(slot / HEALTH_SLOTS_PER_HOUR);
            const minute = (slot % HEALTH_SLOTS_PER_HOUR) * HEALTH_SLOT_MINUTES;
            const startAt = new Date(day);
            startAt.setHours(hour, minute, 0, 0);

            if (startAt.getTime() > visibleThrough.getTime()) {
                continue;
            }

            const endAt = new Date(startAt.getTime() + (HEALTH_SLOT_MINUTES * 60000));
            const displayEndAt = endAt.getTime() > visibleThrough.getTime() ? visibleThrough : endAt;
            const slotData = cellMap.get(`${dateKey}-${hour}-${minute}`) || cellMap.get(`${weekday}-${hour}`) || {
                requestCount: 0,
                errorCount: 0,
                totalTokens: 0,
                logInfo: ''
            };

            const requestCount = Number(slotData.requestCount || 0);
            const errorCount = Number(slotData.errorCount || 0);
            const successCount = Math.max(0, requestCount - errorCount);
            const successRate = requestCount > 0 ? (successCount / requestCount) : 0;
            const level = resolveHealthLevel(requestCount, errorCount);
            const logInfo = typeof slotData.logInfo === 'string' ? slotData.logInfo : '';

            timelineSlots.push({
                isGap: false,
                level,
                startAt,
                endAt: displayEndAt,
                successCount,
                errorCount,
                successRate,
                logInfo
            });
        }
    }

    const columnsPerRow = Math.max(
        HEALTH_SLOTS_PER_DAY,
        Math.ceil(timelineSlots.length / rowCount)
    );

    const heatmapCard = container.closest('.usage-stats-health-card');
    if (heatmapCard) {
        heatmapCard.style.setProperty('--usage-health-columns', String(columnsPerRow));
    }
    const totalSlots = columnsPerRow * rowCount;
    const leadingPlaceholderCount = Math.max(0, totalSlots - timelineSlots.length);
    const orderedSlots = [
        ...Array.from({ length: leadingPlaceholderCount }, () => ({ isPlaceholder: true, level: 0 })),
        ...timelineSlots
    ];

    let html = `
        <div class="usage-stats-health-grid" style="--usage-health-columns: ${columnsPerRow};">
    `;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        html += '<div class="usage-stats-health-row">';

        for (let columnIndex = 0; columnIndex < columnsPerRow; columnIndex += 1) {
            const slotIndex = (columnIndex * rowCount) + rowIndex;
            const slotData = orderedSlots[slotIndex];

            if (!slotData || slotData.isGap || slotData.isPlaceholder) {
                html += '<div class="usage-stats-health-cell level-0 is-placeholder"></div>';
                continue;
            }

            const logAttribute = slotData.logInfo ? ` data-tooltip-log="${escapeAttribute(slotData.logInfo)}"` : '';
            html += `
                <div
                    class="usage-stats-health-cell level-${slotData.level}"
                    data-tooltip-interval="${escapeAttribute(formatHeatmapInterval(slotData.startAt, slotData.endAt))}"
                    data-tooltip-success="${escapeAttribute(formatNumber(Math.round(slotData.successCount)))}"
                    data-tooltip-error="${escapeAttribute(formatNumber(Math.round(slotData.errorCount)))}"
                    data-tooltip-rate="${escapeAttribute((slotData.successRate * 100).toFixed(1))}"${logAttribute}
                ></div>
            `;
        }

        html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;
}
function renderModels(models = {}) {
    const tbody = byId('usageStatsModelsTableBody');
    if (!tbody) {
        return;
    }

    const items = Array.isArray(models.items) ? models.items : [];
    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="usage-stats-empty">暂无 Model 数据。</td></tr>';
        return;
    }

    tbody.innerHTML = items.map((item) => {
        const requestCount = Number(item.requestCount || 0);
        const errorRate = requestCount > 0 ? (Number(item.errorCount || 0) / requestCount) : 0;
        return `
            <tr>
                <td>${escapeHtml(item.model || '(未知)')}</td>
                <td>${formatNumber(item.requestCount)}</td>
                <td>${formatNumber(item.totalTokens)}</td>
                <td>${formatCurrency(item.totalCost)}</td>
                <td>${formatPercent(errorRate)}</td>
            </tr>
        `;
    }).join('');
}

function renderCredentials(credentials = {}) {
    const tbody = byId('usageStatsCredentialsTableBody');
    if (!tbody) {
        return;
    }

    const items = Array.isArray(credentials.items) ? credentials.items : [];
    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="usage-stats-empty">暂无凭证数据。</td></tr>';
        return;
    }

    tbody.innerHTML = items.map((item) => {
        const requestCount = Number(item.requestCount || 0);
        const errorRate = requestCount > 0 ? (Number(item.errorCount || 0) / requestCount) : 0;
        const credentialLabel = item.providerCustomName
            ? `${item.providerCustomName} (${item.providerUuid || '无'})`
            : (item.providerUuid || '无');

        return `
            <tr>
                <td>${escapeHtml(item.toProvider || '(未知)')}</td>
                <td>${escapeHtml(credentialLabel)}</td>
                <td>${formatNumber(item.requestCount)}</td>
                <td>${formatNumber(item.totalTokens)}</td>
                <td>${formatCurrency(item.totalCost)}</td>
                <td>${formatPercent(errorRate)}</td>
            </tr>
        `;
    }).join('');
}

function renderEvents(events = {}) {
    const tbody = byId('usageStatsEventsTableBody');
    const pageInfo = byId('usageStatsEventsPageInfo');
    const prevBtn = byId('usageStatsEventsPrevBtn');
    const nextBtn = byId('usageStatsEventsNextBtn');

    if (!tbody || !pageInfo || !prevBtn || !nextBtn) {
        return;
    }

    const items = Array.isArray(events.items) ? events.items : [];
    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="usage-stats-empty">所选范围内暂无事件。</td></tr>';
    } else {
        tbody.innerHTML = items.map((item) => {
            const statusClass = item.requestStatus || 'unknown';
            const provider = item.providerCustomName
                ? `${item.toProvider || '-'} (${item.providerCustomName})`
                : `${item.toProvider || '-'} (${item.providerUuid || '-'})`;
            return `
                <tr>
                    <td>${escapeHtml(formatDateTime(item.occurredAt))}</td>
                    <td>${escapeHtml(provider)}</td>
                    <td>${escapeHtml(item.model || '-')}</td>
                    <td><span class="usage-stats-status ${escapeHtml(statusClass)}">${escapeHtml(statusClass === 'success' ? '成功' : statusClass === 'error' ? '错误' : statusClass === 'client_disconnected' ? '客户端断开' : (statusClass || '未知'))}</span></td>
                    <td>${formatNumber(item.totalTokens)}</td>
                    <td>${formatCurrency(item.estimatedCost, item.currency)}</td>
                    <td>${formatNumber(item.latencyMs)} ms</td>
                    <td>${escapeHtml(item.errorCode || item.errorMessage || '-')}</td>
                </tr>
            `;
        }).join('');
    }

    const page = Number(events.page || 1);
    const totalPages = Math.max(1, Number(events.totalPages || 1));
    usageStatsState.eventsPage = page;

    pageInfo.textContent = `第 ${page} / ${totalPages} 页 · 共 ${formatNumber(events.totalCount || 0)} 条`;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= totalPages;
}

function bindPriceRowActions() {
    const tbody = byId('usageStatsPricesTableBody');
    if (!tbody) {
        return;
    }

    const deleteButtons = tbody.querySelectorAll('.usage-stats-price-delete');
    deleteButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const index = parsePositiveInt(button.dataset.index, -1);
            if (index < 0 || index >= usageStatsState.prices.length) {
                return;
            }
            usageStatsState.prices.splice(index, 1);
            renderPrices();
        });
    });
}

function renderPrices() {
    const tbody = byId('usageStatsPricesTableBody');
    if (!tbody) {
        return;
    }

    if (!Array.isArray(usageStatsState.prices) || usageStatsState.prices.length === 0) {
        usageStatsState.prices = [{
            model: '',
            currency: 'USD',
            promptPricePer1k: 0,
            completionPricePer1k: 0,
            updatedAt: null
        }];
    }

    tbody.innerHTML = usageStatsState.prices.map((price, index) => `
        <tr>
            <td><input class="usage-stats-price-input" data-field="model" data-index="${index}" value="${escapeHtml(price.model || '')}" placeholder="Model ID"></td>
            <td><input class="usage-stats-price-input" data-field="currency" data-index="${index}" value="${escapeHtml(price.currency || 'USD')}" placeholder="USD"></td>
            <td><input class="usage-stats-price-input" data-field="promptPricePer1k" data-index="${index}" value="${Number(price.promptPricePer1k || 0)}" type="number" step="0.0001" min="0"></td>
            <td><input class="usage-stats-price-input" data-field="completionPricePer1k" data-index="${index}" value="${Number(price.completionPricePer1k || 0)}" type="number" step="0.0001" min="0"></td>
            <td>${escapeHtml(formatDateTime(price.updatedAt))}</td>
            <td><button type="button" class="btn-usage-stats usage-stats-price-delete" data-index="${index}">删除</button></td>
        </tr>
    `).join('');

    bindPriceRowActions();
}

function collectPriceFormValues() {
    const tbody = byId('usageStatsPricesTableBody');
    if (!tbody) {
        return [];
    }

    const rows = [];
    const inputs = tbody.querySelectorAll('.usage-stats-price-input');
    inputs.forEach((input) => {
        const index = parsePositiveInt(input.dataset.index, -1);
        const field = input.dataset.field;
        if (index < 0 || !field) {
            return;
        }

        if (!rows[index]) {
            rows[index] = {
                model: '',
                currency: 'USD',
                promptPricePer1k: 0,
                completionPricePer1k: 0
            };
        }

        rows[index][field] = input.value;
    });

    return rows
        .filter(Boolean)
        .map((row) => ({
            model: String(row.model || '').trim(),
            currency: String(row.currency || 'USD').trim().toUpperCase() || 'USD',
            promptPricePer1k: Number(row.promptPricePer1k || 0),
            completionPricePer1k: Number(row.completionPricePer1k || 0)
        }))
        .filter((row) => row.model);
}

async function loadOverviewAndDimensions() {
    const commonParams = buildCommonParams(true, false);
    const healthParams = buildServiceHealthParams();

    const [overview, trends, heatmap, models, credentials] = await Promise.all([
        requestJson(`/api/usage-statistics/overview?${commonParams.toString()}`),
        requestJson(`/api/usage-statistics/trends?${commonParams.toString()}`),
        requestJson(`/api/usage-statistics/heatmap?${healthParams.toString()}`),
        requestJson(`/api/usage-statistics/dimensions/models?${commonParams.toString()}`),
        requestJson(`/api/usage-statistics/dimensions/credentials?${commonParams.toString()}`)
    ]);

    renderOverview(overview);
    renderTrendCharts(trends);
    renderServiceHealthHeatmap(heatmap);
    renderModels(models);
    renderCredentials(credentials);

    setText(byId('usageStatsUpdatedAt'), `更新时间: ${formatDateTime(new Date().toISOString())}`);
}

async function loadEvents() {
    const params = buildCommonParams(false, true);
    params.set('page', String(usageStatsState.eventsPage));
    params.set('limit', String(usageStatsState.eventsPageSize));

    const events = await requestJson(`/api/usage-statistics/events?${params.toString()}`);
    renderEvents(events);
}

async function loadPrices() {
    const prices = await requestJson('/api/usage-statistics/prices');
    usageStatsState.prices = Array.isArray(prices) ? prices : [];
    renderPrices();
}

async function refreshUsageStatistics(options = {}) {
    if (usageStatsState.loading) {
        return;
    }

    const keepPage = options.keepPage === true;
    if (!keepPage) {
        usageStatsState.eventsPage = 1;
    }

    showUsageStatsError('');
    setUsageStatsLoading(true);

    try {
        await Promise.all([
            loadOverviewAndDimensions(),
            loadEvents(),
            loadPrices()
        ]);
    } catch (error) {
        showUsageStatsError(`加载使用统计失败：${error.message}`);
        showToast('错误', `加载使用统计失败：${error.message}`, 'error');
    } finally {
        setUsageStatsLoading(false);
    }
}

async function exportUsageStatistics(format) {
    const commonParams = buildCommonParams(false, true);
    commonParams.set('format', format);

    try {
        const response = await fetch(`/api/usage-statistics/export?${commonParams.toString()}`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            const errorPayload = await response.json().catch(() => ({}));
            throw new Error(errorPayload?.error?.message || `${response.status} ${response.statusText}`);
        }

        const blob = await response.blob();
        const contentDisposition = response.headers.get('Content-Disposition') || '';
        const fileNameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
        const fileName = fileNameMatch?.[1] || `usage-statistics.${format}`;

        const link = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(objectUrl);

        showToast('成功', `${format.toUpperCase()} 导出成功`, 'success');
    } catch (error) {
        showToast('错误', `导出失败：${error.message}`, 'error');
    }
}

async function saveModelPrices() {
    const prices = collectPriceFormValues();
    if (prices.length === 0) {
        showToast('警告', '请至少填写一条 Model 价格配置。', 'warning');
        return;
    }

    try {
        const result = await requestJson('/api/usage-statistics/prices', {
            method: 'PUT',
            body: JSON.stringify({
                prices,
                updatedBy: 'web-ui'
            })
        });

        usageStatsState.prices = Array.isArray(result?.prices) ? result.prices : prices;
        renderPrices();
        showToast('成功', `已保存 ${result?.updatedCount || prices.length} 条 Model 价格配置。`, 'success');
        await refreshUsageStatistics({ keepPage: true });
    } catch (error) {
        showToast('错误', `保存价格失败：${error.message}`, 'error');
    }
}

function bindUsageStatisticsEvents() {
    if (usageStatsState.initialized) {
        return;
    }

    byId('usageStatsRange')?.addEventListener('change', async () => {
        setCustomRangeVisibility();
        if (byId('usageStatsRange')?.value !== 'custom') {
            await refreshUsageStatistics();
        }
    });

    byId('usageStatsRefreshBtn')?.addEventListener('click', async () => {
        await refreshUsageStatistics();
    });

    byId('usageStatsBucketSwitch')?.addEventListener('click', async (event) => {
        const button = event.target instanceof Element ? event.target.closest('button[data-bucket]') : null;
        if (!button) {
            return;
        }

        const bucket = button.dataset.bucket === 'day' ? 'day' : 'hour';
        if (bucket === usageStatsState.trendBucket) {
            return;
        }

        setTrendBucket(bucket);
        await refreshUsageStatistics({ keepPage: true });
    });

    byId('usageStatsExportCsvBtn')?.addEventListener('click', async () => {
        await exportUsageStatistics('csv');
    });

    byId('usageStatsExportJsonBtn')?.addEventListener('click', async () => {
        await exportUsageStatistics('json');
    });

    byId('usageStatsEventsApplyBtn')?.addEventListener('click', async () => {
        usageStatsState.eventsPage = 1;
        await loadEvents();
    });

    byId('usageStatsEventsKeyword')?.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter') {
            return;
        }

        usageStatsState.eventsPage = 1;
        await loadEvents();
    });

    byId('usageStatsEventsPrevBtn')?.addEventListener('click', async () => {
        usageStatsState.eventsPage = Math.max(1, usageStatsState.eventsPage - 1);
        await loadEvents();
    });

    byId('usageStatsEventsNextBtn')?.addEventListener('click', async () => {
        usageStatsState.eventsPage += 1;
        await loadEvents();
    });

    byId('usageStatsAddPriceBtn')?.addEventListener('click', () => {
        usageStatsState.prices.push({
            model: '',
            currency: 'USD',
            promptPricePer1k: 0,
            completionPricePer1k: 0,
            updatedAt: null
        });
        renderPrices();
    });

    byId('usageStatsSavePricesBtn')?.addEventListener('click', async () => {
        await saveModelPrices();
    });

    window.addEventListener('ui:section-activated', async (event) => {
        const sectionId = event?.detail?.sectionId;
        if (sectionId !== 'usage-statistics') {
            return;
        }

        usageStatsState.active = true;
        await refreshUsageStatistics({ keepPage: true });
    });

    usageStatsState.initialized = true;
}

function initUsageStatisticsManager() {
    bindUsageStatisticsEvents();
    bindUsageStatsTooltip();
    setCustomRangeVisibility();
    setTrendBucket(byId('usageStatsBucket')?.value || 'hour');

    const section = byId('usage-statistics');
    if (section?.classList?.contains('active') && usageStatsState.active !== true) {
        usageStatsState.active = true;
        void refreshUsageStatistics({ keepPage: true });
    }
}

export {
    initUsageStatisticsManager,
    refreshUsageStatistics
};
