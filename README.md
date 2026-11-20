# LUNA Discover notifier

Posts to a Discord channel when an Add On is approved into LUNA's **Discover** list, and
when an Add On already there publishes a new release.

LUNA reads Discover from
[`uaudio-labs/marketplace/manifest.json`](https://github.com/uaudio-labs/marketplace/blob/main/manifest.json),
one `{ github, tag }` per Add On. A GitHub Action here checks it every 15 minutes, compares it
with `state.json`, and for each change reads the release's `.lunaaddon` (name, description,
categories, required LUNA version, icon) and posts an embed linking the release.

- **New Add On**: a post, pinging `DISCORD_ROLE_ID` if set.
- **New tag on a listed Add On**: a smaller post with the release notes, no ping.
- **Removed**: nothing is posted; it is forgotten, so relisting announces it again.

The first run records the current list without posting. A post that fails is retried on the
next run. Posts arrive up to about 20 minutes after a merge, since GitHub's schedule runs late
under load.

## Setup

1. In Discord: create the channel (an Announcement channel lets other servers follow it).
   Channel settings › Integrations › Webhooks › New Webhook, then copy its URL.
2. Here: Settings › Secrets and variables › Actions › **Secrets** › `DISCORD_WEBHOOK_URL`.
3. Optional: a role people can pick for alerts (Server settings › Roles, enable
   "Allow anyone to @mention this role", or add it to Onboarding / a role picker). Copy its
   id (Developer Mode › right click › Copy Role ID) into **Variables** › `DISCORD_ROLE_ID`.
4. Actions › Discover notifier › Run workflow, once, to record the current list.

## Local

```sh
nvm use
npm test
GITHUB_TOKEN=$(gh auth token) npm run dry-run   # prints what it would post, writes nothing
```

`ANNOUNCE_EXISTING=1` with no `state.json` announces every listed Add On, for a channel's
first day.
