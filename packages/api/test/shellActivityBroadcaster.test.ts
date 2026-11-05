import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { closeConnection } from '@propr/core';
import { ShellActivityBroadcaster } from '../services/shellActivityBroadcaster.js';
import { ACTIVITY_ROOM } from '../services/activitySocketRooms.js';

after(async () => closeConnection());

function client(permissions: string[], subscribed = true) {
  const frames: Array<{ event: string; payload: { resource: string; data: unknown } }> = [];
  return {
    frames,
    rooms: new Set(subscribed ? [ACTIVITY_ROOM] : []),
    data: { principal: { authorization: { permissions, source: 'local' } } },
    emit(event: string, payload: { resource: string; data: unknown }) { frames.push({ event, payload }); },
  };
}

test('pushes changed projections once with the HTTP usage permission boundary', async () => {
  const admin = client(['instance.manage_agents']);
  const reader = client([]);
  const unsubscribed = client(['instance.manage_agents'], false);
  const io = {
    sockets: { adapter: { rooms: new Map([[ACTIVITY_ROOM, new Set(['admin', 'reader'])]]) },
      sockets: new Map([['admin', admin], ['reader', reader], ['unsubscribed', unsubscribed]]) },
    to: () => ({ emit() {} }),
  } as unknown as Server;
  let workerCount = 1;
  const broadcaster = new ShellActivityBroadcaster(io,
    async () => ({ workerCount, timestamp: new Date().toISOString(), routingHeartbeat: Math.random() }),
    async () => ({ enabled: false }));
  await broadcaster.sample();
  assert.deepEqual(admin.frames.map(frame => frame.payload.resource).sort(), ['system', 'usage']);
  assert.deepEqual(reader.frames.map(frame => frame.payload.resource), ['system']);
  assert.equal(unsubscribed.frames.length, 0);
  for (let index = 0; index < 20; index++) await broadcaster.sample();
  assert.equal(admin.frames.length, 2, 'timestamps and diagnostics do not wake browsers');
  workerCount = 2;
  await broadcaster.sample();
  assert.equal(admin.frames.length, 3);
  assert.equal((admin.frames[2].payload.data as { workerCount: number }).workerCount, 2);
  broadcaster.close();
  workerCount = 3;
  await broadcaster.sample();
  assert.equal(admin.frames.length, 3);
});
