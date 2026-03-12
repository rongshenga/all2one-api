import {
    extractUsageMetricsFromPayload,
    createUsageMetricsAccumulator,
    mergeUsageMetrics,
    finalizeUsageMetrics
} from '../src/services/usage-statistics-service.js';

describe('usage statistics service metrics extraction', () => {
    test('should extract OpenAI usage payload fields', () => {
        const metrics = extractUsageMetricsFromPayload({
            usage: {
                prompt_tokens: 120,
                completion_tokens: 80,
                total_tokens: 200
            }
        });

        expect(metrics).toEqual({
            promptTokens: 120,
            completionTokens: 80,
            totalTokens: 200,
            cachedTokens: 0,
            reasoningTokens: 0
        });
    });

    test('should extract Gemini usageMetadata fields', () => {
        const metrics = extractUsageMetricsFromPayload({
            usageMetadata: {
                promptTokenCount: 55,
                candidatesTokenCount: 45,
                totalTokenCount: 100,
                cachedContentTokenCount: 12,
                thoughtsTokenCount: 7
            }
        });

        expect(metrics).toEqual({
            promptTokens: 55,
            completionTokens: 45,
            totalTokens: 100,
            cachedTokens: 12,
            reasoningTokens: 7
        });
    });

    test('should aggregate stream chunk usage and finalize usage completeness', () => {
        const aggregate = createUsageMetricsAccumulator();

        mergeUsageMetrics(aggregate, extractUsageMetricsFromPayload({
            usage: {
                prompt_tokens: 20,
                completion_tokens: 30,
                total_tokens: 50
            }
        }));

        mergeUsageMetrics(aggregate, extractUsageMetricsFromPayload({
            usageMetadata: {
                inputTokenCount: 10,
                outputTokenCount: 15,
                totalTokenCount: 25
            }
        }));

        expect(finalizeUsageMetrics(aggregate)).toEqual({
            promptTokens: 30,
            completionTokens: 45,
            totalTokens: 75,
            cachedTokens: 0,
            reasoningTokens: 0,
            usageIncomplete: 0
        });
    });

    test('should mark usageIncomplete when no usage payload is present', () => {
        const aggregate = createUsageMetricsAccumulator();

        expect(finalizeUsageMetrics(aggregate)).toEqual({
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0,
            reasoningTokens: 0,
            usageIncomplete: 1
        });
    });
});
