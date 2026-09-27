// Хранение байтов фотографий в Workers KV.
//
// R2 в этом аккаунте не включён и требует оплаты, поэтому фото лежат в KV.
// Отличия KV от R2, которые важны здесь:
//
//   * значение KV ограничено 25 МБ — наши кадры до 3 МБ, запас достаточный;
//   * у значения нет полей httpMetadata/customMetadata, поэтому тип файла,
//     размер и автор хранятся в записи индекса, а не рядом с байтами.
//
// Байты кладутся «как есть», без base64: KV принимает ArrayBuffer и отдаёт
// его же, поэтому наши 3 МБ занимают ровно 3 МБ, а не 4 МБ. Это проверено
// на живом воркере скриптом worker/tools/verify_blob.mjs.
//
// Отдельного префикса для ключей нет: BLOBS, STATE и INDEX — разные базы,
// поэтому photo:<placeId>:<userId>.<ext> не может пересечься с state:<userId>
// из соседнего хранилища.

// Основные операции над байтами фотографии.
export async function putBlob(env, objectKey, bytes) {
  await env.BLOBS.put(objectKey, bytes);
}

export async function getBlob(env, objectKey) {
  const value = await env.BLOBS.get(objectKey, "arrayBuffer");
  return value ? new Uint8Array(value) : null;
}

export async function deleteBlob(env, objectKey) {
  await env.BLOBS.delete(objectKey);
}
