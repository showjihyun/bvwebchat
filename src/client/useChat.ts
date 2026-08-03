import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { GLOBAL_ROOM, type ChatMessage } from '../shared/types';

// 서버 계약(src/server/createChatServer.ts)과 동일한 이벤트 shape.
interface ServerToClientEvents {
  message: (payload: ChatMessage) => void;
  // 참여자 변경(join/leave/disconnect) 시 서버가 room 멤버에게 방송 (RQ-15).
  // 서버는 founding(0→1) 최초 join은 방송하지 않으므로, 혼자인 사용자의
  // "본인만" 목록은 클라이언트가 join 시 seed한다 (아래 joinRoom).
  participants: (payload: { room: string; participants: string[] }) => void;
  // 존재하는 모든 room의 목록 (RQ-13). global 상시 포함(ADR-0004), user room은
  // 멤버≥1인 것만, 변화 시 전 접속자에게 방송 + 신규 접속 시 초기 전달.
  rooms: (payload: { rooms: string[] }) => void;
  // 안 읽음 개수 유니캐스트 (RQ-18) — 이 세션 소켓에만. 비활성 room에 메시지
  // 도착 시 +1(상한 50), 활성 전환 시 0.
  unread: (payload: { room: string; count: number }) => void;
}
type IdentifyAck = { ok: true; nickname: string; token: string } | { ok: false; error: string };
type ResumeAck =
  | { ok: true; nickname: string; rooms: string[]; activeRoom: string | null; unread: Record<string, number> }
  | { ok: false; error: string };
type ActiveRoomAck = { ok: true } | { ok: false; error: string };
interface ClientToServerEvents {
  // RQ-10/RQ-18: 닉네임 제출 → 서버가 세션 토큰 발급(ADR-0003 결정1).
  identify: (payload: { nickname: string }, ack: (result: IdentifyAck) => void) => void;
  // RQ-18: 유예(30초) 내 토큰 제시로 세션(참여 room·활성 room·안읽음) 복원(ADR-0003 결정5).
  resume: (payload: { token: string }, ack: (result: ResumeAck) => void) => void;
  // RQ-18: 현재 보고 있는 room 통지(ADR-0003 결정4). 미참여 room이면 서버가 거부.
  activeRoom: (payload: { room: string }, ack: (result: ActiveRoomAck) => void) => void;
  join: (
    payload: { room: string; nickname: string },
    // ack.history: 입장 시점의 room 히스토리 (최근 50개, RQ-11).
    ack: (result: { ok: true; history: ChatMessage[] } | { ok: false; error: string }) => void,
  ) => void;
  message: (payload: { room: string; body: string }) => void;
}
type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 화면 렌더용 메시지 — 서버 payload + 클라이언트 수신 시각·키.
 *  (서버 ChatMessage에는 타임스탬프가 없다 — RQ-01 계약. 수신 시각은 클라이언트 기준.) */
export interface ClientMessage {
  id: string;
  room: string;
  nickname: string;
  body: string;
  at: number;
}

export type ConnStatus = 'connecting' | 'connected' | 'reconnecting';

// RQ-18/ADR-0003: 세션 토큰을 localStorage에 보관 — 새로고침·재연결 시 resume에 제시.
// RQ-10-a: App이 마운트 시점에 토큰 존재 여부를 먼저 판정해야 하므로 export한다
// (진입 화면을 건너뛸지는 이 키의 존재로 결정 — 별도 닉네임 키를 추가하지 않는다).
export const TOKEN_KEY = 'bvwebchat.sessionToken';

let msgSeq = 0;

export interface ChatState {
  /** 서버가 확정한 본인 닉네임 (RQ-10-a: resume 성공 시 ack의 nickname으로 갱신된다 —
   *  App이 넘긴 초기값과 다를 수 있다, 예: 세션 복원 시 진입 화면 없이 서버 값을 그대로 쓴다). */
  nickname: string;
  status: ConnStatus;
  rooms: string[];
  activeRoom: string | null;
  messagesByRoom: Record<string, ClientMessage[]>;
  participantsByRoom: Record<string, string[]>;
  availableRooms: string[];
  unreadByRoom: Record<string, number>;
  joinRoom: (room: string) => void;
  setActiveRoom: (room: string) => void;
  sendMessage: (body: string) => void;
}

