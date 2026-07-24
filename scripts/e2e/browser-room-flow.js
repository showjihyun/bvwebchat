/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const baseUrl = 'http://localhost:3001';
  const room = `e2e-room-${Date.now()}`;
  const peerContext = await page.context().browser().newContext();
  const peer = await peerContext.newPage();

  async function enter(target, nickname) {
    await target.goto(baseUrl);
    await target.evaluate(() => localStorage.clear());
    await target.reload();
    await target.getByLabel('닉네임').fill(nickname);
    await target.getByRole('button', { name: '입장' }).click();
    await target.getByRole('button', { name: /global/ }).waitFor();
  }

  try {
    await enter(page, `e2e-owner-${Date.now()}`);
    await enter(peer, `e2e-peer-${Date.now()}`);

    await page.getByRole('button', { name: /room 참여/ }).click();
    await page.getByLabel('room 이름').fill(room);
    await page.getByRole('button', { name: '참여', exact: true }).click();
    await page.getByText(`# ${room}`).first().waitFor();

    await peer.getByRole('button', { name: /room 참여/ }).click();
    await peer.getByLabel('room 이름').fill(room);
    await peer.getByRole('button', { name: '참여', exact: true }).click();
    await peer.getByText(`# ${room}`).first().waitFor();

    await page.getByLabel('메시지 입력').fill('owner message');
    await page.getByRole('button', { name: '전송' }).click();
    await peer.getByText('owner message').waitFor();

    await peer.getByLabel('메시지 입력').fill('peer message');
    await peer.getByRole('button', { name: '전송' }).click();
    await page.getByText('peer message').waitFor();

    await page.getByRole('button', { name: '나가기' }).click();
    await page.getByRole('button', { name: /global/ }).waitFor();
    await page.locator('.rooms-body .room-item').filter({ hasText: room }).waitFor({ state: 'detached' });

    console.log(JSON.stringify({ ok: true, room, checked: ['join', 'broadcast', 'leave'] }));
  } finally {
    await peerContext.close();
  }
}
