#!/usr/bin/env python3
"""Survey a repository and write a first create_diagram request for it, in one command.

Runs the survey (scan_repo.py), prints it, and writes two files to an output folder (a new temporary
folder unless --out names one; never the repository):

  survey.md     the survey, as printed
  request.json  a create_diagram request built from what the survey found: the containers, stores,
                queues and external systems, the connections the configuration states, evidence on
                every element, and the C4 shape the skill's size rules pick

Everything the survey can't know — what each part is for, what each connection carries, the flows —
is left as a `TODO:` placeholder. check_diagram.py refuses a request that still has one, so the draft
can't be sent half-finished. Standard library only.

    python3 draft.py <repo-root> [--out <folder>]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import uuid

# The scripts run from an agent's skills folder: importing the survey must not leave a __pycache__
# there for every repository drafted.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import scan_repo as scan  # noqa: E402 — after the path and bytecode settings above

TODO_DESCRIPTION = 'TODO: its job, in one sentence'
TODO_LABEL = 'TODO: what happens'
#: Past this many parts inside the system, the top view is a C4 context view (CROWDED_BOUNDARY in the app).
MAX_CONTAINER_VIEW = 8
#: Survey types that are code libraries, not running parts: drawn through the units that use them.
LIBRARY_KEYS = {'celery', 'sidekiq', 'rq', 'bullmq'}
CHANNEL_SUFFIX = re.compile(r'[-_.:](exchange|queue|topic|stream|q|ex)$', re.I)
ORDER = {'person': 0, 'gateway': 1, 'service': 2, 'api': 3, 'worker': 4, 'scheduler': 5}
ACRONYMS = {'api': 'API', 'db': 'DB', 'ui': 'UI', 'grpc': 'gRPC', 'http': 'HTTP', 'sql': 'SQL', 'bff': 'BFF', 'cdn': 'CDN', 'id': 'ID'}
#: Survey names whose product, as Draft Canvas names its logo, is shorter. A technology the app shows
#: as a plain mark although it starts with a product draws an advisory and costs an update to fix.
PRODUCTS = {
    'Actix Web': 'Actix',
    'Django REST framework': 'Django',
    'GraphQL server': 'GraphQL',
    'MQTT broker': 'MQTT',
    'Firebase Cloud Messaging': 'Firebase',
    'Google Maps Platform': 'Google Maps',
}
#: Framework names in the survey that aren't products: never a technology.
NOT_PRODUCTS = {'CLI', 'scheduler library'}


def slug(name: str) -> str:
    text = re.sub(r'[^A-Za-z0-9]+', '-', name).strip('-').lower()
    if not text or not text[0].isalpha():
        text = f'x-{text}' if text else 'x'
    return text[:60]


def humanize(name: str) -> str:
    """'grpc-currency-service' → 'gRPC Currency Service', 'cartservice' → 'Cart Service'."""
    words = [w for w in re.split(r'[-_.\s/]+', re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name)) if w]
    out = []
    for word in words:
        low = word.lower()
        if low.endswith('service') and len(low) > len('service'):
            out.extend([low[: -len('service')].capitalize(), 'Service'])
        else:
            out.append(ACRONYMS.get(low, word[:1].upper() + word[1:]))
    return ' '.join(out)[:60] or name


class Draft:
    """Elements and relationships being drafted, with the names each element is known by."""

    def __init__(self, root: str):
        self.root = root
        self.nodes: list[dict] = []
        self.ids: dict[str, str] = {}  # every name an element goes by (slugged) → its id
        self.relationships: list[dict] = []
        self.pairs: set[tuple[str, str]] = set()
        self.made = 0

    def evidence(self, *paths: str | None) -> list[dict]:
        seen = []
        for path in paths:
            if path and path not in seen and os.path.exists(os.path.join(self.root, path)):
                seen.append(path)
        return [{'path': p, 'basis': 'observed'} for p in seen[:3]]

    def add(
        self, name: str, kind: str, technology: str | None, evidence: list[dict], aliases: tuple[str, ...] = (), *, label: str | None = None
    ) -> str:
        key = slug(name)
        if key in self.ids:
            node_id = self.ids[key]
        else:
            node_id = key
            n = 2
            while any(node['id'] == node_id for node in self.nodes):
                node_id, n = f'{key}-{n}', n + 1
            node = {'id': node_id, 'type': kind, 'label': label or humanize(name)}
            if kind != 'person':
                node['description'] = TODO_DESCRIPTION
            if technology:
                node['technology'] = product(technology)[:60]
            if evidence:
                node['evidence'] = evidence
            self.nodes.append(node)
            self.ids[key] = node_id
        for alias in aliases:
            self.ids.setdefault(slug(alias), node_id)
        return node_id

    def find(self, name: str) -> str | None:
        return self.ids.get(slug(name)) or self.ids.get(slug(scan.stem(name)) or '-')

    def connect(self, source: str | None, target: str | None, **extra: object) -> None:
        if not source or not target or source == target or (source, target) in self.pairs:
            return
        self.pairs.add((source, target))
        # Counted, not the list's length: a relationship can be taken out again (split_driver_stores).
        self.made += 1
        self.relationships.append({'id': f'r{self.made}', 'from': source, 'to': target, 'label': TODO_LABEL, **extra})


def build(data: dict) -> tuple[dict, dict]:
    """The create_diagram request for a survey, and a summary of how it was drafted."""
    d = Draft(data['root'])
    units = [
        u
        for u in data['units']
        if not u['suggested_type'].startswith(('workspace', 'library')) and not scan.DEV_SERVICE.fullmatch(u['name'] or '')
    ]
    signals = [s for s in data['signals'] if s['type'] != '-' and s['category'] != 'dev' and s['key'] not in LIBRARY_KEYS]
    infra_by_key = {s['key']: s for s in signals}
    channels = channel_groups(data['messages'])
    broker = next((s for s in signals if s['category'] == 'messaging' and s['type'] in ('queue', 'topic', 'stream')), None)

    d.add('User', 'person', None, [])
    for edge in (s for s in signals if s['category'] == 'edge'):
        d.add(edge['name'], 'gateway', edge['name'], d.evidence(*paths_of(edge, data)), aliases=(edge['key'],), label=edge['name'])
    add_containers(d, data, units, infra_by_key)
    for store in (s for s in signals if s['category'] == 'store'):
        d.add(
            store['name'],
            store['type'],
            store['name'],
            d.evidence(*paths_of(store, data)),
            aliases=(store['key'], *infra_names(data, store['key'])),
            label=store['name'],
        )
    if channels:
        kind = broker['type'] if broker else 'queue'
        for name, sides in channels.items():
            channel = d.add(name, kind, broker['name'] if broker else None, d.evidence(*sides['at']))
            for owner in sorted(sides['publish']):
                d.connect(d.find(owner), channel, **({'semantic': 'publishes'} if kind in ('topic', 'stream') else {}))
            for owner in sorted(sides['consume']):
                d.connect(channel, d.find(owner))
    elif broker:
        d.add(
            broker['name'],
            broker['type'],
            broker['name'],
            d.evidence(*paths_of(broker, data)),
            aliases=(broker['key'], *infra_names(data, broker['key'])),
            label=broker['name'],
        )
    for external in (
        s for s in signals if s['category'] == 'external' or (s['category'] == 'messaging' and s['type'] == 'external-system')
    ):
        d.add(
            external['name'],
            'external-system',
            external['name'],
            d.evidence(*paths_of(external, data)),
            aliases=(external['key'],),
            label=external['name'],
        )

    for link in data['links']:
        source, target = d.find(link['from']), d.find(link['to'])
        # With the broker drawn as its channels, "uses RabbitMQ" is what the channel lines already say.
        if channels and broker and target == d.ids.get(slug(broker['name'])):
            continue
        d.connect(source, target)
    split_driver_stores(d, [s for s in signals if s['category'] == 'store'])
    settle_roles(d)
    entry = entry_point(d)
    gateway = next((n['id'] for n in d.nodes if n['type'] == 'gateway'), None)
    if gateway and not any(r['from'] == gateway for r in d.relationships):
        d.connect(gateway, entry)
    d.connect('user', gateway or entry)

    # Reading order, which the layout follows: who comes in, where, then what that calls.
    d.nodes.sort(key=lambda n: ORDER.get(n['type'], 6 if n['type'] != 'external-system' else 7) if n['id'] != entry else 1.5)
    return shape(data, d)


def split_driver_stores(d: Draft, stores: list[dict]) -> None:
    """A store known only from client libraries is one per program that uses it. Two services with a
    Postgres driver say nothing about sharing one database, and a shared box drawn on that guess
    became a hub every line had to cross; nothing deploys it, so each owner's is drawn beside it."""
    for store in stores:
        if not store['evidence'] or not all('(dep ' in e for e in store['evidence']):
            continue
        sid = d.ids.get(slug(store['name']))
        callers = sorted({r['from'] for r in d.relationships if r['to'] == sid})
        if not sid or len(callers) < 2:
            continue
        shared = next(n for n in d.nodes if n['id'] == sid)
        at = d.nodes.index(shared)
        d.nodes.remove(shared)
        d.relationships = [r for r in d.relationships if r['to'] != sid]
        d.pairs = {(a, b) for a, b in d.pairs if b != sid}
        for caller in callers:
            owner = next(n for n in d.nodes if n['id'] == caller)
            node = {**shared, 'id': f'{caller}.{sid}', 'label': f'{owner["label"].removesuffix(" Service")} Store'[:60]}
            node.pop('evidence', None)
            if owner.get('evidence'):
                # Only the owner's driver dependency says it is there: the agent confirms it in code.
                node['evidence'] = [
                    {**owner['evidence'][0], 'basis': 'inferred', 'explanation': f'{shared["label"]} driver in its dependencies'}
                ]
            d.nodes.insert(at, node)
            d.connect(caller, node['id'])


