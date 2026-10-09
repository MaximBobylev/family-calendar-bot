#!/usr/bin/env bash
# Рукописные и бытовые заметки «как сфотографировали телефоном» для замера «фото → событие» (US-66): стикер, календарь,
# дневник, доска, списки без события. Шрифты (SIL OFL, google/fonts) качаются в кеш, не в репозиторий. Ожидания — index.yaml.
#   scripts/image-synth-hand.sh [папка=testdata/images]   # ImageMagick 7, curl; печатные шрифты macOS — FONT_DIR
set -euo pipefail

OUT="${1:-testdata/images}"
mkdir -p "$OUT"
FC="${XDG_CACHE_HOME:-$HOME/.cache}/cab-fonts"
mkdir -p "$FC"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# Рукописные шрифты с кириллицей (OFL): файл в кеше ← путь в google/fonts/ofl
GF=https://raw.githubusercontent.com/google/fonts/main/ofl
fetch() { [ -s "$FC/$1" ] || curl -sfL -o "$FC/$1" "$GF/$2" || { echo "не скачался шрифт $1 ($GF/$2)" >&2; exit 1; }; echo "$FC/$1"; }
CAVEAT="$(fetch Caveat.ttf 'caveat/Caveat%5Bwght%5D.ttf')"
MARCK="$(fetch MarckScript-Regular.ttf marckscript/MarckScript-Regular.ttf)"
BAD="$(fetch BadScript-Regular.ttf badscript/BadScript-Regular.ttf)"
NEUCHA="$(fetch Neucha.ttf neucha/Neucha.ttf)"
AMATIC="$(fetch AmaticSC-Bold.ttf amaticsc/AmaticSC-Bold.ttf)"
PANGOLIN="$(fetch Pangolin-Regular.ttf pangolin/Pangolin-Regular.ttf)"
FD="${FONT_DIR:-/System/Library/Fonts/Supplemental}"
ARIAL="$FD/Arial.ttf"
ARIALB="$FD/Arial Bold.ttf"
TIMES="$FD/Times New Roman.ttf"

# Бумага: paper <файл> <Ш> <В> <цвет> <plain|lined|grid> [шаг] [цвет линий]
paper() {
  local f=$1 w=$2 h=$3 c=$4 kind=$5 s=${6:-40} lc=${7:-'#9fb7d6'}
  case $kind in
    grid) magick -size "${s}x${s}" xc:"$c" -fill none -stroke "$lc" -draw "line 0,$((s - 1)) $((s - 1)),$((s - 1))" -draw "line $((s - 1)),0 $((s - 1)),$((s - 1))" "$T/tile.png" ;;
    lined) magick -size "${s}x${s}" xc:"$c" -fill none -stroke "$lc" -draw "line 0,$((s - 1)) $((s - 1)),$((s - 1))" "$T/tile.png" ;;
    *) magick -size 8x8 xc:"$c" "$T/tile.png" ;;
  esac
  magick -size "${w}x${h}" tile:"$T/tile.png" -attenuate 0.15 +noise Gaussian "$f"
}

# Лист на фон: place <фон> <лист> <выход> <поворот°> <x> <y> — с мягкой тенью
place() {
  magick "$2" -background none -rotate "$4" \( +clone -background black -shadow 55x10+8+12 \) +swap -background none -layers merge +repage "$T/sh.png"
  magick "$1" "$T/sh.png" -geometry "+$5+$6" -composite "$3"
}

# Перспектива всего кадра: persp <вход> <выход> <dx1,dy1 dx2,dy2 dx3,dy3 dx4,dy4> — сдвиг углов (лв, пв, пн, лн), фон — цвет
persp() {
  local w h
  read -r w h < <(magick identify -format '%w %h\n' "$1")
  IFS=' ' read -r a b c d <<<"$3"
  magick "$1" -virtual-pixel background -background "$4" -distort Perspective \
    "0,0 ${a} $w,0 $((w + ${b%,*})),${b#*,} $w,$h $((w + ${c%,*})),$((h + ${c#*,})) 0,$h ${d%,*},$((h + ${d#*,}))" "$2"
}

