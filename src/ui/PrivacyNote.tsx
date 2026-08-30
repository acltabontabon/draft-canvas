import { Icon } from './common/Icon';

/**
 * The privacy claim, stated plainly and without overselling it.
 *
 * The honest caveat — that clearing site data removes diagrams — is included
 * because a local-first tool that hides that fact will eventually lose someone
 * their work.
 */
export function PrivacyNote({ durable }: { durable: boolean }) {
  return (
    <section className="dc-privacy">
      <h3>
        <Icon name="lock" /> Stored on this device
      </h3>
      {durable ? (
        <p>
          Your diagrams are kept in this browser&rsquo;s local database. Nothing you draw is
          uploaded, and Draft Canvas makes no network requests once it has loaded.
        </p>
      ) : (
        <p className="dc-warn">
          This browser is blocking local storage, so diagrams live in memory only and will be lost
          when you close the tab. Export anything you want to keep.
        </p>
      )}
      <p className="dc-muted">
        Clearing your browser&rsquo;s site data will delete them. Export a{' '}
        <code>.draftcanvas</code> file to keep a copy you control.
      </p>
    </section>
  );
}
