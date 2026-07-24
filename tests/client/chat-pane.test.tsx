// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { ChatPane } from '../../src/client/components/ChatPane';

describe('ChatPane', () => {
  const props = {
    nickname: 'alice',
    messages: [],
    status: 'connected' as const,
    onSend: () => undefined,
    onNewRoom: () => undefined,
  };

  afterEach(cleanup);

  it('offers leave for user rooms and returns to the supplied leave action', async () => {
    const onLeave = vi.fn(async () => null);
    render(<ChatPane {...props} room="project" onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: '나가기' }));
    await vi.waitFor(() => expect(onLeave).toHaveBeenCalledWith('project'));
  });

  it('does not offer leave for global', () => {
    render(<ChatPane {...props} room="global" onLeave={async () => null} />);
    expect(screen.queryByRole('button', { name: '나가기' })).toBeNull();
  });
});
