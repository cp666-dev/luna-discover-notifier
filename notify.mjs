// Posts to Discord when an Add On is added to LUNA's Discover list, or an Add On already
// in it gets a new release, and posts an Add On of the Day to Slack. LUNA reads that list from MANIFEST_URL.
//
// Env:
//   DISCORD_WEBHOOK_URL  a Discord channel's webhook
//   DISCORD_ROLE_ID      optional role to ping, so members can opt in to alerts
//   SLACK_WEBHOOK_URL    a Slack incoming webhook, for the Add On of the Day
//   SLACK_MENTION        optional, e.g. <!here> or <!subteam^ID>, leading that post
//   DAILY_HOUR, DAILY_TZ when the day's post goes out (default 9, America/Los_Angeles)
//   DAILY_FORCE=1        post an Add On of the Day now
//   GITHUB_TOKEN         optional, raises GitHub's API rate limit
//   DRY_RUN=1            print what would be posted, change nothing
//   STATE_FILE           default ./state.json

import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export const MANIFEST_URL = 'https://raw.githubusercontent.com/uaudio-labs/marketplace/main/manifest.json';
const COLOR_NEW = 0xb14b2c;
const COLOR_UPDATE = 0xc98a3f;
const ICON_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// ---- diff ----------------------------------------------------------------

/** `{ "owner/repo": tag }` from manifest.json. Keys are lowercase, as LUNA compares them. */
export function listingsFromManifest(manifest) {
    const out = {};
    for (const entry of manifest?.add_ons ?? []) {
        const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(entry?.github ?? '');
        if (m && typeof entry.tag === 'string') out[`${m[1]}/${m[2]}`.toLowerCase()] = entry.tag;
    }
    return out;
}

/** What changed between two listings: `[{ repo, tag, kind: 'new' | 'updated', previousTag? }]`. */
export function diffListings(before, after) {
    const changes = [];
    for (const [repo, tag] of Object.entries(after)) {
        if (!(repo in before)) changes.push({ repo, tag, kind: 'new' });
        else if (before[repo] !== tag) changes.push({ repo, tag, kind: 'updated', previousTag: before[repo] });
    }
    return changes.sort((a, b) => a.repo.localeCompare(b.repo));
}

// ---- .lunaaddon (a zip) --------------------------------------------------

/** Reads a zip's files into `{ path: Buffer }`. Handles stored and deflated entries. */
export function unzip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const files = {};
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
        const method = buf.readUInt16LE(p + 10);
        const size = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/')) continue;
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        if (method === 0) files[name] = raw;
        else if (method === 8) files[name] = inflateRawSync(raw);
    }
    return files;
}

const text = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').join('') : typeof v === 'string' ? v : '');

/**
 * The Add Ons a .lunaaddon holds, from its manifest.json (either shape: one Add On, or
 * `add_ons` with top-level defaults). Each `{ name, description, manufacturer, version,
 * categories, minLuna, icon? }`, icon being `{ name, type, data }` when Discord can show it.
 */
