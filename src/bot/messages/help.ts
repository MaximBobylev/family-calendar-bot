// Тексты: справка /help и приветствие /start по состоянию пользователя (ревью R1 §4: без LLM, семейные функции — первыми,
// каждый экран заканчивается одним следующим шагом).

import type { Messages } from "./types";

export const helpMessages = {
  // --- /start: четыре состояния ---
  startNew: {
    ru: "Привет! Я семейный помощник в Telegram 🏠\n\nПересылайте мне объявления, приглашения и фото афиш — я занесу их в общий Google Календарь, напомню, кому нужно, и прослежу, что дело взяли.\n\nЧтобы начать, подключите Google Календарь — это пару кликов. Потом спрашивайте голосом или текстом: «Что у меня завтра?»\n\nВас пригласили в семью? Откройте ссылку-приглашение ещё раз — Google не понадобится.",
    en: "Hi! I'm a family assistant in Telegram 🏠\n\nForward me announcements, invitations and posters — I'll put them into the shared Google Calendar, remind the right people and make sure someone takes the task.\n\nTo get started, connect your Google Calendar — a couple of clicks. Then ask by voice or text: “What's on tomorrow?”\n\nInvited to a family? Open the invite link again — no Google needed.",
  },
  startConnected: {
    ru: "Google Календарь подключён ✅ Что можно уже сейчас:\n• «Что у меня завтра?» — голосом или текстом\n• «Поставь стоматолога в четверг в 16»\n• Перешлите сообщение или фото афиши — сделаю событие\n\nЧтобы делить дела с семьёй, создайте дом: жена или муж получат расписание и поручения прямо в Telegram, без Google.\n\nВсе возможности — /help",
    en: "Google Calendar connected ✅ What you can do right away:\n• “What's on tomorrow?” — by voice or text\n• “Dentist on Thursday at 4pm”\n• Forward a message or a poster photo — I'll make an event\n\nTo share tasks with your family, create a household: your partner gets the schedule and tasks right in Telegram, no Google needed.\n\nEverything I can do — /help",
  },
  startOwner: {
    ru: "🏠 Дом «{name}»: {members}{kids}\n• «Пусть {other} заберёт Машу в 17» — передам дело с кнопками «Беру / Не могу»\n• «Кто-то должен отвезти Ваню на плавание в субботу» — возьмёт первый\n• «Что у нас на выходных?»\n\nВсе возможности — /help · дом и участники — /home",
    en: "🏠 Household “{name}”: {members}{kids}\n• “Let {other} pick up the kids at 5pm” — I'll hand it over with “I'll do it / Can't” buttons\n• “Someone needs to take the kids swimming on Saturday” — first to take it\n• “What's on this weekend?”\n\nEverything I can do — /help · household — /home",
  },
  startKids: { ru: " · дети: {list}", en: " · children: {list}" },
  startMember: {
    ru: "🏠 Вы в доме «{name}». Спросите «Что у нас завтра?», попросите добавить событие в общий календарь или поручите дело: «Пусть {owner} купит хлеб».\n\nВсе возможности — /help. Свой Google Календарь можно подключить в любой момент: /connect",
    en: "🏠 You're in “{name}”. Ask “What's on tomorrow?”, ask me to add an event to the shared calendar, or hand over a task: “Let {owner} buy bread”.\n\nEverything I can do — /help. You can connect your own Google Calendar any time: /connect",
  },
  startCreateHomeButton: { ru: "🏠 Создать дом", en: "🏠 Create a household" },
  // --- /help ---
  helpPrivate: {
    ru: "<b>Что я умею</b>\n\n📅 <b>Календарь</b> — голосом или текстом\n«Что у нас завтра?» · «Поставь стоматолога Вани в четверг в 16, отводит папа» · «Перенеси ужин на 20» · «Отмени последнее»\n\n📨 <b>Из чужих сообщений</b>\nПерешлите объявление, приглашение, фото афиши или файл .ics — предложу событие.\n\n👥 <b>Дела семьи</b>\n«Напомни мужу забрать Машу в 17» · «Пусть Аня завтра купит торт» · «Кто-то должен …» · «Мои дела» · «Что я поручил»\nНа поручение можно ответить кнопкой или словом: «Беру», «Не могу», «Сделано».\n\n💬 <b>В любом чате</b>\nНапишите <code>@{bot} суббота 14:00 шашлыки</code> — друзья добавят событие себе одной кнопкой.\n\n⚙️ /settings — сводки и напоминания · 🏠 /home — дом и участники",
    en: "<b>What I can do</b>\n\n📅 <b>Calendar</b> — by voice or text\n“What's on tomorrow?” · “Dentist on Thursday at 4pm” · “Move dinner to 8pm” · “Undo the last one”\n\n📨 <b>From other people's messages</b>\nForward an announcement, an invitation, a poster photo or an .ics file — I'll suggest an event.\n\n👥 <b>Family tasks</b>\n“Remind my husband to pick up the kids at 5pm” · “Someone needs to …” · “My tasks” · “What I assigned”\nYou can answer a task with a button or a word: “I'll do it”, “Can't”, “Done”.\n\n💬 <b>In any chat</b>\nType <code>@{bot} Saturday 2pm barbecue</code> — friends add the event with one tap.\n\n⚙️ /settings — summaries and reminders · 🏠 /home — household and members",
  },
  helpNoGoogle: {
    ru: "\n\nЧтобы начать, подключите Google Календарь — или откройте ссылку-приглашение в дом, если вас позвали в семью.",
    en: "\n\nTo get started, connect Google Calendar — or open a household invite link if your family invited you.",
  },
  helpNoHome: {
    ru: "\n\n🏠 Дома пока нет: создайте его, чтобы поручать дела семье — /home",
    en: "\n\n🏠 No household yet: create one to hand tasks to your family — /home",
  },
  helpMember: {
    ru: "\n\nВы в доме «{name}»: события добавляю в общий календарь дома, Google вам не нужен.",
    en: "\n\nYou're in “{name}”: I add events to the household's shared calendar, you don't need Google.",
  },
  helpGroup: {
    ru: "Обращайтесь ко мне через @{bot} или ответом на моё сообщение: «@{bot} что у нас в выходные?», «@{bot} кто-то должен купить корм коту». Привязать или отвязать чат: /home link, /home unlink. Всё остальное — в личном чате со мной: /help",
    en: "Mention me with @{bot} or reply to my message: “@{bot} what's on this weekend?”, “@{bot} someone needs to buy cat food”. Link or unlink this chat: /home link, /home unlink. Everything else — in a private chat with me: /help",
  },
} satisfies Messages;
