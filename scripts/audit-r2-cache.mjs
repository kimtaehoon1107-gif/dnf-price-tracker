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
const objects = await list(prefix);
const currentKeys = new Map(objects.map(object => [object.Key, object]));
const manifests = objects.filter(object => manifestPattern.test(object.Key));
const roots = objects.filter(object => /^research-v1\/build-replica\/[a-z]{20}\/latest\.json$/.test(object.Key));
assert(roots.length >= 2, 'expected B/C replica roots');
const pointers = await Promise.all(roots.map(async ({Key}) => [Key, await read(Key)]));
const active = new Set(pointers.map(([, bytes]) => prefix + JSON.parse(bytes).manifest));
for (const key of active) assert(key.startsWith(replica + 'manifests/') && currentKeys.has(key));
const referenced = new Set();
const latestRefs = new Set();
let archiveManifests = 0;
let replicaManifests = 0;
for (let offset = 0; offset < manifests.length; offset += 12) {
  await Promise.all(manifests.slice(offset, offset + 12).map(async ({Key}) => {
    const body = await read(Key);
    assert.equal(createHash('sha256').update(body).digest('hex'), Key.match(manifestPattern)[1]);
    const manifest = JSON.parse(body);
    const folder = Key.slice(0, Key.lastIndexOf('manifests/'));
    const isReplica = folder === replica;
    const shards = isReplica ? manifest.chunks : manifest.shards;
    assert(manifest.format === 1 && Array.isArray(shards));
    if (isReplica) replicaManifests++; else archiveManifests++;
    for (const shard of shards) {
      for (const entry of [shard, shard.sourceObject].filter(Boolean)) {
        assert(/^[a-f0-9]{64}$/.test(entry.hash));
        const key = folder + 'objects/' + entry.hash + '.jsonl.gz';
        if (isReplica) referenced.add(key);
        if (active.has(Key)) latestRefs.add(key);
      }
    }
  }));
}
assert(replicaManifests >= active.size && archiveManifests > 0);
const after = await list(prefix);
assert.deepEqual(after.filter(object => manifestPattern.test(object.Key)).map(object => object.Key),
  manifests.map(object => object.Key), 'manifest list changed during audit');
for (const [key, bytes] of pointers) assert((await read(key)).equals(bytes), 'latest pointer changed during audit');
const chunks = objects.filter(object => /^research-v1\/build-replica\/objects\/[a-f0-9]{64}\.jsonl\.gz$/.test(object.Key));
const unreferenced = chunks.filter(object => !referenced.has(object.Key));
const sum = entries => ({ count: entries.length, bytes: entries.reduce((n, object) => n + object.Size, 0) });
console.log('R2_AUDIT ' + JSON.stringify({
  started: new Date(started), finished: new Date(), archiveManifests, replicaManifests,
  activeReplicaManifests: active.size,
  replicaChunks: sum(chunks), latestReferenced: sum(chunks.filter(object => latestRefs.has(object.Key))),
  historicalOnly: sum(chunks.filter(object => referenced.has(object.Key) && !latestRefs.has(object.Key))),
  missingReferencedChunks: [...referenced].filter(key => !currentKeys.has(key)).length,
  unreferenced: sum(unreferenced),
  unreferencedOlderThan7Days: sum(unreferenced.filter(object => started - object.LastModified.getTime() > 7 * 86400000)),
  queryCacheWithoutManifest: sum(objects.filter(object => object.Key.startsWith(prefix + 'build-cache/v1/'))),
}));
