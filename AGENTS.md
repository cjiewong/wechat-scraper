# Repository Guidelines

## Project Structure & Module Organization
This repository is an Electron desktop app for exporting WeChat public-account articles.

- `main.js`: Electron main process, IPC handlers, export orchestration.
- `preload.js`: secure bridge between renderer and main process.
- `renderer/`: UI layer (`index.html`, `renderer.js`, `styles.css`).
- `modules/`: core services (`scraper.js`, `converter.js`, `fileManager.js`, `imageProcessor.js`, `logger.js`, `config.js`).
- `assets/`: static assets used at runtime.
- `build/`: packaging resources (`icon.ico`, `installer.nsh`).
- `docs/`: design and planning notes.

Keep feature logic in `modules/` and keep `renderer/renderer.js` focused on UI state and IPC calls.

## Build, Test, and Development Commands
Use npm scripts from `package.json`:

- `npm install`: install dependencies.
- `npm start`: launch the app normally.
- `npm run dev`: launch Electron in dev mode (`--dev`).
- `npm run pack:win`: build Windows NSIS installer to `dist/`.
- `npm run pack:mac`: build macOS DMG.
- `npm run pack:linux`: build Linux AppImage.

Example local run:
```bash
npm install
npm run dev
```

## Coding Style & Naming Conventions
- JavaScript uses CommonJS (`require`, `module.exports`).
- 2-space indentation, semicolons, single quotes.
- Prefer `const`/`let`; avoid `var`.
- Naming: `camelCase` for variables/functions, `PascalCase` for classes (for example, `ArticleScraper`), descriptive module filenames (for example, `fileManager.js`).
- Keep IPC channel names explicit and action-based (for example, `start-full-export`).

## Testing Guidelines
There is currently no automated test suite configured. For now:

- Validate changes with `npm run dev`.
- Smoke-test core flows: login/session save, account search, article list loading, Markdown/PDF export.
- If you add tests, place them under a new `tests/` directory and name files `*.test.js`.

## Commit & Pull Request Guidelines
Current history follows Conventional Commit style (for example, `chore: initialize standalone open-source repository`). Continue with prefixes such as `feat:`, `fix:`, `refactor:`, `docs:`.

For pull requests, include:
- concise summary of behavior changes,
- linked issue/task,
- manual test steps and results,
- screenshots or short recordings for UI changes.

## Release Versioning Rule
Always bump `package.json` `version` before creating a release tag, so Release tag and installer filename stay aligned.

Release sequence:
- update `package.json` (for example, `1.0.5`),
- commit bump (`chore(release): v1.0.5`),
- tag and push (`git tag -a v1.0.5 -m "Release v1.0.5"` and `git push origin v1.0.5`).

## Security & Configuration Tips
- Never commit real `token`/`Cookie` values or exported private data.
- Keep credentials local and rotate sessions if exposed.
- Respect WeChat platform rate limits and content copyright requirements.
