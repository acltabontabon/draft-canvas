import { describe, expect, it } from 'vitest';
import {
  greetingStatement,
  newExchange,
  newOwnerIdentity,
  newSessionLink as linkFor,
  returningProof,
  readSessionPayload,
  readToGuest,
  readToHost,
  roomKey,
  seal,
  sessionPayload,
  unseal,
  verifyOwner,
} from '../../src/collab/rendezvous';

const newSessionLink = () => linkFor({ publicKey: '', fingerprint: 'A'.repeat(43), sign: async () => '' });

describe('session links', () => {
  it('round-trip, and refuse anything else', () => {
    const link = newSessionLink();
    expect(readSessionPayload(sessionPayload(link))).toEqual(link);
    expect(readSessionPayload('1.AAAA')).toBeNull();
    expect(readSessionPayload(`2.${link.room}.${link.secret}`)).toBeNull();
    expect(readSessionPayload(`2.${link.room}.${link.secret}.${link.owner}x`)).toBeNull();
    expect(readSessionPayload('lan.0123456789abcdef0123456789abcdef')).toBeNull();
  });
});

describe('sealing', () => {
  it('opens only with the same key, in the same direction, untouched', async () => {
    const link = newSessionLink();
    const key = await roomKey(link);
    const sealed = await seal(key, 'to-host', { t: 'cancel' });
    expect(await unseal(key, 'to-host', sealed)).toEqual({ t: 'cancel' });
    // Reflected back the other way: refused.
    expect(await unseal(key, 'to-guest', sealed)).toBeNull();
    // Someone with another link: refused.
    expect(await unseal(await roomKey(newSessionLink()), 'to-host', sealed)).toBeNull();
    // Tampered: refused.
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1);
    expect(await unseal(key, 'to-host', flipped)).toBeNull();
    expect(await unseal(key, 'to-host', 'not base64!')).toBeNull();
  });

  it('gives the owner and the knocker the same pair key, which nobody else in the room can derive', async () => {
    const link = newSessionLink();
    const owner = await newExchange();
    const knocker = await newExchange();
    const eavesdropper = await newExchange();
    const ownerSide = await owner.pairWith(knocker.publicKey, link);
    const knockerSide = await knocker.pairWith(owner.publicKey, link);
    const offer = await seal(ownerSide, 'to-guest', { invite: '1.secret-offer' });
    expect(await unseal(knockerSide, 'to-guest', offer)).toEqual({ invite: '1.secret-offer' });
    // Another link holder, even knowing both public keys, can't pair into it.
    expect(await unseal(await eavesdropper.pairWith(owner.publicKey, link), 'to-guest', offer)).toBeNull();
  });
});

describe('who may greet a knocker', () => {
  it('only the owner whose key the link names — not someone else holding the link', async () => {
    const owner = await newOwnerIdentity();
    const impostor = await newOwnerIdentity();
    const link = linkFor(owner);
    const knocker = (await newExchange()).publicKey;
    const ownersHalf = (await newExchange()).publicKey;
    const statement = greetingStatement(link, knocker, ownersHalf, 'Olive');
    expect(await verifyOwner(link, owner.publicKey, statement, await owner.sign(statement))).toBe(true);
    // The impostor signs perfectly well — with a key the link doesn't name.
    expect(await verifyOwner(link, impostor.publicKey, statement, await impostor.sign(statement))).toBe(false);
    // The owner's key with the impostor's signature, or a signature over another knock: refused.
    expect(await verifyOwner(link, owner.publicKey, statement, await impostor.sign(statement))).toBe(false);
    const other = greetingStatement(link, (await newExchange()).publicKey, ownersHalf, 'Olive');
    expect(await verifyOwner(link, owner.publicKey, statement, await owner.sign(other))).toBe(false);
    // The owner's name is signed too: a greeting re-sealed under another name doesn't verify.
    expect(await verifyOwner(link, owner.publicKey, greetingStatement(link, knocker, ownersHalf, 'Mallory'), await owner.sign(statement))).toBe(false);
  });

  it('lets a collaborator prove a place is theirs — for this knock only', async () => {
    const link = linkFor(await newOwnerIdentity());
    const knockKey = (await newExchange()).publicKey;
    const proof = await returningProof('their-private-resume-key', link, knockKey);
    expect(await returningProof('their-private-resume-key', link, knockKey)).toBe(proof);
    expect(await returningProof('a-guess', link, knockKey)).not.toBe(proof);
    // Replayed into another knock (another fresh key), it no longer matches.
    expect(await returningProof('their-private-resume-key', link, (await newExchange()).publicKey)).not.toBe(proof);
  });
});

describe('reading rendezvous messages', () => {
  it('takes the joiner’s own name, cleaned, and refuses malformed knocks', async () => {
    const key = (await newExchange()).publicKey;
    expect(readToHost({ t: 'knock', name: '  Gus‮  ', publicKey: key })).toEqual({ t: 'knock', name: 'Gus', publicKey: key });
    expect(readToHost({ t: 'knock', name: '', publicKey: key })).toBeNull();
    expect(readToHost({ t: 'knock', name: 'Gus', publicKey: 'short' })).toBeNull();
    expect(readToHost({ t: 'answer', box: 'x' })).toBeNull();
    expect(readToGuest({ t: 'offer', box: 'A'.repeat(40) })).toEqual({ t: 'offer', box: 'A'.repeat(40) });
    expect(readToGuest({ t: 'seen', owner: 'Olive', publicKey: 'nope' })).toBeNull();
    expect(readToGuest({ t: 'seen', owner: 'Olive', publicKey: key, ownerKey: key })).toBeNull();
    // Refusals and endings only travel sealed to the one knocker now.
    expect(readToGuest({ t: 'deny' })).toBeNull();
    expect(readToGuest({ t: 'ended' })).toBeNull();
  });
});
