import { afterEach, expect, it, vi } from 'vitest';
import {
  deleteTask,
  getTaskAnalysis,
  getTaskHistory,
  getTaskLiveDetails,
  setApiBaseUrl,
  setDesktopConnectionScope,
  stopTaskExecution,
} from './proprApi';
import { getFileChanges } from './fileChangesApi';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

afterEach(() => {
  setDesktopConnectionScope(null);
  setApiBaseUrl('');
  vi.restoreAllMocks();
});

it('encodes task IDs in every task-specific API path', async () => {
  setApiBaseUrl('https://api.gitfix.dev');
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(jsonResponse({ history: [] }))
    .mockResolvedValueOnce(jsonResponse({ analysis: null }))
    .mockResolvedValueOnce(jsonResponse({ events: [] }))
    .mockResolvedValueOnce(jsonResponse({ success: true }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(jsonResponse({ files: [], lastUpdated: '', taskId: 'legacy' }));
  const taskId = 'task-opencode-openai/gpt-5.6-luna';

  await getTaskHistory(taskId);
  await getTaskAnalysis(taskId);
  await getTaskLiveDetails(taskId);
  await stopTaskExecution(taskId);
  await deleteTask(taskId);
  await getFileChanges(taskId);

  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
    'https://api.gitfix.dev/api/task/task-opencode-openai%2Fgpt-5.6-luna/history',
    'https://api.gitfix.dev/api/task/task-opencode-openai%2Fgpt-5.6-luna/analysis',
    'https://api.gitfix.dev/api/task/task-opencode-openai%2Fgpt-5.6-luna/live-details',
    'https://api.gitfix.dev/api/task/task-opencode-openai%2Fgpt-5.6-luna/stop',
    'https://api.gitfix.dev/api/tasks/task-opencode-openai%2Fgpt-5.6-luna',
    'https://api.gitfix.dev/api/task/task-opencode-openai%2Fgpt-5.6-luna/file-changes',
  ]);
});
