# Songbird task runner. Run `just --list` to see recipes.

set dotenv-load := false

backend := "backend"
frontend := "frontend"

# List recipes
default:
    @just --list

# Install frontend dependencies and Playwright browsers
setup:
    cd {{frontend}} && pnpm install && pnpm exec playwright install chromium

# Run backend (:8080) and frontend (:3000) together; Ctrl-C stops both
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT INT TERM
    # Production is the backend's default, so the dev recipe has to opt in to run without user keys.
    export SONGBIRD_ENV="${SONGBIRD_ENV:-development}"
    (cd {{backend}} && cargo run -p api) &
    (cd {{frontend}} && pnpm dev) &
    wait

# Start a local Postgres in Docker and print the URL to export for `just dev`
dev-pg:
    docker compose --profile postgres up -d --wait postgres
    @echo "export SONGBIRD_DATABASE_URL=postgres://songbird:songbird@localhost:5432/songbird"

# Run all tests (Rust, Vitest, Playwright). Needs no API key.
test: test-backend test-frontend test-e2e

# Rust unit and integration tests
test-backend:
    cd {{backend}} && cargo test --workspace

# Rust tests with every database-backed test running on Postgres (needs `just dev-pg`)
test-backend-pg:
    cd {{backend}} && SONGBIRD_TEST_POSTGRES_URL="${SONGBIRD_TEST_POSTGRES_URL:-postgres://songbird:songbird@localhost:5432/postgres}" cargo test --workspace

# Frontend unit tests (Vitest)
test-frontend:
    cd {{frontend}} && pnpm test

# End-to-end tests (Playwright; boots backend with the mock provider)
test-e2e:
    cd {{frontend}} && pnpm test:e2e

# Live test against the Claude API (needs ANTHROPIC_API_KEY)
test-live:
    cd {{backend}} && cargo test --workspace -- --ignored live_claude

# Live test against a local Ollama server (needs the model pulled)
test-live-ollama:
    cd {{backend}} && cargo test --workspace -- --ignored live_ollama

# Live test against the OpenAI API (needs OPENAI_API_KEY)
test-live-openai:
    cd {{backend}} && cargo test --workspace -- --ignored live_openai

# Live test against a signed-in Codex CLI
test-live-codex:
    cd {{backend}} && cargo test --workspace -- --ignored live_codex

# Regenerate frontend/src/generated TypeScript types from the Rust types
gen-types:
    cd {{backend}} && UPDATE_TS_BINDINGS=1 cargo test -p api --test ts_bindings

# Formatting check, clippy, ESLint, TypeScript type check, and production build
lint: lint-backend lint-frontend

# Rust formatting check and clippy
lint-backend:
    cd {{backend}} && cargo fmt --all -- --check
    cd {{backend}} && cargo clippy --workspace --all-targets -- -D warnings

# ESLint, TypeScript type check, and production build
lint-frontend:
    cd {{frontend}} && pnpm lint
    cd {{frontend}} && pnpm typecheck
    cd {{frontend}} && pnpm build

# Format Rust and frontend code
fmt:
    cd {{backend}} && cargo fmt --all
    cd {{frontend}} && pnpm exec eslint --fix .
