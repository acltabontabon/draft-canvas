#!/usr/bin/env python3
"""Survey a repository for drawing its architecture in Draft Canvas.

One pass over the files (git's list when it is a git checkout, so ignored files stay out), standard
library only. Prints a compact map an agent can act on: deployable units, runtime services, detected
stores/brokers/external services, HTTP routes, messaging names, schedules, contracts, docs and a
ranked list of files to read next. Everything found is a *candidate* to confirm in code.

Never prints environment variable values, connection strings or file contents — names and
locations only.

    python3 scan_repo.py <repo-root> [--json] [--max-files N]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable

SKIP_DIRS = {
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'bower_components',
    'vendor',
    'dist',
    'build',
    'out',
    'target',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.output',
    '.venv',
    'venv',
    'env',
    '__pycache__',
    '.tox',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    'coverage',
    '.gradle',
    '.idea',
    '.vscode',
    'Pods',
    'DerivedData',
    '.terraform',
    '.serverless',
    '.turbo',
    '.cache',
    '.parcel-cache',
    'tmp',
    'logs',
    '.github',
    '.gitlab',
    '.circleci',
    '.husky',
    '.yarn',
    '.pnpm-store',
    'site-packages',
    '.dart_tool',
    '.angular',
    'storybook-static',
}
COMMITTED_SKIP_DIRS = {
    'node_modules',
    'bower_components',
    'vendor',
    'site-packages',
    'Pods',
    '.yarn',
    '.github',
    '.gitlab',
    '.circleci',
    '.husky',
    'third_party',
    'third-party',
    '.terraform',
}
# Units under these folders are examples, tests or docs, not the system's own deployables.
NON_UNIT_DIRS = {
    'test',
    'tests',
    '__tests__',
    'e2e',
    'fixtures',
    'testdata',
    'mocks',
    '__mocks__',
    'examples',
    'example',
    'samples',
    'sample',
    'docs',
    'benchmark',
    'benchmarks',
    'spec',
    'playground',
}

LANGUAGES = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.mts': 'TypeScript',
    '.cts': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.mjs': 'JavaScript',
    '.cjs': 'JavaScript',
    '.py': 'Python',
    '.go': 'Go',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.kts': 'Kotlin',
    '.scala': 'Scala',
    '.rs': 'Rust',
    '.rb': 'Ruby',
    '.php': 'PHP',
    '.cs': 'C#',
    '.fs': 'F#',
    '.swift': 'Swift',
    '.m': 'Objective-C',
    '.dart': 'Dart',
    '.ex': 'Elixir',
    '.exs': 'Elixir',
    '.erl': 'Erlang',
    '.clj': 'Clojure',
    '.c': 'C',
    '.cc': 'C++',
    '.cpp': 'C++',
    '.h': 'C/C++',
    '.hpp': 'C++',
    '.vue': 'Vue',
    '.svelte': 'Svelte',
    '.sql': 'SQL',
    '.tf': 'Terraform',
    '.proto': 'Protobuf',
    '.graphql': 'GraphQL',
    '.gql': 'GraphQL',
}
CODE_EXTS = {e for e, lang in LANGUAGES.items() if lang not in {'SQL', 'Terraform', 'Protobuf', 'GraphQL'}}
MAX_READ = 512 * 1024

# --- What a dependency, an image or an environment variable says -------------------------------
#
# Each signal: (regex fully matching the lowercase dependency/image name, key). Keys index KNOWN.

KNOWN: dict[str, tuple[str, str, str]] = {
    # key: (display name, Draft Canvas type, category)
    'postgres': ('PostgreSQL', 'sql-database', 'store'),
    'mysql': ('MySQL', 'sql-database', 'store'),
    'sqlite': ('SQLite', 'sql-database', 'store'),
    'mssql': ('SQL Server', 'sql-database', 'store'),
    'oracle': ('Oracle Database', 'sql-database', 'store'),
    'clickhouse': ('ClickHouse', 'sql-database', 'store'),
    'mongodb': ('MongoDB', 'nosql-database', 'store'),
    'dynamodb': ('DynamoDB', 'nosql-database', 'store'),
    'cassandra': ('Cassandra', 'nosql-database', 'store'),
    'firestore': ('Firestore', 'nosql-database', 'store'),
    'cosmosdb': ('Cosmos DB', 'nosql-database', 'store'),
    'neo4j': ('Neo4j', 'nosql-database', 'store'),
    'redis': ('Redis', 'cache', 'store'),
    'memcached': ('Memcached', 'cache', 'store'),
    'elasticsearch': ('Elasticsearch', 'search-index', 'store'),
    'opensearch': ('OpenSearch', 'search-index', 'store'),
    'meilisearch': ('Meilisearch', 'search-index', 'store'),
    'typesense': ('Typesense', 'search-index', 'store'),
    'pinecone': ('Pinecone', 'search-index', 'store'),
    'qdrant': ('Qdrant', 'search-index', 'store'),
    'weaviate': ('Weaviate', 'search-index', 'store'),
    's3': ('Amazon S3', 'object-storage', 'store'),
    'gcs': ('Google Cloud Storage', 'object-storage', 'store'),
    'azureblob': ('Azure Blob Storage', 'object-storage', 'store'),
    'minio': ('MinIO', 'object-storage', 'store'),
    'kafka': ('Kafka', 'stream', 'messaging'),
    'kinesis': ('Kinesis', 'stream', 'messaging'),
    'nats': ('NATS', 'stream', 'messaging'),
    'rabbitmq': ('RabbitMQ', 'queue', 'messaging'),
    'sqs': ('Amazon SQS', 'queue', 'messaging'),
    'sns': ('Amazon SNS', 'topic', 'messaging'),
    'eventbridge': ('Amazon EventBridge', 'topic', 'messaging'),
    'pubsub': ('Google Pub/Sub', 'topic', 'messaging'),
    'servicebus': ('Azure Service Bus', 'queue', 'messaging'),
    'mqtt': ('MQTT broker', 'topic', 'messaging'),
    'bullmq': ('BullMQ (Redis)', 'queue', 'messaging'),
    'celery': ('Celery', 'worker', 'messaging'),
    'sidekiq': ('Sidekiq', 'worker', 'messaging'),
    'rq': ('RQ', 'worker', 'messaging'),
    'temporal': ('Temporal', 'external-system', 'messaging'),
    'stripe': ('Stripe', 'external-system', 'external'),
    'braintree': ('Braintree', 'external-system', 'external'),
    'adyen': ('Adyen', 'external-system', 'external'),
    'paypal': ('PayPal', 'external-system', 'external'),
    'plaid': ('Plaid', 'external-system', 'external'),
    'twilio': ('Twilio', 'external-system', 'external'),
    'sendgrid': ('SendGrid', 'external-system', 'external'),
    'postmark': ('Postmark', 'external-system', 'external'),
    'mailgun': ('Mailgun', 'external-system', 'external'),
    'resend': ('Resend', 'external-system', 'external'),
    'ses': ('Amazon SES', 'external-system', 'external'),
    'smtp': ('SMTP email server', 'external-system', 'external'),
    'fcm': ('Firebase Cloud Messaging', 'external-system', 'external'),
    'auth0': ('Auth0', 'external-system', 'external'),
    'okta': ('Okta', 'external-system', 'external'),
    'clerk': ('Clerk', 'external-system', 'external'),
    'cognito': ('Amazon Cognito', 'external-system', 'external'),
    'keycloak': ('Keycloak', 'external-system', 'external'),
    'supabase': ('Supabase', 'external-system', 'external'),
    'firebase': ('Firebase', 'external-system', 'external'),
    'openai': ('OpenAI API', 'external-system', 'external'),
    'anthropic': ('Anthropic API', 'external-system', 'external'),
    'gemini': ('Google Gemini API', 'external-system', 'external'),
    'cohere': ('Cohere API', 'external-system', 'external'),
    'segment': ('Segment', 'external-system', 'external'),
    'mixpanel': ('Mixpanel', 'external-system', 'external'),
    'posthog': ('PostHog', 'external-system', 'external'),
    'algolia': ('Algolia', 'external-system', 'external'),
    'slack': ('Slack API', 'external-system', 'external'),
    'github': ('GitHub API', 'external-system', 'external'),
    'shopify': ('Shopify', 'external-system', 'external'),
    'salesforce': ('Salesforce', 'external-system', 'external'),
    'hubspot': ('HubSpot', 'external-system', 'external'),
    'googlemaps': ('Google Maps Platform', 'external-system', 'external'),
    'contentful': ('Contentful', 'external-system', 'external'),
    'sentry': ('Sentry', '-', 'observability'),
    'datadog': ('Datadog', '-', 'observability'),
    'newrelic': ('New Relic', '-', 'observability'),
    'opentelemetry': ('OpenTelemetry', '-', 'observability'),
    'prometheus': ('Prometheus', '-', 'observability'),
    'grafana': ('Grafana', '-', 'observability'),
    'jaeger': ('Jaeger', '-', 'observability'),
    'nginx': ('NGINX', 'gateway', 'edge'),
    'traefik': ('Traefik', 'gateway', 'edge'),
    'envoy': ('Envoy', 'gateway', 'edge'),
    'kong': ('Kong', 'gateway', 'edge'),
    'haproxy': ('HAProxy', 'gateway', 'edge'),
    'caddy': ('Caddy', 'gateway', 'edge'),
}

DEP_SIGNALS: list[tuple[str, str]] = [
    (
        r'pg|postgres|pg-promise|psycopg2?(-binary)?|psycopg(\[.*\])?|asyncpg|org\.postgresql:postgresql|github\.com/lib/pq|github\.com/jackc/pgx(/v\d)?|npgsql.*|@neondatabase/serverless|@vercel/postgres|pgx|tokio-postgres|postgresql'
        # Wrappers that bring the driver with them: a lock file lists the driver only as transitive.
        r'|langchain-postgres|langchain-google-alloydb-pg|google-cloud-alloydb-connector(\[.*\])?|pgvector',
        'postgres',
    ),
    (
        r'mysql2?|pymysql|mysqlclient|mysql-connector.*|aiomysql|github\.com/go-sql-driver/mysql|com\.mysql:.*|mysql:mysql-connector-java|mariadb',
        'mysql',
    ),
    (r'sqlite3|better-sqlite3|rusqlite|github\.com/mattn/go-sqlite3|aiosqlite|@libsql/client', 'sqlite'),
    (r'mssql|tedious|pyodbc|microsoft\.data\.sqlclient|com\.microsoft\.sqlserver:.*', 'mssql'),
    (r'oracledb|cx_oracle|com\.oracle\.database\.jdbc:.*', 'oracle'),
    (r'@clickhouse/client|clickhouse-driver|clickhouse-connect', 'clickhouse'),
    (
        r'mongodb|mongoose|pymongo|motor|mongoengine|go\.mongodb\.org/mongo-driver|org\.springframework\.boot:spring-boot-starter-data-mongodb|mongodb\.driver|mongoid',
        'mongodb',
    ),
    (r'@aws-sdk/client-dynamodb|@aws-sdk/lib-dynamodb|dynamoose|pynamodb|aws-sdk-dynamodb|software\.amazon\.awssdk:dynamodb.*', 'dynamodb'),
    (r'cassandra-driver|github\.com/gocql/gocql|com\.datastax\.oss:.*', 'cassandra'),
    (r'@google-cloud/firestore|google-cloud-firestore', 'firestore'),
    (r'@azure/cosmos|azure-cosmos', 'cosmosdb'),
    (r'neo4j(-driver)?|github\.com/neo4j/.*', 'neo4j'),
    (
        r'redis|ioredis|redis-py|github\.com/(go-redis|redis)/.*|redis\.clients:jedis|io\.lettuce:.*|org\.springframework\.boot:spring-boot-starter-data-redis|stackexchange\.redis|@upstash/redis|aioredis',
        'redis',
    ),
    (r'memcached|pymemcache|memjs|pylibmc', 'memcached'),
    (
        r'@elastic/elasticsearch|elasticsearch(\[.*\])?|elasticsearch-dsl|github\.com/(olivere|elastic)/.*|org\.springframework\.boot:spring-boot-starter-data-elasticsearch|co\.elastic\.clients:.*',
        'elasticsearch',
    ),
    (r'@opensearch-project/opensearch|opensearch-py', 'opensearch'),
    (r'meilisearch', 'meilisearch'),
    (r'typesense', 'typesense'),
    (r'@pinecone-database/pinecone|pinecone(-client)?', 'pinecone'),
    (r'qdrant-client|@qdrant/js-client-rest', 'qdrant'),
    (r'weaviate-client|weaviate-ts-client', 'weaviate'),
    (r'@aws-sdk/client-s3|@aws-sdk/lib-storage|aws-sdk-s3|software\.amazon\.awssdk:s3|s3fs|aioboto3', 's3'),
    (r'@google-cloud/storage|google-cloud-storage', 'gcs'),
    (r'@azure/storage-blob|azure-storage-blob', 'azureblob'),
    (r'minio', 'minio'),
    (
        r'kafkajs|node-rdkafka|@confluentinc/kafka-javascript|confluent-kafka|kafka-python|aiokafka|github\.com/segmentio/kafka-go|github\.com/confluentinc/confluent-kafka-go.*|github\.com/(ibm|shopify)/sarama|org\.springframework\.kafka:spring-kafka|org\.apache\.kafka:kafka-clients|rdkafka|faust(-streaming)?',
        'kafka',
    ),
    (r'@aws-sdk/client-kinesis|amazon-kinesis-client', 'kinesis'),
    (r'nats(\.ws)?|nats-py|github\.com/nats-io/nats\.go', 'nats'),
    (
        r'amqplib|amqp-connection-manager|pika|aio-pika|kombu|github\.com/streadway/amqp|github\.com/rabbitmq/amqp091-go|org\.springframework\.boot:spring-boot-starter-amqp|rabbitmq\.client|bunny|php-amqplib/php-amqplib',
        'rabbitmq',
    ),
    (
        r'@aws-sdk/client-sqs|sqs-consumer|sqs-producer|aws-sdk-sqs|software\.amazon\.awssdk:sqs|io\.awspring\.cloud:spring-cloud-aws-starter-sqs',
        'sqs',
    ),
    (r'@aws-sdk/client-sns|software\.amazon\.awssdk:sns', 'sns'),
    (r'@aws-sdk/client-eventbridge', 'eventbridge'),
    (r'@google-cloud/pubsub|google-cloud-pubsub|cloud\.google\.com/go/pubsub', 'pubsub'),
    (r'@azure/service-bus|azure-servicebus', 'servicebus'),
    (r'mqtt|paho-mqtt|async-mqtt', 'mqtt'),
    (r'bullmq|bull|bee-queue|@nestjs/bull(mq)?', 'bullmq'),
    (r'celery(\[.*\])?', 'celery'),
    (r'sidekiq', 'sidekiq'),
    (r'rq|django-rq', 'rq'),
    (r'@temporalio/.*|temporalio|go\.temporal\.io/sdk', 'temporal'),
    (r'stripe|@stripe/stripe-js|stripe-go|github\.com/stripe/stripe-go(/v\d+)?|com\.stripe:stripe-java', 'stripe'),
    (r'braintree', 'braintree'),
    (r'@adyen/api-library|adyen', 'adyen'),
    (r'@paypal/.*|paypalrestsdk|paypal-checkout-serversdk', 'paypal'),
    (r'plaid(-python)?', 'plaid'),
    (r'twilio', 'twilio'),
    (r'@sendgrid/mail|sendgrid', 'sendgrid'),
    (r'postmark', 'postmark'),
    (r'mailgun(\.js)?|mailgun-js', 'mailgun'),
    (r'resend', 'resend'),
    (r'@aws-sdk/client-sesv?2?|software\.amazon\.awssdk:sesv?2?', 'ses'),
    (
        r'nodemailer|django-anymail|actionmailer|spring-boot-starter-mail|org\.springframework\.boot:spring-boot-starter-mail|lettre|gomail',
        'smtp',
    ),
    (r'auth0|@auth0/.*|auth0-python', 'auth0'),
    (r'@okta/.*|okta', 'okta'),
    (r'@clerk/.*', 'clerk'),
    (r'@aws-sdk/client-cognito-identity-provider|amazon-cognito-identity-js', 'cognito'),
    (r'keycloak-js|keycloak-connect|python-keycloak', 'keycloak'),
    (r'@supabase/supabase-js|supabase', 'supabase'),
    (r'firebase|firebase-admin|@react-native-firebase/.*', 'firebase'),
    (r'openai|@ai-sdk/openai|langchain-openai|@langchain/openai', 'openai'),
    (r'@anthropic-ai/sdk|anthropic|@ai-sdk/anthropic|langchain-anthropic|@langchain/anthropic', 'anthropic'),
    (r'@google/generative-ai|@google/genai|google-generativeai|google-genai|langchain-google-genai|@langchain/google-genai', 'gemini'),
    (r'cohere(-ai)?', 'cohere'),
    (r'analytics-node|@segment/.*|segment-analytics-python|analytics-python', 'segment'),
    (r'mixpanel(-browser)?', 'mixpanel'),
    (r'posthog(-js|-node)?', 'posthog'),
    (r'algoliasearch', 'algolia'),
    (r'@slack/.*|slack[-_]sdk|slack-bolt', 'slack'),
    (r'@octokit/.*|pygithub|octokit|github\.com/google/go-github(/v\d+)?', 'github'),
    (r'@shopify/.*|shopifyapi', 'shopify'),
    (r'jsforce|simple-salesforce', 'salesforce'),
    (r'@hubspot/.*|hubspot-api-client', 'hubspot'),
    (r'@googlemaps/.*|googlemaps', 'googlemaps'),
    (r'contentful', 'contentful'),
    (r'@sentry/.*|sentry-sdk|sentry-ruby|io\.sentry:.*|github\.com/getsentry/sentry-go', 'sentry'),
    (r'dd-trace|ddtrace|datadog', 'datadog'),
    (r'newrelic', 'newrelic'),
    (r'@opentelemetry/.*|opentelemetry-.*|go\.opentelemetry\.io/.*|io\.opentelemetry:.*', 'opentelemetry'),
    (r'prom-client|prometheus[-_]client|github\.com/prometheus/client_golang', 'prometheus'),
]

FRAMEWORKS: list[tuple[str, str, str]] = [
    # (regex, name, role) — role: web (UI), api, worker, cli, mobile, desktop, rpc
    (r'next', 'Next.js', 'web'),
    (r'nuxt', 'Nuxt', 'web'),
    (r'@remix-run/.*', 'Remix', 'web'),
    (r'@sveltejs/kit', 'SvelteKit', 'web'),
    (r'astro', 'Astro', 'web'),
    (r'@angular/core', 'Angular', 'web'),
    (r'vue', 'Vue', 'web'),
    (r'react-dom', 'React', 'web'),
    (r'svelte', 'Svelte', 'web'),
    (r'solid-js', 'Solid', 'web'),
    (r'react-native|expo', 'React Native', 'mobile'),
    (r'electron', 'Electron', 'desktop'),
    (r'@tauri-apps/api', 'Tauri', 'desktop'),
    (r'express', 'Express', 'api'),
    (r'fastify', 'Fastify', 'api'),
    (r'koa', 'Koa', 'api'),
    (r'@hapi/hapi', 'hapi', 'api'),
    (r'@nestjs/core', 'NestJS', 'api'),
    (r'hono', 'Hono', 'api'),
    (r'@trpc/server', 'tRPC', 'api'),
    (r'@apollo/server|apollo-server(-express)?|graphql-yoga|mercurius', 'GraphQL server', 'api'),
    (r'django', 'Django', 'api'),
    (r'djangorestframework', 'Django REST framework', 'api'),
    (r'flask', 'Flask', 'api'),
    (r'fastapi', 'FastAPI', 'api'),
    (r'starlette', 'Starlette', 'api'),
    (r'aiohttp', 'aiohttp', 'api'),
    (r'tornado', 'Tornado', 'api'),
    (r'sanic', 'Sanic', 'api'),
    (r'litestar', 'Litestar', 'api'),
    (r'org\.springframework\.boot:spring-boot-starter-web(flux)?', 'Spring Boot', 'api'),
    (r'io\.quarkus:.*', 'Quarkus', 'api'),
    (r'io\.micronaut:.*', 'Micronaut', 'api'),
    (r'io\.ktor:.*', 'Ktor', 'api'),
    (r'github\.com/gin-gonic/gin', 'Gin', 'api'),
    (r'github\.com/labstack/echo(/v\d)?', 'Echo', 'api'),
    (r'github\.com/gofiber/fiber(/v\d)?', 'Fiber', 'api'),
    (r'github\.com/go-chi/chi(/v\d)?', 'chi', 'api'),
    (r'github\.com/gorilla/mux', 'gorilla/mux', 'api'),
    (r'actix-web', 'Actix Web', 'api'),
    (r'axum', 'Axum', 'api'),
    (r'rocket', 'Rocket', 'api'),
    (r'warp', 'warp', 'api'),
    (r'rails|railties', 'Rails', 'api'),
    (r'sinatra', 'Sinatra', 'api'),
    (r'laravel/framework', 'Laravel', 'api'),
    (r'symfony/framework-bundle', 'Symfony', 'api'),
    (r'phoenix', 'Phoenix', 'api'),
    (r'microsoft\.aspnetcore.*', 'ASP.NET Core', 'api'),
    (r'@grpc/grpc-js|grpcio|google\.golang\.org/grpc|io\.grpc:.*|tonic|grpc\.aspnetcore', 'gRPC', 'rpc'),
    (r'commander|yargs|oclif|@oclif/core|click|typer|github\.com/spf13/cobra|github\.com/urfave/cli(/v\d)?|clap', 'CLI', 'cli'),
    (
        r'node-cron|cron|apscheduler|celery-beat|django-celery-beat|github\.com/robfig/cron(/v\d)?|quartz|org\.quartz-scheduler:quartz',
        'scheduler library',
        'scheduler',
    ),
]

IMAGE_SIGNALS: list[tuple[str, str]] = [
    (r'(.*/)?postgres(ql)?|(.*/)?postgis.*|timescale/.*|supabase/postgres', 'postgres'),
    (r'(.*/)?mysql|(.*/)?mariadb', 'mysql'),
    (r'(.*/)?mongo(db)?', 'mongodb'),
    (r'(.*/)?redis(-stack)?|(.*/)?valkey|(.*/)?dragonfly.*|bitnami/redis', 'redis'),
    (r'(.*/)?memcached', 'memcached'),
    (r'(.*/)?rabbitmq', 'rabbitmq'),
    (r'confluentinc/cp-kafka|bitnami/kafka|apache/kafka|wurstmeister/kafka|redpandadata/redpanda|vectorized/redpanda|(.*/)?kafka', 'kafka'),
    (r'(.*/)?elasticsearch|docker\.elastic\.co/elasticsearch/elasticsearch', 'elasticsearch'),
    (r'opensearchproject/opensearch', 'opensearch'),
    (r'(.*/)?minio', 'minio'),
    (r'getmeili/meilisearch', 'meilisearch'),
    (r'(.*/)?nats', 'nats'),
    (r'(.*/)?cassandra', 'cassandra'),
    (r'(.*/)?neo4j', 'neo4j'),
    (r'clickhouse/clickhouse-server|yandex/clickhouse-server', 'clickhouse'),
    (r'(.*/)?nginx|nginxinc/.*', 'nginx'),
    (r'(.*/)?traefik', 'traefik'),
    (r'envoyproxy/envoy.*', 'envoy'),
    (r'(.*/)?kong', 'kong'),
    (r'(.*/)?haproxy', 'haproxy'),
    (r'(.*/)?caddy', 'caddy'),
    (r'(.*/)?keycloak|quay\.io/keycloak/keycloak', 'keycloak'),
    (r'temporalio/.*', 'temporal'),
    (r'mailhog/mailhog|axllent/mailpit|(.*/)?maildev', 'smtp'),
    (r'(.*/)?prometheus|prom/prometheus', 'prometheus'),
    (r'grafana/.*', 'grafana'),
    (r'jaegertracing/.*', 'jaeger'),
    (r'localstack/localstack', 'localstack'),
]

ENV_SIGNALS: list[tuple[str, str]] = [
    (r'.*(POSTGRES|PG_|PGHOST|PGDATABASE).*', 'postgres'),
    (r'.*MYSQL.*', 'mysql'),
    (r'.*MONGO.*', 'mongodb'),
    (r'.*REDIS.*', 'redis'),
    (r'.*MEMCACHE.*', 'memcached'),
    (r'.*(ELASTIC|ES_URL|ES_HOST).*', 'elasticsearch'),
    (r'.*OPENSEARCH.*', 'opensearch'),
    (r'.*KAFKA.*', 'kafka'),
    (r'.*(RABBIT|AMQP).*', 'rabbitmq'),
    (r'.*SQS.*', 'sqs'),
    (r'.*SNS.*', 'sns'),
    (r'.*(S3_|_S3|BUCKET).*', 's3'),
    (r'.*STRIPE.*', 'stripe'),
    (r'.*TWILIO.*', 'twilio'),
    (r'.*SENDGRID.*', 'sendgrid'),
    (r'.*POSTMARK.*', 'postmark'),
    (r'.*MAILGUN.*', 'mailgun'),
    (r'.*RESEND.*', 'resend'),
    (r'.*SMTP.*', 'smtp'),
    (r'.*AUTH0.*', 'auth0'),
    (r'.*OKTA.*', 'okta'),
    (r'.*CLERK.*', 'clerk'),
    (r'.*COGNITO.*', 'cognito'),
    (r'.*KEYCLOAK.*', 'keycloak'),
    (r'.*SUPABASE.*', 'supabase'),
    (r'.*FIREBASE.*', 'firebase'),
    (r'.*OPENAI.*', 'openai'),
    (r'.*ANTHROPIC.*', 'anthropic'),
    (r'.*(GEMINI|GOOGLE_AI).*', 'gemini'),
    (r'.*SEGMENT.*', 'segment'),
    (r'.*SENTRY.*', 'sentry'),
    (r'.*(DATADOG|DD_API|DD_AGENT).*', 'datadog'),
    (r'.*NEW_RELIC.*', 'newrelic'),
    (r'.*OTEL_.*', 'opentelemetry'),
    (r'.*ALGOLIA.*', 'algolia'),
    (r'.*SLACK.*', 'slack'),
    (r'.*PLAID.*', 'plaid'),
    (r'.*PAYPAL.*', 'paypal'),
    (r'.*BRAINTREE.*', 'braintree'),
    (r'.*ADYEN.*', 'adyen'),
    (r'.*SHOPIFY.*', 'shopify'),
    (r'.*HUBSPOT.*', 'hubspot'),
    (r'.*SALESFORCE.*', 'salesforce'),
    (r'.*PINECONE.*', 'pinecone'),
    (r'.*QDRANT.*', 'qdrant'),
    (r'.*NATS.*', 'nats'),
    (r'.*TEMPORAL.*', 'temporal'),
    (r'.*KINESIS.*', 'kinesis'),
    (r'.*PUBSUB.*', 'pubsub'),
    (r'.*SERVICE_?BUS.*', 'servicebus'),
    (r'.*MQTT.*', 'mqtt'),
    (r'.*CLICKHOUSE.*', 'clickhouse'),
]

TF_SIGNALS: list[tuple[str, str]] = [
    (r'aws_db_instance|aws_rds_cluster|google_sql_database_instance|azurerm_(postgresql|mysql|mssql)_.*', 'sql-database'),
    (r'aws_dynamodb_table|google_firestore_database|google_bigtable_instance|azurerm_cosmosdb_account', 'nosql-database'),
    (r'aws_elasticache_.*|google_redis_instance|azurerm_redis_cache|aws_memorydb_cluster', 'cache'),
    (r'aws_s3_bucket|google_storage_bucket|azurerm_storage_container', 'object-storage'),
    (r'aws_opensearch_domain|aws_elasticsearch_domain', 'search-index'),
    (r'aws_sqs_queue|azurerm_servicebus_queue', 'queue'),
    (r'aws_sns_topic|google_pubsub_topic|aws_cloudwatch_event_bus|azurerm_servicebus_topic|azurerm_eventgrid_topic', 'topic'),
    (r'aws_kinesis_stream|aws_msk_cluster|confluent_kafka_topic|azurerm_eventhub', 'stream'),
    (r'aws_lambda_function|google_cloudfunctions2?_function|azurerm_(linux_|windows_)?function_app', 'worker'),
    (
        r'aws_ecs_service|aws_apprunner_service|google_cloud_run_(v2_)?service|azurerm_container_app|aws_elastic_beanstalk_environment|kubernetes_deployment',
        'service',
    ),
    (
        r'aws_api_gateway_rest_api|aws_apigatewayv2_api|aws_lb|aws_alb|aws_cloudfront_distribution|google_compute_url_map|azurerm_application_gateway|azurerm_api_management',
        'gateway',
    ),
    (r'aws_cloudwatch_event_rule|aws_scheduler_schedule|google_cloud_scheduler_job', 'scheduler'),
    (r'aws_cognito_user_pool', 'external-system'),
]

ROUTE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ('js', re.compile(r'\b(?:app|router|server|api|routes|r|fastify|hono)\.(get|post|put|patch|delete|all)\(\s*[\'"`]([^\'"`]+)')),
    ('nest', re.compile(r'@(Get|Post|Put|Patch|Delete)\(\s*[\'"]?([^\'")]*)')),
    ('py', re.compile(r'@\w+(?:\.\w+)?\.(get|post|put|patch|delete|route|api_route)\(\s*[rf]?[\'"]([^\'"]+)')),
    ('django', re.compile(r'\b(?:re_)?path\(\s*r?[\'"]([^\'"]*)[\'"]')),
    ('spring', re.compile(r'@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"')),
    ('go', re.compile(r'\.(GET|POST|PUT|PATCH|DELETE|HandleFunc|Handle|Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"')),
    ('rails', re.compile(r'^\s*(get|post|put|patch|delete|resources?)\s+[\'":]([^\'",\s]+)')),
    ('dotnet', re.compile(r'\[Http(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"|\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"')),
    ('laravel', re.compile(r'Route::(get|post|put|patch|delete|resource)\(\s*[\'"]([^\'"]+)')),
]

MESSAGE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ('publish', re.compile(r'\.send\(\s*\{\s*topic\s*:\s*[\'"`]([^\'"`]+)')),
    ('publish', re.compile(r'\b(?:producer|kafka_producer|publisher)\.(?:produce|send|publish)\(\s*[\'"]([^\'"]+)')),
    ('publish', re.compile(r'kafkaTemplate\.send\(\s*"([^"]+)"')),
    ('consume', re.compile(r'@KafkaListener\([^)]*topics\s*=\s*\{?\s*"([^"]+)"')),
    ('consume', re.compile(r'@RabbitListener\([^)]*queues\s*=\s*\{?\s*"([^"]+)"')),
    ('consume', re.compile(r'\.subscribe\(\s*\{?\s*(?:topics?\s*:\s*)?\[?\s*[\'"`]([A-Za-z0-9._:/-]{3,})')),
    ('queue', re.compile(r'\bnew\s+(?:Queue|Worker|QueueEvents)\(\s*[\'"`]([^\'"`]+)')),
    ('queue', re.compile(r'\.(?:assertQueue|assertExchange|sendToQueue|bindQueue)\(\s*[\'"`]([^\'"`]+)')),
    ('publish', re.compile(r'basic_publish\([^)]*routing_key\s*=\s*[\'"]([^\'"]+)')),
    ('name', re.compile(r'\b(?:Exchange|Queue|Topic|Stream|Subject|Channel)Name\(\s*"([^"]+)"')),
    ('queue', re.compile(r'\.(?:QueueDeclare|ExchangeDeclare|QueueBind|DeclareQueue|DeclareExchange)\(\s*(?:ctx,\s*)?"([^"]+)"')),
    (
        'name',
        re.compile(
            r'\b(?:topic|queue|exchange|stream|channel)(?:Name|_name|Url|_url|Arn|_arn|Id)?\s*[:=]\s*[\'"`]([A-Za-z][A-Za-z0-9._:/-]{2,80})[\'"`]',
            re.I,
        ),
    ),
]

SCHEDULE_PATTERNS: list[re.Pattern] = [
    re.compile(r'@Scheduled\([^)]*(?:cron\s*=\s*"([^"]+)"|fixed(?:Rate|Delay)\s*=\s*(\w+))'),
    re.compile(r'\bcron\.schedule\(\s*[\'"`]([^\'"`]+)'),
    re.compile(r'\bcrontab\(([^)]*)\)'),
    re.compile(r'\bnew\s+CronJob\(\s*[\'"`]([^\'"`]+)'),
    re.compile(r'\.(?:repeat|every)\(\s*\{?\s*(?:pattern|cron)\s*:\s*[\'"`]([^\'"`]+)'),
    re.compile(r'^\s*schedule:\s*[\'"]?([0-9*/,\- ]{9,})[\'"]?\s*$'),
    re.compile(r'add_job\([^)]*(?:trigger\s*=\s*)?[\'"](cron|interval)[\'"]'),
]

ENV_IN_CODE = re.compile(
    r'process\.env\.([A-Z][A-Z0-9_]{2,})|process\.env\[[\'"]([A-Z][A-Z0-9_]{2,})|os\.environ(?:\.get)?[\[(]\s*[\'"]([A-Z][A-Z0-9_]{2,})'
    r'|os\.getenv\(\s*[\'"]([A-Z][A-Z0-9_]{2,})|System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})|env::var\(\s*"([A-Z][A-Z0-9_]{2,})'
    r'|ENV\[[\'"]([A-Z][A-Z0-9_]{2,})|import\.meta\.env\.([A-Z][A-Z0-9_]{2,})|getenv\(\s*"([A-Z][A-Z0-9_]{2,})"'
)

ENTRY_NAMES = re.compile(
    r'(^|/)(main\.(go|py|rs|kt|java|ts|tsx|js|jsx|dart)|cmd/[^/]+/main\.go|server\.(ts|js|mjs|py)|app\.(py|ts|js)|index\.(ts|js|mjs)'
    r'|manage\.py|wsgi\.py|asgi\.py|Program\.cs|Startup\.cs|[A-Z]\w*Application\.(java|kt)|application\.(ts|js)'
    r'|worker\.(ts|js|py)|celery\.py|config/routes\.rb|routes/(web|api)\.php|urls\.py|lib/main\.dart|bin/[^/]+)$'
)

DOC_NAMES = re.compile(
    r'(^|/)(README(\.\w+)?|ARCHITECTURE(\.\w+)?|DESIGN(\.\w+)?|CONTRIBUTING\.md)$|(^|/)(docs?|documentation)/.*(architecture|design|overview|adr|decision|system)[^/]*\.(md|mdx|adoc|rst|txt)$'
    r'|(^|/)(adr|adrs|decisions|architecture)/[^/]+\.(md|mdx|adoc|rst)$|\.(dsl|puml|plantuml|c4)$|(^|/)workspace\.dsl$',
    re.I,
)


def compiled(table: list[tuple[str, str]]) -> list[tuple[re.Pattern, str]]:
    return [(re.compile(pattern), key) for pattern, key in table]


DEP_SIGNALS, IMAGE_SIGNALS, ENV_SIGNALS, TF_SIGNALS = (compiled(t) for t in (DEP_SIGNALS, IMAGE_SIGNALS, ENV_SIGNALS, TF_SIGNALS))
FRAMEWORKS = [(re.compile(pattern), name, role) for pattern, name, role in FRAMEWORKS]


def match_key(name: str, signals: list[tuple[re.Pattern, str]]) -> str | None:
    """The key of the first signal whose pattern matches all of `name`."""
    for pattern, key in signals:
        if pattern.fullmatch(name):
            return key
    return None


# --- Files -------------------------------------------------------------------------------------


def list_files(root: str, max_files: int) -> tuple[list[str], bool]:
    """Repository-relative paths, git's view when available; True when the list was cut short."""
    files: list[str] = []
    from_git = False
    try:
        out = subprocess.run(
            ['git', '-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
            capture_output=True,
            timeout=30,
            check=True,
        ).stdout.decode('utf-8', 'replace')
        files = [f for f in out.split('\0') if f]
        from_git = True
    except (OSError, subprocess.SubprocessError):
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith('.')]
            rel_dir = os.path.relpath(dirpath, root)
            for name in filenames:
                files.append(name if rel_dir == '.' else os.path.join(rel_dir, name).replace(os.sep, '/'))
                if len(files) > max_files:
                    # Stop the entire walk, rather than collecting one more file in every directory.
                    return sorted(files[:max_files]), True
    # Git already leaves out what is ignored, so a committed build/ or out/ folder is source (deploy
    # manifests, say) and is kept; only vendored dependencies and CI configuration still go.
    skip = COMMITTED_SKIP_DIRS if from_git else SKIP_DIRS
    kept = []
    for f in files:
        parts = f.split('/')
        if any(p in skip for p in parts[:-1]):
            continue
        kept.append(f)
    kept.sort()
    truncated = len(kept) > max_files
    return kept[:max_files], truncated


