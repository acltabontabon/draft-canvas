/**
 * The layout gallery: requests an agent might really send, from a four-box request path to
 * C4 context/container/component views, a starter with a flow, and edits to existing diagrams. Each
 * is asserted in `tests/agent/gallery.test.ts` (readable, deterministic, nothing existing moved) and
 * rendered in the real editor, light and dark, by `e2e/agent-gallery.ts` for a person to look at.
 */

type Json = Record<string, unknown>;

export interface GalleryCreate {
  id: string;
  title: string;
  kind: 'create';
  request: Json;
}

export interface GalleryUpdate {
  id: string;
  title: string;
  kind: 'update';
  base: Json;
  /** Moves applied to the base as a person would drag shapes, before the agent's edit ("pinned"). */
  arrange?: Record<string, { x: number; y: number }>;
  update: { ops: unknown[]; view?: Json };
}

export type GalleryCase = GalleryCreate | GalleryUpdate;

const n = (id: string, type: string, label: string, extra: Json = {}) => ({ id, type, label, ...extra });
const r = (id: string, from: string, to: string, label?: string, extra: Json = {}) => ({ id, from, to, ...(label ? { label } : {}), ...extra });

export const GALLERY: GalleryCase[] = [
  {
    id: '01-request-path',
    title: 'Simple request path',
    kind: 'create',
    request: {
      title: 'Checkout request path',
      nodes: [n('shopper', 'person', 'Shopper'), n('web', 'service', 'Web Storefront'), n('api', 'api', 'Checkout API'), n('db', 'sql-database', 'Orders DB')],
      relationships: [r('r1', 'shopper', 'web', 'Places order'), r('r2', 'web', 'api', 'POST /checkout'), r('r3', 'api', 'db', 'Writes order')],
    },
  },
  {
    id: '02-branch-merge',
    title: 'Branching flow with a merge',
    kind: 'create',
    request: {
      title: 'Order validation',
      nodes: [
        n('intake', 'api', 'Order Intake'),
        n('fraud', 'service', 'Fraud Check'),
        n('stock', 'service', 'Inventory Check'),
        n('credit', 'external-system', 'Credit Bureau'),
        n('decide', 'service', 'Order Decision'),
        n('notify', 'worker', 'Customer Notifier'),
      ],
      relationships: [
        r('a', 'intake', 'fraud', 'Screens'),
        r('b', 'intake', 'stock', 'Reserves'),
        r('c', 'fraud', 'credit', 'Scores'),
        r('d', 'fraud', 'decide'),
        r('e', 'stock', 'decide'),
        r('f', 'decide', 'notify', 'Outcome'),
      ],
      flows: [{ id: 'happy', title: 'Approved order', steps: ['a', 'd', 'f'] }],
    },
  },
  {
    id: '03-topic-fanout',
    title: 'SNS topic to queues and consumers',
    kind: 'create',
    request: {
      title: 'Repayment events fan-out',
      nodes: [
        n('parser', 'service', 'Batch Parser', { technology: 'Spring Batch' }),
        n('sns', 'topic', 'Repayment Events', { technology: 'Amazon SNS' }),
        n('q1', 'queue', 'Posting Queue', { technology: 'SQS' }),
        n('q2', 'queue', 'Audit Queue', { technology: 'SQS' }),
        n('q3', 'queue', 'Notification Queue', { technology: 'SQS' }),
        n('posting', 'worker', 'Repayment Posting'),
        n('audit', 'worker', 'Audit Writer'),
        n('notify', 'worker', 'Borrower Notifier'),
        n('dlq', 'dead-letter-queue', 'Posting DLQ'),
      ],
      relationships: [
        r('p', 'parser', 'sns', 'Publishes'),
        r('s1', 'sns', 'q1'),
        r('s2', 'sns', 'q2'),
        r('s3', 'sns', 'q3'),
        r('c1', 'q1', 'posting'),
        r('c2', 'q2', 'audit'),
        r('c3', 'q3', 'notify'),
        r('d1', 'q1', 'dlq'),
      ],
    },
  },
  {
    id: '04-cycle-retry',
    title: 'Cycle and retry path',
    kind: 'create',
    request: {
      title: 'Payment retries',
      nodes: [n('api', 'api', 'Payments API'), n('queue', 'queue', 'Payment Jobs'), n('worker', 'worker', 'Payment Worker'), n('psp', 'external-system', 'Card Processor'), n('ledger', 'database', 'Ledger')],
      relationships: [
        r('enqueue', 'api', 'queue', 'Enqueues payment'),
        r('consume', 'queue', 'worker'),
        r('charge', 'worker', 'psp', 'Charges card'),
        r('record', 'worker', 'ledger', 'Records result'),
        r('retry', 'worker', 'queue', 'Re-enqueues on timeout', { kind: 'retry' }),
      ],
    },
  },
  {
    id: '05-groups',
    title: 'Groups with cross-boundary relationships',
    kind: 'create',
    request: {
      title: 'Lending platform domains',
      groups: [
        { id: 'origination', label: 'Origination', kind: 'domain' },
        { id: 'servicing', label: 'Servicing', kind: 'domain' },
        { id: 'payments', label: 'Payments', kind: 'domain', parent: 'servicing' },
      ],
      nodes: [
        n('apply', 'api', 'Application API', { group: 'origination' }),
        n('underwrite', 'service', 'Underwriting', { group: 'origination' }),
        n('appdb', 'database', 'Applications', { group: 'origination' }),
        n('loans', 'service', 'Loan Accounts', { group: 'servicing' }),
        n('repay', 'service', 'Repayments', { group: 'payments' }),
        n('paydb', 'database', 'Payments Ledger', { group: 'payments' }),
        n('bureau', 'external-system', 'Credit Bureau'),
      ],
      relationships: [
        r('a', 'apply', 'underwrite', 'Submits'),
        r('b', 'apply', 'appdb'),
        r('c', 'underwrite', 'bureau', 'Pulls report'),
        r('d', 'underwrite', 'loans', 'Books loan'),
        r('e', 'loans', 'repay', 'Schedules'),
        r('f', 'repay', 'paydb'),
      ],
    },
  },
  {
    id: '06-parallel-bidirectional',
    title: 'Two-way and compensating relationships',
    kind: 'create',
    request: {
      title: 'Booking saga',
      nodes: [n('orch', 'service', 'Booking Orchestrator'), n('hotel', 'service', 'Hotel Service'), n('flight', 'service', 'Flight Service'), n('pay', 'service', 'Payment Service')],
      relationships: [
        r('h1', 'orch', 'hotel', 'Reserve room'),
        r('h2', 'orch', 'hotel', 'Cancel room', { semantic: 'compensates' }),
        r('f1', 'orch', 'flight', 'Book seat'),
        r('p1', 'orch', 'pay', 'Charge'),
        r('p2', 'pay', 'orch', 'Payment confirmed', { kind: 'callback' }),
      ],
      notes: [{ id: 'why', text: 'Every forward step has a compensation; the orchestrator retries a failed step up to three times before compensating.', kind: 'decision', near: 'orch' }],
    },
  },
  {
    id: '07-long-labels-unicode',
    title: 'Long labels, multiline text and Unicode',
    kind: 'create',
    request: {
      title: 'Internationalised onboarding',
      nodes: [
        n('portal', 'service', 'Customer Onboarding Orchestration Service', { description: 'Coordinates identity verification, account creation and the welcome journey for every new retail customer.', technology: 'Spring Boot 3, Kotlin' }),
        n('kyc', 'external-system', 'Vérification d’identité (KYC) — Prestataire externe'),
        n('jp', 'service', '日本語の通知サービス', { technology: 'Go' }),
        n('store', 'nosql-database', 'Onboarding Case Store', { technology: 'MongoDB Atlas' }),
      ],
      relationships: [
        r('a', 'portal', 'kyc', 'Requests identity verification with document images'),
        r('b', 'portal', 'jp', 'Sends localised welcome notification'),
        r('c', 'portal', 'store', 'Persists case state after every step'),
      ],
      layout: { direction: 'right' },
    },
  },
  {
    id: '08-disconnected',
    title: 'Disconnected components',
    kind: 'create',
    request: {
      title: 'Platform services',
      nodes: [
        n('a1', 'api', 'Search API'), n('a2', 'search-index', 'Product Index'), n('a3', 'worker', 'Indexer'),
        n('b1', 'api', 'Reviews API'), n('b2', 'nosql-database', 'Reviews'),
        n('c1', 'scheduler', 'Nightly Export'), n('c2', 'object-storage', 'Data Lake'),
        n('lone', 'gateway', 'Edge Gateway'),
      ],
      relationships: [r('x1', 'a1', 'a2', 'Queries'), r('x2', 'a3', 'a2', 'Indexes'), r('y1', 'b1', 'b2'), r('z1', 'c1', 'c2', 'Exports')],
    },
  },
  {
    id: '09-incremental-pinned',
    title: 'Addition to a hand-arranged diagram',
    kind: 'update',
    base: {
      title: 'Orders (arranged by hand)',
      nodes: [n('web', 'service', 'Web App'), n('api', 'api', 'Orders API'), n('db', 'sql-database', 'Orders DB'), n('cache', 'cache', 'Session Cache')],
      relationships: [r('a', 'web', 'api', 'Calls'), r('b', 'api', 'db'), r('c', 'api', 'cache')],
    },
    // Someone rearranged it: a column, with the cache off to the lower left.
    arrange: { web: { x: 0, y: 0 }, api: { x: 0, y: 200 }, db: { x: 0, y: 420 }, cache: { x: -320, y: 420 } },
    update: {
      ops: [
        { op: 'add', nodes: [n('events', 'topic', 'Order Events'), n('ship', 'worker', 'Shipping Worker')], relationships: [r('pub', 'api', 'events', 'Publishes OrderPlaced'), r('sub', 'events', 'ship')] },
        { op: 'update', id: 'db', set: { technology: 'PostgreSQL 16' } },
      ],
    },
  },
  {
    id: '10-dense',
    title: 'A moderately dense graph',
    kind: 'create',
    request: (() => {
      const services = ['Gateway', 'Accounts', 'Orders', 'Catalog', 'Pricing', 'Inventory', 'Payments', 'Shipping', 'Notifications', 'Search', 'Reviews', 'Recommendations'];
      const ids = services.map((s) => s.toLowerCase());
      const nodes = services.map((s, i) => n(ids[i] as string, i === 0 ? 'gateway' : 'service', s));
      const stores = ['accounts', 'orders', 'catalog', 'inventory', 'payments', 'reviews'].map((id) => n(`${id}-db`, 'database', `${id[0]!.toUpperCase()}${id.slice(1)} DB`));
      const edges = [
        ['gateway', 'accounts'], ['gateway', 'orders'], ['gateway', 'catalog'], ['gateway', 'search'],
        ['orders', 'pricing'], ['orders', 'inventory'], ['orders', 'payments'], ['orders', 'shipping'],
        ['payments', 'notifications'], ['shipping', 'notifications'], ['catalog', 'pricing'], ['search', 'catalog'],
        ['reviews', 'catalog'], ['recommendations', 'catalog'], ['recommendations', 'reviews'], ['gateway', 'recommendations'],
        ['accounts', 'accounts-db'], ['orders', 'orders-db'], ['catalog', 'catalog-db'], ['inventory', 'inventory-db'], ['payments', 'payments-db'], ['reviews', 'reviews-db'],
      ];
      return { title: 'Commerce services', nodes: [...nodes, ...stores], relationships: edges.map(([a, b], i) => r(`e${i}`, a as string, b as string)) };
    })(),
  },
  {
    id: '11-c4-context',
    title: 'C4 system context',
    kind: 'create',
    request: {
      title: 'Internet banking — system context',
      level: 'context',
      nodes: [
        n('customer', 'person', 'Personal Banking Customer', { description: 'A customer of the bank, with personal accounts.' }),
        n('ibs', 'service', 'Internet Banking System', {
          description: 'Lets customers view their accounts and make payments.',
          inside: {
            level: 'container',
            nodes: [n('spa', 'service', 'Single-Page App', { technology: 'React' }), n('apiapp', 'api', 'API Application', { technology: 'Java, Spring MVC' })],
            relationships: [r('i1', 'spa', 'apiapp', 'Makes API calls')],
          },
        }),
        n('mainframe', 'external-system', 'Mainframe Banking System', { description: 'Stores core banking information about customers, accounts and transactions.' }),
        n('email', 'external-system', 'E-mail System', { description: 'The internal Microsoft Exchange e-mail system.' }),
      ],
      relationships: [
        r('u', 'customer', 'ibs', 'Views account balances and makes payments'),
        r('m', 'ibs', 'mainframe', 'Gets account information'),
        r('e', 'ibs', 'email', 'Sends e-mail'),
        r('n', 'email', 'customer', 'Sends e-mails to'),
      ],
    },
  },
  {
    id: '12-c4-container',
    title: 'C4 container view',
    kind: 'create',
    request: {
      title: 'Internet banking — containers',
      level: 'container',
      groups: [{ id: 'ibs', label: 'Internet Banking System', kind: 'system' }],
      nodes: [
        n('customer', 'person', 'Personal Banking Customer'),
        n('web', 'service', 'Web Application', { group: 'ibs', technology: 'Java, Spring MVC', description: 'Delivers the single-page app.' }),
        n('spa', 'service', 'Single-Page App', { group: 'ibs', technology: 'React', description: 'All banking features in the browser.' }),
        n('api', 'api', 'API Application', { group: 'ibs', technology: 'Java, Spring MVC', description: 'Banking functionality over JSON/HTTPS.' }),
        n('db', 'sql-database', 'Database', { group: 'ibs', technology: 'Oracle', description: 'Credentials, access logs, preferences.' }),
        n('events', 'topic', 'Audit Events', { group: 'ibs', technology: 'Kafka' }),
        n('mainframe', 'external-system', 'Mainframe Banking System'),
      ],
      relationships: [
        r('a', 'customer', 'web', 'Visits'),
        r('b', 'web', 'spa', 'Delivers'),
        r('c', 'spa', 'api', 'Makes API calls'),
        r('d', 'api', 'db', 'Reads and writes'),
        r('e', 'api', 'mainframe', 'Makes API calls'),
        r('f', 'api', 'events', 'Publishes audit events'),
      ],
    },
  },
  {
    id: '13-c4-component',
    title: 'C4 component view (inside the API)',
    kind: 'create',
    request: {
      title: 'API Application',
      level: 'container',
      nodes: [
        n('api', 'api', 'API Application', {
          technology: 'Java, Spring MVC',
          inside: {
            level: 'component',
            nodes: [
              n('signin', 'component', 'Sign In Controller', { technology: 'Spring MVC Controller', description: 'Lets users sign in.' }),
              n('accounts', 'component', 'Accounts Summary Controller', { technology: 'Spring MVC Controller', description: 'A summary of the customer’s accounts.' }),
              n('security', 'component', 'Security Component', { technology: 'Spring Bean', description: 'Signing in, changing passwords.' }),
              n('facade', 'component', 'Mainframe Facade', { technology: 'Spring Bean', description: 'A facade onto the mainframe.' }),
              n('db', 'sql-database', 'Database', { technology: 'Oracle' }),
              n('mainframe', 'external-system', 'Mainframe Banking System'),
            ],
            relationships: [
              r('a', 'signin', 'security', 'Uses'),
              r('b', 'accounts', 'facade', 'Uses'),
              r('c', 'security', 'db', 'Reads and writes'),
              r('d', 'facade', 'mainframe', 'Makes API calls'),
            ],
          },
        }),
      ],
    },
  },
  {
    id: '14-starter-flow',
    title: 'Starter with overrides, an extra element and a flow',
    kind: 'create',
    request: {
      title: 'Order events (from the Event-Driven starter)',
      starter: { id: 'event-driven', prefix: '', overrides: { producer: { label: 'Order Service', technology: 'Spring Boot' }, topic: { label: 'order-events', technology: 'Kafka' } } },
      nodes: [n('audit', 'worker', 'Audit Trail Writer')],
      relationships: [r('audit-sub', 'topic', 'audit', 'Consumes every event')],
    },
  },
  {
    id: '15-feature-rich-edit',
    title: 'Edit that preserves notes, actions, code and flows',
    kind: 'update',
    base: {
      title: 'Payments review',
      nodes: [
        n('api', 'api', 'Payments API', { attachments: [{ kind: 'code', language: 'json', code: '{ "idempotencyKey": "uuid" }' }] }),
        n('worker', 'worker', 'Settlement Worker'),
        n('db', 'database', 'Ledger'),
      ],
      relationships: [r('a', 'api', 'worker', 'Queues settlement'), r('b', 'worker', 'db', 'Posts entries')],
      flows: [{ id: 'settle', title: 'Settlement', steps: ['a', 'b'] }],
      notes: [
        { id: 'q', text: 'Do we need exactly-once posting, or is idempotency enough?', kind: 'question', near: 'worker' },
        { id: 'dec', text: 'Settle in batches of 500.', kind: 'decision', near: 'db' },
      ],
      actions: [{ id: 'act', text: 'Confirm batch size with finance', about: 'db' }],
    },
    update: {
      ops: [
        { op: 'add', nodes: [n('recon', 'scheduler', 'Nightly Reconciliation')], relationships: [r('c', 'recon', 'db', 'Reconciles')] },
        { op: 'update', id: 'worker', set: { technology: 'Kotlin' } },
      ],
    },
  },
  {
    id: '16-notes-busy',
    title: 'Notes beside a busy hub: free, attached and inside a boundary',
    kind: 'create',
    request: {
      title: 'Checkout with notes',
      groups: [{ id: 'pay', label: 'Payments', kind: 'system' }],
      nodes: [
        n('web', 'service', 'Web Checkout'),
        n('api', 'api', 'Checkout API', { technology: 'Node.js' }),
        n('cart', 'cache', 'Cart Cache'),
        n('orders', 'sql-database', 'Orders DB'),
        n('psp', 'external-system', 'Card Processor', { group: 'pay' }),
        n('ledger', 'database', 'Ledger', { group: 'pay' }),
        n('events', 'topic', 'checkout-events'),
      ],
      relationships: [
        r('c1', 'web', 'api', 'POST /checkout'),
        r('c2', 'api', 'cart', 'Reads cart'),
        r('c3', 'api', 'orders', 'Writes order'),
        r('c4', 'api', 'psp', 'Authorises card'),
        r('c5', 'psp', 'ledger', 'Settles'),
        r('c6', 'api', 'events', 'Publishes CheckoutCompleted'),
      ],
      notes: [
        { id: 'n-idem', text: 'Every call carries an idempotency key;\na retry never charges twice.', kind: 'decision', about: 'api' },
        { id: 'n-ttl', text: 'Assumption: carts expire after 30 minutes.', kind: 'question', about: 'cart' },
        { id: 'n-pci', text: 'PCI scope ends here.', kind: 'warning', about: 'pay' },
        { id: 'n-auth', text: '3-D Secure challenge may add 10 s.', about: 'c4' },
      ],
      flows: [{ id: 'main', title: 'Checkout', steps: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] }],
      layout: { primaryFlow: 'main' },
    },
  },
  {
    id: '17-retry-main-path',
    title: 'A retry loop and a dead-letter path around a main path',
    kind: 'create',
    request: {
      title: 'Payment processing with retries',
      nodes: [
        n('api', 'api', 'Payments API'),
        n('jobs', 'queue', 'payment-jobs'),
        n('worker', 'worker', 'Payment Worker'),
        n('retry', 'queue', 'payment-retry'),
        n('dlq', 'dead-letter-queue', 'payment-dlq'),
        n('ledger', 'sql-database', 'Ledger'),
      ],
      relationships: [
        r('p1', 'api', 'jobs', 'Enqueues payment'),
        r('p2', 'jobs', 'worker', 'Delivers'),
        r('p3', 'worker', 'ledger', 'Records result'),
        r('p4', 'worker', 'retry', 'On timeout', { kind: 'retry' }),
        r('p5', 'retry', 'worker', 'Redelivers after backoff'),
        r('p6', 'worker', 'dlq', 'After 5 attempts', { kind: 'failure' }),
      ],
      flows: [
        { id: 'normal', title: 'Normal processing', steps: ['p1', 'p2', 'p3'] },
        { id: 'retrying', title: 'Retry', steps: ['p4', 'p5'] },
      ],
      layout: { primaryFlow: 'normal' },
    },
  },
  {
    id: '18-cleanup',
    title: 'A messy diagram cleaned up in place ({op:"arrange"})',
    kind: 'update',
    base: {
      title: 'Orders (messy)',
      nodes: [
        n('web', 'service', 'Web Storefront'),
        n('api', 'api', 'Orders API'),
        n('db', 'sql-database', 'Orders DB'),
        n('events', 'topic', 'order-events'),
        n('billing', 'worker', 'Billing Worker'),
        n('email', 'worker', 'Email Worker'),
      ],
      relationships: [r('a', 'web', 'api', 'POST /orders'), r('b', 'api', 'db', 'Writes order'), r('c', 'api', 'events', 'Publishes'), r('d', 'events', 'billing'), r('e', 'events', 'email')],
      notes: [{ id: 'nb', text: 'Billing retries 5 times, then parks the message.', about: 'billing' }],
      flows: [{ id: 'happy', title: 'Normal processing', steps: ['a', 'c', 'd'] }],
    },
    arrange: { web: { x: 520, y: 480 }, billing: { x: -300, y: 60 }, nb: { x: -300, y: 170 }, email: { x: 880, y: -160 }, events: { x: 140, y: 400 } },
    update: { ops: [{ op: 'arrange' }] },
  },
  {
    // The MCP layout-quality regression case: two actors and four external systems that used to come
    // out different sizes and misaligned, with one connector (the loan officer's override) looping
    // around the focal system instead of routing to it directly. `tests/agent/gallery.test.ts` checks
    // this case specifically for peer-uniform sizing on top of the generic readability assertions.
    id: '19-loan-application-context',
    title: 'C4 context: peer-uniform actors and external systems, no looping connectors',
    kind: 'create',
    request: {
      title: 'Loan application — system context',
      level: 'context',
      nodes: [
        n('applicant', 'person', 'Applicant', { description: 'A person applying for a loan online.' }),
        n('officer', 'person', 'Loan Officer', { description: 'Reviews applications, overrides automated decisions.' }),
        n('focal', 'service', 'Loan Application System', { description: 'Accepts, underwrites, decisions and disburses consumer loan applications.' }),
        n('bureau', 'external-system', 'Credit Bureau', { description: 'Third-party credit history and score provider.' }),
        n('kyc', 'external-system', 'KYC Provider', { description: 'Identity verification and fraud checks.' }),
        n('core', 'external-system', 'Core Banking System', { description: 'Holds accounts and settles disbursed funds.' }),
        n('notify', 'external-system', 'Email/SMS Provider', { description: 'Delivers applicant notifications.' }),
      ],
      relationships: [
        r('a', 'applicant', 'focal', 'Applies for a loan and tracks status'),
        r('b', 'officer', 'focal', 'Reviews and overrides decisions'),
        r('c', 'focal', 'bureau', 'Fetches credit reports'),
        r('d', 'focal', 'kyc', 'Verifies applicant identity'),
        r('e', 'focal', 'core', 'Disburses approved funds'),
        r('f', 'focal', 'notify', 'Sends applicant notifications'),
      ],
    },
  },
  {
    // Route-only cleanup ({op:"arrange", move:false}): only the connectors touching the scope are
    // re-anchored; the shapes stay exactly where they are, and a neighbour's own connector (not in
    // the scope) is neither moved nor made to collide with the ones that are.
    id: '20-route-only-cleanup',
    title: 'Reconnect two edges into a hub without moving anything ({op:"arrange", move:false})',
    kind: 'update',
    base: {
      title: 'Hub with three inputs',
      nodes: [n('p', 'service', 'P'), n('q', 'service', 'Q'), n('r', 'service', 'R'), n('hub', 'service', 'Hub')],
      relationships: [r('pe', 'p', 'hub'), r('qe', 'q', 'hub'), r('re', 'r', 'hub')],
    },
    arrange: { p: { x: -40, y: -260 }, q: { x: -40, y: -60 }, r: { x: -40, y: 220 }, hub: { x: 360, y: -20 } },
    update: { ops: [{ op: 'arrange', move: false, scope: { nodes: ['p', 'q'] } }] },
  },
  {
    // The reported regression: a container view an agent sent over MCP that passed every check yet
    // read badly — lines to the external providers across the whole system, a notification looping
    // under everything back to the applicant, notes far from what they describe and a boundary that
    // was mostly empty. `tests/agent/gallery.test.ts` holds it to its legibility numbers too.
    id: '21-card-provisioning',
    title: 'Container view: nested domain, grouped externals, a reviewer loop and notes',
    kind: 'create',
    request: {
      title: 'Card provisioning — containers',
      level: 'container',
      groups: [
        { id: 'platform', label: 'Card Provisioning Platform', kind: 'system' },
        { id: 'svc', label: 'Serviceability Check', kind: 'domain', parent: 'platform' },
        { id: 'ext', label: 'External Verification Providers', kind: 'group' },
      ],
      nodes: [
        n('applicant', 'person', 'Applicant'),
        n('app', 'service', 'Card App (Mobile/Web)', { technology: 'Web / Mobile client' }),
        n('gw', 'gateway', 'API Gateway', { group: 'platform' }),
        n('cps', 'service', 'Card Provisioning Service', { group: 'platform', description: 'Orchestrates the end-to-end card provisioning request.' }),
        n('check', 'service', 'Serviceability Check Service', { group: 'svc', description: 'Decides whether the applicant and address can be serviced before a card is issued.' }),
        n('addr', 'service', 'Address Validation', { group: 'svc' }),
        n('idv', 'service', 'Identity Verification', { group: 'svc' }),
        n('risk', 'service', 'Credit Risk Check', { group: 'svc' }),
        n('rules', 'service', 'Eligibility Rules Engine', { group: 'svc' }),
        n('rcache', 'cache', 'Eligibility Rules Cache', { group: 'svc' }),
        n('review', 'queue', 'Manual Review Queue', { group: 'svc' }),
        n('issue', 'service', 'Card Issuance Service', { group: 'platform', description: 'Creates the physical/virtual card once the applicant is deemed serviceable.' }),
        n('carddb', 'database', 'Card Database', { group: 'platform' }),
        n('custdb', 'database', 'Customer Database', { group: 'platform' }),
        n('audit', 'database', 'Audit Log Store', { group: 'platform' }),
        n('outcome', 'topic', 'Provisioning Outcome Topic', { group: 'platform' }),
        n('notify', 'worker', 'Notification Service', { group: 'platform' }),
        n('addrp', 'external-system', 'Address Data Provider', { group: 'ext' }),
        n('kyc', 'external-system', 'KYC / Identity Provider', { group: 'ext' }),
        n('bureau', 'external-system', 'Credit Bureau', { group: 'ext' }),
        n('reviewer', 'person', 'Compliance Reviewer'),
      ],
      relationships: [
        r('r1', 'applicant', 'app', 'Requests new card'),
        r('r2', 'app', 'gw', 'Submits provisioning request'),
        r('r3', 'gw', 'cps', 'Routes request'),
        r('r4', 'cps', 'check', 'Checks serviceability'),
        r('r5', 'check', 'addr', 'Validates address'),
        r('r6', 'check', 'idv', 'Verifies identity'),
        r('r7', 'check', 'risk', 'Requests risk score'),
        r('r8', 'check', 'rules', 'Evaluates eligibility'),
        r('r9', 'rules', 'rcache', 'Reads eligibility rules'),
        r('r10', 'check', 'review', 'Escalates for manual review', { condition: 'provider retries exhausted' }),
        r('r11', 'addr', 'addrp', 'Verifies address'),
        r('r12', 'idv', 'kyc', 'Runs KYC check'),
        r('r13', 'risk', 'bureau', 'Pulls credit report'),
        r('r14', 'review', 'reviewer', 'Assigns case'),
        r('r15', 'reviewer', 'cps', 'Submits manual serviceability decision'),
        r('r16', 'cps', 'issue', 'Issues card', { condition: 'serviceable = true' }),
        r('r17', 'issue', 'carddb', 'Persists card record'),
        r('r18', 'issue', 'custdb', 'Links card to account'),
        r('r19', 'cps', 'audit', 'Logs provisioning decision'),
        r('r20', 'cps', 'outcome', 'Publishes provisioning outcome'),
        r('r21', 'outcome', 'notify', 'Consumes outcome event'),
        r('r22', 'notify', 'applicant', 'Sends outcome notification'),
      ],
      notes: [
        { id: 'n-retry', text: 'Each external check (address, identity, credit) retries up to 2x with exponential backoff before being treated as a failure and escalated.', about: 'check' },
        { id: 'n-decision', text: 'Serviceable only if the address is deliverable, identity is verified, and credit risk is within threshold — a rejection on any one check fails the whole request.', kind: 'decision', about: 'svc' },
        { id: 'n-notify', text: "Delivers the outcome (approved or declined) via the applicant's preferred channel — push, SMS or email.", about: 'notify' },
      ],
    },
  },
];
