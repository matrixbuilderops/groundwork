"""Fixture for pythonBlockEnd. Every construct here broke it at some point."""
import sys


def one_liner(): pass


def multi_line_signature(
    alpha,
    beta=None,
) -> dict:
    return {"a": alpha}


class Container:
    """Docstring that mentions:

    class NotReal:
        def not_real(self):
    ...and must not produce nodes.
    """

    def first(self):
        return 1

# A comment flush at column 0 inside the class body. This used to end the
# class here, which orphaned every method below it.

    def after_comment(self):
        return 2

    def has_inner(self):
        def inner():
            return "nested"
        return inner


QUOTE_AS_DATA = "'''"
OTHER_QUOTE = '"""'


def after_quote_data():
    """Runaway check: the two constants above hold quote characters."""
    return sys.version


class Trailing:
    def only(self):
        return None
