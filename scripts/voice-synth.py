#!/usr/bin/env python3
# Синтетический «шумный» голосовой набор для замера голосовых конвейеров (docs/research/voice-synth-eval.md).
# Запуск — на хосте (не в Docker: нужен интернет к Microsoft TTS и ffmpeg с libopus):
#   python3 -m venv .venv-tts && .venv-tts/bin/pip install edge-tts pyyaml   # зависимости: edge-tts (≥7), PyYAML
#   .venv-tts/bin/python scripts/voice-synth.py [testdata/voice/phrases.yaml] [reports/voice-synth]
# FFMPEG=/opt/homebrew/bin/ffmpeg — путь к ffmpeg (по умолчанию из PATH). Голоса edge-tts кэшируются в <out>/.cache.
#
# Выход: <out>/<id>-<голос>-<условие>.ogg (OGG/Opus, моно, 48 кГц, 24 кбит/с — как голосовое Telegram) и
# <out>/index.tsv (file, phrase, voice, condition). Рецепт условий:
#   clean   — голос + 0,6 с тишины до и после (как нажатие кнопки записи);
#   pink10  — + розовый шум (anoisesrc color=pink); уровень шума = RMS речи − 10 дБ (RMS меряет astats);
#   babble5 — голос с реверберацией маленькой комнаты (aecho) + «гул голосов» (3 бытовые фразы других голосов,
#             смешанные со сдвигом) и слабый розовый шум; гул = RMS речи − 5 дБ; потом телефонная полоса
#             300–3400 Гц (highpass + lowpass). SNR приблизительный: RMS активной речи (без пауз) против RMS шума по всему отрезку.
# Без речи: n01 — 3 с тишины, n02 — 3 с розового шума, n03 — 3 с приглушённого гула голосов без команды.

import asyncio
import os
import re
import subprocess
import sys
from pathlib import Path

import edge_tts
import yaml

PHRASES = Path(sys.argv[1] if len(sys.argv) > 1 else "testdata/voice/phrases.yaml")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "reports/voice-synth")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
SR = 48000

# Голос → (короткое имя, темп). Emma Multilingual читает русский с акцентом.
VOICES = {
    "ru": [("ru-RU-DmitryNeural", "dmitry", "+10%"), ("ru-RU-SvetlanaNeural", "svetlana", "-5%"), ("en-US-EmmaMultilingualNeural", "emma", "+0%")],
    "en": [("en-US-AndrewNeural", "andrew", "+5%"), ("en-US-JennyNeural", "jenny", "-5%")],
}
CONDITIONS = {"ru": ["clean", "pink10", "babble5"], "en": ["clean", "pink10"]}

# Фон — бытовая болтовня без команд (телевизор, кухня); разные голоса и темп
BABBLE = [
    ("ru-RU-SvetlanaNeural", "+15%", "Ну и вот, я ей говорю, что ремонт пора бы уже закончить, а она опять про обои."),
    ("en-US-BrianMultilingualNeural", "+0%", "А ты видел, какая сегодня погода? Совсем осень, листья везде, и дождь с утра."),
    ("ru-RU-DmitryNeural", "-10%", "Он опять опоздал на электричку и целый час просидел на вокзале с бутербродами."),
    ("en-US-AvaMultilingualNeural", "+10%", "Слушай, а суп ещё остался? Я бы съел тарелку, пока все не пришли."),
]


def run(args: list[str]) -> str:
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:6])}…: {p.stderr[-800:]}")
    return p.stderr


def ff(*args: str) -> str:
    return run([FFMPEG, "-hide_banner", "-loglevel", "info", "-y", *args])


def rms_db(path: Path) -> float:
    err = ff("-i", str(path), "-af", "astats=measure_perchannel=none:measure_overall=RMS_level", "-f", "null", "-")
    m = re.findall(r"RMS level dB:\s*(-?[\d.]+|-inf)", err)
    return float(m[-1]) if m and m[-1] != "-inf" else -120.0


