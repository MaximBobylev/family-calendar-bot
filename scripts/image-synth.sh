#!/usr/bin/env bash
# Синтетический набор картинок для замера «фото → событие» (US-66): афиши, объявления, скриншот чата, бронь, талон
# к врачу, картинки без события, размытая. Ожидания — testdata/images/index.yaml; замер — scripts/eval-images.ts.
# Запуск на хосте (нужны ImageMagick 7 и шрифты macOS; другие пути — FONT_DIR):
#   scripts/image-synth.sh [папка=testdata/images]
# Картинки уже лежат в репозитории (переносимые данные, ADR-0006) — перегенерировать только при правке набора.
set -euo pipefail

OUT="${1:-testdata/images}"
mkdir -p "$OUT"
FD="${FONT_DIR:-/System/Library/Fonts/Supplemental}"
ARIAL="$FD/Arial.ttf"
ARIALB="$FD/Arial Bold.ttf"
IMPACT="$FD/Impact.ttf"
GEORGIA="$FD/Georgia.ttf"
GEORGIAB="$FD/Georgia Bold.ttf"
TIMES="$FD/Times New Roman.ttf"
COURIER="$FD/Courier New.ttf"
VERDANA="$FD/Verdana.ttf"
VERDANAB="$FD/Verdana Bold.ttf"
COMIC="$FD/Comic Sans MS.ttf"

# 01 — афиша концерта (тёмный градиент, крупный шрифт)
magick -size 800x1100 gradient:'#1b1035-#8a1c4a' \
  -fill '#ffd166' -font "$IMPACT" -pointsize 96 -gravity north -annotate +0+120 'КОНЦЕРТ' \
  -fill white -font "$ARIALB" -pointsize 64 -annotate +0+260 'группа «Сплин»' \
  -fill '#ffd166' -font "$ARIALB" -pointsize 72 -annotate +0+520 '18 октября' \
  -fill white -font "$ARIALB" -pointsize 60 -annotate +0+620 'начало в 19:00' \
  -fill '#dddddd' -font "$ARIAL" -pointsize 40 -annotate +0+820 'ДК Горбунова, ул. Новозаводская, 27' \
  -fill '#aaaaaa' -font "$ARIAL" -pointsize 30 -annotate +0+960 'Билеты: от 2500 ₽ · 16+' \
  -quality 88 "$OUT/01-concert-poster.jpg"

# 02 — объявление в школе (лист А4, чёрный текст)
magick -size 900x1200 xc:'#fbfbf7' \
  -fill black -font "$TIMES" -pointsize 52 -gravity north -annotate +0+120 'ОБЪЯВЛЕНИЕ' \
  -font "$TIMES" -pointsize 38 -gravity northwest \
  -annotate +90+280 'Уважаемые родители учеников 3 «Б» класса!' \
  -annotate +90+380 'Родительское собрание состоится' \
  -annotate +90+440 'в четверг в 18:00, каб. 12.' \
  -annotate +90+540 'Повестка: итоги первой четверти,' \
  -annotate +90+600 'осенняя экскурсия.' \
  -annotate +90+700 'Явка обязательна.' \
  -font "$TIMES" -pointsize 34 -annotate +520+900 'Классный руководитель' \
  -annotate +520+950 'Смирнова Е. В.' \
  -quality 90 "$OUT/02-school-meeting.jpg"

