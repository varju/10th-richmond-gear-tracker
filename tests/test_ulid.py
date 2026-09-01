from __future__ import annotations

from gear_tracker.ulid import ALPHABET, is_ulid, new_ulid


def test_shape():
    u = new_ulid()
    assert len(u) == 26
    assert set(u) <= set(ALPHABET)
    assert is_ulid(u)


def test_time_prefix_sorts():
    earlier = new_ulid(now_ms=1_000_000)
    later = new_ulid(now_ms=2_000_000)
    assert earlier[:10] < later[:10]


def test_unique():
    assert len({new_ulid() for _ in range(1000)}) == 1000


def test_rejects_the_wrong_shape():
    assert not is_ulid("")
    assert not is_ulid(None)
    assert not is_ulid("01ARZ3NDEKTSV4RRFFQ69G5FA")  # 25 chars
    assert not is_ulid("01ARZ3NDEKTSV4RRFFQ69G5FAVI")  # 27 chars
    assert not is_ulid("01ARZ3NDEKTSV4RRFFQ69G5FAI")  # I is not in the alphabet
    assert not is_ulid("81ARZ3NDEKTSV4RRFFQ69G5FAV")  # time overflow
    assert not is_ulid("01arz3ndektsv4rrffq69g5fav")  # lowercase
