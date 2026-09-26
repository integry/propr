/** Route history belongs to one authenticated connection, never the Electron document. */
export class NativeNavigationHistory {
  private paths: string[] = [];
  private index = -1;

  record(path: string): void {
    if (path === this.paths[this.index]) return;
    this.paths.splice(this.index + 1, Infinity, path);
    this.index = this.paths.length - 1;
  }

  target(direction: 'back' | 'forward'): string | undefined {
    return this.paths[this.index + (direction === 'back' ? -1 : 1)];
  }

  move(direction: 'back' | 'forward'): string | undefined {
    const target = this.target(direction);
    if (target !== undefined) this.index += direction === 'back' ? -1 : 1;
    return target;
  }

  get state(): { canGoBack: boolean; canGoForward: boolean } {
    return { canGoBack: this.index > 0, canGoForward: this.index + 1 < this.paths.length };
  }
}