/**
 * 클라이언트 채팅 상태 (RQ-01 슬라이스 + RQ-11 히스토리).
 * - 소켓 재연결 시 참여 중이던 room을 전부 재join한다 (서버 멤버십은 소켓 연결
 *   단위이므로 재연결 = 새 소켓 = 재등록 필요).
 * - 최초 room 참여 시 join ack의 히스토리(최근 50개, RQ-11)를 기존 앞에 prepend.
 *   재연결 재join은 이미 화면에 있는 메시지와 중복을 피해 히스토리를 무시한다.
 * - 참여자 목록(RQ-15): `participants` 방송을 room별로 반영.
 * - 존재 room 목록(RQ-13): `rooms` 방송을 availableRooms로 반영(참여 모달의 디렉토리).
 * - 세션·안 읽음(RQ-18/ADR-0003): 접속 시 identify로 세션 토큰 발급(localStorage 보관),
 *   재연결·새로고침 시 resume으로 세션(참여 room·활성·안읽음) 복원. room 열람 시
 *   activeRoom 통지 → 그 room 안읽음 0. `unread` 방송을 unreadByRoom(숫자 배지)로 반영.
 *   (새로고침 시 메시지 히스토리 재생은 범위 밖 — resume은 세션 상태만 복원.)
 * - RQ-10-a: `nickname`이 null이면 "닉네임 미확정, 유효한 세션 토큰이 있어 resume으로
 *   확정해야 한다"는 뜻이다(App이 이 경우에만 null을 넘긴다 — 토큰이 없는데 null인
 *   경우는 없다). resume이 성공하면 ack의 nickname을 본인 닉네임으로 채택해
 *   `ChatState.nickname`에 반영한다. resume이 실패하면(유예 만료·무효 토큰) identify로
 *   자동 전환할 근거(사용자가 입력한 닉네임)가 없으므로 `onResumeFail`을 호출해 App이
 *   진입 화면으로 되돌리게 한다 — 여기서 빈 문자열 등으로 임의 identify를 시도하지
 *   않는다(그러면 폴백 경로를 잃고 사실상 영구 로그인이 된다, 팀리드 지시).
 */
