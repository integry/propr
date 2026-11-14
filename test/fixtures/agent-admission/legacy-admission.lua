-- Pre-nesting script from 04e8a0dea^, retained verbatim for mixed-version regressions.

local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local op, token = ARGV[1], ARGV[2]
if op == 'acquire' then
  local config = redis.call('GET', KEYS[2])
  if not config then return -1 end
  if config ~= ARGV[4] then return redis.error_reply('Agent admission configuration/daemon mismatch; drain before reconfiguration') end
  -- ARGV[6] is the direct agent alias ('' when unattributed) and ARGV[7] its
  -- ceiling ('' when none). Holders without an alias (written before alias
  -- support, or exempt launches) count toward the global limit only.
  local alias, ceiling = ARGV[6] or '', tonumber(ARGV[7] or '')
  local same = 0
  local all = redis.call('HVALS', KEYS[1])
  for _,value in ipairs(all) do
    local r = cjson.decode(value)
    -- A recovering holder still counts (globally and for its alias) until
    -- its removal is confirmed; nothing is admitted meanwhile.
    if r.state == 'recovering' then return 0 end
    if alias ~= '' and r.alias == alias then same = same + 1 end
  end
  if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[5]) then return 2 end
  if ceiling and same >= ceiling then return 3 end
  local record = {deadline=now+tonumber(ARGV[3]), state='reserved'}
  if alias ~= '' then record.alias = alias end
  redis.call('HSET', KEYS[1], token, cjson.encode(record))
  return 1
end
if op == 'initialize' then
  return redis.call('SET', KEYS[2], ARGV[4], 'NX')
end
if op == 'expired' then
  local config = redis.call('GET', KEYS[2])
  if config and config ~= ARGV[4] then
    local old, next = cjson.decode(config), cjson.decode(ARGV[4])
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
  local result = {}
  local all = redis.call('HGETALL', KEYS[1])
  for i=1,#all,2 do
    local r = cjson.decode(all[i+1])
    if r.deadline <= now or r.state == 'recovering' then
      r.state = 'recovering'
      redis.call('HSET', KEYS[1], all[i], cjson.encode(r))
      table.insert(result, all[i]); table.insert(result, r.id or '')
    end
  end
  return result
end
local value = redis.call('HGET', KEYS[1], token)
if not value then return 0 end
local r = cjson.decode(value)
if op == 'release' then
  if r.state ~= 'recovering' then return 0 end
  return redis.call('HDEL', KEYS[1], token)
end
if op == 'fence' then
  r.state = 'recovering'
elseif r.state == 'recovering' or r.deadline <= now then
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
