import { describe, expect, it } from 'vitest';
import { readableThoughtContent, readableThoughts } from './thoughtContent';

describe('readableThoughtContent', () => {
  it('extracts the text of serialized tool responses and content-block lists', () => {
    expect(readableThoughtContent('{"content":[{"type":"text","text":"First"},{"type":"image"},{"type":"text","text":"Second"}]}')).toBe('First\n\nSecond');
    expect(readableThoughtContent('[{"type":"text","text":"Only text"}]')).toBe('Only text');
  });

  it('drops redaction placeholders and empty payloads', () => {
    expect(readableThoughtContent('{"content":[{"type":"text","text":"[local preview omitted]"}]}')).toBeNull();
    expect(readableThoughtContent('[local preview omitted]')).toBeNull();
    expect(readableThoughtContent('{"content":[]}')).toBe('{"content":[]}');
    expect(readableThoughtContent('{"content":[{"type":"image"}]}')).toBeNull();
    expect(readableThoughtContent('   ')).toBeNull();
    expect(readableThoughtContent(undefined)).toBeNull();
  });

  it('leaves prose, markdown and other JSON exactly as written', () => {
    const checkpoint = JSON.stringify({ checkpointReady: true, message: 'feat: ship' });
    expect(readableThoughtContent(checkpoint)).toBe(checkpoint);
    expect(readableThoughtContent('  [x] done, moving on  ')).toBe('  [x] done, moving on  ');
    expect(readableThoughtContent('{"content": [not json')).toBe('{"content": [not json');
  });

  it('only rewrites thoughts', () => {
    const tool = { type: 'tool_result' as const, content: '[local preview omitted]' };
    const thought = { type: 'thought' as const, content: 'Plain' };
    const result = readableThoughts([tool, thought, { type: 'thought' as const, content: '[omitted]' }]);
    expect(result).toEqual([tool, thought]);
    expect(result[1]).toBe(thought);
  });
});
