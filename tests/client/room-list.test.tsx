// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RoomList } from '../../src/client/components/RoomList';

describe('RoomList', () => {
  it('global is rendered as the initial selectable channel', () => {
    const onSelect = vi.fn();
    render(
      <RoomList rooms={['global']} activeRoom="global" unreadByRoom={{}} onSelect={onSelect} onNewRoom={() => undefined} />,
    );

    const global = screen.getByRole('button', { name: /global/ });
    expect(global.className).toContain('selected');
    fireEvent.click(global);
    expect(onSelect).toHaveBeenCalledWith('global');
  });
});
