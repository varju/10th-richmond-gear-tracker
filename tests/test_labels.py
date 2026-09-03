"""The label sheet, as far as a test can judge a PDF."""

from __future__ import annotations

import pytest

from gear_tracker import labels

CODES = [f"{n:010d}" for n in range(33)]


def test_a_sheet_is_a_pdf():
    pdf = labels.sheet(CODES[:1], "10th Richmond", "https://example.org")
    assert pdf.startswith(b"%PDF")


@pytest.mark.parametrize(("count", "pages"), [(1, 1), (32, 1), (33, 2), (320, 10)])
def test_pages_needed(count, pages):
    assert labels.pages_needed(count) == pages


def test_thirty_three_codes_need_a_second_page():
    one = labels.sheet(CODES[:32], "10th Richmond", "https://example.org")
    two = labels.sheet(CODES[:33], "10th Richmond", "https://example.org")
    assert one.count(b"/Type /Page\n") == 1
    assert two.count(b"/Type /Page\n") == 2
    assert len(two) > len(one)


def test_the_qr_url_is_base_slash_code():
    """The URL must be short (FR-TAG-13). A trailing slash on the base must not double up."""
    with_slash = labels.sheet(CODES[:1], "10th Richmond", "https://example.org/")
    without = labels.sheet(CODES[:1], "10th Richmond", "https://example.org")
    assert with_slash.count(b"/Type /Page\n") == without.count(b"/Type /Page\n")


def test_a_long_group_name_still_renders():
    pdf = labels.sheet(CODES[:1], "The Extraordinarily Long-Named Scout Group of Somewhere", "https://x.org")
    assert pdf.startswith(b"%PDF")
