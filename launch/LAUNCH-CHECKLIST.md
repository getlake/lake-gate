# lake-gate: what it takes to publish (nothing below has been done)

Proposed names (checked 12 Nov 2026 with `npm view`: `lake-gate` returned 404, so it looks free; not registered):
- npm package: `lake-gate`
- GitHub repo: `getlake/lake-gate`

## Accounts needed (all free)
1. **GitHub org or account** for Lake (e.g. `getlake`). It hosts the code, the Action (`uses: getlake/lake-gate@v0`), Issues and the landing page on GitHub Pages.
2. **npm account** (free) with 2FA. Publish as an unscoped public package `lake-gate`.
3. **GoatCounter** (free for small sites, cookieless). Site code is `lakehq` (`lakehq.goatcounter.com`).
4. Optional: **Tally** (free) if you'd rather have a form than a mailto for the design-partner list.

## Steps, in order
1. If the GitHub owner isn't `getlake`, replace that name everywhere: `grep -rn getlake` covers package.json, `src/init.js` (ACTION_REF) and README.
2. Create the public GitHub repo and push `/workspace/lake/exp-b-gate` without `landing/screenshots` (optional) and `docs/`.
3. Tag the Action: `git tag v0.1.0 && git tag -f v0 && git push --tags`. Optionally publish the Action to GitHub Marketplace from the release page, which needs a public repo and the action.yml at the root (already there).
4. `npm login`, then `npm publish --access public` from the repo root. Check with `npx lake-gate@latest help` in an empty folder.
5. Dogfood once on a real private test repo with two GitHub users: author and approver. Open a plan PR, comment `/lake approve`, and check that the status turns green and that editing the plan turns it red. The Action has been tested only against a mocked GitHub API so far, so this is the one real check before announcing.
6. Landing: GitHub links and the GoatCounter code (`lakehq`) are already set. Host for free on GitHub Pages via `.github/workflows/pages.yml` (Settings → Pages → Source: GitHub Actions). A custom domain is optional and costs money, so it needs separate approval.
7. Post the drafts in `launch/posts.md`, in this order: Show HN (needs an HN account, since there's no Lake one yet), then r/ClaudeCode from u/LakeResearchTeam, then X/LinkedIn if Lake accounts exist.
   - Note: u/LakeResearchTeam also sends the research DMs. Posting a launch from it could make the research look like marketing. Consider waiting until the research round ends, or using a separate account.

## How we measure (no telemetry in the tool)
- npm weekly downloads: `https://api.npmjs.org/downloads/point/last-week/lake-gate` (public, no login)
- GitHub stars, forks, issues, and Insights → Traffic (views, clones, 14-day window; repo admin only)
- Action adoption: GitHub code search for `uses: getlake/lake-gate` (public repos only) plus the Marketplace page
- Landing: GoatCounter visits, plus click events `cta-design-partner`, `copy-install`, `hero-github`
- Design-partner emails arriving at lake.research1@gmail.com (subject "lake-gate design partner")

Suggested 2-week bar (a hypothesis, not a commitment): at least 150 npm downloads not from us, at least 3 repos using the Action, at least 2 design-partner emails. Below that, rethink before building more.