def settle_roles(d: Draft) -> None:
    """A program that only takes work off queues, with nothing calling it directly, is a worker."""
    channels = {n['id'] for n in d.nodes if n['type'] in ('queue', 'topic', 'stream', 'dead-letter-queue')}
    for node in d.nodes:
        if node['type'] not in ('service', 'api'):
            continue
        incoming = [r['from'] for r in d.relationships if r['to'] == node['id']]
        if incoming and all(source in channels for source in incoming):
            node['type'] = 'worker'


def entry_point(d: Draft) -> str | None:
    """Where a person comes in: the running part nothing else calls that calls the most, a web app
    before an API on a tie."""
    callers = {r['to'] for r in d.relationships}
    candidates = [n for n in d.nodes if n['type'] in ('service', 'api') and n['id'] not in callers]
    if not candidates:
        candidates = [n for n in d.nodes if n['type'] in ('service', 'api')]
    outgoing = {n['id']: sum(r['from'] == n['id'] for r in d.relationships) for n in candidates}
    best = max(candidates, key=lambda n: (outgoing[n['id']], n['type'] == 'service'), default=None)
    return best['id'] if best else None


def add_containers(d: Draft, data: dict, units: list[dict], infra_by_key: dict) -> None:
    """The running parts, from the most explicit source there is: compose, then a module's programs,
    then manifests, then deployment manifests."""
    services = merged_compose(data['compose'])
    added = False
    for name, (file, svc) in services.items():
        image = (svc.get('image') or '').split(':', 1)[0].lower()
        if scan.is_dev_service(name, svc) or (image and scan.match_key(image, scan.IMAGE_SIGNALS) in infra_by_key):
            continue
        unit = unit_for(name, svc, units)
        aliases = (unit['name'] or '', os.path.basename(unit['path'])) if unit else ()
        evidence = d.evidence(file, *(unit['entry_points'][:1] if unit else []))
        d.add(name, element_type(unit), technology_of(unit, svc.get('image')), evidence, aliases=tuple(a for a in aliases if a))
        added = True
    if added:
        # A program compose doesn't run can still be part of the system: one that sends or takes
        # messages, or that a stated connection names.
        involved = {m['unit'] for m in data['messages']} | {name for link in data['links'] for name in (link['from'], link['to'])}
        for unit in units:
            for program in unit['binaries'] if len(unit['binaries']) > 1 else []:
                if program in involved and not d.find(program):
                    d.add(program, element_type(unit), technology_of(unit, None), d.evidence(program_main(unit, program)))
    if not added:
        for unit in units:
            if len(unit['binaries']) > 1:
                for program in unit['binaries']:
                    d.add(program, element_type(unit), technology_of(unit, None), d.evidence(program_main(unit, program)))
            else:
                evidence = d.evidence(*unit['entry_points'][:1], *unit['dockerfiles'][:1], *unit['manifests'][:1])
                d.add(unit['name'], element_type(unit), technology_of(unit, None), evidence, aliases=(os.path.basename(unit['path']),))
            added = True
    if not added:
        for workload in data['kubernetes'] + data['nomad']:
            name = workload.get('name') or workload.get('task')
            image = (workload.get('detail') or workload.get('image') or '').split(':', 1)[0].lower()
            if (
                name
                and workload.get('kind', 'Deployment') in ('Deployment', 'StatefulSet', 'CronJob')
                and not scan.match_key(image, scan.IMAGE_SIGNALS)
            ):
                d.add(name, 'scheduler' if workload.get('kind') == 'CronJob' else 'service', None, d.evidence(workload['file']))


