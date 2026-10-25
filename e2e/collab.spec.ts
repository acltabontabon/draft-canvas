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

/** The ICE servers `startSession` sets up: one STUN server at a documentation address nothing answers. */
const UNANSWERED_STUN = 'stun:192.0.2.1:3478';

/**
 * Whether this engine, on this machine, can connect two browser contexts the way a session does —
 * separate processes, full gathering, the offer and answer swapped whole. Two peers in one page
 * prove nothing: they share one mDNS registry, so hidden host addresses resolve there and nowhere
 * else. Playwright's WebKit hides them with no switch to turn that off, and a CI runner has no mDNS
 * responder; its WebKit on macOS gathers no candidates at all. Chromium is never asked, so a
 * regression in the app still fails loudly there. What the probe saw goes into the report.
 */
async function peersConnect(browser: Browser, browserName: string): Promise<boolean> {
  if (browserName === 'chromium') return true;
  const probe = async (stun: string | null) => {
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
      const setUp = async (page: Page, offer: string | null) =>
        page.evaluate(
          async ({ stun, offer }) => {
            const pc = new RTCPeerConnection({ iceServers: stun ? [{ urls: stun }] : [], bundlePolicy: 'max-bundle' });
            const channel = pc.createDataChannel('probe', { negotiated: true, id: 0 });
            const open = new Promise<boolean>((resolve) => {
              channel.onopen = () => resolve(true);
              setTimeout(() => resolve(false), 8_000);
            });
            (window as unknown as { probe: unknown }).probe = { pc, open };
            const gathered = new Promise<void>((resolve) => {
              pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
              setTimeout(resolve, 5_000);
            });
            if (offer) await pc.setRemoteDescription({ type: 'offer', sdp: offer });
            await pc.setLocalDescription(offer ? await pc.createAnswer() : await pc.createOffer());
            await gathered;
            return pc.localDescription!.sdp;
          },
          { stun, offer },
        );
      const offer = await setUp(a, null);
      const answer = await setUp(b, offer);
      const finish = (page: Page, answer: string | null) =>
        page.evaluate(async (answer) => {
          const { pc, open } = (window as unknown as { probe: { pc: RTCPeerConnection; open: Promise<boolean> } }).probe;
          if (answer) await pc.setRemoteDescription({ type: 'answer', sdp: answer });
          const result = await open;
          pc.close();
          return result;
        }, answer);
      const [opened] = await Promise.all([finish(a, answer), finish(b, null)]);
      return { opened, offered: candidates(offer), answered: candidates(answer) };
    } catch (error) {
      return { opened: false, error: String(error).slice(0, 200) };
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  };
  // Each candidate by kind (`udp v4 host`, `udp mdns host`, …), never its address: the log is public.
  const candidates = (sdp: string) =>
    (sdp.match(/^a=candidate:.*$/gm) ?? []).map((line) => {
      const [, , transport, , address, , , type] = line.split(' ');
      const kind = address.endsWith('.local') ? 'mdns' : address.startsWith('127.') || address === '::1' ? 'loopback' : address.includes(':') ? 'v6' : 'v4';
      return `${transport.toLowerCase()} ${kind} ${type}`;
    });
  const withStun = await probe(UNANSWERED_STUN);
  const withoutStun = withStun.opened ? null : await probe(null);
  test.info().annotations.push({
    type: 'webrtc-probe',
    description: JSON.stringify({ browserName, withStun, withoutStun }),
  });
  console.warn(`[webrtc-probe] ${browserName}: ${JSON.stringify({ withStun, withoutStun })}`);
  return withStun.opened;
}