def read_text(root: str, rel: str) -> str | None:
    path = os.path.join(root, rel)
    try:
        if os.path.islink(path) or os.path.getsize(path) > MAX_READ:
            return None
        with open(path, 'rb') as fh:
            data = fh.read(MAX_READ + 1)
            if len(data) > MAX_READ:
                return None
    except OSError:
        return None
    if b'\0' in data[:4096]:
        return None
    return data.decode('utf-8', 'replace')


def git_commit(root: str) -> str | None:
    try:
        return (
            subprocess.run(['git', '-C', root, 'rev-parse', '--short', 'HEAD'], capture_output=True, timeout=10, check=True)
            .stdout.decode()
            .strip()
            or None
        )
    except (OSError, subprocess.SubprocessError):
        return None


# --- Manifests ---------------------------------------------------------------------------------

MANIFESTS = re.compile(
    r'(^|/)(package\.json|pyproject\.toml|requirements(-\w+)?\.txt|Pipfile|setup\.py|setup\.cfg|go\.mod|pom\.xml'
    r'|build\.gradle(\.kts)?|Cargo\.toml|Gemfile|composer\.json|[^/]+\.csproj|pubspec\.yaml|mix\.exs|deno\.jsonc?)$'
)


def section(text: str, header: str) -> str:
    """The body of one `[header]` table in a TOML/INI file, without parsing the rest."""
    m = re.search(r'^\[' + re.escape(header) + r'\]\s*$(.*?)(?=^\[|\Z)', text, re.M | re.S)
    return m.group(1) if m else ''


