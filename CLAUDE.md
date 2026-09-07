# agent-crew-creator

## BIG RULE — never deploy an image built from a branch

**Every deployed image is built from a clean `main` checkout. Never from a
branch, and never from an uncommitted working tree. `main` must always be in
line with production.**

Tag images with the 7-char commit SHA so a running image traces back to a
commit:

```
git checkout main && git pull --ff-only
docker build -t docker4zerocool/bionic-platform:$(git rev-parse --short HEAD) -f Dockerfile .
docker build -t docker4zerocool/bionic-agent:$(git rev-parse --short HEAD)  -f agent-template/Dockerfile agent-template/
```

Hotfixes go through `main` too: commit, merge, then build. Never patch a
running image or build from a dirty tree "just this once".

**Why this rule exists.** On 2026-09-07 the running
`mcp-api-server:20260905-sarvamv3` turned out to have been built from an
uncommitted working tree. Its code was on no branch and in no commit — all
seven remote branches were checked. It carried a live hotfix (Sarvam retired
`bulbul:v2` server-side; the image had migrated to `v3`) that existed nowhere
in git. Building from `main` and deploying therefore *reverted production*:
Sarvam's 37 voices dropped out of the gateway within a minute, because `main`
still pinned the dead model.

Recovering it needed a full three-way merge, because `main` had meanwhile
moved ahead on other work — the divergence was bidirectional, not a simple
"main is behind". Note also that `mcp-api-server` tags images by date and
feature (`20260905-sarvamv3`) rather than by SHA, which is precisely what let
the drift hide.

**The tell, missed twice:** two `test_faster_whisper_vad_retry` tests were
failing on `main` and were written off as pre-existing and unrelated. They
were not. `main` held the *test*; the *implementation* existed only in the
image. A test failing for no apparent reason is evidence of drift, not noise.

## Before any deploy: check the candidate against what is running

A deploy can silently remove something production depends on. Diff the
candidate image against the **running** image and confirm it drops nothing:

```
predeploy-check.sh <running-image> <candidate-image> [path-in-image]
```

It reports, per file, how many lines exist only in the running image versus
only in the candidate. Any `running-only > 0` needs a human to confirm the
removal is deliberate — it is either work `main` intentionally replaced, or a
hotfix about to be reverted, and those look identical to the tool. Only
reading the lines tells them apart.

If a deploy does revert something: roll back first, recover into git second.

## Deployment topology

- `platform.baisoln.com` → k8s `bionic-platform` in namespace `bionic-platform`
  → `docker4zerocool/bionic-platform:<short-sha>`
- Agent fleet → `docker4zerocool/bionic-agent:<same-sha>`, deployed per tenant
  into `guruji`, `jarvis`, `tutor`
- `AGENT_TEMPLATE_IMAGE` on the platform deployment is the fleet default for
  **newly created** agents. Update it alongside the agent rollout, or new
  agents come up on the old image.
- There are no CI workflows in this repo; builds and deploys are manual, which
  is exactly why the rule above matters.
