"""Normalize printed identifiers only; never guess a card's identity from its name."""
import re
import unicodedata


def printed_number(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    if match := re.fullmatch(r"(\d+)\s*/\s*(\d+)", text):
        return ("fraction", *map(int, match.groups()))
    if match := re.fullmatch(r"(\d+)\s*/\s*((?=[A-Z0-9.-]*[A-Z])[A-Z0-9][A-Z0-9.-]*)", text):
        return ("promo", int(match[1]), match[2])
    if match := re.fullmatch(r"(\d+)\s+(\d+)\s*/\s*(\d+)", text):
        return ("pack", *map(int, match.groups()))
    if match := re.fullmatch(r"([BGR])\s*/\s*(RGB)", text):
        return ("color", *match.groups())
    return None


def printed_set(value, number=None):
    code = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or ""))).upper()
    identity = printed_number(number)
    if identity and identity[0] == "promo":
        # Some promos print only one combined identifier such as 115/SV-P.
        # Its suffix is explicit printed data, not a set inferred from a card name.
        if not code or printed_number(code) == identity:
            return identity[2]
    return code or None
