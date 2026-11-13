/**
 * The atomic admission script. KEYS: holders hash, config, parent scopes hash
 * (`scope -> holder token`). ARGV: op, token, lease ms, extra (configuration
 * identity or container ID), global limit, alias, alias ceiling, parent scope,
 * scope to register, maximum nesting depth, nested executions per parent.
 *
 * Records NEVER expire. Expiry permits fencing and Docker removal, not reuse.
 * All clock comparisons use Redis TIME. Each reservation has a unique token.
 *
 * Holder record fields: `state` (reserved | running | draining | recovering),
 * `deadline`, `id` (immutable container ID), `alias`, and for nesting:
 * `parent` (the parent's token), `depth`, `shared` (charged under the parent's
 * slot of the same alias) and `scope` (the scope this holder registered).
 *
 * Acquire replies: -1 configuration missing, 0 a holder is recovering,
 * 1 admitted, 2 global limit, 3 alias ceiling, 4 admitted as nested,
 * 5 nesting depth exceeded, 6 nested count exceeded, 7 nested cross-alias ceiling refusal.
 *
 * Fence replies: 0 unknown holder, 2 finished normally while nested executions
 * run (now draining), otherwise {1, nested token, nested container ID, ...}
 * listing every nested execution fenced with it.
 */
export const ADMISSION_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local op, token = ARGV[1], ARGV[2]
local function records()
  local list = {}
  local all = redis.call('HGETALL', KEYS[1])
  for i=1,#all,2 do table.insert(list, {all[i], cjson.decode(all[i+1])}) end
  return list
end
local function children(list, parent)
  local n = 0
  for _,e in ipairs(list) do if e[2].parent == parent then n = n + 1 end end
  return n
end
-- Only a live holder can carry nested executions or keep its registered scope.
local function live(r) return r.state ~= 'recovering' and r.state ~= 'draining' and r.deadline > now end
local function forgetScope(r, owner)
  if r.scope and redis.call('HGET', KEYS[3], r.scope) == owner then redis.call('HDEL', KEYS[3], r.scope) end
end
if op == 'acquire' then
  local config = redis.call('GET', KEYS[2])
  if not config then return -1 end
  if config ~= ARGV[4] then return redis.error_reply('Agent admission configuration/daemon mismatch; drain before reconfiguration') end
  -- ARGV[6] is the direct agent alias ('' when unattributed) and ARGV[7] its
  -- ceiling ('' when none). Holders without an alias (written before alias
  -- support, or exempt launches) count toward the global limit only.
  local alias, ceiling = ARGV[6] or '', tonumber(ARGV[7] or '')
  local scope, register = ARGV[8] or '', ARGV[9] or ''
  local list = records()
  local parentToken, parent
  if scope ~= '' then
    local candidate = redis.call('HGET', KEYS[3], scope)
    local value = candidate and redis.call('HGET', KEYS[1], candidate)
    if value then
      local r = cjson.decode(value)
      if live(r) then parentToken, parent = candidate, r end
    end
  end
  local top, same = 0, 0
  for _,e in ipairs(list) do
    local r = e[2]
    -- A recovering holder still counts (globally and for its alias) until
    -- its removal is confirmed; nothing is admitted meanwhile.
    if r.state == 'recovering' then return 0 end
    -- Nested executions are charged under their parent's global slot.
    if not r.parent then top = top + 1 end
    if alias ~= '' and r.alias == alias and not r.shared then same = same + 1 end
  end
  local record = {deadline=now+tonumber(ARGV[3]), state='reserved'}
  if alias ~= '' then record.alias = alias end
  local result = 1
  if parent then
    local depth = (parent.depth or 0) + 1
    if depth > tonumber(ARGV[10]) then return 5 end
    if children(list, parentToken) >= tonumber(ARGV[11]) then return 6 end
    record.parent = parentToken
    record.depth = depth
    -- Same alias: charged under the parent's slot. Another alias: that alias's ceiling applies.
    if alias ~= '' and parent.alias == alias then record.shared = true
    elseif ceiling and same >= ceiling then return 7 end
    result = 4
  else
    if top >= tonumber(ARGV[5]) then return 2 end
    if ceiling and same >= ceiling then return 3 end
  end
  if register ~= '' then
    local current = redis.call('HGET', KEYS[3], register)
    local holder = current and redis.call('HGET', KEYS[1], current)
    if not holder or not live(cjson.decode(holder)) then
      redis.call('HSET', KEYS[3], register, token)
      record.scope = register
    end
  end
  redis.call('HSET', KEYS[1], token, cjson.encode(record))
  return result