# «Телефонная» обработка: неровный свет (пятно в точке ox,oy), шум, лёгкая расфокусировка, JPEG ≤ 200 КБ
photo() {
  local in=$1 out=$2 ox=${3:-0} oy=${4:-0} dark=${5:-'#6a6a6a'} blur=${6:-0.6} q=${7:-80}
  local w h
  read -r w h < <(magick identify -format '%w %h\n' "$in")
  magick "$in" \( -size "$((w * 2))x$((h * 2))" radial-gradient:white-"$dark" -crop "${w}x${h}+${ox}+${oy}" +repage \) \
    -compose multiply -composite -blur "0x$blur" -attenuate 0.5 +noise Gaussian -resize '1280x1280>' \
    -sampling-factor 4:2:0 -strip -quality "$q" "$out"
}

# h01 — жёлтый стикер на рамке монитора
magick -size 1200x900 xc:'#7a5a3c' -fill '#141414' -draw 'roundrectangle 40,20 1160,760 18,18' \
  -fill '#24324d' -draw 'rectangle 80,55 1120,700' \
  \( -size 1040x645 gradient:'#3b5480-#1b2438' \) -geometry +80+55 -composite \
  -fill '#2e3e60' -draw 'rectangle 120,100 560,130' -draw 'rectangle 120,160 820,180' -draw 'rectangle 120,210 700,230' \
  -fill '#0d0d0d' -draw 'rectangle 520,760 680,900' "$T/bg.png"
magick -size 400x400 gradient:'#fff47e-#f1dc55' -fill '#1c2a7a' -font "$CAVEAT" -pointsize 86 -gravity northwest \
  -annotate -3x-3+30+60 'Стоматолог' -fill '#b0121b' -pointsize 92 -annotate -2x-2+36+205 'чт 16:30!' \
  -stroke '#b0121b' -strokewidth 5 -fill none -draw 'bezier 60,335 180,325 260,345 340,322' "$T/note.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" 5 700 430
photo "$T/c.png" "$OUT/h01-sticky-monitor.jpg" 300 150

# h02 — настенный календарь, октябрь 2026 (1-е — четверг), рукописные пометки в двух клетках
cal=(-fill '#c0392b' -draw 'rectangle 0,0 980,170' -fill white -font "$ARIALB" -pointsize 78 -gravity north -annotate +0+40 'ОКТЯБРЬ 2026'
  -gravity northwest -font "$ARIALB" -pointsize 30 -fill '#444444')
dn=(Пн Вт Ср Чт Пт Сб Вс)
for i in 0 1 2 3 4 5 6; do cal+=(-annotate "+$((30 + i * 135 + 40))+190" "${dn[$i]}"); done
cal+=(-stroke '#999999' -strokewidth 2 -fill none)
for r in 0 1 2 3 4 5; do cal+=(-draw "line 30,$((240 + r * 150)) 975,$((240 + r * 150))"); done
for c in 0 1 2 3 4 5 6 7; do cal+=(-draw "line $((30 + c * 135)),240 $((30 + c * 135)),990"); done
cal+=(-stroke none -font "$ARIAL" -pointsize 38)
for d in $(seq 1 31); do
  p=$((d + 2)) # смещение: 1-е — четверг (индекс 3)
  col=$((p % 7)) row=$((p / 7))
  [ $col -ge 5 ] && cal+=(-fill '#c0392b') || cal+=(-fill '#222222')
  cal+=(-annotate "+$((38 + col * 135))+$((246 + row * 150))" "$d")
done
magick -size 1000x1020 xc:'#fdfcf8' "${cal[@]}" \
  -fill '#c2185b' -font "$CAVEAT" -pointsize 50 -annotate -6x-6+700+600 'Маме ДР' \
  -stroke '#c2185b' -strokewidth 3 -fill none -draw 'ellipse 800,628 108,38 0,360' -stroke none \
  -fill '#1a3a9a' -font "$CAVEAT" -pointsize 36 -annotate -4x-4+352+700 '19:00' -annotate -3x-3+306+740 'родит.' -annotate -3x-3+310+780 'собр.' "$T/note.png"
