/**
 * Review input token estimation.
 *
 * Text is measured with the o200k_base tokenizer, which is the tokenizer family
 * of the OpenAI models the Codex runtime routes to. Other providers do not
 * publish a local tokenizer, so their counts are derived from the o200k count
 * with a documented calibration ratio. Every profile also applies a
 * character-class floor so text a proxy tokenizer compresses unusually well
 * (non-Latin scripts, emoji) is never under-counted.
 *
 * Text is measured in small line-aligned chunks. Chunk estimates are summed, so
 * a section's estimate never depends on its neighbours, prefixes can be fitted
 * without re-tokenizing, and a pathological single "word" (minified code,
 * base64) cannot trigger quadratic BPE work.
 */
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { ReviewTokenizerProfile } from '@propr/shared';

interface TokenizerCalibration {
    /** Multiplier applied to the o200k_base count. */
    tokenizerRatio: number;
    /** Lower bound: ASCII characters per token. */
    asciiCharsPerTokenFloor: number;
    /** Lower bound: tokens per non-ASCII code point. */
    nonAsciiTokensPerCodePoint: number;
}

// Existing repository calibration: Claude tokens are ~36% above tiktoken for
// code and XML (TIKTOKEN_TO_CLAUDE_RATIO in @propr/core modelLimits).
const TIKTOKEN_TO_CLAUDE_RATIO = 1.36;
// Newer Claude tokenizers produce up to ~35% more tokens for the same text.
const CLAUDE_TOKENIZER_REVISION_MARGIN = 1.35;

export const REVIEW_TOKENIZER_CALIBRATIONS: Record<ReviewTokenizerProfile, TokenizerCalibration> = {
    // o200k_base is the runtime tokenizer family; 10% covers undisclosed
    // revisions. Production reference: a 242,268-character review prompt was
    // billed as 76,530 input tokens including runtime instructions.
    'openai-o200k': { tokenizerRatio: 1.1, asciiCharsPerTokenFloor: 6, nonAsciiTokensPerCodePoint: 2 },
    'anthropic-calibrated': {
        tokenizerRatio: TIKTOKEN_TO_CLAUDE_RATIO * CLAUDE_TOKENIZER_REVISION_MARGIN,
        asciiCharsPerTokenFloor: 6,
        nonAsciiTokensPerCodePoint: 2,
    },
    // Unknown tokenizer: the Claude-level ratio plus the same floors.
    'generic-calibrated': { tokenizerRatio: 1.85, asciiCharsPerTokenFloor: 6, nonAsciiTokensPerCodePoint: 2 },
};

const CHUNK_TARGET_CHARS = 1024;

interface ChunkStats {
    end: number;
    tokens: number;
    asciiChars: number;
    nonAsciiCodePoints: number;
}

let o200kEncoder: Tiktoken | undefined;
function encoder(): Tiktoken {
    o200kEncoder ??= getEncoding('o200k_base');
    return o200kEncoder;
}

function chunkEnd(text: string, start: number): number {
    const limit = Math.min(text.length, start + CHUNK_TARGET_CHARS);
    if (limit === text.length) return limit;
    const newline = text.lastIndexOf('\n', limit - 1);
    let end = newline >= start ? newline + 1 : limit;
    // Never split a surrogate pair.
    const code = text.charCodeAt(end - 1);
    if (end === limit && code >= 0xd800 && code <= 0xdbff) end -= 1;
    return end > start ? end : limit;
}

function measureChunk(chunk: string, end: number): ChunkStats {
    let asciiChars = 0;
    let nonAsciiCodePoints = 0;
    for (const char of chunk) {
        if (char.charCodeAt(0) < 0x80) asciiChars += 1;
        else nonAsciiCodePoints += 1;
    }
    // Special-token strings in review text are ordinary text, not control tokens.
    const tokens = encoder().encode(chunk, [], []).length;
    return { end, tokens, asciiChars, nonAsciiCodePoints };
}

/**
 * Tokenizer statistics shared by every reviewer of one review job, so large
 * inputs are tokenized once even when reviewers use different profiles.
 */
export class ReviewTokenStatsCache {
    private readonly sections = new Map<string, ChunkStats[]>();

    chunks(text: string, cache = true): ChunkStats[] {
        const cached = this.sections.get(text);
        if (cached) return cached;
        const chunks: ChunkStats[] = [];
        for (let start = 0; start < text.length;) {
            const end = chunkEnd(text, start);
            chunks.push(measureChunk(text.slice(start, end), end));
            start = end;
        }
        if (cache) this.sections.set(text, chunks);
        return chunks;
    }
}

export class ReviewTokenEstimator {
    private readonly calibration: TokenizerCalibration;

    constructor(
        readonly profile: ReviewTokenizerProfile,
        private readonly stats: ReviewTokenStatsCache = new ReviewTokenStatsCache(),
    ) {
        this.calibration = REVIEW_TOKENIZER_CALIBRATIONS[profile];
    }

    private chunkEstimate(chunk: ChunkStats): number {
        const { tokenizerRatio, asciiCharsPerTokenFloor, nonAsciiTokensPerCodePoint } = this.calibration;
        const calibrated = chunk.tokens * tokenizerRatio;
        const floor = chunk.asciiChars / asciiCharsPerTokenFloor + chunk.nonAsciiCodePoints * nonAsciiTokensPerCodePoint;
        return Math.ceil(Math.max(calibrated, floor));
    }

    /** Estimated tokens for `text`; pass `cache: false` for one-off text such as a full prompt. */
    estimate(text: string, options: { cache?: boolean } = {}): number {
        if (!text) return 0;
        let total = 0;
        for (const chunk of this.stats.chunks(text, options.cache ?? true)) total += this.chunkEstimate(chunk);
        return total;
    }

    /** Length of the longest chunk-aligned prefix of `text` whose estimate fits `maxTokens`. */
    fitPrefixLength(text: string, maxTokens: number): number {
        let total = 0;
        let length = 0;
        for (const chunk of this.stats.chunks(text)) {
            total += this.chunkEstimate(chunk);
            if (total > maxTokens) break;
            length = chunk.end;
        }
        return length;
    }
}
