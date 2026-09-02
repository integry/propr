import path from 'node:path';
import type {
    NativeGoalSessionRecord,
    NativeGoalWorktree,
    NativeGoalWritableMount,
    StartNativeGoalOptions,
} from './nativeGoalTypes.js';
import { NativeGoalSessionError } from './nativeGoalErrors.js';

export function worktreesEqual(
    left: NativeGoalSessionRecord['worktree'],
    right: NativeGoalSessionRecord['worktree'],
): boolean {
    return left.hostPath === right.hostPath
        && left.containerPath === right.containerPath
        && left.repository === right.repository
        && left.branch === right.branch;
}

function absolute(value: string, label: string): string {
    if (!path.isAbsolute(value)) throw new NativeGoalSessionError(`${label} must be an absolute path`);
    return path.resolve(value);
}

function pathsOverlap(left: string, right: string): boolean {
    const relative = path.relative(left, right);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function validateAndNormalizeStart(options: StartNativeGoalOptions): {
    worktree: NativeGoalWorktree;
    writableMounts: NativeGoalWritableMount[];
} {
    if (!options.goalId.trim()) throw new NativeGoalSessionError('Goal ID must not be empty');
    if (!options.objective.trim()) throw new NativeGoalSessionError('Goal objective must not be empty');
    if (!options.image.trim()) throw new NativeGoalSessionError('Goal container image must not be empty');
    const worktree = {
        ...options.worktree,
        hostPath: absolute(options.worktree.hostPath, 'Worktree host path'),
        containerPath: absolute(options.worktree.containerPath, 'Worktree container path'),
    };
    const names = new Set<string>();
    const targets = new Set<string>([worktree.containerPath]);
    const hostPaths = [worktree.hostPath];
    const writableMounts = options.writableMounts.map(mount => {
        const normalized = {
            ...mount,
            hostPath: absolute(mount.hostPath, `Writable mount '${mount.name}' host path`),
            containerPath: absolute(mount.containerPath, `Writable mount '${mount.name}' container path`),
        };
        if (!mount.name.trim() || names.has(mount.name)) {
            throw new NativeGoalSessionError('Writable mount names must be non-empty and unique');
        }
        if (targets.has(normalized.containerPath)) {
            throw new NativeGoalSessionError(`Duplicate container mount target '${normalized.containerPath}'`);
        }
        if (hostPaths.some(existing => pathsOverlap(existing, normalized.hostPath) || pathsOverlap(normalized.hostPath, existing))) {
            throw new NativeGoalSessionError(`Overlapping goal host mount '${normalized.hostPath}'`);
        }
        names.add(mount.name);
        targets.add(normalized.containerPath);
        hostPaths.push(normalized.hostPath);
        return normalized;
    });
    return { worktree, writableMounts };
}
