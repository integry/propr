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
