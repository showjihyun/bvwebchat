import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { displayNickname } from '../avatar';
import type { ClientMessage, ConnStatus } from '../useChat';
import { GLOBAL_ROOM } from '../../shared/types';

interface Props {
  room: string | null;
  nickname: string;
  messages: ClientMessage[];
  status: ConnStatus;
  onSend: (body: string) => void;
  onLeave: (room: string) => Promise<string | null>;
  onNewRoom: () => void;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 채팅 영역 (DESIGN.md §4/§5). 재연결 배너, 플랫 메시지 리스트, 입력창. */
export function ChatPane({ room, nickname, messages, status, onSend, onLeave, onNewRoom }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  // 새 메시지가 오거나 room을 바꾸면 목록을 맨 아래로 스크롤(최신 메시지 노출).
  // 위로 스크롤하면 과거 대화를 볼 수 있고, 새 메시지 도착 시 다시 하단으로 붙는다.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, room]);

  if (room === null) {
    return (
      <div className="col-chat">
        <div className="empty-room">
          <div className="title">참여한 room이 없습니다</div>
          <div className="hint">
            좌측 하단 “+ room 참여”로 room에 들어가면 대화를 시작할 수 있습니다.
          </div>
          <button className="btn-primary" onClick={onNewRoom}>
            room 참여
          </button>
        </div>
      </div>
    );
  }

  const leave = async () => {
    const error = await onLeave(room);
    setLeaveError(error);
  };

  return (
    <div className="col-chat">
      <div className="col-header">
        <span className="chat-head-name"># {room}</span>
        {room !== GLOBAL_ROOM && (
          <button className="btn-ghost room-leave" type="button" onClick={() => void leave()}>
            나가기
          </button>
        )}
      </div>
      {leaveError && <div className="leave-error">{leaveError}</div>}
      {status === 'reconnecting' && (
        <div className="reconnect-bar">
          <span className="dot" />
          <span>연결이 끊겼습니다 — 재연결 중…</span>
        </div>
      )}
      <div className="msg-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="empty-room">
            <div className="title"># {room}</div>
            <div className="hint">아직 메시지가 없습니다.</div>
          </div>
        ) : (
          messages.map((msg, i) => {
            const prev = messages[i - 1];
            const grouped = prev !== undefined && prev.nickname === msg.nickname;
            const isMe = msg.nickname === nickname;
            if (grouped) {
              return (
                <div key={msg.id} className="msg-row grouped">
                  <div className="msg-body">{msg.body}</div>
                </div>
              );
            }
            return (
              <div key={msg.id} className="msg-row msg-lead">
                <Avatar nickname={msg.nickname} />
                <div style={{ minWidth: 0 }}>
                  <div className="msg-meta">
                    <span className="msg-name" title={msg.nickname}>
                      {displayNickname(msg.nickname)}
                    </span>
                    {isMe && <span className="me-badge">나</span>}
                    <span className="msg-time">{formatTime(msg.at)}</span>
                  </div>
                  <div className="msg-body">{msg.body}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <Composer room={room} disabled={status === 'reconnecting'} onSend={onSend} />
    </div>
  );
}
