from gear_tracker.ratelimit import RateLimit

MINUTE = 60_000


def test_hits_within_the_window_count_and_the_next_is_refused():
    limit = RateLimit(3, MINUTE)
    assert [limit.allow("a", 0), limit.allow("a", 1), limit.allow("a", 2)] == [True, True, True]
    assert limit.allow("a", 3) is False


def test_the_window_slides():
    limit = RateLimit(2, MINUTE)
    assert limit.allow("a", 0)
    assert limit.allow("a", 30_000)
    assert not limit.allow("a", 59_999)
    # The first hit is a minute old now; one slot opens.
    assert limit.allow("a", MINUTE)
    assert not limit.allow("a", MINUTE + 1)


def test_keys_are_independent():
    limit = RateLimit(1, MINUTE)
    assert limit.allow("a", 0)
    assert limit.allow("b", 0)
    assert not limit.allow("a", 1)


def test_a_refusal_is_not_a_hit():
    limit = RateLimit(1, MINUTE)
    assert limit.allow("a", 0)
    for t in range(1, 10):
        assert not limit.allow("a", t)
    assert limit.allow("a", MINUTE)


def test_would_allow_checks_without_recording():
    limit = RateLimit(1, MINUTE)
    assert limit.would_allow("a", 0) is True
    assert limit.would_allow("a", 1) is True, "nothing was recorded, so the slot is still open"
    limit.record("a", 2)
    assert limit.would_allow("a", 3) is False
    assert limit.allow("a", 3) is False


def test_idle_keys_are_forgotten():
    limit = RateLimit(1, MINUTE)
    limit.allow("a", 0)
    limit.allow("b", 50_000)
    limit.allow("c", MINUTE)
    assert set(limit._hits) == {"b", "c"}
