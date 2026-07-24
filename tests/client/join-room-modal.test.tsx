// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { JoinRoomModal } from '../../src/client/components/JoinRoomModal';

describe('JoinRoomModal', () => {
  it('keeps the modal open and displays a server join failure', async () => {
    const onCancel = vi.fn();
    render(
      <JoinRoomModal
        existingRooms={['global']}
        availableRooms={['global']}
        onCancel={onCancel}
        onJoin={async () => 'room limit reached'}
      />,
    );

    fireEvent.change(screen.getByLabelText('room 이름'), { target: { value: 'project' } });
    fireEvent.click(screen.getByRole('button', { name: '참여' }));

    expect(await screen.findByText('room limit reached')).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