magick -size 1200x1250 gradient:'#e9e1cf-#cfc4ad' "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" -1.5 90 90
persp "$T/c.png" "$T/c.png" '30,10 -20,40 -50,-10 10,-30' '#cfc4ad'
photo "$T/c.png" "$OUT/h02-wall-calendar.jpg" 500 100 '#707070' 0.7 70

# h03 — записка на холодильнике под магнитом (линейка)
paper "$T/p.png" 620 460 '#fbfbf6' lined 52 '#a9c3e6'
magick "$T/p.png" -fill '#1b2f8f' -font "$MARCK" -pointsize 52 -gravity northwest \
  -annotate -2x-2+40+40 'Забрать Ваню' -annotate -1x-1+40+130 'из бассейна' -annotate -2x-2+40+225 'в пятницу в 18:15' \
  -font "$MARCK" -pointsize 44 -annotate +380+330 'мама' "$T/note.png"
magick -size 1000x1000 gradient:'#eeeeee-#c9cdd2' -fill '#b8bcc2' -draw 'rectangle 0,960 1000,1000' "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" -4 170 230
magick "$T/c.png" -fill '#e63946' -draw 'circle 470,250 470,290' -fill '#ff8a95' -draw 'circle 460,240 460,252' \
  -fill '#2a9d8f' -draw 'roundrectangle 760,120 900,190 20,20' "$T/c.png"
photo "$T/c.png" "$OUT/h03-fridge-note.jpg" 700 0 '#666666'

# h04 — школьный дневник: печатная сетка, запись ручкой
paper "$T/p.png" 900 760 '#f7f8fb' lined 50 '#b9c9e2'
magick "$T/p.png" -stroke '#d08080' -strokewidth 2 -draw 'line 120,0 120,760' -draw 'line 560,0 560,760' -stroke none \
  -fill '#4a5a7a' -font "$TIMES" -pointsize 30 -gravity northwest -annotate +20+15 'Дни' -annotate +140+15 'Предмет / задание' -annotate +580+15 'Оценка, подпись' \
  -fill '#123a9c' -font "$BAD" -pointsize 38 -annotate -2x-2+20+108 'Пн 19.10 — экскурсия, сбор в 8:30 у школы' \
  -font "$BAD" -pointsize 34 -annotate -1x-1+140+210 'Матем. — №214, 216' -annotate -1x-1+140+310 'Рус. яз. — упр. 87' \
  -fill '#c62828' -font "$BAD" -pointsize 50 -annotate +620+200 '5' "$T/note.png"
magick -size 1100x980 xc:'#9a7d5b' -attenuate 0.4 +noise Multiplicative "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" 2.5 70 70
persp "$T/c.png" "$T/c.png" '0,0 -40,30 -10,-20 30,-10' '#9a7d5b'
photo "$T/c.png" "$OUT/h04-school-diary.jpg" 100 400 '#606060'

# h05 — доска в офисе маркером, блик
magick -size 1300x860 xc:'#f2f4f3' \( -size 1300x860 gradient:'#ffffff-#dfe3e2' -rotate 90 -resize 1300x860! \) -compose multiply -composite -compose over \
  -fill '#1747b5' -font "$NEUCHA" -pointsize 92 -gravity northwest -annotate -2x-2+90+130 'Планёрка перенесена' \
  -annotate -2x-2+90+260 'на 11:00 среда' -stroke '#1747b5' -strokewidth 6 -fill none -draw 'bezier 90,370 400,360 600,380 820,358' -stroke none \
  -fill '#c0392b' -font "$NEUCHA" -pointsize 60 -annotate +860+520 'Q4 план?' -annotate +120+560 'отчёт Маше' \
  -fill '#9aa' -font "$NEUCHA" -pointsize 50 -annotate +200+700 'спринт 42' -blur 0x0.5 "$T/note.png"
