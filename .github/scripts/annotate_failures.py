"""Turn unittest FAIL/ERROR blocks into GitHub Actions error annotations."""
import re
import sys

SEPARATOR = "=" * 70


def escape(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "").replace("\n", "%0A")


def escape_property(text: str) -> str:
    return escape(text).replace(":", "%3A").replace(",", "%2C")


def main(path: str) -> None:
    with open(path, encoding="utf-8", errors="replace") as f:
        output = f.read()
    blocks = [block for block in output.split(SEPARATOR) if re.match(r"\s*(FAIL|ERROR):", block)]
    if not blocks:
        # Import errors or crashes before the summary: report the tail of the log.
        blocks = [output[-4000:]]
    for block in blocks[:10]:
        lines = block.strip().splitlines()
        title = lines[0] if lines else "test failure"
        print(f"::error title={escape_property(title)}::{escape(block.strip()[-4000:])}")


if __name__ == "__main__":
    main(sys.argv[1])
