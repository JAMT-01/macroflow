import { dateInTimeZone } from '../shared/time';
import { getSettings } from './db';

/**
 * Body progress photos.
 *
 * macros.md §10 asks for a photo every 4 weeks under fixed conditions, as the
 * check on what the scale cannot show. This stores those photos and pairs each
 * one with the bodyweight at the time it was taken.
 *
 * These are NOT meal photos and must never be treated as such. The two rules
 * that keep them apart:
 *
 *   1. They live under the KV prefix `progress/`, never `uploads/`. Meal
 *      deletion (worker/index.ts) filters on `/uploads/` before deleting KV
 *      objects, so it cannot reach these.
 *   2. Nothing here ever calls OpenRouter. Meal photos are uploaded to a
 *      third-party model by design; a body photo has no reason to leave
 *      Cloudflare, so no code path in this module gives it one.
 *
 * Wire up in worker/index.ts — see PROGRESS-PHOTOS.md §2.
 */

/** Declared locally, as worker/push.ts and worker/reminders.ts do — there is no
 *  generated `worker-configuration.d.ts` in the tree yet. */
interface Env {
  DB: D1Database;
  PHOTOS: KVNamespace;
}

export const POSES = ['front', 'side', 'back'] as const;
export type Pose = (typeof POSES)[number];

/** KV prefix. The trailing slash is load-bearing — see isProgressPath. */
const KV_PREFIX = 'progress/';

/** Public URL prefix. Deliberately not `/uploads/`, which serves meal photos. */
const URL_PREFIX = '/progress-photos/';

/**
 * Matches /api/analyze's cap. Client-side downscaling (worker/progress-assets.ts)
 * means a real upload is ~200-400 kB, so this only ever catches a client that
 * failed to resize — it is a backstop, not the expected size.
 */
const MAX_BYTES = 15 * 1024 * 1024;

export interface ProgressPhoto {
  id: string;
  takenAt: string;
  takenDate: string;
  pose: Pose;
  imagePath: string;
  weightKg: number | null;
  notes: string;
}

export function isPose(value: unknown): value is Pose {
  return typeof value === 'string' && (POSES as readonly string[]).includes(value);
}

/**
 * True only for paths this module minted. Used to refuse a client-supplied path
 * that points somewhere else in KV — the same class of check that keeps meal
 * deletion off these objects.
 */
export function isProgressPath(imagePath: string): boolean {
  return imagePath.startsWith(URL_PREFIX) && !imagePath.slice(URL_PREFIX.length).includes('/');
}

/** '/progress-photos/x.jpg' -> 'progress/x.jpg'. */
export function progressKvKey(imagePath: string): string {
  return KV_PREFIX + imagePath.slice(URL_PREFIX.length);
}

/** The filename component of a request to GET /progress-photos/:key. */
export function progressKvKeyFromParam(key: string): string {
  return KV_PREFIX + key;
}

/**
 * Store the bytes, then the row.
 *
 * Order matters. Bytes first means a crash between the two leaves an unreferenced
 * KV object — invisible, and reclaimable by the sweep in §5 of the doc. Row first
 * would leave a row pointing at nothing, which renders as a broken image in the
 * gallery and looks like data loss.
 */
export async function saveProgressPhoto(
  env: Env,
  input: {
    bytes: ArrayBuffer;
    contentType: string;
    pose: Pose;
    takenAt?: string;
    weightKg?: number | null;
    notes?: string;
  }
): Promise<ProgressPhoto> {
  if (input.bytes.byteLength > MAX_BYTES) throw new Error('That photo is larger than 15 MB');
  if (!input.contentType.startsWith('image/')) throw new Error('Only image uploads are supported');

  const settings = await getSettings(env);

  // new Date('nonsense').toISOString() throws RangeError, which would surface as
  // a 500 on an otherwise fine upload. The capture instant is not worth losing a
  // photo over, so an unparseable one falls back to now.
  const parsed = input.takenAt ? new Date(input.takenAt) : new Date();
  const takenAt = (Number.isNaN(parsed.getTime()) ? new Date() : parsed).toISOString();

  const extension = input.contentType === 'image/png' ? 'png' : 'jpg';
  const id = crypto.randomUUID();
  const imagePath = `${URL_PREFIX}${id}.${extension}`;

  // Fall back to settings.weight_kg, which POST /api/weight keeps current. A
  // photo logged right after the morning weigh-in then carries the right number
  // without the client having to send it.
  const weightKg =
    input.weightKg === undefined || input.weightKg === null
      ? (settings.weight_kg as number | null) ?? null
      : input.weightKg;

  await env.PHOTOS.put(progressKvKey(imagePath), input.bytes, {
    metadata: { contentType: input.contentType },
  });

  const photo: ProgressPhoto = {
    id,
    takenAt,
    takenDate: dateInTimeZone(takenAt, settings.timezone),
    pose: input.pose,
    imagePath,
    weightKg,
    notes: (input.notes ?? '').trim(),
  };

  await env.DB.prepare(
    `INSERT INTO progress_photos (id, taken_at, taken_date, pose, image_path, weight_kg, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(photo.id, photo.takenAt, photo.takenDate, photo.pose, photo.imagePath, photo.weightKg, photo.notes)
    .run();

  return photo;
}

/** Newest first. Metadata only — the bytes are fetched per-image by the gallery. */
export async function listProgressPhotos(env: Env, limit = 500): Promise<ProgressPhoto[]> {
  const result = await env.DB.prepare(
    `SELECT id, taken_at AS takenAt, taken_date AS takenDate, pose,
            image_path AS imagePath, weight_kg AS weightKg, notes
       FROM progress_photos
      ORDER BY taken_at DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<ProgressPhoto>();
  return result.results ?? [];
}

export async function getProgressPhotoBytes(
  env: Env,
  key: string
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const result = await env.PHOTOS.getWithMetadata<{ contentType?: string }>(
    progressKvKeyFromParam(key),
    'arrayBuffer'
  );
  if (!result.value) return null;
  return { bytes: result.value, contentType: result.metadata?.contentType || 'image/jpeg' };
}

/**
 * Delete the bytes, then the row — the reverse of save, and deliberately the
 * reverse of how DELETE /api/meals/:id does it.
 *
 * For a body photo the guarantee that matters is "when I delete it, the image is
 * gone". Bytes first delivers that even if the second statement fails; the worst
 * case is a row rendering a broken thumbnail, which the user can delete again.
 * Row first would invert it: the photo vanishes from the UI while the bytes stay
 * in KV with nothing left pointing at them to ever clean them up.
 */
export async function deleteProgressPhoto(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT image_path AS imagePath FROM progress_photos WHERE id = ?')
    .bind(id)
    .first<{ imagePath: string }>();
  if (!row) return false;

  if (isProgressPath(row.imagePath)) await env.PHOTOS.delete(progressKvKey(row.imagePath));
  await env.DB.prepare('DELETE FROM progress_photos WHERE id = ?').bind(id).run();
  return true;
}
