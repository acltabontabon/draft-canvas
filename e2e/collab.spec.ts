import { expect, test, type Browser, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';

/**
 * A live session between two browsers that share nothing — two contexts, two storages — over a real
 * WebRTC connection. People knock through the session link (the dev relay Playwright starts) and the
 * owner lets them in; the direct invite and reply code are the fallback without the relay.
 *
 * No STUN server on the internet is asked, so the run needs no internet.
 */
// Each engine hides a machine's own addresses from WebRTC by default (mDNS names a CI runner may not
// resolve); these keep plain host candidates, the one concession to two peers on one machine.
test.use({
  launchOptions: [
    async ({ browserName }, use) => {
      if (browserName === 'chromium') return use({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
      if (browserName === 'firefox') {
        return use({
          firefoxUserPrefs: {
            'media.peerconnection.ice.obfuscate_host_addresses': false,
            'media.peerconnection.ice.loopback': true,
          },
        });
      }
      return use({});
    },
    { scope: 'worker' },
  ],
});

/**
 * Whether this engine can open a peer connection at all — two in one page, no network asked.
 * Playwright's WebKit build on macOS gathers no ICE candidates, so a live session can't open there;
 * only WebKit is asked, so a regression anywhere else still fails loudly.
 */
async function peersConnect(page: Page, browserName: string): Promise<boolean> {
  if (browserName !== 'webkit') return true;
  return page.evaluate(async () => {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (event) => event.candidate && void b.addIceCandidate(event.candidate);
    b.onicecandidate = (event) => event.candidate && void a.addIceCandidate(event.candidate);
    const channel = a.createDataChannel('probe');
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    const open = await new Promise<boolean>((resolve) => {
      channel.onopen = () => resolve(true);
      setTimeout(() => resolve(false), 5_000);
    });
    a.close();
    b.close();
    return open;
  });
}

async function startSession(owner: Page): Promise<string> {
  await owner.getByRole('button', { name: 'Collaborate', exact: true }).click();
  const dialog = owner.getByRole('dialog', { name: 'Collaborate' });
  await dialog.getByLabel('Your name').fill('Olive');
  // A session link goes through the relay, so the owner picks "Anyone with the link" — with a STUN server
  // at a documentation address (TEST-NET-1) that nothing answers, so the run asks nothing of the
  // internet. (A loopback address doesn't do: Chromium then fails to pair the host candidates.)
  await dialog.getByText('Anyone with the link').click();
  await dialog.getByText('Use your own STUN server').click();
  await dialog.getByLabel('Server').fill('stun:192.0.2.1:3478');
  await dialog.getByRole('button', { name: 'Start session' }).click();
  const link = dialog.getByRole('textbox', { name: 'Session link' });
  await expect(link).toHaveValue(/#join=2\./, { timeout: 15_000 });
  // Said where the link is copied: the relay never sees the diagram.
  await expect(dialog.getByText('Your diagram never passes through the relay', { exact: false })).toBeVisible();
  return link.inputValue();
}

/** Opens the session link in a browser of its own and asks to join; resolves once they are waiting. */
async function knock(browser: Browser, link: string, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(link);
  const dialog = page.getByRole('dialog', { name: 'Join a live session' });
  await expect(dialog).toBeVisible();
  // The link leaves the address as soon as it is read: not bookmarked, not synced into history.
  await expect.poll(() => page.url()).not.toContain('join=');
  await dialog.getByLabel('Your name').fill(name);
  await dialog.getByRole('button', { name: 'Ask to join' }).click();
  await expect(dialog.getByText('Waiting for Olive to let you in', { exact: false })).toBeVisible({ timeout: 15_000 });
  return page;
}

async function letIn(owner: Page, name: string, role: 'Can edit' | 'Can view' = 'Can edit') {
  const card = owner.getByRole('group', { name: `${name} is asking to join` });
  await expect(card).toBeVisible({ timeout: 10_000 });
  if (role === 'Can view') await card.getByLabel(`What ${name} can do`).selectOption('viewer');
  await card.getByRole('button', { name: 'Let in' }).click();
}

async function openInvite(owner: Page): Promise<string> {
  const dialog = owner.getByRole('dialog', { name: 'Collaborate' });
  await dialog.getByText('Invite one person directly').click();
  await dialog.getByRole('button', { name: 'Create invite link' }).click();
  const link = dialog.getByLabel('Send this link to one person');
  await expect(link).toHaveValue(/#join=1\./, { timeout: 15_000 });
  return link.inputValue();
}

async function join(browser: Browser, link: string, name: string): Promise<{ page: Page; reply: string }> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(link);
  const dialog = page.getByRole('dialog', { name: 'Join a live session' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Your name').fill(name);
  await dialog.getByRole('button', { name: 'Join' }).click();
  const code = dialog.getByLabel('Send this reply code back to the person who invited you');
  await expect(code).toHaveValue(/^1\./, { timeout: 15_000 });
  return { page, reply: await code.inputValue() };
}

async function paste(owner: Page, reply: string) {
  const dialog = owner.getByRole('dialog', { name: 'Collaborate' });
  await dialog.getByLabel('Paste their reply code').fill(reply);
  await dialog.getByRole('button', { name: 'Connect' }).click();
}

const labels = (page: Page) => page.locator('.react-flow__node').allInnerTexts();

test('two browsers edit one canvas live, and the owner stays in charge', async ({ page: owner, browser, browserName }) => {
  await newCanvas(owner, 'Payments');
  test.skip(!(await peersConnect(owner, browserName)), 'This engine build opens no peer connections');
  await create(owner, 'Service', { x: 260, y: 220 });

  const link = await startSession(owner);
  await owner.keyboard.press('Escape');
  const guest = { page: await knock(browser, link, 'Gus') };
  // The knock arrives in the people column on the owner's canvas, with Gus's own name on it.
  await letIn(owner, 'Gus');

  // The collaborator's copy opens with the owner's canvas on it.
  await expect(guest.page.locator('.dc-editor')).toBeVisible({ timeout: 30_000 });
  await expect(guest.page.getByLabel('Diagram title')).toHaveValue('Payments');
  await expect.poll(() => labels(guest.page)).toEqual(await labels(owner));
  await expect(owner.getByRole('complementary', { name: 'People in this session' }).getByRole('button', { name: /^Gus:/ })).toBeVisible();
  // Let in, they leave the door: nobody is left waiting.
  await expect(owner.getByRole('region', { name: 'Waiting to join' })).toHaveCount(0);

  // Each sees where the other is pointing, with their name.
  const guestPane = (await guest.page.locator('.react-flow__pane').boundingBox())!;
  await guest.page.mouse.move(guestPane.x + 420, guestPane.y + 300);
  await guest.page.mouse.move(guestPane.x + 440, guestPane.y + 310);
  await expect(owner.locator('.dc-presence-cursor').filter({ hasText: 'Gus' })).toBeVisible({ timeout: 10_000 });

  // An edit on either side shows up on the other.
  await create(guest.page, 'Queue', { x: 520, y: 360 });
  await expect.poll(async () => (await labels(owner)).length, { timeout: 10_000 }).toBe(2);
  await create(owner, 'Data Store', { x: 260, y: 460 });
  await expect.poll(async () => (await labels(guest.page)).length, { timeout: 10_000 }).toBe(3);

  // The owner presents; the collaborator is offered to follow, and their view goes along.
  await owner.getByRole('button', { name: 'Present', exact: true }).click();
  const prompt = guest.page.locator('.dc-follow');
  await expect(prompt).toContainText('Olive is presenting', { timeout: 10_000 });
  await prompt.getByRole('button', { name: 'Follow' }).click();
  await expect(prompt).toContainText('Following Olive');
  await owner.keyboard.press('Escape');
  await expect(prompt).toBeHidden({ timeout: 10_000 });

  // The owner makes the collaborator view-only: their canvas says so and takes no edits.
  await owner.getByRole('button', { name: /^Live session, 2 people/ }).click();
  const dialog = owner.getByRole('dialog', { name: 'Collaborate' });
  await dialog.getByLabel('What Gus can do').selectOption('viewer');
  await expect(guest.page.getByRole('status').filter({ hasText: 'view only' })).toBeVisible();

  // Undo on the owner's side takes back only the owner's own edit.
  await owner.keyboard.press('Escape');
  await owner.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
  await owner.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => (await labels(guest.page)).length, { timeout: 10_000 }).toBe(2);

  // Removing them ends their session, and their screen says why.
  await owner.getByRole('button', { name: /^Live session/ }).click();
  await dialog.getByRole('button', { name: 'Remove Gus from the session' }).click();
  await expect(guest.page.getByRole('status').filter({ hasText: 'removed you' })).toBeVisible();
  await guest.page.context().close();
});

test('someone the owner turns away is told so, and never gets in', async ({ page: owner, browser }) => {
  await newCanvas(owner, 'Doorstep');
  const link = await startSession(owner);
  await owner.keyboard.press('Escape');
  const stranger = await knock(browser, link, 'Stranger');
  await owner.getByRole('group', { name: 'Stranger is asking to join' }).getByRole('button', { name: 'Deny' }).click();
  await expect(stranger.getByText('The owner didn’t let you in.')).toBeVisible({ timeout: 10_000 });
  await expect(stranger.locator('.dc-editor')).toHaveCount(0);
  await stranger.context().close();
});

test('without the relay, a direct invite and reply code still work — and a wrong code is refused', async ({ page: owner, browser, browserName }) => {
  await newCanvas(owner, 'Mixups');
  test.skip(!(await peersConnect(owner, browserName)), 'This engine build opens no peer connections');
  await startSession(owner);
  const first = await openInvite(owner);
  const other = await join(browser, first, 'Early');
  // A new invite replaces the first; the first's reply now answers nothing.
  const dialog = owner.getByRole('dialog', { name: 'Collaborate' });
  await dialog.getByRole('button', { name: 'Cancel invite' }).click();
  await dialog.getByRole('button', { name: 'Create invite link' }).click();
  const link = dialog.getByLabel('Send this link to one person');
  await expect(link).toHaveValue(/#join=1\./, { timeout: 15_000 });
  await paste(owner, other.reply);
  await expect(dialog.getByRole('alert')).toBeVisible();

  const right = await join(browser, await link.inputValue(), 'Right');
  await dialog.getByLabel('Paste their reply code').fill(right.reply);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(right.page.locator('.dc-editor')).toBeVisible({ timeout: 30_000 });
  await other.page.context().close();
  await right.page.context().close();
});
