/**
 * Blob storage for packs made in the editor.
 * - S3-compatible bucket (Cloudflare R2, Supabase Storage, AWS…) when S3_BUCKET is set — survives restarts and deploys.
 * - Local folder DATA_DIR (default ./data) otherwise — fine for development.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface BlobStore {
  readonly kind: 'local' | 's3';
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Local: absolute file path to send. S3: a short-lived signed URL to redirect to. */
  locate(key: string): Promise<{ file: string } | { url: string } | null>;
}

class LocalStore implements BlobStore {
  readonly kind = 'local' as const;
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }
  private abs(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('bad key');
    return p;
  }
  async list(prefix: string) {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else out.push(path.relative(this.root, p).split(path.sep).join('/'));
      }
    };
    walk(this.abs(prefix.replace(/\/$/, '') || '.'));
    return out;
  }
  async get(key: string) {
    const p = this.abs(key);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  async put(key: string, body: Buffer | Readable) {
    const p = this.abs(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    if (Buffer.isBuffer(body)) fs.writeFileSync(tmp, body);
    else await pipeline(body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, p);
  }
  async deletePrefix(prefix: string) {
    fs.rmSync(this.abs(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  }
  async locate(key: string) {
    const p = this.abs(key);
    return fs.existsSync(p) ? { file: p } : null;
  }
}

class S3Store implements BlobStore {
  readonly kind = 's3' as const;
  private s3: S3Client;
  constructor(private bucket: string) {
    this.s3 = new S3Client({
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '' },
    });
  }
  async list(prefix: string) {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async get(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }
  async put(key: string, body: Buffer | Readable, contentType: string) {
    await new Upload({ client: this.s3, params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType } }).done();
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000)
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
  }
  async locate(key: string) {
    return { url: await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 6 * 3600 }) };
  }
}

export const store: BlobStore = process.env.S3_BUCKET ? new S3Store(process.env.S3_BUCKET) : new LocalStore(path.resolve(process.env.DATA_DIR ?? 'data'));