def parse_manifest(rel: str, text: str) -> dict | None:
    """{name, language, deps, workspace_root, entry_hint} — or None for a file that names no unit."""
    base = rel.rsplit('/', 1)[-1]
    deps: list[str] = []
    name = None
    lang = None
    workspace_root = False
    scripts: dict[str, str] = {}
    if base == 'package.json' or base.startswith('deno.json'):
        try:
            data = json.loads(text)
        except ValueError:
            return None
        if not isinstance(data, dict):
            return None
        name = data.get('name')
        for key in ('dependencies', 'optionalDependencies', 'peerDependencies'):
            if isinstance(data.get(key), dict):
                deps.extend(data[key].keys())
        dev = list(data['devDependencies'].keys()) if isinstance(data.get('devDependencies'), dict) else []
        # Frameworks often sit in devDependencies of a front end (vite, react…); keep them for role only.
        deps.extend('dev:' + d for d in dev)
        # A monorepo's root: it declares workspaces, or is a private top-level package with no dependencies.
        workspace_root = bool(data.get('workspaces')) or ('/' not in rel and bool(data.get('private')) and not data.get('dependencies'))
        scripts = data.get('scripts') if isinstance(data.get('scripts'), dict) else {}
        lang = 'TypeScript/JavaScript'
    elif base == 'pyproject.toml':
        lang = 'Python'
        m = re.search(r'^\s*name\s*=\s*[\'"]([^\'"]+)', section(text, 'project') or section(text, 'tool.poetry'), re.M)
        name = m.group(1) if m else None
        # Brackets inside the strings ("fastapi[standard]") don't end the array.
        arr = re.search(r'^\s*dependencies\s*=\s*\[((?:[^\]"\']|"[^"]*"|\'[^\']*\')*)\]', section(text, 'project'), re.M | re.S)
        if arr:
            deps.extend(re.findall(r'[\'"]\s*([A-Za-z0-9_.\-\[\]]+)', arr.group(1)))
        for header in ('tool.poetry.dependencies', 'tool.poetry.group.main.dependencies'):
            deps.extend(re.findall(r'^\s*([A-Za-z0-9_.-]+)\s*=', section(text, header), re.M))
        if '[tool.uv.workspace]' in text and not section(text, 'project'):
            workspace_root = True
    elif base.startswith('requirements'):
        lang = 'Python'
        if '-dev' in base or '-test' in base or 'dev' in base.split('.')[0][12:]:
            return None
        # A pip-compile lock says why each pin is there: `# via -r requirements.in` is a direct
        # dependency, `# via some-package` a transitive one, which says nothing about what the code calls
        # (google-cloud-storage pulled in by a vector-store library once drew a bucket nobody used).
        compiled = re.search(r'^\s*#\s+via\b', text, re.M) is not None
        pending: str | None = None
        for raw in text.splitlines() + ['']:
            line = raw.strip()
            if compiled and pending is not None and line.startswith('#'):
                if re.search(r'(?:^#\s+via|^#)\s+-[rc]\s', line):
                    deps.append(pending)
                    pending = None
                continue
            pending = None
            if line and not line.startswith(('#', '-')):
                dep = re.split(r'[<>=!~;\s\[]', line, maxsplit=1)[0]
                if compiled:
                    pending = dep
                else:
                    deps.append(dep)
    elif base == 'Pipfile':
        lang = 'Python'
        deps.extend(re.findall(r'^\s*([A-Za-z0-9_.-]+)\s*=', section(text, 'packages'), re.M))
    elif base in ('setup.py', 'setup.cfg'):
        lang = 'Python'
        m = re.search(r'install_requires\s*=\s*\[(.*?)\]', text, re.S)
        if m:
            deps.extend(re.findall(r'[\'"]\s*([A-Za-z0-9_.-]+)', m.group(1)))
        m = re.search(r'name\s*=\s*[\'"]?([A-Za-z0-9_.-]+)', text)
        name = m.group(1) if m else None
    elif base == 'go.mod':
        lang = 'Go'
        m = re.search(r'^module\s+(\S+)', text, re.M)
        name = m.group(1).rsplit('/', 1)[-1] if m else None
        # `// indirect` requirements are other modules' dependencies, not calls this code makes.
        deps.extend(re.findall(r'^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}/[^\s]+)\s+v[^\s]*\s*$', text, re.M))
    elif base == 'pom.xml':
        lang = 'Java/Kotlin'
        body = re.sub(r'<parent>.*?</parent>', '', text, flags=re.S)
        body = re.sub(r'<dependencyManagement>.*?</dependencyManagement>', '', body, flags=re.S)
        body = re.sub(r'<build>.*?</build>', '', body, flags=re.S)
        m = re.search(r'<artifactId>([^<]+)</artifactId>', body)
        name = m.group(1) if m else None
        for g, a in re.findall(r'<dependency>\s*<groupId>([^<]+)</groupId>\s*<artifactId>([^<]+)</artifactId>', body, re.S):
            deps.append(f'{g.strip()}:{a.strip()}')
        workspace_root = '<packaging>pom</packaging>' in body
    elif base.startswith('build.gradle'):
        lang = 'Java/Kotlin'
        for g, a in re.findall(r'(?:implementation|api|compile|runtimeOnly|compileOnly)\s*\(?\s*[\'"]([^:\'"]+):([^:\'"]+)', text):
            deps.append(f'{g}:{a}')
    elif base == 'Cargo.toml':
        lang = 'Rust'
        m = re.search(r'^\s*name\s*=\s*"([^"]+)"', section(text, 'package'), re.M)
        name = m.group(1) if m else None
        deps.extend(re.findall(r'^\s*([A-Za-z0-9_-]+)\s*=', section(text, 'dependencies'), re.M))
        workspace_root = not section(text, 'package') and '[workspace]' in text
    elif base == 'Gemfile':
        lang = 'Ruby'
        deps.extend(re.findall(r'^\s*gem\s+[\'"]([^\'"]+)', text, re.M))
    elif base == 'composer.json':
        lang = 'PHP'
        try:
            data = json.loads(text)
            name = data.get('name')
            deps.extend((data.get('require') or {}).keys())
        except (ValueError, AttributeError):
            return None
    elif base.endswith('.csproj'):
        lang = 'C#'
        name = base[:-7]
        deps.extend(re.findall(r'<PackageReference\s+Include="([^"]+)"', text))
        if 'Microsoft.NET.Sdk.Web' in text:
            deps.append('microsoft.aspnetcore')
    elif base == 'pubspec.yaml':
        lang = 'Dart'
        m = re.search(r'^name:\s*(\S+)', text, re.M)
        name = m.group(1) if m else None
        block = re.search(r'^dependencies:\s*$(.*?)(?=^\S|\Z)', text, re.M | re.S)
        if block:
            deps.extend(re.findall(r'^\s{2}([a-z0-9_]+):', block.group(1), re.M))
        deps.append('flutter' if 'flutter:' in text else '')
    elif base == 'mix.exs':
        lang = 'Elixir'
        deps.extend(re.findall(r'\{:([a-z0-9_]+),', text))
    # `fastapi[standard]`, `psycopg[binary]`: the extras don't change what the dependency is.
    clean = [re.sub(r'\[.*?\]', '', d).strip().lower() for d in deps if d]
    return {'name': name, 'language': lang, 'deps': [d for d in clean if d], 'workspace_root': workspace_root, 'scripts': scripts}