magick "$T/note.png" -bordercolor '#b8bcc0' -border 22 \( +clone -fill black -colorize 100 -fill '#a8a49a' -draw 'ellipse 980,180 260,120 0,360' -blur 0x60 \) -compose screen -composite "$T/n2.png"
magick -size 1500x1050 xc:'#d9d2c3' "$T/bg.png"
place "$T/bg.png" "$T/n2.png" "$T/c.png" 0 60 50
persp "$T/c.png" "$T/c.png" '60,40 -10,0 0,0 80,-50' '#d9d2c3'
photo "$T/c.png" "$OUT/h05-whiteboard.jpg" 900 200 '#7a7a7a' 0.8 76

# h06 — листок в клетку, напоминание на английском
paper "$T/p.png" 560 420 '#fcfcfa' grid 28 '#a8c0dc'
magick "$T/p.png" -fill '#0f2a8a' -font "$CAVEAT" -pointsize 96 -gravity northwest -annotate -4x-4+50+80 'Dentist' \
  -annotate -3x-3+70+210 'Tue 3pm' -stroke '#0f2a8a' -strokewidth 4 -fill none -draw 'line 60,330 300,322' "$T/note.png"
magick -size 900x800 gradient:'#d7c6a8-#b39b74' "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" -8 150 160
photo "$T/c.png" "$OUT/h06-dentist-en.jpg" 0 300 '#5c5c5c'

# h07 — «послезавтра в 9» (утро/вечер неоднозначно), блокнот на пружине
paper "$T/p.png" 600 520 '#fffef2' lined 46 '#c7d3e8'
rings=()
for x in 30 90 150 210 270 330 390 450 510 570; do rings+=(-draw "circle $x,15 $x,8"); done
magick "$T/p.png" -fill '#333' -draw 'rectangle 0,0 600,30' -fill '#ddd' "${rings[@]}" \
  -fill '#222' -font "$PANGOLIN" -pointsize 50 -gravity northwest -annotate -2x-2+40+80 'Позвонить Маше' \
  -annotate -2x-2+40+175 'насчёт дачи' -annotate -2x-2+40+270 'послезавтра в 9' "$T/note.png"
magick -size 900x800 xc:'#e5e2dc' "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" 3 130 110
photo "$T/c.png" "$OUT/h07-call-day-after.jpg" 400 0

# h08 — «в полвосьмого вечера», карандашом на обороте чека
magick -size 440x700 xc:'#f6f3ec' -attenuate 0.2 +noise Gaussian -fill '#8a8a8a' -font "$ARIAL" -pointsize 18 -gravity north \
  -annotate +0+20 '· · · · · · · · · · · · · ·' -fill '#4b4b4b' -font "$BAD" -pointsize 44 -gravity northwest \
  -annotate -3x-3+30+110 'Театр с Машей' -annotate -2x-2+30+200 'в субботу' -annotate -3x-3+30+290 'в полвосьмого' \
  -annotate -2x-2+30+380 'вечера' -annotate -2x-2+30+500 'билеты у меня!' "$T/note.png"
magick -size 800x900 gradient:'#8f9aa3-#5f6a73' "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" -11 170 70
photo "$T/c.png" "$OUT/h08-theatre-half-past.jpg" 200 400 '#555555'

# h09 — список покупок без даты (нет события)
paper "$T/p.png" 520 760 '#fdfdf8' lined 54 '#b6c8e4'
magick "$T/p.png" -fill '#1c3d8f' -font "$CAVEAT" -pointsize 62 -gravity northwest -annotate -2x-2+40+20 'Купить:' \
  -pointsize 52 -annotate -2x-2+60+110 'молоко 2' -annotate -1x-1+60+170 'хлеб' -annotate -2x-2+60+228 'яйца 10 шт' \
  -annotate -1x-1+60+284 'сыр' -annotate -2x-2+60+340 'гречка 1 кг' -annotate -1x-1+60+396 'бананы' \
  -annotate -2x-2+60+452 'корм коту' -annotate -1x-1+60+508 'батарейки АА' \
  -stroke '#1c3d8f' -strokewidth 3 -draw 'line 55,190 160,184' -draw 'line 55,302 130,298' "$T/note.png"
