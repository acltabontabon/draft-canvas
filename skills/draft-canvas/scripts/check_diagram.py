#!/usr/bin/env python3
"""Check a create_diagram request before sending it to Draft Canvas.

ERROR lines are what the app would refuse (or silently drop); WARN lines are what would draw or
present badly. Fix every ERROR. Standard library only.

    python3 check_diagram.py <request.json> [--repo <repo-root>]
    python3 check_diagram.py - < request.json

Exit status: 0 clean or warnings only, 1 errors, 2 unreadable input.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid

ID = re.compile(r'^[A-Za-z][A-Za-z0-9_.-]{0,63}$')
TYPES = {
    'service',
    'api',
    'worker',
    'scheduler',
    'gateway',
    'external-system',
    'database',
    'sql-database',
    'nosql-database',
    'cache',
    'file-system',
    'object-storage',
    'search-index',
    'table',
    'queue',
    'topic',
    'stream',
    'dead-letter-queue',
    'person',
    'user-group',
    'external-actor',
    'system-actor',
    'device',
    'component',
    'module',
    'adapter',
    'port',
    'junction',
}
ALIASES = {
    'microservice',
    'application',
    'app',
    'backend',
    'web-app',
    'frontend',
    'spa',
    'lambda',
    'function',
    'consumer',
    'job',
    'cron',
    'load-balancer',
    'api-gateway',
    'external',
    'external-service',
    'software-system',
    'system',
    'db',
    'datastore',
    'data-store',
    'sql',
    'postgres',
    'mysql',
    'nosql',
    'document-store',
    'redis',
    's3',
    'bucket',
    'elasticsearch',
    'message-queue',
    'sqs',
    'sns',
    'kafka-topic',
    'kafka',
    'event-stream',
    'dlq',
    'user',
    'actor',
    'human',
    'team',
    'third-party',
}
CAN_HAVE_INSIDE = {
    'service',
    'api',
    'worker',
    'scheduler',
    'gateway',
    'external-system',
    'component',
    'module',
    'adapter',
    'microservice',
    'application',
    'app',
    'backend',
    'web-app',
    'frontend',
    'spa',
    'software-system',
    'system',
}
PEOPLE = {'person', 'user-group', 'external-actor', 'system-actor', 'device', 'user', 'actor', 'human', 'team', 'third-party'}
EXTERNAL = {'external-system', 'external', 'external-service', 'external-actor', 'third-party'}
ENTRY = PEOPLE | {'gateway', 'load-balancer', 'api-gateway', 'frontend', 'spa', 'web-app', 'scheduler', 'cron', 'job'}
NO_FIELDS = PEOPLE | {'junction'}
SEMANTICS = {
    'http',
    'grpc',
    'event',
    'command',
    'query',
    'reads',
    'writes',
    'readsWrites',
    'publishes',
    'consumes',
    'calls',
    'dependsOn',
    'uses',
    'fansOut',
    'deliversTo',
    'ingests',
    'replicates',
    'cdc',
    'syncs',
    'deadLetters',
    'invalidates',
    'watches',
    'searches',
    'indexes',
    'routes',
    'triggers',
    'implementedBy',
    'implements',
    'compensates',
    'transforms',
}
KINDS = {'sync', 'async', 'event', 'callback', 'conditional', 'retry', 'failure', 'fallback'}
COLORS = {'neutral', 'teal', 'blue', 'violet', 'amber', 'rose', 'green'}
GROUP_KINDS = {'system', 'domain', 'network', 'deployment', 'group', 'boundary'}
NOTE_KINDS = {'note', 'question', 'warning', 'decision', 'code', 'label'}
LANGUAGES = {'plaintext', 'java', 'javascript', 'typescript', 'json', 'yaml', 'xml', 'sql', 'bash', 'http', 'log'}
LEVELS = {'context', 'container', 'component'}

# Hard limits (the app refuses past these) and soft ones (past these it still draws, but reads worse).
MAX = {
    'label': 120,
    'description': 280,
    'technology': 60,
    'relLabel': 80,
    'condition': 120,
    'response': 120,
    'noteText': 1000,
    'code': 4000,
    'flowTitle': 100,
    'caption': 120,
    'groupLabel': 80,
    'title': 200,
}
# viewElements and boundaryMembers are the app's own advisory thresholds (CROWDED_VIEW and
# CROWDED_BOUNDARY in src/agent/advice.ts); tests/agent-skill.test.ts keeps them equal.
SOFT = {
    'label': 32,
    'description': 120,
    'relLabel': 40,
    'caption': 90,
    'viewElements': 15,
    'boundaryMembers': 8,
    'notesPerView': 10,
    'codeLines': 15,
}


class Report:
    def __init__(self):
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, where: str, message: str):
        self.errors.append(f'ERROR {where}: {message}')

    def warn(self, where: str, message: str):
        self.warnings.append(f'WARN  {where}: {message}')


class View:
    """One room of the diagram: the top level, or an element's inside."""

    def __init__(self, path: str, body: dict, depth: int):
        self.path = path
        self.body = body
        self.depth = depth
        self.nodes: list[dict] = [n for n in body.get('nodes') or [] if isinstance(n, dict)]
        self.rels: list[dict] = [r for r in body.get('relationships') or [] if isinstance(r, dict)]
        self.groups: list[dict] = [g for g in body.get('groups') or [] if isinstance(g, dict)]
        self.flows: list[dict] = [f for f in body.get('flows') or [] if isinstance(f, dict)]
        self.notes: list[dict] = [n for n in body.get('notes') or [] if isinstance(n, dict)]
        self.node_ids = {n.get('id') for n in self.nodes}
        self.rel_ids = {r.get('id') for r in self.rels}
        self.group_ids = {g.get('id') for g in self.groups}
        self.flow_ids = {f.get('id') for f in self.flows}
        self.note_ids = {n.get('id') for n in self.notes}


