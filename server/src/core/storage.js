/**
 * Firebase Storage helper for customer avatars.
 *
 * The previous disk-based upload path (multer -> local ./uploads directory)
 * cannot work on Cloud Functions, whose filesystem is read-only apart from
 * /tmp and does not survive between invocations. Avatars are instead written
 * to Cloud Storage and served from the public read-only download URL.
 *
 * Storage rules allow public reads of `avatars/*` but deny all client writes
 * (see storage.rules); only this server, running with admin credentials, can
 * upload. The download URL carries a `firebaseStorageDownloadTokens` value so
 * it works even when the bucket has uniform bucket-level access enabled.
 */

import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { config } from './config.js';
import { initFirestore } from '../db/firestore.js';

let bucketHandle = null;

function bucket() {
  if (bucketHandle) return bucketHandle;
  initFirestore(); // guarantees a Firebase app exists before getStorage()
  const name = config.firebase.storageBucket;
  bucketHandle = name ? getStorage().bucket(name) : getStorage().bucket();
  return bucketHandle;
}

const AVATAR_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

/** Whether a declared MIME type is an accepted avatar image. */
export function isAllowedAvatarType(contentType) {
  return AVATAR_EXTENSIONS.has(contentType);
}

export function avatarExtension(contentType) {
  return AVATAR_EXTENSIONS.get(contentType) ?? null;
}

function downloadUrlFor(objectPath, token) {
  const name = bucket().name;
  return `https://firebasestorage.googleapis.com/v0/b/${name}/o/${encodeURIComponent(
    objectPath,
  )}?alt=media&token=${token}`;
}

/**
 * Store an avatar and return its public download URL.
 *
 * The object path is generated server-side and never derived from user input,
 * so a renamed `.svg`/`.exe` cannot influence where bytes land or their name.
 *
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {Promise<{ url: string, path: string }>}
 */
export async function uploadAvatar(buffer, contentType) {
  const extension = avatarExtension(contentType);
  if (!extension) throw new Error(`Unsupported avatar type: ${contentType}`);

  const objectPath = `avatars/${randomUUID()}${extension}`;
  const token = randomUUID();

  await bucket()
    .file(objectPath)
    .save(buffer, {
      contentType,
      resumable: false,
      metadata: {
        metadata: { firebaseStorageDownloadTokens: token },
        cacheControl: 'public, max-age=604800',
      },
    });

  return { url: downloadUrlFor(objectPath, token), path: objectPath };
}

/**
 * Best-effort delete of a previously stored avatar given its download URL.
 * Failure is deliberately swallowed: a stale avatar is cosmetic and must never
 * fail the upload that superseded it.
 */
export async function deleteAvatarByUrl(url) {
  if (!url) return;
  const marker = '/o/';
  const at = url.indexOf(marker);
  if (at === -1 || !url.startsWith('https://firebasestorage.googleapis.com/')) return;

  const rest = url.slice(at + marker.length);
  const query = rest.indexOf('?');
  const objectPath = decodeURIComponent(query === -1 ? rest : rest.slice(0, query));

  try {
    await bucket().file(objectPath).delete();
  } catch {
    /* ignore */
  }
}
