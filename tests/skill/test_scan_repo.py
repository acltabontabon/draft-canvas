"""`scan_repo.py`: what it finds, what it must never print, and that odd repositories don't break it."""

from __future__ import annotations

import json
import time
import unittest

from helpers import TempRepo, load, run_script

scan = load('scan_repo')

COMPOSE = """\
services:
  web:
    build: .
    ports: ["8080:8080"]
    depends_on: [proxy]
  proxy:
    build: .
    environment:
      - GRPC_COUNTER_HOST=counter
    depends_on:
      counter:
        condition: service_started
  counter:
    build: .
    environment:
      DATABASE_URL: postgres://admin:hunter2@postgres:5432/shop
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672/
    depends_on: [postgres, rabbitmq]
  postgres:
    image: postgres:16
  rabbitmq:
    image: rabbitmq:3-management
  adminer:
    image: adminer
    depends_on: [postgres]
"""

GO_MOD = """\
module github.com/example/coffee

go 1.22

require (
\tgithub.com/rabbitmq/amqp091-go v1.9.0
\tgithub.com/lib/pq v1.10.9
\tgoogle.golang.org/grpc v1.62.0
)
"""

SHOP = {
    'go.mod': GO_MOD,
    'docker-compose.yml': COMPOSE,
    'cmd/counter/main.go': (
        'package main\n'
        'func main() {\n'
        '\tpub.Configure(publisher.ExchangeName("barista-orders"))\n'
        '\tsub.Configure(consumer.ExchangeName("counter-updates"), consumer.QueueName("counter-queue"))\n'
        '\tdsn := os.Getenv("DATABASE_URL")\n'
        '}\n'
    ),
    'cmd/barista/main.go': (
        'package main\n'
        'func main() {\n'
        '\tsub.Configure(consumer.ExchangeName("barista-orders"))\n'
        '\tpub.Configure(publisher.ExchangeName("counter-updates"))\n'
        '}\n'
    ),
    'cmd/proxy/main.go': 'package main\nfunc main() { mux.HandleFunc("/v1/orders", h) }\n',
    'pkg/rabbit/consumer.go': 'package rabbit\nfunc d() { ch.ExchangeDeclare(name, "direct", true) }\n',
    'proto/counter.proto': (
        'syntax = "proto3";\n'
        'service CounterService {\n'
        '  rpc PlaceOrder(Req) returns (Res) { option (google.api.http) = { post: "/v1/api/orders" body: "*" }; }\n'
        '}\n'
    ),
    '.env.example': 'STRIPE_SECRET_KEY=sk_live_51Hx_DO_NOT_PRINT\nPORT=8080\n',
    'README.md': '# Coffee shop\n\n' + 'A small system of services that take and make coffee orders. ' * 5,
    'docs/placeholder/README.md': 'TBD\n',
    'build/nomad/jobs/counter.nomad.hcl': 'job "counter" {\n  group "g" {\n    task "counter" {\n      config { image = "ghcr.io/example/counter:1" }\n    }\n  }\n}\n',
    'vendor/github.com/lib/pq/conn.go': 'package pq\nfunc x() { os.Getenv("VENDORED_SECRET_ADDR") }\n',
}


def survey(root, **kwargs) -> dict:
    return scan.survey(str(root), kwargs.get('max_files', 40000))


