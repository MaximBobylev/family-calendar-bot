// Тексты: дом и участники (US-90), бот в групповом чате (US-94).

import type { Messages } from "./types";

export const householdMessages = {
  homeNone: {
    ru: 'У вас пока нет дома. Дом — это семья в боте: общие календари, участники без Google, групповой чат.\n\nСоздать: «Создай дом "Бобылевы"» или /home create Бобылевы',
    en: "You don't have a household yet. A household is your family in the bot: shared calendars, members without Google, a group chat.\n\nCreate one: /home create Smiths",
  },
  homeNoneNoGoogle: {
    ru: "Вы пока не в доме. Попросите взрослого, который подключил Google, прислать ссылку-приглашение — или подключите свой календарь: /connect",
    en: "You're not in a household yet. Ask the adult who connected Google for an invite link — or connect your own calendar: /connect",
  },
  homeCreateNeedsGoogle: {
    ru: "Дом создаёт взрослый с подключённым Google Календарём — его календари станут общими. Подключить: /connect",
    en: "A household is created by an adult with Google Calendar connected — their calendars become shared. Connect: /connect",
  },
  homeAlreadyIn: {
    ru: "Вы уже в доме «{name}». Чтобы перейти в другой, сначала выйдите: /leave",
    en: "You're already in the household “{name}”. To switch, leave first: /leave",
  },
  homeCreated: {
    ru: "🏠 Дом «{name}» создан. Отметьте общие календари — их увидят и смогут менять участники дома:",
    en: "🏠 Household “{name}” created. Choose the shared calendars — household members will see and edit them:",
  },
  homeHelp: {
    ru: "Команды дома:\n/home — состав и кнопки\n/home create Название — создать дом\n/home invite Имя, другие имена — ссылка-приглашение\n/home name Имя, другие имена — как вас называть («Дима, муж, папа»)\n/home kid Имя, другие имена — добавить ребёнка\n/home link — в групповом чате: привязать чат к дому\n/leave — выйти из дома",
    en: "Household commands:\n/home — members and buttons\n/home create Name — create a household\n/home invite Name, other names — invite link\n/home name Name, other names — how to call you\n/home kid Name, other names — add a child\n/home link — in a group chat: link it to the household\n/leave — leave the household",
  },
  homeTitle: { ru: "🏠 Дом «{name}»", en: "🏠 Household “{name}”" },
  homeMembers: { ru: "Участники:", en: "Members:" },
  homeOwnerMark: { ru: "владелец", en: "owner" },
  homeNoGoogleMark: { ru: "без Google", en: "no Google" },
  homeKids: { ru: "Дети:", en: "Children:" },
  homeNoKids: { ru: "Дети: — (добавить: /home kid Маша)", en: "Children: — (add: /home kid Mary)" },
  homeCalendars: { ru: "Общие календари: {list}", en: "Shared calendars: {list}" },
  homeNoCalendars: { ru: "Общие календари: не выбраны", en: "Shared calendars: none selected" },
  homeMenuHint: {
    ru: "Как вас называть: /home name Имя, другие имена. Все команды: /home help",
    en: "How to call you: /home name Name, other names. All commands: /home help",
  },
  homeInviteButton: { ru: "➕ Пригласить", en: "➕ Invite" },
  homeCalendarsButton: { ru: "📅 Календари дома", en: "📅 Shared calendars" },
  homeRemoveButton: { ru: "✖ {name}", en: "✖ {name}" },
  homeLeaveButton: { ru: "Выйти из дома", en: "Leave the household" },
  homeDissolveButton: { ru: "Распустить дом", en: "Dissolve the household" },
  homeDissolveYes: { ru: "Да, распустить", en: "Yes, dissolve" },
  homeDoneButton: { ru: "Готово", en: "Done" },
  homeCalendarsPick: {
    ru: "Общие календари дома «{name}» — участники видят их и могут добавлять события (через ваш Google):",
    en: "Shared calendars of “{name}” — members see them and can add events (through your Google):",
  },
  homeOwnerOnly: { ru: "Это может только владелец дома", en: "Only the household owner can do this" },
  homeInvite: {
    ru: "Ссылка-приглашение в дом «{name}» — одноразовая, действует 48 часов:\n{link}\n\nПерешлите её члену семьи. Google ему не нужен.",
    en: "Invite link to “{name}” — single use, valid for 48 hours:\n{link}\n\nForward it to a family member. They don't need Google.",
  },
  homeInviteFor: { ru: "Для: {name}", en: "For: {name}" },
  homeFull: {
    ru: "В доме уже {max} участников — больше пока нельзя.",
    en: "The household already has {max} members — that's the limit for now.",
  },
  homeInviteInvalid: {
    ru: "Ссылка-приглашение недействительна: она уже использована или истекла. Попросите новую.",
    en: "This invite link is no longer valid: it was used or has expired. Ask for a new one.",
  },
  homeJoined: {
    ru: "🏠 Вы в доме «{name}». Будете получать расписание семьи и сможете добавлять события в общие календари.\n\nСпросите, например: «Что у нас завтра?»",
    en: "🏠 You're in the household “{name}”. You'll see the family schedule and can add events to the shared calendars.\n\nTry: “What's on tomorrow?”",
  },
  homeAskName: {
    ru: "Как вас называть в доме? Ответьте на это сообщение: имя и другие имена через запятую — «Дима, муж, папа».",
    en: "How should the household call you? Reply to this message: name and other names separated by commas.",
  },
  homeMemberJoined: { ru: "🏠 {name} присоединился(-ась) к дому «{home}».", en: "🏠 {name} joined “{home}”." },
  homeNameSet: { ru: "Запомнил: {name}{aliases}.", en: "Got it: {name}{aliases}." },
  homeAliasesSuffix: { ru: " (а также: {list})", en: " (also: {list})" },
  homeKidAdded: { ru: "Добавил ребёнка: {name}{aliases}.", en: "Child added: {name}{aliases}." },
  homeKidRemoved: { ru: "Убрал: {name}", en: "Removed: {name}" },
  homeKidsFull: { ru: "Детей в доме уже {max} — больше пока нельзя.", en: "The household already has {max} children." },
  homeWelcomeMember: {
    ru: "🏠 Вы в доме «{name}». Спросите «Что у нас завтра?» или попросите добавить событие в общий календарь.\n\nСвой Google Календарь можно подключить в любой момент: /connect",
    en: "🏠 You're in “{name}”. Ask “What's on tomorrow?” or ask me to add an event to the shared calendar.\n\nYou can connect your own Google Calendar any time: /connect",
  },
  homeLeft: { ru: "Вы вышли из дома «{name}».", en: "You left “{name}”." },
  homeMemberLeft: { ru: "{name} вышел(-ла) из дома «{home}».", en: "{name} left “{home}”." },
  homeNotInHousehold: { ru: "Вы не состоите в доме.", en: "You're not in a household." },
  homeOwnerCantLeave: {
    ru: "Владелец не может выйти из дома. Распустить дом можно в /home.",
    en: "The owner can't leave. You can dissolve the household in /home.",
  },
  homeRemoved: { ru: "Убрал из дома: {name}", en: "Removed from the household: {name}" },
  homeYouWereRemoved: { ru: "Вас убрали из дома «{name}».", en: "You were removed from “{name}”." },
  homeDissolveConfirm: {
    ru: "Распустить дом «{name}»? Участники потеряют доступ к общим календарям, групповые чаты отвяжутся. Ваш Google и события не пострадают.",
    en: "Dissolve “{name}”? Members lose access to the shared calendars, group chats get unlinked. Your Google and events stay intact.",
  },
  homeDissolved: { ru: "Дом «{name}» распущен.", en: "Household “{name}” dissolved." },
  homeDissolvedNotice: {
    ru: "Дом «{name}» распущен владельцем — общие календари больше недоступны.",
    en: "The household “{name}” was dissolved by its owner — shared calendars are no longer available.",
  },
  homeCalendarsUnavailable: {
    ru: "Общие календари дома сейчас недоступны: владельцу дома нужно переподключить Google (/connect).",
    en: "The household calendars are unavailable right now: the owner needs to reconnect Google (/connect).",
  },
  homeNoSharedCalendars: {
    ru: "В доме пока нет общих календарей — владелец может выбрать их в /home.",
    en: "The household has no shared calendars yet — the owner can pick them in /home.",
  },
  homeCreatedBy: { ru: "👤 Добавляет: {name}", en: "👤 Added by: {name}" },
  homeCreatedByDone: { ru: "👤 Добавил(а): {name}", en: "👤 Added by: {name}" },
  // US-94: групповой чат
  groupNotLinked: {
    ru: "Этот чат пока не привязан к дому. Владелец дома или взрослый с Google может привязать его командой /home link. По личным делам — напишите мне в личные сообщения.",
    en: "This chat isn't linked to a household yet. The household owner or an adult with Google can link it with /home link. For personal matters, message me directly.",
  },
  groupLinked: {
    ru: "🏠 Чат привязан к дому «{name}». Обращайтесь ко мне по имени или ответом на моё сообщение: «@{bot} что у нас в выходные?»",
    en: "🏠 This chat is linked to “{name}”. Mention me or reply to my message: “@{bot} what's on this weekend?”",
  },
  groupUnlinked: { ru: "Чат отвязан от дома «{name}».", en: "This chat is unlinked from “{name}”." },
  groupLinkNeedsHome: {
    ru: "Привязать чат может участник дома с подключённым Google. Сначала создайте дом в личном чате со мной: /home",
    en: "Only a household member with Google connected can link a chat. Create a household in a private chat with me first: /home",
  },
  groupLinkedElsewhere: {
    ru: "Этот чат уже привязан к дому «{name}».",
    en: "This chat is already linked to “{name}”.",
  },
  groupMembersOnly: {
    ru: "Отвечаю в этом чате только участникам дома «{name}».",
    en: "In this chat I only answer members of “{name}”.",
  },
  groupMembersOnlyButton: { ru: "Кнопки — только для участников дома", en: "Buttons are for household members only" },
  groupPrivateCommand: {
    ru: "Эта команда — в личном чате со мной.",
    en: "Please use this command in a private chat with me.",
  },
} satisfies Messages;