# 03 — скриншот чата (пузыри сообщений)
magick -size 720x1000 xc:'#dfe8d8' \
  -fill white -draw 'roundrectangle 30,60 560,200 24,24' \
  -fill '#effdde' -draw 'roundrectangle 180,240 690,330 24,24' \
  -fill white -draw 'roundrectangle 30,370 600,520 24,24' \
  -fill '#effdde' -draw 'roundrectangle 300,560 690,640 24,24' \
  -font "$ARIALB" -pointsize 26 -fill '#3a7bd5' -annotate +55+100 'Маша' \
  -font "$ARIAL" -pointsize 28 -fill black -annotate +55+145 'Привет! Как насчёт встретиться' -annotate +55+180 'на выходных?' \
  -annotate +205+295 'Давай! Когда тебе удобно?' \
  -annotate +55+410 'В субботу в 12:30 в кафе «Пушкин»,' -annotate +55+450 'Тверской бульвар, 26' \
  -font "$ARIAL" -pointsize 20 -fill '#888888' -annotate +520+505 '14:02' \
  -font "$ARIAL" -pointsize 28 -fill black -annotate +325+610 'Отлично, до встречи!' \
  -quality 90 "$OUT/03-chat-screenshot.png"

# 04 — подтверждение брони (английский, письмо)
magick -size 900x900 xc:white \
  -fill '#0b5394' -draw 'rectangle 0,0 900,110' \
  -fill white -font "$VERDANAB" -pointsize 40 -gravity northwest -annotate +40+30 'Booking confirmed' \
  -fill '#222222' -font "$VERDANA" -pointsize 30 \
  -annotate +40+170 'Hi Maxim,' \
  -annotate +40+230 'Your table at Nobu London is confirmed.' \
  -font "$VERDANAB" -annotate +40+330 'Friday, October 16, 2026 at 8:00 PM' \
  -font "$VERDANA" -annotate +40+390 'Party size: 2 guests' \
  -annotate +40+450 'Address: 15 Berkeley St, London W1J 8DY' \
  -fill '#888888' -pointsize 24 -annotate +40+560 'Need to change your reservation? Reply to this e-mail.' \
  -annotate +40+600 'Reference: NB-48213' \
  -quality 90 "$OUT/04-booking-en.png"

# 05 — талон к врачу (карточка с полями)
magick -size 800x560 xc:'#f4f8ff' \
  -stroke '#5577aa' -strokewidth 3 -fill none -draw 'rectangle 15,15 785,545' -stroke none \
  -fill '#1d3557' -font "$ARIALB" -pointsize 36 -gravity north -annotate +0+40 'ТАЛОН НА ПРИЁМ К ВРАЧУ' \
  -font "$ARIAL" -pointsize 30 -gravity northwest -fill black \
  -annotate +50+130 'ГБУЗ «Городская поликлиника № 3»' \
  -annotate +50+190 'Врач: стоматолог-терапевт Иванова А. П.' \
  -annotate +50+250 'Дата: 14.10.2026' \
  -annotate +50+310 'Время: 09:30' \
  -annotate +50+370 'Кабинет: 205, 2 этаж' \
  -font "$ARIAL" -pointsize 22 -fill '#555555' -annotate +50+460 'При себе иметь полис ОМС и паспорт. Отмена: 8 (495) 123-45-67' \
  -quality 90 "$OUT/05-doctor-ticket.png"

# 06 — пейзаж без текста (нет события)
magick -size 900x600 gradient:'#87ceeb-#fdf6e3' \
  -fill '#556b2f' -draw 'polygon 0,600 0,380 180,250 330,360 480,200 650,340 900,260 900,600' \
  -fill '#2e4a1f' -draw 'polygon 0,600 0,470 220,400 420,480 640,410 900,470 900,600' \
  -fill '#fff3b0' -draw 'circle 720,120 760,120' \
  -attenuate 0.4 +noise Gaussian -quality 85 "$OUT/06-landscape.jpg"

# 07 — реклама без даты (нет события)
magick -size 800x800 xc:'#ffefd5' \
  -fill '#d62828' -font "$IMPACT" -pointsize 140 -gravity center -annotate +0-180 'СКИДКИ' \
  -fill '#003049' -font "$ARIALB" -pointsize 80 -annotate +0-30 'на всё −30%' \
  -fill '#003049' -font "$ARIAL" -pointsize 44 -annotate +0+110 'Магазин «Уют»' \
  -font "$ARIAL" -pointsize 34 -annotate +0+190 'ул. Садовая, 10 · ежедневно' \
  -quality 88 "$OUT/07-ad-no-date.jpg"