async function startSession(owner: Page): Promise<string> {
  await owner.getByRole('button', { name: 'Share', exact: true }).click();
  await owner.getByRole('menuitem', { name: /^Draw together, live/ }).click();
  const dialog = owner.getByRole('dialog', { name: 'Collaborate' });
  await dialog.getByLabel('Your name').fill('Olive');
  // A session link goes through the relay, so the owner picks "Anyone with the link" — with a STUN server
  // at a documentation address (TEST-NET-1) that nothing answers, so the run asks nothing of the
  // internet. (A loopback address doesn't do: Chromium then fails to pair the host candidates.)
  await dialog.getByText('Anyone with the link').click();
  // The STUN server is set behind the privacy seal, with the rest of what leaves the browser.
  await dialog.getByRole('button', { name: 'How your diagram stays private' }).click();
  await dialog.getByText('Use your own STUN server').click();
  await dialog.getByLabel('Server').fill(UNANSWERED_STUN);
  await dialog.getByRole('button', { name: 'Start session' }).click();
  const link = dialog.getByRole('textbox', { name: 'Session link' });
  await expect(link).toHaveValue(/#join=2\./, { timeout: 15_000 });
  // Behind the seal, said plainly: the relay never sees the diagram.
  await dialog.getByRole('button', { name: 'How your diagram stays private' }).click();
  await expect(dialog.getByRole('note')).toContainText('Your diagram never passes through the relay');
  await dialog.getByRole('button', { name: 'How your diagram stays private' }).click();
  await expect(dialog.getByRole('note')).toHaveCount(0);
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
  test.skip(!(await peersConnect(browser, browserName)), 'This engine can’t connect two browser contexts on this machine');
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

  // Taking back Gus's changes removes the Queue he added — on both sides — and nothing of the owner's.
  await owner.getByRole('button', { name: /^Live session/ }).click();
  await dialog.getByRole('button', { name: 'Undo changes' }).click();
  await expect.poll(async () => (await labels(guest.page)).length, { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await labels(owner)).length).toBe(1);

  // Removing them ends their session, and their screen says why.
  await dialog.getByRole('button', { name: 'Remove Gus from the session' }).click();
  const removed = guest.page.getByRole('dialog', { name: 'Olive removed you from the session' });
  await expect(removed).toBeVisible();
  // Taken out by the owner, they get no copy of the owner's canvas to carry off: only the way home.
  await expect(removed.getByRole('button', { name: 'Back to home' })).toBeFocused();
  await expect(removed.getByRole('button', { name: /copy/ })).toHaveCount(0);
  await expect(guest.page.locator('.dc-editor')).toHaveAttribute('data-session-ended', 'true');
  await expect(guest.page.locator('.dc-editor-body')).toHaveAttribute('inert', '');
  await expect(guest.page.locator('.dc-read-only-banner')).toHaveCount(0);
  await guest.page.context().close();
});

test('when the owner ends the session, the collaborator’s canvas closes behind a card, and a copy can be kept', async ({ page: owner, browser, browserName }) => {
  await newCanvas(owner, 'Payments');
  test.skip(!(await peersConnect(browser, browserName)), 'This engine can’t connect two browser contexts on this machine');
  await create(owner, 'Service', { x: 260, y: 220 });

  const link = await startSession(owner);
  await owner.keyboard.press('Escape');
  const guest = { page: await knock(browser, link, 'Gus') };
  await letIn(owner, 'Gus');
  await expect(guest.page.locator('.dc-editor')).toBeVisible({ timeout: 30_000 });

  await expect.poll(async () => (await labels(guest.page)).length).toBe(1);
  await owner.getByRole('button', { name: /^Live session/ }).click();
  const dialog = owner.getByRole('dialog', { name: 'Collaborate' });
  await dialog.getByRole('button', { name: 'End session' }).click();

  const sessionEnd = guest.page.getByRole('dialog', { name: 'Olive ended the session' });
  await expect(sessionEnd).toBeVisible({ timeout: 15_000 });
  await expect(guest.page.locator('.dc-editor-body')).toHaveAttribute('inert', '');
  // Nothing behind the card takes a key: select-all and Delete leave the canvas as it was.
  await guest.page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await guest.page.keyboard.press('Delete');
  await expect.poll(async () => (await labels(guest.page)).length).toBe(1);
  await expect(guest.page.locator('.react-flow__node.selected')).toHaveCount(0);

  await sessionEnd.getByRole('button', { name: 'Keep a copy' }).click();
  await expect(guest.page.locator('.dc-session-end')).toHaveCount(0);
  await expect(guest.page.locator('.dc-editor')).not.toHaveAttribute('data-session-ended');
  await expect(guest.page.getByLabel('Diagram title')).toHaveValue('Payments');
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
  test.skip(!(await peersConnect(browser, browserName)), 'This engine can’t connect two browser contexts on this machine');
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