def merged_compose(files: dict[str, dict]) -> dict[str, tuple[str, dict]]:
    """Every compose service once, with what all files say about it: an override file adds ports or
    environment to a service whose image the base file names."""
    merged: dict[str, tuple[str, dict]] = {}
    for file, services in sorted(files.items(), key=lambda kv: -len(kv[1])):
        for name, svc in services.items():
            first_file, known = merged.get(name, (file, {}))
            merged[name] = (first_file, {**svc, **{k: v for k, v in known.items() if v}})
    return merged


def program_main(unit: dict, program: str) -> str:
    return f'cmd/{program}/main.go' if unit['path'] == '.' else f'{unit["path"]}/cmd/{program}/main.go'


def unit_for(name: str, svc: dict, units: list[dict]) -> dict | None:
    context = (svc.get('build') or '').strip().strip('./')
    for unit in units:
        if context and unit['path'].strip('./') == context:
            return unit
    wanted = scan.stem(name)
    return next(
        (
            u
            for u in units
            if wanted in (scan.stem(u['name'] or ''), scan.stem(os.path.basename(u['path'])), *(scan.stem(b) for b in u['binaries']))
        ),
        None,
    )


def element_type(unit: dict | None) -> str:
    kind = (unit or {}).get('suggested_type', 'service').split(' ', 1)[0]
    return kind if kind in ('api', 'worker', 'scheduler', 'service') else 'service'


