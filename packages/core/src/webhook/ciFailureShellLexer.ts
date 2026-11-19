/**
 * A small reader of shell words and separators for `ciFailureGateScript`:
 * each simple command's words, with quotes kept, and the separators around
 * it. Anything it does not follow (command or process substitution,
 * arithmetic, here-documents, unterminated quotes) stops it.
 */

export interface ShellCommand { words: string[]; before: string; after: string }

/**
 * The script's simple commands with their separators, as unquoted words with
 * quotes kept; null for anything this reader does not follow (command or
 * process substitution, arithmetic, here-documents, unterminated quotes).
 */
export function splitCommands(text: string): ShellCommand[] | null {
    const lexer = new ShellLexer(text);
    return lexer.run() ? lexer.commands : null;
}

/** A small reader of shell words and separators; any construct it does not follow stops it. */
class ShellLexer {
    readonly commands: ShellCommand[] = [];
    private words: string[] = [];
    private word = '';
    private quote: '"' | "'" | null = null;
    private index = 0;
    /** The separator before the next command; `&&`, `||` and `|` carry over the newlines that may follow them. */
    private before = '\n';

    constructor(private readonly text: string) {}

    run(): boolean {
        for (; this.index < this.text.length; this.index += 1) {
            if (!this.step(this.text[this.index], this.text[this.index + 1])) return false;
        }
        this.endCommand('\n');
        return this.quote === null;
    }

    private step(char: string, next: string | undefined): boolean {
        if (this.quote === "'") {
            this.word += char;
            if (char === "'") this.quote = null;
            return true;
        }
        if (char === '`' || (char === '$' && next === '(')) return false;
        if (char === '\\') return this.escape(next);
        if (char === '$' && next === '{') return this.expansion();
        if (this.quote === '"') {
            this.word += char;
            if (char === '"') this.quote = null;
            return true;
        }
        return this.unquoted(char, next);
    }

    private escape(next: string | undefined): boolean {
        // A line continuation joins the lines; any other escape stays in the word.
        if (next !== '\n') this.word += `\\${next ?? ''}`;
        this.index += 1;
        return true;
    }

    private expansion(): boolean {
        const end = this.text.indexOf('}', this.index);
        const expansion = this.text.slice(this.index, end + 1);
        if (end === -1 || expansion.includes('$(') || expansion.includes('`')) return false;
        this.word += expansion;
        this.index = end;
        return true;
    }

    private unquoted(char: string, next: string | undefined): boolean {
        // Process substitution, here-documents and here-strings.
        if (((char === '<' || char === '>') && next === '(') || (char === '<' && next === '<')) return false;
        if (char === "'" || char === '"') {
            this.quote = char;
            this.word += char;
        } else if (char === '#' && this.word === '') {
            while (this.index + 1 < this.text.length && this.text[this.index + 1] !== '\n') this.index += 1;
        } else if (char === '&' && /[<>]$/u.test(this.word)) {
            this.word += char;
        } else if (char === '{' || char === '}') {
            this.endCommand(';');
            this.words.push(char);
            this.endCommand(';');
        } else if ('\n;&|()'.includes(char)) {
            this.endCommand(this.separator(char, next));
        } else if (char === ' ' || char === '\t' || char === '\r') {
            this.endWord();
        } else {
            this.word += char;
        }
        return true;
    }

    private separator(char: string, next: string | undefined): string {
        if ((char === '&' || char === '|' || char === ';') && next === char) {
            this.index += 1;
            return char + char;
        }
        if (char === '(') {
            const rest = /^[ \t]*\)/u.exec(this.text.slice(this.index + 1));
            if (rest) {
                this.index += rest[0].length;
                return '()';
            }
        }
        return char;
    }

    private endWord(): void {
        if (this.word) this.words.push(this.word);
        this.word = '';
    }

    private endCommand(separator: string): void {
        this.endWord();
        if (this.words.length > 0) {
            this.commands.push({ words: this.words, before: this.before, after: separator });
            this.before = separator;
        } else if (!['&&', '||', '|'].includes(this.before) || (separator !== '\n' && separator !== ';')) {
            this.before = separator;
        }
        this.words = [];
    }
}
