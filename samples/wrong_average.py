# The snippet the mock backend's canned replies are written for.
#
# No crash, no traceback — it runs and quietly returns the wrong number, which
# is the harder and more realistic case for a tutor to handle.
#
# Prints 10.0. Should print 25.0.
#
# Paste from "def average" downwards, not these comments. The mock backend's
# canned line numbers assume the function starts at line 1. A real model counts
# whatever you actually give it.

def average(nums):
    for n in nums:
        total = 0
        total += n
    return total / len(nums)


print(average([10, 20, 30, 40]))
