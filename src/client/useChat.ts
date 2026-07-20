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
    ack: (result: { ok: true } | { ok: false; error: string }) => void,
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
 * RQ-01 수직 슬라이스의 클라이언트 상태.
 * - 소켓 재연결 시 참여 중이던 room을 전부 재join한다 (서버 멤버십은 소켓 연결
 *   단위이므로 재연결 = 새 소켓 = 재등록 필요).
 * - 참여자 목록·안 읽음·히스토리·닉네임 고유화는 각각 RQ-15/18/11/10 서버 기능이
 *   필요해 이 슬라이스 범위 밖이다.
 */
export function useChat(nickname: string): ChatState {
  const socketRef = useRef<ChatSocket | null>(null);
  const roomsRef = useRef<string[]>([]);
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

  const joinRoom = useCallback(
    (room: string) => {
      const name = room.trim();
      if (!name || roomsRef.current.includes(name)) {
        if (name) setActiveRoomState(name);
        return;
      }
      const socket = socketRef.current;
      socket?.emit('join', { room: name, nickname }, () => undefined);
      roomsRef.current = [...roomsRef.current, name];
      setRooms(roomsRef.current);
      setActiveRoomState(name);
      setMessagesByRoom((prev) => (prev[name] ? prev : { ...prev, [name]: [] }));
    },
    [nickname],
  );

  const setActiveRoom = useCallback((room: string) => setActiveRoomState(room), []);

  const sendMessage = useCallback((body: string) => {
    const text = body.trim();
    const socket = socketRef.current;
    if (!text || !socket) return;
    setActiveRoomState((room) => {
      if (room) socket.emit('message', { room, body: text });
      return room;
    });
  }, []);

  return useMemo(
    () => ({ status, rooms, activeRoom, messagesByRoom, joinRoom, setActiveRoom, sendMessage }),
    [status, rooms, activeRoom, messagesByRoom, joinRoom, setActiveRoom, sendMessage],
  );
}