class FindsTheSystem(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = TempRepo(SHOP, git=True)
        root = cls.repo.__enter__()
        cls.data = survey(root)
        cls.text = scan.render_text(cls.data)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.repo.__exit__()

    def test_a_go_module_with_several_programs_is_one_unit_naming_each_program(self) -> None:
        [unit] = self.data['units']
        self.assertEqual(unit['binaries'], ['barista', 'counter', 'proxy'])
        self.assertEqual(unit['suggested_type'], 'api (also consumes messages)')

    def test_stores_and_brokers_come_from_dependencies_images_and_settings(self) -> None:
        names = {s['name']: s for s in self.data['signals']}
        self.assertEqual(names['PostgreSQL']['type'], 'sql-database')
        self.assertEqual(names['RabbitMQ']['type'], 'queue')

    def test_connections_come_from_compose_and_settings_never_from_dev_tools(self) -> None:
        links = {(link['from'], link['to']) for link in self.data['links']}
        self.assertIn(('web', 'proxy'), links)
        self.assertIn(('proxy', 'counter'), links)  # long-form depends_on and GRPC_COUNTER_HOST
        self.assertIn(('counter', 'postgres'), links)
        self.assertNotIn(('adminer', 'postgres'), links)
        self.assertFalse(any(name == 'condition' for link in self.data['links'] for name in (link['from'], link['to'])))
        # A module that builds several programs never speaks as one unit.
        self.assertFalse(any(link['from'] == 'coffee' for link in self.data['links']))

    def test_each_program_publishes_and_consumes_under_its_own_name(self) -> None:
        seen = {(m['unit'], m['kind'], m['name']) for m in self.data['messages']}
        self.assertIn(('counter', 'publish', 'barista-orders'), seen)
        self.assertIn(('counter', 'consume', 'counter-queue'), seen)
        self.assertIn(('barista', 'consume', 'barista-orders'), seen)
        self.assertIn(('barista', 'publish', 'counter-updates'), seen)
        self.assertEqual([e['kind'] for e in self.data['exchange_kinds']], ['direct'])

    def test_routes_include_grpc_gateway_annotations(self) -> None:
        [unit] = self.data['units']
        paths = {(r['method'], r['path']) for r in unit['route_sample']}
        self.assertIn(('POST', '/v1/api/orders'), paths)
        self.assertIn(('ANY', '/v1/orders'), paths)

    def test_committed_deploy_folders_are_read_and_vendored_code_is_not(self) -> None:
        self.assertEqual([n['task'] for n in self.data['nomad']], ['counter'])
        self.assertNotIn('VENDORED_SECRET_ADDR', self.text)

    def test_reads_next_every_program_and_skips_a_placeholder_readme(self) -> None:
        paths = [r['path'] for r in self.data['read_next']]
        for program in ('barista', 'counter', 'proxy'):
            self.assertIn(f'cmd/{program}/main.go', paths)
        self.assertIn('README.md', paths)
        self.assertNotIn('docs/placeholder/README.md', paths)

    def test_never_prints_a_setting_value(self) -> None:
        for secret in ('sk_live_51Hx_DO_NOT_PRINT', 'hunter2', 'admin:', 'guest:guest'):
            self.assertNotIn(secret, self.text)
            self.assertNotIn(secret, json.dumps(self.data))
        self.assertIn('STRIPE_SECRET_KEY', self.text)
        self.assertIn('DATABASE_URL', self.text)


class StaysUpright(unittest.TestCase):
    def test_a_folder_that_is_not_a_git_checkout_is_walked_skipping_dependencies_and_output(self) -> None:
        files = {
            'package.json': json.dumps({'name': 'shop-web', 'dependencies': {'express': '4', 'pg': '8', 'stripe': '14'}}),
            'src/server.js': "const app = express();\napp.post('/orders', h);\nprocess.env.STRIPE_KEY;\n",
            'node_modules/pg/index.js': "app.get('/never', h)\n",
            'dist/server.js': "app.get('/never-either', h)\n",
        }
        with TempRepo(files) as root:
            data = survey(root)
        [unit] = data['units']
        self.assertEqual(unit['name'], 'shop-web')
        self.assertEqual(unit['suggested_type'], 'api')
        self.assertEqual([(r['method'], r['path']) for r in unit['route_sample']], [('POST', '/orders')])
        self.assertEqual({s['key'] for s in data['signals']}, {'postgres', 'stripe'})

    def test_broken_binary_huge_and_strangely_named_files_are_survived(self) -> None:
        files = {
            'package.json': '{ this is not json',
            'pyproject.toml': '[project]\nname = "api"\ndependencies = ["fastapi[standard]>=0.110", "psycopg[binary]"]\n',
            'logo.png': b'\x89PNG\r\n\x1a\n\x00\x00\x00' + bytes(range(256)) * 4,
            'big.js': "app.get('/too-big', h)\n" + ('x' * 1024 * 1024),
            'latin1.py': 'caf\xe9 = "app"\n'.encode('latin-1'),
            'résumé/ünïcode.py': '@app.get("/unicode")\ndef f(): ...\n',
        }
        with TempRepo(files, git=True) as root:
            data = survey(root)
            text = scan.render_text(data)
        api = next(u for u in data['units'] if u['name'] == 'api')
        self.assertEqual(api['frameworks'], ['FastAPI'])
        self.assertIn('PostgreSQL', text)
        self.assertNotIn('/too-big', text)
        self.assertIn('/unicode', text)

    def test_an_empty_folder_says_so(self) -> None:
        with TempRepo({}) as root:
            text = scan.render_text(survey(root))
        self.assertIn('none found from manifests', text)

    def test_the_aws_sdk_check_only_reads_javascript(self) -> None:
        files = {'tool.py': "# require('aws-sdk')\nclient = new S3()\n"}
        with TempRepo(files) as root:
            data = survey(root)
        self.assertNotIn('s3', {s['key'] for s in data['signals']})

    def test_a_few_thousand_files_take_well_under_a_few_seconds(self) -> None:
        files = {f'svc{i % 20}/src/mod{i}.ts': f"export const r{i} = router.get('/r{i}', h);\n" for i in range(3000)}
        files.update({f'svc{i}/package.json': json.dumps({'name': f'svc{i}', 'dependencies': {'express': '4'}}) for i in range(20)})
        with TempRepo(files, git=True) as root:
            started = time.perf_counter()
            data = survey(root)
            elapsed = time.perf_counter() - started
        self.assertEqual(len(data['units']), 20)
        self.assertLess(elapsed, 5.0)


class CommandLine(unittest.TestCase):
    def test_json_is_valid_and_a_missing_folder_is_refused(self) -> None:
        with TempRepo(SHOP) as root:
            done = run_script('scan_repo', str(root), '--json')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('units', json.loads(done.stdout))
        missing = run_script('scan_repo', '/nonexistent/folder/for/sure')
        self.assertEqual(missing.returncode, 2)
        self.assertIn('Not a folder', missing.stderr)

    def test_prints_on_a_console_that_cannot_encode_its_punctuation(self) -> None:
        with TempRepo(SHOP) as root:
            done = run_script('scan_repo', str(root), env={'PYTHONIOENCODING': 'ascii'}, isolated=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('Repository survey', done.stdout)


if __name__ == '__main__':
    unittest.main()