# 08 — размытое и бледное объявление (низкий контраст)
magick -size 900x700 xc:'#e8e4da' \
  -fill '#9a948a' -font "$ARIALB" -pointsize 46 -gravity north -annotate +0+80 'ЭКСКУРСИЯ В МУЗЕЙ' \
  -font "$ARIAL" -pointsize 36 -gravity northwest \
  -annotate +80+220 '22 октября в 10:00' \
  -annotate +80+290 'Сбор у главного входа школы.' \
  -annotate +80+360 'Стоимость 600 руб., сдать до 15.10.' \
  -blur 0x2.2 -attenuate 0.3 +noise Gaussian -quality 70 "$OUT/08-blurry-excursion.jpg"

# 09 — объявление в детском саду (рукописный стиль, цвет)
magick -size 800x1000 xc:'#fffbe6' \
  -fill '#e76f51' -font "$COMIC" -pointsize 64 -gravity north -annotate +0+80 'Дорогие родители!' \
  -fill '#264653' -font "$COMIC" -pointsize 40 -gravity northwest \
  -annotate +70+240 'Приглашаем вас на осенний' \
  -annotate +70+300 'утренник «Золотая осень»' \
  -annotate +70+400 '30 октября в 10:30' \
  -annotate +70+460 'в музыкальном зале.' \
  -annotate +70+580 'Костюмы: листочки, грибочки.' \
  -fill '#f4a261' -draw 'circle 650,850 700,850' -draw 'circle 150,880 190,880' \
  -quality 88 "$OUT/09-kindergarten-party.jpg"

# 10 — записка на двери секции (перенос занятия)
magick -size 800x600 xc:white \
  -fill black -font "$COURIER" -pointsize 34 -gravity northwest \
  -annotate +50+60 'Секция плавания, группа 2' \
  -annotate +50+150 'ВНИМАНИЕ!' \
  -annotate +50+220 'Занятие переносится на' \
  -annotate +50+280 'понедельник, 19 октября, 17:00.' \
  -annotate +50+380 'Бассейн «Дельфин», дорожка 4.' \
  -annotate +50+470 'Тренер: Олег' \
  -rotate 2 -background '#c9c2b5' -gravity center -extent 840x640 -quality 85 "$OUT/10-swim-moved.jpg"

# 11 — афиша на английском
magick -size 800x1000 gradient:'#0d1b2a-#1b263b' \
  -fill '#e0e1dd' -font "$GEORGIAB" -pointsize 90 -gravity north -annotate +0+150 'Jazz Night' \
  -fill '#fca311' -font "$GEORGIA" -pointsize 48 -annotate +0+330 'Saturday, Oct 24' \
  -fill '#e0e1dd' -annotate +0+410 'Doors 7:30 pm' \
  -font "$GEORGIA" -pointsize 38 -annotate +0+620 'Blue Note Club, 131 W 3rd St' \
  -fill '#778da9' -pointsize 30 -annotate +0+800 'Free entry · Live quartet' \
  -quality 88 "$OUT/11-jazz-en.jpg"

# 12 — приглашение «как фото»: поворот, шум, тень
magick -size 760x560 xc:'#fff0f5' \
  -fill '#c9184a' -font "$GEORGIAB" -pointsize 54 -gravity north -annotate +0+50 'Приглашение' \
  -fill '#333333' -font "$GEORGIA" -pointsize 34 -gravity northwest \
  -annotate +60+160 'Приглашаем на день рождения Сони!' \
  -annotate +60+240 '25 октября в 15:00' \
  -annotate +60+310 'ул. Ленина, 5, кв. 12' \
  -annotate +60+400 'Будут торт и аниматор :)' \
  -background '#6b5b4b' -rotate -7 -gravity center -extent 900x720 \
  -attenuate 0.6 +noise Gaussian -modulate 92 -quality 75 "$OUT/12-birthday-photo.jpg"

ls -la "$OUT"
