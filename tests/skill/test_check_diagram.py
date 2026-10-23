"""`check_diagram.py`: what it refuses, what it warns about, and its exit codes."""

from __future__ import annotations

import copy
import json
import io
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from helpers import TempRepo, example_request, load, run_script

checker = load('check_diagram')


def report(request: dict, repo: Path | None = None):
    return checker.check(copy.deepcopy(request), str(repo) if repo else None)


def minimal(**extra) -> dict:
    request = {
        'requestId': '7d2c0f4e-1b8a-4c6e-9f3a-2a5b6c7d8e9f',
        'title': 'Shop',
        'level': 'container',
        'layout': {'primaryFlow': 'main'},
        'nodes': [
            {'id': 'user', 'type': 'person', 'label': 'Shopper'},
            {
                'id': 'api',
                'type': 'api',
                'label': 'Orders API',
                'description': 'Takes orders.',
                'technology': 'Go',
                'evidence': [{'path': 'main.go', 'basis': 'observed', 'line': 2, 'symbol': 'main'}],
            },
            {
                'id': 'db',
                'type': 'sql-database',
                'label': 'Orders DB',
                'description': 'Keeps orders.',
                'technology': 'PostgreSQL',
                'evidence': [{'path': 'main.go', 'basis': 'observed'}],
            },
        ],
        'relationships': [
            {'id': 'r1', 'from': 'user', 'to': 'api', 'label': 'Places order'},
            {'id': 'r2', 'from': 'api', 'to': 'db', 'label': 'Writes order'},
        ],
        'flows': [
            {
                'id': 'main',
                'title': 'Place an order',
                'steps': [
                    {'spotlight': ['user', 'api'], 'caption': 'One call, one write.'},
                    {'relationship': 'r1', 'caption': 'The shopper submits the cart.'},
                    {'relationship': 'r2', 'caption': 'The order is stored.'},
                ],
            }
        ],
    }
    request.update(extra)
    return request


REPO = {'main.go': 'package main\nfunc main() {}\n'}


class Refuses(unittest.TestCase):
    def test_the_skill_example_and_a_minimal_request_are_clean(self) -> None:
        for request in (example_request(), minimal()):
            r = report(request)
            self.assertEqual((r.errors, r.warnings), ([], []))
        with TempRepo(REPO) as root:
            r = report(minimal(), root)
        self.assertEqual((r.errors, r.warnings), ([], []))

    def test_what_the_app_would_refuse(self) -> None:
        request = minimal()
        request['nodes'].append({'id': 'api', 'type': 'api', 'label': 'Twin'})
        request['nodes'].append({'id': '9bad', 'type': 'wizard', 'label': 'X'})
        request['relationships'] += [
            {'id': 'r3', 'from': 'api', 'to': 'ghost', 'label': 'Calls'},
            {'id': 'r4', 'from': 'db', 'to': 'db', 'label': 'Loops'},
            {'id': 'r5', 'from': 'api', 'to': 'db', 'label': 'Writes again'},
        ]
        request['flows'][0]['steps'].append({'relationship': 'r1', 'caption': 'Again'})
        errors = '\n'.join(report(request).errors)
        self.assertIn('id already used', errors)
        self.assertIn('must start with a letter', errors)
        self.assertIn('unknown type "wizard"', errors)
        self.assertIn('to "ghost" is not an element of this view', errors)
        self.assertIn('connects an element to itself', errors)
        self.assertIn('a second relationship api → db', errors)
        self.assertIn('already a step of this flow', errors)

    def test_placeholders_left_by_the_draft_are_errors(self) -> None:
        request = minimal()
        request['nodes'][1]['description'] = 'TODO: what it does'
        request['relationships'][0]['label'] = 'TODO'
        errors = report(request).errors
        self.assertEqual(len([e for e in errors if 'placeholder' in e]), 2, errors)

    def test_evidence_must_name_files_lines_and_symbols_that_exist(self) -> None:
        request = minimal()
        request['nodes'][1]['evidence'] = [
            {'path': 'missing.go', 'basis': 'observed'},
            {'path': 'main.go', 'basis': 'observed', 'line': 99},
            {'path': 'main.go', 'basis': 'observed', 'symbol': 'PlaceOrder'},
            {'path': '/etc/passwd', 'basis': 'observed'},
            {'path': 'main.go', 'basis': 'guessed'},
        ]
        with TempRepo(REPO) as root:
            r = report(request, root)
        text = '\n'.join(r.errors + r.warnings)
        self.assertIn('"missing.go" does not exist', text)
        self.assertIn('line 99 is past the end', text)
        self.assertIn('symbol "PlaceOrder" does not appear', text)
        self.assertIn('must be relative to the repository root', text)
        self.assertIn('basis ("observed" or "inferred")', text)

    def test_evidence_uses_the_apps_portable_path_and_field_rules(self) -> None:
        for evidence in (
            {'path': r'..\outside.go', 'basis': 'observed'},
            {'path': r'\server\share', 'basis': 'observed'},
            {'path': 'file:secret', 'basis': 'observed'},
            {'path': 'bad\x00path', 'basis': 'observed'},
            {'path': 'main.go', 'basis': 'observed', 'line': True},
            {'path': 'main.go', 'basis': 'observed', 'line': 0},
            {'path': 'main.go', 'basis': 'observed', 'symbol': ''},
            {'path': 'main.go', 'basis': 'observed', 'unknown': 'x'},
        ):
            with self.subTest(evidence=evidence):
                r = checker.Report()
                checker.check_evidence({'evidence': [evidence]}, 'api', r, None)
                self.assertTrue(r.errors)

    def test_evidence_cannot_follow_a_symlink_out_of_the_repository(self) -> None:
        with TempRepo(REPO) as root, tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / 'private.go'
            target.write_text('private')
            try:
                (root / 'linked.go').symlink_to(target)
            except OSError:
                self.skipTest('symlinks unavailable')
            r = checker.Report()
            checker.check_evidence({'evidence': [{'path': 'linked.go', 'basis': 'observed'}]}, 'api', r, str(root))
            self.assertTrue(r.errors)

    def test_evidence_reads_in_chunks_and_matches_symbols_across_chunk_boundaries(self) -> None:
        class Chunked(io.BytesIO):
            def read(self, size=-1):
                self.assert_bounded(size)
                return super().read(min(size, 4))

            def assert_bounded(self, size):
                if size < 0 or size > 65536:
                    raise AssertionError('evidence must not read a whole source file into memory')

        with TempRepo(REPO) as root, patch.object(checker, 'open', return_value=Chunked(b'xxPlaceOrder\n'), create=True):
            r = checker.Report()
            checker.check_evidence(
                {'evidence': [{'path': 'main.go', 'basis': 'observed', 'symbol': 'PlaceOrder', 'line': 1}]}, 'api', r, str(root)
            )
        self.assertEqual((r.errors, r.warnings), ([], []))