# --- Compose, Kubernetes, Terraform, serverless ------------------------------------------------


def parse_compose(text: str) -> dict[str, dict]:
    """services → {image, build, ports, depends_on, env} without a YAML library (PyYAML when present)."""
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
        out = {}
        for name, svc in ((data or {}).get('services') or {}).items():
            svc = svc or {}
            env = svc.get('environment') or []
            env_names = list(env.keys()) if isinstance(env, dict) else [str(e).split('=', 1)[0] for e in env]
            deps = svc.get('depends_on') or []
            build = svc.get('build')
            out[str(name)] = {
                'image': svc.get('image'),
                'build': build.get('context') if isinstance(build, dict) else build,
                'ports': [str(p) for p in (svc.get('ports') or [])],
                'depends_on': list(deps.keys()) if isinstance(deps, dict) else [str(d) for d in deps],
                'env': env_names,
            }
        return out
    except Exception:  # noqa: BLE001 — no PyYAML, or a file it can't read: fall back to the line reader
        pass
    services: dict[str, dict] = {}
    lines = text.splitlines()
    in_services = False
    svc_indent = None
    current = None
    key = None
    key_indent = 0
    child_indent = None
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith('#'):
            continue
        indent = len(raw) - len(raw.lstrip(' '))
        line = raw.strip()
        if indent == 0:
            in_services = line.startswith('services:')
            current = None
            continue
        if not in_services:
            continue
        if svc_indent is None:
            svc_indent = indent
        if indent == svc_indent and line.endswith(':'):
            current = line[:-1].strip('\'"')
            services[current] = {'image': None, 'build': None, 'ports': [], 'depends_on': [], 'env': []}
            key = None
            continue
        if current is None:
            continue
        svc = services[current]
        m = re.match(r'([A-Za-z_]+):\s*(.*)$', line)
        if m and (key is None or indent <= key_indent):
            key, value = m.group(1), m.group(2).strip().strip('\'"')
            key_indent = indent
            child_indent = None
            if key == 'image':
                svc['image'] = value
            elif (key == 'build' and value) or (key == 'context' and svc['build'] is None):
                svc['build'] = value
            elif key in ('depends_on', 'ports', 'environment') and value.startswith('['):
                items = [v.strip().strip('\'"') for v in value.strip('[]').split(',') if v.strip()]
                svc[{'environment': 'env'}.get(key, key)].extend(i.split('=', 1)[0] if key == 'environment' else i for i in items)
            continue
        if key in ('depends_on', 'ports', 'environment'):
            child_indent = indent if child_indent is None else child_indent
            if indent > child_indent:
                continue  # `condition: service_healthy` under a long-form depends_on entry
            target = {'environment': 'env'}.get(key, key)
            if line.startswith('- '):
                item = line[2:].strip().strip('\'"')
                svc[target].append(item.split('=', 1)[0] if key == 'environment' else item)
            elif ':' in line and key in ('environment', 'depends_on'):
                svc[target].append(line.split(':', 1)[0].strip().strip('\'"'))
        elif key == 'build' and line.startswith('context:'):
            svc['build'] = line.split(':', 1)[1].strip()
    return services


