import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getClaudeAnalysisText, getFinalAnswerText } from '../packages/core/src/agents/impl/utils/claudeOutputHelpers.js';

const assistant = (id: string, ...blocks: Array<Record<string, unknown>>) => ({ type: 'assistant', message: { id, content: blocks } });
const text = (value: string) => ({ type: 'text', text: value });
const user = (content: unknown) => ({ type: 'user', message: { content } });

const plan = JSON.stringify([{ title: 'A', body: 'b', implementation: 'c' }, { title: 'B', body: 'd', implementation: 'e' }]);
const cut = plan.indexOf('"implementation":"e"') - 3;

test('a reply continued after the output-token limit is returned whole', () => {
  const conversationLog = [
    user('Generate the plan'),
    assistant('msg_1', { type: 'thinking', thinking: '...' }),
    assistant('msg_1', text(plan.slice(0, cut))),
    // Claude Code asks the model to resume; the result line then holds only the tail.
    user('Output token limit hit. Resume directly.'),
    assistant('msg_2', text(plan.slice(cut))),
  ];
  const output = { finalResult: { result: plan.slice(cut) }, conversationLog };

  assert.equal(getFinalAnswerText(conversationLog), plan);
  assert.equal(getClaudeAnalysisText(output), plan);
  assert.deepEqual(JSON.parse(getClaudeAnalysisText(output)), JSON.parse(plan));
});

test('repeated stream lines of one message are counted once', () => {
  const conversationLog = [assistant('msg_1', text('[1,')), assistant('msg_1', text('[1,')), assistant('msg_2', text('2]'))];
  assert.equal(getClaudeAnalysisText({ finalResult: { result: '2]' }, conversationLog }), '[1,2]');
});

test('only the answer after the last tool result is joined', () => {
  const conversationLog = [
    assistant('msg_1', text('Let me read the file.'), { type: 'tool_use', id: 't1', name: 'Read', input: {} }),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'file' }]),
    assistant('msg_2', text('{"answer":')),
    assistant('msg_3', text(' 42}')),
  ];
  assert.equal(getClaudeAnalysisText({ finalResult: { result: '{"answer": 42}'.slice(10) }, conversationLog }), '{"answer": 42}');
});

test('an ordinary single-message result is unchanged', () => {
  const conversationLog = [user('q'), assistant('msg_1', text('The answer.'))];
  assert.equal(getClaudeAnalysisText({ finalResult: { result: 'The answer.' }, conversationLog }), 'The answer.');
  // A result that is not the tail of the joined answer is kept as reported.
  assert.equal(getClaudeAnalysisText({ finalResult: { result: 'Different text.' }, conversationLog }), 'Different text.');
});

test('a reply restarted after the output-token limit returns only the restarted answer', () => {
  const response = JSON.stringify({ action: 'modified', summary: 'Reworked the history store', plan: JSON.parse(plan) }, null, 2);
  // The first attempt is cut mid-string; the model then rewrites the whole document.
  const firstAttempt = response.slice(0, response.indexOf('history store'));
  const conversationLog = [
    user('Refine the plan'),
    assistant('msg_1', text(firstAttempt)),
    user('Output token limit hit. Resume directly.'),
    assistant('msg_2', text(response)),
  ];
  const output = { finalResult: { result: response }, conversationLog };

  assert.equal(getFinalAnswerText(conversationLog), response);
  assert.equal(getClaudeAnalysisText(output), response);
  assert.deepEqual(JSON.parse(getClaudeAnalysisText(output)), JSON.parse(response));
});

test('a restart is taken from the last block that repeats the opening', () => {
  const response = '{"action": "modified", "summary": "Done", "plan": []}';
  const conversationLog = [
    assistant('msg_1', text('{"action": "modified", "summary": "Fi')),
    assistant('msg_2', text('{"action": "modified", "summary": "Sec')),
    assistant('msg_3', text(response.slice(0, 30))),
    assistant('msg_4', text(response.slice(30))),
  ];
  assert.equal(getFinalAnswerText(conversationLog), response);
});

test('a short or non-repeating continuation is still joined', () => {
  // Continuations that only resume mid-text never repeat the opening.
  const conversationLog = [assistant('msg_1', text('{"a": [1, 2,')), assistant('msg_2', text(' 3]}'))];
  assert.equal(getFinalAnswerText(conversationLog), '{"a": [1, 2, 3]}');
  // An opening too short to identify a restart is not treated as one.
  assert.equal(getFinalAnswerText([assistant('m1', text('[')), assistant('m2', text('[1]]'))]), '[[1]]');
});

test('a restart that rewords the answer after its opening is still recognised', () => {
  // Seen with Opus 5: both attempts open the same way, then the summary differs.
  const first = '{\n  "action": "modified",\n  "summary": "Dropped the JSON history file completely and';
  const restart = '{\n  "action": "modified",\n  "summary": "Dropped the JSON history backend.",\n  "plan": []\n}';
  const conversationLog = [assistant('msg_1', text(first)), assistant('msg_2', text(restart))];
  assert.equal(getClaudeAnalysisText({ finalResult: { result: restart }, conversationLog }), restart);
});
