import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { listingsFromManifest, diffListings, unzip, addOnsFromPackage, buildMessage, buildSlackMessage, cleanNotes, prepareState } from './notify.mjs';

/** A minimal zip writer, so tests need no fixtures. `deflate` picks method 8 for every file. */
function zip(files, { deflate = false } = {}) {
    const locals = [];
    const dir = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content);
        const body = deflate ? deflateRawSync(data) : data;
        const nameBuf = Buffer.from(name);
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(deflate ? 8 : 0, 8);
        h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameBuf.length, 26);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(deflate ? 8 : 0, 10);
        c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
        c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
        locals.push(h, nameBuf, body);
        dir.push(c, nameBuf);
        offset += 30 + nameBuf.length + body.length;
    }
    const dirBuf = Buffer.concat(dir);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(dir.length / 2, 8); end.writeUInt16LE(dir.length / 2, 10);
    end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dirBuf, end]);
}

test('listings: lowercase owner/repo, tolerant of .git and trailing slash, skips junk', () => {
    const got = listingsFromManifest({
        add_ons: [
            { github: 'https://github.com/UAudio-Labs/Video-Window', tag: '0.1.4' },
            { github: 'https://github.com/a/b.git', tag: 'v1' },
            { github: 'https://github.com/c/d/', tag: '2' },
            { github: 'https://example.com/x/y', tag: '1' },
            { github: 'https://github.com/e/f' },
        ],
    });
    assert.deepEqual(got, { 'uaudio-labs/video-window': '0.1.4', 'a/b': 'v1', 'c/d': '2' });
});

test('diff: new and retagged, not unchanged or removed', () => {
    const changes = diffListings({ 'a/a': '1', 'b/b': '1', 'gone/x': '1' }, { 'a/a': '1', 'b/b': '2', 'c/c': '1' });
    assert.deepEqual(changes, [
        { repo: 'b/b', tag: '2', kind: 'updated', previousTag: '1' },
        { repo: 'c/c', tag: '1', kind: 'new' },
    ]);
});

test('unzip reads stored and deflated files, skipping folders', () => {
    for (const deflate of [false, true]) {
        const files = unzip(zip({ 'x/': '', 'x/a.txt': 'hello', 'x/b.txt': 'world'.repeat(50) }, { deflate }));
        assert.deepEqual(Object.keys(files), ['x/a.txt', 'x/b.txt']);
        assert.equal(files['x/a.txt'].toString(), 'hello');
        assert.equal(files['x/b.txt'].toString(), 'world'.repeat(50));
    }
});

test('single Add On package: fields and PNG icon', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const addOns = addOnsFromPackage(zip({
        'vw/manifest.json': JSON.stringify({
            id: 'com.uaudio.video_window', name: 'Video Window', version: '0.1.4',
            description: ['Plays a video ', 'in sync.'], manufacturer: 'Universal Audio',
            categories: ['Utility'], min_luna_version: '3.1.1', icon: 'icon.png', html: 'index.html',
        }),
        'vw/icon.png': png,
    }));
    assert.equal(addOns.length, 1);
    const [a] = addOns;
    assert.equal(a.name, 'Video Window');
    assert.equal(a.description, 'Plays a video in sync.');
    assert.deepEqual(a.categories, ['Utility']);
    assert.equal(a.minLuna, '3.1.1');
    assert.deepEqual(a.icon, { name: 'icon.png', type: 'image/png', data: png });
});

test('add_ons package: entries inherit top-level fields; SVG icons are dropped', () => {
    const addOns = addOnsFromPackage(zip({
        'p/manifest.json': JSON.stringify({
            package_name: 'Pack', manufacturer: 'CP', description: 'Shared', categories: ['MIDI'],
            add_ons: [
                { id: 'a', name: 'One', icon: 'one.svg' },
                { id: 'b', name: 'Two', description: 'Own', manufacturer: 'Other' },
            ],
        }),
        'p/one.svg': '<svg/>',
    }));
    assert.deepEqual(addOns.map((a) => [a.name, a.description, a.manufacturer, a.categories, a.icon]), [
        ['One', 'Shared', 'CP', ['MIDI'], null],
        ['Two', 'Own', 'Other', ['MIDI'], null],
    ]);
});

test('cleanNotes drops GitHub draft comments', () => {
    assert.equal(cleanNotes('<!-- Draft hint -->\r\n\r\n- Fix\r\n\n\n\n- More'), '- Fix\n\n- More');
});