K8S_KIND = re.compile(
    r'^kind:\s*(Deployment|StatefulSet|DaemonSet|CronJob|Job|Service|Ingress|HTTPRoute|Gateway|KafkaTopic|Rollout|KnativeService)\s*$', re.M
)
#: Each line under `metadata:` is either indented content or blank, never both: with `\s+.*\n` a run
#: of blank lines could be split many ways and a manifest without a name backtracked exponentially.
K8S_NAME = re.compile(r'^metadata:[ \t]*\r?\n(?:[ \t]+\S.*\n|[ \t]*\r?\n)*?[ \t]+name:[ \t]*[\'"]?([^\s\'"]+)', re.M)


def parse_k8s(text: str) -> list[tuple[str, str, str | None]]:
    out = []
    for doc in re.split(r'^---\s*$', text, flags=re.M):
        kind = K8S_KIND.search(doc)
        if not kind:
            continue
        name = K8S_NAME.search(doc)
        image = re.search(r'^\s+image:\s*[\'"]?([^\s\'"]+)', doc, re.M)
        schedule = re.search(r'^\s+schedule:\s*[\'"]?([^\'"\n]+)', doc, re.M)
        out.append(
            (
                kind.group(1),
                name.group(1) if name else '?',
                (image.group(1) if image else None) or (schedule.group(1).strip() if schedule else None),
            )
        )
    return out


def parse_terraform(text: str) -> list[tuple[str, str]]:
    return re.findall(r'^\s*resource\s+"([a-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"', text, re.M)


def parse_serverless(text: str) -> list[tuple[str, list[str]]]:
    """functions with their event kinds, from serverless.yml (line reader) or SAM template.yaml."""
    out = []
    block = re.search(r'^functions:\s*$(.*?)(?=^\S|\Z)', text, re.M | re.S)
    if block:
        current = None
        events: list[str] = []
        for line in block.group(1).splitlines():
            m = re.match(r'^  ([A-Za-z0-9_-]+):\s*$', line)
            if m:
                if current:
                    out.append((current, events))
                current, events = m.group(1), []
                continue
            e = re.match(r'^\s+- (http|httpApi|sqs|sns|schedule|stream|s3|eventBridge|kafka|websocket|alb)\b', line)
            if e:
                events.append(e.group(1))
        if current:
            out.append((current, events))
    for name, body in re.findall(r'^  ([A-Za-z0-9]+):\s*\n\s+Type:\s*AWS::Serverless::Function(.*?)(?=^  \S|\Z)', text, re.M | re.S):
        out.append((name, sorted(set(re.findall(r'Type:\s*(Api|HttpApi|SQS|SNS|Schedule|S3|Kinesis|EventBridgeRule|DynamoDB)', body)))))
    return out


# --- The survey --------------------------------------------------------------------------------


class Survey:
    def __init__(self, root: str):
        self.root = root
        self.units: dict[str, dict] = {}
        self.ignored_units: list[str] = []
        self.signals: dict[str, dict] = {}
        self.compose: dict[str, dict[str, dict]] = {}
        self.k8s: list[dict] = []
        self.terraform: list[dict] = []
        self.serverless: list[dict] = []
        self.dockerfiles: list[dict] = []
        self.routes: dict[str, list[dict]] = defaultdict(list)
        self.route_counts: Counter = Counter()
        self.route_files: Counter = Counter()
        self.messages: list[dict] = []
        self.schedules: list[dict] = []
        self.contracts: list[dict] = []
        self.docs: list[str] = []
        self.doc_sizes: dict[str, int] = {}
        self.exchange_kinds: list[dict] = []
        self.nomad: list[dict] = []
        self.diagrams: list[str] = []
        self.entries: dict[str, list[str]] = defaultdict(list)
        self.env_names: dict[str, set] = defaultdict(set)
        self.languages: Counter = Counter()
        self.message_files: Counter = Counter()
        self.code_capped = False

    def add_route(self, unit: str, rel: str | None, method: str, path: str, at: str) -> None:
        self.route_counts[unit] += 1
        if rel:
            self.route_files[rel] += 1
        if len(self.routes[unit]) < 10:
            self.routes[unit].append({'method': method, 'path': path, 'at': at})

    def unit_of(self, rel: str) -> str:
        best = ''
        for path in self.units:
            if (path == '' or rel == path or rel.startswith(path + '/')) and len(path) >= len(best):
                best = path
        return best if best in self.units else '(root)'

    def note_signal(self, key: str, where: str):
        if key not in KNOWN:
            if key == 'localstack':
                self.signals.setdefault(
                    'localstack', {'name': 'LocalStack (AWS emulation in dev)', 'type': '-', 'category': 'dev', 'where': set()}
                )['where'].add(where)
            return
        name, typ, cat = KNOWN[key]
        entry = self.signals.setdefault(key, {'name': name, 'type': typ, 'category': cat, 'where': set()})
        entry['where'].add(where)


#: How many source files are read for routes, messaging and settings; past it the survey says so.
MAX_CODE_FILES = 6000

COMPOSE_FILE = re.compile(r'(^|/)(docker-)?compose[\w.-]*\.ya?ml$', re.I)
TEST_FILE = re.compile(r'(\.|_)(test|spec)\.\w+$|_test\.go$|Test\.(java|kt)$')
WORKLOAD_KIND = re.compile(r'^kind:\s*(Deployment|StatefulSet|DaemonSet|CronJob|Job|Rollout)\s*$', re.M)
FILE_ROUTES = re.compile(r'(^|/)(app|pages)/(.*?)(/route|/page)?\.(ts|tsx|js|jsx)$')
#: Committed environment templates (.env.example, .env.sample…): names only. A real .env is never read.
ENV_TEMPLATE = re.compile(r'(^|/)\.env\.(example|sample|template|dist|defaults)$', re.I)


def in_non_unit_dir(rel: str) -> bool:
    return any(part in NON_UNIT_DIRS for part in rel.split('/')[:-1])


def survey(root: str, max_files: int) -> dict:
    files, truncated = list_files(root, max_files)
    s = Survey(root)
    collect_units(s, files)
    code_read = 0
    for rel in files:
        lang = LANGUAGES.get(os.path.splitext(rel)[1].lower())
        if lang:
            s.languages[lang] += 1
        note_layout(s, rel)
        if scan_config(s, rel):
            continue
        if is_code(rel):
            if code_read >= MAX_CODE_FILES:
                s.code_capped = True
                continue
            text = read_text(root, rel)
            if text:
                code_read += 1
                scan_code(s, rel, s.unit_of(rel), text, os.path.splitext(rel)[1].lower())
    scan_file_routes(s, files)
    for origin, names in sorted(s.env_names.items()):
        where = origin_file(s, origin)
        for env in sorted(names):
            key = match_key(env, ENV_SIGNALS)
            if key:
                s.note_signal(key, f'env {env} in {where}' if where else f'env {env}')
    for unit in s.units.values():
        for dep in unit['deps']:
            key = None if dep.startswith('dev:') else match_key(dep, DEP_SIGNALS)
            if key:
                s.note_signal(key, f'{unit["path"]} (dep {dep})')
    return render_data(s, files, truncated)


def origin_file(s: Survey, origin: str) -> str | None:
    """The file a group of setting names was read from, for citing it: a template, a compose file or
    manifest naming the service, a program's main file, or a unit's manifest."""
    if origin.startswith('compose:'):
        name = origin.split(':', 1)[1]
        found = next((file for file, services in s.compose.items() if name in services), None)
        return found or next((k['file'] for k in s.k8s if k['name'] == name), None)
    if origin.startswith('program:'):
        program = origin.split(':', 1)[1]
        return next((e for entries in s.entries.values() for e in entries if e.endswith(f'cmd/{program}/main.go')), None)
    if origin in s.units:
        return s.units[origin]['manifests'][0] if s.units[origin]['manifests'] else None
    return origin if origin and origin != '(root)' else None


def collect_units(s: Survey, files: list[str]) -> None:
    """One unit per folder holding a manifest, shallowest first, so later findings attribute to the
    nearest one."""
    for rel in sorted((f for f in files if MANIFESTS.search(f)), key=lambda p: p.count('/')):
        text = read_text(s.root, rel)
        info = parse_manifest(rel, text) if text is not None else None
        if not info:
            continue
        unit_dir = rel.rsplit('/', 1)[0] if '/' in rel else ''
        if in_non_unit_dir(rel):
            s.ignored_units.append(unit_dir)
            continue
        unit = s.units.setdefault(
            unit_dir,
            {
                'path': unit_dir or '.',
                'name': None,
                'languages': set(),
                'deps': set(),
                'manifests': [],
                'workspace_root': False,
                'scripts': {},
            },
        )
        unit['name'] = unit['name'] or info['name']
        if info['language']:
            unit['languages'].add(info['language'])
        unit['deps'].update(info['deps'])
        unit['manifests'].append(rel)
        unit['workspace_root'] = unit['workspace_root'] or info['workspace_root']
        unit['scripts'].update(info['scripts'] or {})


def note_layout(s: Survey, rel: str) -> None:
    """Diagrams, docs and entry points: where to look, not what the system is."""
    if rel.endswith('.draftcanvas'):
        if not in_non_unit_dir(rel):
            s.diagrams.append(rel)
        return
    if DOC_NAMES.search(rel) and rel.count('/') <= 4:
        try:
            size = os.path.getsize(os.path.join(s.root, rel))
        except OSError:
            size = 0
        # A placeholder README ("TBD") is no reason to spend a read.
        if size >= 120:
            s.docs.append(rel)
            s.doc_sizes[rel] = size
    if ENTRY_NAMES.search(rel) and not in_non_unit_dir(rel):
        unit = s.unit_of(rel)
        inner = rel[len(unit) + 1 :] if unit not in ('', '(root)') else rel
        # An entry point sits at the unit's top, in src/ or app/, or under cmd/ or bin/ — an index.ts
        # deep in the tree is a barrel file, not where the program starts.
        if inner.count('/') <= 1 or re.match(r'(src|app|cmd|bin|lib)/[^/]+(/main\.go)?$', inner) or inner.startswith('config/'):
            s.entries[unit].append(rel)