class Warns(unittest.TestCase):
    def test_a_meaning_the_pair_does_not_take_names_the_ones_that_fit(self) -> None:
        request = minimal()
        request['nodes'].insert(
            1,
            {
                'id': 'gw',
                'type': 'gateway',
                'label': 'Gateway',
                'description': 'Routes.',
                'technology': 'NGINX',
                'evidence': [{'path': 'main.go', 'basis': 'inferred'}],
            },
        )
        request['relationships'] = [
            {'id': 'r0', 'from': 'user', 'to': 'gw', 'label': 'Calls'},
            {'id': 'r1', 'from': 'gw', 'to': 'api', 'label': 'Forwards', 'semantic': 'grpc'},
            {'id': 'r2', 'from': 'api', 'to': 'db', 'label': 'Writes order'},
        ]
        request['flows'] = [
            {
                'id': 'main',
                'title': 'Main',
                'steps': [
                    {'spotlight': ['user'], 'caption': 'Start.'},
                    {'relationship': 'r0', 'caption': 'a'},
                    {'relationship': 'r1', 'caption': 'b'},
                    {'relationship': 'r2', 'caption': 'c'},
                ],
            }
        ]
        [warning] = report(request).warnings
        self.assertIn('doesn\'t offer "grpc" from gateway to api', warning)
        self.assertIn('routes', warning)

    def test_what_would_draw_badly(self) -> None:
        request = minimal()
        request['nodes'][0], request['nodes'][1] = request['nodes'][1], request['nodes'][0]
        request['relationships'][1]['label'] = ''
        request['flows'][0]['steps'][2] = {'relationship': 'r2'}
        request['notes'] = [{'id': 'n1', 'text': 'Floating.'}]
        request['groups'] = [{'id': 'ext', 'label': 'Externals', 'kind': 'group'}]
        request['nodes'].append({'id': 'stripe', 'type': 'external-system', 'label': 'Stripe', 'group': 'ext', 'description': 'Payments.'})
        warnings = '\n'.join(report(request).warnings)
        for expected in (
            'list the entry point',
            'unlabelled relationships',
            'without a caption',
            'no about',
            'groups only external systems',
            'connect to nothing',
            'has one member',
        ):
            self.assertIn(expected, warnings)

    def test_an_evidence_line_must_point_at_the_code_it_cites(self) -> None:
        source = '@app.route("/")\ndef handle():\n    pass\n\n\n\n\n\ndef helper():\n    handle()\n'
        cases = {
            # A decorator just above the symbol, or a line inside its body, is a fair pointer.
            1: [],
            10: [],
            4: ['line 4 of app.py is blank'],
        }
        for line, expected in cases.items():
            with self.subTest(line=line), TempRepo({'app.py': source}) as root:
                r = checker.Report()
                checker.check_evidence(
                    {'evidence': [{'path': 'app.py', 'basis': 'observed', 'line': line, 'symbol': 'handle'}]}, 'api', r, str(root)
                )
                self.assertEqual(len(r.warnings), len(expected), r.warnings)
                for text in expected:
                    self.assertIn(text, r.warnings[0])
        with TempRepo({'app.py': source}) as root:
            r = checker.Report()
            checker.check_evidence(
                {'evidence': [{'path': 'app.py', 'basis': 'observed', 'line': 1, 'symbol': 'helper'}]}, 'api', r, str(root)
            )
        self.assertIn('line 1 comes before "helper" first appears in app.py (line 9)', '\n'.join(r.warnings))

    def test_a_system_of_containers_needs_a_component_view_and_its_main_flow_inside(self) -> None:
        inner = minimal()
        inner['nodes'][1:1] = [
            {'id': 'web', 'type': 'service', 'label': 'Web', 'description': 'Serves pages.', 'technology': 'Go'},
            {'id': 'worker', 'type': 'worker', 'label': 'Mailer', 'description': 'Sends mail.', 'technology': 'Go'},
        ]
        inner['relationships'] += [
            {'id': 'r3', 'from': 'api', 'to': 'worker', 'label': 'Queues mail'},
            {'id': 'r4', 'from': 'web', 'to': 'api', 'label': 'Calls'},
        ]
        container = report(inner).warnings
        self.assertTrue(any('3 containers and no component view' in w and '"api"' in w for w in container), container)

        body = {k: inner[k] for k in ('nodes', 'relationships')}
        context = {
            'title': 'Shop',
            'level': 'context',
            'layout': {'primaryFlow': 'glance'},
            'nodes': [
                {'id': 'c.user', 'type': 'person', 'label': 'Shopper'},
                {'id': 'shop', 'type': 'service', 'label': 'Shop', 'description': 'Sells things.', 'inside': body},
            ],
            'relationships': [{'id': 'c.r1', 'from': 'c.user', 'to': 'shop', 'label': 'Buys'}],
            'flows': [
                {
                    'id': 'glance',
                    'title': 'At a glance',
                    'steps': [{'spotlight': ['shop'], 'caption': 'The shop.'}, {'relationship': 'c.r1', 'caption': 'A purchase.'}],
                }
            ],
        }
        # The inside of a context view's system is its container view without saying so.
        warnings = '\n'.join(report(context).warnings)
        self.assertIn('no component view', warnings)
        self.assertIn('the container view has no flow', warnings)

        next(n for n in body['nodes'] if n['id'] == 'api')['inside'] = {
            'nodes': [{'id': 'api.http', 'type': 'component', 'label': 'Handlers', 'description': 'Routes.'}],
            'relationships': [],
        }
        self.assertNotIn('no component view', '\n'.join(report(context).warnings))


class CommandLine(unittest.TestCase):
    def test_exit_codes_and_a_fresh_request_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            good, bad, broken = (Path(tmp) / name for name in ('good.json', 'bad.json', 'broken.json'))
            clean = minimal()
            del clean['requestId']
            good.write_text(json.dumps(clean), encoding='utf-8')
            bad.write_text(json.dumps(minimal(title='')), encoding='utf-8')
            broken.write_text('{ nope', encoding='utf-8')
            ok = run_script('check_diagram', str(good))
            self.assertEqual(ok.returncode, 0, ok.stdout)
            self.assertRegex(ok.stdout, r'requestId: missing — use "[0-9a-f-]{36}"')
            self.assertEqual(run_script('check_diagram', str(bad)).returncode, 1)
            self.assertEqual(run_script('check_diagram', str(broken)).returncode, 2)


if __name__ == '__main__':
    unittest.main()
