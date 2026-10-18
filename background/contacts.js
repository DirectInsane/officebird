// Address book photo lookup (MV2 `contacts` API), memoized per address.

const memo = new Map();
const AVATAR_PX = 64;

async function toAvatarDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const scale = AVATAR_PX / Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (AVATAR_PX - w) / 2, (AVATAR_PX - h) / 2, w, h);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

async function findPhoto(email) {
  const nodes = await messenger.contacts.quickSearch({ searchString: email, includeRemote: false });
  for (const node of nodes) {
    const props = node.properties || {};
    const addresses = [props.PrimaryEmail, props.SecondEmail].filter(Boolean).map(a => a.toLowerCase());
    if (!addresses.includes(email)) {
      continue;
    }
    const file = await messenger.contacts.getPhoto(node.id);
    if (file) {
      return toAvatarDataUrl(file);
    }
  }
  return null;
}

// `email` must already be lowercased.
export function lookupContactPhoto(email) {
  if (!memo.has(email)) {
    memo.set(email, findPhoto(email).catch(() => null));
  }
  return memo.get(email);
}

export function clearContactPhotoCache() {
  memo.clear();
}
