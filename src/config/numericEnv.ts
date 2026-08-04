interface BoundedIntegerOptions {
    fallback: number;
    min: number;
    max: number;
}

/** Reads an integer environment value without allowing unsafe timer/TTL ranges. */
export function readBoundedIntegerEnv(name: string, options: BoundedIntegerOptions): number {
    const value = Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
        return options.fallback;
    }
    return value;
}