def text_len(value) -> int:
    return len(value) if isinstance(value, str) else 0


def check(request: dict, repo: str | None) -> Report:
    r = Report()
    if not isinstance(request, dict):
        r.error('request', 'must be a JSON object (the create_diagram arguments)')
        return r
    if 'arguments' in request and isinstance(request['arguments'], dict) and 'nodes' not in request:
        request = request['arguments']
    if not isinstance(request.get('title'), str) or not request['title'].strip():
        r.error('title', 'required')
    elif len(request['title']) > MAX['title']:
        r.error('title', f'longer than {MAX["title"]} characters')
    if request.get('level') is not None and request['level'] not in LEVELS:
        r.error('level', f'"{request["level"]}" is not one of {sorted(LEVELS)}')
    if 'starter' in request:
        r.warn('starter', 'a starter request is checked only partly here; its own elements come from the app')

    views: list[View] = []
    seen_ids: dict[str, str] = {}

    def collect(path: str, body: dict, depth: int):
        view = View(path, body, depth)
        views.append(view)
        for n in view.nodes:
            inside = n.get('inside')
            if isinstance(inside, dict):
                if depth >= 3:
                    r.error(f'{path} › {n.get("id")}.inside', 'nesting goes at most 3 views down')
                else:
                    collect(f'{path} › {n.get("id")}', inside, depth + 1)

    collect('top', request, 0)
    for where, value in placeholders(request):
        r.error(where, f'still a placeholder ({value[:60]!r}) — replace it with what the code shows, or remove the item')

    for view in views:
        for kind, items in (
            ('element', view.nodes),
            ('relationship', view.rels),
            ('group', view.groups),
            ('flow', view.flows),
            ('note', view.notes),
        ):
            for item in items:
                ident = item.get('id')
                if not isinstance(ident, str) or not ID.match(ident):
                    r.error(f'{view.path} {kind}', f'id {ident!r} must start with a letter and use letters, digits, _ . - (≤ 64)')
                    continue
                if ident in seen_ids:
                    r.error(
                        f'{view.path} {kind} {ident}',
                        f'id already used by a {seen_ids[ident]} — ids are unique across the whole file, inside views included',
                    )
                seen_ids[ident] = kind

    primary = (request.get('layout') or {}).get('primaryFlow') if isinstance(request.get('layout'), dict) else None
    top_flows = views[0].flow_ids if views else set()
    if primary is not None and primary not in top_flows:
        r.error('layout.primaryFlow', f'"{primary}" is not a flow of the top view')

    ALL_NODE_IDS.clear()
    ALL_NODE_IDS.update(i for v in views for i in v.node_ids if isinstance(i, str))
    for view in views:
        check_view(view, r, repo, request, is_top=view.depth == 0, primary=primary)
    return r


