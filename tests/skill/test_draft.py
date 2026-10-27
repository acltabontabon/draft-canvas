"""`draft.py`: the first request it writes is well formed, true to the survey and never half-finished."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import SCRIPTS, TempRepo, load, run_script
from test_scan_repo import SHOP

draft = load('draft')
checker = load('check_diagram')
scan = load('scan_repo')


def build(files: dict[str, str | bytes]) -> tuple[dict, dict, Path]:
    repo = TempRepo(files, git=True)
    root = repo.__enter__()
    try:
        request, summary = draft.build(scan.survey(str(root), 40000))
        return request, summary, root
    finally:
        repo.__exit__()


def view_of(request: dict) -> dict:
    return request['nodes'][1]['inside'] if request['level'] == 'context' else request


class Drafts(unittest.TestCase):
    def test_a_compose_system_becomes_containers_stores_and_queues_wired_as_configured(self) -> None:
        request, summary, _ = build(SHOP)
        view = view_of(request)
        types = {n['id']: n['type'] for n in view['nodes']}
        self.assertEqual(types['user'], 'person')
        self.assertEqual(types['postgresql'], 'sql-database')
        self.assertEqual(types['barista'], 'worker')  # only takes work off a queue
        self.assertEqual(types['barista-orders'], 'queue')
        self.assertNotIn('adminer', types)  # a dev tool in compose
        self.assertNotIn('postgres', types)  # the compose service *is* the PostgreSQL element
        pairs = {(r['from'], r['to']) for r in view['relationships']}
        for pair in [
            ('user', 'web'),
            ('web', 'proxy'),
            ('proxy', 'counter'),
            ('counter', 'postgresql'),
            ('counter', 'barista-orders'),
            ('barista-orders', 'barista'),
            ('barista', 'counter-updates'),
        ]:
            self.assertIn(pair, pairs)
        self.assertEqual([n['id'] for n in view['nodes']][:2], ['user', 'web'])  # reading order: who, then where
        self.assertEqual(summary['placeholders'], len(checker.placeholders(request)))

    def test_every_element_cites_files_that_exist(self) -> None:
        repo = TempRepo(SHOP, git=True)
        root = repo.__enter__()
        try:
            request, _ = draft.build(scan.survey(str(root), 40000))
            for node in view_of(request)['nodes']:
                if node['type'] == 'person':
                    continue
                self.assertTrue(node.get('evidence'), node['id'])
                for e in node['evidence']:
                    self.assertTrue(os.path.exists(root / e['path']), e['path'])
        finally:
            repo.__exit__()

    def test_is_valid_apart_from_its_placeholders_and_refused_until_they_are_filled(self) -> None:
        request, _, _ = build(SHOP)
        report = checker.check(json.loads(json.dumps(request)), None)
        self.assertTrue(report.errors)
        self.assertTrue(all('placeholder' in e for e in report.errors), report.errors)

        def fill(value):
            if isinstance(value, dict):
                return {k: ('Does its job.' if isinstance(v, str) and v.startswith('TODO') else fill(v)) for k, v in value.items()}
            return [fill(v) for v in value] if isinstance(value, list) else value

        self.assertEqual(checker.check(fill(request), None).errors, [])

    def test_a_large_system_with_providers_opens_on_a_context_view(self) -> None:
        files = {
            'services/' + name + '/package.json': json.dumps({'name': name, 'dependencies': {'express': '4'}})
            for name in ('gateway-api', 'orders', 'payments', 'billing', 'catalog', 'search', 'users', 'notify', 'reports', 'audit')
        }
        files['services/payments/package.json'] = json.dumps({'name': 'payments', 'dependencies': {'express': '4', 'stripe': '14'}})
        request, summary, _ = build(files)
        self.assertEqual(request['level'], 'context')
        self.assertEqual([n['id'] for n in request['nodes']], ['user', 'system', 'stripe'])
        inside = request['nodes'][1]['inside']
        self.assertIn('c.stripe', {n['id'] for n in inside['nodes']})
        self.assertIn(('payments', 'c.stripe'), {(r['from'], r['to']) for r in inside['relationships']})
        self.assertIn('context view', summary['view'])

    def test_a_small_system_without_providers_has_no_boundary(self) -> None:
        files = {
            'package.json': json.dumps({'name': 'tiny', 'dependencies': {'express': '4', 'pg': '8'}}),
            'server.js': "app.get('/', h)\n",
        }
        request, _, _ = build(files)
        self.assertEqual(request['level'], 'container')
        self.assertEqual(request['groups'], [])
        self.assertIn(('tiny', 'postgresql'), {(r['from'], r['to']) for r in request['relationships']})

    def test_a_store_known_only_from_drivers_is_one_per_owner(self) -> None:
        files = {
            'cart/package.json': json.dumps({'name': 'cart', 'dependencies': {'express': '4', 'pg': '8'}}),
            'cart/server.js': "app.get('/', h)\n",
            'catalog/go.mod': 'module example.com/catalog\n\nrequire github.com/jackc/pgx/v5 v5.7.0\n',
            'catalog/main.go': 'package main\nfunc main() {}\n',
            'web/package.json': json.dumps({'name': 'web', 'dependencies': {'express': '4'}}),
            'web/server.js': "app.get('/', h)\n",
        }
        request, _, _ = build(files)
        view = view_of(request)
        stores = {n['id']: n for n in view['nodes'] if n['type'] == 'sql-database'}
        self.assertEqual(sorted(stores), ['cart.postgresql', 'catalog.postgresql'])
        self.assertEqual(stores['cart.postgresql']['label'], 'Cart Store')
        self.assertEqual({e['basis'] for n in stores.values() for e in n.get('evidence', [])}, {'inferred'})
        links = {(r['from'], r['to']) for r in view['relationships']}
        self.assertTrue({('cart', 'cart.postgresql'), ('catalog', 'catalog.postgresql')} <= links)
        ids = [r['id'] for r in view['relationships']]
        self.assertEqual(len(ids), len(set(ids)))

    def test_ids_are_unique_and_valid_however_names_collide(self) -> None:
        files = {
            'docker-compose.yml': 'services:\n  orders:\n    build: .\n  Orders:\n    build: .\n  "9lives":\n    build: .\n',
        }
        request, _, _ = build(files)
        ids = [n['id'] for n in request['nodes']] + [r['id'] for r in request['relationships']]
        self.assertEqual(len(ids), len(set(ids)))
        for value in ids:
            self.assertRegex(value, r'^[A-Za-z][A-Za-z0-9_.-]{0,63}$')

    def test_each_technology_is_one_product_the_one_behind_the_type(self) -> None:
        # Draft Canvas shows a logo only for one product's own name; "TypeScript, Express" would draw a
        # plain mark and an advisory, and the agent an extra update to fix it.
        files = {
            'desktop/package.json': json.dumps({'name': 'desktop', 'dependencies': {'react-dom': '18', '@tauri-apps/api': '2'}}),
            'desktop/src/main.tsx': 'render()\n',
            'api/package.json': json.dumps({'name': 'api', 'dependencies': {'commander': '12', 'express': '4', '@anthropic-ai/sdk': '1'}}),
            'api/server.ts': "app.get('/', h)\n",
            'tool/go.mod': 'module example.com/tool\n',
            'tool/main.go': 'package main\nfunc main() {}\n',
        }
        request, _, _ = build(files)
        technology = {n['id']: n.get('technology') for n in view_of(request)['nodes']}
        self.assertEqual(technology['desktop'], 'Tauri')
        self.assertEqual(technology['api'], 'Express')
        self.assertEqual(technology['tool'], 'Go')
        self.assertEqual(technology['anthropic-api'], 'Anthropic')
        self.assertEqual(draft.product('Django REST framework'), 'Django')


class CommandLine(unittest.TestCase):
    def test_writes_survey_and_request_outside_the_repository(self) -> None:
        with TempRepo(SHOP, git=True) as root, tempfile.TemporaryDirectory() as out:
            done = run_script('draft', str(root), '--out', out)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn('## Draft request', done.stdout)
            self.assertTrue((Path(out) / 'survey.md').is_file())
            request = json.loads((Path(out) / 'request.json').read_text(encoding='utf-8'))
            self.assertEqual(request['open'], True)
            inside = run_script('draft', str(root), '--out', str(root / 'drafts'))
            self.assertEqual(inside.returncode, 2)
            self.assertFalse((root / 'drafts').exists())

    def test_running_from_the_skills_folder_leaves_nothing_behind_there(self) -> None:
        cache = SCRIPTS / '__pycache__'
        shutil.rmtree(cache, ignore_errors=True)
        with TempRepo(SHOP) as root, tempfile.TemporaryDirectory() as out:
            done = run_script('draft', str(root), '--out', out, isolated=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(cache.exists())

    def test_the_same_repository_drafts_the_same_way_every_time(self) -> None:
        with TempRepo(SHOP, git=True) as root, tempfile.TemporaryDirectory() as out:
            outputs = []
            for seed in ('1', '2'):
                done = run_script('scan_repo', str(root), '--json', env={'PYTHONHASHSEED': seed}, isolated=False)
                outputs.append(done.stdout)
                drafted = run_script('draft', str(root), '--out', os.path.join(out, seed), env={'PYTHONHASHSEED': seed}, isolated=False)
                self.assertEqual(drafted.returncode, 0, drafted.stderr)
            self.assertEqual(outputs[0], outputs[1])
            first, second = (json.loads(Path(out, seed, 'request.json').read_text(encoding='utf-8')) for seed in ('1', '2'))
            for request in (first, second):
                request.pop('requestId')
            self.assertEqual(first, second)


if __name__ == '__main__':
    unittest.main()
