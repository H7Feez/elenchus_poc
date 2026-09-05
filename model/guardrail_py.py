"""
A Python mirror of the extension's Direct Output Filter (guardrail.js).

Kept in step with the JavaScript by hand: the rules are short, and having the
same filter available to the training scripts, the comparison tool and the web
demo is worth more than sharing one implementation across two languages.

If you change a rule here, change it in guardrail.js too, and vice versa.
"""

import re

# Fenced code blocks: the most common leak by far.
FENCE = "```"

# Lines that are almost certainly code being handed over rather than discussed.
CODE_LINE = [
    r"^\s*(def|class)\s+\w+\s*\(",
    r"^\s*(function|const|let|var)\s+\w+\s*[=(]",
    r"^\s*(public|private|protected)\s+\w+",
    r"^\s*(if|elif|else|for|while|try|except|switch)\b.*[:{]\s*$",
    r"^\s*return\s+.+",
    r"^\s*\w+\s*=\s*.+",
]

# Phrases that state the bug outright instead of asking about it.
SPOILER_PHRASES = [
    r"\bthe (bug|problem|issue|error) is\b",
    r"\bthe fix is\b",
    r"\byou (need to|should) (change|replace|remove)\b",
    # "you should add a print to check" is a hint technique, not a spoiler.
    # "you should add `total = 0`" is a spoiler. The backticks are the tell.
    r"\byou (need to|should|can|could) add\s+`[^`]+`",
    r"\bchange (line|it) .* to\b",
    r"\breplace .* with\b",
    r"\bhere('s| is) the (corrected|fixed|working)\b",
    r"\bsimply (change|replace|add)\b",
]

MAX_CONSECUTIVE_CODE_LINES = 2
MAX_WORDS = 160


def inspect(reply):
    """Returns the list of reasons the filter would block this reply, or []."""
    reasons = []
    text = (reply or "").strip()

    if not text:
        return ["empty reply"]

    if FENCE in text:
        reasons.append("contains a fenced code block")

    run = best = 0
    for line in text.split("\n"):
        run = run + 1 if any(re.search(p, line) for p in CODE_LINE) else 0
        best = max(best, run)
    if best > MAX_CONSECUTIVE_CODE_LINES:
        reasons.append(f"{best} consecutive lines that look like code")

    # Per sentence, and questions are exempt: "What do you think the problem
    # is?" is the tutor doing its job, not a spoiler.
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if sentence.strip().endswith("?"):
            continue
        hit = next((p for p in SPOILER_PHRASES if re.search(p, sentence, re.I)), None)
        if hit:
            reasons.append("states the answer directly")
            break

    words = len(text.split())
    if words > MAX_WORDS:
        reasons.append(f"{words} words, over the {MAX_WORDS} ceiling")

    return reasons


def has_question(reply):
    """A tutor that has stopped asking has usually started telling."""
    return "?" in (reply or "")