ALL_NODE_IDS: set[str] = set()


def check_view(view: View, r: Report, repo: str | None, request: dict, is_top: bool, primary: str | None):
    p = view.path
    level = view.body.get('level')
    if not is_top and level is not None and level not in LEVELS:
        r.error(f'{p}.level', f'"{level}" is not one of {sorted(LEVELS)}')
    countable = [n for n in view.nodes if n.get('type') != 'junction']
    if len(countable) > 25:
        r.warn(p, f"{len(countable)} elements — move a part's detail into its inside view (aim for 7–15 per view)")
    elif len(countable) > SOFT['viewElements']:
        r.warn(p, f'{len(countable)} elements — past about 15 a view gets hard to read; consider an inside view')
    if is_top and not view.nodes and 'starter' not in request:
        r.error(p, 'no elements')
    if is_top and 0 < len(countable) < 3 and any(isinstance(n.get('inside'), dict) for n in view.nodes):
        r.warn(
            p,
            f'the opening view has only {len(countable)} elements — a context view earns its place with the people and '
            'external systems around the system; with none, open on the container view instead',
        )

    missing_desc, missing_tech, missing_evidence = [], [], []
    for n in view.nodes:
        nid = n.get('id')
        typ = n.get('type')
        if not isinstance(typ, str):
            r.error(f'{p} element {nid}', 'type is required')
        elif typ not in TYPES and typ.lower() not in ALIASES and 'fallbackType' not in request:
            r.error(f'{p} element {nid}', f'unknown type "{typ}" — use one of the element types, or set fallbackType')
        label = n.get('label')
        if not isinstance(label, str) or not label.strip():
            r.error(f'{p} element {nid}', 'label is required')
        else:
            if len(label) > MAX['label']:
                r.error(f'{p} element {nid}', f'label longer than {MAX["label"]}')
            elif len(label) > SOFT['label']:
                r.warn(f'{p} element {nid}', f'label "{label}" is {len(label)} characters — a name people say fits in ~24')
            tech = n.get('technology')
            if isinstance(tech, str) and tech and tech.lower() in label.lower() and tech.lower() != label.lower():
                r.warn(f'{p} element {nid}', f'label repeats the technology "{tech}" — it has its own field')
            if re.search(r'[(\[]', label):
                r.warn(f'{p} element {nid}', f'label "{label}" has a parenthesis — put the detail in description or technology')
        for field in ('description', 'technology'):
            if text_len(n.get(field)) > MAX[field]:
                r.error(f'{p} element {nid}', f'{field} longer than {MAX[field]}')
        if text_len(n.get('description')) > SOFT['description']:
            r.warn(f'{p} element {nid}', 'description is long — one sentence of ~90 characters reads best on the shape')
        if typ not in NO_FIELDS:
            if not n.get('description'):
                missing_desc.append(nid)
            # A software system in a context view has no single technology; containers and components do.
            if not n.get('technology') and typ not in EXTERNAL and level != 'context':
                missing_tech.append(nid)
            if not n.get('evidence'):
                missing_evidence.append(nid)
        if n.get('group') is not None and n['group'] not in view.group_ids:
            r.error(f'{p} element {nid}', f'group "{n["group"]}" is not a group of this view')
        if n.get('color') is not None and n['color'] not in COLORS:
            r.error(f'{p} element {nid}', f'color "{n["color"]}" is not one of {sorted(COLORS)}')
        if isinstance(n.get('inside'), dict) and isinstance(typ, str) and typ not in CAN_HAVE_INSIDE:
            r.error(
                f'{p} element {nid}', f'a {typ} has no inside view — only services, APIs, workers, gateways and (non-port) components do'
            )
        if isinstance(n.get('inside'), dict) and typ in EXTERNAL:
            r.warn(f'{p} element {nid}', 'an inside view of an external system — you rarely know its insides; check this is yours')
        check_attachments(n, f'{p} element {nid}', r)
        check_evidence(n, f'{p} element {nid}', r, repo)
    if missing_desc:
        r.warn(p, f'no description on {fmt(missing_desc)} — a one-sentence responsibility is drawn under the name')
    if missing_tech:
        r.warn(p, f'no technology on {fmt(missing_tech)}')
    if missing_evidence:
        r.warn(p, f'no evidence on {fmt(missing_evidence)} — cite the file (and line) each element comes from')

    colored = [n.get('id') for n in view.nodes if n.get('color') not in (None, 'neutral')]
    if len(colored) > 2:
        r.warn(p, f'{len(colored)} coloured elements ({fmt(colored)}) — leave elements neutral; colour is for flows and one focal element')

    if view.nodes:
        first = view.nodes[0]
        if str(first.get('type')) not in ENTRY and any(str(n.get('type')) in ENTRY for n in view.nodes):
            r.warn(
                p,
                f'the first element is "{first.get("id")}" — list the entry point (a person, client or gateway) first: the layout reads in input order',
            )

    # Groups.
    members: dict[str, list[dict]] = {g.get('id'): [] for g in view.groups}
    for n in view.nodes:
        if n.get('group') in members:
            members[n['group']].append(n)
    for g in view.groups:
        gid = g.get('id')
        if not isinstance(g.get('label'), str) or not g['label'].strip():
            r.error(f'{p} group {gid}', 'label is required')
        elif len(g['label']) > MAX['groupLabel']:
            r.error(f'{p} group {gid}', f'label longer than {MAX["groupLabel"]}')
        if g.get('kind') is not None and g['kind'] not in GROUP_KINDS:
            r.error(f'{p} group {gid}', f'kind "{g["kind"]}" is not one of {sorted(GROUP_KINDS)}')
        if g.get('parent') is not None and g['parent'] not in view.group_ids:
            r.error(f'{p} group {gid}', f'parent "{g["parent"]}" is not a group of this view')
        inner = members.get(gid, [])
        nested = [h for h in view.groups if h.get('parent') == gid]
        if not inner and not nested:
            r.warn(f'{p} group {gid}', 'has no members — it would be an empty box')
        elif len(inner) == 1 and not nested:
            r.warn(f'{p} group {gid}', 'has one member — a boundary around one shape adds a box, not meaning')
        if len(inner) > SOFT['boundaryMembers']:
            r.warn(
                f'{p} group {gid}',
                f'holds {len(inner)} elements — past {SOFT["boundaryMembers"]}, draw the system as one element in a context view with these inside it',
            )
        if inner and all(str(m.get('type')) in EXTERNAL for m in inner):
            r.warn(f'{p} group {gid}', 'groups only external systems — leave externals ungrouped so each sits beside its caller')
        if g.get('kind') == 'system':
            ext = [m.get('id') for m in inner if str(m.get('type')) in EXTERNAL]
            if ext:
                r.warn(f'{p} group {gid}', f'external {fmt(ext)} inside a system boundary — externals belong outside it')

    # Relationships.
    type_of = {n.get('id'): n.get('type') for n in view.nodes}
    pairs: dict[tuple, str] = {}
    connected: set[str] = set()
    unlabelled = []
    for rel in view.rels:
        rid = rel.get('id')
        src, dst = rel.get('from'), rel.get('to')
        for end, value in (('from', src), ('to', dst)):
            if value in view.group_ids:
                r.error(f'{p} relationship {rid}', f'{end} "{value}" is a group — a relationship joins two elements')
            elif value not in view.node_ids:
                elsewhere = ' (it is in another view: a relationship joins two elements of the same view)' if value in ALL_NODE_IDS else ''
                r.error(f'{p} relationship {rid}', f'{end} "{value}" is not an element of this view{elsewhere}')
        if src == dst and src is not None:
            r.error(f'{p} relationship {rid}', 'connects an element to itself')
        twin = rel.get('semantic') == 'compensates'
        key = (src, dst, twin)
        if key in pairs:
            r.error(f'{p} relationship {rid}', f'a second relationship {src} → {dst} (first: {pairs[key]}) — one per direction; merge them')
        pairs[key] = rid
        connected.update(x for x in (src, dst) if isinstance(x, str))
        label = rel.get('label')
        if not label:
            unlabelled.append(rid)
        elif len(label) > MAX['relLabel']:
            r.error(f'{p} relationship {rid}', f'label longer than {MAX["relLabel"]}')
        elif len(label) > SOFT['relLabel']:
            r.warn(f'{p} relationship {rid}', f'label "{label}" is {len(label)} characters — a verb phrase of ≤ 32 keeps the line clean')
        if rel.get('semantic') is not None and rel['semantic'] not in SEMANTICS:
            r.error(f'{p} relationship {rid}', f'semantic "{rel["semantic"]}" is unknown')
        elif rel.get('semantic') is not None:
            offered = offered_between(type_of.get(src), type_of.get(dst))
            if offered and rel['semantic'] not in offered:
                r.warn(
                    f'{p} relationship {rid}',
                    f'Draft Canvas doesn\'t offer "{rel["semantic"]}" from {type_of.get(src)} to {type_of.get(dst)} '
                    f'and would use "{offered[0]}" instead — choose one of {", ".join(offered)}, or leave semantic out',
                )
        if rel.get('kind') is not None and rel['kind'] not in KINDS:
            r.error(f'{p} relationship {rid}', f'kind "{rel["kind"]}" is not one of {sorted(KINDS)}')
        if rel.get('color') is not None and rel['color'] not in COLORS:
            r.error(f'{p} relationship {rid}', f'color "{rel["color"]}" is not one of {sorted(COLORS)}')
        for field in ('condition', 'response'):
            if isinstance(rel.get(field), str) and len(rel[field]) > MAX[field]:
                r.error(f'{p} relationship {rid}', f'{field} longer than {MAX[field]}')
        if rel.get('deliveryAttempts') is not None and rel.get('semantic') != 'deadLetters':
            r.warn(f'{p} relationship {rid}', 'deliveryAttempts only shows on a deadLetters relationship')
        check_attachments(rel, f'{p} relationship {rid}', r)
        check_evidence(rel, f'{p} relationship {rid}', r, repo)
    if unlabelled:
        r.warn(p, f'unlabelled relationships {fmt(unlabelled)} — say what happens ("Places order", "Publishes OrderPlaced")')
    lonely = [n.get('id') for n in view.nodes if n.get('id') not in connected and n.get('type') != 'junction']
    if lonely and view.rels:
        r.warn(p, f'{fmt(lonely)} connect to nothing — connect them or leave them out')

    # Flows.
    rel_by_id = {rel.get('id'): rel for rel in view.rels}
    targets = view.node_ids | view.group_ids | view.rel_ids
    if is_top and view.rels and not view.flows:
        r.warn(p, 'no flows — the main request path as a flow is the presentation, and it lays the diagram out straight')
    if is_top and view.flows and primary is None:
        r.warn('layout.primaryFlow', f'not set — name the main flow ({view.flows[0].get("id")}?) so it is laid out as a straight line')
    for flow in view.flows:
        fid = flow.get('id')
        title = flow.get('title')
        if not isinstance(title, str) or not title.strip():
            r.error(f'{p} flow {fid}', 'title is required')
        elif len(title) > MAX['flowTitle']:
            r.error(f'{p} flow {fid}', f'title longer than {MAX["flowTitle"]}')
        if flow.get('color') is not None and flow['color'] not in COLORS:
            r.error(f'{p} flow {fid}', f'color "{flow["color"]}" is not one of {sorted(COLORS)}')
        if flow.get('variantOf') is not None:
            base = next((f for f in view.flows if f.get('id') == flow['variantOf']), None)
            if base is None:
                r.error(f'{p} flow {fid}', f'variantOf "{flow["variantOf"]}" is not a flow of this view')
            elif base.get('variantOf'):
                r.error(f'{p} flow {fid}', f'variantOf "{flow["variantOf"]}", which is itself a variant — one level only')
        steps = flow.get('steps')
        if not isinstance(steps, list) or not steps:
            r.error(f'{p} flow {fid}', 'needs at least one step')
            continue
        used: set[str] = set()
        uncaptioned = 0
        visited: set[str] = set()
        for i, step in enumerate(steps, 1):
            where = f'{p} flow {fid} step {i}'
            if isinstance(step, str):
                step = {'relationship': step}
            if not isinstance(step, dict):
                r.error(where, 'must be a relationship id or an object')
                continue
            caption = step.get('caption')
            if isinstance(caption, str) and len(caption) > MAX['caption']:
                r.error(where, f'caption longer than {MAX["caption"]}')
            elif isinstance(caption, str) and len(caption) > SOFT['caption']:
                r.warn(where, 'caption is long — the presentation bar reads best under ~80 characters')
            if 'spotlight' in step and 'relationship' not in step:
                for ident in step.get('spotlight') or []:
                    if ident not in targets:
                        r.error(where, f'spotlight "{ident}" is not an element, group or relationship of this view')
                    visited.add(ident)
                if not caption:
                    uncaptioned += 1
                continue
            rid = step.get('relationship')
            if rid not in view.rel_ids:
                r.error(where, f'relationship "{rid}" is not a relationship of this view')
                continue
            if rid in used:
                r.error(where, f'relationship "{rid}" is already a step of this flow — each at most once')
            used.add(rid)
            for ident in step.get('highlight') or []:
                if ident not in targets:
                    r.error(where, f'highlight "{ident}" is not an element, group or relationship of this view')
            if not caption:
                uncaptioned += 1
            rel = rel_by_id[rid]
            # A step continues from somewhere the story has already been — the step before, or an
            # earlier element a fan-out branches from. One that doesn't is usually a misordered step.
            if visited and not ({rel.get('from'), rel.get('to')} & visited):
                r.warn(where, f'"{rid}" starts nowhere the flow has been yet — check the order follows the code')
            visited.update(x for x in (rel.get('from'), rel.get('to')) if x)
        if uncaptioned:
            r.warn(
                f'{p} flow {fid}',
                f'{uncaptioned} step(s) without a caption — say what happens at each step; it is what the presentation shows',
            )
        if not any(isinstance(s, dict) and 'spotlight' in s for s in steps) and flow.get('variantOf') is None and is_top:
            r.warn(f'{p} flow {fid}', 'no opening {spotlight, caption} step — an overview first sets the scene when presenting')

    # Notes.
    if len(view.notes) > SOFT['notesPerView']:
        r.warn(p, f'{len(view.notes)} notes — keep the few that explain the diagram; the rest belong in docs')
    for note in view.notes:
        nid = note.get('id')
        kind = note.get('kind', 'note')
        where = f'{p} note {nid}'
        if kind not in NOTE_KINDS:
            r.error(where, f'kind "{kind}" is not one of {sorted(NOTE_KINDS)}')
        about = note.get('about', note.get('near'))
        if about is None:
            r.warn(where, 'no about — it would go after the diagram, far from what it means')
        elif about not in targets:
            r.error(where, f'about "{about}" is not an element, relationship or group of this view')
        if kind == 'code':
            code = note.get('code')
            if not isinstance(code, str) or not code.strip():
                r.error(where, 'a code note needs code')
            elif len(code) > MAX['code']:
                r.error(where, f'code longer than {MAX["code"]}')
            elif code.count('\n') + 1 > SOFT['codeLines']:
                r.warn(
                    where,
                    f'{code.count(chr(10)) + 1} lines of code — a snippet of ≤ 15 lines reads on the canvas; trim to the part that matters',
                )
            if note.get('language') is not None and note['language'] not in LANGUAGES:
                r.error(where, f'language "{note["language"]}" is not one of {sorted(LANGUAGES)}')
        else:
            text = note.get('text')
            if not isinstance(text, str) or not text.strip():
                r.error(where, 'needs text')
            elif len(text) > MAX['noteText']:
                r.error(where, f'text longer than {MAX["noteText"]}')
        if kind == 'label' and about in view.rel_ids:
            r.error(where, 'a label attaches to elements only')


