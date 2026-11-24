import { tryAcquireSpriteLock } from '../../packages/core/src/agents/runtime/sprites/spritesLock.ts';

/**
 * A worker process competing for a Sprite's lock, for the lock tests:
 * `spritesLockContender.ts <lock file> <poll ms>`. It tries until it holds the
 * lock, prints `held`, and then keeps it until it is killed. With `once` in
 * place of the poll interval it tries a single time and prints `held` or `busy`.
 */
const [file, mode] = process.argv.slice(2);

if (mode === 'once') {
    const lock = tryAcquireSpriteLock(file);
    process.stdout.write(lock ? 'held\n' : 'busy\n');
    lock?.release();
} else {
    // Referenced for the life of the process: a lock nothing refers to is closed, and so freed, by garbage collection.
    let held: ReturnType<typeof tryAcquireSpriteLock>;
    const attempt = (): void => {
        held = tryAcquireSpriteLock(file);
        if (!held) return;
        clearInterval(timer);
        process.stdout.write('held\n');
        // Holds the lock (and stays alive) until the test kills it.
        setInterval(() => held, 1 << 30);
    };
    const timer = setInterval(attempt, Number(mode) || 5);
    process.stdout.write('ready\n');
}