export function addOnsFromPackage(buf) {
    const files = unzip(buf);
    const manifestPath = Object.keys(files)
        .filter((f) => /(^|\/)manifest\.json$/.test(f))
        .sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (!manifestPath) return [];
    const root = manifestPath.slice(0, -'manifest.json'.length);
    const top = JSON.parse(files[manifestPath].toString('utf8'));
    const entries = Array.isArray(top.add_ons) ? top.add_ons : [top];
    return entries.map((e) => {
        const pick = (k) => e[k] ?? top[k];
        const iconPath = typeof pick('icon') === 'string' ? root + pick('icon').replace(/^\.\//, '') : null;
        const ext = iconPath?.split('.').pop().toLowerCase();
        const icon = iconPath && files[iconPath] && ICON_TYPES[ext]
            ? { name: `icon.${ext}`, type: ICON_TYPES[ext], data: files[iconPath] }
            : null;
        return {
            name: text(e.name) || text(top.package_name) || 'Untitled Add On',
            description: text(pick('description')),
            manufacturer: text(pick('manufacturer')),
            version: text(pick('version')),
            categories: Array.isArray(pick('categories')) ? pick('categories').filter((c) => typeof c === 'string') : [],
            minLuna: text(pick('min_luna_version')),
            icon,
        };
    });
}

// ---- GitHub --------------------------------------------------------------

async function get(url, as = 'json') {
    const headers = { 'User-Agent': 'luna-discover-notifier' };
    if (url.startsWith('https://api.github.com/')) {
        headers.Accept = as === 'json' ? 'application/vnd.github+json' : 'application/octet-stream';
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

/** The release behind a listing and the Add Ons in its .lunaaddon assets. */
async function loadRelease(repo, tag) {
    const release = await get(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    const addOns = [];
    for (const asset of release.assets ?? []) {
        if (!/\.lunaaddon$/i.test(asset.name)) continue;
        try {
            addOns.push(...addOnsFromPackage(await get(asset.url, 'binary')));
        } catch (err) {
            console.warn(`  could not read ${asset.name}: ${err.message}`);
        }
    }
    return { release, addOns };
}

// ---- Discord -------------------------------------------------------------

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Release notes without HTML comments (GitHub's draft hints) or blank runs. */
export function cleanNotes(body) {
    return (body ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** The webhook message for one change: `{ payload, files }`. */
export function buildMessage(change, release, addOns, roleId) {
    const owner = change.repo.split('/')[0];
    const list = addOns.length ? addOns.slice(0, 10) : [{ name: change.repo.split('/')[1], description: '', categories: [] }];
    const files = [];
    const embeds = list.map((a, i) => {
        const version = a.version || change.tag;
        const fields = [{ name: 'By', value: clip(a.manufacturer || owner, 1024), inline: true }];
        fields.push({ name: 'Version', value: change.kind === 'updated' ? `${change.previousTag} → ${version}` : version, inline: true });
        if (a.categories.length) fields.push({ name: 'Category', value: a.categories.join(', '), inline: true });
        if (a.minLuna) fields.push({ name: 'Needs', value: `LUNA ${a.minLuna}+`, inline: true });
        const notes = cleanNotes(release.body);
        const description = change.kind === 'new'
            ? a.description || notes
            : notes || a.description;
        const embed = {
            title: clip(change.kind === 'new' ? `New in Discover: ${a.name}` : `Updated: ${a.name} ${version}`, 256),
            url: release.html_url,
            color: change.kind === 'new' ? COLOR_NEW : COLOR_UPDATE,
            description: clip(description, change.kind === 'new' ? 1000 : 700),
            fields,
            footer: { text: 'Install it from LUNA › Add Ons › Discover' },
            timestamp: release.published_at ?? undefined,
        };
        if (a.icon) {
            const name = `icon-${i}.${a.icon.name.split('.').pop()}`;
            files.push({ ...a.icon, name });
            embed.thumbnail = { url: `attachment://${name}` };
        }
        return embed;
    });
    const ping = change.kind === 'new' && roleId ? `<@&${roleId}> ` : '';
    const payload = {
        content: change.kind === 'new' ? `${ping}A new Add On is in Discover` : undefined,
        embeds,
        allowed_mentions: { roles: ping ? [roleId] : [] },
        attachments: files.map((f, id) => ({ id, filename: f.name })),
    };
    return { payload, files };
}

async function post(webhook, { payload, files }) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name));
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${webhook}?wait=true`, { method: 'POST', body: form });
        if (res.ok) return;
        if (res.status === 429) {
            const { retry_after = 2 } = await res.json().catch(() => ({}));
            await new Promise((r) => setTimeout(r, retry_after * 1000 + 250));
            continue;
        }
        throw new Error(`Discord answered ${res.status}: ${await res.text()}`);
    }
    throw new Error('Discord kept rate limiting');
}

// ---- Add On of the Day (Slack) --------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The date (`YYYY-MM-DD`) and hour (0-23) at `date` in `timeZone`. */
export function localNow(date, timeZone) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/**
 * Today's pick: at random from the listed Add Ons not yet featured this round. When every
 * one has had a turn a new round starts, never with the one just shown. Add Ons approved
 * mid-round join it. Returns `{ repo, featured }`, `featured` being the round with it added.
 */
export function pickOfTheDay(listed, featured = [], random = Math.random) {
    let round = featured.filter((r) => listed.includes(r));
    let pool = listed.filter((r) => !round.includes(r));
    if (!pool.length) {
        round = [];
        pool = listed.length > 1 ? listed.filter((r) => r !== featured.at(-1)) : listed;
    }
    const repo = pool[Math.floor(random() * pool.length)];
    return { repo, featured: [...round, repo] };
}

/**
 * The Slack incoming-webhook message featuring one listing: `{ payload }`. Slack webhooks
 * cannot upload files, so there is no icon. `mention` (`<!here>`, `<!subteam^ID>`) leads it.
 */
export function buildDailyMessage(repo, release, addOns, mention) {
    const owner = repo.split('/')[0];
    const list = addOns.length ? addOns.slice(0, 10) : [{ name: repo.split('/')[1], description: '', categories: [] }];
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: 'Add On of the Day' } }];
    for (const a of list) {
        const by = esc(a.manufacturer || owner);
        const body = a.description || cleanNotes(release.body);
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*<${release.html_url}|${esc(a.name)}>*  by ${by}\n${esc(body)}`, 3000) } });
        const facts = [esc(a.version || release.tag_name || '')].filter(Boolean);
        if (a.categories.length) facts.push(esc(a.categories.join(', ')));
        if (a.minLuna) facts.push(`Needs LUNA ${esc(a.minLuna)}+`);
        if (facts.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: facts.join('  ·  ') }] });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Install it from LUNA › Add Ons › Discover' }] });
    const names = list.map((a) => a.name).join(', ');
    return { payload: { text: `${mention ? `${mention} ` : ''}Add On of the Day: ${names}`, blocks } };
}

