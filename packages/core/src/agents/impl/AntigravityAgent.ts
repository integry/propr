import { GeminiAgent } from './GeminiAgent.js';

/**
 * Antigravity replaces the previous Gemini agent type. The runner remains
 * compatible with the existing stream-json event shape while configs and
 * metadata use the Antigravity name.
 */
export class AntigravityAgent extends GeminiAgent {}
