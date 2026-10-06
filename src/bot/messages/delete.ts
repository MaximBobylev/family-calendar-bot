// Тексты: удаление события и отклонение приглашения (US-50).

import type { Messages } from "./types";

export const deleteMessages = {
  deleteConfirm: { ru: "Удалить?", en: "Delete this event?" },
  declineConfirm: { ru: "Отклонить приглашение?", en: "Decline the invitation?" },
  declineExplain: {
    ru: "Встреча не удаляется — вы отклоняете приглашение, организатор получит ответ.",
    en: "The event is not deleted — you decline the invitation, the organizer will be notified.",
  },
  attendeesNotifiedCancel: { ru: "👥 Участники получат уведомление об отмене.", en: "👥 Attendees will be notified about the cancellation." },
  deleteButton: { ru: "Удалить", en: "Delete" },
  declineButton: { ru: "Отклонить", en: "Decline" },
  deleted: { ru: "🗑 Удалено", en: "🗑 Deleted" },
  deletedSeries: { ru: "🗑 Удалена вся серия", en: "🗑 The whole series was deleted" },
  declined: { ru: "✅ Приглашение отклонено", en: "✅ Invitation declined" },
  massDeleteUnsupported: {
    ru: "Удалять сразу несколько встреч пока не умею — назовите одну.",
    en: "I can't delete several events at once yet — please name one.",
  },
} as const satisfies Messages;