#: Fields a person reads on the canvas. `code` is not among them: a snippet may quote a real TODO.
PROSE_FIELDS = {'title', 'label', 'description', 'technology', 'text', 'caption', 'condition', 'response'}
PLACEHOLDER = re.compile(r'^\s*(TODO|FIXME|TBD|XXX)\b', re.I)


def placeholders(value: object, path: str = 'request') -> list[tuple[str, str]]:
    """Every prose field still holding a `TODO:` marker (as draft.py leaves them), by where it is."""
    found: list[tuple[str, str]] = []
    if isinstance(value, dict):
        label = value.get('id', '')
        for key, item in value.items():
            where = f'{path} {label}'.strip() if label else path
            if key in PROSE_FIELDS and isinstance(item, str) and PLACEHOLDER.search(item):
                found.append((f'{where}.{key}', item))
            elif isinstance(item, (dict, list)):
                found.extend(placeholders(item, f'{where}.{key}' if not label else where))
    elif isinstance(value, list):
        for item in value:
            found.extend(placeholders(item, path))
    return found


def check_attachments(item: dict, where: str, r: Report):
    attachments = item.get('attachments')
    if attachments is None:
        return
    if not isinstance(attachments, list) or len(attachments) > 4:
        r.error(where, 'attachments: at most 4')
        return
    for a in attachments:
        if not isinstance(a, dict) or a.get('kind') not in ('note', 'code'):
            r.error(where, 'attachment kind must be "note" or "code"')
        elif a['kind'] == 'code' and not a.get('code'):
            r.error(where, 'a code attachment needs code')
        elif a['kind'] == 'note' and not a.get('text'):
            r.error(where, 'a note attachment needs text')


