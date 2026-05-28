import type { NextFunction, Request, Response } from 'express';
import { DEMO_MODE_READ_ONLY_CODE, parseTruthyEnvValue } from '@propr/shared';
import type { RedisClientType } from 'redis';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let configuredDemoMode: boolean | null = null;

export function isDemoMode(): boolean {
  return configuredDemoMode ?? parseTruthyEnvValue(process.env.PROPR_DEMO_MODE);
}

export function configureDemoMode(value: boolean = parseTruthyEnvValue(process.env.PROPR_DEMO_MODE)): boolean {
  configuredDemoMode = value;
  return value;
}

export function resetConfiguredDemoMode(): void {
  configuredDemoMode = null;
}

function readDemoModeFromEnvironment(): boolean {
  return parseTruthyEnvValue(process.env.PROPR_DEMO_MODE);
}

export function getDemoUser(): Express.User {
  return {
    id: 'demo',
    login: 'demo',
    username: 'demo',
    displayName: 'Demo User',
    email: null,
    avatarUrl: null,
  };
}

export function demoModeReadOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!(configuredDemoMode ?? readDemoModeFromEnvironment()) || !MUTATING_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  res.status(405).json({
    code: DEMO_MODE_READ_ONLY_CODE,
    error: 'Demo mode is read-only. Changes are not allowed.'
  });
}

