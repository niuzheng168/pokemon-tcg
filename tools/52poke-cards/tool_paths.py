"""Defaults for the checked-in tools/52poke-cards layout; no secrets are read here."""
from pathlib import Path

TOOLS_ROOT = Path(__file__).resolve().parent
ACADEMY_ROOT = TOOLS_ROOT.parents[1]
DEFAULT_ENV = ACADEMY_ROOT / ".env"
RESEARCH_DATASET = ACADEMY_ROOT.parent / "PTCG-CHS-Datasets"