def duration(path: Path) -> float:
    p = subprocess.run(["ffprobe" if FFMPEG == "ffmpeg" else str(Path(FFMPEG).with_name("ffprobe")), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return float(p.stdout.strip())


async def tts(text: str, voice: str, rate: str, dst: Path) -> None:
    if dst.exists() and dst.stat().st_size > 0:
        return
    await edge_tts.Communicate(text, voice, rate=rate).save(str(dst))


def to_wav(src: Path, dst: Path, pad: float = 0.6) -> None:
    ff("-i", str(src), "-af", f"adelay={int(pad * 1000)}:all=1,apad=pad_dur={pad}", "-ac", "1", "-ar", str(SR), str(dst))


def opus(src: Path, dst: Path) -> None:
    # Как Telegram: OGG/Opus, моно, 48 кГц, ~24 кбит/с, профиль voip
    ff("-i", str(src), "-c:a", "libopus", "-b:a", "24k", "-ac", "1", "-ar", str(SR), "-application", "voip", str(dst))


def mix(speech: Path, noise: Path, gain_db: float, dst: Path, speech_filter: str = "anull", post: str = "anull") -> None:
    """Речь + шум (шум усилен на gain_db), длина — по речи; amix без нормализации, чтобы не менять уровни."""
    ff(
        "-i", str(speech), "-i", str(noise),
        "-filter_complex",
        f"[0]{speech_filter}[s];[1]volume={gain_db:.2f}dB[n];[s][n]amix=inputs=2:duration=first:normalize=0,{post},alimiter=limit=0.95[o]",
        "-map", "[o]", "-ac", "1", "-ar", str(SR), str(dst),
    )


def pink(seconds: float, dst: Path) -> None:
    ff("-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=0.3:duration={seconds:.2f}:sample_rate={SR}:seed=7", "-ac", "1", str(dst))


async def build_babble(cache: Path) -> Path:
    """3–4 бытовые фразы разными голосами, смешанные со сдвигом и зацикленные — «гул голосов» ~20 с."""
    dst = cache / "babble.wav"
    if dst.exists():
        return dst
    parts = []
    for i, (voice, rate, text) in enumerate(BABBLE):
        mp3 = cache / f"babble{i}.mp3"
        await tts(text, voice, rate, mp3)
        parts.append(mp3)
    inputs = sum((["-i", str(p)] for p in parts), [])
    delays = "".join(f"[{i}]adelay={i * 900}:all=1,aloop=loop=3:size={SR * 8}[b{i}];" for i in range(len(parts)))
    ff(*inputs, "-filter_complex", f"{delays}{''.join(f'[b{i}]' for i in range(len(parts)))}amix=inputs={len(parts)}:normalize=0,atrim=0:20[o]",
       "-map", "[o]", "-ac", "1", "-ar", str(SR), str(dst))
    return dst


async def main() -> None:
    data = yaml.safe_load(PHRASES.read_text(encoding="utf8"))
    OUT.mkdir(parents=True, exist_ok=True)
    cache = OUT / ".cache"
    cache.mkdir(exist_ok=True)
    babble = await build_babble(cache)
    babble_rms = rms_db(babble)
    index = ["file\tphrase\tvoice\tcondition\tsnr_db"]
    for ph in data["phrases"]:
        for voice, short, rate in VOICES[ph["lang"]]:
            mp3 = cache / f"{ph['id']}-{short}.mp3"
            await tts(ph["text"], voice, rate, mp3)
            wav = cache / f"{ph['id']}-{short}.wav"
            to_wav(mp3, wav)
            sp_rms = rms_db(mp3)  # уровень активной речи — без пауз по краям
            dur = duration(wav)
            for cond in CONDITIONS[ph["lang"]]:
                name = f"{ph['id']}-{short}-{cond}.ogg"
                tmp = cache / f"{ph['id']}-{short}-{cond}.wav"
                snr = ""
                if cond == "clean":
                    tmp = wav
                elif cond == "pink10":
                    noise = cache / f"pink-{dur:.1f}.wav"
                    pink(dur + 0.5, noise)
                    mix(wav, noise, sp_rms - 10 - rms_db(noise), tmp)
                    snr = "10"
                elif cond == "babble5":
                    # Сначала гул (длина — по речи), потом слабый розовый шум и телефонная полоса для всего
                    mix(wav, babble, sp_rms - 5 - babble_rms, tmp,
                        speech_filter="aecho=0.8:0.6:35|60:0.3|0.2",
                        post="highpass=f=300,lowpass=f=3400")
                    snr = "5"
                opus(tmp, OUT / name)
                index.append(f"{name}\t{ph['id']}\t{short}\t{cond}\t{snr}")
                print(name, flush=True)
    # Без речи
    sil = cache / "n01.wav"
    ff("-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", "3", str(sil))
    opus(sil, OUT / "n01-none-silence.ogg")
    pn = cache / "n02.wav"
    pink(3, pn)
    ff("-i", str(pn), "-af", "volume=-12dB", str(cache / "n02q.wav"))
    opus(cache / "n02q.wav", OUT / "n02-none-pink.ogg")
    bb = cache / "n03.wav"
    # Гул «за стеной»: тише и глуше, чем фон в babble5
    ff("-i", str(babble), "-af", f"atrim=4:7,asetpts=N/SR/TB,volume={-30 - babble_rms:.2f}dB,lowpass=f=2500,highpass=f=300", str(bb))
    opus(bb, OUT / "n03-none-babble.ogg")
    for f, cond in [("n01-none-silence.ogg", "silence"), ("n02-none-pink.ogg", "pink"), ("n03-none-babble.ogg", "babble")]:
        index.append(f"{f}\t{f[:3]}\tnone\t{cond}\t")
    (OUT / "index.tsv").write_text("\n".join(index) + "\n", encoding="utf8")
    print(f"{len(index) - 1} файлов → {OUT}/index.tsv")


asyncio.run(main())
