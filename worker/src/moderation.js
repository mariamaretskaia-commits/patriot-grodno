// Права модератора.
//
// Список модераторов приходит секретом MODERATOR_IDS (через
// `wrangler secret put MODERATOR_IDS`) и представляет собой перечисление
// числовых Telegram-id через запятую. В wrangler.jsonc он намеренно не
// лежит: репозиторий публичный, и id модератора там увидят все.
//
// Значение читается на каждый авторизованный запрос. Список короткий, а
// кешировать его нельзя: выход модератора из числа проверяющих должен
// действовать сразу после смены секрета.
export function isModerator(userId, env) {
  const raw = env && env.MODERATOR_IDS;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const wanted = String(userId);
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => part === wanted);
}

// Поля, которые обычному пользователю отдавать нельзя: они опознают
// человека. Модератору они нужны, чтобы понимать, чьё фото перед ним.
const MODERATOR_ONLY_FIELDS = ["author", "username", "userId"];

export function publicEntry(entry, { moderator = false } = {}) {
  const view = {
    id: entry.id,
    placeId: entry.placeId,
    caption: entry.caption || "",
    contentType: entry.contentType,
    size: entry.size,
    createdAt: entry.createdAt,
  };
  if (moderator) {
    view.author = entry.author || "Участник";
    view.username = entry.username || "";
    view.userId = entry.userId;
  }
  return view;
}

export { MODERATOR_ONLY_FIELDS };