type RedisValueType = 'string' | 'list' | 'set' | 'hash';
type RedisTransaction = {
  expire: (key: string, seconds: number) => RedisTransaction;
  del: (key: string) => RedisTransaction;
  exec: () => Promise<unknown[]>;
};

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function normalizeValues(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function normalizeKeys(keys: Array<string | string[]>): string[] {
  return keys.flatMap(key => Array.isArray(key) ? key : [key]);
}

export function createDemoRedisClient(): RedisClientType {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
  const expirations = new Map<string, number>();
  const keyTypes = new Map<string, RedisValueType>();
  const allKeys = (): string[] => Array.from(new Set([...strings.keys(), ...lists.keys(), ...sets.keys(), ...hashes.keys()]))
    .filter(key => !isExpired(key));
  const deleteKey = (key: string): boolean => {
    expirations.delete(key);
    keyTypes.delete(key);
    return strings.delete(key) || lists.delete(key) || sets.delete(key) || hashes.delete(key);
  };
  const isExpired = (key: string): boolean => {
    const expiresAt = expirations.get(key);
    if (expiresAt === undefined || expiresAt > Date.now()) return false;
    deleteKey(key);
    return true;
  };
  const hasKey = (key: string): boolean => !isExpired(key) && (strings.has(key) || lists.has(key) || sets.has(key));
  const markType = (key: string, type: RedisValueType): void => {
    keyTypes.set(key, type);
    if (type !== 'string') strings.delete(key);
    if (type !== 'list') lists.delete(key);
    if (type !== 'set') sets.delete(key);
    if (type !== 'hash') hashes.delete(key);
  };
  const listRange = (list: string[], start: number, stop: number): string[] => {
    const normalizedStart = start < 0 ? list.length + start : start;
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    const from = Math.max(normalizedStart, 0);
    const to = Math.min(normalizedStop, list.length - 1);
    if (from > to || from >= list.length || to < 0) return [];
    return list.slice(from, to + 1);
  };
  const getString = (key: string): string | null => {
    if (isExpired(key)) return null;
    return strings.get(key) ?? null;
  };
  const getHash = (key: string): Map<string, string> => {
    if (isExpired(key)) return new Map<string, string>();
    return hashes.get(key) ?? new Map<string, string>();
  };
  const expire = async (key: string, seconds: number): Promise<boolean> => {
    if (!hasKey(key)) return false;
    expirations.set(key, Date.now() + seconds * 1000);
    return true;
  };
  const del = async (...keys: Array<string | string[]>): Promise<number> => normalizeKeys(keys).reduce((count, key) => count + (deleteKey(key) ? 1 : 0), 0);
  const set = async (key: string, value: string | number, options?: { NX?: boolean; EX?: number } | string, ...args: Array<string | number>): Promise<string | null> => {
    const commandArgs = typeof options === 'string' ? [options, ...args] : args;
    const hasNx = (typeof options === 'object' && options?.NX === true) || commandArgs.map(String).some(arg => arg.toUpperCase() === 'NX');
    if (hasNx && hasKey(key)) return null;
    markType(key, 'string');
    strings.set(key, String(value));
    const objectTtl = typeof options === 'object' ? options.EX : undefined;
    const exIndex = commandArgs.map(String).findIndex(arg => arg.toUpperCase() === 'EX');
    const ttl = objectTtl ?? (exIndex >= 0 ? Number(commandArgs[exIndex + 1]) : undefined);
    if (ttl !== undefined && Number.isFinite(ttl)) expirations.set(key, Date.now() + Number(ttl) * 1000);
    else expirations.delete(key);
    return 'OK';
  };
  const setEx = async (key: string, seconds: number, value: string) => set(key, value, { EX: seconds });
  const evalScript = async (_script: string, options: { keys: string[]; arguments: string[] }): Promise<number> => {
    const [key] = options.keys;
    const [lockValue, seconds] = options.arguments;
    if (getString(key) !== lockValue) return 0;
    if (_script.includes('expire')) return (await expire(key, Number(seconds))) ? 1 : 0;
    if (_script.includes('del')) return (await del(key));
    return 0;
  };
  const multi = (): RedisTransaction => {
    const operations: Array<() => Promise<unknown>> = [];
    const transaction: RedisTransaction = {
      expire: (key: string, seconds: number) => { operations.push(() => expire(key, seconds)); return transaction; },
      del: (key: string) => { operations.push(() => del(key)); return transaction; },
      exec: async () => Promise.all(operations.map(operation => operation()))
    };
    return transaction;
  };
  const client = {
    connect: async () => undefined,
    quit: async () => 'OK',
    disconnect: async () => undefined,
    on: () => undefined,
    ping: async () => 'PONG',
    get: async (key: string) => getString(key),
    set,
    setEx,
    del,
    exists: async (...keys: Array<string | string[]>) => normalizeKeys(keys).filter(hasKey).length,
    expire,
    ttl: async (key: string) => {
      if (!hasKey(key)) return -2;
      const expiresAt = expirations.get(key);
      return expiresAt === undefined ? -1 : Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    },
    type: async (key: string) => hasKey(key) ? keyTypes.get(key) ?? 'none' : 'none',
    publish: async () => 0,
    lPush: async (key: string, value: string | string[]) => {
      markType(key, 'list');
      const list = lists.get(key) ?? [];
      list.unshift(...normalizeValues(value).reverse());
      lists.set(key, list);
      return list.length;
    },
    rPush: async (key: string, value: string | string[]) => {
      markType(key, 'list');
      const list = lists.get(key) ?? [];
      list.push(...normalizeValues(value));
      lists.set(key, list);
      return list.length;
    },
    lTrim: async (key: string, start: number, stop: number) => {
      const list = isExpired(key) ? [] : lists.get(key) ?? [];
      lists.set(key, listRange(list, start, stop));
      markType(key, 'list');
      return 'OK';
    },
    lRange: async (key: string, start: number, stop: number) => listRange(isExpired(key) ? [] : lists.get(key) ?? [], start, stop),
    sAdd: async (key: string, value: string | string[]) => {
      markType(key, 'set');
      const setValues = sets.get(key) ?? new Set<string>();
      let added = 0;
      for (const item of normalizeValues(value)) {
        if (!setValues.has(item)) added++;
        setValues.add(item);
      }
      sets.set(key, setValues);
      return added;
    },
    sRem: async (key: string, value: string | string[]) => {
      if (isExpired(key)) return 0;
      const setValues = sets.get(key) ?? new Set<string>();
      return normalizeValues(value).reduce((count, item) => count + (setValues.delete(item) ? 1 : 0), 0);
    },
    sMembers: async (key: string) => Array.from(isExpired(key) ? [] : sets.get(key) ?? []),
    sCard: async (key: string) => (isExpired(key) ? new Set() : sets.get(key) ?? new Set()).size,
    sIsMember: async (key: string, value: string) => (isExpired(key) ? false : sets.get(key)?.has(value) ?? false),
    hGet: async (key: string, field: string) => getHash(key).get(field) ?? null,
    hGetAll: async (key: string) => Object.fromEntries(getHash(key)),
    hKeys: async (key: string) => Array.from(getHash(key).keys()),
    hVals: async (key: string) => Array.from(getHash(key).values()),
    hLen: async (key: string) => getHash(key).size,
    hExists: async (key: string, field: string) => getHash(key).has(field),
    hSet: async (key: string, fieldOrValues: string | Record<string, string | number>, value?: string | number) => {
      markType(key, 'hash');
      const hash = hashes.get(key) ?? new Map<string, string>();
      const entries: Array<[string, string | number | undefined]> = typeof fieldOrValues === 'string'
        ? [[fieldOrValues, value]]
        : Object.entries(fieldOrValues);
      let added = 0;
      for (const [field, fieldValue] of entries) {
        if (!hash.has(field)) added++;
        hash.set(field, String(fieldValue ?? ''));
      }
      hashes.set(key, hash);
      return added;
    },
    hDel: async (key: string, fields: string | string[]) => {
      const hash = getHash(key);
      return normalizeValues(fields).reduce((count, field) => count + (hash.delete(field) ? 1 : 0), 0);
    },
    incr: async (key: string) => {
      const nextValue = Number.parseInt(getString(key) ?? '0', 10) + 1;
      await set(key, String(nextValue));
      return nextValue;
    },
    decr: async (key: string) => {
      const nextValue = Number.parseInt(getString(key) ?? '0', 10) - 1;
      await set(key, String(nextValue));
      return nextValue;
    },
    keys: async (pattern: string) => allKeys().filter(key => globToRegExp(pattern).test(key)),
    scan: async (cursor: number, options?: { MATCH?: string; COUNT?: number }) => {
      const matchingKeys = options?.MATCH ? allKeys().filter(key => globToRegExp(options.MATCH!).test(key)) : allKeys();
      const count = options?.COUNT ?? matchingKeys.length;
      const nextCursor = cursor + count >= matchingKeys.length ? 0 : cursor + count;
      return { cursor: nextCursor, keys: matchingKeys.slice(cursor, cursor + count) };
    },
    scanIterator: async function* (options?: { MATCH?: string }) {
      const matchingKeys = options?.MATCH ? allKeys().filter(key => globToRegExp(options.MATCH!).test(key)) : allKeys();
      yield* matchingKeys;
    },
    mGet: async (keys: string[]) => keys.map(key => getString(key)),
    lLen: async (key: string) => (isExpired(key) ? [] : lists.get(key) ?? []).length,
    lIndex: async (key: string, index: number) => {
      const list = isExpired(key) ? [] : lists.get(key) ?? [];
      const normalizedIndex = index < 0 ? list.length + index : index;
      return list[normalizedIndex] ?? null;
    },
    zRange: async () => [],
    zRevRange: async () => [],
    zCard: async () => 0,
    zScore: async () => null,
    eval: evalScript,
    watch: async () => undefined,
    unwatch: async () => undefined,
    multi,
  } as Record<string, unknown>;
  client.lpush = client.lPush;
  client.rpush = client.rPush;
  client.ltrim = client.lTrim;
  client.lrange = client.lRange;
  client.sadd = client.sAdd;
  client.srem = client.sRem;
  client.smembers = client.sMembers;
  client.scard = client.sCard;
  client.sismember = client.sIsMember;
  client.hget = client.hGet;
  client.hgetall = client.hGetAll;
  client.hkeys = client.hKeys;
  client.hvals = client.hVals;
  client.hlen = client.hLen;
  client.hexists = client.hExists;
  client.hset = client.hSet;
  client.hdel = client.hDel;
  client.mget = client.mGet;
  client.llen = client.lLen;
  client.lindex = client.lIndex;
  client.zrange = client.zRange;
  client.zrevrange = client.zRevRange;
  client.zcard = client.zCard;
  client.zscore = client.zScore;
  client.setex = setEx;
  const unsupportedRedisCommand = (command: string) => async () => {
    const lowerCommand = command.toLowerCase();
    if (lowerCommand.startsWith('get') || lowerCommand.startsWith('hget') || lowerCommand.startsWith('zrange')) return null;
    if (lowerCommand.startsWith('lrange') || lowerCommand.startsWith('smembers') || lowerCommand.startsWith('keys')) return [];
    if (lowerCommand.startsWith('exists') || lowerCommand.startsWith('llen') || lowerCommand.startsWith('scard') || lowerCommand.startsWith('zcard')) return 0;
    throw new Error(`Demo Redis facade blocks unsupported Redis command "${command}". Add explicit support before using this route in demo mode.`);
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string' || prop === 'then') return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      return unsupportedRedisCommand(prop);
    }
  }) as unknown as RedisClientType;
}
