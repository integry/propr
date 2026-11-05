import { describe, expect, test } from 'vitest';
import { findLogMatches, logSearchText, splitLogMatches } from './logSearch';

const log = '[INFO] acceptance [payload] (retry) C:\\tmp\\run.log matched .* twice; INFO again';

describe('log search', () => {
  test.each(['[', ']', '(', ')', '\\', '.*', '[payload]', '?', '+', '^', '$', '{', '|'])('treats %j literally without throwing', query => {
    const expected = log.split(query).length - 1;
    expect(findLogMatches(log, query)).toHaveLength(expected);
    const matched = splitLogMatches(log, query).filter(segment => segment.matchIndex !== undefined);
    expect(matched).toHaveLength(expected);
    expect(matched.every(segment => segment.text === query)).toBe(true);
  });

  test('matches without regard to case, and highlighting covers exactly the counted matches', () => {
    expect(findLogMatches(log, 'info').map(match => match.index)).toEqual([1, log.lastIndexOf('INFO')]);
    const segments = splitLogMatches(log, 'info');
    expect(segments.map(segment => segment.text).join('')).toBe(log);
    expect(segments.filter(segment => segment.matchIndex !== undefined).map(segment => segment.matchIndex)).toEqual([0, 1]);
  });

  test('an empty query finds nothing and leaves the text whole', () => {
    expect(findLogMatches(log, '')).toEqual([]);
    expect(splitLogMatches(log, '')).toEqual([{ text: log }]);
    expect(splitLogMatches('', 'x')).toEqual([{ text: '' }]);
  });

  test('JSON logs are searched as displayed', () => {
    expect(logSearchText({ message: '[INFO]' }, true)).toBe('{\n  "message": "[INFO]"\n}');
    expect(logSearchText('plain', false)).toBe('plain');
  });
});