def product(name: str) -> str:
    """A technology as Draft Canvas shows its logo: one product's own name ("Anthropic API" →
    "Anthropic"); the rest belongs in the description. tests/agent-skill.test.ts holds every name the
    survey knows to the app's own rule."""
    name = PRODUCTS.get(name, name)
    return name[: -len(' API')] if name.endswith(' API') else name


def technology_of(unit: dict | None, image: str | None) -> str | None:
    """One product: the framework behind the unit's suggested type (Tauri for a desktop app, Express
    for an API), else its first framework, else its language. The survey lists the rest."""
    if unit:
        roles = {name: (rank, role) for rank, (_, name, role) in enumerate(scan.FRAMEWORKS)}
        found = sorted((f for f in unit['frameworks'] if f in roles and f not in NOT_PRODUCTS), key=lambda f: roles[f][0])
        suggested = unit.get('suggested_type', '')
        wanted = next(
            (role for role in ('mobile', 'desktop', 'web') if f'{role} app' in suggested), 'api' if suggested.startswith('api') else None
        )
        chosen = next((f for f in found if roles[f][1] == wanted), found[0] if found else None)
        return chosen or (unit['languages'][0].split('/')[0] if unit['languages'] else None)
    return image.split('@', 1)[0] if image else None


def paths_of(signal: dict, data: dict) -> list[str]:
    """Files that show a store, broker or provider: a manifest, a compose file, a source file."""
    out = []
    manifests = {u['path']: u['manifests'] for u in data['units']}
    for where in signal['evidence']:
        if ' (dep ' in where:
            out.extend(manifests.get(where.split(' (dep ', 1)[0], [])[:1])
        elif ' (boto3 ' in where or ' (aws-sdk ' in where:
            out.append(where.split(' (', 1)[0])
        elif where.startswith('env ') and ' in ' in where:
            out.append(where.split(' in ', 1)[1])
        elif ':' in where and not where.startswith('env '):
            out.append(where.rsplit(':', 1)[0])
    return out


def infra_names(data: dict, key: str) -> list[str]:
    """Compose services and workloads that run `key` (postgres, rabbitmq…), so links to them resolve."""
    names = []
    for services in data['compose'].values():
        for name, svc in services.items():
            if scan.match_key((svc.get('image') or '').split(':', 1)[0].lower(), scan.IMAGE_SIGNALS) == key:
                names.append(name)
    return names


def channel_groups(messages: list[dict]) -> dict[str, dict]:
    """Queue and topic names, an exchange and its queue taken as one channel, with who publishes and
    who consumes. A name nobody both sends to and reads from is still drawn: its other side may be
    outside the repository."""
    groups: dict[str, dict] = {}
    for message in messages:
        name = CHANNEL_SUFFIX.sub('', message['name'])
        group = groups.setdefault(name, {'publish': set(), 'consume': set(), 'at': []})
        if message['kind'] in ('publish', 'consume'):
            group[message['kind']].add(message['unit'])
        path = message['at'].rsplit(':', 1)[0]
        if path not in group['at']:
            group['at'].append(path)
    return {name: g for name, g in groups.items() if g['publish'] or g['consume']}