end
if op == 'initialize' then
  return redis.call('SET', KEYS[2], ARGV[4], 'NX')
end
if op == 'expired' then
  local config = redis.call('GET', KEYS[2])
  if config and config ~= ARGV[4] then
    local old, next = cjson.decode(config), cjson.decode(ARGV[4])
    -- The daemon identity includes the admission protocol. Legacy recovery
    -- performs this same comparison, so it cannot recover nested-v1 holders,
    -- even with a higher generation. Protocol changes require a stopped drain.
    if old.daemon ~= next.daemon or (next.generation or 0) <= (old.generation or 0) then
      return redis.error_reply('Agent admission configuration/daemon mismatch; stale generation or unsupported daemon change')
    end
    -- The new operator generation fences every reservation atomically with the
    -- config change. No capacity is reusable until removal is confirmed below.
    local all = redis.call('HGETALL', KEYS[1])
    for i=1,#all,2 do
      local r = cjson.decode(all[i+1]); r.state = 'recovering'
      redis.call('HSET', KEYS[1], all[i], cjson.encode(r))
    end
    redis.call('SET', KEYS[2], ARGV[4])
  end
  if not config and redis.call('HLEN', KEYS[1]) > 0 then return redis.error_reply('Agent admission configuration missing; drain before recovery') end
  local list = records()
  local parents, fenced = {}, {}
  for _,e in ipairs(list) do if e[2].parent then parents[e[2].parent] = true end end
  for _,e in ipairs(list) do
    local r = e[2]
    -- A finished parent keeps its slot while its nested executions run.
    if r.state == 'draining' then
      if not parents[e[1]] then fenced[e[1]] = true end
    elseif r.deadline <= now or r.state == 'recovering' then
      fenced[e[1]] = true
    end
  end
  -- A nested execution never outlives the fencing of its parent.
  for _,e in ipairs(list) do if e[2].parent and fenced[e[2].parent] then fenced[e[1]] = true end end
  -- Nested executions first: a parent is released only after them.
  local first, last = {}, {}
  for _,e in ipairs(list) do
    if fenced[e[1]] then
      local r = e[2]
      r.state = 'recovering'
      redis.call('HSET', KEYS[1], e[1], cjson.encode(r))
      local target = last
      if r.parent then target = first end
      table.insert(target, e[1]); table.insert(target, r.id or '')
    end
  end
  for _,v in ipairs(last) do table.insert(first, v) end
  return first
end
local value = redis.call('HGET', KEYS[1], token)
if not value then return 0 end
local r = cjson.decode(value)
if op == 'release' then
  if r.state ~= 'recovering' then return 0 end
  local list = records()
  -- The parent's reservation outlives every nested execution charged under it.
  if children(list, token) > 0 then return 0 end
  redis.call('HDEL', KEYS[1], token)
  forgetScope(r, token)
  if r.parent then
    local pv = redis.call('HGET', KEYS[1], r.parent)
    if pv then
      local p = cjson.decode(pv)
      -- The last nested execution of a finished parent hands its slot back.
      if p.state == 'draining' and children(list, r.parent) <= 1 then
        p.state = 'recovering'
        redis.call('HSET', KEYS[1], r.parent, cjson.encode(p))
        return {1, r.parent, p.id or '', p.alias or ''}
      end
    end
  end
  return 1
end
if op == 'fence' then
  local list = records()
  if live(r) and children(list, token) > 0 then
    -- Normal completion with nested executions still running: the slot stays
    -- charged (draining) and no further nested execution can join it.
    r.state = 'draining'
    forgetScope(r, token)
    redis.call('HSET', KEYS[1], token, cjson.encode(r))
    return 2
  end
  r.state = 'recovering'
  -- Reply {1, nested token, nested container ID, ...}: the caller removes and
  -- releases those nested executions before its own container.
  local fenced = {1}
  for _,e in ipairs(list) do
    if e[2].parent == token then
      if e[2].state ~= 'recovering' then
        e[2].state = 'recovering'
        redis.call('HSET', KEYS[1], e[1], cjson.encode(e[2]))
      end
      table.insert(fenced, e[1]); table.insert(fenced, e[2].id or '')
    end
  end
  r.deadline = now + tonumber(ARGV[3])
  redis.call('HSET', KEYS[1], token, cjson.encode(r))
  return fenced
elseif r.state == 'recovering' or r.state == 'draining' or r.deadline <= now then
  return 0
elseif op == 'attach' then
  if r.id then return 0 end
  r.id = ARGV[4]; r.state = 'running'
elseif op ~= 'renew' then
  return redis.error_reply('Unknown admission operation')
end
r.deadline = now + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], token, cjson.encode(r))
return 1
`;
