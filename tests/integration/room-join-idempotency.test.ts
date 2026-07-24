import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';

type JoinAck = { ok: true; history: unknown[] } | { ok: false; error: string };

function join(socket: Socket, room: string, nickname: string): Promise<JoinAck> {
  return new Promise((resolve) => socket.emit('join', { room, nickname }, resolve));
}

describe('room join idempotency', () => {
  const cleanup: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()?.();
  });

  it('does not duplicate a participant when the same socket retries join', async () => {
    const { httpServer, io } = createChatServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    cleanup.push(() => new Promise<void>((resolve) => io.close(() => resolve())));
    const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
    const alice = ioClient(url, { forceNew: true });
    const bob = ioClient(url, { forceNew: true });
    cleanup.push(() => { alice.disconnect(); });
    cleanup.push(() => { bob.disconnect(); });

    expect((await join(alice, 'retry-room', 'alice')).ok).toBe(true);
    expect((await join(alice, 'retry-room', 'alice')).ok).toBe(true);

    const participants = new Promise<string[]>((resolve) => {
      alice.on('participants', ({ room, participants: names }) => {
        if (room === 'retry-room') resolve(names);
      });
    });
    expect((await join(bob, 'retry-room', 'bob')).ok).toBe(true);
    await expect(participants).resolves.toEqual(['alice', 'bob']);
  });
});