def scan_config(s: Survey, rel: str) -> bool:
    """Reads `rel` if it is configuration (a Dockerfile, compose, Kubernetes, Nomad, Terraform,
    contracts, an environment template). True when it was, so it isn't read again as code."""
    base = rel.rsplit('/', 1)[-1]
    lower = rel.lower()
    ext = os.path.splitext(lower)[1]
    if base == 'Dockerfile' or base.startswith('Dockerfile.') or base.endswith('.Dockerfile'):
        scan_dockerfile(s, rel)
    elif COMPOSE_FILE.search(lower):
        scan_compose(s, rel)
    elif ext in ('.yaml', '.yml'):
        scan_yaml(s, rel)
    elif lower.endswith(('.nomad', '.nomad.hcl')):
        scan_nomad(s, rel, read_text(s.root, rel) or '')
    elif ext == '.hcl':
        text = read_text(s.root, rel) or ''
        if re.search(r'^\s*job\s+"', text, re.M):
            scan_nomad(s, rel, text)
    elif ext == '.tf':
        for rtype, rname in parse_terraform(read_text(s.root, rel) or ''):
            typ = match_key(rtype, TF_SIGNALS)
            if typ:
                s.terraform.append({'file': rel, 'resource': rtype, 'name': rname, 'type': typ})
    elif ext == '.proto':
        scan_proto(s, rel)
    elif ext in ('.graphql', '.gql'):
        ops = re.findall(r'type\s+(Query|Mutation|Subscription)\s*\{', read_text(s.root, rel) or '')
        if ops:
            s.contracts.append({'kind': 'GraphQL', 'path': rel, 'detail': ', '.join(sorted(set(ops)))})
    elif ENV_TEMPLATE.search(rel):
        for env in re.findall(r'^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=', read_text(s.root, rel) or '', re.M):
            s.env_names[rel].add(env)
    else:
        return False
    return True


def is_code(rel: str) -> bool:
    base = rel.rsplit('/', 1)[-1]
    return (
        os.path.splitext(base)[1].lower() in CODE_EXTS
        and not in_non_unit_dir(rel)
        and not TEST_FILE.search(base)
        and not TOOLING_FILE.search(base)
    )


def scan_dockerfile(s: Survey, rel: str) -> None:
    text = read_text(s.root, rel) or ''
    froms = re.findall(r'^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)', text, re.M | re.I)
    ports = re.findall(r'^\s*EXPOSE\s+(.+)$', text, re.M | re.I)
    s.dockerfiles.append({'path': rel, 'unit': s.unit_of(rel), 'from': froms[-1] if froms else None, 'expose': ' '.join(ports).split()})


def scan_compose(s: Survey, rel: str) -> None:
    services = parse_compose(read_text(s.root, rel) or '')
    if not services:
        return
    s.compose[rel] = services
    for name, svc in services.items():
        image = (svc.get('image') or '').split(':', 1)[0].lower()
        key = match_key(image, IMAGE_SIGNALS) if image else None
        if key:
            s.note_signal(key, f'{rel}:{name}')
        for env in svc.get('env') or []:
            s.env_names[f'compose:{name}'].add(env)


def scan_yaml(s: Survey, rel: str) -> None:
    text = read_text(s.root, rel)
    if not text:
        return
    base = rel.rsplit('/', 1)[-1]
    if base in ('serverless.yml', 'serverless.yaml') or 'AWS::Serverless::Function' in text:
        s.serverless.extend({'file': rel, 'function': name, 'events': events} for name, events in parse_serverless(text))
        return
    if re.search(r'^\s*(openapi|swagger):\s*[\'"]?\d', text, re.M):
        paths = len(re.findall(r'^  /[^\s:]*:\s*$', text, re.M))
        s.contracts.append({'kind': 'OpenAPI', 'path': rel, 'detail': f'{paths} paths'})
        return
    if re.search(r'^asyncapi:\s', text, re.M):
        block = re.search(r'^channels:\s*$(.*?)(?=^\S|\Z)', text, re.M | re.S)
        channels = re.findall(r'^  ([A-Za-z0-9._/{}-]+):\s*$', block.group(1), re.M) if block else []
        s.contracts.append({'kind': 'AsyncAPI', 'path': rel, 'detail': ', '.join(channels[:8])})
        return
    if 'apiVersion:' in text and 'kind:' in text:
        scan_k8s(s, rel, text)
    if base == 'Chart.yaml':
        m = re.search(r'^name:\s*(\S+)', text, re.M)
        s.k8s.append({'file': rel, 'kind': 'HelmChart', 'name': m.group(1) if m else '?', 'detail': None})


def scan_k8s(s: Survey, rel: str, text: str) -> None:
    for kind, name, extra in parse_k8s(text):
        if '{{' in name:
            continue  # a Helm template; the rendered manifests or the chart say the same
        s.k8s.append({'file': rel, 'kind': kind, 'name': name, 'detail': extra})
        if extra and kind in ('Deployment', 'StatefulSet'):
            key = match_key(extra.split(':', 1)[0].lower(), IMAGE_SIGNALS)
            if key:
                s.note_signal(key, f'{rel}:{name}')
    # Environment names per workload, so CART_SERVICE_ADDR in the frontend's Deployment reads as
    # frontend → cartservice.
    for doc in re.split(r'^---\s*$', text, flags=re.M):
        owner = K8S_NAME.search(doc) if WORKLOAD_KIND.search(doc) else None
        if owner and '{{' not in owner.group(1):
            s.env_names[f'compose:{owner.group(1)}'].update(re.findall(r'-\s*name:\s*([A-Z][A-Z0-9_]{2,})\s*$', doc, re.M))


def scan_nomad(s: Survey, rel: str, text: str) -> None:
    job = re.search(r'^\s*job\s+"([^"]+)"', text, re.M)
    tasks = re.findall(r'^\s*task\s+"([^"]+)"\s*\{(.*?)^\s*\}', text, re.M | re.S)
    for task, body in tasks:
        image = re.search(r'image\s*=\s*"([^"]+)"', body)
        s.nomad.append({'file': rel, 'job': job.group(1) if job else '?', 'task': task, 'image': image.group(1) if image else None})
        key = match_key(image.group(1).split(':', 1)[0].lower(), IMAGE_SIGNALS) if image else None
        if key:
            s.note_signal(key, f'{rel}:{task}')
    if job and not tasks:
        s.nomad.append({'file': rel, 'job': job.group(1), 'task': None, 'image': None})


def scan_proto(s: Survey, rel: str) -> None:
    text = read_text(s.root, rel) or ''
    unit = s.unit_of(rel)
    # grpc-gateway / Google API annotations: the HTTP routes a gateway exposes for these RPCs.
    for m in re.finditer(r'\b(get|post|put|patch|delete)\s*:\s*"([^"]+)"', text):
        s.add_route(unit, rel, m.group(1).upper(), m.group(2), f'{rel}:{line_of(text, m.start())}')
    for svc, body in re.findall(r'service\s+(\w+)\s*\{(.*?)\n\}', text, re.S):
        rpcs = re.findall(r'rpc\s+(\w+)', body)
        s.contracts.append({'kind': 'gRPC', 'path': rel, 'detail': f'{svc}: ' + ', '.join(rpcs[:8]) + (' …' if len(rpcs) > 8 else '')})


def scan_file_routes(s: Survey, files: list[str]) -> None:
    """Next.js-style routing, where the file's path is the route."""
    for rel in files:
        m = FILE_ROUTES.search(rel)
        if m and (m.group(4) == '/route' or '/api/' in '/' + m.group(3) + '/'):
            path = '/' + re.sub(r'(^|/)(index|route)$', '', m.group(3)).replace('(', '').replace(')', '')
            s.add_route(s.unit_of(rel), None, 'ANY', path, rel)


def line_of(text: str, pos: int) -> int:
    return text.count('\n', 0, pos) + 1


JS_EXTS = ('.ts', '.js', '.mjs', '.cjs', '.mts', '.tsx', '.jsx')
#: Which route patterns apply to which files: (pattern kind, applies to (rel, ext, text)).
ROUTE_APPLIES = {
    'js': lambda rel, ext, text: ext in JS_EXTS,
    'nest': lambda rel, ext, text: '@Controller' in text,
    'py': lambda rel, ext, text: ext == '.py',
    'django': lambda rel, ext, text: rel.endswith('urls.py'),
    'spring': lambda rel, ext, text: ext in ('.java', '.kt'),
    'go': lambda rel, ext, text: ext == '.go',
    'rails': lambda rel, ext, text: rel.endswith('routes.rb'),
    'dotnet': lambda rel, ext, text: ext == '.cs',
    'laravel': lambda rel, ext, text: ext == '.php',
}
AWS_JS_CLIENTS = {
    'S3': 's3',
    'SQS': 'sqs',
    'SNS': 'sns',
    'DynamoDB': 'dynamodb',
    'Kinesis': 'kinesis',
    'SES': 'ses',
    'EventBridge': 'eventbridge',
}
AWS_PY_CLIENTS = {
    's3': 's3',
    'sqs': 'sqs',
    'sns': 'sns',
    'dynamodb': 'dynamodb',
    'kinesis': 'kinesis',
    'ses': 'ses',
    'sesv2': 'ses',
    'events': 'eventbridge',
    'cognito-idp': 'cognito',
}
ADDRESS_NAME = re.compile(r'["\']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:ADDR|ADDRESS|URL|URI|HOST|ENDPOINT))["\']')


def scan_code(s: Survey, rel: str, unit: str, text: str, ext: str) -> None:
    # One module can build several programs (Go's cmd/<name>/main.go): code under cmd/<name>/ speaks
    # for that program, not for the module as a whole.
    program = re.search(r'(?:^|/)cmd/([^/]+)/', rel)
    owner = program.group(1) if program else unit
    env_key = f'program:{program.group(1)}' if program else unit
    scan_routes(s, rel, unit, text, ext)
    if any(word in text for word in ('topic', 'Topic', 'queue', 'Queue', 'publish', 'subscribe', 'Listener', 'exchange', 'stream')):
        scan_messaging(s, rel, owner, text)
    scan_exchange_kinds(s, rel, text)
    if any(word in text for word in ('cron', 'Cron', 'Scheduled', 'schedule', 'crontab', 'repeat')):
        for pattern in SCHEDULE_PATTERNS:
            for m in pattern.finditer(text):
                if len(s.schedules) >= 30:
                    break
                expr = next((g for g in m.groups() if g), m.group(0))
                s.schedules.append({'expr': expr.strip()[:60], 'unit': unit, 'at': f'{rel}:{line_of(text, m.start())}'})
    for m in ENV_IN_CODE.finditer(text):
        name = next((g for g in m.groups() if g), None)
        if name:
            s.env_names[env_key].add(name)
    # Address-shaped names read through a project's own helper (mustMapEnv(&x, "CART_SERVICE_ADDR")).
    s.env_names[env_key].update(ADDRESS_NAME.findall(text))
    # boto3 and the v2 JavaScript SDK reach every AWS service through one dependency: name the ones used.
    if ext == '.py' and 'boto3' in text:
        for client in re.findall(r'\.(?:client|resource)\(\s*[\'"]([a-z0-9-]+)[\'"]', text):
            if client in AWS_PY_CLIENTS:
                s.note_signal(AWS_PY_CLIENTS[client], f'{rel} (boto3 {client})')
    if ext in JS_EXTS and ("from 'aws-sdk'" in text or "require('aws-sdk')" in text):
        for client in re.findall(r'new\s+(?:AWS\.)?(S3|SQS|SNS|DynamoDB|Kinesis|SES|EventBridge)\(', text):
            s.note_signal(AWS_JS_CLIENTS[client], f'{rel} (aws-sdk {client})')


