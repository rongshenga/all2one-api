<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# Repository Guidelines

## Project Structure & Module Organization
- `src/` is the Node.js ESM backend.
- `src/core/` handles process lifecycle and config bootstrap.
- `src/services/` contains the API server and service orchestration.
- `src/providers/` implements provider adapters (`openai/`, `claude/`, `gemini/`, `grok/`, `forward/`).
- `src/converters/` contains protocol conversion strategies.
- `src/auth/` stores OAuth flows and handlers.
- `src/plugins/` hosts optional plugin modules.
- `src/ui-modules/` exposes backend endpoints used by the Web UI.
- `static/` contains the Web UI assets (HTML/CSS/JS), `configs/` stores runtime config files, `tests/` contains Jest tests, and `docker/` contains Compose files.

## Build, Test, and Development Commands
- `npm install`: install project dependencies.
- `npm run start`: run master mode (`src/core/master.js`).
- `npm run start:standalone`: run API server directly (`src/services/api-server.js`).
- `npm run start:dev`: run master with `--dev` flag.
- `npm test`: run Jest test suite.
- `npm run test:coverage`: generate coverage reports in `coverage/`.
- `docker compose -f docker/docker-compose.build.yml up -d --build`: build and run from source image.
- 前端改动后**不需要**执行构建产物生成（不要求执行 `npm run build`，默认不生成 `dist/`）。
- Note: `test:unit`, `test:integration`, and `test:summary` currently reference missing files; do not rely on them until restored.

## Coding Style & Naming Conventions
- Use ESM syntax (`import`/`export`) and keep semicolons.
- Follow existing 4-space indentation in `src/`.
- Prefer `kebab-case` for module files (for example, `provider-pool-manager.js`).
- Use PascalCase for converter strategy classes/files (for example, `OpenAIConverter.js`).
- Keep provider-specific logic in `src/providers/<provider>/`; place shared utilities in `src/utils/`.

## Testing Guidelines
- Framework: Jest + Babel (`jest.config.js`, `.babelrc`).
- Place tests in `tests/` and use `*.test.js` naming.
- Use `supertest` for HTTP endpoint checks when applicable.
- Before opening a PR, run `npm test` and `npm run test:coverage`.

## Change Verification Requirement
- After any code change, verify the behavior with `chrome-devtools` and confirm the result matches expectations before finalizing.

## Commit & Pull Request Guidelines
- Follow Conventional Commits seen in history: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
- Optional scopes are encouraged (for example, `fix(codex): ...`).
- Keep each commit focused on one logical change.
- PRs should include: goal, impacted paths, config/env changes, test evidence (commands + results), and screenshots for `static/` UI changes.
- Link related issues and call out breaking changes explicitly.
