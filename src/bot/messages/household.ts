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
    ru: "🏠 Дом «{name}» создан. Отметьте общие календари — их увидят и смогут менять участники дома. Личный календарь лучше не отмечать.\n\n⭐ — основной общий: туда я добавляю события, которые создают участники.",
    en: "🏠 Household “{name}” created. Choose the shared calendars — household members will see and edit them. Better not to share your personal calendar.\n\n⭐ — the main shared one: events created by members go there.",
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
  homeRemoveKidButton: { ru: "✖ 🧒 {name}", en: "✖ 🧒 {name}" },
  homeEditMemberButton: { ru: "✏️ {name}", en: "✏️ {name}" },
  homeEditMeButton: { ru: "✏️ Как меня называть", en: "✏️ How to call me" },
  homeAddKidButton: { ru: "👶 Добавить ребёнка", en: "👶 Add a child" },
  homeRoleHusband: { ru: "👨 муж, папа", en: "👨 husband, dad" },
  homeRoleWife: { ru: "👩 жена, мама", en: "👩 wife, mom" },
  homeTomorrowButton: { ru: "🌙 Сводка «Завтра» в 21:00", en: "🌙 “Tomorrow” summary at 21:00" },
  homeTomorrowOn: {
    ru: "🌙 Включил: каждый вечер в 21:00 — что завтра у семьи и ваши дела. Выключить — /settings → Сводка.",
    en: "🌙 Enabled: every evening at 21:00 — the family's plans and your tasks for tomorrow. Turn off — /settings → Summary.",
  },
  homeTomorrowOffer: {
    ru: "Хотите вечером видеть, что завтра у семьи и какие дела на вас? Включите сводку «Завтра» — одной кнопкой.",
    en: "Want to see the family's plans and your tasks for tomorrow every evening? Turn on the “Tomorrow” summary with one tap.",
  },
  homeRemoveConfirm: {
    ru: "Убрать {name} из дома «{home}»? {name} перестанет получать расписание семьи и дела; открытые поручения на {name} вернутся их авторам.",
    en: "Remove {name} from “{home}”? {name} will stop getting the family schedule and tasks; open tasks on {name} go back to their authors.",
  },
  homeRemoveYes: { ru: "Да, убрать", en: "Yes, remove" },
  homeAskNameOf: {
    ru: "Как называть {name}? Напишите имя и другие имена через запятую: «Аня, жена, мама».",
    en: "How should the household call {name}? Type the name and other names separated by commas.",
  },
  homeAskKid: {
    ru: "Напишите имя ребёнка и другие имена через запятую: «Маша, Машенька».",
    en: "Type the child's name and other names separated by commas: “Mary, Molly”.",
  },
  homeAskCreate: {
    ru: "Как назовём дом? Напишите название, например: Бобылевы",
    en: "What should we call the household? Type a name, for example: Smiths",
  },
  homeDefaultCalendar: {
    ru: "⭐ Основной общий (сюда добавляю события семьи): {name}",
    en: "⭐ Main shared calendar (family events go here): {name}",
  },
  homeNoFamilyCalendar: {
    ru: "Семейного календаря я не нашёл — отметьте общий сами (личный лучше не отмечать).\n\nЕсли общего ещё нет: в Google Календаре слева «Другие календари» → «+» → «Создать календарь», назовите его «Семья», затем отправьте мне /connect — я его увижу.",
    en: "I didn't find a family calendar — pick the shared one yourself (better not your personal one).\n\nNo shared calendar yet? In Google Calendar, “Other calendars” → “+” → “Create new calendar”, name it “Family”, then send me /connect and I'll see it.",
  },
  homeChecklist: {
    ru: "🏠 Дом «{name}» готов. Три шага, чтобы заработало:\n\n1. Как вас называть? Напишите: «{first}, муж, папа» — тогда семья сможет сказать «напомни мужу». Или нажмите кнопку ниже.\n2. ➕ Пригласите жену или мужа — ссылка на 48 часов, Google не нужен.\n3. 👶 Добавьте детей — «Маша, Машенька», чтобы писать «для Маши».\n\nЕсть семейный чат в Telegram? Добавьте меня туда и напишите /home link.",
    en: "🏠 Household “{name}” is ready. Three steps to get going:\n\n1. How should the family call you? Type: “{first}, husband, dad” — then they can say “remind my husband”. Or tap a button below.\n2. ➕ Invite your partner — a 48-hour link, no Google needed.\n3. 👶 Add children — “Mary, Molly” — to say “for Mary”.\n\nHave a family group chat in Telegram? Add me there and type /home link.",
  },
  homeAliasLearned: { ru: "Запомнил: «{alias}» — это {name}.", en: "Got it: “{alias}” is {name}." },
  homeLeaveButton: { ru: "Выйти из дома", en: "Leave the household" },
  homeDissolveButton: { ru: "Распустить дом", en: "Dissolve the household" },
  homeDissolveYes: { ru: "Да, распустить", en: "Yes, dissolve" },
  homeDoneButton: { ru: "Готово", en: "Done" },
  homeCalendarsPick: {
    ru: "Общие календари дома «{name}» — участники видят их и могут добавлять события (через ваш Google). Личный календарь лучше не отмечать.\n\n⭐ — основной общий: туда я добавляю события, которые создают участники.",
    en: "Shared calendars of “{name}” — members see them and can add events (through your Google). Better not to share your personal calendar.\n\n⭐ — the main shared one: events created by members go there.",
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
    ru: "🏠 Вы в доме «{name}». Что я буду делать:\n• присылать дела от семьи с кнопками «Беру / Не могу» и напоминать о них;\n• каждое утро в 08:00 — что сегодня у семьи (время — в /settings).\n\nЧто можно попросить:\n• «Что у нас завтра?»\n• «Пусть {owner} купит хлеб»\n• перешлите объявление из школьного чата — добавлю в общий календарь.\n\nВсе возможности — /help",
    en: "🏠 You're in the household “{name}”. What I'll do:\n• send you family tasks with “I'll do it / Can't” buttons and remind you about them;\n• every morning at 08:00 — what the family has today (time — in /settings).\n\nWhat you can ask:\n• “What's on tomorrow?”\n• “Let {owner} buy bread”\n• forward an announcement from the school chat — I'll add it to the shared calendar.\n\nEverything I can do — /help",
  },
  homeAskName: {
    ru: "Как вас называть в доме? Напишите имя и, если хотите, другие имена через запятую: «Аня, мама» — или нажмите кнопку.",
    en: "How should the household call you? Type your name and, optionally, other names separated by commas — or tap a button.",
  },
  homeMemberJoined: {
    ru: "🏠 В доме «{home}» новый участник: {name}.",
    en: "🏠 New member in “{home}”: {name}.",
  },
  homeNameSet: { ru: "Запомнил: {name}{aliases}.", en: "Got it: {name}{aliases}." },
  homeAliasesSuffix: { ru: " (а также: {list})", en: " (also: {list})" },
  homeKidAdded: { ru: "Добавил ребёнка: {name}{aliases}.", en: "Child added: {name}{aliases}." },
  homeKidRemoved: { ru: "Убрал: {name}", en: "Removed: {name}" },
  homeKidsFull: { ru: "Детей в доме уже {max} — больше пока нельзя.", en: "The household already has {max} children." },
  homeLeft: { ru: "Вы вышли из дома «{name}».", en: "You left “{name}”." },
  homeMemberLeft: {
    ru: "🏠 {name} больше не в доме «{home}».",
    en: "🏠 {name} is no longer in “{home}”.",
  },
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
  homeCreatedByDone: {
    ru: "👤 Автор: {name}",
    en: "👤 Added by: {name}",
  },
  // US-94: групповой чат
  groupNotLinked: {
    ru: "Этот чат пока не привязан к дому. Владелец дома или взрослый с Google может привязать его командой /home link. По личным делам — напишите мне в личные сообщения.",
    en: "This chat isn't linked to a household yet. The household owner or an adult with Google can link it with /home link. For personal matters, message me directly.",
  },
  groupLinked: {
    ru: "🏠 Чат привязан к дому «{name}». Обращайтесь ко мне по имени или ответом на моё сообщение: «@{bot} что у нас в выходные?»",
    en: "🏠 This chat is linked to “{name}”. Mention me or reply to my message: “@{bot} what's on this weekend?”",
  },
  groupHello: {
    ru: "Привет! Я семейный помощник 🏠 Могу показывать здесь расписание семьи и дела, которые никто не взял.\n\nПривязать этот чат к дому «{name}»? Или напишите /home link.\n\nЧитаю только сообщения, обращённые ко мне: @{bot} или ответ на моё сообщение.",
    en: "Hi! I'm a family assistant 🏠 I can show the family schedule and untaken tasks here.\n\nLink this chat to “{name}”? Or type /home link.\n\nI only read messages addressed to me: @{bot} or a reply to my message.",
  },
  groupHelloNoHome: {
    ru: "Привет! Я семейный помощник 🏠 Могу показывать здесь расписание семьи и дела, которые никто не взял.\n\nЧтобы привязать чат к дому, владелец дома пишет здесь /home link (дом создаётся в личном чате со мной: /home).\n\nЧитаю только сообщения, обращённые ко мне: @{bot} или ответ на моё сообщение.",
    en: "Hi! I'm a family assistant 🏠 I can show the family schedule and untaken tasks here.\n\nTo link this chat, the household owner types /home link here (a household is created in a private chat with me: /home).\n\nI only read messages addressed to me: @{bot} or a reply to my message.",
  },
  groupLinkButton: { ru: "🔗 Привязать", en: "🔗 Link" },
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
