// Photo and document evidence, stored in the private `evidence` bucket.
//
// Files go under <mine_id>/<kind>/..., and that folder is exactly what the
// storage policies check (migration 07): people can add and read evidence
// for their own mine only, and nobody can overwrite or delete it.
//
// Photos are shrunk on the device before upload. A phone camera produces
// 4-8 MB images; over a weak signal at a pit head that is the difference
// between a record that arrives and one that never does. 1600px on the
// long side keeps a defect clearly legible at a fraction of the size.
import { supabase } from "./supabase";

const BUCKET = "evidence";

export async function compressImage(file, maxSide = 1600, quality = 0.72) {
  if (!file || !file.type?.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;   // an unreadable image is uploaded as-is rather than lost
  }
}

function randomId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Uploads a file or blob; returns its storage path. */
export async function uploadEvidence(mineId, kind, fileOrBlob) {
  if (!mineId) throw new Error("No mine to file this evidence under.");
  const isPdf = fileOrBlob.type === "application/pdf";
  const body = isPdf ? fileOrBlob : await compressImage(fileOrBlob);
  const ext = isPdf ? "pdf" : (body.type === "image/png" ? "png" : "jpg");
  const path = `${mineId}/${kind}/${new Date().toISOString().slice(0, 10)}/${randomId()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    contentType: body.type || (isPdf ? "application/pdf" : "image/jpeg"),
    upsert: false,
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

/** A short-lived link to view a stored file. */
export async function evidenceUrl(path, seconds = 600) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error) throw new Error(error.message);
  return data?.signedUrl || null;
}
