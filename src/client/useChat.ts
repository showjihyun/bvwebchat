import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ChatMessage } from '../shared/types';

// 서버 계약(src/server/createChatServer.ts)과 동일한 이벤트 shape.
interface ServerToClientEvents {
  message: (payload: ChatMessage) => void;
}
interface ClientToServerEvents {
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

let msgSeq = 0;

export interface ChatState {
  status: ConnStatus;
  rooms: string[];
  activeRoom: string | null;
  messagesByRoom: Record<string, ClientMessage[]>;
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
 * - 참여자 목록·안 읽음·닉네임 고유화는 각각 RQ-15/18/10 서버 기능이 필요해 범위 밖이다.
 */
export function useChat(nickname: string): ChatState {
  const socketRef = useRef<ChatSocket | null>(null);
  const roomsRef = useRef<string[]>([]);
  // activeRoom을 ref로 미러링 — sendMessage가 상태 업데이터(순수해야 함) 밖에서
  // 현재 room을 읽어 emit하기 위함. StrictMode 이중 호출로 인한 중복 전송 방지.
  const activeRoomRef = useRef<string | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [rooms, setRooms] = useState<string[]>([]);
  const [activeRoom, setActiveRoomState] = useState<string | null>(null);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ClientMessage[]>>({});

  useEffect(() => {
    // Vite proxy(/socket.io → :3001)를 통해 same-origin으로 접속.
    const socket: ChatSocket = io({ autoConnect: true });
    socketRef.current = socket;

    const rejoinAll = () => {
      for (const room of roomsRef.current) {
        socket.emit('join', { room, nickname }, () => undefined);
      }
    };

    socket.on('connect', () => {
      setStatus('connected');
      rejoinAll(); // 최초 연결·재연결 모두 참여 room 복원
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

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [nickname]);

  const selectRoom = useCallback((room: string) => {
    activeRoomRef.current = room;
    setActiveRoomState(room);
  }, []);

  const joinRoom = useCallback(
    (room: string) => {
      const name = room.trim();
      if (!name || roomsRef.current.includes(name)) {
        if (name) selectRoom(name);
        return;
      }
      const socket = socketRef.current;
      // 최초 join: ack의 히스토리(RQ-11)를 기존 앞에 prepend. 서버가 히스토리와
      // 라이브의 무중복을 보장하므로(한 메시지는 둘 중 하나에만), ack 전 도착한
      // 라이브가 있어도 prepend로 순서(과거→현재) 유지하며 잃지 않는다.
      socket?.emit('join', { room: name, nickname }, (result) => {
        if (!result.ok) return;
        const historyMsgs: ClientMessage[] = result.history.map((m) => {
          msgSeq += 1;
          return { id: `h${msgSeq}`, room: m.room, nickname: m.nickname, body: m.body, at: Date.now() };
        });
        setMessagesByRoom((prev) => ({ ...prev, [name]: [...historyMsgs, ...(prev[name] ?? [])] }));
      });
      roomsRef.current = [...roomsRef.current, name];
      setRooms(roomsRef.current);
      selectRoom(name);
      setMessagesByRoom((prev) => (prev[name] ? prev : { ...prev, [name]: [] }));
    },
    [nickname, selectRoom],
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
      joinRoom,
      setActiveRoom: selectRoom,
      sendMessage,
    }),
    [status, rooms, activeRoom, messagesByRoom, joinRoom, selectRoom, sendMessage],
  );
}
