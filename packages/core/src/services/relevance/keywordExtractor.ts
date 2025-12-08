const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'of', 'as',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'she', 'they', 'them', 'their', 'who', 'what',
  'which', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'just',
  'fix', 'feat', 'chore', 'refactor', 'update', 'change', 'add', 'remove',
  'delete', 'implement', 'improve', 'make', 'use', 'get', 'set', 'new',
  'create', 'need', 'want', 'like', 'see', 'look', 'find', 'check', 'test',
  'code', 'file', 'function', 'method', 'class', 'module', 'component',
  'bug', 'issue', 'error', 'problem', 'work', 'working', 'broken'
]);

const CAMEL_CASE_PATTERN = /[A-Z][a-z]+[A-Z][a-zA-Z]*/g;
const SNAKE_CASE_PATTERN = /[a-z]+_[a-z_]+/g;
const FILE_EXTENSION_PATTERN = /\.[a-z]{1,5}$/i;
const PATH_PATTERN = /[a-zA-Z0-9_-]+\/[a-zA-Z0-9_\-/]+/g;

export function extractKeywords(prompt: string): string[] {
  const keywords: Set<string> = new Set();

  const camelCaseMatches = prompt.match(CAMEL_CASE_PATTERN) || [];
  camelCaseMatches.forEach(match => keywords.add(match));

  const snakeCaseMatches = prompt.match(SNAKE_CASE_PATTERN) || [];
  snakeCaseMatches.forEach(match => keywords.add(match));

  const pathMatches = prompt.match(PATH_PATTERN) || [];
  pathMatches.forEach(match => keywords.add(match));

  const extensionMatches = prompt.match(/\w+\.[a-z]{1,5}/gi) || [];
  extensionMatches.forEach(match => {
    if (FILE_EXTENSION_PATTERN.test(match)) {
      keywords.add(match);
    }
  });

  const clean = prompt.replace(/[^a-zA-Z0-9_\-/.]/g, ' ');
  const tokens = clean.split(/\s+/).filter(t => t.length > 2);
  
  tokens.forEach(token => {
    const lowerToken = token.toLowerCase();
    if (!STOP_WORDS.has(lowerToken)) {
      const isCamelCase = CAMEL_CASE_PATTERN.test(token);
      const isSnakeCase = SNAKE_CASE_PATTERN.test(token);
      const isPath = token.includes('/');
      const hasExtension = FILE_EXTENSION_PATTERN.test(token);
      
      if (isCamelCase || isSnakeCase || isPath || hasExtension) {
        keywords.add(token);
      } else if (token.length > 3 || /^[A-Z]/.test(token)) {
        keywords.add(token);
      }
    }
  });

  return Array.from(keywords);
}