async function postSlack(webhook, { payload }) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.ok) return;
        if (res.status === 429) {
            await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2) * 1000 + 250));
            continue;
        }
        throw new Error(`Slack answered ${res.status}: ${await res.text()}`);
    }
    throw new Error('Slack kept rate limiting');
}

/**
 * Posts today's Add On once, on the first run at or after DAILY_HOUR, so a late or skipped
 * schedule still posts that day. DAILY_FORCE=1 posts now regardless.
 */
async function addOnOfTheDay(env, state, current, release, dryRun) {
    const force = env.DAILY_FORCE === '1';
    const { day, hour } = localNow(new Date(), env.DAILY_TZ || 'America/Los_Angeles');
    const daily = (state.daily ??= { last_day: null, featured: [] });
    if (!force && (daily.last_day === day || hour < Number(env.DAILY_HOUR || 9))) return;
    const { repo, featured } = pickOfTheDay(Object.keys(current).sort(), daily.featured);
    console.log(`add on of the day: ${repo}`);
    const { release: r, addOns } = await release({ repo, tag: current[repo] });
    const message = buildDailyMessage(repo, r, addOns, env.SLACK_MENTION);
    if (dryRun) console.log(JSON.stringify(message.payload, null, 2));
    else await postSlack(env.SLACK_WEBHOOK_URL, message);
    Object.assign(daily, { last_day: day, featured });
}

// ---- main ----------------------------------------------------------------

/** Where to post, from env. Each target remembers what it announced on its own. */
function targetsFromEnv(env, dryRun) {
    const all = {
        discord: { url: env.DISCORD_WEBHOOK_URL, build: (c, r, a) => buildMessage(c, r, a, env.DISCORD_ROLE_ID), send: post },
    };
    return Object.fromEntries(Object.entries(all).filter(([, t]) => dryRun || t.url));
}

/**
 * state.json is `{ targets: { <name>: { "owner/repo": tag } }, daily? }`. An older
 * `{ listings }` is Discord's. A target with no record yet starts from what is listed now,
 * so turning it on does not announce everything at once.
 */
export function prepareState(saved, current, names, announceExisting = false) {
    const targets = { ...(saved?.targets ?? (saved?.listings ? { discord: saved.listings } : {})) };
    const seeded = [];
    for (const name of names) {
        if (targets[name]) continue;
        targets[name] = saved || !announceExisting ? { ...current } : {};
        if (saved || !announceExisting) seeded.push(name);
    }
    return { state: { targets }, seeded };
}

export async function main(env = process.env) {
    const stateFile = env.STATE_FILE ?? new URL('./state.json', import.meta.url);
    const dryRun = env.DRY_RUN === '1';
    const targets = targetsFromEnv(env, dryRun);
    const daily = dryRun || Boolean(env.SLACK_WEBHOOK_URL);
    if (!Object.keys(targets).length && !daily) throw new Error('Set DISCORD_WEBHOOK_URL and/or SLACK_WEBHOOK_URL');

    const current = listingsFromManifest(await get(MANIFEST_URL));
    if (!Object.keys(current).length) throw new Error('Discover manifest listed no Add Ons; not trusting it');

    let saved = null;
    try { saved = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* first run */ }
    const { state, seeded } = prepareState(saved, current, Object.keys(targets), env.ANNOUNCE_EXISTING === '1');
    for (const name of seeded) console.log(`${name}: recorded ${Object.keys(current).length} Add Ons without posting.`);
    const save = async () => { if (!dryRun) await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`); };

    const releases = new Map();
    const release = (c) => {
        const key = `${c.repo}@${c.tag}`;
        if (!releases.has(key)) releases.set(key, loadRelease(c.repo, c.tag));
        return releases.get(key);
    };
    let failed = 0;
    for (const [name, target] of Object.entries(targets)) {
        const sent = state.targets[name];
        const changes = diffListings(sent, current);
        // Take-downs leave quietly, so a relisting announces again.
        for (const repo of Object.keys(sent)) if (!(repo in current)) delete sent[repo];
        console.log(`${name}: ${changes.length ? `${changes.length} change(s)` : 'no changes'}`);
        for (const change of changes) {
            console.log(`- ${change.kind}: ${change.repo} ${change.tag}`);
            try {
                const { release: r, addOns } = await release(change);
                const message = target.build(change, r, addOns);
                if (dryRun) console.log(JSON.stringify(message.payload, null, 2));
                else await target.send(target.url, message);
                sent[change.repo] = change.tag;
            } catch (err) {
                failed++;
                console.error(`  failed, will retry next run: ${err.message}`);
            }
        }
    }
    state.daily = saved?.daily;
    if (daily) {
        try {
            await addOnOfTheDay(env, state, current, release, dryRun);
        } catch (err) {
            failed++;
            console.error(`  add on of the day failed, will retry next run: ${err.message}`);
        }
    }
    await save();
    if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => { console.error(err.message); process.exit(1); });
}
