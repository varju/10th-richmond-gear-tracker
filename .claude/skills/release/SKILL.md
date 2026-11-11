---
name: release
description:
  Ship what is on local main to production — make check, deploy the server, upload a TestFlight build, push main. Use
  only when the user runs /release or asks to release, ship or put changes in production.
---

# Release

Ship the commits on local `main` that origin does not have yet. Run from the repo root, on `main`, with a clean tree. If
either is not true, stop and say so.

1. **Work out what changed.** `git log --oneline origin/main..main` and `git diff --stat origin/main..main`. Also
   compare with the `deployed` tag: `git diff --stat deployed..main`. If nothing is new, say so and stop.
2. **Test.** `nice -n 19 make check`. If it fails, stop and report. Never deploy on red.
3. **Deploy** if anything the server runs or serves changed since `deployed`: `server/`, `client/`, `docs/guide/`,
   `Dockerfile`, dependencies. Run `nice -n 19 make deploy`. Skip it for docs-only or iOS-only changes, and say why.
4. **TestFlight** if anything the iPhone app runs changed since the last `ios-*` tag: `client/` (not tests or dev-only
   code), `docs/guide/`, `ios/`. `docs/pending-ios.md` lists these. Run `nice -n 19 make testflight`. Do not bump the
   version unless the user asks. The `ios-*` tag it makes stays local: never push it.
5. **Push.** `git push origin main`. The branch only, no tags.

Report in one short list: what shipped, which steps ran, which were skipped and why. Name any App Store follow-up: a
TestFlight build reaches iPhones only once the user releases it on the App Store.