def check_evidence(item: dict, where: str, r: Report, repo: str | None):
    evidence = item.get('evidence')
    if evidence is None:
        return
    if not isinstance(evidence, list) or len(evidence) > 8:
        r.error(where, 'evidence: a list of at most 8')
        return
    for e in evidence:
        if not isinstance(e, dict) or not isinstance(e.get('path'), str) or e.get('basis') not in ('observed', 'inferred'):
            r.error(where, 'each evidence entry needs path and basis ("observed" or "inferred")')
            continue
        path = e['path']
        if path.startswith('/') or re.match(r'^[A-Za-z]:[\\/]', path) or '..' in path.split('/'):
            r.error(where, f'evidence path "{path}" must be relative to the repository root')
            continue
        if repo and not os.path.exists(os.path.join(repo, path)):
            r.error(where, f'evidence path "{path}" does not exist in {repo} — cite only files you read')
        elif repo and os.path.isfile(os.path.join(repo, path)):
            try:
                with open(os.path.join(repo, path), 'rb') as fh:
                    text = fh.read()
            except OSError:
                continue
            lines = text.count(b'\n') + 1
            if isinstance(e.get('line'), int) and e['line'] > lines:
                r.error(where, f'evidence line {e["line"]} is past the end of {path} ({lines} lines)')
            symbol = e.get('symbol')
            if isinstance(symbol, str) and symbol.strip():
                # `Orders.place`, `orders::place`, `place()`: the last name is what the file must contain.
                name = re.split(r'[.:#/\\]+', re.sub(r'\(.*\)$', '', symbol.strip()))[-1]
                if name and name.encode() not in text:
                    r.warn(where, f'evidence symbol "{symbol}" does not appear in {path} — cite a name you saw there')


