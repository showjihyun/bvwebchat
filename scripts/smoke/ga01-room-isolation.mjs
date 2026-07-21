// 스모크 GA-01 (RQ-02 room 격리) — 배포된 인스턴스에 대해 실행.
// user1·user2는 room-A, user3는 room-B. user1이 room-A에 보낸 메시지를
// user2는 받고 user3는 절대 받지 않는다. 새 테스트가 아니라 골든의 프로덕션 승격.
import { io } from 'socket.io-client';

const BASE_URL = process.argv[2];
if (!BASE_URL) {
  console.error('[GA-01] BASE_URL 인자 필요');
  process.exit(2);
}

const connect = () => io(BASE_URL, { transports: ['websocket'], forceNew: true });
const join = (sock, room, nickname) =>
  new Promise((res, rej) => {
    sock.emit('join', { room, nickname }, (ack) => (ack?.ok ? res() : rej(new Error(`join 실패: ${room}`))));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fail = (msg) => {
  console.error(`[GA-01] FAIL — ${msg}`);
  process.exit(1);
};

const run = async () => {
  const user1 = connect();
  const user2 = connect();
  const user3 = connect();
  const sockets = [user1, user2, user3];

  await Promise.all(
    sockets.map((s) => new Promise((res, rej) => {
      s.on('connect', res);
      s.on('connect_error', (e) => rej(new Error(`connect_error: ${e.message}`)));
    })),
  );

  await join(user1, 'room-A', 'user1');
  await join(user2, 'room-A', 'user2');
  await join(user3, 'room-B', 'user3');

  let user2Got = null;
  let user3Leaked = false;
  user2.on('message', (m) => { if (m.room === 'room-A' && m.body === 'smoke-hello') user2Got = m; });
  user3.on('message', (m) => { if (m.room === 'room-A') user3Leaked = true; });

  user1.emit('message', { room: 'room-A', body: 'smoke-hello' });
  await wait(700);

  sockets.forEach((s) => s.close());

  if (!user2Got) fail('room-A 참여자 user2가 메시지를 받지 못했다');
  if (user3Leaked) fail('room-B의 user3에게 room-A 메시지가 누출됐다 (격리 위반)');
  console.log('[GA-01] PASS — room 격리 정상 (user2 수신, user3 미수신)');
  process.exit(0);
};

run().catch((e) => fail(e.message));