def scan_routes(s: Survey, rel: str, unit: str, text: str, ext: str) -> None:
    for kind, pattern in ROUTE_PATTERNS:
        if not ROUTE_APPLIES[kind](rel, ext, text):
            continue
        for m in pattern.finditer(text):
            groups = [g for g in m.groups() if g is not None]
            if len(groups) < 2:
                continue
            method, path = groups[0].upper(), groups[1]
            if kind == 'go' and not (path.startswith('/') or re.match(r'^(GET|POST|PUT|PATCH|DELETE) /', path)):
                continue
            if kind == 'js' and not path.startswith('/'):
                continue
            if kind == 'nest':
                prefix = re.search(r'@Controller\(\s*[\'"]?([^\'")]*)', text)
                path = '/' + '/'.join(p.strip('/') for p in ((prefix.group(1) if prefix else ''), path) if p.strip('/'))
            method = {'HANDLEFUNC': 'ANY', 'HANDLE': 'ANY', 'REQUEST': 'ANY'}.get(method, method)
            s.add_route(unit, rel, method, path, f'{rel}:{line_of(text, m.start())}')


def scan_messaging(s: Survey, rel: str, owner: str, text: str) -> None:
    for kind, pattern in MESSAGE_PATTERNS:
        for m in pattern.finditer(text):
            name = next((g for g in m.groups() if g), None)
            if not name or name.startswith(('http', '/', '.')) or ' ' in name:
                continue
            # The catch-all `topic = "…"` pattern only trusts names shaped like real channel names
            # (orders.placed, billing-queue, arn:…), never a type word such as "queue" or "Topic".
            if kind == 'name' and not re.fullmatch(r'(arn:.*|[a-z0-9]+(?:[._:/-][a-z0-9{}]+)+)', name):
                continue
            side = kind
            if kind in ('name', 'queue'):
                # Which side of the channel this code is on, from the words just before the name. The
                # nearest word wins: a publisher and a consumer are often configured lines apart.
                before = text[max(0, m.start() - 160) : m.start()].lower()
                consume = max((x.end() for x in re.finditer(r'consum|subscri|listen|receiv|handler', before)), default=-1)
                publish = max((x.end() for x in re.finditer(r'publish|produc|send|emit', before)), default=-1)
                side = 'declare' if consume == publish == -1 else 'consume' if consume > publish else 'publish'
            s.message_files[rel] += 1
            if len(s.messages) < 60:
                s.messages.append({'kind': side, 'name': name, 'unit': owner, 'at': f'{rel}:{line_of(text, m.start())}'})


def scan_exchange_kinds(s: Survey, rel: str, text: str) -> None:
    # RabbitMQ exchange types decide queue (direct: one consumer each) versus topic (fanout, topic).
    if 'xchange' in text:
        for number, line in enumerate(text.splitlines(), 1):
            if 'xchange' in line or 'ExchangeType' in line:
                for kind in re.findall(r'[\'"](fanout|direct|topic|headers)[\'"]', line):
                    if len(s.exchange_kinds) < 12:
                        s.exchange_kinds.append({'kind': kind, 'at': f'{rel}:{number}'})


def unit_role(unit: dict, routes: int, has_docker: bool, entries: list[str]) -> tuple[str, list[str]]:
    """A suggested element type for the unit, and the frameworks behind the guess."""
    found = []
    roles = Counter()
    for dep in sorted(unit['deps']):
        clean = dep[4:] if dep.startswith('dev:') else dep
        for pattern, name, role in FRAMEWORKS:
            if pattern.fullmatch(clean):
                if dep.startswith('dev:') and role not in ('web', 'mobile', 'desktop'):
                    continue
                if name not in found:
                    found.append(name)
                roles[role] += 1
    deps = {d for d in unit['deps'] if not d.startswith('dev:')}
    worker = any(match_key(d, DEP_SIGNALS) in ('celery', 'sidekiq', 'rq', 'bullmq', 'kafka', 'sqs', 'rabbitmq', 'temporal') for d in deps)
    if unit['workspace_root']:
        return 'workspace root (not drawn)', found
    if roles['mobile']:
        return 'service (mobile app)', found
    if roles['desktop']:
        return 'service (desktop app)', found
    if roles['web'] and not roles['api']:
        return 'service (web app)', found
    if roles['api'] or roles['rpc'] or routes:
        return 'api' + (' (also consumes messages)' if worker else ''), found
    if worker:
        return 'worker', found
    if roles['scheduler']:
        return 'scheduler', found
    if roles['cli']:
        return 'service (CLI)', found
    if not has_docker and not entries:
        return 'library (draw as a component, or leave out)', found
    return 'service', found


def render_data(s: Survey, files: list[str], truncated: bool) -> dict:
    docker_units = Counter(d['unit'] for d in s.dockerfiles)
    units = []
    for path, unit in sorted(s.units.items(), key=lambda kv: kv[0]):
        key = path if path else ''
        routes = s.route_counts.get(key, 0) + (s.route_counts.get('(root)', 0) if path == '' else 0)
        entries = s.entries.get(key, [])[:4]
        role, frameworks = unit_role(unit, routes, docker_units.get(key, 0) > 0, entries)
        units.append(
            {
                'path': unit['path'],
                'name': unit['name'] or (os.path.basename(path) if path else os.path.basename(os.path.abspath(s.root))),
                'languages': sorted(unit['languages']),
                'suggested_type': role,
                'frameworks': frameworks,
                'entry_points': entries,
                'binaries': sorted(
                    {m.group(1) for e in s.entries.get(key, []) for m in [re.search(r'(?:^|/)cmd/([^/]+)/main\.go$', e)] if m}
                ),
                'dockerfiles': [d['path'] for d in s.dockerfiles if d['unit'] == key],
                'exposes': sorted({p for d in s.dockerfiles if d['unit'] == key for p in d['expose']}),
                'routes': routes,
                'route_sample': s.routes.get(key, []),
                'start_scripts': {k: v for k, v in unit['scripts'].items() if k in ('start', 'serve', 'dev', 'worker')},
                'manifests': unit['manifests'],
            }
        )

    links = likely_links(s, units)

    signals = []
    for key, sig in sorted(s.signals.items(), key=lambda kv: (kv[1]['category'], kv[1]['name'])):
        signals.append(
            {'key': key, 'name': sig['name'], 'type': sig['type'], 'category': sig['category'], 'evidence': sorted(sig['where'])[:6]}
        )

    read_next: list[tuple[int, str, str]] = []

    def add(score: int, path: str, why: str):
        if path not in {p for _, p, _ in read_next}:
            read_next.append((score, path, why))

    for d in s.docs:
        low = d.lower()
        if re.search(r'adr|decision|architecture|design', low):
            add(95, d, 'architecture notes / decisions')
        elif re.search(r'(^|/)readme', low) and d.count('/') <= 1 and s.doc_sizes.get(d, 0) >= 300:
            add(90 if '/' not in d else 70, d, 'what the system is for')
    for d in s.diagrams[:3]:
        add(92, d, 'an existing Draft Canvas diagram — update it rather than drawing a new one')
    for c in s.compose:
        add(88, c, 'runtime topology: services, images, dependencies')
    for c in s.contracts[:6]:
        add(80, c['path'], f'{c["kind"]} contract')
    for unit in units:
        programs = [
            e for e in s.entries.get('' if unit['path'] == '.' else unit['path'], []) if re.search(r'(?:^|/)cmd/[^/]+/main\.go$', e)
        ]
        for e in programs[:8] if len(programs) > 1 else unit['entry_points'][:2]:
            add(85, e, f'entry point of {re.search(r"cmd/([^/]+)/", e).group(1) if len(programs) > 1 else unit["name"]}')
    for rel, n in s.route_files.most_common(6):
        add(75 + min(n, 10), rel, f'{n} route handlers')
    for rel, n in s.message_files.most_common(6):
        add(78 + min(n, 10), rel, 'publishes / consumes messages')
    for t in sorted({t['file'] for t in s.terraform})[:3]:
        add(60, t, 'infrastructure as code')
    for k in sorted({k['file'] for k in s.k8s})[:3]:
        add(58, k, 'deployment manifests')
    read_next.sort(key=lambda t: -t[0])

    return {
        'repository': os.path.basename(os.path.abspath(s.root)),
        'root': os.path.abspath(s.root),
        'commit': git_commit(s.root),
        'files_scanned': len(files),
        'truncated': truncated,
        'code_files_capped': s.code_capped,
        'languages': [{'language': k, 'files': v} for k, v in s.languages.most_common(8)],
        'units': units,
        'ignored_units': s.ignored_units[:20],
        'compose': s.compose,
        'kubernetes': unique(s.k8s, lambda k: (k['kind'], k['name']))[:60],
        'terraform': s.terraform[:80],
        'serverless': s.serverless[:40],
        'nomad': s.nomad[:40],
        'exchange_kinds': s.exchange_kinds,
        'signals': signals,
        'links': links,
        'messages': dedupe_messages(s.messages),
        'schedules': s.schedules,
        'contracts': unique(s.contracts, lambda c: (c['kind'], c['detail']))[:30],
        'docs': [d for d in s.docs if d.count('/') <= 1 or re.search(r'adr|decision|architecture|design', d, re.I)][:30],
        'diagrams': s.diagrams[:20],
        'env_names': {k: sorted(v)[:40] for k, v in sorted(s.env_names.items()) if v},
        'read_next': [{'path': p, 'why': w} for _, p, w in read_next[:25]],
    }


# Test runners, local admin UIs and mail catchers: real services in compose, not part of the system.
DEV_SERVICE = re.compile(
    r'(playwright|cypress|selenium|e2e|tests?|adminer|pgadmin|phpmyadmin|mailpit|mailhog|maildev|localstack'
    r'|redis-?commander|kafka-?ui|kafdrop|portainer|prometheus|grafana|jaeger|zipkin|otel|loadgen.*|locust)',
    re.I,
)
TOOLING_FILE = re.compile(
    r'^(playwright|vitest|jest|cypress|karma|webpack|rollup|babel|eslint|prettier|tailwind|postcss)\.config\.\w+$|^vite\.config\.\w+$'
)


def is_dev_service(name: str, svc: dict) -> bool:
    return bool(DEV_SERVICE.fullmatch(name) or DEV_SERVICE.search((svc.get('image') or '').split(':', 1)[0].rsplit('/', 1)[-1]))


def unique(items: list[dict], key) -> list[dict]:
    seen = set()
    out = []
    for item in items:
        k = key(item)
        if k not in seen:
            seen.add(k)
            out.append(item)
    return out


ENV_NOISE = {
    'ADDR',
    'ADDRESS',
    'URL',
    'URI',
    'HOST',
    'HOSTNAME',
    'PORT',
    'ENDPOINT',
    'BASE',
    'API',
    'GRPC',
    'HTTP',
    'HTTPS',
    'SERVICE',
    'SVC',
    'CLIENT',
    'TARGET',
    'SERVER',
    'DSN',
    'CONN',
    'CONNECTION',
    'STRING',
    'NAME',
}


def stem(name: str) -> str:
    """'grpc-currency-service' and CURRENCY_SERVICE_ADDR both → 'currency'."""
    words = [w for w in re.split(r'[^a-z0-9]+', re.sub(r'([a-z])([A-Z])', r'\1_\2', name).lower()) if w]
    words = [w for w in words if w.upper() not in ENV_NOISE]
    joined = ''.join(words)
    return re.sub(r'(service|svc|api|server)$', '', joined) or joined


