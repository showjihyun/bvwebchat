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
type IdentifyAck = { ok: true; nickname: string; token: string; globalHistory: ChatMessage[] } | { ok: false; error: string };
type ResumeAck =
  | {
      ok: true;
      nickname: string;
      rooms: string[];
      activeRoom: string | null;
      unread: Record<string, number>;
      globalHistory: ChatMessage[];
    }
  | { ok: false; error: string };
type ActiveRoomAck = { ok: true } | { ok: false; error: string };
type LeaveAck = { ok: true } | { ok: false; error: string };
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
  leave: (payload: { room: string }, ack: (result: LeaveAck) => void) => void;
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
const TOKEN_KEY = 'bvwebchat.sessionToken';

let msgSeq = 0;

export interface ChatState {
  status: ConnStatus;
  rooms: string[];
  activeRoom: string | null;
  messagesByRoom: Record<string, ClientMessage[]>;
  participantsByRoom: Record<string, string[]>;
  availableRooms: string[];
  unreadByRoom: Record<string, number>;
  joinRoom: (room: string) => Promise<string | null>;
  leaveRoom: (room: string) => Promise<string | null>;
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
 */
export function useChat(nickname: string): ChatState {
  const socketRef = useRef<ChatSocket | null>(null);
  const roomsRef = useRef<string[]>([GLOBAL_ROOM]);
  // activeRoom을 ref로 미러링 — sendMessage가 상태 업데이터(순수해야 함) 밖에서
  // 현재 room을 읽어 emit하기 위함. StrictMode 이중 호출로 인한 중복 전송 방지.
  const activeRoomRef = useRef<string | null>(GLOBAL_ROOM);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  // global은 모든 사용자가 자동 참여하는 고정 채널이다. UI에서도 항상 첫 채널로
  // 보여야 하므로, 서버의 room directory 수신을 기다리지 않고 초기 상태에 둔다.
  const [rooms, setRooms] = useState<string[]>([GLOBAL_ROOM]);
  const [activeRoom, setActiveRoomState] = useState<string | null>(GLOBAL_ROOM);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ClientMessage[]>>({});
  const [participantsByRoom, setParticipantsByRoom] = useState<Record<string, string[]>>({});
  const [availableRooms, setAvailableRooms] = useState<string[]>([]);
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});

  const setGlobalHistory = (history: ChatMessage[]) => {
    const messages: ClientMessage[] = history.map((message) => {
      msgSeq += 1;
      return { id: `g${msgSeq}`, room: message.room, nickname: message.nickname, body: message.body, at: Date.now() };
    });
    setMessagesByRoom((prev) => ({ ...prev, [GLOBAL_ROOM]: messages }));
  };

  useEffect(() => {
    // Vite proxy(/socket.io → :3001)를 통해 same-origin으로 접속.
    const socket: ChatSocket = io({ autoConnect: true });
    socketRef.current = socket;

    const rejoinAll = () => {
      for (const room of roomsRef.current) {
        socket.emit('join', { room, nickname }, () => undefined);
      }
    };

    // RQ-18/ADR-0003: 새 세션 발급 — 닉네임 identify → 토큰 저장 → 참여 room 복원.
    const identifyFresh = () => {
      socket.emit('identify', { nickname }, (res) => {
        if (res.ok) {
          localStorage.setItem(TOKEN_KEY, res.token);
          setGlobalHistory(res.globalHistory);
          socket.emit('activeRoom', { room: GLOBAL_ROOM }, () => undefined);
        }
        rejoinAll(); // 최초 연결은 no-op, 재연결/토큰만료 폴백 시 참여 room 재등록
      });
    };

    socket.on('connect', () => {
      setStatus('connected');
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        // 유예(30초) 내 재연결·새로고침: 토큰으로 세션(참여 room·활성·안읽음) 복원.
        socket.emit('resume', { token }, (res) => {
          if (!res.ok) {
            // 유예 만료·무효 토큰 → 새 세션 발급으로 폴백.
            localStorage.removeItem(TOKEN_KEY);
            identifyFresh();
            return;
          }
          // resume이 서버측 room 재합류를 수행하므로 rejoinAll을 다시 하지 않는다.
          const restored = res.rooms.includes(GLOBAL_ROOM) ? res.rooms : [GLOBAL_ROOM, ...res.rooms];
          roomsRef.current = restored;
          setRooms(restored);
          setUnreadByRoom(res.unread);
          setGlobalHistory(res.globalHistory);
          for (const room of restored) {
            setMessagesByRoom((prev) => (prev[room] ? prev : { ...prev, [room]: [] }));
          }
          if (res.activeRoom) {
            // selectRoom은 아래에서 정의되므로 ref/setter를 인라인(활성 room 통지는 이미 서버에 복원됨).
            activeRoomRef.current = res.activeRoom;
            setActiveRoomState(res.activeRoom);
          } else {
            activeRoomRef.current = GLOBAL_ROOM;
            setActiveRoomState(GLOBAL_ROOM);
            socket.emit('activeRoom', { room: GLOBAL_ROOM }, () => undefined);
          }
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
    (room: string): Promise<string | null> => {
      const name = room.trim();
      if (!name) return Promise.resolve('room 이름을 입력해 주세요.');
      if (roomsRef.current.includes(name)) {
        selectRoom(name);
        return Promise.resolve(null);
      }
      const socket = socketRef.current;
      if (!socket?.connected) return Promise.resolve('서버 연결이 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      // 최초 join: ack의 히스토리(RQ-11)를 기존 앞에 prepend. 서버가 히스토리와
      // 라이브의 무중복을 보장하므로(한 메시지는 둘 중 하나에만), ack 전 도착한
      // 라이브가 있어도 prepend로 순서(과거→현재) 유지하며 잃지 않는다.
      return new Promise((resolve) => socket.emit('join', { room: name, nickname }, (result) => {
        if (!result.ok) {
          resolve(result.error);
          return;
        }
        const historyMsgs: ClientMessage[] = result.history.map((m) => {
          msgSeq += 1;
          return { id: `h${msgSeq}`, room: m.room, nickname: m.nickname, body: m.body, at: Date.now() };
        });
        roomsRef.current = [...roomsRef.current, name];
        setRooms(roomsRef.current);
        selectRoom(name);
        setMessagesByRoom((prev) => ({ ...prev, [name]: [...historyMsgs, ...(prev[name] ?? [])] }));
      // 혼자 입장(founding join)은 서버가 방송하지 않으므로 본인을 seed —
      // 두 번째 참여자가 오면 서버 방송(participants)이 권위 목록으로 대체한다.
        setParticipantsByRoom((prev) => (prev[name] ? prev : { ...prev, [name]: [nickname] }));
        resolve(null);
      }));
    },
    [nickname, selectRoom],
  );

  const leaveRoom = useCallback(
    (room: string): Promise<string | null> => {
      if (room === GLOBAL_ROOM) return Promise.resolve('global 채널은 나갈 수 없습니다.');
      const socket = socketRef.current;
      if (!socket?.connected) return Promise.resolve('서버 연결이 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return new Promise((resolve) => socket.emit('leave', { room }, (result) => {
        if (!result.ok) {
          resolve(result.error);
          return;
        }
        roomsRef.current = roomsRef.current.filter((item) => item !== room);
        setRooms(roomsRef.current);
        setMessagesByRoom((prev) => {
          const next = { ...prev };
          delete next[room];
          return next;
        });
        setParticipantsByRoom((prev) => {
          const next = { ...prev };
          delete next[room];
          return next;
        });
        setUnreadByRoom((prev) => {
          const next = { ...prev };
          delete next[room];
          return next;
        });
        if (activeRoomRef.current === room) selectRoom(GLOBAL_ROOM);
        resolve(null);
      }));
    },
    [selectRoom],
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
      status,
      rooms,
      activeRoom,
      messagesByRoom,
      participantsByRoom,
      availableRooms,
      unreadByRoom,
      joinRoom,
      leaveRoom,
      setActiveRoom: selectRoom,
      sendMessage,
    }),
    [
      status,
      rooms,
      activeRoom,
      messagesByRoom,
      participantsByRoom,
      availableRooms,
      unreadByRoom,
      joinRoom,
      leaveRoom,
      selectRoom,
      sendMessage,
    ],
  );
}
