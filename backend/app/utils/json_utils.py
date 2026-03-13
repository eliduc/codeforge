"""Shared JSON utilities for agent response parsing."""

import json
import re


def _fix_unquoted_keys(json_str: str) -> str:
    """Fix unquoted keys only outside of JSON string values.

    Splits the input on double-quoted strings so that the unquoted-key
    regex is only applied to non-string segments, preventing corruption
    of string values that happen to contain patterns like ``foo:``.
    """
    # Split into alternating non-string / string-literal tokens.
    # The regex captures double-quoted strings (handling escaped quotes).
    parts = re.split(r'("(?:[^"\\]|\\.)*")', json_str)
    for i, part in enumerate(parts):
        # Even-indexed parts are outside of quoted strings
        if i % 2 == 0:
            part = re.sub(r'([{,])\s*(\w+)\s*:', r'\1"\2":', part)
            parts[i] = part
    return "".join(parts)


def _fix_unterminated_strings(json_str: str) -> str:
    """Fix unterminated strings in truncated JSON output.

    When LLM output is truncated mid-string, the JSON will have an
    unterminated string. This function:
    1. Closes unterminated strings
    2. Closes any open brackets/braces
    """
    # Walk character by character to find unterminated strings
    in_string = False
    escape_next = False
    last_good_pos = 0
    open_stack: list[str] = []  # track [ and {

    for i, ch in enumerate(json_str):
        if escape_next:
            escape_next = False
            continue

        if in_string:
            if ch == '\\':
                escape_next = True
            elif ch == '"':
                in_string = False
                last_good_pos = i
        else:
            if ch == '"':
                in_string = True
            elif ch in ('{', '['):
                open_stack.append(ch)
            elif ch == '}':
                if open_stack and open_stack[-1] == '{':
                    open_stack.pop()
                    last_good_pos = i
            elif ch == ']':
                if open_stack and open_stack[-1] == '[':
                    open_stack.pop()
                    last_good_pos = i

    if not in_string and not open_stack:
        return json_str  # Already valid structure

    result = json_str
    if in_string:
        # Close the unterminated string
        result = result.rstrip()
        # Remove trailing incomplete escape
        if result.endswith('\\'):
            result = result[:-1]
        result += '"'

    # Remove any trailing comma or colon (partial key-value)
    result = re.sub(r'[,:\s]+$', '', result)

    # Close open brackets/braces
    for bracket in reversed(open_stack):
        result = re.sub(r'[,\s]+$', '', result)
        if bracket == '{':
            result += '}'
        else:
            result += ']'

    return result


def fix_json(json_str: str) -> str:
    """
    Fix common JSON formatting issues from LLM outputs.

    Handles:
    - Trailing commas before } or ]
    - Unquoted keys (simple cases, only outside of string values)
    - Unterminated strings (truncated LLM output)
    - Unclosed brackets/braces
    """
    # Remove trailing commas before closing brackets
    json_str = re.sub(r",\s*([\]}])", r"\1", json_str)
    # Fix unquoted keys only in non-string portions of the JSON
    json_str = _fix_unquoted_keys(json_str)
    # Fix unterminated strings and unclosed brackets
    json_str = _fix_unterminated_strings(json_str)
    return json_str.strip()