def drawn_signal(s: Survey, key: str | None) -> str | None:
    """The display name of a detected store, broker or provider that becomes an element of its own."""
    found = s.signals.get(key) if key else None
    if not found or found['type'] in ('-', 'worker') or found['category'] not in ('store', 'messaging', 'external', 'edge'):
        return None
    return found['name']


def likely_links(s: Survey, units: list[dict]) -> list[dict]:
    """Connections the configuration already states: an environment variable naming another unit
    (CART_SERVICE_ADDR in the frontend) or a store, broker or provider (REDIS_ADDR), a unit's driver or
    SDK dependency (pg, stripe), and compose's depends_on."""
    targets: dict[str, str] = {}
    for u in units:
        if u['suggested_type'].startswith(('workspace', 'library')):
            continue
        for candidate in (u['name'], os.path.basename(u['path'])):
            if candidate and stem(candidate):
                targets.setdefault(stem(candidate), u['name'])
        for b in u['binaries']:
            targets.setdefault(stem(b), b)
    runs: dict[str, str | None] = {}
    for services in s.compose.values():
        for name, svc in services.items():
            targets.setdefault(stem(name), name)
            image = (svc.get('image') or '').split(':', 1)[0].lower()
            runs[name] = runs.get(name) or (match_key(image, IMAGE_SIGNALS) if image else None)
    out: dict[tuple[str, str], dict] = {}

    def add(src: str, dst: str, via: str):
        if src and dst and src != dst:
            entry = out.setdefault((src, dst), {'from': src, 'to': dst, 'via': []})
            if via not in entry['via']:
                entry['via'].append(via)

    # A module that builds several programs speaks through each program, never as one unit: its shared
    # code's settings belong to whichever program reads them, which a survey can't tell.
    by_path = {('' if u['path'] == '.' else u['path']): u['name'] for u in units if len(u['binaries']) <= 1}
    for key, names in sorted(s.env_names.items()):
        if key.startswith(('compose:', 'program:')):
            source = key.split(':', 1)[1]
        elif key in by_path:
            source = by_path[key]
        else:
            continue
        for env in sorted(names):
            signal = match_key(env, ENV_SIGNALS)
            target = targets.get(stem(env)) or drawn_signal(s, signal)
            # A compose service running Postgres reads POSTGRES_DB about itself, not about a store.
            if target and not (signal and runs.get(source) == signal):
                add(source, target, f'env {env}')
    # A driver or SDK in a unit's own dependencies: that unit talks to the store or provider.
    for u in units:
        if len(u['binaries']) > 1 or u['suggested_type'].startswith(('workspace', 'library')):
            continue
        raw = s.units.get('' if u['path'] == '.' else u['path'], {}).get('deps', set())
        for dep in sorted(d for d in raw if not d.startswith('dev:')):
            target = drawn_signal(s, match_key(dep, DEP_SIGNALS))
            if target:
                add(u['name'], target, f'dep {dep}')
    dev = set()
    for file, services in s.compose.items():
        for name, svc in services.items():
            if is_dev_service(name, svc):
                dev.add(name)
                continue
            for dep in svc.get('depends_on') or []:
                add(name, dep, f'depends_on ({file})')
    kept = (link for link in out.values() if link['from'] not in dev and link['to'] not in dev)
    return sorted(kept, key=lambda link: (link['from'], link['to']))[:60]


def dedupe_messages(messages: list[dict]) -> list[dict]:
    seen = {}
    for m in messages:
        key = (m['kind'], m['name'], m['unit'], m['at'].rsplit(':', 1)[0])
        if key not in seen:
            seen[key] = m
    return list(seen.values())[:40]


# --- Output ------------------------------------------------------------------------------------


def render_text(d: dict) -> str:
    out: list[str] = []
    w = out.append
    head = f'# Repository survey: {d["repository"]}'
    if d['commit']:
        head += f'  (commit {d["commit"]})'
    w(head)
    total = sum(lang['files'] for lang in d['languages']) or 1
    langs = ', '.join(f'{lang["language"]} {round(100 * lang["files"] / total)}%' for lang in d['languages'][:6])
    w(f'{d["files_scanned"]} files{" (cut short — scan a sub-folder for more)" if d["truncated"] else ""} · {langs or "no source files"}')
    if d['code_files_capped']:
        w(f'Only the first {MAX_CODE_FILES} source files were read for routes and messaging — survey a sub-folder for the rest.')
    w('Everything below is a candidate: confirm it in code before drawing it.')

    units = [u for u in d['units'] if not u['suggested_type'].startswith('workspace root')]
    w(f'\n## Deployable units ({len(units)})')
    if not units:
        w('- none found from manifests; read the README and entry points')
    for u in units:
        bits = [f'{u["path"]}', '/'.join(u['languages']) or '?', f'→ {u["suggested_type"]}']
        line = f'- **{u["name"]}** [{" · ".join(bits)}]'
        if u['frameworks']:
            line += f' frameworks: {", ".join(u["frameworks"][:6])}'
        w(line)
        extra = []
        if len(u['binaries']) > 1:
            extra.append(f'{len(u["binaries"])} programs (cmd/*): ' + ', '.join(u['binaries'][:10]) + ' — likely one container each')
        elif u['entry_points']:
            extra.append('entry ' + ', '.join(u['entry_points'][:2]))
        if u['dockerfiles']:
            extra.append('Dockerfile' + (f' (EXPOSE {" ".join(u["exposes"])})' if u['exposes'] else ''))
        if u['routes']:
            extra.append(f'{u["routes"]} routes')
        if u['start_scripts']:
            extra.append('scripts ' + ', '.join(f'{k}: {v[:50]}' for k, v in list(u['start_scripts'].items())[:2]))
        if extra:
            w('  ' + ' · '.join(extra))
    if d['ignored_units']:
        w(f'  (left out as tests/examples/docs: {", ".join(d["ignored_units"][:6])}{" …" if len(d["ignored_units"]) > 6 else ""})')

    if d['compose']:
        shown: list[tuple[str, set]] = []
        for file, services in sorted(d['compose'].items(), key=lambda kv: -len(kv[1])):
            base = next((f for f, names in shown if set(services) <= names), None)
            if base:
                # An override or variant of a file already listed: names only.
                w(f'\n## Runtime services ({file}) — adjusts {base}: {", ".join(services)}')
                continue
            shown.append((file, set(services)))
            w(f'\n## Runtime services ({file})')
            for name, svc in services.items():
                bits = []
                if svc.get('build'):
                    bits.append(f'build {svc["build"]}')
                if svc.get('image'):
                    bits.append(f'image {svc["image"]}')
                if svc.get('ports'):
                    bits.append('ports ' + ', '.join(svc['ports'][:3]))
                if svc.get('depends_on'):
                    bits.append('depends on ' + ', '.join(svc['depends_on']))
                if svc.get('env'):
                    bits.append('env ' + ', '.join(svc['env'][:8]) + (' …' if len(svc['env']) > 8 else ''))
                if not bits:
                    continue  # an override file only adjusting a service listed elsewhere
                w(f'- {name}: ' + ' · '.join(bits) + (' · (dev tooling — not drawn by default)' if is_dev_service(name, svc) else ''))

    if d['kubernetes'] or d['terraform'] or d['serverless'] or d['nomad']:
        w('\n## Infrastructure as code')
        by_kind: dict[str, list[str]] = defaultdict(list)
        for k in d['kubernetes']:
            detail = k['detail'] if k['detail'] and k['kind'] in ('CronJob', 'Job') else None
            by_kind[k['kind']].append(k['name'] + (f' ({detail})' if detail else ''))
        for kind, names in by_kind.items():
            w(f'- k8s {kind}: ' + ', '.join(names[:20]) + (' …' if len(names) > 20 else ''))
        for t in d['terraform'][:30]:
            w(f'- terraform {t["resource"]}.{t["name"]} → {t["type"]} — {t["file"]}')
        for n in d['nomad'][:20]:
            w(
                f'- nomad job {n["job"]}'
                + (f' task {n["task"]}' if n['task'] else '')
                + (f' ({n["image"]})' if n['image'] else '')
                + f' — {n["file"]}'
            )
        for f in d['serverless'][:20]:
            w(f'- function {f["function"]}' + (f' on {", ".join(f["events"])}' if f['events'] else '') + f' — {f["file"]}')

    groups = [('store', 'Data stores'), ('messaging', 'Messaging'), ('external', 'External services'), ('edge', 'Edge / gateways')]
    w('\n## Detected infrastructure and external systems')
    any_signal = False
    for cat, title in groups:
        items = [sig for sig in d['signals'] if sig['category'] == cat]
        if not items:
            continue
        any_signal = True
        w(f'{title}:')
        for sig in items:
            w(f'- {sig["name"]} → `{sig["type"]}` · ' + '; '.join(sig['evidence'][:4]))
    if not any_signal:
        w('- nothing detected from dependencies, images or environment names')
    quiet = [sig['name'] for sig in d['signals'] if sig['category'] in ('observability', 'dev')]
    if quiet:
        w(f'Not drawn by default (observability / dev tooling): {", ".join(quiet)}')

    if d['links']:
        w('\n## Likely connections (from configuration — confirm the direction and meaning in code)')
        for link in d['links'][:40]:
            w(f'- {link["from"]} → {link["to"]} · ' + ', '.join(sorted(set(link['via']))[:3]))

    routed = [u for u in d['units'] if u['route_sample']]
    if routed:
        w('\n## HTTP routes (sample)')
        for u in routed:
            sample = ', '.join(f'{r["method"]} {r["path"]} ({r["at"]})' for r in u['route_sample'][:6])
            w(f'- {u["name"]} ({u["routes"]}): {sample}')

    if d['messages']:
        w('\n## Messaging names in code')
        for m in d['messages'][:30]:
            w(f'- {m["unit"]}: {m["kind"]} "{m["name"]}" — {m["at"]}')
        if d['exchange_kinds']:
            w('Exchange types: ' + ', '.join(sorted({f'{e["kind"]} ({e["at"]})' for e in d['exchange_kinds']})[:6]))
    if d['schedules']:
        w('\n## Schedules')
        for sch in d['schedules'][:12]:
            w(f'- {sch["expr"]} — {sch["at"]}')
    if d['contracts']:
        w('\n## API contracts')
        for c in d['contracts'][:15]:
            w(f'- {c["kind"]}: {c["path"]}' + (f' — {c["detail"]}' if c['detail'] else ''))
    if d['diagrams']:
        w('\n## Existing Draft Canvas diagrams')
        for p in d['diagrams'][:10]:
            w(f'- {p}')
    if d['docs']:
        w('\n## Docs')
        w('- ' + ', '.join(d['docs'][:15]))
    env_all = sorted({e for v in d['env_names'].values() for e in v})
    if env_all:
        w(f'\n## Environment variable names ({len(env_all)}; values never read)')
        w('- ' + ', '.join(env_all[:60]) + (' …' if len(env_all) > 60 else ''))

    w('\n## Read next')
    for i, r in enumerate(d['read_next'], 1):
        w(f'{i}. {r["path"]} — {r["why"]}')
    return '\n'.join(out)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('root', nargs='?', default='.', help='repository (or sub-folder) to survey')
    parser.add_argument('--json', action='store_true', help='print the full survey as JSON')
    parser.add_argument('--max-files', type=int, default=40000)
    args = parser.parse_args(list(argv) if argv is not None else None)
    # A console that can't encode a dash or an arrow (Windows' cp1252, a C locale) gets a stand-in
    # character rather than a crash halfway through the survey.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    if not os.path.isdir(args.root):
        print(f'Not a folder: {args.root}', file=sys.stderr)
        return 2
    data = survey(args.root, args.max_files)
    if args.json:
        print(json.dumps(data, indent=1, default=sorted))
    else:
        print(render_text(data))
    return 0


if __name__ == '__main__':
    sys.exit(main())
