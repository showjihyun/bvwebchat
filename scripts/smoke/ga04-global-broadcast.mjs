// 스모크 GA-04 (RQ-04 global 전파) — 배포된 인스턴스에 대해 실행.
// user1은 room-A, user2는 room-B, user3는 room 미참여(전원 접속). user1이
// global에 보낸 메시지를 user2·user3 모두 받는다. 골든의 프로덕션 승격.
import { io } from 'socket.io-client';

const BASE_URL = process.argv[2];
if (!BASE_URL) {
  console.error('[GA-04] BASE_URL 인자 필요');
  process.exit(2);
}

const GLOBAL_ROOM = 'global';
const connect = () => io(BASE_URL, { transports: ['websocket'], forceNew: true });
const join = (sock, room, nickname) =>
  new Promise((res, rej) => {
    sock.emit('join', { room, nickname }, (ack) => (ack?.ok ? res() : rej(new Error(`join 실패: ${room}`))));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fail = (msg) => {
  console.error(`[GA-04] FAIL — ${msg}`);
  process.exit(1);
};

const run = async () => {
  const user1 = connect();
  const user2 = connect();
  const user3 = connect(); // room 미참여 — global 자동 참여만
  const sockets = [user1, user2, user3];

  await Promise.all(
    sockets.map((s) => new Promise((res, rej) => {
      s.on('connect', res);
      s.on('connect_error', (e) => rej(new Error(`connect_error: ${e.message}`)));
    })),
  );

  await join(user1, 'room-A', 'user1');
  await join(user2, 'room-B', 'user2');

  let user2Got = false;
  let user3Got = false;
  user2.on('message', (m) => { if (m.room === GLOBAL_ROOM && m.body === 'smoke-global') user2Got = true; });
  user3.on('message', (m) => { if (m.room === GLOBAL_ROOM && m.body === 'smoke-global') user3Got = true; });

  user1.emit('message', { room: GLOBAL_ROOM, body: 'smoke-global' });
  await wait(700);

  sockets.forEach((s) => s.close());

  if (!user2Got) fail('room-B의 user2가 global 메시지를 받지 못했다');
  if (!user3Got) fail('room 미참여 user3가 global 메시지를 받지 못했다');
  console.log('[GA-04] PASS — global 전파 정상 (room 참여자·미참여자 모두 수신)');
  process.exit(0);
};

run().catch((e) => fail(e.message));
