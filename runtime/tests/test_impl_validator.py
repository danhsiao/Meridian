"""The planted bodies.

This file is the entire defence for letting a review-time model write code that
ships inside a frozen spec, so it is written alongside the validator rather than
after it. Each planted body is an escape a model could plausibly reach for; each
one has to be rejected *before* the mutation is written.
"""
import pytest

from runtime.helpers import EXPORTS
from runtime.validate_impl import compile_impl, validate

GOOD = {
    "signature": ["a2.f1", "a1.f2"],
    "reads_fields": ["a2.f1", "a1.f2"],
    "helpers": ["days_between"],
    "body": "def check(f1, f2):\n    return days_between(f2, f1) <= 30\n",
}
READS = ["a2.f1", "a1.f2"]


def test_a_well_formed_body_passes_and_runs():
    assert validate(GOOD, READS).ok
    fn = compile_impl(GOOD, READS)
    assert fn("2026-01-10", "2026-01-01") is True
    assert fn("2026-03-10", "2026-01-01") is False


# ── the three planted bodies ─────────────────────────────────────────────
def test_planted_body_that_imports_is_rejected():
    planted = {
        **GOOD,
        "body": "def check(f1, f2):\n    import os\n    return os.getenv('X') == f1\n",
    }
    result = validate(planted, READS)
    assert not result.ok
    assert any("import" in e for e in result.errors)


def test_planted_body_that_reads_an_undeclared_field_is_rejected():
    planted = {
        **GOOD,
        "body": "def check(f1, f2):\n    return f1 == f2 and f9 is None\n",
    }
    result = validate(planted, READS)
    assert not result.ok
    assert any("'f9'" in e for e in result.errors)


def test_planted_body_that_calls_an_unlisted_helper_is_rejected():
    planted = {
        **GOOD,
        "body": "def check(f1, f2):\n    return eval(f1) > eval(f2)\n",
    }
    result = validate(planted, READS)
    assert not result.ok
    assert any("eval" in e for e in result.errors)
    assert "eval" not in EXPORTS


# ── the declared surface is a contract, not documentation ────────────────
def test_a_signature_that_does_not_equal_reads_is_rejected():
    widened = {
        "signature": ["a2.f1", "a1.f2", "a1.f3"],
        "reads_fields": ["a2.f1", "a1.f2", "a1.f3"],
        "helpers": [],
        "body": "def check(f1, f2, f3):\n    return f1 == f2 == f3\n",
    }
    result = validate(widened, READS)
    assert not result.ok
    assert any("does not equal reads" in e for e in result.errors)


def test_a_body_whose_parameters_disagree_with_its_signature_is_rejected():
    mismatched = {**GOOD, "body": "def check(x, y):\n    return x == y\n"}
    assert not validate(mismatched, READS).ok


def test_helpers_must_name_something_the_module_actually_exports():
    invented = {**GOOD, "helpers": ["days_between", "call_the_api"]}
    result = validate(invented, READS)
    assert not result.ok
    assert any("call_the_api" in e for e in result.errors)


def test_a_helper_used_but_not_declared_is_rejected():
    undeclared = {
        **GOOD,
        "helpers": [],
        "body": "def check(f1, f2):\n    return days_between(f2, f1) <= 30\n",
    }
    result = validate(undeclared, READS)
    assert not result.ok
    assert any("without declaring it" in e for e in result.errors)


# ── the other escapes ────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "body",
    [
        "def check(f1, f2):\n    return f1.__class__ is str\n",
        "def check(f1, f2):\n    return type(f1).__mro__\n",
        "def check(f1, f2):\n    return f1.upper() == f2\n",
        "def check(f1, f2):\n    global x\n    return True\n",
        "def check(f1, f2):\n    open('/etc/passwd')\n    return True\n",
        "def check(f1, f2):\n    return __import__('os')\n",
    ],
)
def test_attribute_and_builtin_escapes_are_rejected(body):
    assert not validate({**GOOD, "body": body}, READS).ok


def test_a_body_that_is_not_exactly_one_function_is_rejected():
    two = {
        **GOOD,
        "body": "def helper(x):\n    return x\ndef check(f1, f2):\n    return helper(f1) == f2\n",
    }
    assert not validate(two, READS).ok
    wrong_name = {**GOOD, "body": "def run(f1, f2):\n    return f1 == f2\n", "helpers": []}
    assert not validate(wrong_name, READS).ok


def test_a_body_that_does_not_parse_is_rejected_rather_than_raising():
    result = validate({**GOOD, "body": "def check(f1, f2)\n    return f1\n"}, READS)
    assert not result.ok
    assert any("does not parse" in e for e in result.errors)


def test_compile_refuses_a_rejected_body():
    with pytest.raises(ValueError, match="impl rejected"):
        compile_impl({**GOOD, "body": "def check(f1, f2):\n    import os\n    return True\n"}, READS)


def test_a_compiled_body_has_no_ambient_builtins():
    """Belt and braces: even if the validator ever missed a reach for a builtin,
    the namespace it runs in does not have one."""
    fn = compile_impl(
        {
            "signature": ["a2.f1", "a1.f2"],
            "reads_fields": ["a2.f1", "a1.f2"],
            "helpers": ["normalize"],
            "body": "def check(f1, f2):\n    return normalize(f1) == normalize(f2)\n",
        },
        READS,
    )
    assert fn.__globals__["__builtins__"] == {}
    assert fn(" A ", "a") is True
