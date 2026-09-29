"""
Unit tests for website.handy_pea_han — Hansatech Handy PEA .HAN parser.

Run with:  pytest tests/test_handy_pea_han.py -v
(from the Flask_server directory)

Tests verified against two example files:
  - At_Col-0_HL.HAN  (15 records, N=140, one duplicate pair)
  - Cr CC1883 NL.HAN  (12 records, N=140)
"""

import os
import sys

# Make the website package importable from tests/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from website.handy_pea_han import (
    parse_han,
    handy_pea_timebase_us,
    HanParseError,
    MAGIC,
    HEADER_SIZE,
    RECORD_SIZE,
)

EXAMPLES_DIR = os.path.join(
    os.path.dirname(__file__), "..", "website", "static", "files", "examples", "ojip", "HandyPEA"
)


def _read(name):
    with open(os.path.join(EXAMPLES_DIR, name), "rb") as f:
        return f.read()


# ── timebase tests ─────────────────────────────────────────────────────

class TestTimebase:
    def test_length_140(self):
        tb = handy_pea_timebase_us(140)
        assert len(tb) == 140

    def test_first_point(self):
        assert handy_pea_timebase_us(1) == [10]

    def test_linear_region(self):
        tb = handy_pea_timebase_us(30)
        assert tb == list(range(10, 301, 10))

    def test_time_marks(self):
        """The five standard time marks must land at 50, 100, 300, 2000, 30000 µs."""
        tb = handy_pea_timebase_us(140)
        marks_1based = [5, 10, 30, 47, 84]
        expected_us = [50, 100, 300, 2000, 30000]
        for idx, exp in zip(marks_1based, expected_us):
            assert tb[idx - 1] == exp, f"Index {idx} (1-based): got {tb[idx - 1]}, expected {exp}"

    def test_n118_ends_at_1s(self):
        tb = handy_pea_timebase_us(118)
        assert tb[-1] == 1_000_000  # 1 second in µs

    def test_n140_ends_at_5s(self):
        tb = handy_pea_timebase_us(140)
        assert tb[-1] == 5_000_000  # 5 seconds in µs

    def test_monotonic(self):
        tb = handy_pea_timebase_us(192)
        for i in range(1, len(tb)):
            assert tb[i] > tb[i - 1], f"Not monotonic at index {i}"


# ── At_Col-0_HL.HAN ───────────────────────────────────────────────────

class TestAtCol0HL:
    @pytest.fixture(autouse=True)
    def parsed(self):
        self.result = parse_han(_read("At_Col-0_HL.HAN"))

    def test_record_count(self):
        """15 raw records — all returned (duplicates tagged, not dropped)."""
        assert len(self.result["records"]) == 15

    def test_n_points(self):
        assert self.result["n_points"] == 140

    def test_time_axis_length(self):
        assert len(self.result["time_us"]) == 140

    def test_duplicate_warning(self):
        """Position 13 is byte-identical to position 6 — should be reported."""
        dup_warnings = [w for w in self.result["warnings"] if "Duplicate" in w]
        assert len(dup_warnings) == 1
        assert "pos 13" in dup_warnings[0]
        assert "pos 6" in dup_warnings[0]

    def test_duplicate_tagged(self):
        """Position 13 should have duplicate_of set to 6."""
        rec13 = [r for r in self.result["records"] if r["pos"] == 13][0]
        assert rec13["duplicate_of"] == 6
        rec6 = [r for r in self.result["records"] if r["pos"] == 6][0]
        assert rec6["duplicate_of"] is None

    def test_first_record_metadata(self):
        r = self.result["records"][0]
        assert r["pos"] == 0
        assert r["rec_no"] == 123
        assert r["n_points"] == 140
        assert r["light"] == 3500

    def test_first_record_trace(self):
        r = self.result["records"][0]
        assert r["values"][0] == 476   # F(10 µs)
        assert max(r["values"]) == 1817  # Fm


# ── Cr CC1883 NL.HAN ──────────────────────────────────────────────────

class TestCrCC1883NL:
    @pytest.fixture(autouse=True)
    def parsed(self):
        self.result = parse_han(_read("Cr CC1883 NL.HAN"))

    def test_record_count(self):
        assert len(self.result["records"]) == 12

    def test_no_duplicates(self):
        dup_warnings = [w for w in self.result["warnings"] if "Duplicate" in w]
        assert len(dup_warnings) == 0

    def test_first_record_rec_no(self):
        assert self.result["records"][0]["rec_no"] == 616

    def test_first_record_f10us(self):
        """F at 10 µs (first point) = 728."""
        assert self.result["records"][0]["values"][0] == 728

    def test_first_record_f20us(self):
        """F at 20 µs (second point) = 750."""
        assert self.result["records"][0]["values"][1] == 750

    def test_first_record_fm(self):
        """Fm (max of trace) = 2024."""
        assert max(self.result["records"][0]["values"]) == 2024


# ── validation / error handling ────────────────────────────────────────

class TestValidation:
    def test_invalid_magic(self):
        bad = b"\x00\x00\x00\x00\x00\x00" + b"\x00" * 20 + b"\x00" * 437
        with pytest.raises(HanParseError, match="magic"):
            parse_han(bad)

    def test_wrong_size(self):
        """File size not divisible by record size."""
        good = _read("At_Col-0_HL.HAN")
        with pytest.raises(HanParseError, match="divisible"):
            parse_han(good + b"\x00")  # add 1 extra byte

    def test_too_small(self):
        with pytest.raises(HanParseError, match="too small"):
            parse_han(b"\x04PE30" + b"\x00" * 5)

    def test_no_records(self):
        """Header only, no records."""
        header = b"\x04PE30\x00" + b"\x00" * 20
        with pytest.raises(HanParseError, match="no records"):
            parse_han(header)
