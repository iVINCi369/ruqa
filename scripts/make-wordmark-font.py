#!/usr/bin/env python3
"""Готовит гарнитуру вордмарка: Outfit Bold, только нужные глифы.

Запускать из корня репозитория:

    python scripts/make-wordmark-font.py

Результат — assets/fonts/Outfit-Wordmark.ttf (около 3 КБ против 5,7 МБ
полного Noto Sans JP) и лицензия OFL-Outfit.txt рядом. Нужен fonttools.
После этого перегенерировать логотипы: python scripts/make-brand-assets.py
"""
import os
import tempfile
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TMP = os.path.join(tempfile.gettempdir(), "Outfit-variable.ttf")
OUT = os.path.join(ROOT, "assets", "fonts", "Outfit-Wordmark.ttf")
LIC = os.path.join(ROOT, "assets", "fonts", "OFL-Outfit.txt")

SRC = "https://raw.githubusercontent.com/google/fonts/main/ofl/outfit/Outfit%5Bwght%5D.ttf"
SRC_LIC = "https://raw.githubusercontent.com/google/fonts/main/ofl/outfit/OFL.txt"

if not os.path.exists(TMP):
    urllib.request.urlretrieve(SRC, TMP)
urllib.request.urlretrieve(SRC_LIC, LIC)

# Вариативную ось фиксируем на Bold — вордмарк один, ось в рантайме не нужна.
font = instancer.instantiateVariableFont(TTFont(TMP), {"wght": 700}, inplace=False)

# В файле остаётся ровно то, чем набрано слово: 5,7 МБ CJK ради четырёх букв
# в интерфейсе — это то, от чего уходим.
options = subset.Options()
options.name_IDs = ["*"]
options.name_legacy = True
options.layout_features = ["*"]
options.notdef_outline = True
options.recalc_bounds = True
options.drop_tables += ["DSIG"]

subsetter = subset.Subsetter(options=options)
subsetter.populate(text="Ruqa")
subsetter.subset(font)

# Имя должно отражать, что это не полный Outfit, иначе спутать легко.
for record in font["name"].names:
    value = str(record)
    if "Outfit" in value:
        record.string = value.replace("Outfit", "Outfit Wordmark")

font.save(OUT)
print("готово:", OUT, os.path.getsize(OUT), "байт")
print("лицензия:", LIC)
