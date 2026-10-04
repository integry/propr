/**
 * Gives a `get`-only Redis fake the atomic read the live-output reader uses,
 * answered from the plain `agent:output:<task>` value: exactly what output
 * written before the append-only log (no metadata hash) looks like.
 */
export function withLiveOutputReads<T extends { get(key: string): Promise<string | null> | string | null }>(client: T): T & {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<string[]>;
} {
  return Object.assign(client, {
    async eval(_script: string, { keys }: { keys: string[]; arguments: string[] }) {
      const data = Buffer.from((await client.get(keys[0])) ?? '');
      const from = 0;
      const text = data.toString();
      return ['0', 'legacy', '0', '', String(from), text, String(data.length)];
    },
  });
}