magick -size 860x1000 xc:'#cfd6cf' "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" 6 140 80
photo "$T/c.png" "$OUT/h09-shopping-list.jpg" 600 500

# h10 — рецепт врача: печатный бланк с часами приёма, назначение «почерком врача» (нет события)
magick -size 760x1000 xc:'#fbfaf3' -fill '#1d3557' -font "$ARIALB" -pointsize 30 -gravity north -annotate +0+40 'РЕЦЕПТ' \
  -font "$ARIAL" -pointsize 22 -annotate +0+90 'Детская поликлиника, кабинет педиатра' \
  -annotate +0+122 'Часы приёма: Пн–Пт 8:00–14:00, Сб 9:00–12:00' -stroke '#1d3557' -draw 'line 40,165 720,165' -stroke none \
  -gravity northwest -font "$ARIAL" -pointsize 24 -annotate +40+190 'Пациент:' -annotate +40+250 'Rp.:' \
  -fill '#203a8f' -font "$MARCK" -pointsize 40 -annotate -4x-4+160+178 'Ваня, 8 лет' \
  -annotate -6x-6+110+240 'Амоксициллин 250 мг' -annotate -5x-5+110+300 'по 1 таб. 3 р/день' -annotate -6x-6+110+360 'после еды — 7 дней' \
  -annotate -5x-5+110+440 'Нурофен при t > 38,5' -annotate -6x-6+110+520 'Повт. осмотр по необх.' \
  -stroke '#5470c6' -strokewidth 4 -fill none -draw 'ellipse 560,820 120,70 0,360' -stroke none \
  -fill '#5470c6' -font "$ARIAL" -pointsize 20 -annotate -10x-10+480+810 'ДЛЯ РЕЦЕПТОВ' \
  -fill '#203a8f' -font "$MARCK" -pointsize 46 -annotate +80+800 'Подпись' "$T/note.png"
magick -size 1000x1200 xc:'#efe9e0' "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" -2 110 80
persp "$T/c.png" "$T/c.png" '20,30 -30,0 0,-20 40,-10' '#efe9e0'
photo "$T/c.png" "$OUT/h10-prescription.jpg" 200 100 '#6a6a6a' 0.6 74

# h11 — трудная: неразборчивый карандаш, волна, размытость
paper "$T/p.png" 760 420 '#f3f0e6' lined 60 '#cfd8e6'
magick "$T/p.png" -fill '#86868e' -font "$BAD" -pointsize 44 -gravity northwest \
  -annotate -9x-9+30+60 'Ване на футбол в сб к 10:00,' -annotate -6x-6+30+170 'взять форму и бутсы' \
  -resize 85x100% -wave 9x150 -blur 0x1.8 "$T/note.png"
magick -size 1000x700 xc:'#a7a39a' "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" 9 70 100
photo "$T/c.png" "$OUT/h11-illegible-pencil.jpg" 0 0 '#4f4f4f' 1.3 70

# h12 — трудная: сильная перспектива, лист на столе снят под углом
paper "$T/p.png" 820 600 '#fbfbf7' grid 30 '#b2c6df'
magick "$T/p.png" -fill '#102c86' -font "$MARCK" -pointsize 64 -gravity northwest \
  -annotate -2x-2+50+90 'Маша — окулист' -annotate -2x-2+50+220 '23 октября в 10:40' -annotate -1x-1+50+350 'каб. 7, взять карту' "$T/note.png"
magick -size 1100x900 xc:'#6e5640' -attenuate 0.5 +noise Multiplicative "$T/bg.png"
place "$T/bg.png" "$T/note.png" "$T/c.png" 0 130 130
persp "$T/c.png" "$T/c.png" '330,330 -330,330 40,0 -40,0' '#6e5640'
photo "$T/c.png" "$OUT/h12-steep-angle.jpg" 1000 800 '#555555' 0.9

ls -la "$OUT"/h*.jpg