def load_pairings() -> dict:
    """The app's own relationship pairings (`pairings.json`, written by `npm run agent:schemas`)."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pairings.json'), encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


PAIRINGS = load_pairings()


def offered_between(source_type: str | None, target_type: str | None) -> list[str]:
    """The meanings Draft Canvas offers from one element type to another; empty when it has no opinion."""
    categories = PAIRINGS.get('categories', {})
    source, target = categories.get(source_type or ''), categories.get(target_type or '')
    if not source or not target:
        return []
    return PAIRINGS.get('offered', {}).get(f'{source}>{target}', [])


def fmt(ids: list) -> str:
    shown = ', '.join(str(i) for i in ids[:6])
    return shown + (f' and {len(ids) - 6} more' if len(ids) > 6 else '')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('request', help='create_diagram arguments as JSON (a file, or - for stdin)')
    parser.add_argument('--repo', help='repository root, to check that evidence paths exist')
    args = parser.parse_args()
    try:
        if args.request == '-':
            raw = sys.stdin.read()
        else:
            with open(args.request, encoding='utf-8') as fh:
                raw = fh.read()
        request = json.loads(raw)
    except (OSError, ValueError) as error:
        print(f'Could not read the request: {error}', file=sys.stderr)
        return 2
    report = check(request, args.repo)
    for line in report.errors + report.warnings:
        print(line)
    if isinstance(request, dict) and not request.get('requestId'):
        print(f'NOTE  requestId: missing — use "{uuid.uuid4()}"')
    print(
        f'{len(report.errors)} error(s), {len(report.warnings)} warning(s)'
        + (
            ' — ready to send.'
            if not report.errors and not report.warnings
            else ' — fix the errors before sending.'
            if report.errors
            else ''
        )
    )
    return 1 if report.errors else 0


if __name__ == '__main__':
    sys.exit(main())
