import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';

type IdentifyAck =
  | { ok: true; nickname: string; token: string; globalHistory: Array<{ room: string; nickname: string; body: string }> }
  | { ok: false; error: string };

function connect(url: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { forceNew: true });
    const timer = setTimeout(() => reject(new Error('connection timed out')), 2_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

function identify(socket: ClientSocket, nickname: string): Promise<IdentifyAck> {
  return new Promise((resolve) => socket.emit('identify', { nickname }, resolve));
}

function waitForParticipants(socket: ClientSocket): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('participants timed out')), 2_000);
    socket.on('participants', ({ room, participants }: { room: string; participants: string[] }) => {
      if (room === 'global' && participants.includes('alice') && participants.includes('bob')) {
        clearTimeout(timer);
        resolve(participants);
      }
    });
  });
}

function waitForGlobalMessage(socket: ClientSocket, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('global message timed out')), 2_000);
    socket.on('message', (message: { room: string; body: string }) => {
      if (message.room === 'global' && message.body === body) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

describe('global channel completeness', () => {
  const cleanup: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('provides prior global history and an identified global participant list to a new user', async () => {
    const { httpServer, io } = createChatServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    cleanup.push(() => new Promise<void>((resolve) => io.close(() => resolve())));
    const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

    const alice = await connect(url);
    cleanup.push(() => {
      alice.disconnect();
    });
    expect((await identify(alice, 'alice')).ok).toBe(true);
    const priorMessage = waitForGlobalMessage(alice, 'prior global message');
    alice.emit('message', { room: 'global', body: 'prior global message' });
    await priorMessage;

    const bob = await connect(url);
    cleanup.push(() => {
      bob.disconnect();
    });
    const participants = waitForParticipants(bob);
    const bobAck = await identify(bob, 'bob');
    if (!bobAck.ok) throw new Error(bobAck.error);

    expect(bobAck.globalHistory).toContainEqual({ room: 'global', nickname: 'alice', body: 'prior global message' });
    await expect(participants).resolves.toEqual(expect.arrayContaining(['alice', 'bob']));
  });
});
