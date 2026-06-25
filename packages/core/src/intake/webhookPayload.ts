/**
 * Materialize a routing-relay delivery payload into the parsed-object shape the
 * webhook dispatch expects.
 *
 * The relay carries the GitHub webhook body as a raw JSON *string*
 * (`rawPayload: string`), but `processWebhookEvent` and its type guards (e.g.
 * `isIssueCommentEvent`) operate on a parsed object — exactly what the
 * direct-webhook intake hands them. Without parsing, every routing event is
 * ACKed but silently dropped: the guards see a string, return false, and no
 * handler runs (which is why direct webhooks worked but the routing relay did
 * not). A string is JSON-parsed; an already-materialized object is passed
 * through unchanged. A string that is not valid JSON throws, so the caller
 * withholds the ACK and the relay can redeliver rather than us swallowing a
 * corrupt payload.
 *
 * Kept dependency-free (no webhook-handler imports) so it stays cheaply unit
 * testable without standing up the full intake stack.
 */
export function parseWebhookPayload(payload: unknown): unknown {
    if (typeof payload !== 'string') {
        return payload;
    }
    try {
        return JSON.parse(payload);
    } catch (error) {
        throw new Error(`Routing delivery payload was a string but not valid JSON: ${(error as Error).message}`);
    }
}
