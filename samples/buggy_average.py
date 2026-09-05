# A test case for the tutor. Two bugs, both classic student mistakes.
#
# 1. The loop runs one step past the end of the list (IndexError).
# 2. Even once that is fixed, the result is wrong: the "- 1" was meant to be
#    part of the denominator, but precedence puts it outside the division.
#
# Paste this into the panel, along with the traceback, and see whether the
# tutor points you at them without handing over the fix.

def average(numbers):
    total = 0
    for i in range(len(numbers) + 1):
        total = total + numbers[i]
    return total / len(numbers) - 1


if __name__ == "__main__":
    print(average([4, 8, 15, 16, 23, 42]))