export function useChat(nickname: string | null, onResumeFail?: () => void): ChatState {
  const socketRef = useRef<ChatSocket | null>(null);
  const roomsRef = useRef<string[]>([]);
  // activeRoom을 ref로 미러링 — sendMessage가 상태 업데이터(순수해야 함) 밖에서
  // 현재 room을 읽어 emit하기 위함. StrictMode 이중 호출로 인한 중복 전송 방지.
  const activeRoomRef = useRef<string | null>(null);
  // RQ-10-a: 본인 닉네임. App이 넘긴 초기값(닉네임 미확정이면 '')에서 시작해
  // resume 성공 시 서버 ack 값으로 교체된다 — 화면 표시(ChatPane/ParticipantList의
  // "나" 배지)는 항상 이 상태를 본다, App이 넘긴 원래 prop이 아니라.
  const [selfNickname, setSelfNickname] = useState<string>(nickname ?? '');
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [rooms, setRooms] = useState<string[]>([]);
  const [activeRoom, setActiveRoomState] = useState<string | null>(null);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ClientMessage[]>>({});
  const [participantsByRoom, setParticipantsByRoom] = useState<Record<string, string[]>>({});
  const [availableRooms, setAvailableRooms] = useState<string[]>([]);
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});

  useEffect(() => {
    // Vite proxy(/socket.io → :3001)를 통해 same-origin으로 접속.
    const socket: ChatSocket = io({ autoConnect: true });
    socketRef.current = socket;

    // activeNickname을 인자로 받는다(클로저의 nickname prop을 직접 쓰지 않음) — 이 함수는
    // identifyFresh 안에서 null-narrowing된 뒤에만 호출되므로 타입도 string으로 좁혀진다.
    const rejoinAll = (activeNickname: string) => {
      for (const room of roomsRef.current) {
        socket.emit('join', { room, nickname: activeNickname }, () => undefined);
      }
    };

    // RQ-18/ADR-0003: 새 세션 발급 — 닉네임 identify → 토큰 저장 → 참여 room 복원.
    // RQ-10-a: nickname이 null이면(App이 세션 복원 중이라 아직 확정된 닉네임이 없음을
    // 뜻함) 빈 값으로 identify를 시도하지 않는다 — 대신 onResumeFail로 App에 알려
    // 진입 화면을 띄우게 한다(팀리드 지시: 임의 identify는 폴백 경로를 없애 사실상
    // 영구 로그인이 된다).
    const identifyFresh = () => {
      if (nickname === null) {
        onResumeFail?.();
        return;
      }
      socket.emit('identify', { nickname }, (res) => {
        if (res.ok) localStorage.setItem(TOKEN_KEY, res.token);
        rejoinAll(nickname); // 최초 연결은 no-op, 재연결/토큰만료 폴백 시 참여 room 재등록
      });
    };

    socket.on('connect', () => {
      setStatus('connected');
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        // 유예(30초) 내 재연결·새로고침: 토큰으로 세션(참여 room·활성·안읽음) 복원.
        socket.emit('resume', { token }, (res) => {
          if (!res.ok) {
            // 유예 만료·무효 토큰 → 새 세션 발급으로 폴백(닉네임 미확정이면 identifyFresh가
            // 대신 onResumeFail을 호출한다).
            localStorage.removeItem(TOKEN_KEY);
            identifyFresh();
            return;
          }
          // resume이 서버측 room 재합류를 수행하므로 rejoinAll을 다시 하지 않는다.
          const restored = res.rooms.filter((r) => r !== GLOBAL_ROOM);
          roomsRef.current = restored;
          setRooms(restored);
          setUnreadByRoom(res.unread);
          for (const room of restored) {
            setMessagesByRoom((prev) => (prev[room] ? prev : { ...prev, [room]: [] }));
          }
          if (res.activeRoom) {
            // selectRoom은 아래에서 정의되므로 ref/setter를 인라인(활성 room 통지는 이미 서버에 복원됨).
            activeRoomRef.current = res.activeRoom;
            setActiveRoomState(res.activeRoom);
          }
          // RQ-10-a: 서버가 확정한 본인 닉네임을 채택 — App이 넘긴 초기값과 다를 수 있다.
          setSelfNickname(res.nickname);
        });
      } else {
        identifyFresh();
      }
    });
    socket.on('disconnect', () => setStatus('reconnecting'));
    socket.io.on('reconnect_attempt', () => setStatus('reconnecting'));

    socket.on('message', (payload) => {
      msgSeq += 1;
      const msg: ClientMessage = {
        id: `m${msgSeq}`,
        room: payload.room,
        nickname: payload.nickname,
        body: payload.body,
        at: Date.now(),
      };
      setMessagesByRoom((prev) => ({
        ...prev,
        [msg.room]: [...(prev[msg.room] ?? []), msg],
      }));
    });

    socket.on('participants', (payload) => {
      // 서버가 보낸 목록이 권위 있는 상태 — seed/이전 값을 대체.
      setParticipantsByRoom((prev) => ({ ...prev, [payload.room]: payload.participants }));
    });

    socket.on('rooms', (payload) => {
      // 존재 room 목록(RQ-13) — 서버가 유일 권위. 접속 시 초기 + 변화 시 방송.
      setAvailableRooms(payload.rooms);
    });

    socket.on('unread', (payload) => {
      // 안 읽음 개수(RQ-18) — 서버가 유일 권위(비활성 +1 / 활성 전환 0).
      setUnreadByRoom((prev) => ({ ...prev, [payload.room]: payload.count }));
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [nickname]);

  const selectRoom = useCallback((room: string) => {
    activeRoomRef.current = room;
    setActiveRoomState(room);
    // RQ-18: 열람 중인 room을 서버에 통지 → 그 room 안읽음 0 초기화(서버가 unread로 회신).
    // 낙관적으로 로컬도 0 처리(서버 회신 전 배지 즉시 제거).
    socketRef.current?.emit('activeRoom', { room }, () => undefined);
    setUnreadByRoom((prev) => (prev[room] ? { ...prev, [room]: 0 } : prev));
  }, []);

  const joinRoom = useCallback(
    (room: string) => {
      const name = room.trim();
      if (!name || roomsRef.current.includes(name)) {
        if (name) selectRoom(name);
        return;
      }
      const socket = socketRef.current;
      // RQ-13-a: 거부(ok:false) 시 되돌릴 상태를 스냅샷한다. `name` 자체는 (위 가드가
      // 재참여를 이미 걸러내) roomsRef엔 시도 전엔 없었지만, messagesByRoom/
      // participantsByRoom은 **다를 수 있다** — 예: 'global'은 roomsRef엔 절대
      // 안 들어가도(:156) 이미 대화가 쌓여 있을 수 있다. 낙관적 갱신은 키가 이미
      // 있으면 no-op이므로(D5), 되돌릴 때 필요한 건 값이 아니라 **존재 여부**뿐이다
      // — 있었으면 롤백도 no-op(그 사이 도착한 갱신을 보존), 없었으면 새로 만든
      // 키를 제거한다.
      // activeRoom도 마찬가지로 직전 값을 보존해 되돌린다(D3: 그 사이 사용자가
      // 다른 room으로 옮겼으면 되돌리지 않는다 — 아래 ack 분기에서 조건부 복원).
      const prevActiveRoom = activeRoomRef.current;
      let hadMessages = false;
      let hadParticipants = false;

      // 낙관적 갱신: 서버 ack을 기다리지 않고 즉시 반영(체감 지연 없음, GA-30).
      roomsRef.current = [...roomsRef.current, name];
      setRooms(roomsRef.current);
      // activeRoom은 로컬 상태만 낙관적으로 세팅한다(GA-30 충족). 서버 통지
      // (emit('activeRoom'))와 안읽음 0 처리는 join 성공이 ack로 확정된 뒤로
      // 미룬다 — RQ-13-a D1: 아직 참여하지 않은(서버 기준) room을 activeRoom으로
      // 통지하면 서버가 거부해(session.ts:228) RQ-18 회귀(안읽음 오증가)가 생긴다.
      // emit('join')의 위치는 되돌리지 않는다 — 그러면 테스트 더블의 동기 ack
      // 때문에 롤백이 낙관적 갱신보다 먼저 실행돼 무효화된다(축4 관찰).
      activeRoomRef.current = name;
      setActiveRoomState(name);
      setMessagesByRoom((prev) => {
        hadMessages = name in prev;
        return prev[name] ? prev : { ...prev, [name]: [] };
      });
      // 혼자 입장(founding join)은 서버가 방송하지 않으므로 본인을 seed —
      // 두 번째 참여자가 오면 서버 방송(participants)이 권위 목록으로 대체한다.
      setParticipantsByRoom((prev) => {
        hadParticipants = name in prev;
        return prev[name] ? prev : { ...prev, [name]: [selfNickname] };
      });

      // nickname(App prop, resume 중이면 null)이 아니라 selfNickname(서버 확정값)을
      // 쓴다 — RQ-10-a: resume 성공 직후 사용자가 새 room에 참여해도 올바른 본인
      // 닉네임으로 join되어야 한다.
      socket?.emit('join', { room: name, nickname: selfNickname }, (result) => {
        if (!result.ok) {
          // RQ-13-a(GA-28/GA-29): 서버 거부 — 위 낙관적 갱신을 되돌린다.
          // 거부 사유(예약 이름 vs 빈 nickname)는 구분하지 않는다 — ok:false만 본다.
          roomsRef.current = roomsRef.current.filter((r) => r !== name);
          setRooms(roomsRef.current);
          // D3: 그 사이 사용자가 다른 room으로 옮겼으면 activeRoom을 되돌리지
          // 않는다 — 먼저 보낸 join의 늦은 거부가 지금 보고 있는 room을 빼앗지
          // 않도록.
          if (activeRoomRef.current === name) {
            // M-2: prevActiveRoom을 무조건 복원하면, 동시에 진행 중이던 다른 join이
            // 먼저 거부되어 prevActiveRoom 자신이 이미 rooms에서 빠진 뒤일 수 있다
            // (예: room-A join 도중 room-B join이 활성화 → A 거부(활성은 이미 B라
            // 안 건드림, rooms에서 A만 제거) → B도 거부 → prevActiveRoom_B='room-A'를
            // 무조건 복원하면 rooms=[]인데 activeRoom='room-A'를 가리키는 유령 상태가
            // 된다). 위 filter로 최신 상태가 반영된 roomsRef.current에 prevActiveRoom이
            // 여전히 있을 때만 복원하고, 없으면(또는 애초에 null이면) null로 떨어뜨린다.
            const restoreTo =
              prevActiveRoom !== null && roomsRef.current.includes(prevActiveRoom) ? prevActiveRoom : null;
            activeRoomRef.current = restoreTo;
            setActiveRoomState(restoreTo);
          }
          // D5: 낙관적 갱신은 키가 이미 있으면(예: 'global') 아무것도 하지 않는
          // no-op이었다(:255,:262) — 그 역연산도 no-op이어야 한다. 스냅샷 값으로
          // "복원"하면 ack 대기 중 도착한 message/participants(:187,:195)가
          // 지워진다(부모 191847f와 같은 손실 — D2 잔여). 낙관적 갱신이 새로
          // 키를 만든 경우에만 그 키를 제거한다.
          setMessagesByRoom((prev) => {
            if (hadMessages || !(name in prev)) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
          });
          setParticipantsByRoom((prev) => {
            if (hadParticipants || !(name in prev)) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
          });
          // D4: 낙관적 unread 0 처리를 애초에 성공 분기로 미뤘으므로(아래) 거부
          // 시 되돌릴 unread 변경 자체가 없다.
          return;
        }
        // 최초 join 성공: ack의 히스토리(RQ-11)를 기존 앞에 prepend. 서버가 히스토리와
        // 라이브의 무중복을 보장하므로(한 메시지는 둘 중 하나에만), ack 전 도착한
        // 라이브가 있어도 prepend로 순서(과거→현재) 유지하며 잃지 않는다.
        const historyMsgs: ClientMessage[] = result.history.map((m) => {
          msgSeq += 1;
          return { id: `h${msgSeq}`, room: m.room, nickname: m.nickname, body: m.body, at: Date.now() };
        });
        setMessagesByRoom((prev) => ({ ...prev, [name]: [...historyMsgs, ...(prev[name] ?? [])] }));
        // RQ-18/D1·D4: join이 서버에서 확정된 뒤에야 활성 room을 통지하고
        // 안읽음을 0 처리한다 — 그 사이 사용자가 다른 room으로 옮겼으면 건드리지
        // 않는다(D3과 동일 원칙).
        if (activeRoomRef.current === name) {
          socketRef.current?.emit('activeRoom', { room: name }, () => undefined);
          setUnreadByRoom((prev) => (prev[name] ? { ...prev, [name]: 0 } : prev));
        }
      });
    },
    [selfNickname, selectRoom],
  );

  const sendMessage = useCallback((body: string) => {
    const text = body.trim();
    const room = activeRoomRef.current;
    const socket = socketRef.current;
    if (!text || !room || !socket) return;
    socket.emit('message', { room, body: text });
  }, []);

  return useMemo(
    () => ({
      nickname: selfNickname,
      status,
      rooms,
      activeRoom,
      messagesByRoom,
      participantsByRoom,
      availableRooms,
      unreadByRoom,
      joinRoom,
      setActiveRoom: selectRoom,
      sendMessage,
    }),
    [
      selfNickname,
      status,
      rooms,
      activeRoom,
      messagesByRoom,
      participantsByRoom,
      availableRooms,
      unreadByRoom,
      joinRoom,
      selectRoom,
      sendMessage,
    ],
  );
}
