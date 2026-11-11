import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const Bucket = process.env.R2_BUCKET;
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const prefix = 'research-v1/';
const replica = prefix + 'build-replica/';
const manifestPattern = /^research-v1\/(?:build-replica\/|sources\/[a-z]{20}\/)?manifests\/([a-f0-9]{64})\.json$/;
const started = Date.now();
async function list(Prefix) {
  const entries = [];
  let ContinuationToken;
  do {
    const response = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    entries.push(...response.Contents ?? []);
    ContinuationToken = response.NextContinuationToken;
    assert(!response.IsTruncated || ContinuationToken);
  } while (ContinuationToken);
  return entries;
}
async function read(Key) {
  const response = await client.send(new GetObjectCommand({ Bucket, Key }));
  return Buffer.from(await response.Body.transformToByteArray());
}
const parsed = new Map();
async function scanManifests(objects) {
  const pending = objects.filter(({Key}) => Key.startsWith(replica + 'manifests/') && !parsed.has(Key));
  console.log('Replica manifests to read: ' + pending.length);
  for (let offset = 0; offset < pending.length; offset += 32) {
    await Promise.all(pending.slice(offset, offset + 32).map(async ({Key}) => {
    assert(manifestPattern.test(Key), 'unexpected replica manifest key');
    const body = await read(Key);
    assert.equal(createHash('sha256').update(body).digest('hex'), Key.match(manifestPattern)[1]);
    const manifest = JSON.parse(body);
    assert(manifest.format === 1 && Array.isArray(manifest.chunks));
    parsed.set(Key, manifest.chunks.map(chunk => {
      assert(/^[a-f0-9]{64}$/.test(chunk.hash));
      return chunk.hash;
    }));
    }));
  }
}
let inventory = await list(prefix);
let objects, active;
for (let attempt = 0; attempt < 4; attempt++) {
  await scanManifests(inventory);
  const roots = inventory.filter(({Key}) => /^research-v1\/build-replica\/[a-z]{20}\/latest\.json$/.test(Key));
  assert(roots.length >= 2, 'expected B/C replica roots');
  const pointers = await Promise.all(roots.map(async ({Key}) => [Key, await read(Key)]));
  const after = await list(prefix);
  const refs = new Set(pointers.map(([, bytes]) => prefix + JSON.parse(bytes).manifest));
  const pointersStable = (await Promise.all(pointers.map(async ([key, bytes]) => (await read(key)).equals(bytes)))).every(Boolean);
  const listed = new Set(after.filter(({Key}) => Key.startsWith(replica + 'manifests/')).map(({Key}) => Key));
  if (pointersStable && [...refs].every(key => listed.has(key)) && [...listed].every(key => parsed.has(key))) {
    objects = after;
    active = refs;
    break;
  }
  inventory = after;
}
assert(objects && active, 'manifest references did not settle');
const currentKeys = new Set(objects.map(object => object.Key));
const replicaManifests = objects.filter(({Key}) => Key.startsWith(replica + 'manifests/'));
// Research archives resolve shard and sourceObject hashes in their own objects/ prefix.
const archiveManifests = objects.filter(({Key}) => manifestPattern.test(Key) && !Key.startsWith(replica));
const chunkKey = hash => replica + 'objects/' + hash + '.jsonl.gz';
const referenced = new Set();
const latestRefs = new Set();
for (const {Key} of replicaManifests) {
  for (const hash of parsed.get(Key)) {
    const key = chunkKey(hash);
    referenced.add(key);
    if (active.has(Key)) latestRefs.add(key);
  }
}
const chunks = objects.filter(object => /^research-v1\/build-replica\/objects\/[a-f0-9]{64}\.jsonl\.gz$/.test(object.Key));
const unreferenced = chunks.filter(object => !referenced.has(object.Key));
const sum = entries => ({ count: entries.length, bytes: entries.reduce((n, object) => n + object.Size, 0) });
console.log('R2_AUDIT ' + JSON.stringify({
  started: new Date(started), finished: new Date(), archiveManifests: archiveManifests.length, replicaManifests: replicaManifests.length,
  activeReplicaManifests: active.size,
  replicaChunks: sum(chunks), latestReferenced: sum(chunks.filter(object => latestRefs.has(object.Key))),
  historicalOnly: sum(chunks.filter(object => referenced.has(object.Key) && !latestRefs.has(object.Key))),
  missingReferencedChunks: [...referenced].filter(key => !currentKeys.has(key)).length,
  unreferenced: sum(unreferenced),
  unreferencedOlderThan7Days: sum(unreferenced.filter(object => started - object.LastModified.getTime() > 7 * 86400000)),
  queryCacheWithoutManifest: sum(objects.filter(object => object.Key.startsWith(prefix + 'build-cache/v1/'))),
}));
