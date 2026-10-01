import { useEffect, useState } from 'react';
import { subscribeAnnouncements, type Announcement } from '../../lib/announce';

/**
 * The one `aria-live` region `announce()` speaks through — see `lib/announce.ts` for why there is
 * only one. Two regions, polite and assertive, both always mounted and empty until something is
 * said: a region that is created with its first message is often skipped by the screen reader.
 * Each message is keyed on its sequence number, so repeating the same words replaces the text
 * node and is read again.
 */
export function LiveAnnouncer() {
  const [polite, setPolite] = useState<Announcement | null>(null);
  const [assertive, setAssertive] = useState<Announcement | null>(null);

  useEffect(
    () =>
      subscribeAnnouncements((announcement) => {
        if (announcement.assertive) setAssertive(announcement);
        else setPolite(announcement);
      }),
    [],
  );

  return (
    <>
      <div className="dc-sr-only" role="status" aria-live="polite" aria-atomic="true" data-dc-announcer="polite">
        {polite && <span key={polite.seq}>{polite.text}</span>}
      </div>
      <div className="dc-sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-dc-announcer="assertive">
        {assertive && <span key={assertive.seq}>{assertive.text}</span>}
      </div>
    </>
  );
}
