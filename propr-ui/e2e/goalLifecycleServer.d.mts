/** Node-only server fixture kept outside the browser TypeScript project. */
export function goalLifecycleServer(): Promise<{
  url: string;
  requests: string[];
  reconnect(): void;
  rooms(): string[];
  read(): Promise<{ result_state: string | null; final_pr_number: number | null }>;
  settle(): Promise<void>;
  close(): Promise<void>;
}>;