const release = { html_url: 'https://github.com/o/r/releases/tag/1.0', body: 'Notes', published_at: '2026-11-20T00:00:00Z' };
const addOn = { name: 'Thing', description: 'Does things', manufacturer: '', version: '1.0', categories: ['Utility'], minLuna: '3.1.1', icon: { name: 'icon.png', type: 'image/png', data: Buffer.from('x') } };

test('new message: pings the role, attaches the icon, links the release', () => {
    const { payload, files } = buildMessage({ repo: 'o/r', tag: '1.0', kind: 'new' }, release, [addOn], '123');
    assert.match(payload.content, /^<@&123> /);
    assert.deepEqual(payload.allowed_mentions, { roles: ['123'] });
    const [e] = payload.embeds;
    assert.equal(e.title, 'New in Discover: Thing');
    assert.equal(e.url, release.html_url);
    assert.equal(e.description, 'Does things');
    assert.equal(e.fields.find((f) => f.name === 'By').value, 'o');
    assert.equal(e.thumbnail.url, 'attachment://icon-0.png');
    assert.deepEqual(files.map((f) => f.name), ['icon-0.png']);
    assert.deepEqual(payload.attachments, [{ id: 0, filename: 'icon-0.png' }]);
});

test('update message: shows the version change and release notes, never pings', () => {
    const { payload } = buildMessage({ repo: 'o/r', tag: '1.1', kind: 'updated', previousTag: '1.0' }, release, [{ ...addOn, version: '1.1', icon: null }], '123');
    assert.equal(payload.content, undefined);
    assert.deepEqual(payload.allowed_mentions, { roles: [] });
    const [e] = payload.embeds;
    assert.equal(e.title, 'Updated: Thing 1.1');
    assert.equal(e.description, 'Notes');
    assert.equal(e.fields.find((f) => f.name === 'Version').value, '1.0 → 1.1');
    assert.equal(e.thumbnail, undefined);
});

test('a release with no readable package still gets a post', () => {
    const { payload } = buildMessage({ repo: 'o/cool-tool', tag: '1.0', kind: 'new' }, release, [], undefined);
    assert.equal(payload.embeds[0].title, 'New in Discover: cool-tool');
    assert.equal(payload.content, 'A new Add On is in Discover');
});

test('state: old { listings } becomes Discord\'s; a new target starts from what is listed now', () => {
    const current = { 'a/a': '1', 'b/b': '1' };
    const { state, seeded } = prepareState({ listings: { 'a/a': '1' } }, current, ['discord', 'slack']);
    assert.deepEqual(state.targets, { discord: { 'a/a': '1' }, slack: current });
    assert.deepEqual(seeded, ['slack']);
    // Discord still owes b/b; Slack owes nothing.
    assert.deepEqual(diffListings(state.targets.discord, current).map((c) => c.repo), ['b/b']);
    assert.deepEqual(diffListings(state.targets.slack, current), []);
});

test('state: first run seeds every target, unless announcing existing', () => {
    const current = { 'a/a': '1' };
    assert.deepEqual(prepareState(null, current, ['discord', 'slack']).state.targets, { discord: current, slack: current });
    const { state, seeded } = prepareState(null, current, ['slack'], true);
    assert.deepEqual(state.targets, { slack: {} });
    assert.deepEqual(seeded, []);
});

test('slack message: linked title, escaped text, facts, mention on new only', () => {
    const a = { ...addOn, name: 'A<b>', description: 'x & y' };
    const { payload } = buildSlackMessage({ repo: 'o/r', tag: '1.0', kind: 'new' }, release, [a], '<!channel>');
    assert.equal(payload.text, '<!channel> A new Add On is in Discover: A<b>');
    assert.equal(payload.blocks[0].text.text, `*<${release.html_url}|New in Discover: A&lt;b&gt;>*\nx &amp; y`);
    assert.equal(payload.blocks[1].elements[0].text, 'By *o*  ·  1.0  ·  Utility  ·  Needs LUNA 3.1.1+');
    const upd = buildSlackMessage({ repo: 'o/r', tag: '1.1', kind: 'updated', previousTag: '1.0' }, release, [{ ...addOn, version: '1.1' }], '<!channel>');
    assert.equal(upd.payload.text, 'Updated in Discover: Thing');
    assert.match(upd.payload.blocks[1].elements[0].text, /1\.0 → 1\.1/);
});
