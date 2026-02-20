# Contributing to Janee

Thanks for contributing to Janee! Please read this guide before submitting a PR.

## Pull Request Workflow

When you're ready to contribute changes:

1. Commit your changes to a feature branch
2. Push the branch to GitHub
3. Open a pull request against the `main` branch
4. Copy the **PR Checklist** below into your PR description and check off completed items
5. Wait for review and address any feedback

## PR Checklist

Copy this into your PR description:

```markdown
## PR Checklist

- [ ] **Tests** — New features need tests. Bug fixes need regression tests.
- [ ] **CHANGELOG.md** — Update `docs/CHANGELOG.md` for user-facing changes.
- [ ] **Version bump** — Bump version in each changed package's `package.json` (see [Version Bumping](#version-bumping) for all three packages).

### When Applicable

- [ ] **README.md** — Update if adding new features, CLI commands, or config options.
- [ ] **SKILL.md** — Update if agents need to know about the change (new tools, new auth types, new capabilities).
- [ ] **docs/** — Add or update documentation for significant features.
- [ ] **Types** — Ensure TypeScript types are updated and exported if needed.
- [ ] **Security review** — For auth/crypto changes, note any security considerations in the PR description.

### Before Merge

- [ ] All tests pass (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] PR description explains *what* and *why*
- [ ] Breaking changes are clearly noted
```

### Version Bumping

This repo contains **three publishable packages**. Bump the version in every package that changed:

| Package | File | npm name |
|---------|------|----------|
| Janee (main) | `package.json` | `@true-and-useful/janee` |
| create-gh-app | `packages/create-gh-app/package.json` | `@true-and-useful/create-gh-app` |
| OpenClaw plugin | `packages/openclaw-plugin/package.json` | `@true-and-useful/janee-openclaw` |

Follow [semver](https://semver.org/):
- **patch** (0.8.x → 0.8.y) for bug fixes
- **minor** (0.x.0 → 0.y.0) for new features
- **major** (x.0.0 → y.0.0) for breaking changes

For each bumped package:
1. Update the version in its `package.json`
2. Add an entry in `docs/CHANGELOG.md` under the new version heading
3. If unsure whether to bump, ask in the PR — the maintainer will advise

Publishing is done after merge with `npm publish` from each package directory. Duplicate-version publishes will fail, so always check `npm view <pkg> versions` before publishing.

## Commit Messages

Keep them short and descriptive:
- `feat: Add service account authentication`
- `fix: Handle 401 retry in token refresh`
- `docs: Update changelog for v0.2.0`
- `test: Add caching tests for service accounts`

## Security

Janee is a security product. Extra care required:

- Never log credentials, tokens, or private keys
- Encrypt secrets at rest
- Validate all inputs
- Document security implications in PRs
- When in doubt, ask for a security review
