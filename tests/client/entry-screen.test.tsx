// @vitest-environment jsdom
// FE 배선 스모크 (RQ-01 슬라이스) — 입장 화면이 렌더되고 미입력 시 버튼 비활성,
// 입력 시 활성이 되는지 확인. 제품 행동 통합 테스트(GA-*)는 서버 경계에 있고,
// 이건 클라이언트 컴포넌트가 컴파일·렌더되는지를 지키는 배선 테스트다.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EntryScreen } from '../../src/client/components/EntryScreen';

describe('EntryScreen', () => {
  it('닉네임 미입력 시 입장 버튼 비활성, 입력 시 활성', () => {
    render(<EntryScreen onEnter={() => undefined} />);
    const btn = screen.getByRole('button', { name: '입장' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('닉네임'), { target: { value: '지수' } });
    expect(btn.disabled).toBe(false);
  });
});