def shape(data: dict, d: Draft) -> tuple[dict, dict]:
    """The C4 shape, by the skill's rule: up to ~8 parts read as one container view; more, with
    external systems around them, open on a context view with the containers inside."""
    title = humanize(os.path.basename(data['root'].rstrip('/\\')) or 'System')
    people = [n for n in d.nodes if n['type'] == 'person']
    externals = [n for n in d.nodes if n['type'] == 'external-system']
    inside = [n for n in d.nodes if n not in people and n not in externals]
    request: dict = {'requestId': str(uuid.uuid4()), 'title': title, 'open': True}
    if len(inside) > MAX_CONTAINER_VIEW and externals:
        system = 'system'
        top_rels = [{'id': 'k1', 'from': 'user', 'to': system, 'label': TODO_LABEL}]
        top_rels += [{'id': f'k{i + 2}', 'from': system, 'to': n['id'], 'label': TODO_LABEL} for i, n in enumerate(externals)]
        copies = {n['id']: f'c.{n["id"]}' for n in people + externals}
        inner_nodes = [{**n, 'id': copies.get(n['id'], n['id'])} for n in d.nodes]
        inner_rels = [{**r, 'from': copies.get(r['from'], r['from']), 'to': copies.get(r['to'], r['to'])} for r in d.relationships]
        request.update(
            level='context',
            nodes=[
                *people,
                {
                    'id': system,
                    'type': 'service',
                    'label': title,
                    'description': TODO_DESCRIPTION,
                    **({'evidence': d.evidence('README.md')} if d.evidence('README.md') else {}),
                    'inside': {'level': 'container', 'nodes': inner_nodes, 'relationships': inner_rels, 'flows': [], 'notes': []},
                },
                *externals,
            ],
            relationships=top_rels,
        )
        view = f'context view (user, {title}, {len(externals)} external), with {len(inner_nodes)} elements inside {title}'
    else:
        groups = []
        nodes = d.nodes
        if externals:
            groups = [{'id': 'system', 'label': title, 'kind': 'system'}]
            nodes = [{**n, 'group': 'system'} if n in inside else n for n in d.nodes]
        request.update(level='container', groups=groups, nodes=nodes, relationships=d.relationships)
        view = f'container view of {len(d.nodes)} elements' + (' in a system boundary' if groups else '')
    request.update(flows=[], notes=[])
    summary = {
        'view': view,
        'elements': len(d.nodes),
        'relationships': len(d.relationships),
        'placeholders': len(placeholder_paths(request)),
    }
    return request, summary


def placeholder_paths(value: object) -> list[str]:
    if isinstance(value, dict):
        return [k for k, v in value.items() if isinstance(v, str) and v.startswith('TODO')] + [
            p for v in value.values() for p in placeholder_paths(v)
        ]
    if isinstance(value, list):
        return [p for v in value for p in placeholder_paths(v)]
    return []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('root', nargs='?', default='.', help='repository (or sub-folder) to draw')
    parser.add_argument('--out', help='folder for survey.md and request.json (default: a new temporary folder)')
    parser.add_argument('--max-files', type=int, default=40000)
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    if not os.path.isdir(args.root):
        print(f'Not a folder: {args.root}', file=sys.stderr)
        return 2
    root = os.path.abspath(args.root)
    out = os.path.abspath(args.out) if args.out else tempfile.mkdtemp(prefix='draft-canvas-')
    if os.path.commonpath([out, root]) == root:
        print(f'Refusing to write into the repository ({out}); pass --out outside it.', file=sys.stderr)
        return 2
    os.makedirs(out, exist_ok=True)

    data = scan.survey(root, args.max_files)
    survey_text = scan.render_text(data)
    request, summary = build(data)
    with open(os.path.join(out, 'survey.md'), 'w', encoding='utf-8') as fh:
        fh.write(survey_text + '\n')
    request_path = os.path.join(out, 'request.json')
    with open(request_path, 'w', encoding='utf-8') as fh:
        json.dump(request, fh, indent=1, ensure_ascii=False)
        fh.write('\n')

    print(survey_text)
    print('\n## Draft request')
    print(f'{request_path}: {summary["view"]}; {summary["relationships"]} connections; {summary["placeholders"]} TODO placeholders.')
    print('Confirm each element in code (delete what is wrong, add what is missing), fill every TODO, add the main flow,')
    print(f'then: python3 {os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_diagram.py")} {request_path} --repo {root}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
